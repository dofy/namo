import { t as tr } from './locale.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, parseConfig } from './config.js';
import { ConfigEditor, digest, readJson } from './paths.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { Tasks } from './tasks.js';
import { Recovery, RecoveryError, type Resolution } from './recovery.js';
import { serviceAction, serviceStatus, activeData, waitForService } from './service.js';
import { doctor } from './doctor.js';
import { acquireLock, makeRedactor } from './safety.js';
import { AssistantSettings, AssistantSettingsError } from './assistant.js';
import { Memories, MemoryError, MEMORY_LIMITS, type MemoryAuthority, type MemoryScope } from './memory.js';
import { MigrationMemory, MigrationMemoryError, migrationMemoryStatus } from './migration-memory.js';
import { Profiles, ProfileError } from './profiles.js';
import type { ProfileState, UserProfile } from './ui-contract.js';
import { Browse, BrowseError } from './browse.js';

export class ManagementError extends Error { constructor(message:string,readonly status=409){super(message);} }
export interface ManagementDeps {
  status: typeof serviceStatus; action: typeof serviceAction; wait: typeof waitForService; diagnose: typeof doctor;
}
const defaults:ManagementDeps={status:serviceStatus,action:serviceAction,wait:waitForService,diagnose:doctor};
export class Management {
  readonly dataDir: string;
  private deps:ManagementDeps;
  constructor(readonly file:string, deps:Partial<ManagementDeps>={}) {
    const raw=readJson(file),path=raw.dataDir??'./data';
    if(typeof path!=='string') throw new ManagementError(tr("数据目录配置无效，请先用 namo init 修正"));
    this.dataDir=path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(file),path);
    this.deps={...defaults,...deps};
  }
  private source():{raw:any;revision:string} {
    const text=readFileSync(this.file,'utf8'),raw=JSON.parse(text);
    const path=raw.dataDir??'./data';
    if(typeof path!=='string'||(path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(this.file),path))!==this.dataDir) throw new ManagementError(tr("数据目录已被外部修改，请关闭并重新启动管理界面"));
    return {raw,revision:digest(text)};
  }
  private status():Record<string,any> {
    try{return this.deps.status(loadConfig(this.file));}
    catch{return {running:activeData(this.dataDir),ready:false,connection:'unknown',configInvalid:true};}
  }
  private read<T>(fn:(s:Store)=>T):T|undefined {
    const path=join(this.dataDir,'bot.sqlite');if(!existsSync(path))return;
    const s=new Store(path,true);try{return fn(s);}finally{s.close();}
  }
  private write<T>(fn:(s:Store)=>T):T {
    const version=this.read(s=>Number(s.db.prepare('PRAGMA user_version').get()?.user_version));
    if(version!==SCHEMA_VERSION) throw new ManagementError(tr("当前数据库尚未升级。请在维护窗口升级接收服务；界面没有迁移或修改数据"));
    const s=new Store(join(this.dataDir,'bot.sqlite'));try{return fn(s);}finally{s.close();}
  }
  config():any {
    const {raw,revision}=this.source(),c=raw.codex??{},f=raw.feishu??{};
    let valid=true;try{parseConfig(raw,this.file);}catch{valid=false;}
    const service=this.status();let applied:string|undefined;
    try{const h=readJson(join(this.dataDir,'health.json'));if(service.running&&h.pid===service.pid)applied=h.configRevision;}catch{/* Not yet instrumented. */}
    return {revision,valid,application:!service.running?'stopped':!applied?'unknown':applied===revision?'applied':'pending',
      values:{projects:c.projects??{},defaultProject:c.defaultProject??'',sandbox:c.sandbox??'read-only',networkAccess:c.networkAccess??false,allowLocalCommits:c.allowLocalCommits??false,
        concurrency:raw.concurrency??2,model:c.model??'',bin:c.bin??'codex',timeoutMs:c.timeoutMs??600000,readPaths:c.readPaths??[],denyPaths:c.denyPaths??[],cards:f.cards===true,requireMention:f.requireMention!==false,
        reactions:f.reactions!==false,progressUpdates:f.progressUpdates!==false,progressDelayMs:f.progressDelayMs??12000,progressIntervalMs:f.progressIntervalMs??5000,progressHeartbeatMs:f.progressHeartbeatMs??30000},
      feishu:{appId:f.appId??'',domain:f.domain??'feishu',secretConfigured:!!f.appSecret||!!process.env[f.appSecretEnv??'FEISHU_APP_SECRET'],pairedUsers:Array.isArray(f.allowedUserIds)?f.allowedUserIds.length:0,
        restrictedChats:Array.isArray(f.allowedChatIds)?f.allowedChatIds.length:0},file:this.file};
  }
  state():any {
    const db=this.read(s=>{
      const schema=Number(s.db.prepare('PRAGMA user_version').get()?.user_version);
      if(schema<1||schema>SCHEMA_VERSION)return {schema,tasks:[],issues:[],workstreams:[]};
      return {schema,tasks:s.db.prepare('SELECT id,workstreamId,project,state,inputVersion,startedAt,finishedAt,error FROM tasks ORDER BY rowid DESC LIMIT 50').all(),
        workstreams:s.db.prepare('SELECT id,project,createdAt FROM workstreams ORDER BY createdAt DESC LIMIT 30').all(),
        issues:schema===SCHEMA_VERSION?new Recovery(s).list():[],queue:s.status()};
    });
    return {service:this.status(),config:this.config(),database:db??{schema:0,tasks:[],issues:[],workstreams:[]},recoveryAvailable:db?.schema===SCHEMA_VERSION,profiles:this.profiles(),assistant:this.read(s=>new AssistantSettings(s).read())};
  }
  assistant(action: string, version: number, values: unknown): unknown {
    try {return this.write(s=>{const settings=new AssistantSettings(s);
      if(action==='preview')return settings.preview(values);
      if(action==='reset')return settings.reset(version,{kind:'local-owner',authenticated:true});
      if(action==='save')return settings.save(version,values,{kind:'local-owner',authenticated:true});
      throw new ManagementError('Unsupported assistant operation',400);
    });}catch(e){if(e instanceof AssistantSettingsError)throw new ManagementError(e.message,
      e.code==='invalid'?400:e.code==='forbidden'?403:e.code==='conflict'||e.code==='run_already_adopted'?409:503);throw e;}
  }
  private memoryIdentity(ownerId?:unknown):{ownerId:string;owners:{id:string;label:string}[];projects:string[];appId:string;channel:'feishu'|'lark';secret:string} {
    let config;try{config=loadConfig(this.file);}catch{throw new ManagementError(tr("配置尚未通过校验，请检查项目目录和权限后保存。"),409);}
    const f=config.feishu,ids=[...new Set(f.allowedUserIds)];
    if(!ids.length)throw new ManagementError(tr("请先完成应用配置和用户配对"),409);
    if(ownerId!==undefined&&(typeof ownerId!=='string'||!ids.includes(ownerId)))throw new ManagementError(tr("只能管理当前应用中已配对用户的记忆"),403);
    const selected=typeof ownerId==='string'?ownerId:ids[0]!;
    const names=this.read(s=>{
      const account=s.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
      if(account&&account!==f.appId)throw new ManagementError(tr("应用与数据目录不匹配，不能读取或修改档案"),409);
      if(!s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_profiles'").get())return new Map<string,string>();
      return new Map(s.db.prepare('SELECT userId,name FROM user_profiles WHERE channel=? AND appId=?').all(f.domain,f.appId)
        .map(row=>[String(row.userId),String(row.name)]));
    })??new Map<string,string>();
    const redact=makeRedactor([f.appSecret].filter(Boolean));
    return {ownerId:selected,owners:ids.map(id=>({id,label:redact(names.get(id)??'')||id})),projects:Object.keys(config.codex.projects??{}),
      appId:f.appId,channel:f.domain,secret:f.appSecret};
  }
  private memoryChats(s:Store,ownerId:string,projects:string[]):{chatKey:string;project:string|null}[] {
    const allowed=new Set(projects),seen=new Set<string>(),result:{chatKey:string;project:string|null}[]=[];
    const add=(chatKey:unknown,project:unknown)=>{if(typeof chatKey!=='string'||!chatKey)return;const p=typeof project==='string'&&allowed.has(project)?project:null,key=JSON.stringify([chatKey,p]);if(!seen.has(key)){seen.add(key);result.push({chatKey,project:p});}};
    for(const row of s.db.prepare('SELECT DISTINCT i.chatKey,t.project FROM inbox i LEFT JOIN tasks t ON t.id=i.taskId WHERE i.senderId=?').all(ownerId))add(row.chatKey,row.project);
    for(const row of s.db.prepare('SELECT DISTINCT chatKey,project FROM workstreams WHERE ownerId=?').all(ownerId))add(row.chatKey,row.project);
    return result.sort((a,b)=>a.chatKey.localeCompare(b.chatKey)||(a.project??'').localeCompare(b.project??''));
  }
  memories(ownerId?:unknown):unknown {
    try{
      const identity=this.memoryIdentity(ownerId),result=this.read(s=>{
        if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw new ManagementError(tr("在线数据尚未升级，记忆暂不可编辑；请在维护窗口升级接收服务"),409);
        const redact=makeRedactor([identity.secret].filter(Boolean)),memory=new Memories(s,redact),chats=this.memoryChats(s,identity.ownerId,identity.projects);
        return {available:true,ownerId:identity.ownerId,owners:identity.owners,projects:identity.projects,chats,
          imports:new MigrationMemory(s,{dataDir:this.dataDir,configFile:this.file,appId:identity.appId},redact).list(),
          items:memory.manage({kind:'local-owner',authenticated:true,ownerId:identity.ownerId}),limits:{entryChars:MEMORY_LIMITS.entryChars,
            ownerEntries:MEMORY_LIMITS.ownerEntries,ownerChars:MEMORY_LIMITS.ownerChars,scopeEntries:MEMORY_LIMITS.scopeEntries,scopeChars:MEMORY_LIMITS.scopeChars}};
      });
      if(!result)throw new ManagementError(tr("尚无服务数据库，请先完成初始化"),409);
      return result;
    }catch(e){if(e instanceof MemoryError)throw this.memoryError(e);if(e instanceof MigrationMemoryError)throw new ManagementError(e.message,migrationMemoryStatus(e));throw e;}
  }
  memory(action:unknown,ownerId:unknown,input:unknown):unknown {
    const identity=this.memoryIdentity(ownerId);
    try{return this.write(s=>{
      const account=s.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
      if(account&&account!==identity.appId)throw new ManagementError(tr("应用与数据目录不匹配，不能读取或修改档案"),409);
      const redactor=makeRedactor([identity.secret].filter(Boolean)),memory=new Memories(s,redactor),chats=this.memoryChats(s,identity.ownerId,identity.projects);
      if(!input||typeof input!=='object'||Array.isArray(input))throw new ManagementError(tr("请求内容无效"),400);
      const value=input as Record<string,unknown>,authority:MemoryAuthority={kind:'local-owner',authenticated:true,ownerId:identity.ownerId,
        source:{kind:'local-owner',ref:`workbench:${randomUUID()}`}};
      if(action==='save'){
        const scope=this.validMemoryScope(value.scope,identity.ownerId,identity.projects,chats),text=value.text;
        if(typeof text==='string'&&redactor(text)!==text)throw new ManagementError(tr("记忆不能包含凭据，请移除后重试"),400);
        memory.save({kind:value.kind as any,scope,text:text as string},authority);
      }else if(action==='import'){
        const scope=this.validMemoryScope(value.scope,identity.ownerId,identity.projects,chats);
        new MigrationMemory(s,{dataDir:this.dataDir,configFile:this.file,appId:identity.appId},redactor).importPending({
          migrationId:value.migrationId as string,candidateId:value.candidateId as string,fingerprint:value.fingerprint as string,scope,
        },{kind:'local-owner',authenticated:true,ownerId:identity.ownerId});
      }else{
        if(typeof value.id!=='string'||!Number.isSafeInteger(value.version))throw new ManagementError(tr("记忆编号或版本无效"),400);
        if(action==='correct'){
          if(typeof value.text==='string'&&redactor(value.text)!==value.text)throw new ManagementError(tr("记忆不能包含凭据，请移除后重试"),400);
          memory.correct(value.id,Number(value.version),{text:value.text as string},authority);
        }else if(action==='disable')memory.disable(value.id,Number(value.version),authority);
        else if(action==='delete')memory.delete(value.id,Number(value.version),authority);
        else if(action==='activate')memory.activatePending(value.id,Number(value.version),authority);
        else throw new ManagementError(tr("操作不存在"),400);
      }
      return this.memoryState(s,identity);
    });}catch(e){if(e instanceof MemoryError)throw this.memoryError(e);if(e instanceof MigrationMemoryError)throw new ManagementError(e.message,migrationMemoryStatus(e));throw e;}
  }
  private memoryState(s:Store,identity:ReturnType<Management['memoryIdentity']>):unknown {
    const memory=new Memories(s,makeRedactor([identity.secret].filter(Boolean)));
    const redact=makeRedactor([identity.secret].filter(Boolean));
    return {available:true,ownerId:identity.ownerId,owners:identity.owners,projects:identity.projects,chats:this.memoryChats(s,identity.ownerId,identity.projects),
      imports:new MigrationMemory(s,{dataDir:this.dataDir,configFile:this.file,appId:identity.appId},redact).list(),
      items:memory.manage({kind:'local-owner',authenticated:true,ownerId:identity.ownerId}),limits:{entryChars:MEMORY_LIMITS.entryChars,
        ownerEntries:MEMORY_LIMITS.ownerEntries,ownerChars:MEMORY_LIMITS.ownerChars,scopeEntries:MEMORY_LIMITS.scopeEntries,scopeChars:MEMORY_LIMITS.scopeChars}};
  }
  private validMemoryScope(raw:unknown,ownerId:string,projects:string[],chats:{chatKey:string;project:string|null}[]):MemoryScope {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ManagementError(tr("记忆范围无效"),400);
    const scope=raw as Record<string,unknown>;
    if(scope.ownerId!==ownerId)throw new ManagementError(tr("只能管理当前选择用户的记忆"),403);
    if(scope.kind==='owner'&&scope.project===null&&scope.chatKey===null)return scope as unknown as MemoryScope;
    if(scope.kind==='project'&&typeof scope.project==='string'&&projects.includes(scope.project)&&scope.chatKey===null)return scope as unknown as MemoryScope;
    if(scope.kind==='chat'&&typeof scope.chatKey==='string'&&(scope.project===null||typeof scope.project==='string')
      &&chats.some(chat=>chat.chatKey===scope.chatKey&&(scope.project===null||chat.project===scope.project)))return scope as unknown as MemoryScope;
    throw new ManagementError(tr("记忆范围不属于当前已配对用户、项目或聊天"),403);
  }
  private memoryError(error:MemoryError):ManagementError {
    const status=error.code==='invalid'?400:error.code==='forbidden'?403:error.code==='missing'?404:error.code==='capacity'?413:error.code==='storage_invalid'?503:409;
    return new ManagementError(error.message,status);
  }
  private projections(s: Store): Browse {
    const {raw}=this.source(),f=raw.feishu??{};
    return new Browse(s,{appId:f.appId??'',channel:f.domain??'feishu'},makeRedactor([
      typeof f.appSecret==='string'?f.appSecret:'',process.env[f.appSecretEnv??'FEISHU_APP_SECRET']??'',
    ]));
  }
  browse(kind:'tasks'|'sessions'|'dashboard'|'options',params=new URLSearchParams()):unknown {
    const result=this.read(s=>{
      const schema=Number(s.db.prepare('PRAGMA user_version').get()?.user_version);
      if(schema<1||schema>SCHEMA_VERSION)throw new BrowseError(tr("当前数据版本不支持浏览，请先完成服务初始化或升级"));
      // A deferred read transaction keeps totals and rows consistent without
      // migrating the database or taking a writer reservation from the receiver.
      s.db.exec('BEGIN');
      try{
        const view=this.projections(s);
        const value=kind==='tasks'?view.tasks(params):kind==='sessions'?view.sessions(params):kind==='dashboard'?view.dashboard():view.options();
        s.db.exec('COMMIT');return value;
      }catch(e){s.db.exec('ROLLBACK');throw e;}
    });
    if(result===undefined)throw new BrowseError(tr("尚无任务数据库，请先完成 Namo 初始化"));
    return result;
  }
  profiles(): ProfileState {
    const {raw,revision}=this.source(),f=raw.feishu??{};
    const unavailable=(reason:string):ProfileState=>({available:false,reason,configRevision:revision,entries:[]});
    if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu')||!Array.isArray(f.allowedUserIds)||f.allowedUserIds.some((id:unknown)=>typeof id!=='string'||!id))return unavailable(tr("请先完成应用配置和用户配对"));
    try{return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)return unavailable(tr("在线数据尚未升级，档案暂不可编辑；请在维护窗口升级接收服务"));
      return {available:true,configRevision:revision,entries:[...new Set<string>(f.allowedUserIds)].map(userId=>new Profiles(s,{channel:f.domain??'feishu',appId:f.appId,userId}).get())};
    })??unavailable(tr("尚无服务数据库，请先完成初始化"));}
    catch(e){if(e instanceof ProfileError)return unavailable(e.message);throw e;}
  }
  saveProfile(configRevision:string,userId:string,version:number,patch:unknown):UserProfile {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try{
      const {raw,revision}=this.source(),f=raw.feishu??{};
      if(configRevision!==revision)throw new ManagementError(tr("应用配置已变化，请刷新并重新选择用户"));
      if(typeof userId!=='string'||!Array.isArray(f.allowedUserIds)||!f.allowedUserIds.includes(userId))throw new ManagementError(tr("只能管理当前应用中已配对用户的档案"));
      if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu'))throw new ManagementError(tr("应用身份无效"));
      const redact=makeRedactor([typeof f.appSecret==='string'?f.appSecret:'',process.env[f.appSecretEnv??'FEISHU_APP_SECRET']??''].filter(Boolean));
      if(JSON.stringify(patch)!==redact(JSON.stringify(patch)??''))throw new ManagementError(tr("档案不能包含凭据，请移除后重试"));
      return this.write(s=>new Profiles(s,{channel:f.domain??'feishu',appId:f.appId,userId}).update(version,patch,{source:'local-owner'}));
    }catch(e){if(e instanceof ProfileError)throw new ManagementError(e.message);throw e;}finally{release();}
  }
  save(revision:string,patch:any):any {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try {
      const {raw,revision:current}=this.source();if(current!==revision)throw new ManagementError(tr("配置已被其他页面或程序修改，请刷新后重试"));
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new ManagementError(tr("配置内容无效"));
      const allowed=['projects','defaultProject','sandbox','networkAccess','allowLocalCommits','concurrency','model','bin','timeoutMs','readPaths','denyPaths','cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs','newSecret'];
      if(Object.keys(patch).some(k=>!allowed.includes(k)))throw new ManagementError(tr("包含不允许编辑的配置项"));
      const next=structuredClone(raw);next.codex??={};next.feishu??={};
      for(const key of allowed.filter(k=>!['concurrency','cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs','newSecret'].includes(k))) if(Object.hasOwn(patch,key))next.codex[key]=patch[key];
      if(next.codex.defaultProject==='')delete next.codex.defaultProject;
      if(Object.hasOwn(patch,'concurrency'))next.concurrency=patch.concurrency;
      for(const k of ['cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs'])if(Object.hasOwn(patch,k))next.feishu[k]=patch[k];
      if(patch.newSecret!==undefined) {
        if(typeof patch.newSecret!=='string'||patch.newSecret.length>256)throw new ManagementError(tr("Secret 格式无效"));
        if(patch.newSecret)next.feishu.appSecret=patch.newSecret;
      }
      try{parseConfig(next,this.file);}catch{throw new ManagementError(tr("配置未通过校验：请核对项目目录、默认项目、权限、并发和超时；原配置没有覆盖"));}
      const editor=new ConfigEditor(this.file);if(digest(readFileSync(this.file,'utf8'))!==revision)throw new ManagementError(tr("配置已变化，请刷新"));
      editor.save(next);return this.config();
    } finally {release();}
  }
  async apply(revision:string,confirmed:boolean):Promise<any> {
    if(!confirmed)throw new ManagementError(tr("应用配置需要明确确认重启接收服务"));
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));const maintenance=randomUUID();let paused=false;
    try {
      if(this.source().revision!==revision)throw new ManagementError(tr("配置已变化，请重新检查后应用"));
      const c=loadConfig(this.file),service=this.deps.status(c);
      if(!service.installed||service.mode==='foreground')throw new ManagementError(tr("请在终端管理前台实例或先安装后台服务；界面不会接管其他进程"));
      if(service.running) {
        let h:any;try{h=readJson(join(this.dataDir,'health.json'));}catch{}
        if(h?.pid!==service.pid||h?.managementVersion!==2)throw new ManagementError(tr("在线版本尚不支持安全应用。请在维护窗口手动升级；没有停止现有服务"));
      }
      this.write(s=>s.transaction(()=>{
        if(s.db.prepare("SELECT 1 FROM inbox WHERE state IN ('queued','running','waiting','awaiting_reply')").get()||s.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','sending')").get())throw new ManagementError(tr("仍有在途任务或待发送消息，请完成后再应用；没有中断任务"));
        if(s.db.prepare("SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost')").get())throw new ManagementError(tr("仍有独立运行或失联占位，请完成或在本机核对后再应用配置"));
        if(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get())throw new ManagementError(tr("已有维护操作进行中"));
        s.db.prepare("INSERT INTO settings VALUES('maintenance',?)").run(maintenance);paused=true;
      }));
      if(this.source().revision!==revision)throw new ManagementError(tr("配置已被外部修改，未重启服务"));
      await this.deps.action(service.registered?'restart':'start',c);
      const ready=await this.deps.wait(c,30000);
      return {ready,config:this.config(),message:ready?tr("服务已重新连接；请核对配置生效状态"):tr("服务已尝试启动，连接尚未就绪；请运行 namo doctor")};
    } finally {
      try{if(paused)this.write(s=>{s.db.prepare("DELETE FROM settings WHERE key='maintenance' AND value=?").run(maintenance);});}finally{release();}
    }
  }
  detail(id:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id))throw new ManagementError(tr("任务编号无效"));
    return this.read(s=>{const tasks=new Tasks(s),t=tasks.get(id);if(!t)throw new ManagementError(tr("未找到任务"));
      const summary=this.projections(s).taskSummary(id);
      return {...tasks.detail(t) as object,title:summary?.title,ownerId:summary?.ownerId,ownerName:summary?.ownerName,createdAt:summary?.createdAt,
        results:s.db.prepare("SELECT content,state,part FROM outbox WHERE inboxKey=? AND kind='result' ORDER BY part").all(t.inboxKey)};});
  }
  issue(id:string):any {
    return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw new ManagementError(tr("请先升级接收服务以启用异常核对"));
      const {snapshot:_s,inboxKey:_k,...safe}=new Recovery(s).inspect(id);return safe;
    });
  }
  reconcile(request:Resolution):any {
    const c=loadConfig(this.file);request={...request,note:makeRedactor([c.feishu.appSecret])(request.note??'')};
    try{return this.write(s=>new Recovery(s).resolve(request,{id:'local-owner'},true));}catch(e){if(e instanceof RecoveryError)throw new ManagementError(e.message);throw e;}
  }
  cancel(id:string,inputVersion:number,requestId:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id)||!requestId||requestId.length>100)throw new ManagementError(tr("取消请求无效"));
    return this.write(s=>s.transaction(()=>{
      const old=s.db.prepare('SELECT subject,action,actor FROM reconciliations WHERE requestId=?').get(requestId);
      if(old){if(old.subject===id&&old.action==='cancel'&&old.actor==='local-owner')return {duplicate:true};throw new ManagementError(tr("操作编号已使用"));}
      const tasks=new Tasks(s),t=tasks.get(id);
      if(!t||!['queued','running','waiting'].includes(t.state)||t.inputVersion!==inputVersion)throw new ManagementError(tr("任务已变化，请刷新后操作"));
      if(t.state==='running') {
        const job=s.db.prepare(`SELECT j.state FROM runner_jobs j JOIN task_runs r ON r.id=j.runId WHERE r.taskId=? AND r.state='running' ORDER BY r.startedAt DESC LIMIT 1`).get(t.id);
        if(!job&&!this.status().running)throw new ManagementError(tr("执行器状态需核对；服务未运行，不能确认已停止"));
      }
      if(!tasks.cancel(t))throw new ManagementError(tr("任务已变化或独立运行已结束或失联，请刷新任务或通过异常入口核对；没有再发出停止请求"));
      s.db.prepare('INSERT INTO reconciliations(requestId,subject,actor,action,note,beforeState,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(requestId,id,'local-owner','cancel',tr("本机用户请求停止"),JSON.stringify({state:t.state,inputVersion}),Date.now());
      return {duplicate:false};
    }));
  }
  async diagnose():Promise<any> {return this.deps.diagnose(this.file,false);}
}
