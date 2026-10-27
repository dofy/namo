import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ArtifactError, prepareArtifact } from '../src/artifacts.js';
import { waitFor } from './helpers.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { ArtifactDelivery } from '../src/artifact-delivery.js';
import { chatWorkspace } from '../src/safety.js';
import { parseConfig } from '../src/config.js';
import { Engine, type Sender } from '../src/engine.js';
import { type Runtime } from '../src/runtime.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'namo-artifact-')), project = join(dir, 'project');
  mkdirSync(join(project, 'output'), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const request = { taskId: 'N-ONE', ownerId: 'alice', chatId: 'chat', projectRoot: project, projectRelativePath: 'output/report.md' };
  const authorization = { ...request, source: 'task_instruction' as const };
  return { dir, project, request, authorization };
}

function code(fn: () => unknown): string {
  try { fn(); return 'none'; } catch (error) { assert.ok(error instanceof ArtifactError); return error.code; }
}

test('preparation binds task ownership and freezes verified payload and hash', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), '# result\n');
  const artifact = prepareArtifact(f.request, f.authorization);
  assert.deepEqual(artifact.binding, { taskId: 'N-ONE', ownerId: 'alice', chatId: 'chat' });
  assert.equal(artifact.relativePath, 'output/report.md'); assert.equal(artifact.kind, 'file');
  assert.equal(artifact.mime, 'text/markdown; charset=utf-8');
  assert.equal(artifact.sha256, createHash('sha256').update('# result\n').digest('hex'));
  const first = artifact.readPayload(); first.fill(0);
  assert.equal(artifact.readPayload().toString(), '# result\n');
  writeFileSync(join(f.project, 'output/report.md'), 'changed after preparation');
  assert.equal(artifact.readPayload().toString(), '# result\n');
  assert.equal(Object.isFrozen(artifact), true); assert.equal(Object.isFrozen(artifact.binding), true);
});

test('task, owner, chat, project and exact path authorization must all match', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), 'ok');
  for (const patch of [{ taskId: 'N-TWO' }, { ownerId: 'bob' }, { chatId: 'other' },
    { projectRoot: join(f.dir, 'other') }, { projectRelativePath: 'output/other.md' }]) {
    assert.equal(code(() => prepareArtifact({ ...f.request, ...patch }, f.authorization)), 'artifact_not_authorized');
  }
  assert.equal(code(() => prepareArtifact(f.request, { ...f.authorization, source: 'material' as any })), 'artifact_not_authorized');
});

test('absolute, traversal, denied, external and symlink paths are rejected', t => {
  const f = fixture(t); writeFileSync(join(f.project, 'output/report.md'), 'ok');
  const outside = join(f.dir, 'outside.md'); writeFileSync(outside, 'outside');
  symlinkSync(outside, join(f.project, 'output/link.md'));
  const attempt = (path: string) => {
    const request = { ...f.request, projectRelativePath: path };
    return code(() => prepareArtifact(request, { ...request, source: 'task_instruction' }));
  };
  assert.equal(attempt(outside), 'invalid_artifact_path');
  assert.equal(attempt('../outside.md'), 'invalid_artifact_path');
  assert.equal(attempt('output/link.md'), 'artifact_symlink_denied');
  for (const path of ['.git/result.md', 'config/result.md', 'data/result.md', 'logs/result.md', 'output/config.local.json', 'output/.env']) {
    assert.equal(attempt(path), 'artifact_path_denied');
  }
  const deepRequest = { ...f.request, projectRelativePath: 'output/report.md' };
  assert.equal(code(() => prepareArtifact(deepRequest, { ...deepRequest, source: 'task_instruction' }, { maxDepth: 1 })), 'invalid_artifact_path');
});

test('unsupported, empty, oversized and signature-mismatched files fail before delivery', t => {
  const f = fixture(t);
  const attempt = (path: string, bytes: string | Buffer, options: any = {}) => {
    writeFileSync(join(f.project, 'output', path), bytes);
    const request = { ...f.request, projectRelativePath: `output/${path}` };
    return code(() => prepareArtifact(request, { ...request, source: 'task_instruction' }, options));
  };
  assert.equal(attempt('run.sh', '#!/bin/sh'), 'artifact_type_unsupported');
  assert.equal(attempt('empty.txt', ''), 'artifact_empty');
  assert.equal(attempt('large.txt', '123456', { maxBytes: 5 }), 'artifact_size_limit');
  assert.equal(attempt('fake.png', 'not png'), 'artifact_type_mismatch');
  assert.equal(attempt('binary.md', Buffer.from([0xc3, 0x28])), 'artifact_type_mismatch');
});

test('supported image and PDF signatures are classified without reading them again at send time', t => {
  const f = fixture(t);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('payload')]);
  writeFileSync(join(f.project, 'output/image.png'), png);
  const imageRequest = { ...f.request, projectRelativePath: 'output/image.png' };
  const image = prepareArtifact(imageRequest, { ...imageRequest, source: 'task_instruction' });
  assert.equal(image.kind, 'image'); assert.equal(image.mime, 'image/png'); assert.deepEqual(image.readPayload(), png);
  writeFileSync(join(f.project, 'output/report.pdf'), '%PDF-1.7\nfixture');
  const pdfRequest = { ...f.request, projectRelativePath: 'output/report.pdf' };
  const pdf = prepareArtifact(pdfRequest, { ...pdfRequest, source: 'task_instruction' });
  assert.equal(pdf.platformFileType, 'pdf'); assert.equal(pdf.kind, 'file');
});

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
  assert.equal(store.db.prepare("SELECT * FROM artifact_deliveries WHERE id='artifact:intent'").get()!.state,'sent');
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
  assert.equal(store.db.prepare("SELECT * FROM artifact_deliveries WHERE id='artifact:manual-delivery'").get()!.state,'sent');
});
