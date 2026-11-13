import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.js';
import { loadConfig, parseConfig } from './config.js';
import { ConfigEditor, digest } from './paths.js';
import { acquireLock } from './safety.js';
import { Store, type Incoming } from './store.js';
import type { Task } from './tasks.js';

interface Request {id:string;taskId:string;sourceKey:string;ownerId:string;chatKey:string;chatId:string;path:string;device:number;inode:number;remaining:string;revision:string;state:'pending'|'approved'|'rejected'|'saved'|'applied'|'failed';createdAt:number;expiresAt:number;reason?:string;}
const key=(id:string)=>`directory-approval:${id}`;
function read(store:Store,id:string):Request|undefined {const row=store.db.prepare('SELECT value FROM settings WHERE key=?').get(key(id));if(!row)return;try{return JSON.parse(String(row.value)) as Request;}catch{return;}}
function save(store:Store,r:Request):void {store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(r.id),JSON.stringify(r));}
function owner(c:Config,m:Incoming):boolean {return m.envelope?.chatType==='p2p'&&m.envelope.kind==='instruction'&&c.feishu.allowedUserIds.includes(m.senderId);}

/** Create an exact, validated request. No configuration is changed before approval. */
export function requestDirectory(store:Store,c:Config,m:Incoming,task:Task,path:string,remaining:string):string {
 if(!owner(c,m)||m.key.startsWith('schedule:'))throw Error('目录权限只能由已配对的所有者在私聊中请求。');
 if(!isAbsolute(path)||path.length>4096||/[\u0000-\u001f\u007f]/u.test(path))throw Error('请提供完整的本地目录路径。');
 if(!remaining.trim()||remaining.length>4000)throw Error('请说明授权后尚未完成的工作。');
 const resolved=realpathSync(path),info=statSync(resolved);if(!info.isDirectory())throw Error('目标不是目录。');
 const raw=JSON.parse(readFileSync(c.file,'utf8'));raw.codex??={};raw.codex.directories=[...new Set([...(c.codex.directories??[]),resolved])];
 parseConfig(raw,c.file);
 if((c.codex.directories??[]).includes(resolved))return '该目录已在当前白名单中，无需再次授权。';
 const id=`DIR-${randomBytes(6).toString('hex').toUpperCase()}`,now=Date.now();
 const request:Request={id,taskId:task.id,sourceKey:m.key,ownerId:m.senderId,chatKey:m.chatKey,chatId:m.chatId,path:resolved,device:info.dev,inode:info.ino,remaining:remaining.trim(),revision:digest(readFileSync(c.file,'utf8')),state:'pending',createdAt:now,expiresAt:now+24*60*60_000};
 save(store,request);store.addOutput(m.key,`directory-approval:${id}`,`**申请访问目录**\n目录：${resolved}\n该目录将对已获准使用 Namo 的成员开放读写。\n用途：${remaining.trim()}\n回复“确认目录 ${id}”或“拒绝目录 ${id}”；确认后会在安全切换时自动应用，已有任务不会被重跑。`);
 return `已发出目录权限确认请求 ${id}；尚未修改白名单。等待用户确认后再继续。`;
}
export function getDirectoryRequest(store:Store,id:string):Request|undefined {return read(store,id);}
export function decideDirectory(store:Store,c:Config,id:string,m:Incoming,approve:boolean):string {
 const r=read(store,id);if(!r||!owner(c,m)||r.ownerId!==m.senderId||r.chatKey!==m.chatKey||r.chatId!==m.chatId)return '未找到属于你的目录权限请求。';
 if(r.state!=='pending'||Date.now()>=r.expiresAt)return '该目录权限请求已处理或已过期。';
 r.state=approve?'approved':'rejected';save(store,r);
 return approve?'已确认目录权限，正在等待安全应用。':'已拒绝目录权限，白名单不会改变。';
}
/** Apply each approved request exactly once; config watcher handles safe reload. */
export function applyDirectoryRequests(store:Store,c:Config,dispatch:(source:Incoming,request:{id:string;taskId:string;path:string;remaining:string})=>void):void {
 const rows=store.db.prepare("SELECT key,value FROM settings WHERE key>=? AND key<? LIMIT 100").all('directory-approval:','directory-approval;');
 for(const row of rows){let r:Request;try{r=JSON.parse(String(row.value));}catch{continue;}
  if(!['approved','saved'].includes(r.state))continue;
  const source=store.get(r.sourceKey),task=store.db.prepare('SELECT state FROM tasks WHERE id=?').get(r.taskId);
  if(!source||!task||!owner(c,source)){r.state='failed';r.reason='身份或原任务不可用';save(store,r);continue;}
  if(r.state==='approved') {
   if(['queued','running','waiting'].includes(String(task.state)))continue;
   let unlock:(()=>void)|undefined;
   try {
    unlock=acquireLock(join(c.dataDir,'config-edit.lock'));
    const current=loadConfig(c.file),rawText=readFileSync(c.file,'utf8');
    if(!owner(current,source))throw Error('授权身份已变化');
    const info=statSync(r.path);if(realpathSync(r.path)!==r.path||!info.isDirectory()||info.dev!==r.device||info.ino!==r.inode)throw Error('目录已变化，请重新申请');
    if(!(current.codex.directories??[]).includes(r.path)){
      if(digest(rawText)!==r.revision)throw Error('配置已变化，请重新申请目录权限');
      const editor=new ConfigEditor(c.file),next=structuredClone(editor.value);next.codex??={};next.codex.directories=[...new Set([...(current.codex.directories??[]),r.path])];
      parseConfig(next,c.file);editor.save(next);
    }
    r.state='saved';save(store,r);
   } catch(e) {r.state='failed';r.reason=e instanceof Error&&['配置已变化，请重新申请目录权限','目录已变化，请重新申请','授权身份已变化'].includes(e.message)?e.message:'无法保存目录权限';save(store,r);store.addOutput(r.sourceKey,`directory-result:${r.id}`,`目录权限未应用：${r.reason}。`);}
   finally{unlock?.();}
  }
  if(r.state==='saved'&&(c.codex.directories??[]).includes(r.path)) {
    store.transaction(()=>{
      const latest=read(store,r.id);if(!latest||latest.state!=='saved')return;
      latest.state='applied';save(store,latest);
      store.addOutput(latest.sourceKey,`directory-result:${latest.id}`,`目录权限已应用：${latest.path}。`);
      if(task.state==='succeeded')dispatch(source,latest);
    });
  }
 }
}
