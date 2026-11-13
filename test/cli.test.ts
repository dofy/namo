import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initialConfig, onboard, type InitDeps } from '../src/onboarding.js';
test('new installations enable progress cards without altering legacy defaults',()=>{
 assert.equal(initialConfig('/tmp/namo-config-test/config.json').feishu.cards,true);
});
import { loadConfig } from '../src/config.js';
import { atomicJson, readJson, ConfigEditor, configFile } from '../src/paths.js';
import { renderLaunchAgent } from '../src/service.js';
import { type Prompter } from '../src/prompts.js';
import { type FeishuEvent } from '../src/feishu.js';
import { acquireLock } from '../src/safety.js';
import { PairingChallenge, type SetupConnection } from '../src/feishu-setup.js';

const bin=resolve('bin/namo.js');
test('CLI keeps lifecycle commands and rejects invalid arguments before loading configuration',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const run=(...a:string[])=>spawnSync(process.execPath,[bin,...a],{cwd:dir,encoding:'utf8',env:{...process.env,NAMO_HOME:dir,NAMO_LANG:'system',LC_ALL:'en_US.UTF-8'}});
 for(const command of ['doctor','check','status','logs','agent','issues','issue','resolve','access','github','approval']) {const result=run(command);assert.equal(result.status,1);assert.match(result.stderr,/namo ui/);}
 assert.match(run('migrate').stderr,/namo init --import/);
 assert.match(run('init','--import').stderr,/interactive (?:local )?terminal/);
 assert.match(run('service','status').stderr,/namo ui/);
 assert.match(run('service').stderr,/install.*uninstall/);
 assert.equal(run('ui','--import').status,1);
 assert.equal(run('login','extra').status,1);
 assert.match(run('config', '--config', join(dir, 'other.json')).stderr,/No configuration/);
 const init=run('init');assert.equal(init.status,1);assert.match(init.stderr,/interactive (?:local )?terminal/);
 assert.match(run('init','--lang','zh-CN').stderr,/交互终端/);
 assert.match(run('--config',join(dir,'other.json'),'ui').stderr,/No configuration/);
});
test('service render uses explicit installed entry and private config references without secrets',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-service-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json');const raw=initialConfig(file, file.slice(0, file.lastIndexOf('/')));raw.feishu.appSecret='SECRET_MUST_NOT_APPEAR';atomicJson(file,raw);
 const xml=renderLaunchAgent(loadConfig(file),'io.namo.0123456789ab','/installed/namo/bin.js','/stable/node','/tools/a&b');
 assert.ok(xml.includes('/installed/namo/bin.js'));assert.ok(xml.includes('/tools/a&amp;b'));assert.ok(!xml.includes(raw.feishu.appSecret));assert.ok(xml.includes(file));
});

test('status recognizes a foreground instance but needs matching health to report ready',async t=>{
 const {serviceStatus}=await import('../src/service.js');const {acquireLock}=await import('../src/safety.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-foreground-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json');atomicJson(file,initialConfig(file, file.slice(0, file.lastIndexOf('/'))));const c=loadConfig(file);const release=acquireLock(c.dataDir);
 try{
  assert.equal(serviceStatus(c).running,true);assert.equal(serviceStatus(c).ready,false);
  atomicJson(join(c.dataDir,'health.json'),{pid:process.pid,connection:'connected',ready:true});
  assert.equal(serviceStatus(c).ready,true);
  atomicJson(join(c.dataDir,'health.json'),{pid:process.pid+100000,connection:'connected',ready:true});assert.equal(serviceStatus(c).ready,false);
 }finally{release()}
});

