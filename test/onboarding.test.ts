import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onboard, initialConfig, type InitDeps } from '../src/onboarding.js';
import type { Prompter } from '../src/prompts.js';
import type { FeishuEvent } from '../src/feishu.js';
import { acquireLock } from '../src/safety.js';
import { atomicJson, readJson, ConfigEditor, configFile } from '../src/paths.js';
import { PairingChallenge, type SetupConnection } from '../src/feishu-setup.js';

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
  const c=initialConfig(file);c.codex.projects={app:dir};c.codex.defaultProject='app';c.feishu.appId='cli_aaaaaaaaaaaaaaaa';c.feishu.appSecret='test-secret-do-not-print';c.custom={preserved:true};atomicJson(file,c);
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
  const originalText=f.ui.text;
  f.ui.text=async(label,initial,secret)=>{
    if(label.startsWith('Codex'))return process.execPath;
    if(label.startsWith('允许 Agent'))return f.dir;
    if(label==='App ID')return'cli_aaaaaaaaaaaaaaaa';
    if(secret)return'new-private-secret';
    return originalText(label,initial,secret);
  };
  f.ui.confirm=async label=>!label.includes('允许修改')&&!label.includes('命令联网')&&!label.includes('后台服务')&&!label.includes('再配对');
  const result=await onboard(f.file,f.ui,f.deps);assert.equal(result.verified,true);
  const raw=readJson(f.file);assert.equal(raw.agent,'codex');assert.equal(raw.codex.sandbox,'read-only');assert.deepEqual(raw.feishu.allowedUserIds,['ou_owner']);
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
