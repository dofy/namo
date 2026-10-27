import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Store, Incoming } from './store.js';
import type { Task } from './tasks.js';
import type { Sender } from './engine.js';
import { prepareArtifact, ArtifactError, type PreparedArtifact } from './artifacts.js';
import { chatWorkspace } from './safety.js';
import { pathsOverlap } from './engine.js';

interface Delivery {id:string; inboxKey:string; taskId:string; ownerId:string; chatId:string; projectRoot:string; path:string; state:string; uuid:string; createdAt:number; sha256?:string; size?:number; fileKey?:string; platformId?:string; error?:string;}
export class ArtifactDelivery {
  private busy=false;
  constructor(private store:Store,private sender:Sender,private denyPaths:string[]=[],private isolation?:{dataDir:string;explicitDenyPaths:string[]},private canAccess:(taskId:string)=>boolean=()=>true){ }
  private denied(taskId:string,root:string,path:string):boolean{
    if(!this.canAccess(taskId))return true;
    const target=resolve(root,path),task=this.store.db.prepare(`SELECT t.project,t.chatKey,t.scopeKey,t.ownerId,t.cwd,i.envelope
      FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE t.id=?`).get(taskId);
    // Engine.project binds current messages to scope+owner. Only legacy inbox
    // rows without an envelope used the old chat-wide workspace key.
    const workspaceKey=task?(task.envelope===null||task.envelope===undefined?String(task.chatKey):`${task.scopeKey}:user:${task.ownerId}`):'';
    const safeDefault=!!this.isolation&&task&&!task.project&&task.cwd===root&&root===chatWorkspace(this.isolation.dataDir,workspaceKey);
    return this.denyPaths.some(denied=>pathsOverlap(denied,target)&&!(safeDefault&&denied===this.isolation!.dataDir&&!this.isolation!.explicitDenyPaths.some(explicit=>pathsOverlap(explicit,target))));
  }
  enqueue(input:Incoming,task:Task,path:string):string{
    if(input.senderId!==task.ownerId||input.chatKey!==task.chatKey||input.envelope?.kind==='material'||input.envelope?.type==='card_action')throw new ArtifactError('artifact_not_authorized');
    if(!['succeeded','failed','cancelled','needs_attention','interrupted'].includes(task.state))throw new ArtifactError('artifact_task_not_finished');
    const binding={taskId:task.id,ownerId:input.senderId,chatId:input.chatId,projectRoot:task.cwd,projectRelativePath:path};
    if(this.denied(task.id,task.cwd,path))throw new ArtifactError('artifact_path_denied');
    const prepared=prepareArtifact(binding,{...binding,source:'task_instruction'});
    const id=`artifact:${input.key}`,row:Delivery={id,inboxKey:input.key,taskId:task.id,ownerId:input.senderId,chatId:input.chatId,projectRoot:task.cwd,path:prepared.relativePath,state:'pending',uuid:randomUUID(),createdAt:Date.now(),sha256:prepared.sha256,size:prepared.size};
    this.store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(id,JSON.stringify(row));return id;
  }
  intent(input:Incoming,task:Task,path:string):void{
    if(input.envelope?.kind==='material'||input.envelope?.parentId||path.length>240||path.startsWith('/')||path.split('/').some(part=>!part||part==='..'||part==='.')||path.includes('\\'))throw new ArtifactError('artifact_invalid_delivery_intent');
    this.store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(`artifact-intent:${task.id}`,JSON.stringify({inboxKey:input.key,taskId:task.id,path,state:'pending'}));
  }
  private completeIntents():void{
    const intents=this.store.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'artifact-intent:%' AND json_extract(value,'$.state')='pending'").all();
    for(const entry of intents){const intent=JSON.parse(String(entry.value)),task=this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(intent.taskId) as unknown as Task|undefined;
      if(!task||['queued','running','waiting'].includes(task.state))continue;
      this.store.transaction(()=>{try{if(task.state!=='succeeded')throw new ArtifactError('artifact_task_not_succeeded');this.enqueue(this.store.get(intent.inboxKey)!,task,intent.path);}
        catch(error){this.store.addOutput(intent.inboxKey,'artifact-intent-result',`指定文件未交付：${error instanceof ArtifactError?error.code:'artifact_failed'}。可核对任务后用 /deliver 明确发起交付。`);}
        this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({...intent,state:'processed'}),entry.key);
      });
    }
  }
  recover():void{for(const row of this.rows())if(['uploading','sending'].includes(row.state)){row.state='unknown';row.error='receiver_stopped_during_delivery';this.save(row);}}
  private rows():Delivery[]{return this.store.db.prepare("SELECT value FROM settings WHERE key LIKE 'artifact:%'").all().map(row=>JSON.parse(String(row.value)));}
  private save(row:Delivery):void{this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(row),row.id);}
  async settle():Promise<void>{while(this.busy)await new Promise(r=>setTimeout(r,20));}
  async tick():Promise<void>{
    if(this.busy||!this.sender.uploadArtifact||!this.sender.sendArtifact)return;this.busy=true;
    try{
      this.completeIntents();
      const row=this.rows().find(row=>row.state==='pending'||row.state==='uploaded');if(!row)return;
      const input=this.store.get(row.inboxKey);if(!input)throw new ArtifactError('artifact_input_missing');
      try{
        if(row.state==='pending'){
          const binding={taskId:row.taskId,ownerId:row.ownerId,chatId:row.chatId,projectRoot:row.projectRoot,projectRelativePath:row.path};
          if(this.denied(row.taskId,row.projectRoot,row.path))throw new ArtifactError('artifact_path_denied');
          const artifact:PreparedArtifact=prepareArtifact(binding,{...binding,source:'task_instruction'});
          if(artifact.sha256!==row.sha256||artifact.size!==row.size)throw new ArtifactError('artifact_changed_since_authorization');
          row.state='uploading';this.save(row);row.fileKey=await this.sender.uploadArtifact(artifact);row.state='uploaded';this.save(row);
        }
        if(!this.canAccess(row.taskId))throw new ArtifactError('artifact_access_changed');
        row.state='sending';this.save(row);
        row.platformId=await this.sender.sendArtifact(row.chatId,row.fileKey!,row.uuid,{messageId:input.messageId,thread:!!input.envelope?.threadId});
        this.store.transaction(()=>{row.state='sent';this.save(row);});
        this.store.addOutput(row.inboxKey,'artifact-receipt',`文件已被飞书接受：${row.path}。请确认实际收到的内容；这不是已读回执。`);
      }catch(error){
        // Any exception after entering an external phase is uncertain unless the adapter proves rejection.
        const e=error as {code?:string;unknown?:boolean};row.state=['uploading','sending','sent'].includes(row.state)&&e.unknown!==false?'unknown':'failed';row.error=e.code??'artifact_failed';this.save(row);
        this.store.addOutput(row.inboxKey,'artifact-receipt',`文件交付${row.state==='unknown'?'结果未确认，未自动重发':'失败'}：${row.path}（${row.error}）。`);
      }
    }finally{this.busy=false;}
  }
}