function event(code: string, user = 'ou_owner'): FeishuEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: 'message-'+code, chat_id: 'private-chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: code }) } };
}
test('pairing requires private user exact single-use code before expiration', () => {
  let time=100; const c = new PairingChallenge(() => time, 10);
  assert.equal(c.accept(event('wrong')), undefined);
  const group = event(c.code); group.message!.chat_type = 'group'; assert.equal(c.accept(group), undefined);
  const bot = event(c.code); bot.sender!.sender_type='app'; assert.equal(c.accept(bot), undefined);
  assert.equal(c.accept(event(c.code))?.senderId, 'ou_owner'); assert.equal(c.accept(event(c.code)), undefined);
  const expired = new PairingChallenge(() => time, 10); time=110; assert.equal(expired.accept(event(expired.code)), undefined);
});
function fixture(t: { after(fn:()=>void):void }) {
  const dir=mkdtempSync(join(tmpdir(),'namo-init-')); const file=join(dir,'config.json');
  const oldHome=process.env.NAMO_HOME;process.env.NAMO_HOME=join(dir,'namo-home');
  t.after(()=>{if(oldHome===undefined)delete process.env.NAMO_HOME;else process.env.NAMO_HOME=oldHome;});
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const c=initialConfig(file, file.slice(0, file.lastIndexOf('/')));c.codex.directories=[dir];c.feishu.appId='cli_aaaaaaaaaaaaaaaa';c.feishu.appSecret='test-secret-do-not-print';c.custom={preserved:true};atomicJson(file,c);
  let accept:(e:FeishuEvent)=>void=()=>{};let calls=0,sends=0,closed=0;
  const connection:SetupConnection={async credentials(){return true},async connect(fn){accept=fn},async identity(){return{id:'bot',name:'Test Bot'}},async send(){sends++;return'receipt'},close(){closed++}};
  const deps:Partial<InitDeps>={async probe(){return[{id:'agent.protocol',status:'ok',message:'ready'}]},connection:()=>connection,async live(){calls++;return true},async install(){return{ready:true}}};
  const answers=(label:string)=> !label.includes('后台服务')&&!label.includes('再配对')&&!label.includes('上次测试');
  const ui:Prompter={async text(_l,initial){return initial??''},async confirm(label){return answers(label)},info(message){const code=message.match(/NAMO-[A-F0-9]{16}/)?.[0];if(code)queueMicrotask(()=>accept(event(code)))},close(){}};
  return{dir,file,deps,ui,get calls(){return calls},get sends(){return sends},get closed(){return closed}};
}
test('init pairs locally before inference, verifies receipt, preserves unknown fields and resumes without rerun',async t=>{
  const f=fixture(t); const original=f.deps.live!;
  f.deps.live=async c=>{assert.ok(readJson(f.file).feishu.allowedUserIds.includes('ou_owner'));return original(c)};
  const first=await onboard(f.file,f.ui,f.deps);assert.equal(first.verified,true);assert.equal(f.calls,1);assert.equal(f.sends,1);assert.equal(f.closed,1);
  assert.deepEqual(readJson(f.file).custom,{preserved:true});
  const second=await onboard(f.file,f.ui,f.deps);assert.equal(second.verified,true);assert.equal(f.calls,1);assert.equal(f.sends,1);
  assert.ok(existsSync(join(f.dir,'data','config-backups')));
});
test('local owner rejection does not authorize user or run model',async t=>{
  const f=fixture(t);const previous=f.ui.confirm;f.ui.confirm=async l=>l.includes('允许此用户')?false:previous(l);
  const r=await onboard(f.file,f.ui,f.deps);assert.equal(r.configured,false);assert.deepEqual(readJson(f.file).feishu.allowedUserIds,[]);assert.equal(f.calls,0);assert.equal(f.sends,0);
});
test('active config is never changed or connected by init',async t=>{
  const f=fixture(t);const before=readFileSync(f.file);const release=acquireLock(join(f.dir,'data'));
  try{await assert.rejects(onboard(f.file,f.ui,f.deps),/运行中的接收端/);assert.deepEqual(readFileSync(f.file),before);assert.equal(f.calls,0);assert.equal(f.closed,0)}finally{release()}
});
test('ambiguous send is persisted and cannot automatically replay inference on resume',async t=>{
  const f=fixture(t);const conn=f.deps.connection!;f.deps.connection=c=>({...conn(c),async send(){throw new Error('network')}});
  await assert.rejects(onboard(f.file,f.ui,f.deps),/发送结果未确认/);assert.equal(f.calls,1);
  assert.equal(readJson(join(f.dir,'data','onboarding','state.json')).verification.status,'unknown');
  await onboard(f.file,f.ui,f.deps);assert.equal(f.calls,1);
});
test('configuration editing refuses concurrent changes and never overwrites them',t=>{
  const f=fixture(t);const editor=new ConfigEditor(f.file);const other={...editor.value,changedByUser:true};atomicJson(f.file,other);
  assert.throws(()=>editor.save({...editor.value,newValue:1}),/其他程序修改/);assert.deepEqual(readJson(f.file),other);
});
test('configuration paths preserve legacy selection and explicit/env precedence',t=>{
  const dir=mkdtempSync(join(tmpdir(),'namo-path-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const env={NAMO_HOME:dir};assert.equal(configFile(undefined,dir,env),join(dir,'config.json'));
  writeFileSync(join(dir,'config.local.json'),'{}');assert.equal(configFile(undefined,dir,env),join(dir,'config.local.json'));
  assert.equal(configFile(undefined,dir,{...env,NAMO_CONFIG:join(dir,'custom.json')}),join(dir,'custom.json'));
  assert.equal(configFile(join(dir,'explicit.json'),dir,env),join(dir,'explicit.json'));
});

test('fresh init creates private config and completes guided setup without developer JSON editing',async t=>{
  const f=fixture(t);rmSync(f.file);
  const originalText=f.ui.text;let directoryPrompts=0;
  f.ui.text=async(label,initial,secret)=>{
    if(label.startsWith('Codex'))return process.execPath;
    if(label.startsWith('允许 Agent')){assert.equal(initial,'');return ++directoryPrompts===1?'':f.dir;}
    if(label==='App ID')return'cli_aaaaaaaaaaaaaaaa';
    if(secret)return'new-private-secret';
    return originalText(label,initial,secret);
  };
  f.ui.confirm=async label=>!label.includes('允许修改')&&!label.includes('命令联网')&&!label.includes('后台服务')&&!label.includes('再配对');
  const result=await onboard(f.file,f.ui,f.deps);assert.equal(result.verified,true);
  const raw=readJson(f.file);assert.equal(directoryPrompts,2);assert.deepEqual(raw.codex.directories,[realpathSync(f.dir)]);assert.equal(raw.codex.defaultProject,undefined);assert.equal(raw.dataDir,join(f.dir,'namo-home','data'));assert.equal(raw.agent,'codex');assert.equal(raw.codex.sandbox,'workspace-write');assert.deepEqual(raw.feishu.allowedUserIds,['ou_owner']);
});
test('aborting pairing leaves no authorized identity and releases both receiver locks',async t=>{
  const f=fixture(t);const abort=new AbortController();f.ui.signal=abort.signal;
  f.ui.info=message=>{if(message.includes('NAMO-'))queueMicrotask(()=>abort.abort())};
  await assert.rejects(onboard(f.file,f.ui,f.deps),/取消/);assert.deepEqual(readJson(f.file).feishu.allowedUserIds,[]);assert.equal(f.calls,0);
  const release=acquireLock(join(f.dir,'data'));release();
});

test('partial legacy config is completed with defaults while preserving its fields',async t=>{
 const f=fixture(t);atomicJson(f.file,{custom:{keep:true}});
 f.ui.text=async(label,initial,secret)=>label.startsWith('Codex')?process.execPath:label.startsWith('允许 Agent')?f.dir:label==='App ID'?'cli_aaaaaaaaaaaaaaaa':secret?'new-secret':initial??'';
 f.ui.confirm=async label=>!label.includes('允许修改')&&!label.includes('命令联网')&&!label.includes('后台服务');
 const result=await onboard(f.file,f.ui,f.deps);assert.equal(result.verified,true);assert.deepEqual(readJson(f.file).custom,{keep:true});
});

test('terminal configuration saves only selected settings and preserves secrets and other fields', async t=>{
 const {terminalConfig}=await import('../src/terminal-config.js');const {Management}=await import('../src/management.js');const {Back}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-terminal-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json'),raw=initialConfig(file,dir);raw.feishu.appSecret='private-secret';raw.feishu.appId='cli_aaaaaaaaaaaaaaaa';raw.codex.directories=[dir];raw.custom={untouched:true};atomicJson(file,raw);
 const answers=['1','model','concurrency','$save','0'],textAnswers=['example-model','12'],messages:string[]=[];
 const ui={select:async()=>{const answer=answers.shift()!;if(answer==='0')throw new Back();return answer;},text:async()=>textAnswers.shift()!,confirm:async()=>true,info:(s:string)=>messages.push(s),close:()=>{}};
 await terminalConfig(new Management(file),ui);
 const saved=readJson(file);assert.equal(saved.codex.model,'example-model');assert.equal(saved.concurrency,12);assert.equal(saved.feishu.appSecret,'private-secret');assert.deepEqual(saved.custom,{untouched:true});assert.ok(messages.every(s=>!s.includes('private-secret')));
});

test('terminal configuration Escape discards a partially entered draft',async t=>{
 const {terminalConfig}=await import('../src/terminal-config.js');const {Management}=await import('../src/management.js');const {Back}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-terminal-cancel-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json'),raw=initialConfig(file,dir);raw.feishu.appSecret='private-secret';raw.codex.directories=[dir];atomicJson(file,raw);const original=readFileSync(file,'utf8');
 const answers=['1','model','$back','0'],messages:string[]=[];
 const ui={select:async()=>{const answer=answers.shift()!;if(answer==='0')throw new Back();return answer;},text:async()=> 'unsaved-model',confirm:async()=>true,info:(message:string)=>messages.push(message),close:()=>{}};
 await terminalConfig(new Management(file),ui);assert.equal(readFileSync(file,'utf8'),original);assert.ok(messages.some(s=>s.includes('取消')||s.includes('Cancelled')));assert.ok(messages.every(s=>!s.includes('private-secret')));
});

test('terminal configuration Escape at the top menu exits without changes',async t=>{
 const {terminalConfig}=await import('../src/terminal-config.js');const {Management}=await import('../src/management.js');const {Back}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-terminal-exit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'config.json');atomicJson(file,initialConfig(file,dir));const original=readFileSync(file,'utf8');
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[],_initial?:string,mode?:'root')=>{assert.equal(mode,'root');assert.ok(!options.some(option=>option.value==='0'));throw new Back();},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 await terminalConfig(new Management(file),ui);assert.equal(readFileSync(file,'utf8'),original);
});

