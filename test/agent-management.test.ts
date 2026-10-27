import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Management, ManagementError } from '../src/management.js';

function fixture(t:TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'namo-agent-management-')),data=join(dir,'data'),project=join(dir,'project'),file=join(dir,'config.json');
  mkdirSync(data);mkdirSync(project);
  const raw={version:1,agent:'codex',dataDir:data,custom:{keep:'untouched'},
    feishu:{appId:'agent_management',appSecret:'PRIVATE_AGENT_MANAGEMENT_SECRET',allowedUserIds:['alice'],allowedChatIds:[]},
    codex:{bin:'codex',home:join(data,'codex-home'),projects:{app:project},defaultProject:'app',sandbox:'read-only',networkAccess:false,denyPaths:[],readPaths:[],timeoutMs:600000},
    agents:{defaultProfile:'team',memoryProfile:'codex',profiles:{
      team:{adapter:'codex',bin:'codex-team',model:'gpt-team',timeoutMs:120000},
      future:{adapter:'claude',enabled:false,bin:join(dir,'missing-claude')},
    }},concurrency:1};
  writeFileSync(file,JSON.stringify(raw));
  const manager=new Management(file,{status:()=>({running:false,installed:true,registered:false,mode:'stopped'})});
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {dir,data,file,raw,manager};
}

test('management projects editable agent specs separately from resolved safe metadata',t=>{
  const f=fixture(t),view=f.manager.config();
  assert.equal(view.valid,true);assert.equal(view.agents.defaultProfile,'team');assert.equal(view.agents.memoryProfile,'codex');
  assert.deepEqual(view.agents.specs,f.raw.agents.profiles,'editable specs retain only registry input fields');
  assert.deepEqual(view.agents.profiles.map((profile:any)=>[profile.id,profile.adapter,profile.available,profile.enabled]),[
    ['codex','codex',true,true],['team','codex',true,true],['future','claude',false,false],
  ]);
  const team=view.agents.profiles.find((profile:any)=>profile.id==='team');
  assert.equal(team.home,join(f.data,'agents','team'));assert.equal(team.bin,'codex-team');assert.equal(team.model,'gpt-team');
  const state=JSON.stringify(f.manager.state()),encoded=JSON.stringify(view.agents);
  assert.equal(state.includes(f.raw.feishu.appSecret),false);assert.equal(encoded.includes('authenticated'),false);assert.equal(encoded.includes('installed'),false);
  writeFileSync(f.file,JSON.stringify({...f.raw,agents:{...f.raw.agents,profiles:{...f.raw.agents.profiles,
    team:{...f.raw.agents.profiles.team,model:f.raw.feishu.appSecret}}}}));
  assert.equal(JSON.stringify(f.manager.config().agents).includes(f.raw.feishu.appSecret),false);
});

test('management saves a complete strict registry without moving fields under codex or replacing unrelated configuration',t=>{
  const f=fixture(t),before=f.manager.config(),profiles={
    team:{adapter:'codex' as const,enabled:true,bin:'codex-team-v2',model:'gpt-team-v2',timeoutMs:180000},
    cursor_next:{adapter:'cursor' as const,enabled:true,bin:'cursor-agent'},
  };
  const saved=f.manager.save(before.revision,{agents:{defaultProfile:'team',memoryProfile:'codex',profiles}});
  assert.equal(saved.agents.defaultProfile,'team');assert.deepEqual(saved.agents.specs,profiles);
  const raw=JSON.parse(readFileSync(f.file,'utf8'));
  assert.deepEqual(raw.agents,{defaultProfile:'team',memoryProfile:'codex',profiles});
  assert.equal(Object.hasOwn(raw.codex,'agents'),false);assert.equal(raw.custom.keep,'untouched');assert.equal(raw.feishu.appSecret,f.raw.feishu.appSecret);
  assert.throws(()=>f.manager.save(before.revision,{agents:{defaultProfile:'codex',profiles:{}}}),error=>error instanceof ManagementError&&error.status===409);
});

