import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAgents, findExecutable, probeAgent } from '../src/agents.js';
import { initialConfig } from '../src/onboarding.js';
import { atomicJson } from '../src/paths.js';
import { loadConfig, parseConfig } from '../src/config.js';
import { waitFor } from './helpers.js';
import { Waits } from '../src/waits.js';
import { getAgentRegistry, selectAgent, resolveAgent, agentCodexConfig, selectedPolicyHash, agentSessionKey } from '../src/agent-registry.js';
import { Store, SCHEMA_VERSION, type Incoming } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { Engine } from '../src/engine.js';
import { type RunRequest } from '../src/runtime.js';
import { spawnSync } from 'node:child_process';
import { Management, ManagementError } from '../src/management.js';

test('probe distinguishes missing binary, login and protocol permission compatibility without inference',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-agent-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json'),raw=initialConfig(file);raw.codex.bin=join(dir,'missing');atomicJson(file,raw);
 assert.equal(findExecutable(raw.codex.bin),undefined);assert.equal((await probeAgent(loadConfig(file)))[0].status,'fail');
 const bin=join(dir,'agent.mjs');raw.codex.bin=bin;writeFileSync(bin,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);let result={};if(m.method==='skills/list')result={data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='permissionProfile/list')result={data:[{id:'feishu-bot',allowed:true}]};if(m.method==='turn/start')process.exit(98);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});`,{mode:0o700});atomicJson(file,raw);
 assert.equal((await probeAgent(loadConfig(file))).some(x=>x.id==='agent.auth'&&x.status==='fail'),true);
 mkdirSync(raw.codex.home,{recursive:true});
 const valid=await probeAgent(loadConfig(file));assert.equal(valid.some(x=>x.id==='agent.protocol'&&x.status==='ok'),true);assert.equal(valid.some(x=>x.id==='agent.auth'&&x.status==='ok'),true);
 writeFileSync(bin,readDenied(),{mode:0o700});assert.equal((await probeAgent(loadConfig(file))).some(x=>x.id==='agent.protocol'&&x.status==='fail'),true);
});
function readDenied(){return `#!/usr/bin/env node
import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='skills/list'?{data:[{cwd:m.params.cwds[0],skills:[],errors:[]}]}:m.method==='permissionProfile/list'?{data:[{id:'feishu-bot',allowed:false}]}:m.method==='account/read'?{account:{}}:{}})+'\\n')});`}

test('agent discovery never executes a generic PATH binary or exposes inherited credentials',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-discovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const marker=join(dir,'executed');
 writeFileSync(join(dir,'agent'),`#!/bin/sh