test('terminal main menu restores the selected entry after returning from its page',async t=>{
 const {terminalConfig}=await import('../src/terminal-config.js');const {Management}=await import('../src/management.js');const {Back}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-terminal-focus-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json');atomicJson(file,initialConfig(file,dir));let step=0;const rootSelections:(string|undefined)[]=[];
 const ui={select:async(_label:string,_options:import('../src/config-prompts.js').Option[],initial?:string,mode?:'root')=>{if(mode==='root')rootSelections.push(initial);if(step++===0)return '2';throw new Back();},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 await terminalConfig(new Management(file),ui);assert.deepEqual(rootSelections,[undefined,'2']);
});

test('terminal menu bounds Unicode labels to prevent wrapping in narrow windows',async()=>{
 const {fitTerminalLine}=await import('../src/config-prompts.js');
 assert.equal(fitTerminalLine('  ❯ 🤖 模型',8),'  ❯ 🤖 ');
 assert.equal(fitTerminalLine('📁 文件',5),'📁 文');
 assert.equal(fitTerminalLine('👨‍👩‍👧‍👦ab',3),'👨‍👩‍👧‍👦a');
});

test('terminal summary aligns columns by display width and falls back to one column',async()=>{
 const {formatTerminalSummary,terminalCellWidth}=await import('../src/config-prompts.js');
 const rows:[string,string][][]=[[['服务','已生效'],['配置','有效']],[['模型','默认'],['并发','8']],[['目录','3'],['MCP','3']]];
 const lines=formatTerminalSummary(rows,80);
 assert.deepEqual(lines.map((line,index)=>terminalCellWidth(line.slice(0,line.indexOf(['配置','并发','MCP'][index])))),[18,18,18]);
 assert.ok(lines.every(line=>line.includes(': ')));
 assert.equal(formatTerminalSummary(rows,20).length,6);
 const styles:string[]=[];formatTerminalSummary(rows,80,(code,text)=>{styles.push(code);return text;});assert.ok(styles.includes('2'));assert.ok(styles.includes('1'));
});

test('terminal menu supports Vim navigation without consuming modified keys',async()=>{
 const {menuNavigation}=await import('../src/config-prompts.js');
 assert.equal(menuNavigation({name:'j'},false),'down');
 assert.equal(menuNavigation({name:'k'},false),'up');
 assert.equal(menuNavigation({name:'h'},false),'home');
 assert.equal(menuNavigation({name:'left'},false),'back');
 assert.equal(menuNavigation({name:'l'},false),'accept');
 assert.equal(menuNavigation({name:'g'},false),'prefix');
 assert.equal(menuNavigation({name:'g'},true),'first');
 assert.equal(menuNavigation({name:'g',shift:true},false),'last');
 assert.equal(menuNavigation({name:'j',ctrl:true},false),undefined);
 assert.equal(menuNavigation({name:'h',meta:true},false),undefined);
 assert.equal(menuNavigation({name:'j',shift:true},false),undefined);
 assert.equal(menuNavigation({name:'escape'},false),'back');
 assert.equal(menuNavigation({name:'escape',meta:true},false),'back');
 assert.equal(menuNavigation({name:'escape',meta:true},false,'root'),'back');
 assert.equal(menuNavigation({name:'h'},false,'root'),undefined);
 assert.equal(menuNavigation({name:'left'},false,'root'),undefined);
 assert.equal(menuNavigation({name:'return'},false),'accept');
});

test('terminal refresh keeps cancellation notice on the next screen',async t=>{
 const {terminalConfig}=await import('../src/terminal-config.js');const {Management}=await import('../src/management.js');const {Back}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-screen-refresh-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'config.json');atomicJson(file,initialConfig(file,dir));
 let screens=0,step=0;let lines:string[]=[];
 const ui={screen:()=>{screens++;lines=[];},select:async()=>{step++;if(step===1)return '1';throw new Back();},text:async()=>'',confirm:async()=>false,info:(line:string)=>lines.push(line),close:()=>{}};
 await terminalConfig(new Management(file),ui);assert.equal(screens,4);assert.ok(lines.some(line=>line.includes('取消')||line.includes('Cancelled')));
});

