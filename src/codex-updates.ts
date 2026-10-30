import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import type { CodexUpdateStatus } from './ui-contract.js';
import { digest } from './paths.js';
import { acquireLock } from './safety.js';
import { SCHEMA_VERSION } from './store.js';
import { Rpc } from './codex-connection.js';
import { NAMO_VERSION } from './version.js';
import { fetchStableRelease, installCodexRelease, readCodexVersion, targetTriple } from './codex-distribution.js';
import { installationRoot, installationState, installedBinary, resolveCodexBinary, saveInstallation, type CodexInstallation } from './codex-installation.js';

export interface UpdateDependencies {
  latest: typeof fetchStableRelease; install: typeof installCodexRelease; version: typeof readCodexVersion;
  probe: (config: Config['codex'], signal?: AbortSignal) => Promise<void>; now: () => number;
}
const defaults: UpdateDependencies = { latest: fetchStableRelease, install: installCodexRelease, version: readCodexVersion, now: Date.now,
  probe: async (config,signal) => {
    const rpc=new Rpc(config.bin,config.home,config.sandbox,config,false,undefined,false);
    const abort=()=>rpc.stop();signal?.addEventListener('abort',abort,{once:true});
    try {
      if(signal?.aborted)throw Error('update_cancelled');
      await rpc.request('initialize',{clientInfo:{name:'namo-update',version:NAMO_VERSION},capabilities:{experimentalApi:true}});
      rpc.notify('initialized');
      const account=await rpc.request('account/read',{refreshToken:false});
      const permissions=await rpc.request('permissionProfile/list',{});
      const catalog=await rpc.request('model/list',{limit:100});
      if(!account.account || !permissions.data?.some((p:{id:string;allowed:boolean})=>p.id==='feishu-bot'&&p.allowed)
        || !Array.isArray(catalog.data) || !catalog.data.length)throw Error('update_probe_failed');
    } finally { signal?.removeEventListener('abort',abort);await rpc.close(); }
  } };
const DAY = 86_400_000, RETRY = 3_600_000;
export function newerVersion(candidate: string, current: string | null): boolean {
  if (!current) return true;
  const a=candidate.split('.').map(Number), b=current.split('-')[0].split('.').map(Number);
  for (let i=0;i<3;i++) { if (a[i]!==b[i]) return a[i]>b[i]; }
  return current.includes('-');
}

/** Claiming a task and selecting a new binary serialize through the same SQLite write lock. */
export function whileCodexIdle<T>(config: Config, run: () => T): { busy: true } | { busy: false; value: T } {
  const file=join(config.dataDir,'bot.sqlite');
  if (!existsSync(file)) return {busy:false,value:run()};
  const db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION) throw Error('update_database_incompatible');
    const busy=[
      "SELECT 1 FROM inbox WHERE state IN ('queued','running','waiting','awaiting_reply') LIMIT 1",
      "SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost') LIMIT 1",
      "SELECT 1 FROM memory_jobs WHERE state='running' LIMIT 1",
      "SELECT 1 FROM settings WHERE key='maintenance' LIMIT 1",
    ].some(sql=>!!db.prepare(sql).get());
    if (busy) { db.exec('ROLLBACK'); return {busy:true}; }
    const value=run(); db.exec('COMMIT'); return {busy:false,value};
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

