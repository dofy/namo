import { AgentRegistryError } from './agent-registry.js';
import { directoryConfiguration } from './legacy-config.js';
import {addsDuplicateMcpEndpoint} from './mcp-endpoint-contract.js';
import { listCodexMcp, selectCodexMcp, CodexMcpImportError } from './codex-mcp-import.js';
import { serviceLogs, listApprovals, changeApproval } from './management-operations.js';
import { ApprovalError } from './approvals.js';
import { inspectOpenClawSource, MigrationError } from './migration.js';
import type { McpConnectionPatch, ApprovalAction, ApprovalList, MemoryExtractionError, MemoryExtractionJob, MemoryExtractionView } from './ui-contract.js';
import { t as tr } from './locale.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, parseConfig, type Config } from './config.js';
import { claudeGatewaySecrets, claudeGatewayTarget, getAgentRegistry, resolveAgent, validClaudeGatewaySecret } from './agent-registry.js';
import { agentLabel } from './agents.js';
import { ConfigEditor, digest, readJson } from './paths.js';
import { Store, SCHEMA_VERSION } from './store.js';
import { Tasks } from './tasks.js';
import { Recovery, RecoveryError, type Resolution } from './recovery.js';
import { serviceAction, serviceStatus, activeData, waitForService } from './service.js';
import { doctor } from './doctor.js';
import { acquireLock, makeRedactor, chatWorkspace } from './safety.js';
import { Schedules } from './schedules.js';
import { executionPolicy } from './access.js';
import { agentCodexConfig, selectAgent, selectedPolicyHash } from './agent-registry.js';
import { scopeOf } from './tasks.js';
import { AssistantSettings, AssistantSettingsError } from './assistant.js';
import { Memories, MemoryError, MEMORY_LIMITS, type MemoryAuthority, type MemoryScope } from './memory.js';
import { MEMORY_EXTRACTION_MAX_ATTEMPTS } from './auto-memory.js';
import { MigrationMemory, MigrationMemoryError, migrationMemoryStatus } from './migration-memory.js';
import { Profiles, ProfileError } from './profiles.js';
import { AgentModelError, readAgentModel, saveAgentModel } from './agent-models.js';
import { listCodexModels } from './codex-connection.js';
import { CodexUpdates } from './codex-updates.js';
import { ClaudeUpdates } from './claude-updates.js';
import type { ProfileState, UserProfile } from './ui-contract.js';
import { Browse, BrowseError } from './browse.js';
import { isOAuthReference, resolveMcpCredential, discoverMcpOAuthScopes } from './mcp-oauth.js';
import { parseMcpConnections, publicMcpConnections, remoteRead, stdioRead } from './mcp-connections.js';
import { parseGitHubAccessConfig, publicGitHubAccess } from './github-access.js';
import { FeishuTransport } from './feishu.js';
import { discoverLocalGh, type LocalGhConfig } from './github-local.js';
import { DailyTurns, dailyTurnDay } from './daily-turns.js';