test('terminal form exposes save and back as distinct keyboard actions',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');
 let choices:import('../src/config-prompts.js').Option[]=[];
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[])=>{choices=options;return '$back';},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 assert.equal(await editForm(ui,'test',{model:''},[{key:'model',label:'Model',kind:'text'}],()=>{}),false);
 assert.deepEqual(choices.filter(option=>option.action).map(option=>[option.value,option.shortcut]),[['$edit','E'],['$save','S'],['$back','Esc']]);
 assert.deepEqual(choices.filter(option=>!option.action).map(option=>option.value),['model']);
});

test('restoring a form field to its initial value clears unsaved state',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Back}=await import('../src/config-prompts.js');
 const answers=['model','model'];const values=['new','original'];let confirmations=0;
 const ui={select:async()=>{const next=answers.shift();if(!next)throw new Back();return next;},text:async()=>values.shift()!,confirm:async()=>{confirmations++;return true;},info:(_message:string)=>{},close:()=>{}};
 assert.equal(await editForm(ui,'Model',{model:'original'},[{key:'model',label:'Model',kind:'text',clearable:true}],()=>{}),false);
 assert.equal(confirmations,0);
});

test('MCP actions use the selected connection directly',async()=>{
 const {manageMcp}=await import('../src/terminal-mcp.js');const {selectedAction}=await import('../src/config-prompts.js');
 let optionsSeen:import('../src/config-prompts.js').Option[]=[];let tested='';
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[])=>{optionsSeen=options;return selectedAction('test','connection');},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 const manager={config:()=>({revision:'r',mcpConnections:[{id:'connection',type:'remote',url:'https://example.test'}]}),testMcp:async(_revision:string,id:string)=>{tested=id;return {toolCount:1};}} as unknown as import('../src/management.js').Management;
 await manageMcp(manager,ui);assert.equal(tested,'connection');assert.ok(optionsSeen.some(o=>o.value==='test'&&o.targeted&&o.shortcut==='T'));
 assert.deepEqual(optionsSeen.filter(o=>!o.action).map(o=>o.value),['connection']);
 assert.ok(optionsSeen.some(o=>o.value==='$add'&&o.action&&o.shortcut==='A'));
 assert.ok(optionsSeen.some(o=>o.value==='$import'&&o.action&&o.shortcut==='I'));
});

