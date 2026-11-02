import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { acquireLock } from './safety.js';
import { loadConfig, parseConfig, migrateDirectoryConfiguration, type Config } from './config.js';
import { digest } from './paths.js';
import type { Store } from './store.js';
import type { RuntimeFactory, RuntimeHost } from './runtime-host.js';
import { executionPolicy } from './access.js';
import { legacyPolicyHash, selectAgent, selectedPolicyHash } from './agent-registry.js';

/** Reuse the existing private save backup after a receiver crash; never copy credentials into SQLite. */
export function queuedConfiguration(saved:Config):{config:Config;revision:string} {
  const revision=digest(readFileSync(saved.file,'utf8')), normal={config:saved,revision};
  const healthFile=join(saved.dataDir,'health.json'),database=join(saved.dataDir,'bot.sqlite');
  if(!existsSync(healthFile)||!existsSync(database))return normal;
  const health=JSON.parse(readFileSync(healthFile,'utf8'));
  if(!health.automaticConfiguration||health.configRevision===revision)return normal;
  const db=new DatabaseSync(database,{readOnly:true});let pending=false;
  try {pending=!!db.prepare("SELECT 1 FROM tasks WHERE state IN ('queued','running','waiting') LIMIT 1").get();} finally {db.close();}
  if(!pending)return normal;
  const directory=join(saved.dataDir,'config-backups');
  if(/^[a-f0-9]{64}$/.test(health.configRevision)&&existsSync(directory))for(const name of readdirSync(directory).sort().reverse()) {
    if(!/^[0-9]+-[a-f0-9-]+\.json$/.test(name))continue;
    const file=join(directory,name);if(lstatSync(file).isSymbolicLink())continue;
    const raw=readFileSync(file,'utf8');if(digest(raw)!==health.configRevision)continue;
    const previous=parseConfig(JSON.parse(raw),saved.file);
    if(previous.dataDir===saved.dataDir&&previous.feishu.appId===saved.feishu.appId&&previous.feishu.domain===saved.feishu.domain)return {config:previous,revision:health.configRevision};
  }
  throw Error('configuration_queue_snapshot_unavailable');
}

function retainModelContexts(store:Store,before:Config,after:Config):void {
  const rows=store.db.prepare('SELECT w.id,w.policyHash,w.project,t.inboxKey FROM workstreams w JOIN tasks t ON t.id=(SELECT id FROM tasks WHERE workstreamId=w.id ORDER BY rowid DESC LIMIT 1)').all();
  for(const row of rows) {
    const message=store.get(String(row.inboxKey));if(!message)continue;
    try {
      const oldPolicy=executionPolicy(before.codex,before.feishu,message,row.project?String(row.project):undefined,before.github);
      const newPolicy=executionPolicy(after.codex,after.feishu,message,row.project?String(row.project):undefined,after.github);
      if(legacyPolicyHash({...oldPolicy,model:undefined})!==legacyPolicyHash({...newPolicy,model:undefined}))continue;
      const oldConfig={...before,codex:oldPolicy},newConfig={...after,codex:newPolicy};
      if(row.policyHash!==selectedPolicyHash(oldConfig,selectAgent(oldConfig,'codex')))continue;
      store.db.prepare('UPDATE workstreams SET policyHash=? WHERE id=?').run(selectedPolicyHash(newConfig,selectAgent(newConfig,'codex')),row.id);
      store.db.prepare('UPDATE execution_bindings SET selection=? WHERE subjectId=?').run(JSON.stringify(selectAgent(newConfig,'codex')),row.id);
    } catch { /* Changed access or unsupported profiles never inherit context. */ }
  }
}

/** Hold new task creation while the accepted queue drains. Never restart a turn. */
export function watchConfiguration(store:Store, host:RuntimeHost, initial:Config, revision:string,
  prepare:(next:Config)=>Promise<RuntimeFactory>,
  commit:(next:Config,revision:string)=>void|Promise<void>,
  report:(state:'pending'|'applied'|'error')=>void) {
  let applied=revision, appliedConfig=initial, pending=false, closed=false, running:Promise<void>|undefined;
  const observe=()=>{
    if(closed)return;
    try { if(appliedConfig.codex.directories===undefined||digest(readFileSync(initial.file,'utf8'))!==applied){pending=true;host.drainConfiguration(true);report('pending');} }
    catch {pending=true;host.drainConfiguration(true);report('error');}
  };
  const tick=async()=>{
    observe(); if(!pending||closed)return;
    if(store.db.prepare("SELECT 1 FROM tasks WHERE state IN ('queued','running','waiting') LIMIT 1").get()
      ||store.db.prepare("SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost') LIMIT 1").get()
      ||store.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','sending') LIMIT 1").get()
      ||store.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get())return;
    let unlock:(()=>void)|undefined;
    try {
      unlock=acquireLock(join(initial.dataDir,'config-edit.lock'));
      migrateDirectoryConfiguration(initial.file);
      const nextRevision=digest(readFileSync(initial.file,'utf8')), next=loadConfig(initial.file);
      // Account/data relocation is a migration, not an ordinary settings save.
      if(next.dataDir!==initial.dataDir||next.feishu.appId!==initial.feishu.appId||next.feishu.domain!==initial.feishu.domain)throw Error('configuration_identity_changed');
      if(nextRevision!==digest(readFileSync(initial.file,'utf8')))return;
      const factory=await prepare(next);
      if(closed||nextRevision!==digest(readFileSync(initial.file,'utf8')))return;
      await host.replace(factory,async()=>{
        if(nextRevision!==digest(readFileSync(initial.file,'utf8')))throw Error('configuration_changed');
        await commit(next,nextRevision);
        store.transaction(()=>retainModelContexts(store,appliedConfig,next));
      });
      applied=nextRevision;appliedConfig=next;pending=false;host.drainConfiguration(false);report('applied');
    } catch {report('error');} finally {unlock?.();}
  };
  const timer=setInterval(()=>{if(!closed&&!running)running=tick().catch(()=>report('error')).finally(()=>{running=undefined;});},250);
  return {observe,stop:async()=>{closed=true;clearInterval(timer);await running;}};
}