export class CodexUpdates {
  private readonly deps: UpdateDependencies;
  private running?: Promise<void>;
  private controller?: AbortController;
  private closed=false;
  private versionCache?: { bin: string; at: number; version: string | null };
  constructor(private readonly config: Config, deps: Partial<UpdateDependencies> = {},
    private readonly revision = digest(readFileSync(config.file,'utf8'))) { this.deps={...defaults,...deps}; }
  private read(): CodexInstallation { return installationState(this.config.codex.bin,this.config.codex.home); }
  private write(value: CodexInstallation): void { saveInstallation(this.config.codex.home,value); }
  async status(): Promise<CodexUpdateStatus> {
    const s=this.read(),bin=resolveCodexBinary(this.config.codex.bin,this.config.codex.home);
    if (!this.versionCache || this.versionCache.bin!==bin || this.deps.now()-this.versionCache.at>60000)
      this.versionCache={bin,at:this.deps.now(),version:await this.deps.version(bin,this.config.codex.home)};
    const currentVersion=this.versionCache.version;
    return {supported:!!targetTriple(),currentVersion,latestVersion:s.latestVersion,checkedAt:s.checkedAt,automatic:s.automatic,
      state:s.state,updateAvailable:!!s.latestVersion&&newerVersion(s.latestVersion,currentVersion),managed:!!s.active?.directory,
      previousVersion:s.previous?.version??null,error:s.error};
  }
  async action(action: string, enabled?: boolean, automaticAttempt=false): Promise<CodexUpdateStatus> {
    if(this.closed)throw Error('update_cancelled');
    this.unchanged(this.revision);
    if (!['check','upgrade','automatic','rollback'].includes(action)) throw Error('update_action_invalid');
    if (!targetTriple()) throw Error('update_unsupported');
    if (action==='automatic' && typeof enabled!=='boolean') throw Error('update_action_invalid');
    const release=this.lock();
    let state: CodexInstallation;
    try {
      state=this.read();
      if (action==='automatic') { this.write({...state,automatic:enabled!,...(enabled?{attemptedAt:null,failureCount:0}: {})}); release(); return this.status(); }
      if (action==='rollback'&&!state.previous) throw Error('update_no_previous');
      this.unchanged(this.revision);
      const revision=this.revision;
      const priorError=automaticAttempt?state.error:null,priorFailures=automaticAttempt?(state.failureCount??0):0;
      state={...state,state:action==='check'?'checking':'installing',ownerPid:process.pid,error:null,attemptedAt:this.deps.now(),
        pendingAction:null, ...(automaticAttempt?{}:{failureCount:0}),
        ...(action==='rollback'?{automatic:false}:{})};
      this.write(state);
      this.controller=new AbortController();
      this.running=this.perform(action,state,revision).catch(error=>{
        // Never publish child output, fetch errors, paths or credentials.
        const code=error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)?error.message:'update_failed';
        const previous=this.read(),count=priorError===code?priorFailures+1:1;
        this.write({...previous,state:'failed',ownerPid:null,error:code,failureCount:Math.min(count,5)});
      }).finally(()=>{release();this.running=undefined;this.controller=undefined;});
      void this.running.catch(()=>{});
      // A status read may execute --version; it must not keep the operation lock on failure.
    } catch (error) { release(); throw error; }
    return this.status();
  }
  private lock(): () => void {
    try { return acquireLock(join(installationRoot(this.config.codex.home),'operation')); }
    catch { throw Error('update_busy'); }
  }
  private unchanged(revision: string): void {
    if(this.closed||this.controller?.signal.aborted)throw Error('update_cancelled');
    if(digest(readFileSync(this.config.file,'utf8'))!==revision)throw Error('update_config_changed');
  }
  private async perform(action: string, state: CodexInstallation, revision: string): Promise<void> {
    const c=this.config.codex;
    const current=await this.deps.version(resolveCodexBinary(c.bin,c.home),c.home);
    if (action==='rollback') {
      const previous=state.previous!;
      const bin=previous.directory?installedBinary(c.home,previous):c.bin;
      if (await this.deps.version(bin,c.home)!==previous.version) throw Error('update_previous_changed');
      await this.deps.probe({...c,bin},this.controller?.signal);
      this.unchanged(revision);
      const switched=whileCodexIdle(this.config,()=>this.write({...state,active:previous.directory?previous:null,
        previous:state.active,state:'idle',ownerPid:null,error:null,automatic:false,failureCount:0}));
      if(switched.busy)this.write({...state,state:'deferred',ownerPid:null,pendingAction:'rollback'});
      return;
    }
    const latest=await this.deps.latest({signal:this.controller?.signal});
    this.unchanged(revision);
    state={...state,latestVersion:latest.version,checkedAt:this.deps.now()};
    this.write(state);
    if (action==='check'||!newerVersion(latest.version,current)) { this.write({...state,state:'idle',ownerPid:null,failureCount:0,error:null}); return; }
    if (whileCodexIdle(this.config,()=>{}).busy) { this.write({...state,state:'deferred',ownerPid:null,pendingAction:'upgrade'}); return; }
    const candidate=state.candidate;
    if(candidate && candidate.version===latest.version && candidate.target===latest.target && candidate.sha256===latest.sha256 && candidate.configRevision===revision){
      const bin=installedBinary(c.home,candidate);
      if(await this.deps.version(bin,c.home)!==candidate.version)throw Error('update_candidate_changed');
      await this.deps.probe({...c,bin},this.controller?.signal);this.unchanged(revision);
      const switched=whileCodexIdle(this.config,()=>this.write({...state,active:{version:candidate.version,directory:candidate.directory},candidate:null,
        previous:state.active??(current?{version:current,directory:null}:null),state:'idle',ownerPid:null,error:null,failureCount:0}));
      if(switched.busy)this.write({...state,state:'deferred',ownerPid:null,pendingAction:'upgrade'});
      return;
    }
    const parent=join(installationRoot(c.home),'releases'); mkdirSync(parent,{recursive:true,mode:0o700});
    const destination=join(parent,`${latest.version}-${latest.target}-${randomUUID()}`);
    let activated=false,retained=false;
    try {
      const bin=await this.deps.install(latest,destination,{signal:this.controller?.signal});
      this.unchanged(revision);
      // Absolute candidate paths bypass the managed selection until validation succeeds.
      try { await this.deps.probe({...c,bin},this.controller?.signal); } catch { throw Error(this.closed?'update_cancelled':'update_probe_failed'); }
      this.unchanged(revision);
      const active={version:latest.version,directory:basename(destination)};
      const switched=whileCodexIdle(this.config,()=>{
        // Retain the directory even if an atomic state write reports an
        // ambiguous failure after rename; the active pointer may reference it.
        activated=true;
        this.write({...state,active,candidate:null,previous:state.active??(current?{version:current,directory:null}:null),state:'idle',ownerPid:null,error:null,failureCount:0});
      });
      if(switched.busy){retained=true;this.write({...state,state:'deferred',ownerPid:null,pendingAction:'upgrade',candidate:{...active,target:latest.target,sha256:latest.sha256,configRevision:revision}});}
    } finally {
      // Only this operation's unpublished directory can be removed; old selected versions are retained.
      if(!activated&&!retained)rmSync(destination,{recursive:true,force:true});
    }
  }
  async settled(): Promise<void> { await this.running; }
  async close(): Promise<void> { this.closed=true;this.controller?.abort();await this.running; }
  async tick(): Promise<void> {
    if(this.running)return;
    const s=this.read(); if(!s.automatic && !(s.state==='deferred' && s.pendingAction))return;
    const now=this.deps.now();
    if(s.state==='deferred') { if(whileCodexIdle(this.config,()=>{}).busy)return; }
    else if(s.state==='failed') { if((s.failureCount??0)>=5)return; if(s.attemptedAt && now-s.attemptedAt<RETRY*2**Math.max(0,(s.failureCount??1)-1))return; }
    else if(s.attemptedAt!==null && s.checkedAt && now-s.checkedAt<DAY)return;
    try { await this.action(s.state==='deferred' && s.pendingAction ? s.pendingAction : 'upgrade',undefined,true); } catch(error) { if(!(error instanceof Error)||error.message!=='update_busy')throw error; }
  }
}

export function startCodexAutoUpdates(config: Config): () => Promise<void> {
  const updater=new CodexUpdates(config),revision=digest(readFileSync(config.file,'utf8'));
  let closed=false,ticking=false;
  const tick=async()=>{
    if(closed||ticking)return; ticking=true;
    try { if(digest(readFileSync(config.file,'utf8'))===revision)await updater.tick(); }
    catch { /* Status retains bounded failure codes; the receiver remains available. */ }
    finally { ticking=false; }
  };
  const timer=setInterval(()=>void tick(),60_000);timer.unref();void tick();
  return async()=>{closed=true;clearInterval(timer);await updater.close();};
}