test('empty MCP list exposes add and import without selected-item actions',async()=>{
 const {manageMcp}=await import('../src/terminal-mcp.js');const {Back}=await import('../src/config-prompts.js');let options:import('../src/config-prompts.js').Option[]=[];
 const ui={select:async(_label:string,items:import('../src/config-prompts.js').Option[])=>{options=items;throw new Back();},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 const manager={config:()=>({revision:'r',mcpConnections:[]})} as unknown as import('../src/management.js').Management;
 await assert.rejects(manageMcp(manager,ui),Back);
 assert.equal(options.filter(o=>!o.action).length,1);assert.equal(options.find(o=>!o.action)?.disabled,true);
 assert.deepEqual(options.filter(o=>o.action).map(o=>o.shortcut),['A','I']);
});

test('MCP removal confirmation names the selected connection',async()=>{
 const {manageMcp}=await import('../src/terminal-mcp.js');const {Back,selectedAction}=await import('../src/config-prompts.js');let prompt='';let step=0,saves=0;
 const ui={select:async()=>{if(step++===0)return selectedAction('remove','second');throw new Back();},text:async()=>'',confirm:async(label:string)=>{prompt=label;return false;},info:(_message:string)=>{},close:()=>{}};
 const manager={config:()=>({revision:'r',mcpConnections:[{id:'first',type:'remote',url:'https://first.example'},{id:'second',type:'remote',url:'https://second.example'}]}),save:()=>{saves++;}} as unknown as import('../src/management.js').Management;
 await assert.rejects(manageMcp(manager,ui),Back);assert.ok(prompt.includes('second'));assert.ok(!prompt.includes('first'));assert.equal(saves,0);
});

test('profile actions open the chosen editor directly and return to the list',async()=>{
 const {editProfiles}=await import('../src/terminal-settings.js');const {Back,selectedAction}=await import('../src/config-prompts.js');
 const optionsSeen:string[][]=[],initials:(string|undefined)[]=[];let step=0;
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[],initial?:string)=>{optionsSeen.push(options.map(o=>o.value));initials.push(initial);if(step++===0)return selectedAction('model','user');throw new Back();},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 const manager={profiles:()=>({available:true,configRevision:'r',entries:[{userId:'user',name:'Name'}]})} as unknown as import('../src/management.js').Management;
 await assert.rejects(editProfiles(manager,ui),Back);
 assert.ok(optionsSeen[1].includes('model'));assert.ok(optionsSeen[2].includes('user'));assert.equal(initials[2],'user');
});