test('management rejects malformed, reserved, unavailable and expanded agent registry writes atomically',t=>{
  const f=fixture(t),revision=f.manager.config().revision,before=readFileSync(f.file,'utf8');
  const invalid:unknown[]=[
    null,
    {defaultProfile:'team',memoryProfile:'codex',profiles:[],extra:true},
    {defaultProfile:'codex',memoryProfile:'codex',profiles:{codex:{adapter:'codex'}}},
    {defaultProfile:'codex',memoryProfile:'codex',profiles:{'Bad ID':{adapter:'codex'}}},
    {defaultProfile:'codex',memoryProfile:'codex',profiles:{team:{adapter:'codex',home:'/tmp/shared-auth'}}},
    {defaultProfile:'future',memoryProfile:'codex',profiles:{future:{adapter:'claude',enabled:true}}},
    {defaultProfile:'disabled',memoryProfile:'codex',profiles:{disabled:{adapter:'codex',enabled:false}}},
    {defaultProfile:'codex',memoryProfile:'claude',profiles:{}},
    {defaultProfile:'codex',memoryProfile:'codex',profiles:{team:{adapter:'codex',timeoutMs:999}}},
    {defaultProfile:'codex',memoryProfile:'codex',profiles:{team:{adapter:'codex',bin:'codex\nwrapper'}}},
  ];
  for(const agents of invalid){
    assert.throws(()=>f.manager.save(revision,{agents}),error=>error instanceof ManagementError&&/校验/.test(error.message));
    assert.equal(readFileSync(f.file,'utf8'),before);
  }
  assert.throws(()=>f.manager.save(revision,{agents:{defaultProfile:'team',memoryProfile:'codex',profiles:{team:{adapter:'codex',model:f.raw.feishu.appSecret}}}}),/凭据/);
  assert.equal(readFileSync(f.file,'utf8'),before);
  assert.throws(()=>f.manager.save(revision,{agents:f.raw.agents,agentCredentials:{token:'no'}}),/不允许/);
  assert.equal(readFileSync(f.file,'utf8'),before);
});

test('CLI exposes the safe registry and changes only a runnable default with an explicit restart receipt',t=>{
  const f=fixture(t),bin=resolve('bin/namo.js');
  const run=(...args:string[])=>spawnSync(process.execPath,[bin,...args,'--config',f.file],{encoding:'utf8',env:{...process.env,NAMO_LANG:'en'}});
  const profiles=run('agent','profiles','--json');assert.equal(profiles.status,0,profiles.stderr);
  const view=JSON.parse(profiles.stdout);assert.equal(view.defaultProfile,'team');assert.equal(view.memoryProfile,'codex');
  assert.equal(JSON.stringify(view).includes(f.raw.feishu.appSecret),false);assert.equal(view.profiles.find((profile:any)=>profile.id==='future').available,false);
  const human=run('agent','profiles');assert.equal(human.status,0,human.stderr);assert.match(human.stdout,/Default profile: team/);assert.doesNotMatch(human.stdout,/默认配置|等待后续版本/);
  assert.equal(run('agent','probe','--json').status,1);
  const probe=run('agent','probe','--profile','future','--json');assert.equal(probe.status,0,probe.stderr);
  const report=JSON.parse(probe.stdout);assert.equal(report.profileId,'future');assert.equal(report.adapter,'claude');assert.equal(report.report.installed.status,'unavailable');
  const probeHuman=run('agent','probe','--profile','future');assert.equal(probeHuman.status,0,probeHuman.stderr);assert.match(probeHuman.stdout,/Profile: future · claude/);assert.match(probeHuman.stdout,/still cannot run tasks/);assert.doesNotMatch(probeHuman.stdout,/此探测结果|当前版本/);
  const unavailable=run('agent','use','--profile','future','--json');assert.equal(unavailable.status,1);assert.equal(JSON.parse(readFileSync(f.file,'utf8')).agents.defaultProfile,'team');
  const selected=run('agent','use','--profile','codex','--json');assert.equal(selected.status,0,selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout),{defaultProfile:'codex',restartRequired:true,scope:'new_workstreams'});
  const raw=JSON.parse(readFileSync(f.file,'utf8'));assert.equal(raw.agents.defaultProfile,'codex');assert.deepEqual(raw.agents.profiles,f.raw.agents.profiles);
});