touch '${marker}'
`,{mode:0o700});
 const path=process.env.PATH;process.env.PATH=dir;
 try { const agents=detectAgents();assert.deepEqual(agents.map(a=>a.id),['codex']);assert.equal(agents[0].installed,false);assert.equal(existsSync(marker),false); }
 finally {if(path===undefined)delete process.env.PATH;else process.env.PATH=path;}
});

const msg = (key: string, text = '/run hello'): Incoming => ({key,messageId:key,chatId:'chat',chatKey:'chat',senderId:'alice',text});

function fixture(t: {after(fn:()=>void|Promise<void>):void}) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'namo-registry-'))), project=join(dir,'project');mkdirSync(project);
  const config=parseConfig({dataDir:join(dir,'data'),codex:{projects:{one:project},defaultProject:'one'},
    agents:{profiles:{review:{adapter:'codex',model:'review-model'},future:{adapter:'claude'},cursor:{adapter:'cursor'}}}},join(dir,'config.json'));
  config.file=''; // Unit engine uses injected config; no management service in this fixture.
  const store=new Store(join(dir,'bot.sqlite')),tasks=new Tasks(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,project,config,store,tasks};
}
test('implicit Codex retains policy, home, native namespace and independent memory executor',t=>{
  const {config}=fixture(t), selection=selectAgent(config);
  assert.equal(selectedPolicyHash(config,selection),policyHash(config.codex));
  assert.equal(agentCodexConfig(config).home,config.codex.home);
  assert.equal(agentSessionKey('W-old',selection),'workstream:W-old');
  config.agents!.defaultProfile='review';
  assert.equal(getAgentRegistry(config).memoryProfile,'codex');
  assert.equal(agentCodexConfig(config,selection).home,config.codex.home);
  assert.equal(resolveAgent(config).home,join(config.dataDir,'agents','review'));
});
test('registry rejects unknown, disabled and unimplemented defaults, fields and identity spoofing',t=>{
  const {dir,config}=fixture(t);
  for(const agents of [ {defaultProfile:'missing'}, {profiles:{codex:{adapter:'codex'}}},
    {profiles:{x:{adapter:'cursor'}},defaultProfile:'x'}, {profiles:{x:{adapter:'codex',enabled:false}},defaultProfile:'x'},
    {profiles:{x:{adapter:'codex',home:'/tmp/host'}}}, {profiles:{x:{adapter:'claude',token:'secret'}}}, {memoryProfile:'review'} ])
    assert.throws(()=>parseConfig({agents},join(dir,'invalid.json')));
  const tilde=parseConfig({agents:{profiles:{local:{adapter:'codex',bin:'~/.local/bin/codex'}}}},join(dir,'tilde.json'));
  assert.equal(resolveAgent(tilde,selectAgent(tilde,'local')).bin,join(homedir(),'.local/bin/codex'));
  assert.throws(()=>selectAgent(config,'future'),/agent_profile_unavailable/);
  assert.throws(()=>selectAgent(config,'unknown'),/agent_profile_unavailable/);
  const s=selectAgent(config,'review');
  assert.throws(()=>resolveAgent(config,{...s,adapter:'cursor'}),/agent_configuration_changed/);
  config.agents!.profiles.review.enabled=false;
  assert.throws(()=>resolveAgent(config,s),/agent_profile_unavailable/);
});
test('task and workstream snapshot survive reopen and default changes; native IDs cannot cross profiles',t=>{
  const {config,store,tasks,project}=fixture(t), a=selectAgent(config), b=selectAgent(config,'review');
  store.enqueue(msg('a')); const old=tasks.create(store.get('a')!,{cwd:project,policyHash:selectedPolicyHash(config,a)},undefined,a);
  store.saveThread(tasks.sessionKey(old),'native-a');
  tasks.reset(msg('x')); store.enqueue(msg('b'));
  const fresh=tasks.create(store.get('b')!,{cwd:project,policyHash:selectedPolicyHash(config,b),agentSelection:b},undefined,b);
  assert.equal(tasks.thread(fresh),undefined);store.saveThread(tasks.sessionKey(fresh),'native-b');
  config.agents!.defaultProfile='review';
  assert.deepEqual(tasks.selection(old.id),a);assert.deepEqual(tasks.selection(old.workstreamId),a);
  assert.equal(tasks.thread(old),'native-a');assert.equal(tasks.thread(fresh),'native-b');
  assert.notEqual(tasks.sessionKey(old),tasks.sessionKey(fresh));
  const readonly=new Store(join(project,'..','bot.sqlite'),true);
  assert.deepEqual(new Tasks(readonly).selection(fresh.id),b);readonly.close();
  config.agents!.profiles.review.model='changed';
  assert.throws(()=>resolveAgent(config,tasks.selection(fresh.id)),/agent_configuration_changed/);
});
test('schema 8 upgrade retains legacy sessions and task state without rewriting existing rows',t=>{
  const {store,tasks,project}=fixture(t);
  store.enqueue(msg('old'));const task=tasks.create(store.get('old')!,{cwd:project,policyHash:'old-policy'});
  store.saveThread(tasks.sessionKey(task),'old-native');
  store.db.exec('DROP TABLE execution_bindings; PRAGMA user_version=8');
  const before=JSON.stringify(store.db.prepare('SELECT * FROM tasks').all());
  const upgraded=new Store(join(project,'..','bot.sqlite'));
  assert.equal(JSON.stringify(upgraded.db.prepare('SELECT * FROM tasks').all()),before);
  assert.equal(new Tasks(upgraded).selection(task.id),undefined);
  assert.equal(new Tasks(upgraded).thread(task),'old-native');
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);upgraded.close();
});
test('queued task keeps selected executor when default changes; existing workstream keeps binding',async t=>{
  const {config,store,tasks}=fixture(t);const requests:RunRequest[]=[];
  const engine=new Engine(store,{async run(r){requests.push(r);r.onThread('native');return {text:'done',threadId:'native',turnId:'turn'};}},
    {async send(_c,_t,u){return u;}},config);
  // Accept while stopped so selection is durable before the first scheduling attempt.
  engine.accept(msg('first'));const first=tasks.list(msg('x'))[0];
  assert.equal(tasks.selection(first.id)?.profileId,'codex');
  config.agents!.defaultProfile='review';engine.start();
  try {
    await waitFor(()=>tasks.get(first.id)?.state==='succeeded');
    engine.accept(msg('same'));await waitFor(()=>tasks.list(msg('x'))[0]?.state==='succeeded');
    assert.equal(tasks.selection(tasks.list(msg('x'))[0].id)?.profileId,'codex');
    engine.accept(msg('reset','/new'));engine.accept(msg('new'));
    await waitFor(()=>tasks.list(msg('x'))[0]?.state==='succeeded');
    const latest=tasks.list(msg('x'))[0];assert.equal(tasks.selection(latest.id)?.profileId,'review');
    assert.equal(requests[2].threadId,undefined);
  } finally {await engine.stop();}
});
test('queued profile revocation fails before executing without falling back to legacy Codex',async t=>{
  const {config,store,tasks}=fixture(t);config.agents!.defaultProfile='review';let calls=0;
  const engine=new Engine(store,{async run(){calls++;return {text:'bad',threadId:'x',turnId:'x'};}},{async send(_c,_t,u){return u;}},config);
  engine.accept(msg('revoked'));const task=tasks.list(msg('x'))[0];config.agents!.profiles.review.enabled=false;config.agents!.defaultProfile='codex';
  engine.start();try {await waitFor(()=>tasks.get(task.id)?.state==='failed');assert.equal(calls,0);assert.equal(tasks.get(task.id)?.error,'agent_profile_unavailable');} finally {await engine.stop();}
});

test('native wait IDs from independent profiles are scoped by durable run identity',t=>{
  const {config,store,tasks,project}=fixture(t);
  for(const id of ['codex','review']){
    const message={...msg(id),chatId:id,chatKey:id}, selection=selectAgent(config,id);store.enqueue(message);
    const task=tasks.create(store.get(id)!,{cwd:project,policyHash:selectedPolicyHash(config,selection)},undefined,selection);
    const run=tasks.start(task);tasks.saveRun(run,'same-native-thread','same-native-turn');
    new Waits(store).request(task.id,run,{threadId:'same-native-thread',turnId:'same-native-turn',callId:'same-native-call',question:'Continue?'});
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM task_waits').get()?.n,2);
});

test('registry migration rebuild preserves every legacy wait field and foreign-key link',t=>{
  const {store,tasks,project}=fixture(t);store.enqueue(msg('legacy-wait'));
  const task=tasks.create(store.get('legacy-wait')!,{cwd:project,policyHash:'legacy'}),run=tasks.start(task);tasks.saveRun(run,'native','turn');
  new Waits(store).request(task.id,run,{threadId:'native',turnId:'turn',callId:'call',question:'Pick?',choices:['one','two']});
  // Recreate the exact schema-8 global native-ID constraint with a populated wait.
  const sql=String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='task_waits'").get()?.sql);
  store.db.exec(`ALTER TABLE task_waits RENAME TO backup_waits;
    ${sql.replace(/\)\s*$/, ', UNIQUE(threadId,turnId,callId))')};
    INSERT INTO task_waits SELECT * FROM backup_waits; DROP TABLE backup_waits;
    DROP TABLE execution_bindings; PRAGMA user_version=8;`);
  const before=JSON.stringify(store.db.prepare('SELECT * FROM task_waits').all());
  store.db.exec('UPDATE task_waits SET rowid=42');
  const upgraded=new Store(join(project,'..','bot.sqlite'));
  assert.equal(JSON.stringify(upgraded.db.prepare('SELECT * FROM task_waits').all()),before);
  assert.equal(upgraded.db.prepare('SELECT rowid FROM task_waits').get()?.rowid,42);
  assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(new Tasks(upgraded).get(task.id)?.state,'running');upgraded.close();
});

function agentManagementFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-agent-management-'));
  const data = join(dir, 'data'), project = join(dir, 'project'), file = join(dir, 'config.json');
  mkdirSync(data); mkdirSync(project);
  const raw = { version: 1, agent: 'codex', dataDir: data, custom: { keep: 'untouched' },
    feishu: { appId: 'agent_management', appSecret: 'PRIVATE_AGENT_MANAGEMENT_SECRET', allowedUserIds: ['alice'], allowedChatIds: [] },
    codex: { bin: 'codex', home: join(data, 'codex-home'), projects: { app: project }, defaultProject: 'app', sandbox: 'read-only' },
    agents: { defaultProfile: 'team', memoryProfile: 'codex', profiles: {
      team: { adapter: 'codex', bin: 'codex-team', model: 'gpt-team', timeoutMs: 120000 },
      future: { adapter: 'claude', enabled: false, bin: join(dir, 'missing-claude') },
      cursor: { adapter: 'cursor', enabled: true },
    } }, concurrency: 1 };
  writeFileSync(file, JSON.stringify(raw));
  const manager = new Management(file, { status: () => ({ running: false, installed: true, registered: false, mode: 'stopped' }) });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { data, file, raw, manager };
}

test('management hides retired registry while preserving legacy Codex configuration and inactive entries on disk', t => {
  const f = agentManagementFixture(t), view = f.manager.config(), before = loadConfig(f.file);
  assert.equal(view.valid, true);
  assert.equal(Object.hasOwn(view, 'agents'), false);
  assert.equal(JSON.stringify(view).includes(f.raw.feishu.appSecret), false);
  assert.deepEqual(Object.keys(before.agents!.profiles), ['team']);
  const selection = selectAgent(before);
  assert.equal(selection.profileId, 'team');
  assert.equal(agentCodexConfig(before, selection).home, join(f.data, 'agents', 'team'));
  f.manager.save(view.revision, { concurrency: 2 });
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.deepEqual(saved.agents, f.raw.agents);
  assert.deepEqual(saved.custom, f.raw.custom);
  assert.equal(saved.feishu.appSecret, f.raw.feishu.appSecret);
  assert.deepEqual(selectAgent(loadConfig(f.file)), selection, 'unrelated saves retain native session identity');
});

test('management and CLI refuse retired agent registry writes without mutating configuration', t => {
  const f = agentManagementFixture(t), revision = f.manager.config().revision, before = readFileSync(f.file, 'utf8');
  for (const agents of [null, {}, f.raw.agents, { defaultProfile: 'codex', profiles: {} }]) {
    assert.throws(() => f.manager.save(revision, { agents }), error => error instanceof ManagementError);
    assert.equal(readFileSync(f.file, 'utf8'), before);
  }
  const result = spawnSync(process.execPath, [resolve('bin/namo.js'), 'login', '--profile', 'future', '--config', f.file], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.file, 'utf8'), before);
});