test('form keeps field selection when a save confirmation is declined',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Back}=await import('../src/config-prompts.js');
 const actions=['second','$save','exit'],initials:(string|undefined)[]=[];
 const ui={select:async(_label:string,_options:import('../src/config-prompts.js').Option[],initial?:string)=>{initials.push(initial);const next=actions.shift();if(next==='exit')throw new Back();assert.ok(next);return next;},text:async()=> 'changed',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 // Reject saving, then allow the final discard so the form can exit.
 let calls=0;ui.confirm=async()=>++calls===2;
 assert.equal(await editForm(ui,'Settings',{first:'a',second:'b'},[{key:'first',label:'First',kind:'text'},{key:'second',label:'Second',kind:'text'}],()=>{}),false);
 assert.deepEqual(initials,['first','second','second']);
});

test('terminal list editing preserves spaces and semicolons while adding, editing and removing individual items',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {selectedAction,parseSelectedAction}=await import('../src/config-prompts.js');
 const selections=['$list:directories:0',selectedAction('$add','$list:directories:0'),selectedAction('$delete','$list:directories:1'),'$save'];
 const inputs=['/path/with spaces;and semicolon','/new folder/item'];
 let saved:unknown;let firstLabels:string[]=[];
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[])=>{
  if(!firstLabels.length)firstLabels=options.map(o=>o.label);
  const value=selections.shift();assert.ok(value);const target=parseSelectedAction(value);assert.ok(options.some(o=>o.value===(target?.[1]??value)));return value;
 },text:async()=>{const value=inputs.shift();assert.ok(value);return value;},confirm:async()=>true,info:(_message:string)=>{},close:()=>{}};
 const result=await editForm(ui,'Directories',{directories:['/old dir','/remove me']},[{key:'directories',label:'Directories',kind:'list'}],(draft,changed)=>{saved=structuredClone(draft);assert.deepEqual([...changed],['directories']);});
 assert.equal(result,true);assert.ok(firstLabels.includes('/old dir'));assert.ok(firstLabels.includes('/remove me'));
 assert.ok(firstLabels.every(label=>!label.includes('+ ')));
 assert.deepEqual(saved,{directories:['/path/with spaces;and semicolon','/new folder/item']});
});

