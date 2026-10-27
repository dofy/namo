import { Waits } from '../src/waits.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { getAgentRegistry, selectAgent, resolveAgent, agentCodexConfig, selectedPolicyHash, agentSessionKey } from '../src/agent-registry.js';
import { Store, SCHEMA_VERSION, type Incoming } from '../src/store.js';
import { Tasks, policyHash } from '../src/tasks.js';
import { Engine } from '../src/engine.js';
import type { RunRequest } from '../src/runtime.js';

const msg = (key: string, text = '/run hello'): Incoming => ({key,messageId:key,chatId:'chat',chatKey:'chat',senderId:'alice',text});
const wait = async (fn: () => boolean) => { const end=Date.now()+5000; while(!fn()){if(Date.now()>end)throw new Error('timeout');await new Promise(r=>setTimeout(r,10));} };
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
  assert.throws(()=>selectAgent(config,'future'),/agent_adapter_unavailable/);
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
    await wait(()=>tasks.get(first.id)?.state==='succeeded');
    engine.accept(msg('same'));await wait(()=>tasks.list(msg('x'))[0]?.state==='succeeded');
    assert.equal(tasks.selection(tasks.list(msg('x'))[0].id)?.profileId,'codex');
    engine.accept(msg('reset','/new'));engine.accept(msg('new'));
    await wait(()=>tasks.list(msg('x'))[0]?.state==='succeeded');
    const latest=tasks.list(msg('x'))[0];assert.equal(tasks.selection(latest.id)?.profileId,'review');
    assert.equal(requests[2].threadId,undefined);
  } finally {await engine.stop();}
});
test('queued profile revocation fails before executing without falling back to legacy Codex',async t=>{
  const {config,store,tasks}=fixture(t);config.agents!.defaultProfile='review';let calls=0;
  const engine=new Engine(store,{async run(){calls++;return {text:'bad',threadId:'x',turnId:'x'};}},{async send(_c,_t,u){return u;}},config);
  engine.accept(msg('revoked'));const task=tasks.list(msg('x'))[0];config.agents!.profiles.review.enabled=false;config.agents!.defaultProfile='codex';
  engine.start();try {await wait(()=>tasks.get(task.id)?.state==='failed');assert.equal(calls,0);assert.equal(tasks.get(task.id)?.error,'agent_profile_unavailable');} finally {await engine.stop();}
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
  const upgraded=new Store(join(project,'..','bot.sqlite'));
  assert.equal(JSON.stringify(upgraded.db.prepare('SELECT * FROM task_waits').all()),before);
  assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(new Tasks(upgraded).get(task.id)?.state,'running');upgraded.close();
});
