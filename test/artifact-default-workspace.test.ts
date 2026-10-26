import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store,type Incoming} from '../src/store.js';import {Tasks} from '../src/tasks.js';import {ArtifactDelivery} from '../src/artifact-delivery.js';import {chatWorkspace} from '../src/safety.js';
import {parseConfig} from '../src/config.js';import {Engine,type Sender} from '../src/engine.js';import type {Runtime} from '../src/runtime.js';

const waitFor=async(condition:()=>boolean,timeoutMs=5000)=>{const deadline=Date.now()+timeoutMs;while(!condition()){if(Date.now()>deadline)throw new Error('condition_timeout');await new Promise(resolve=>setTimeout(resolve,10));}};
const enveloped=(key:string,text:string):Incoming=>({key,messageId:`om_${key}`,chatKey:'app:chat',chatId:'chat',senderId:'owner',text,
  envelope:{version:1,type:'text',kind:'instruction',scopeKey:'topic-one',threadId:'topic-one',chatType:'p2p',materials:[],limitations:[]}});
function defaultConfig(root:string){return parseConfig({dataDir:'./data',concurrency:1,codex:{sandbox:'workspace-write'},feishu:{appId:'app',allowedUserIds:['owner'],allowedChatIds:['chat'],reactions:false,progressUpdates:false}},join(root,'config.json'));}
test('default isolated workspace permits its authorized output but explicit deny remains effective',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'namo-default-artifact-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const chatKey='app:chat',cwd=chatWorkspace(dir,chatKey);mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,'answer.md'),'verified output');
  const input={key:'task',messageId:'om_task',chatKey,chatId:'chat',senderId:'owner',text:'create file'};store.enqueue(input);const tasks=new Tasks(store),created=tasks.create(store.get(input.key)!,{cwd,policyHash:'policy'});
  store.db.prepare("UPDATE tasks SET state='succeeded' WHERE id=?").run(created.id);const task=tasks.get(created.id)!;const command={...input,key:'delivery',messageId:'om_delivery',text:`/deliver ${task.id} answer.md`};store.enqueue(command);
  let sends=0;const sender={async send(){return 'text';},async uploadArtifact(){return 'file';},async sendArtifact(){sends++;return 'file-message';}};
  const delivery=new ArtifactDelivery(store,sender,[dir],{dataDir:dir,explicitDenyPaths:[]});delivery.enqueue(command,task,'answer.md');await delivery.tick();assert.equal(sends,1);
  assert.throws(()=>new ArtifactDelivery(store,sender,[dir],{dataDir:dir,explicitDenyPaths:[dir]}).enqueue({...command,key:'denied'},task,'answer.md'),/artifact_path_denied/);
});

test('real enveloped default workspace permits /run delivery intent under parseConfig built-in denies',async t=>{
  const root=mkdtempSync(join(tmpdir(),'namo-default-intent-')),config=defaultConfig(root);mkdirSync(config.dataDir,{recursive:true});
  const store=new Store(join(config.dataDir,'bot.sqlite')),bytes=Buffer.from('intent default workspace\n');let uploads=0,sends=0;
  const runtime:Runtime={async run(request){writeFileSync(join(request.cwd,'answer.md'),bytes);return{text:'done',threadId:'thread',turnId:'turn'};}};
  const sender:Sender={async send(_chat,_text,uuid){return uuid;},async uploadArtifact(artifact){uploads++;assert.deepEqual(artifact.readPayload(),bytes);return'file-key';},
    async sendArtifact(_chat,key,_uuid,route){sends++;assert.equal(key,'file-key');assert.deepEqual(route,{messageId:'om_intent',thread:true});return'artifact-message';}};
  const engine=new Engine(store,runtime,sender,{dataDir:config.dataDir,concurrency:1,codex:config.codex,feishu:config.feishu});
  t.after(async()=>{await engine.stop();store.close();rmSync(root,{recursive:true,force:true});});
  assert.ok(config.codex.denyPaths?.includes(config.dataDir));engine.start();engine.accept(enveloped('intent','/run --deliver answer.md -- create it'));
  await waitFor(()=>uploads===1&&sends===1);for(let index=0;index<4;index++)await engine.pump();
  const task=store.db.prepare("SELECT * FROM tasks WHERE inboxKey='intent'").get();
  assert.equal(realpathSync(String(task?.cwd)),realpathSync(chatWorkspace(config.dataDir,'topic-one:user:owner')));assert.equal(uploads,1);assert.equal(sends,1);
  assert.equal(JSON.parse(String(store.db.prepare("SELECT value FROM settings WHERE key='artifact:intent'").get()?.value)).state,'sent');
});

test('real enveloped default workspace permits manual /deliver after successful task',async t=>{
  const root=mkdtempSync(join(tmpdir(),'namo-default-manual-')),config=defaultConfig(root);mkdirSync(config.dataDir,{recursive:true});
  const store=new Store(join(config.dataDir,'bot.sqlite')),bytes=Buffer.from('manual default workspace\n');let uploads=0,sends=0;
  const runtime:Runtime={async run(request){writeFileSync(join(request.cwd,'manual.md'),bytes);return{text:'created',threadId:'thread',turnId:'turn'};}};
  const sender:Sender={async send(_chat,_text,uuid){return uuid;},async uploadArtifact(artifact){uploads++;assert.deepEqual(artifact.readPayload(),bytes);return'manual-key';},
    async sendArtifact(_chat,key){sends++;assert.equal(key,'manual-key');return'manual-message';}};
  const engine=new Engine(store,runtime,sender,{dataDir:config.dataDir,concurrency:1,codex:config.codex,feishu:config.feishu});
  t.after(async()=>{await engine.stop();store.close();rmSync(root,{recursive:true,force:true});});engine.start();engine.accept(enveloped('task','create manual file'));
  await waitFor(()=>store.get('task')?.state==='replied');const taskId=store.get('task')!.taskId!;
  engine.accept(enveloped('manual-delivery',`/deliver ${taskId} manual.md`));await waitFor(()=>uploads===1&&sends===1);
  for(let index=0;index<4;index++)await engine.pump();
  assert.equal(realpathSync(String(new Tasks(store).get(taskId)?.cwd)),realpathSync(chatWorkspace(config.dataDir,'topic-one:user:owner')));assert.equal(uploads,1);assert.equal(sends,1);
  assert.equal(JSON.parse(String(store.db.prepare("SELECT value FROM settings WHERE key='artifact:manual-delivery'").get()?.value)).state,'sent');
});
