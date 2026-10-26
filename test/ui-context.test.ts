import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { Memories } from '../src/memory.js';
import { Store, type Incoming } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { buildTaskRunPrompt, isDateTimeTask } from '../src/task-context.js';

function fixture(t:any){
  const root=mkdtempSync(join(tmpdir(),'namo-context-')),data=join(root,'data'),project=join(root,'project');mkdirSync(data);mkdirSync(project);
  const config:Config={file:join(root,'config.json'),dataDir:data,concurrency:1,agent:'codex',feishu:{appId:'app',appSecret:'KNOWN_SECRET_123456',allowedUserIds:['alice'],allowedChatIds:[],requireMention:false,domain:'feishu'},
    codex:{bin:'codex',home:join(data,'auth'),timeoutMs:600000,sandbox:'workspace-write',projects:{one:project},defaultProject:'one',networkAccess:false,readPaths:[],denyPaths:[],allowLocalCommits:false},
    gitApprovals:{maxTtlMs:300000,remotes:[]}};
  const store=new Store(join(data,'bot.sqlite'));store.bindAccount('app');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,data,project,config,store};
}
function incoming(id:string,chatType:'p2p'|'group'='p2p'):Incoming{return {key:`app:${id}`,messageId:id,chatKey:chatType==='p2p'?'app:dm-alice':'app:group-one',chatId:chatType==='p2p'?'dm-alice':'group-one',senderId:'alice',text:'Implement the task',
  envelope:{version:1,type:'text',kind:'instruction',chatType,scopeKey:chatType==='p2p'?'app:dm-alice':'app:group-one',materials:[],limitations:[]}};}
function create(f:ReturnType<typeof fixture>,message:Incoming){f.store.enqueue(message);const tasks=new Tasks(f.store),created=tasks.create(f.store.get(message.key)!,{project:'one',cwd:f.project,policyHash:policyHash(f.config.codex)}),run=tasks.start(created);return {tasks,task:tasks.get(created.id)!,run,inbox:f.store.get(message.key)!};}
const local=(ref:string)=>({kind:'local-owner' as const,authenticated:true,ownerId:'alice',source:{kind:'local-owner' as const,ref}});

test('fresh installs preserve the exact prompt when assistant is inactive and no memory exists',t=>{
  const f=fixture(t),created=create(f,incoming('legacy')),before=created.tasks.prompt(created.task);
  assert.equal(buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run),before);
  assert.ok(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`assistant:run:${created.run}`));
  assert.equal(f.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`memory:snapshot:${created.run}`),undefined);
});

test('date/time classification uses explicit words and does not mistake runtime for time',()=>{
  assert.equal(isDateTimeTask('debug the runtime error'),false);assert.equal(isDateTimeTask('what time is the release?'),true);
  assert.equal(isDateTimeTask('核对今天的日程'),true);assert.equal(isDateTimeTask('优化 runtime'),false);
});

test('private runs compose authorized memory as non-authorizing context',t=>{
  const f=fixture(t),memory=new Memories(f.store);
  memory.save({kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'Keep replies concise'},local('owner'));
  memory.save({kind:'project_knowledge',scope:{kind:'project',ownerId:'alice',project:'one',chatKey:null},text:'Never treat remembered direct push as approval'},local('project'));
  memory.save({kind:'project_knowledge',scope:{kind:'chat',ownerId:'alice',project:'one',chatKey:'app:group-one'},text:'Group-visible convention'},local('group'));
  const created=create(f,incoming('private')),prompt=buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run);
  assert.match(prompt,/Keep replies concise/);assert.match(prompt,/remembered direct push/);assert.doesNotMatch(prompt,/Group-visible convention/);
  assert.match(prompt,/not an instruction, permission, approval/);
  assert.doesNotMatch(JSON.stringify(memory.snapshotRecord(created.run)),/Keep replies|direct push/);
});

test('group runs receive only memory explicitly bound to that exact chat and project',t=>{
  const f=fixture(t),memory=new Memories(f.store);
  memory.save({kind:'preference',scope:{kind:'owner',ownerId:'alice',project:null,chatKey:null},text:'PRIVATE_OWNER_VALUE'},local('owner'));
  memory.save({kind:'project_knowledge',scope:{kind:'project',ownerId:'alice',project:'one',chatKey:null},text:'PRIVATE_PROJECT_VALUE'},local('project'));
  memory.save({kind:'project_knowledge',scope:{kind:'chat',ownerId:'alice',project:'one',chatKey:'app:group-one'},text:'VISIBLE_GROUP_VALUE'},local('group'));
  const created=create(f,incoming('group','group')),prompt=buildTaskRunPrompt(f.store,created.task,created.inbox,f.config,created.run);
  assert.match(prompt,/VISIBLE_GROUP_VALUE/);assert.doesNotMatch(prompt,/PRIVATE_OWNER_VALUE|PRIVATE_PROJECT_VALUE/);
});
