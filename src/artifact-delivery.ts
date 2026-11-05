import { deliveries } from './business-storage.js';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Store, Incoming } from './store.js';
import type { Task } from './tasks.js';
import type { Sender } from './engine.js';
import { prepareArtifact, ArtifactError, type PreparedArtifact } from './artifacts.js';
import { chatWorkspace } from './safety.js';
import { pathsOverlap } from './path-policy.js';
import type { GeneratedImage } from './runtime-contract.js';

export interface Delivery {id:string; inboxKey:string; taskId:string; ownerId:string; chatId:string; rootDirectory:string; path:string; state:string; uuid:string; createdAt:number; sha256?:string; size?:number; fileKey?:string; platformId?:string; error?:string;}

export function asksForDescribedImage(text:string):boolean {
  const clean=text.trim().replace(/[\s，。！？!?、]/gu,'');
  return clean.length<=100 && !/(?:生成新|重新生成|重画|编辑|修改|改成|分析|识别|描述|比较|以及|并且|同时|顺便|然后)/u.test(clean)
    && /(?:之前|上次|刚才|刚刚|先前|以前|那张|这张|原图|N-[A-Fa-f0-9]{12})/u.test(clean)
    && /^(?:请|麻烦|帮我|能不能|能否|可以|再|重新)*(?:(?:把|将).{0,40}(?:图片|图像|照片|原图|图)(?:发给我|发我|发过来|传给我|给我|展示给我|发出来)(?:一下|一遍|吧|吗)?|(?:给我|发我|发送|发|再发|展示).{0,40}(?:图片|图像|照片|原图|图)(?:给我|一下|一遍|吧|吗)?)$/u.test(clean);
}
/** Only a direct, simple request can authorize replay of an earlier image. */
export function asksForPreviousImage(text:string,hasReference=false):boolean {
  const value=text.trim();
  if(value.length>100 || /(?:生成新|重新生成|重画|编辑|修改|改成|分析|识别|描述|比较|以及|并且|同时|顺便|然后)/u.test(value))return false;
  const clean=value.replace(/[\s，。！？!?、]/gu,'');
  const image='(?:图片|图像|照片|原图|图)';
  const before='(?:请|麻烦|帮我|能否|可以|再|重新)*';
  const subject='(?:刚才生成的|刚刚生成的|刚才|刚刚|之前|上次|最近|最新|刚生成的|之前生成的|上次生成的|原来|原来的|这|这张|那|那张|这幅|那幅|那个|这个|的|一张|一幅|一份|那一张|这张的|一下|N-[A-Fa-f0-9]{12})*';
  const tail='(?:给我|发我|给我看|发过来|出来|一下|一遍|一次|吧|吗|呀|嘛|的|我)*';
  const cn=new RegExp(`^${before}(?:(?:把|将)?${subject}${image}(?:发|发送|传|展示|给)${tail}|(?:给我|我要|我想要|发我|发|发送|再发|传|展示)${subject}${image}${tail})$`,'u');
  return cn.test(clean) || hasReference && /^(?:请|麻烦|帮我|再|重新)*(?:(?:把|将)?(?:它|这张|那张)(?:发|发送|传|给)(?:给我|我|过来|一下|一遍|吧)*|(?:发|发送|传|给我|再发)(?:它|这张|那张)(?:给我|我|过来|一下|一遍|吧)*)$/u.test(clean)
    || /^(?:please\s+)?(?:send|resend|show)\s+(?:me\s+)?(?:the\s+)?(?:previous|last|earlier|generated|same|that|this|original|image|picture|photo|again|\s){1,80}[.!?]?$/iu.test(value);
}
export class ArtifactDelivery {
  private busy=false;
  constructor(private store:Store,private sender:Sender,private denyPaths:string[]=[],private isolation?:{dataDir:string;explicitDenyPaths:string[]},private canAccess:(taskId:string)=>boolean=()=>true){ }
  private denied(taskId:string,root:string,path:string):boolean{
    if(!this.canAccess(taskId))return true;
    const target=resolve(root,path),task=this.store.db.prepare(`SELECT t.chatKey,t.scopeKey,t.ownerId,t.cwd,i.envelope
      FROM tasks t JOIN inbox i ON i.key=t.inboxKey WHERE t.id=?`).get(taskId);
    // Engine.workspace binds current messages to scope+owner. Only legacy inbox
    // rows without an envelope used the old chat-wide workspace key.
    const workspaceKey=task?(task.envelope===null||task.envelope===undefined?String(task.chatKey):`${task.scopeKey}:user:${task.ownerId}`):'';
    const safeDefault=!!this.isolation&&task&&task.cwd===root&&root===chatWorkspace(this.isolation.dataDir,workspaceKey);
    return this.denyPaths.some(denied=>pathsOverlap(denied,target)&&!(safeDefault&&denied===this.isolation!.dataDir&&!this.isolation!.explicitDenyPaths.some(explicit=>pathsOverlap(explicit,target))));
  }
  enqueue(input:Incoming,task:Task,path:string):string{
    if(input.senderId!==task.ownerId||input.chatKey!==task.chatKey||input.envelope?.kind==='material'||input.envelope?.type==='card_action')throw new ArtifactError('artifact_not_authorized');
    if(!['succeeded','failed','cancelled','needs_attention','interrupted'].includes(task.state))throw new ArtifactError('artifact_task_not_finished');
    const binding={taskId:task.id,ownerId:input.senderId,chatId:input.chatId,rootDirectory:task.cwd,relativePath:path};
    if(this.denied(task.id,task.cwd,path))throw new ArtifactError('artifact_path_denied');
    const prepared=prepareArtifact(binding,{...binding,source:'task_instruction'});
    const id=`artifact:${input.key}`,row:Delivery={id,inboxKey:input.key,taskId:task.id,ownerId:input.senderId,chatId:input.chatId,rootDirectory:task.cwd,path:prepared.relativePath,state:'pending',uuid:randomUUID(),createdAt:Date.now(),sha256:prepared.sha256,size:prepared.size};
    deliveries(this.store.db).save(row,'ignore');return id;
  }
  enqueueGenerated(input:Incoming,task:Task,runId:string,image:GeneratedImage):void {
    if (!['succeeded','waiting'].includes(task.state) || input.senderId !== task.ownerId || input.chatKey !== task.chatKey
      || input.envelope?.kind === 'material' || input.envelope?.type === 'card_action'
      || !/^[a-f0-9]{64}$/.test(image.id) || !/^[a-f0-9]{64}$/.test(image.sha256)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)
      || image.path !== `namo-generated-${runId}-${image.id.slice(0,20)}.png`) throw new ArtifactError('artifact_not_authorized');
    if (this.denied(task.id,task.cwd,image.path)) throw new ArtifactError('artifact_path_denied');
    const binding={taskId:task.id,ownerId:input.senderId,chatId:input.chatId,rootDirectory:task.cwd,relativePath:image.path};
    const prepared=prepareArtifact(binding,{...binding,source:'task_instruction'});
    if(prepared.kind!=='image'||prepared.sha256!==image.sha256||prepared.size!==image.size)throw new ArtifactError('artifact_changed_since_authorization');
    // An explicit delivery intent already owns the same bytes; do not send twice.
    const intent=this.store.db.prepare("SELECT path FROM artifact_intents WHERE taskId=? AND state='pending'").get(task.id);
    if(intent) {
      try {
        const requested={...binding,relativePath:String(intent.path)};
        if(!this.denied(task.id,task.cwd,requested.relativePath)
          && prepareArtifact(requested,{...requested,source:'task_instruction'}).sha256===prepared.sha256)return;
      } catch { /* The explicit intent will report its own error. */ }
    }
    const imageMessage=prepared.size<=10_000_000;
    const id=`artifact:generated-${imageMessage?'image':'file'}:${runId}:${image.id}`,row:Delivery={id,inboxKey:input.key,taskId:task.id,ownerId:input.senderId,chatId:input.chatId,
      rootDirectory:task.cwd,path:prepared.relativePath,state:'pending',uuid:randomUUID(),createdAt:Date.now(),sha256:prepared.sha256,size:prepared.size};
    deliveries(this.store.db).save(row,'ignore');
  }
  previousImages(input:Incoming,workstreamId:string,taskId?:string):Delivery[] {
    const scope=input.envelope?.scopeKey??input.chatKey;
    const args=[workstreamId,input.senderId,input.chatKey,scope];
    const rows=this.store.db.prepare(`SELECT d.*,t.finishedAt,
      (SELECT MAX(x.createdAt) FROM artifact_deliveries x WHERE x.taskId=d.taskId AND x.path=d.path AND x.sha256=d.sha256 AND x.state='sent') lastDeliveryAt
      FROM artifact_deliveries d JOIN tasks t ON t.id=d.taskId
      WHERE t.workstreamId=? AND t.ownerId=? AND t.chatKey=? AND t.scopeKey=? AND d.state='sent'
      AND (d.id LIKE 'artifact:generated-image:%' OR d.id LIKE 'artifact:generated-file:%')
      AND d.id NOT LIKE '%:resend:%' ORDER BY lastDeliveryAt DESC,d.createdAt,d.id LIMIT 100`).all(...args) as unknown as (Delivery&{finishedAt:number;lastDeliveryAt:number})[];
    const history=this.store.db.prepare(`SELECT t.id,t.ownerId,t.cwd,t.finishedAt,i.chatId,i.key,s.value FROM settings s
      JOIN tasks t ON t.id=substr(s.key,length('generated-image-history:')+1,14)
      JOIN inbox i ON i.key=t.inboxKey WHERE s.key LIKE 'generated-image-history:%' AND t.workstreamId=? AND t.ownerId=? AND t.chatKey=? AND t.scopeKey=?
      ORDER BY t.finishedAt DESC LIMIT 100`).all(...args);
    for(const row of history){
      try{const image=JSON.parse(String(row.value));
        if(typeof image.path!=='string'||!/^namo-recovered-[a-f0-9]{64}\.png$/.test(image.path)||!/^([a-f0-9]{64})$/.test(image.sha256)
          ||!Number.isSafeInteger(image.size)||image.size<=0||typeof image.platformId!=='string')continue;
        const latest=this.store.db.prepare("SELECT MAX(createdAt) stamp FROM artifact_deliveries WHERE taskId=? AND path=? AND sha256=? AND state='sent'").get(row.id,image.path,image.sha256);
        rows.push({id:`artifact:legacy-image:${row.id}:${image.sha256}`,inboxKey:String(row.key),taskId:String(row.id),ownerId:String(row.ownerId),chatId:String(row.chatId),
          rootDirectory:String(row.cwd),path:image.path,state:'sent',uuid:'',createdAt:Number(row.finishedAt),finishedAt:Number(row.finishedAt),
          lastDeliveryAt:Math.max(Number(row.finishedAt),Number(image.recordedAt)||0,Number(latest?.stamp)||0),sha256:image.sha256,size:image.size,platformId:image.platformId});
      }catch{/* Invalid legacy metadata is never a delivery source. */}
    }
    rows.sort((a,b)=>b.lastDeliveryAt-a.lastDeliveryAt||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    if(input.envelope?.parentId){
      // The quoted image may itself have been resent; resolve it to its source.
      const quoted=this.store.db.prepare(`SELECT d.taskId,d.path,d.sha256 FROM artifact_deliveries d JOIN tasks t ON t.id=d.taskId
        WHERE d.platformId=? AND d.state='sent' AND t.workstreamId=? AND t.ownerId=? AND t.chatKey=? AND t.scopeKey=?`).get(input.envelope.parentId,...args);
      const image=rows.find(row=>row.platformId===input.envelope?.parentId || quoted && row.taskId===quoted.taskId && row.path===quoted.path && row.sha256===quoted.sha256);
      if(image)return [image];
      if(!taskId)return [];
    }
    const eligible=taskId?rows.filter(row=>row.taskId===taskId):rows;
    return eligible.length?eligible.filter(row=>row.taskId===eligible[0].taskId).slice(0,20):[];
  }
  enqueuePrevious(input:Incoming,task:Task,source:Delivery):void {
    if(input.senderId!==task.ownerId||input.chatKey!==task.chatKey||(input.envelope?.scopeKey??input.chatKey)!==task.scopeKey
      ||source.taskId!==task.id||source.ownerId!==input.senderId||source.chatId!==input.chatId||source.state!=='sent'
      ||source.rootDirectory!==task.cwd||!source.sha256||!source.size)throw new ArtifactError('artifact_not_authorized');
    if(this.denied(task.id,task.cwd,source.path))throw new ArtifactError('artifact_path_denied');
    const binding={taskId:task.id,ownerId:input.senderId,chatId:input.chatId,rootDirectory:task.cwd,relativePath:source.path};
    const artifact=prepareArtifact(binding,{...binding,source:'task_instruction'});
    if(artifact.kind!=='image'||artifact.sha256!==source.sha256||artifact.size!==source.size)throw new ArtifactError('artifact_changed_since_authorization');
    const digest=createHash('sha256').update(input.key).update('\0').update(source.id).digest('hex');
    const id=`artifact:generated-${source.size<=10_000_000?'image':'file'}:resend:${digest}`;
    deliveries(this.store.db).save({id,inboxKey:input.key,taskId:task.id,ownerId:input.senderId,chatId:input.chatId,
      rootDirectory:task.cwd,path:artifact.relativePath,state:'pending',uuid:randomUUID(),createdAt:Date.now(),sha256:artifact.sha256,size:artifact.size},'ignore');
  }
  intent(input:Incoming,task:Task,path:string):void{
    if(input.envelope?.kind==='material'||input.envelope?.parentId||path.length>240||path.startsWith('/')||path.split('/').some(part=>!part||part==='..'||part==='.')||path.includes('\\'))throw new ArtifactError('artifact_invalid_delivery_intent');
    this.store.db.prepare("INSERT INTO artifact_intents(taskId,inboxKey,path,state) VALUES(?,?,?,'pending') ON CONFLICT(taskId) DO NOTHING").run(task.id,input.key,path);
  }
  private completeIntents():void{
    const intents=this.store.db.prepare("SELECT * FROM artifact_intents WHERE state='pending'").all() as unknown as {taskId:string;inboxKey:string;path:string}[];
    for(const intent of intents){const task=this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(intent.taskId) as unknown as Task|undefined;
      if(!task||['queued','running','waiting'].includes(task.state))continue;
      this.store.transaction(()=>{try{if(task.state!=='succeeded')throw new ArtifactError('artifact_task_not_succeeded');this.enqueue(this.store.get(intent.inboxKey)!,task,intent.path);}
        catch(error){this.store.addOutput(intent.inboxKey,'artifact-intent-result',`指定文件未交付：${error instanceof ArtifactError?error.code:'artifact_failed'}。可核对任务后用 /deliver 明确发起交付。`);}
        this.store.db.prepare("UPDATE artifact_intents SET state='processed' WHERE taskId=?").run(intent.taskId);
      });
    }
  }
  recover():void{for(const row of this.rows(true))if(['uploading','sending'].includes(row.state)){row.state='unknown';row.error='receiver_stopped_during_delivery';this.save(row);}}
  private rows(recovery = false):Delivery[]{
    return deliveries(this.store.db).list(recovery ? "state IN ('uploading','sending')" : "state IN ('pending','uploaded')", [], 'ORDER BY createdAt,id');
  }
  private save(row:Delivery):void{deliveries(this.store.db).save(row);}
  async settle():Promise<void>{while(this.busy)await new Promise(r=>setTimeout(r,20));}
  async tick():Promise<void>{
    if(this.busy||!this.sender.uploadArtifact||!this.sender.sendArtifact)return;this.busy=true;
    try{
      this.completeIntents();
      const row=this.rows().find(row=>row.state==='pending'||row.state==='uploaded');if(!row)return;
      const imageMessage=row.id.startsWith('artifact:generated-image:');
      const input=this.store.get(row.inboxKey);if(!input)throw new ArtifactError('artifact_input_missing');
      try{
        if(row.state==='pending'){
          const binding={taskId:row.taskId,ownerId:row.ownerId,chatId:row.chatId,rootDirectory:row.rootDirectory,relativePath:row.path};
          if(this.denied(row.taskId,row.rootDirectory,row.path))throw new ArtifactError('artifact_path_denied');
          const artifact:PreparedArtifact=prepareArtifact(binding,{...binding,source:'task_instruction'});
          if(artifact.sha256!==row.sha256||artifact.size!==row.size)throw new ArtifactError('artifact_changed_since_authorization');
          if(imageMessage&&!this.sender.uploadImage)throw new ArtifactError('image_sender_unavailable');
          row.state='uploading';this.save(row);row.fileKey=await (imageMessage?this.sender.uploadImage!(artifact):this.sender.uploadArtifact(artifact));row.state='uploaded';this.save(row);
        }
        if(!this.canAccess(row.taskId))throw new ArtifactError('artifact_access_changed');
        if(imageMessage&&!this.sender.sendImage)throw new ArtifactError('image_sender_unavailable');
        row.state='sending';this.save(row);
        const route={messageId:input.messageId,thread:!!input.envelope?.threadId};
        row.platformId=await (imageMessage?this.sender.sendImage!(row.chatId,row.fileKey!,row.uuid,route):this.sender.sendArtifact(row.chatId,row.fileKey!,row.uuid,route));
        this.store.transaction(()=>{row.state='sent';this.save(row);});
        const subject=row.id.startsWith('artifact:generated-')?'图片':`文件：${row.path}`;
        this.store.addOutput(row.inboxKey,`artifact-receipt:${row.id}`,`${subject}已被飞书接受，请确认实际收到的内容；这不是已读回执。`);
      }catch(error){
        // Any exception after entering an external phase is uncertain unless the adapter proves rejection.
        const e=error as {code?:string;unknown?:boolean};row.state=['uploading','sending','sent'].includes(row.state)&&e.unknown!==false?'unknown':'failed';row.error=e.code??'artifact_failed';this.save(row);
        const subject=row.id.startsWith('artifact:generated-')?'图片':`文件 ${row.path}`;
        this.store.addOutput(row.inboxKey,`artifact-receipt:${row.id}`,`${subject}交付${row.state==='unknown'?'结果未确认，未自动重发':'失败'}（${row.error}）。`);
      }
    }finally{this.busy=false;}
  }
}