test('terminal list changes can be discarded without saving',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Back,selectedAction}=await import('../src/config-prompts.js');
 let step=0,saves=0;
 const ui={select:async()=>{if(step++===0)return selectedAction('$add','$list:directories:empty');throw new Back();},text:async()=>'/new path',confirm:async()=>true,info:(_message:string)=>{},close:()=>{}};
 const result=await editForm(ui,'Directories',{directories:[]},[{key:'directories',label:'Directories',kind:'list'}],()=>{saves++;});
 assert.equal(result,false);assert.equal(saves,0);
});

test('clear shortcut changes only the selected clearable field',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {selectedAction}=await import('../src/config-prompts.js');
 const selections=[selectedAction('$clear','model'),'$save'];let saved:unknown;
 const ui={select:async()=>selections.shift()!,text:async()=>{throw Error('unexpected input');},confirm:async()=>true,info:(_message:string)=>{},close:()=>{}};
 await editForm(ui,'Model',{model:'old',bin:'codex'},[{key:'model',label:'Model',kind:'text',clearable:true},{key:'bin',label:'Command',kind:'text'}],draft=>{saved=structuredClone(draft);});
 assert.deepEqual(saved,{model:'',bin:'codex'});
});

test('terminal directory editor saves an existing path containing spaces',async t=>{
 const {editDirectories}=await import('../src/terminal-settings.js');const {Management}=await import('../src/management.js');
 const {selectedAction}=await import('../src/config-prompts.js');
 const dir=mkdtempSync(join(tmpdir(),'namo-directory-list-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'config.json'),directory=join(dir,'folder with spaces;extra');mkdirSync(directory);
 const raw=initialConfig(file,dir);raw.codex.directories=[];atomicJson(file,raw);
 const selections=[selectedAction('$add','$list:directories:empty'),'$save'];
 const ui={select:async()=>selections.shift()!,text:async()=>directory,confirm:async()=>true,info:(_message:string)=>{},close:()=>{}};
 const manager=new Management(file);
 assert.equal(await editDirectories(manager,ui,manager.config()),true);
 assert.deepEqual(readJson(file).codex.directories,[directory]);
});

test('list fields in mixed forms open a nested list and remain a draft until saving',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Back,selectedAction}=await import('../src/config-prompts.js');
 const selections=['denyPaths',selectedAction('$delete','$list:denyPaths:0'),'$escape','$save'];let saved:unknown;const seen:import('../src/config-prompts.js').Option[][]=[];
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[])=>{seen.push(options);const next=selections.shift()!;if(next==='$escape')throw new Back();return next;},text:async()=>'',confirm:async()=>true,info:(_message:string)=>{},close:()=>{}};
 const fields:import('../src/terminal-forms.js').Field[]=[{key:'model',label:'Model',kind:'text'},{key:'denyPaths',label:'Excluded paths',kind:'list'}];
 assert.equal(await editForm(ui,'Settings',{model:'codex',denyPaths:['/one','/two']},fields,d=>{saved=structuredClone(d);}),true);
 assert.deepEqual(seen[0].filter(o=>!o.action).map(o=>o.value),['model','denyPaths']);
 assert.ok(!seen[0].some(o=>o.value==='$add'||o.value==='$delete'));
 assert.ok(seen[1].some(o=>o.value==='$list:denyPaths:0'));assert.ok(!seen[1].some(o=>o.label.startsWith('+ ')));
 assert.deepEqual(saved,{model:'codex',denyPaths:['/two']});
});

