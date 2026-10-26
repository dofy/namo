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
import { Profiles, ProfileError } from './profiles.js';
import type { ProfileState, UserProfile } from './ui-contract.js';

export class ManagementError extends Error {}
export interface ManagementDeps {
  status: typeof serviceStatus; action: typeof serviceAction; wait: typeof waitForService; diagnose: typeof doctor;
}
const defaults:ManagementDeps={status:serviceStatus,action:serviceAction,wait:waitForService,diagnose:doctor};
export class Management {
  readonly dataDir: string;
  private deps:ManagementDeps;
  constructor(readonly file:string, deps:Partial<ManagementDeps>={}) {
    const raw=readJson(file),path=raw.dataDir??'./data';
    if(typeof path!=='string') throw new ManagementError('数据目录配置无效，请先用 namo init 修正');
    this.dataDir=path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(file),path);
    this.deps={...defaults,...deps};
  }
  private source():{raw:any;revision:string} {
    const text=readFileSync(this.file,'utf8'),raw=JSON.parse(text);
    const path=raw.dataDir??'./data';
    if(typeof path!=='string'||(path.startsWith('~/')?resolve(homedir(),path.slice(2)):resolve(dirname(this.file),path))!==this.dataDir) throw new ManagementError('数据目录已被外部修改，请关闭并重新启动管理界面');
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
    if(version!==SCHEMA_VERSION) throw new ManagementError('当前数据库尚未升级。请在维护窗口升级接收服务；界面没有迁移或修改数据');
    const s=new Store(join(this.dataDir,'bot.sqlite'));try{return fn(s);}finally{s.close();}
  }
  config():any {
    const {raw,revision}=this.source(),c=raw.codex??{},f=raw.feishu??{};
    let valid=true;try{parseConfig(raw,this.file);}catch{valid=false;}
    const service=this.status();let applied:string|undefined;
    try{const h=readJson(join(this.dataDir,'health.json'));if(service.running&&h.pid===service.pid)applied=h.configRevision;}catch{/* Not yet instrumented. */}
    return {revision,valid,application:!service.running?'stopped':!applied?'unknown':applied===revision?'applied':'pending',
      values:{projects:c.projects??{},defaultProject:c.defaultProject??'',sandbox:c.sandbox??'read-only',networkAccess:c.networkAccess??false,allowLocalCommits:c.allowLocalCommits??false,
        concurrency:raw.concurrency??2,model:c.model??'',bin:c.bin??'codex',timeoutMs:c.timeoutMs??600000,readPaths:c.readPaths??[],denyPaths:c.denyPaths??[],cards:f.cards===true,requireMention:f.requireMention!==false},
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
    return {service:this.status(),config:this.config(),database:db??{schema:0,tasks:[],issues:[],workstreams:[]},recoveryAvailable:db?.schema===SCHEMA_VERSION,profiles:this.profiles()};
  }
  profiles(): ProfileState {
    const {raw,revision}=this.source(),f=raw.feishu??{};
    const unavailable=(reason:string):ProfileState=>({available:false,reason,configRevision:revision,entries:[]});
    if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu')||!Array.isArray(f.allowedUserIds)||f.allowedUserIds.some((id:unknown)=>typeof id!=='string'||!id))return unavailable('请先完成应用配置和用户配对');
    try{return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)return unavailable('在线数据尚未升级，档案暂不可编辑；请在维护窗口升级接收服务');
      return {available:true,configRevision:revision,entries:[...new Set<string>(f.allowedUserIds)].map(userId=>new Profiles(s,{channel:f.domain??'feishu',appId:f.appId,userId}).get())};
    })??unavailable('尚无服务数据库，请先完成初始化');}
    catch(e){if(e instanceof ProfileError)return unavailable(e.message);throw e;}
  }
  saveProfile(configRevision:string,userId:string,version:number,patch:unknown):UserProfile {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try{
      const {raw,revision}=this.source(),f=raw.feishu??{};
      if(configRevision!==revision)throw new ManagementError('应用配置已变化，请刷新并重新选择用户');
      if(typeof userId!=='string'||!Array.isArray(f.allowedUserIds)||!f.allowedUserIds.includes(userId))throw new ManagementError('只能管理当前应用中已配对用户的档案');
      if(typeof f.appId!=='string'||!f.appId||!['feishu','lark'].includes(f.domain??'feishu'))throw new ManagementError('应用身份无效');
      const redact=makeRedactor([typeof f.appSecret==='string'?f.appSecret:'',process.env[f.appSecretEnv??'FEISHU_APP_SECRET']??''].filter(Boolean));
      if(JSON.stringify(patch)!==redact(JSON.stringify(patch)??''))throw new ManagementError('档案不能包含凭据，请移除后重试');
      return this.write(s=>new Profiles(s,{channel:f.domain??'feishu',appId:f.appId,userId}).update(version,patch,{source:'local-owner'}));
    }catch(e){if(e instanceof ProfileError)throw new ManagementError(e.message);throw e;}finally{release();}
  }
  save(revision:string,patch:any):any {
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));
    try {
      const {raw,revision:current}=this.source();if(current!==revision)throw new ManagementError('配置已被其他页面或程序修改，请刷新后重试');
      if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new ManagementError('配置内容无效');
      const allowed=['projects','defaultProject','sandbox','networkAccess','allowLocalCommits','concurrency','model','bin','timeoutMs','readPaths','denyPaths','cards','requireMention','newSecret'];
      if(Object.keys(patch).some(k=>!allowed.includes(k)))throw new ManagementError('包含不允许编辑的配置项');
      const next=structuredClone(raw);next.codex??={};next.feishu??={};
      for(const key of allowed.filter(k=>!['concurrency','cards','requireMention','newSecret'].includes(k))) if(Object.hasOwn(patch,key))next.codex[key]=patch[key];
      if(next.codex.defaultProject==='')delete next.codex.defaultProject;
      if(Object.hasOwn(patch,'concurrency'))next.concurrency=patch.concurrency;
      for(const k of ['cards','requireMention'])if(Object.hasOwn(patch,k))next.feishu[k]=patch[k];
      if(patch.newSecret!==undefined) {
        if(typeof patch.newSecret!=='string'||patch.newSecret.length>256)throw new ManagementError('Secret 格式无效');
        if(patch.newSecret)next.feishu.appSecret=patch.newSecret;
      }
      try{parseConfig(next,this.file);}catch{throw new ManagementError('配置未通过校验：请核对项目目录、默认项目、权限、并发和超时；原配置没有覆盖');}
      const editor=new ConfigEditor(this.file);if(digest(readFileSync(this.file,'utf8'))!==revision)throw new ManagementError('配置已变化，请刷新');
      editor.save(next);return this.config();
    } finally {release();}
  }
  async apply(revision:string,confirmed:boolean):Promise<any> {
    if(!confirmed)throw new ManagementError('应用配置需要明确确认重启接收服务');
    const release=acquireLock(join(this.dataDir,'config-edit.lock'));const maintenance=randomUUID();let paused=false;
    try {
      if(this.source().revision!==revision)throw new ManagementError('配置已变化，请重新检查后应用');
      const c=loadConfig(this.file),service=this.deps.status(c);
      if(!service.installed||service.mode==='foreground')throw new ManagementError('请在终端管理前台实例或先安装后台服务；界面不会接管其他进程');
      if(service.running) {
        let h:any;try{h=readJson(join(this.dataDir,'health.json'));}catch{}
        if(h?.pid!==service.pid||h?.managementVersion!==2)throw new ManagementError('在线版本尚不支持安全应用。请在维护窗口手动升级；没有停止现有服务');
      }
      this.write(s=>s.transaction(()=>{
        if(s.db.prepare("SELECT 1 FROM inbox WHERE state IN ('queued','running','awaiting_reply')").get()||s.db.prepare("SELECT 1 FROM outbox WHERE state IN ('pending','sending')").get())throw new ManagementError('仍有在途任务或待发送消息，请完成后再应用；没有中断任务');
        if(s.db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get())throw new ManagementError('已有维护操作进行中');
        s.db.prepare("INSERT INTO settings VALUES('maintenance',?)").run(maintenance);paused=true;
      }));
      if(this.source().revision!==revision)throw new ManagementError('配置已被外部修改，未重启服务');
      await this.deps.action(service.registered?'restart':'start',c);
      const ready=await this.deps.wait(c,30000);
      return {ready,config:this.config(),message:ready?'服务已重新连接；请核对配置生效状态':'服务已尝试启动，连接尚未就绪；请运行 namo doctor'};
    } finally {
      try{if(paused)this.write(s=>{s.db.prepare("DELETE FROM settings WHERE key='maintenance' AND value=?").run(maintenance);});}finally{release();}
    }
  }
  detail(id:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id))throw new ManagementError('任务编号无效');
    return this.read(s=>{const tasks=new Tasks(s),t=tasks.get(id);if(!t)throw new ManagementError('未找到任务');
      return {...tasks.detail(t) as object,results:s.db.prepare("SELECT content,state,part FROM outbox WHERE inboxKey=? AND kind='result' ORDER BY part").all(t.inboxKey)};});
  }
  issue(id:string):any {
    return this.read(s=>{
      if(Number(s.db.prepare('PRAGMA user_version').get()?.user_version)!==SCHEMA_VERSION)throw new ManagementError('请先升级接收服务以启用异常核对');
      const {snapshot:_s,inboxKey:_k,...safe}=new Recovery(s).inspect(id);return safe;
    });
  }
  reconcile(request:Resolution):any {
    const c=loadConfig(this.file);request={...request,note:makeRedactor([c.feishu.appSecret])(request.note??'')};
    try{return this.write(s=>new Recovery(s).resolve(request,{id:'local-owner'},true));}catch(e){if(e instanceof RecoveryError)throw new ManagementError(e.message);throw e;}
  }
  cancel(id:string,inputVersion:number,requestId:string):any {
    if(!/^N-[A-F0-9]{12}$/.test(id)||!requestId||requestId.length>100)throw new ManagementError('取消请求无效');
    return this.write(s=>s.transaction(()=>{
      const old=s.db.prepare('SELECT subject,action,actor FROM reconciliations WHERE requestId=?').get(requestId);
      if(old){if(old.subject===id&&old.action==='cancel'&&old.actor==='local-owner')return {duplicate:true};throw new ManagementError('操作编号已使用');}
      const tasks=new Tasks(s),t=tasks.get(id);
      if(!t||!['queued','running'].includes(t.state)||t.inputVersion!==inputVersion)throw new ManagementError('任务已变化，请刷新后操作');
      if(t.state==='running'&&!this.status().running)throw new ManagementError('执行器状态需核对；服务未运行，不能确认已停止');
      s.db.prepare('INSERT INTO reconciliations(requestId,subject,actor,action,note,beforeState,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(requestId,id,'local-owner','cancel','本机用户请求停止',JSON.stringify({state:t.state,inputVersion}),Date.now());
      tasks.cancel(t);return {duplicate:false};
    }));
  }
  async diagnose():Promise<any> {return this.deps.diagnose(this.file,false);}
}
