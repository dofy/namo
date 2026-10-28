import type { Store, Incoming } from './store.js';
import { Memories, MemoryError, type MemoryAuthority, type MemoryVersionRef } from './memory.js';
import { Tasks } from './tasks.js';
import { readEvidence } from './evidence.js';

/** Explicit commands only; model text, quoted messages and material cannot write memory. */
export function memoryCommand(store:Store,m:Incoming,allowedUsers:string[],project:string|null,redact:(s:string)=>string,allowedProjects?:readonly string[]):string|undefined{
  const [command,...args]=m.text.trim().split(/\s+/);
  if(!['/remember','/memories','/memory-correct','/memory-disable','/forget','/handoff'].includes(command))return;
  if(!allowedUsers.includes(m.senderId)||m.envelope?.chatType!=='p2p'||m.envelope.type!=='text'||m.envelope.kind!=='instruction'||m.envelope.materials.length||m.envelope.parentId||m.envelope.rootId)return '记忆操作只接受已配对本人的直接私聊文字命令；引用和材料不会改写记忆。';
  const authority:MemoryAuthority={kind:'verified-user',authenticated:true,ownerId:m.senderId,chatKey:m.chatKey,chatType:'p2p',project,allowedProjects,source:{kind:'message',ref:m.key}};
  const memory=new Memories(store,redact);
  try{
    if(command==='/memories'){
      const literal=(text:string)=>text.replace(/[\\`*_{}\[\]()#~!>|+-]/g,'\\$&');
      const rows=memory.search({...authority,allowedProjects},{query:args.join(' ')});
      return rows.length ? `**当前范围内的记忆**\n${rows.map(row=>`\`${row.id}\` · v${row.version} · ${row.scope.kind}\n${literal(row.text)}`).join('\n\n')}` : '没有当前范围内可用的记忆。';
    }
    if(command==='/remember'){
      const [scope,...body]=args;if(!['owner','project','chat'].includes(scope)||!body.length)return '用法：`/remember owner|project|chat 明确要记住的内容`';
      const saved=memory.save({kind:scope==='project'?'project_knowledge':'preference',scope:{kind:scope as 'owner'|'project'|'chat',ownerId:m.senderId,project:scope==='owner'?null:project,chatKey:scope==='chat'?m.chatKey:null},text:body.join(' ')},authority);
      return `已保存 ${saved.id} · v${saved.version}，后续运行会按范围使用。`;
    }
    if(command==='/handoff'){
      const tasks=new Tasks(store),task=tasks.owned(args[0]??'',m);if(!task||task.scopeKey!==(m.envelope?.scopeKey??m.chatKey))return '未找到本聊天中可交接的本人任务。用法：/handoff N-任务编号';
      const input=store.get(task.inboxKey)!,runs=store.db.prepare('SELECT id FROM task_runs WHERE taskId=? ORDER BY startedAt DESC LIMIT 1').all(task.id);
      const dependencies:MemoryVersionRef[]=runs.flatMap(run=>memory.snapshotRecord(String(run.id))?.items??[]);
      const answer=store.db.prepare("SELECT content FROM output_sources WHERE inboxKey=? AND kind='result'").get(task.inboxKey);
      const evidence=readEvidence(store,task.id).flatMap(report=>report.items.map(item=>`${item.kind}: ${item.status}`)).slice(0,5);
      const saved=memory.saveHandoff({scope:{kind:'chat',ownerId:m.senderId,chatKey:m.chatKey,project:task.project??null},goal:input.text.slice(0,350),
        limitations:['仅限本用户、本聊天和本项目；不复制 Agent session，不授予新操作权限。'],
        decisions:answer?[String(answer.content).slice(0,350)]:[],evidence:[`来源任务 ${task.id} / ${input.messageId}`,...evidence],
        unfinished:['实时任务状态和后续变化请查原任务，不能把此交接视作最新执行状态。'],dependsOn:dependencies}, {...authority,project:task.project??null});
      return `已保存交接 ${saved.id} · v${saved.version}。在本聊天和同一项目的新会话中可用，默认 30 天后失效。`;
    }
    const id=args[0],version=Number(args[1]);
    if(!id||!Number.isSafeInteger(version))return '请提供记忆编号和版本；先用 `/memories` 查看。';
    const updated=command==='/memory-correct'?memory.correct(id,version,{text:args.slice(2).join(' ')},authority):command==='/memory-disable'?memory.disable(id,version,authority):memory.delete(id,version,authority);
    return `已更新 ${updated.id} · v${updated.version}；后续检索与运行按新状态处理。`;
  }catch(error){if(error instanceof MemoryError)return `记忆操作未完成：${error.message}`;throw error;}
}