test('home from a changed nested list asks once and keeps the draft when declined',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Home,Back,selectedAction}=await import('../src/config-prompts.js');
 const actions=['deny',selectedAction('$delete','$list:deny:0'),'home','back','$save'];let confirmations=0,saved:unknown;
 const ui={select:async()=>{const next=actions.shift();if(next==='home')throw new Home();if(next==='back')throw new Back();assert.ok(next);return next;},text:async()=>'',confirm:async()=>++confirmations!==1,info:(_message:string)=>{},close:()=>{}};
 const result=await editForm(ui,'Settings',{model:'x',deny:['one','two']},[{key:'model',label:'Model',kind:'text'},{key:'deny',label:'Excluded',kind:'list'}],d=>{saved=structuredClone(d);});
 assert.equal(result,true);assert.equal(confirmations,2);assert.deepEqual(saved,{model:'x',deny:['two']});
});

test('home discards parent and nested drafts only after one confirmation',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');const {Home,selectedAction}=await import('../src/config-prompts.js');
 const actions=['model','deny',selectedAction('$delete','$list:deny:0'),'home'];let confirmations=0,saves=0;
 const ui={select:async()=>{const next=actions.shift();if(next==='home')throw new Home();assert.ok(next);return next;},text:async()=> 'changed',confirm:async()=>{confirmations++;return true;},info:(_message:string)=>{},close:()=>{}};
 await assert.rejects(editForm(ui,'Settings',{model:'x',deny:['one','two']},[{key:'model',label:'Model',kind:'text'},{key:'deny',label:'Excluded',kind:'list'}],()=>{saves++;}),Home);
 assert.equal(confirmations,1);assert.equal(saves,0);
});

test('an empty list shows an inert placeholder while keeping add available',async()=>{
 const {editForm}=await import('../src/terminal-forms.js');let seen:import('../src/config-prompts.js').Option[]=[];
 const ui={select:async(_label:string,options:import('../src/config-prompts.js').Option[])=>{seen=options;return '$back';},text:async()=>'',confirm:async()=>false,info:(_message:string)=>{},close:()=>{}};
 assert.equal(await editForm(ui,'Directories',{directories:[]},[{key:'directories',label:'Directories',kind:'list'}],()=>{}),false);
 assert.equal(seen[0].disabled,true);assert.deepEqual(seen[0].availableActions,['$add']);assert.ok(seen.some(o=>o.value==='$add'&&o.shortcut==='A'));
});