export class ManagementError extends Error { constructor(message:string,readonly status=409){super(message);} }
export interface ManagementDeps {
  status: typeof serviceStatus; action: typeof serviceAction; wait: typeof waitForService; diagnose: typeof doctor;
  localGh: typeof discoverLocalGh; codexMcpConfig?:string; mcpReader:typeof remoteRead; claudeUpdates?: ClaudeUpdates;
}
const defaults:ManagementDeps={status:serviceStatus,action:serviceAction,wait:waitForService,diagnose:doctor,localGh:discoverLocalGh,mcpReader:remoteRead};
export class Management {
  readonly dataDir: string;
  private deps:ManagementDeps;
  private codexUpdater?: { revision: string; updates: CodexUpdates };
  private claudeUpdater: ClaudeUpdates;
  private updateOperations=new Set<CodexUpdates>();
  async close(): Promise<void> { await Promise.allSettled([this.claudeUpdater, ...this.updateOperations].map(updater=>updater.close())); }
  constructor(readonly file:string, deps:Partial<ManagementDeps>={}) {
    const raw=readJson(file),path=raw.dataDir??'./data';
    if(typeof path!=='string') throw new ManagementError(tr("management.invalidDataDirectoryConfigurationFixNamoInit"));
    this.dataDir=path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(file),path);
    this.deps={...defaults,...deps};
    this.claudeUpdater=deps.claudeUpdates ?? new ClaudeUpdates();
  }
  private source():{raw:any;revision:string} {
    const text=readFileSync(this.file,'utf8'),raw=JSON.parse(text);
    const path=raw.dataDir??'./data';
    if(typeof path!=='string'||(path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(this.file),path))!==this.dataDir) throw new ManagementError(tr("management.dataDirectoryChangedExternallyCloseRestartWorkbench"));
    return {raw:directoryConfiguration(raw),revision:digest(text)};
  }
  private status():Record<string,any> {
    try{return this.deps.status(loadConfig(this.file));}
    catch{return {running:activeData(this.dataDir),ready:false,connection:'unknown',configInvalid:true};}
  }
  private redactor():(text:string)=>string {
    const {raw}=this.source(),f=raw.feishu??{};let token=typeof raw.github?.token==='string'?raw.github.token:'';
    try {token=parseGitHubAccessConfig(raw.github,process.env)?.token??'';}catch{const key=raw.github?.tokenEnv;if(typeof key==='string'&&/^NAMO_GITHUB_[A-Z][A-Z0-9_]*$/.test(key))token=process.env[key]??token;}
    return makeRedactor([typeof f.appSecret==='string'?f.appSecret:'',process.env[f.appSecretEnv??'FEISHU_APP_SECRET']??'',token,...(Array.isArray(raw.mcpConnections)?raw.mcpConnections.map((v:any)=>typeof v?.token==='string'?v.token:''):[]),...claudeGatewaySecrets(raw.agents)]);
  }
  private read<T>(fn:(s:Store)=>T):T|undefined {
    const path=join(this.dataDir,'bot.sqlite');if(!existsSync(path))return;
    const s=new Store(path,true);try{return fn(s);}finally{s.close();}
  }
  private readCurrent<T>(fn:(s:Store)=>T):T|undefined {
    return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)
        throw new ManagementError(tr('management.databaseSchemaUnsupported'),409);
      return fn(s);
    });
  }
  private sanitize<T>(value:T):T {
    const redact=this.redactor();
    const visit=(item:unknown):unknown=>typeof item==='string'?redact(item):Array.isArray(item)?item.map(visit)
      :item&&typeof item==='object'?Object.fromEntries(Object.entries(item).map(([key,entry])=>[key,visit(entry)])):item;
    return visit(value) as T;
  }
  private write<T>(fn:(s:Store)=>T):T {
    const version=this.read(s=>Number(s.db.prepare('PRAGMA user_version').get()?.user_version));
    if(version!==SCHEMA_VERSION) throw new ManagementError(tr("management.databaseSchemaUnsupported"));
    const s=new Store(join(this.dataDir,'bot.sqlite'));try{return fn(s);}finally{s.close();}
  }
  async organization():Promise<{tenantKey:string;name:string}> { return new FeishuTransport(loadConfig(this.file).feishu,()=>{}).organization(); }
  config():any {
    const {raw,revision}=this.source(),c=raw.codex??{},f=raw.feishu??{};
    let parsed: Config | undefined;
    try { parsed = parseConfig(raw, this.file); } catch { /* Keep the repair form available. */ }
    const registry = parsed && getAgentRegistry(parsed);
    const agentConnections = registry && { defaultProfile: registry.defaultProfile,
      profiles: registry.profiles.map(p => {
        let model: string | undefined;
        let modelError: string | undefined;
        try { model = readAgentModel(p); } catch (error) {
          modelError = error instanceof AgentModelError ? error.message : '无法读取 Agent 模型。';
        }
        const saved = p.id === 'codex' ? raw.codex : raw.agents?.profiles?.[p.id];
        return { id: p.id, adapter: p.adapter, label: agentLabel(p), enabled: p.enabled,
          bin: typeof saved?.bin === 'string' ? saved.bin : p.bin, timeoutMs: p.timeoutMs,
          model: model ?? '', ...(modelError ? {modelError} : {}), ...(p.gateway ? {gateway:p.gateway} : {}) };
      }) };
    let github=publicGitHubAccess();try {github=publicGitHubAccess(parseGitHubAccessConfig(raw.github,process.env));}catch{/* Keep an invalid credential out of the projection. */}
    let mcpConnections:ReturnType<typeof publicMcpConnections>;try{mcpConnections=publicMcpConnections(parseMcpConnections(raw.mcpConnections));}catch{mcpConnections=[];}
    const service=this.status();let applied:string|undefined,automaticConfiguration=false,configurationReload:string|undefined;
    let agentModelEditing = !service.running;
    try{const h=readJson(join(this.dataDir,'health.json'));if(service.running&&h.pid===service.pid){applied=h.configRevision;automaticConfiguration=h.automaticConfiguration===true;configurationReload=h.configurationReload;agentModelEditing=h.isolatedAgentModels===true;}}catch{/* Not yet instrumented. */}
    let activeModelDefault:{model:string;profile:string}|undefined;
    if(parsed&&service.running&&applied===revision){
      try {const agent=resolveAgent(parsed);activeModelDefault={model:readAgentModel(agent)??'',profile:agent.id};}catch{/* Unavailable profiles must not be presented as active. */}
    }
    return {revision,valid:!!parsed,github,mcpConnections,agentConnections,agentModelEditing,activeModelDefault,automaticConfiguration,configurationReload,application:!service.running?'stopped':!applied?'unknown':applied===revision?'applied':'pending',
      values:{directories:c.directories??[],sandbox:'workspace-write',networkAccess:c.networkAccess??false,allowLocalCommits:true,
        concurrency:Number.isInteger(raw.concurrency)&&raw.concurrency>=1&&raw.concurrency<4?4:raw.concurrency??8,bin:c.bin??'codex',timeoutMs:c.timeoutMs??600000,readPaths:c.readPaths??[],denyPaths:c.denyPaths??[],cards:f.cards===true,requireMention:f.requireMention!==false,
        reactions:f.reactions!==false,progressUpdates:f.progressUpdates!==false,progressDelayMs:f.progressDelayMs??200,progressIntervalMs:f.progressIntervalMs??5000,progressHeartbeatMs:f.progressHeartbeatMs??30000},
      feishu:{appId:f.appId??'',domain:f.domain??'feishu',secretConfigured:!!f.appSecret||!!process.env[f.appSecretEnv??'FEISHU_APP_SECRET'],pairedUsers:Array.isArray(f.allowedUserIds)?f.allowedUserIds.length:0,
        restrictedChats:Array.isArray(f.allowedChatIds)?f.allowedChatIds.length:0,access:f.access??null,allowedUserIds:f.allowedUserIds??[],allowedChatIds:f.allowedChatIds??[]},file:this.file};
  }
  state():any {
    const day=dailyTurnDay();
    let limit: number | undefined;
    try { limit=loadConfig(this.file).codex.dailyTurnLimit??0; }
    catch { /* Keep the repair form available when execution settings are invalid. */ }
    const db=this.read(s=>{
      const schema=Number(s.db.prepare('PRAGMA user_version').get()?.user_version);
      if(schema!==SCHEMA_VERSION)return {schema,tasks:[],issues:[],workstreams:[]};
      return {schema,tasks:s.db.prepare('SELECT id,workstreamId,cwd,state,inputVersion,startedAt,finishedAt,error FROM tasks ORDER BY rowid DESC LIMIT 50').all(),
        workstreams:s.db.prepare('SELECT id,cwd,createdAt FROM workstreams ORDER BY createdAt DESC LIMIT 30').all(),
        issues:new Recovery(s).list(),queue:s.status(),
        ...(limit===undefined?{}:{usage:{day,turns:new DailyTurns(s).used(day),limit}})};
    });
    return this.sanitize({service:this.status(),config:this.config(),database:db??{schema:0,tasks:[],issues:[],workstreams:[]},recoveryAvailable:db?.schema===SCHEMA_VERSION,profiles:this.profiles(),assistant:db?.schema===SCHEMA_VERSION?this.read(s=>new AssistantSettings(s).read()):undefined});
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
  private memoryIdentity(ownerId?:unknown):{ownerId:string;owners:{id:string;label:string}[];directories:string[];appId:string;channel:'feishu'|'lark';secret:string} {
    let config;try{config=loadConfig(this.file);}catch{throw new ManagementError(tr("common.configurationValidationFailedCheckDirectoriesPermissions"),409);}
    const f=config.feishu,ids=f.access?this.profiles().entries.map(p=>p.userId):[...new Set(f.allowedUserIds)];
    if(!ids.length)throw new ManagementError(tr("management.completeAppSetupUserPairingFirst"),409);
    if(ownerId!==undefined&&(typeof ownerId!=='string'||!ids.includes(ownerId)))throw new ManagementError(tr("management.pairedUsersCurrentAppMayMemoryManaged"),403);
    const selected=typeof ownerId==='string'?ownerId:ids[0]!;
    const names=this.readCurrent(s=>{
      const account=s.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
      if(account&&account!==f.appId)throw new ManagementError(tr("common.appDataDirectoryNotMatchProfilesCannot"),409);
      if(!s.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_profiles'").get())return new Map<string,string>();
      return new Map(s.db.prepare('SELECT userId,name FROM user_profiles WHERE channel=? AND appId=?').all(f.domain,f.appId)
        .map(row=>[String(row.userId),String(row.name)]));
    })??new Map<string,string>();
    const redact=this.redactor();
    return {ownerId:selected,owners:ids.map(id=>({id,label:redact(names.get(id)??'')||id})),directories:config.codex.directories??[],
      appId:f.appId,channel:f.domain,secret:f.appSecret};
  }
  private memoryChats(s:Store,ownerId:string,directories:string[]):{chatKey:string;directory:string|null}[] {
    const allowed=new Set(directories),seen=new Set<string>(),result:{chatKey:string;directory:string|null}[]=[];
    const add=(chatKey:unknown,directory:unknown)=>{if(typeof chatKey!=='string'||!chatKey)return;const p=typeof directory==='string'&&allowed.has(directory)?directory:null,key=JSON.stringify([chatKey,p]);if(!seen.has(key)){seen.add(key);result.push({chatKey,directory:p});}};
    for(const row of s.db.prepare('SELECT DISTINCT i.chatKey,t.cwd AS directory FROM inbox i LEFT JOIN tasks t ON t.id=i.taskId WHERE i.senderId=?').all(ownerId))add(row.chatKey,row.directory);
    for(const row of s.db.prepare('SELECT DISTINCT chatKey,cwd AS directory FROM workstreams WHERE ownerId=?').all(ownerId))add(row.chatKey,row.directory);
    return result.sort((a,b)=>a.chatKey.localeCompare(b.chatKey)||(a.directory??'').localeCompare(b.directory??''));
  }
  memories(ownerId?:unknown):unknown {
    try{
      const identity=this.memoryIdentity(ownerId),result=this.read(s=>{
        if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw new ManagementError(tr("management.databaseSchemaUnsupported"),409);
        return this.memoryState(s,identity);
      });
      if(!result)throw new ManagementError(tr("management.noServiceDatabaseCompleteSetupFirst"),409);
      return result;
    }catch(e){if(e instanceof MemoryError)throw this.memoryError(e);if(e instanceof MigrationMemoryError)throw new ManagementError(e.message,migrationMemoryStatus(e));throw e;}
  }
  memory(action:unknown,ownerId:unknown,input:unknown):unknown {
    const identity=this.memoryIdentity(ownerId);
    try{return this.write(s=>{
      const account=s.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
      if(account&&account!==identity.appId)throw new ManagementError(tr("common.appDataDirectoryNotMatchProfilesCannot"),409);
      const redactor=this.redactor(),memory=new Memories(s,redactor),chats=this.memoryChats(s,identity.ownerId,identity.directories);
      if(!input||typeof input!=='object'||Array.isArray(input))throw new ManagementError(tr("common.invalidRequestBody"),400);
      const value=input as Record<string,unknown>,authority:MemoryAuthority={kind:'local-owner',authenticated:true,ownerId:identity.ownerId,
        source:{kind:'local-owner',ref:`workbench:${randomUUID()}`}};
      if(action==='save'){
        const scope=this.validMemoryScope(value.scope,identity.ownerId,identity.directories,chats),text=value.text;
        if(typeof text==='string'&&redactor(text)!==text)throw new ManagementError(tr("management.memoryCannotContainCredentialsRemoveThemRetry"),400);
        memory.save({kind:value.kind as any,scope,text:text as string},authority);
      }else if(action==='import'){
        const scope=this.validMemoryScope(value.scope,identity.ownerId,identity.directories,chats);
        new MigrationMemory(s,{dataDir:this.dataDir,configFile:this.file,appId:identity.appId},redactor).importPending({
          migrationId:value.migrationId as string,candidateId:value.candidateId as string,fingerprint:value.fingerprint as string,scope,
        },{kind:'local-owner',authenticated:true,ownerId:identity.ownerId});
      }else{
        if(typeof value.id!=='string'||!Number.isSafeInteger(value.version))throw new ManagementError(tr("management.invalidMemoryIdVersion"),400);
        if(action==='correct'){
          if(typeof value.text==='string'&&redactor(value.text)!==value.text)throw new ManagementError(tr("management.memoryCannotContainCredentialsRemoveThemRetry"),400);
          memory.correct(value.id,Number(value.version),{text:value.text as string},authority);
        }else if(action==='disable')memory.disable(value.id,Number(value.version),authority);
        else if(action==='delete')memory.delete(value.id,Number(value.version),authority);
        else if(action==='activate')memory.activatePending(value.id,Number(value.version),authority);
        else throw new ManagementError(tr("common.actionNotFound"),400);
      }
      return this.memoryState(s,identity);
    });}catch(e){if(e instanceof MemoryError)throw this.memoryError(e);if(e instanceof MigrationMemoryError)throw new ManagementError(e.message,migrationMemoryStatus(e));throw e;}
  }
  private memoryState(s:Store,identity:ReturnType<Management['memoryIdentity']>):unknown {
    const memory=new Memories(s,this.redactor());
    const redact=this.redactor();
    return {available:true,ownerId:identity.ownerId,owners:identity.owners,directories:identity.directories,chats:this.memoryChats(s,identity.ownerId,identity.directories),
      extraction:this.memoryExtraction(s,identity.ownerId),
      imports:new MigrationMemory(s,{dataDir:this.dataDir,configFile:this.file,appId:identity.appId},redact).list(),
      items:memory.manage({kind:'local-owner',authenticated:true,ownerId:identity.ownerId}),limits:{entryChars:MEMORY_LIMITS.entryChars,
        ownerEntries:MEMORY_LIMITS.ownerEntries,ownerChars:MEMORY_LIMITS.ownerChars,scopeEntries:MEMORY_LIMITS.scopeEntries,scopeChars:MEMORY_LIMITS.scopeChars}};
  }
  private memoryExtraction(s:Store,ownerId:string):MemoryExtractionView {
    const counts={pending:0,running:0,failed:0};
    for(const row of s.db.prepare("SELECT state,COUNT(*) AS n FROM memory_jobs WHERE ownerId=? AND state IN ('pending','running','failed') GROUP BY state").all(ownerId)) {
      counts[row.state as keyof typeof counts]=Number(row.n);
    }
    const errors=new Set<MemoryExtractionError>(['extraction_failed','timeout','connection_failed','invalid_output','tool_rejected','capacity']);
    const rows=s.db.prepare(`SELECT id,directory,state,createdAt,attempts,dueAt,leaseUntil,accepted,rejected,error
      FROM memory_jobs WHERE ownerId=? ORDER BY createdAt DESC,id DESC LIMIT 21`).all(ownerId);
    const redact=this.redactor();
    const recent=rows.slice(0,20).map(row=>({
      id:String(row.id),directory:row.directory===null?null:redact(String(row.directory)),state:row.state as MemoryExtractionJob['state'],
      createdAt:Number(row.createdAt),attempts:Number(row.attempts),dueAt:Number(row.dueAt),leaseUntil:Number(row.leaseUntil),
      accepted:row.accepted===null?null:Number(row.accepted),rejected:row.rejected===null?null:Number(row.rejected),
      error:row.error===null?null:errors.has(row.error as MemoryExtractionError)?row.error as MemoryExtractionError:'extraction_failed' as const,
    }));
    return {...counts,maxAttempts:MEMORY_EXTRACTION_MAX_ATTEMPTS,recent,hasMore:rows.length>20};
  }
  private validMemoryScope(raw:unknown,ownerId:string,directories:string[],chats:{chatKey:string;directory:string|null}[]):MemoryScope {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ManagementError(tr("management.invalidMemoryScope"),400);
    const scope=raw as Record<string,unknown>;
    if(scope.ownerId!==ownerId)throw new ManagementError(tr("management.selectedUsersMemoryMayManaged"),403);
    if(scope.kind==='owner'&&scope.directory===null&&scope.chatKey===null)return scope as unknown as MemoryScope;
    if(scope.kind==='directory'&&typeof scope.directory==='string'&&directories.includes(scope.directory)&&scope.chatKey===null)return scope as unknown as MemoryScope;
    if(scope.kind==='chat'&&typeof scope.chatKey==='string'&&(scope.directory===null||typeof scope.directory==='string')
      &&chats.some(chat=>chat.chatKey===scope.chatKey&&(scope.directory===null||chat.directory===scope.directory)))return scope as unknown as MemoryScope;
    throw new ManagementError(tr("management.memoryScopeNotAvailableSelectedPairedUser"),403);
  }
  private memoryError(error:MemoryError):ManagementError {
    const status=error.code==='invalid'?400:error.code==='forbidden'?403:error.code==='missing'?404:error.code==='capacity'?413:error.code==='storage_invalid'?503:409;
    return new ManagementError(error.message,status);
  }
  private projections(s: Store): Browse {
    const {raw}=this.source(),f=raw.feishu??{};
    return new Browse(s,{appId:f.appId??'',channel:f.domain??'feishu'},this.redactor());
  }
  scheduleAction(input:unknown):{ok:true} {
    if(!input || typeof input!=='object' || Array.isArray(input))throw new ManagementError(tr('schedules.invalidAction'),400);
    const v=input as Record<string,unknown>;
    if(Object.keys(v).some(k=>!['id','action','state','nextAt'].includes(k)) || typeof v.id!=='string' || !/^S-[A-F0-9]{12}$/.test(v.id)
      || !['pause','resume','delete'].includes(String(v.action)) || !['active','paused','completed'].includes(String(v.state)) || !Number.isSafeInteger(v.nextAt))throw new ManagementError(tr('schedules.invalidAction'),400);
    const action=v.action as 'pause'|'resume'|'delete',config=loadConfig(this.file);
    if(action==='resume' && this.status().running && this.config().application!=='applied')throw new ManagementError(tr('schedules.configurationPending'));
    try {this.write(s=>new Schedules(s).changeFromWorkbench(v.id as string,v.state as string,v.nextAt as number,action,source=>{
      const policy=executionPolicy(config.codex,config.feishu,source),tasks=new Tasks(s),bound=tasks.binding(source),saved=bound?tasks.selection(bound.id):undefined;
      const selection=saved&&saved.profileId!=='codex'?saved:selectAgent(config,bound?'codex':undefined);
      const workspace=chatWorkspace(config.dataDir,source.envelope?`${scopeOf(source)}:user:${source.senderId}`:source.chatKey);
      return {cwd:realpathSync(workspace),directories:config.codex.directories??[],policyHash:selectedPolicyHash({...config,codex:policy},selection),...(selection.profileId!=='codex'?{agentSelection:selection}:{})};
    }));} catch(error) {if(error instanceof ManagementError)throw error;throw new ManagementError(error instanceof Error && [tr('schedules.conflict'),tr('schedules.invalidAction'),tr('schedules.resumeUnavailable')].includes(error.message)?error.message:tr('schedules.resumeUnavailable'));}
    return {ok:true};
  }
  browse(kind:'tasks'|'schedules'|'sessions'|'dashboard'|'options',params=new URLSearchParams()):unknown {
    const result=this.read(s=>{
      const schema=Number(s.db.prepare('PRAGMA user_version').get()?.user_version);
      if(schema!==SCHEMA_VERSION)throw new BrowseError(tr("management.databaseSchemaUnsupported"));
      // A deferred read transaction keeps totals and rows consistent without
      // migrating the database or taking a writer reservation from the receiver.
      s.db.exec('BEGIN');
      try{
        const view=this.projections(s);
        const value=kind==='tasks'?view.tasks(params):kind==='schedules'?view.schedules(params):kind==='sessions'?view.sessions(params):kind==='dashboard'?view.dashboard():view.options();
        s.db.exec('COMMIT');return value;
      }catch(e){s.db.exec('ROLLBACK');throw e;}
    });
    if(result===undefined)throw new BrowseError(tr("management.noTaskDatabaseCompleteNamoSetupFirst"));
    return result;
  }
  profiles(): ProfileState {
    const {raw,revision}=this.source(),f=raw.feishu??{};
    const unavailable=(reason:string):ProfileState=>({available:false,reason,configRevision:revision,entries:[]});
    if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu')||!Array.isArray(f.allowedUserIds)||f.allowedUserIds.some((id:unknown)=>typeof id!=='string'||!id))return unavailable(tr("management.completeAppSetupUserPairingFirst"));
    try{return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)return unavailable(tr("management.databaseSchemaUnsupported"));
      return this.sanitize({available:true,configRevision:revision,entries:[...new Set<string>([...f.allowedUserIds,...(f.access?s.db.prepare("SELECT DISTINCT senderId FROM inbox WHERE chatKey LIKE ? AND json_extract(envelope,'$.tenantKey')=? LIMIT 1000").all(`${f.appId}:%`,f.access.tenantKey).map(r=>String(r.senderId)):[])])].map(userId=>{const identity={channel:f.domain??'feishu',appId:f.appId,userId};return new Profiles(s,identity).get();})});
    })??unavailable(tr("management.noServiceDatabaseCompleteSetupFirst"));}
    catch(e){if(e instanceof ProfileError)return unavailable(e.message);throw e;}
  }
  saveExecutionModel(revision: string, profile: unknown, expected: unknown, model: unknown): string {
    if (typeof profile !== 'string' || typeof expected !== 'string') throw new ManagementError('请选择 Agent 并刷新模型设置。', 400);
    try {
      const current = this.source();
      if (current.revision !== revision) throw new ManagementError(tr('management.configurationChangedAnotherPageProgramRefreshTry'));
      const config = parseConfig(current.raw, this.file);
      const agent = resolveAgent(config, selectAgent(config, profile));
      return saveAgentModel(config, agent, model, expected, () => {
        if (this.source().revision !== revision) throw new ManagementError(tr('management.configurationChangedAnotherPageProgramRefreshTry'));
        if (!this.config().agentModelEditing) throw new ManagementError(tr('model.receiverRequiresUpgrade'));
      });
    } catch (error) {
      if (error instanceof AgentModelError) throw new ManagementError(error.message, 409);
      if (error instanceof AgentRegistryError) throw new ManagementError('所选 Agent 不可用。', 400);
      throw error;
    }
  }
  saveProfile(configRevision:string,userId:string,version:number,patch:unknown):UserProfile {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try{
      const {raw,revision}=this.source(),f=raw.feishu??{};
      if(configRevision!==revision)throw new ManagementError(tr("management.appConfigurationChangedRefreshSelectUserAgain"));
      if(typeof userId!=='string'||!Array.isArray(f.allowedUserIds)||!(f.access?this.profiles().entries.some(p=>p.userId===userId):f.allowedUserIds.includes(userId)))throw new ManagementError(tr("management.profilesUsersPairedAppCanManaged"));
      if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu'))throw new ManagementError(tr("management.invalidAppIdentity"));
      const redact=this.redactor();
      if(JSON.stringify(patch)!==redact(JSON.stringify(patch)??''))throw new ManagementError(tr("management.profilesCannotContainCredentialsRemoveThemTry"));
      return this.write(s=>new Profiles(s,{channel:f.domain??'feishu',appId:f.appId,userId}).update(version,patch,{source:'local-owner'}));
    }catch(e){if(e instanceof ProfileError)throw new ManagementError(e.message);throw e;}finally{release();}
  }
  async models(profile = 'codex'): Promise<{id:string;name:string;isDefault:boolean}[]> {
    try {
      const config = loadConfig(this.file);
      return await listCodexModels(agentCodexConfig(config, selectAgent(config, profile)));
    } catch { throw new ManagementError('模型列表暂不可用，请检查 Codex 登录和 Agent 配置。',503); }
  }
  async codexUpdate(input?: {action:string;configRevision:string;enabled?:boolean}) {
    const {revision}=this.source();
    if(input && input.configRevision!==revision)throw new ManagementError('update_config_changed');
    if(!this.codexUpdater || this.codexUpdater.revision!==revision) {
      this.codexUpdater={revision,updates:new CodexUpdates(loadConfig(this.file),{},revision)};
      this.updateOperations.add(this.codexUpdater.updates);
    }
    try { return input ? await this.codexUpdater.updates.action(input.action,input.enabled) : await this.codexUpdater.updates.status(); }
    catch(error) { throw new ManagementError(error instanceof Error && /^update_[a-z_]+$/.test(error.message)?error.message:'update_failed'); }
  }
  async claudeUpdate(input?: {profileId: unknown; configRevision: unknown; enabled?: boolean}, action: 'check' | 'upgrade' | 'automatic' = 'upgrade') {
    const { revision } = this.source();
    if (input && input.configRevision !== revision) throw new ManagementError('update_config_changed');
    if (input && input.profileId !== null && typeof input.profileId !== 'string') throw new ManagementError('update_action_invalid', 400);
    const config = loadConfig(this.file);
    try {
      return input
        ? await this.claudeUpdater.action(action, config, input.profileId as string | null, revision, input.enabled)
        : await this.claudeUpdater.status(config);
    } catch (error) {
      throw new ManagementError(error instanceof Error && /^update_[a-z_]+$/.test(error.message) ? error.message : 'update_failed');
    }
  }
  async mcpOAuthScopes(revision:unknown,url:unknown) {
    if(typeof revision!=='string'||this.source().revision!==revision)throw new ManagementError('mcp_config_changed');
    if(typeof url!=='string'||url.length>2048)throw new ManagementError('mcp_invalid_config',400);
    try{const result=await discoverMcpOAuthScopes(url);if(this.source().revision!==revision)throw new ManagementError('mcp_config_changed');return result;}
    catch(error){if(error instanceof ManagementError)throw error;throw new ManagementError('mcp_oauth_discovery_failed',400);}
  }
  async testMcp(revision:unknown,id:unknown):Promise<{toolCount:number}> {
    if(typeof revision!=='string'||typeof id!=='string'||this.source().revision!==revision)throw new ManagementError('mcp_config_changed');
    const connection=loadConfig(this.file).mcpConnections?.find(c=>c.id===id);
    if(!connection)throw new ManagementError('mcp_connection_not_found',400);
    try {
      const signal=AbortSignal.timeout(30000),credential=connection.type==='stdio'?{token:''}:await resolveMcpCredential(this.dataDir,connection.token,connection.url,signal,undefined,connection.oauthScope);
      // Admin diagnostics may list tools before the connection is enabled for tasks.
      const result=await (connection.type==='stdio'?stdioRead:this.deps.mcpReader)({...connection,token:credential.token},{operation:'list'},signal);
      if(this.source().revision!==revision)throw new ManagementError('mcp_config_changed');
      return {toolCount:Array.isArray(result)?result.length:0};
    } catch(error) {if(error instanceof ManagementError)throw error;throw new ManagementError('mcp_connection_failed',400);}
  }
  codexMcpCatalog() {try{return listCodexMcp(this.deps.codexMcpConfig,parseMcpConnections(this.source().raw.mcpConnections));}catch{throw new ManagementError('codex_mcp_config_invalid',400);}}
  importCodexMcp(revision:unknown,sourceRevision:unknown,ids:unknown) {
    if(typeof revision!=='string'||this.source().revision!==revision)throw new ManagementError('mcp_config_changed');
    if(typeof sourceRevision!=='string'||!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>typeof id!=='string'))throw new ManagementError('codex_mcp_selection_invalid',400);
    const current=parseMcpConnections(this.source().raw.mcpConnections),used=new Set(current.map(c=>c.id));
    try {
      const additions=ids.map(id=>{const selected=selectCodexMcp(id,sourceRevision,this.deps.codexMcpConfig),normalized=selected.id.toLowerCase();if(used.has(normalized))throw new ManagementError('codex_mcp_duplicate',400);used.add(normalized);return {id:normalized,type:'remote' as const,url:selected.url};});
      return this.save(revision,{mcpConnections:[...current.map(({token:_token,...value})=>value),...additions]});
    } catch(error){if(error instanceof ManagementError)throw error;if(error instanceof CodexMcpImportError)throw new ManagementError(error.code,400);throw error;}
  }
  prepareMcpOAuth(revision:string,id:string,draft?:unknown):McpConnectionPatch {
    const {raw,revision:current}=this.source();if(current!==revision)throw new ManagementError('mcp_config_changed');
    const connections=parseMcpConnections(raw.mcpConnections),prior=connections.find(c=>c.id===id);
    if(draft===undefined){if(!prior)throw new ManagementError('mcp_config_changed');const {token:_token,...value}=prior;return value;}
    if(!draft||typeof draft!=='object'||Array.isArray(draft)||Object.keys(draft).some(k=>!['id','type','url','oauthScope','ownerUserId'].includes(k)))throw new ManagementError('mcp_invalid_config',400);
    const value=draft as McpConnectionPatch;
    if(id&&(!prior||id!==value.id)||!id&&connections.some(c=>c.id===value.id))throw new ManagementError('mcp_config_changed');
    let parsed;try{parsed=parseMcpConnections([{...value,token:''}])[0];const existing=connections.filter(c=>c.id!==id).map(c=>{if(c.type!=='stdio')return c;const {url:_url,...local}=c;return local;});parseConfig({...raw,mcpConnections:[...existing,parsed]},this.file);}catch{throw new ManagementError('mcp_invalid_config',400);}
    if(addsDuplicateMcpEndpoint(connections,[...connections.filter(c=>c.id!==id),parsed!]))throw new ManagementError('mcp_duplicate_endpoint',400);
    const {token:_token,...safe}=parsed!;return {...safe,...(Object.hasOwn(value,'ownerUserId')&&!value.ownerUserId?{ownerUserId:''}:{})};
  }
  saveMcpOAuth(revision:string,id:string,reference:string,draft?:McpConnectionPatch):void {
    if(!isOAuthReference(reference))throw new ManagementError('mcp_oauth_invalid',400);
    const {raw,revision:current}=this.source();if(current!==revision)throw new ManagementError('mcp_config_changed');
    const connections=parseMcpConnections(raw.mcpConnections);
    const selected=this.prepareMcpOAuth(revision,id,draft);
    const values=connections.filter(c=>c.id!==id).map(({token:_token,...value})=>value);
    this.save(revision,{mcpConnections:[...values,{...selected,newToken:reference}]},undefined,true);
  }
  async saveGitHub(revision:string,patch:any):Promise<any> {
    if (patch?.github?.source!=='gh') return this.save(revision,patch);
    const {raw,revision:current}=this.source();
    if (revision!==current) throw new ManagementError(tr("management.configurationChangedAnotherPageProgramRefreshTry"));
    const owners=patch.github.allowedUserIds;
    if (patch.github.mode!=='shared' && (patch.github.mode==='simple' ? !raw.feishu?.allowedUserIds?.includes(patch.github.ownerUserId)
      : patch.github.grants===undefined && (!Array.isArray(owners)||owners.length!==1||!raw.feishu?.allowedUserIds?.includes(owners[0]))))
      throw new ManagementError(tr("management.localGithubLoginMustLinkedExactlyOne"),400);
    let local:LocalGhConfig;
    try {local=await this.deps.localGh();}
    catch {throw new ManagementError(tr("management.localGithubLoginUnavailableRunGhAuth"),400);}
    return this.save(revision,patch,local);
  }
  save(revision:string,patch:any,localGh?:LocalGhConfig,internalOAuth=false):any {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try {
      const {raw,revision:current}=this.source();if(current!==revision)throw new ManagementError(tr("management.configurationChangedAnotherPageProgramRefreshTry"));
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new ManagementError(tr("management.invalidConfigurationContent"));
      const allowed=['directories','serviceAccess','sandbox','networkAccess','allowLocalCommits','concurrency','bin','timeoutMs','readPaths','denyPaths','cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs','newSecret','github','newGithubToken','clearGithubToken','mcpConnections'];
      if(Object.keys(patch).some(k=>!allowed.includes(k)&&!['defaultAgentProfile','claudeCode','agentExecution'].includes(k)))throw new ManagementError(tr("management.configurationIncludesFieldsCannotEdited"));
      const next=structuredClone(raw);next.codex??={};next.feishu??={};
      if (Object.hasOwn(patch, 'defaultAgentProfile') || Object.hasOwn(patch, 'claudeCode')) {
        next.agents ??= {};
        if (Object.hasOwn(patch, 'defaultAgentProfile')) {
          if (typeof patch.defaultAgentProfile !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(patch.defaultAgentProfile))
            throw new ManagementError(tr('claude.configInvalid'), 400);
          next.agents.defaultProfile = patch.defaultAgentProfile;
        }
        if (Object.hasOwn(patch, 'claudeCode')) {
          const value = patch.claudeCode;
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(key => !['enabled', 'gateway'].includes(key))
            || typeof value.enabled !== 'boolean')
            throw new ManagementError(tr('claude.configInvalid'), 400);
          next.agents.profiles ??= {};
          const prior = next.agents.profiles.claude;
          if (prior && prior.adapter !== 'claude') throw new ManagementError(tr('claude.profileConflict'), 400);
          let gateway = prior?.gateway;
          if (value.gateway === null) gateway = undefined;
          else if (value.gateway !== undefined) {
            const draft = value.gateway;
            if (!draft || typeof draft !== 'object' || Array.isArray(draft)
              || Object.keys(draft).some(key => !['baseUrl', 'auth', 'newSecret'].includes(key))
              || (draft.newSecret !== undefined && draft.newSecret !== '' && !validClaudeGatewaySecret(draft.newSecret)))
              throw new ManagementError(tr('claude.gatewayInvalid'), 400);
            let target;
            try { target = claudeGatewayTarget(typeof draft.baseUrl === 'string' ? draft.baseUrl.trim() : draft.baseUrl, draft.auth); }
            catch { throw new ManagementError(tr('claude.gatewayInvalid'), 400); }
            let retainedSecret: string | undefined;
            if (!draft.newSecret && gateway) {
              try {
                const previous = claudeGatewayTarget(gateway.baseUrl, gateway.auth);
                if (target.baseUrl === previous.baseUrl && target.auth === previous.auth) retainedSecret = gateway.secret;
              } catch { /* Repairing an invalid gateway requires a new credential. */ }
            }
            const secret = draft.newSecret || retainedSecret;
            if (!secret) throw new ManagementError(tr('claude.gatewayCredentialRequired'), 400);
            gateway = { ...target, secret };
          }
          next.agents.profiles.claude = { ...prior, adapter: 'claude', enabled: value.enabled, bin: prior?.bin ?? 'claude',
            gateway: undefined,
            ...(gateway ? { gateway } : {}) };
          if (!value.enabled && next.agents.defaultProfile === 'claude') next.agents.defaultProfile = 'codex';
        }
      }
      for(const key of allowed.filter(k=>!['serviceAccess','concurrency','cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs','newSecret','github','newGithubToken','clearGithubToken','mcpConnections'].includes(k))) if(Object.hasOwn(patch,key))next.codex[key]=patch[key];
      if (Object.hasOwn(patch, 'agentExecution')) {
        const value = patch.agentExecution;
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => !['profile', 'bin', 'timeoutMs'].includes(key))
          || typeof value.profile !== 'string' || typeof value.bin !== 'string' || !value.bin.trim()
          || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 7200000)
          throw new ManagementError(tr('claude.configInvalid'), 400);
        const agent = value.profile === 'codex' ? next.codex
          : Object.hasOwn(next.agents?.profiles ?? {}, value.profile) ? next.agents.profiles[value.profile] : undefined;
        if (!agent) throw new ManagementError('所选 Agent 不可用。', 400);
        agent.bin = value.bin.trim();
        agent.timeoutMs = value.timeoutMs;
      }
      if(patch.serviceAccess!==undefined) {
        const a=patch.serviceAccess;
        if (!a || typeof a!=='object' || Array.isArray(a) || Object.keys(a).some(k=>!['access','allowedUserIds','allowedChatIds'].includes(k))) throw new ManagementError(tr("management.invalidOrganizationAccessSettings"),400);
        next.feishu.access=a.access;next.feishu.allowedUserIds=a.allowedUserIds;next.feishu.allowedChatIds=a.allowedChatIds;
      }
      if(Object.hasOwn(patch,'concurrency')){
        if(!Number.isInteger(patch.concurrency)||patch.concurrency<4||patch.concurrency>64)throw new ManagementError(tr('config.concurrencyMustBetween'),400);
        next.concurrency=patch.concurrency;
      }
      for(const k of ['cards','requireMention','reactions','progressUpdates','progressDelayMs','progressIntervalMs','progressHeartbeatMs'])if(Object.hasOwn(patch,k))next.feishu[k]=patch[k];
      if(patch.newSecret!==undefined) {
        if(typeof patch.newSecret!=='string'||patch.newSecret.length>256)throw new ManagementError(tr("management.invalidSecretFormat"));
        if(patch.newSecret)next.feishu.appSecret=patch.newSecret;
      }
      if(patch.github!==undefined){
        if(!patch.github||typeof patch.github!=='object'||Array.isArray(patch.github)||Object.keys(patch.github).some(k=>!['mode','ownerUserId','source','repositories','allowedUserIds','grants'].includes(k)))throw new ManagementError(tr("management.invalidGithubConfiguration"),400);
        const retainedGrants=patch.github.grants===undefined && patch.github.mode==='simple' && raw.github?.mode==='simple' ? raw.github.grants : patch.github.grants;
        next.github={...next.github,...patch.github};
        if(retainedGrants===undefined)delete next.github.grants;else next.github.grants=retainedGrants;
        if(patch.github.mode==='shared'){delete next.github.ownerUserId;delete next.github.grants;next.github.repositories=[];next.github.allowedUserIds=[];}
        if(patch.github.mode===undefined){delete next.github.mode;delete next.github.ownerUserId;}
        if (patch.github.source==='gh') {
          if (!localGh || patch.newGithubToken || patch.clearGithubToken || patch.github.repositories?.length) throw new ManagementError(tr("management.invalidGithubConfiguration"),400);
          next.github={source:'gh',localGh,repositories:[],allowedUserIds:patch.github.allowedUserIds,...(patch.github.mode==='shared'?{mode:'shared'}:patch.github.mode==='simple'?{mode:'simple',ownerUserId:patch.github.ownerUserId}:{}),...(retainedGrants===undefined?{}:{grants:retainedGrants})};
        } else if (patch.github.source==='anonymous') {
          if (patch.newGithubToken) throw new ManagementError(tr("management.invalidGithubConfiguration"),400);
          next.github={source:'anonymous',repositories:[],allowedUserIds:[],...(patch.github.grants===undefined?{}:{grants:patch.github.grants})};
        } else if (patch.github.source==='token') {
          delete next.github.localGh;delete next.github.source;
        }
      }
      if(patch.mcpConnections!==undefined){
        if(!Array.isArray(patch.mcpConnections)||patch.mcpConnections.length>20)throw new ManagementError('mcp_invalid_config',400);
        const previous=parseMcpConnections(raw.mcpConnections);
        next.mcpConnections=patch.mcpConnections.map((entry:any)=>{
          if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(k=>!['id','type','url','command','args','oauthScope','ownerUserId','newToken','clearToken'].includes(k))
            ||entry.newToken!==undefined&&typeof entry.newToken!=='string'||entry.clearToken!==undefined&&typeof entry.clearToken!=='boolean'
            ||entry.clearToken&&entry.newToken||!internalOAuth&&typeof entry.newToken==='string'&&isOAuthReference(entry.newToken))throw new ManagementError('mcp_invalid_config',400);
          const prior=previous.find(v=>v.id===entry.id);
          if(prior?.token&&(prior.type!==entry.type||prior.type==='remote'&&prior.url!==entry.url)&&!entry.clearToken&&!entry.newToken)throw new ManagementError('mcp_credential_target_changed',400);
          if(prior?.token&&isOAuthReference(prior.token)&&(prior.oauthScope??'')!==(entry.oauthScope??'')&&!entry.clearToken&&!entry.newToken)throw new ManagementError('mcp_credential_target_changed',400);
          const owner=entry.ownerUserId===undefined?prior?.ownerUserId:entry.ownerUserId;
          return {id:entry.id,type:entry.type,...(owner?{ownerUserId:owner}:{}),...(entry.type==='remote'?{url:entry.url,...(entry.oauthScope?{oauthScope:entry.oauthScope}:{})}:entry.type==='stdio'?{command:entry.command,args:entry.args}:{}),
            token:entry.clearToken?'':entry.newToken||prior?.token||''};
        });
      }
      if(patch.clearGithubToken!==undefined&&typeof patch.clearGithubToken!=='boolean')throw new ManagementError(tr("management.invalidGithubConfiguration"),400);
      if(patch.newGithubToken!==undefined&&(typeof patch.newGithubToken!=='string'||patch.newGithubToken.length>4096))throw new ManagementError(tr("management.invalidGithubCredentialFormat"),400);
      if(patch.clearGithubToken&&patch.newGithubToken)throw new ManagementError(tr("management.cannotClearReplaceGithubCredentialTogether"),400);
      if(next.github?.source==='gh'&&(patch.newGithubToken||patch.clearGithubToken))throw new ManagementError(tr("management.invalidGithubConfiguration"),400);
      if(patch.newGithubToken||patch.clearGithubToken){next.github??={};delete next.github.tokenEnv;delete next.github.token;
        if(patch.newGithubToken)next.github.token=patch.newGithubToken;}
      try{parseConfig(next,this.file);}catch{throw new ManagementError(tr("management.configurationValidationFailedCheckDirectorySettings"));}
      if(patch.mcpConnections!==undefined&&addsDuplicateMcpEndpoint(parseMcpConnections(raw.mcpConnections),parseMcpConnections(next.mcpConnections)))throw new ManagementError('mcp_duplicate_endpoint',400);
      const editor=new ConfigEditor(this.file);if(digest(readFileSync(this.file,'utf8'))!==revision)throw new ManagementError(tr("management.configurationChangedRefreshContinue"));
      editor.save(next);return this.config();
    } finally {release();}
  }
  async apply(revision:string,confirmed:boolean):Promise<any> {
    if(!confirmed)throw new ManagementError(tr("management.applyingConfigurationRequiresExplicitConfirmationRestartReceiver"));
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));const maintenance=randomUUID();let paused=false;
    try {
      if(this.source().revision!==revision)throw new ManagementError(tr("management.configurationChangedReviewAgainApplying"));
      const c=loadConfig(this.file),service=this.deps.status(c);
      if(!service.installed||service.mode==='foreground')throw new ManagementError(tr("management.manageForegroundInstanceTerminalInstallBackgroundService"));
      if(service.running) {
        let h:any;try{h=readJson(join(this.dataDir,'health.json'));}catch{}
        if(h?.pid!==service.pid||h?.managementVersion!==2)throw new ManagementError(tr("management.runningVersionNotSupportSafeApplyUpgrade"));
      }
      this.write(s=>s.transaction(()=>{
        if(s.db.prepare("SELECT 1 FROM inbox WHERE state IN ('queued','running','waiting','awaiting_reply')").get()||s.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','sending')").get())throw new ManagementError(tr("management.tasksOutgoingMessagesStillPendingWaitCompletion"));
        if(s.db.prepare("SELECT 1 FROM runner_jobs WHERE state IN ('starting','running','lost')").get())throw new ManagementError(tr("management.independentRunnersLostRunnerSlotsRemainFinish"));
        if(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get())throw new ManagementError(tr("management.maintenanceOperationAlreadyProgress"));
        s.db.prepare("INSERT INTO settings VALUES('maintenance',?)").run(maintenance);paused=true;
      }));
      if(this.source().revision!==revision)throw new ManagementError(tr("management.configurationChangedExternallyServiceWasNotRestarted"));
      await this.deps.action(service.registered?'restart':'start',c);
      const ready=await this.deps.wait(c,30000);
      return {ready,config:this.config(),message:ready?tr("management.serviceReconnectedCheckSavedConfigurationActive"):tr("management.serviceStartAttemptedButConnectionNotReady")};
    } finally {
      try{if(paused)this.write(s=>{s.db.prepare("DELETE FROM settings WHERE key='maintenance' AND value=?").run(maintenance);});}finally{release();}
    }
  }
  detail(id:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id))throw new ManagementError(tr("management.invalidTaskId"));
    return this.readCurrent(s=>{const tasks=new Tasks(s),t=tasks.get(id);if(!t)throw new ManagementError(tr("tasks.notFound"));
      const summary=this.projections(s).taskSummary(id);
      return this.sanitize({...tasks.detail(t) as object,title:summary?.title,ownerId:summary?.ownerId,ownerName:summary?.ownerName,createdAt:summary?.createdAt,model:tasks.reportedModel(t.id),
        results:s.db.prepare("SELECT content,state,part FROM outbox WHERE inboxKey=? AND kind='result' ORDER BY part").all(t.inboxKey)});});
  }
  issue(id:string):any {
    return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw new ManagementError(tr("management.databaseSchemaUnsupported"));
      const {snapshot:_s,inboxKey:_k,...safe}=new Recovery(s).inspect(id);return this.sanitize(safe);
    });
  }
  reconcile(request:Resolution):any {
    loadConfig(this.file);request={...request,note:this.redactor()(request.note??'')};
    try{return this.write(s=>new Recovery(s).resolve(request,{id:'local-owner'},true));}catch(e){if(e instanceof RecoveryError)throw new ManagementError(e.message);throw e;}
  }
  cancel(id:string,inputVersion:number,requestId:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id)||!requestId||requestId.length>100)throw new ManagementError(tr("management.invalidCancellationRequest"));
    return this.write(s=>s.transaction(()=>{
      const old=s.db.prepare('SELECT subject,action,actor FROM reconciliations WHERE requestId=?').get(requestId);
      if(old){if(old.subject===id&&old.action==='cancel'&&old.actor==='local-owner')return {duplicate:true};throw new ManagementError(tr("management.operationIdAlreadyUsed"));}
      const tasks=new Tasks(s),t=tasks.get(id);
      if(!t||!['queued','running','waiting'].includes(t.state)||t.inputVersion!==inputVersion)throw new ManagementError(tr("management.taskChangedRefreshActing"));
      if(t.state==='running') {
        const job=s.db.prepare(`SELECT j.state FROM runner_jobs j JOIN task_runs r ON r.id=j.runId WHERE r.taskId=? AND r.state='running' ORDER BY r.startedAt DESC LIMIT 1`).get(t.id);
        if(!job&&!this.status().running)throw new ManagementError(tr("management.runnerStateNeedsReviewServiceNotRunning"));
      }
      if(!tasks.cancel(t))throw new ManagementError(tr("management.taskChangedItsRunnerFinishedLostContact"));
      s.db.prepare('INSERT INTO reconciliations(requestId,subject,actor,action,note,beforeState,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(requestId,id,'local-owner','cancel',tr("management.localUserRequestedStop"),JSON.stringify({state:t.state,inputVersion}),Date.now());
      return {duplicate:false};
    }));
  }
  logs() { return serviceLogs(this.dataDir, this.redactor()); }
  inspectMigration(input: { sourceFile?: unknown; sourceInstanceId?: unknown }) {
    if (typeof input.sourceFile !== 'string' || !isAbsolute(input.sourceFile) || input.sourceFile.length > 4096
      || typeof input.sourceInstanceId !== 'string' || !input.sourceInstanceId.trim() || input.sourceInstanceId.length > 100) throw new ManagementError(tr('operations.migrationInputInvalid'), 400);
    try { return this.sanitize(inspectOpenClawSource({ sourceFile: input.sourceFile, sourceInstanceId: input.sourceInstanceId })); }
    catch (error) { if (error instanceof MigrationError) throw new ManagementError(this.redactor()(error.message), 400); throw error; }
  }
  approvals(): ApprovalList {
    const { revision } = this.source(), config = loadConfig(this.file);
    return this.sanitize({ configured: !!config.gitApprovals?.gitBin && !!config.gitApprovals.remotes.length,
      configRevision: revision, remotes: config.gitApprovals?.remotes.map(remote => remote.name) ?? [], items: this.readCurrent(listApprovals) ?? [] });
  }
  async approval(input: ApprovalAction) {
    if (!input || !['request','push','approve','reject','execute','reconcile'].includes(input.action)) throw new ManagementError(tr('common.actionNotFound'), 400);
    const { revision } = this.source(), config = loadConfig(this.file);
    if (input.confirmed !== true) throw new ManagementError(tr('operations.confirmRequired'), 400);
    if (this.source().revision !== revision) throw new ManagementError(tr('management.configurationChangedReviewAgainApplying'));
    if (!/^[a-f0-9]{64}$/.test(input.configRevision??'') || ((input.action === 'request' || input.action === 'push')
      ? typeof input.taskId !== 'string' || !/^N-[A-F0-9]{12}$/.test(input.taskId) || typeof input.remote !== 'string' || typeof input.ref !== 'string' || input.directory!==undefined&&(typeof input.directory!=='string'||input.directory.length>4096)
      : typeof input.id !== 'string' || !/^AP-[A-F0-9]{12}$/.test(input.id) || !Number.isSafeInteger(input.revision))) throw new ManagementError(tr('operations.approvalInputInvalid'), 400);
    const schema = this.read(s => Number(s.db.prepare('PRAGMA user_version').get()?.user_version));
    if (schema !== SCHEMA_VERSION) throw new ManagementError(tr('management.databaseSchemaUnsupported'));
    const store = new Store(join(this.dataDir, 'bot.sqlite'));
    try { return this.sanitize(await changeApproval(store, config, revision, () => this.source().revision, input)); }
    catch (error) { if (error instanceof ApprovalError) throw new ManagementError(this.redactor()(error.message)); throw error; }
    finally { store.close(); }
  }
  async diagnose(live = false, confirmed = false, profile?: unknown) {
    if (live && !confirmed) throw new ManagementError(tr('operations.confirmRequired'), 400);
    if (profile !== undefined && (typeof profile !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(profile)))
      throw new ManagementError(tr('claude.configInvalid'), 400);
    return this.sanitize(await this.deps.diagnose(this.file, live, profile));
  }
}
