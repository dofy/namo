import { randomBytes } from 'node:crypto';
import { Store, type Incoming } from './store.js';
import { scopeOf } from './tasks.js';
import { t as tr } from './locale.js';

interface Schedule {
  id:string; ownerId:string; chatKey:string; scopeKey:string; sourceKey:string;
  kind:'reminder'|'task'; content:string; intervalMs:number|null; nextAt:number;
  state:string; binding:string|null;
}
const HELP = '**定时任务**\n在私聊中直接告诉我你要创建、查看、暂停、恢复或删除的定时任务。创建时请说明内容、时间和时区；每日和每周按固定间隔重复。服务停止时不会运行，恢复后合并错过的触发。';
export class Schedules {
  constructor(private store:Store) {}
  private displayTime(row:Schedule):string {
    const saved=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`schedule-time:${row.id}`);
    const text=this.store.get(row.sourceKey)?.text??'',match=saved ? /(Z|[+-]\d{2}:\d{2})$/.exec(String(saved.value)) : /^\/schedule\s+add\s+(?:reminder|task)\s+(?:once|daily|weekly)\s+\S*?(Z|[+-]\d{2}:\d{2})(?:\s|$)/.exec(text.trim());
    if(!match||match[1]==='Z')return new Date(row.nextAt).toISOString();
    const offset=match[1],minutes=(Number(offset.slice(1,3))*60+Number(offset.slice(4,6)))*(offset[0]==='-'?-1:1);
    if(!Number.isFinite(minutes)||Math.abs(minutes)>1439)return new Date(row.nextAt).toISOString();
    return new Date(row.nextAt+minutes*60_000).toISOString().replace(/Z$/,offset);
  }
  command(m:Incoming, binding:()=>unknown, now=Date.now()):string | undefined {
    if (!/^\/schedule(?:\s|$)/.test(m.text.trim())) return;
    if (m.envelope?.chatType !== 'p2p' || !['text','post'].includes(m.envelope.type) || m.envelope.parentId || m.envelope.rootId || m.envelope.materials.length || m.envelope.limitations.length) return '请在机器人私聊中单独发送定时任务命令。';
    const text=m.text.trim();
    if (/^\/schedule(?:\s+list)?$/.test(text)) {
      const rows=this.store.db.prepare('SELECT * FROM schedules WHERE ownerId=? AND chatKey=? AND scopeKey=? AND state!=\'deleted\' ORDER BY createdAt DESC LIMIT 100').all(m.senderId,m.chatKey,scopeOf(m)) as unknown as Schedule[];
      return rows.length ? rows.map(r=>{const row=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`schedule-status:${r.id}`);let detail='';
        if(row){try{const status=JSON.parse(String(row.value));detail=[status.reason?`暂停原因：${status.reason}`:'',status.skipped?`跳过 ${status.skipped} 次触发`: ''].filter(Boolean).join(' · ');}catch{}}
        return `${r.id} · ${r.state} · ${r.kind} · ${this.displayTime(r)} · ${r.content}${detail?`\n${detail}`:''}\n\`/schedule pause ${r.id}\` · \`/schedule resume ${r.id}\` · \`/schedule delete ${r.id}\``;}).join('\n\n') : `暂无定时任务。\n${HELP}`;
    }
    const change=/^\/schedule\s+(pause|resume|delete)\s+(S-[A-Fa-f0-9]{12})$/.exec(text);
    if(change) {
      const row=this.store.db.prepare("SELECT * FROM schedules WHERE id=? AND ownerId=? AND chatKey=? AND scopeKey=? AND state!='deleted'").get(change[2].toUpperCase(),m.senderId,m.chatKey,scopeOf(m)) as unknown as Schedule|undefined;
      if(!row)return '未找到属于本人的定时任务。';
      if(change[1]==='resume' && row.state==='completed')return '一次性任务已触发，请新建任务。';
      let nextBinding=row.binding,rebound=false;
      if(change[1]==='resume' && row.state==='paused' && row.kind==='task') {
        try {
          const previous=JSON.parse(row.binding??'null'),current=binding() as {cwd?:unknown;directories?:unknown};
          if(!previous||!current||typeof previous.cwd!=='string'||typeof current.cwd!=='string')return '定时任务的工作目录绑定无效，原任务记录仍保留。';
          nextBinding=JSON.stringify(current);rebound=nextBinding!==row.binding;
        } catch {return '当前目录或权限不可用，定时任务仍保持暂停。';}
      }
      let next=row.nextAt;
      if(change[1]==='resume' && next<=now) {
        if (!row.intervalMs) next=now+1;
        else next += (Math.floor((now-next)/row.intervalMs)+1)*row.intervalMs;
      }
      this.store.db.prepare('UPDATE schedules SET state=?,nextAt=?,binding=? WHERE id=?').run(change[1]==='pause'?'paused':change[1]==='resume'?'active':'deleted',next,nextBinding,row.id);
      if(change[1]==='resume') {const key=`schedule-status:${row.id}`,saved=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);if(saved){const status=JSON.parse(String(saved.value));delete status.reason;this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(status),key);}}
      return `${row.id} 已${change[1]==='pause'?'暂停':change[1]==='resume'?'恢复':'删除'}${rebound?'，已按当前目录权限重新绑定':''}；已入队或正在执行的任务不会自动撤销。`;
    }
    const add=/^\/schedule\s+add\s+(reminder|task)\s+(once|daily|weekly)\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if(!add)return HELP;
    const time=add[3];
    const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(time);
    if(!parts)return '时间格式无效，请使用例如 2026-11-01T09:00+08:00。';
    const [,year,month,day,hour,minute,second='0',,offsetHour='0',offsetMinute='0']=parts;
    const calendar=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
    if(calendar.getUTCFullYear()!==Number(year)||calendar.getUTCMonth()+1!==Number(month)||calendar.getUTCDate()!==Number(day)
      ||Number(hour)>23||Number(minute)>59||Number(second)>59||Number(offsetHour)>23||Number(offsetMinute)>59)
      return '日期、时间或 UTC 偏移无效。';
    const next=Date.parse(time);
    if(!Number.isFinite(next)||next<=now)return '时间无效或已过去，请指定将来的时间。';
    const content=add[4].trim();
    if(content.length>4000 || !content || content.startsWith('/'))return '内容须为 1–4000 字，且不能以斜杠命令开头。';
    const count=this.store.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE ownerId=? AND state IN ('active','paused')").get(m.senderId);
    if(Number(count?.n)>=100)return '定时任务已达上限（100 项），请先删除不需要的任务。';
    let frozen:string|null=null;
    try {if(add[1]==='task') frozen=JSON.stringify(binding());} catch {return '当前目录或权限不可用，尚未创建定时任务。';}
    const id=`S-${randomBytes(6).toString('hex').toUpperCase()}`;
    const interval=add[2]==='daily'?86_400_000:add[2]==='weekly'?604_800_000:null;
    this.store.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.senderId,m.chatKey,scopeOf(m),m.key,add[1],content,interval,next,'active',frozen,now);
    return `已创建 ${id} · ${add[1]==='reminder'?'提醒':'任务'} · ${add[2]}\n首次：${time}（${new Date(next).toISOString()}）\n内容：${content}\n服务需保持运行；错过多次时只补一次。`;
  }
  /** Local owner changes are serialized with dispatch; stale UI state never overwrites a trigger. */
  changeFromWorkbench(id:string,expectedState:string,expectedNextAt:number,action:'pause'|'resume'|'delete',binding:(source:Incoming)=>unknown,now=Date.now()):void {
    this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM schedules WHERE id=?').get(id) as unknown as Schedule|undefined;
      if(!row || row.state!==expectedState || row.nextAt!==expectedNextAt)throw Error(tr('schedules.conflict'));
      if(action==='pause' && row.state!=='active' || action==='resume' && row.state!=='paused' || action==='delete' && !['paused','completed'].includes(row.state))throw Error(tr('schedules.invalidAction'));
      let next=row.nextAt,nextBinding=row.binding;
      if(action==='resume') {
        if(row.kind==='task') {
          const source=this.store.get(row.sourceKey);
          if(!source)throw Error(tr('schedules.resumeUnavailable'));
          try { const previous=JSON.parse(row.binding??'null'),current=binding(source) as {cwd?:unknown};
            if(!previous || typeof previous.cwd!=='string' || !current || typeof current.cwd!=='string')throw Error();
            nextBinding=JSON.stringify(current);
          } catch {throw Error(tr('schedules.resumeUnavailable'));}
        }
        if(next<=now)next=row.intervalMs?next+(Math.floor((now-next)/row.intervalMs)+1)*row.intervalMs:now+1;
      }
      const nextState=action==='pause'?'paused':action==='resume'?'active':'deleted';
      this.store.db.prepare('UPDATE schedules SET state=?,nextAt=?,binding=? WHERE id=?').run(nextState,next,nextBinding,id);
      if(action==='resume') {const statusKey=`schedule-status:${id}`,saved=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(statusKey);
        if(saved){const status=JSON.parse(String(saved.value));delete status.reason;this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(status),statusKey);}}
    });
  }
  /** Model tool calls use the same validated scheduler and are scoped to the authenticated message. */
  tool(m:Incoming, args:unknown, callId:string, binding:()=>unknown):unknown {
    if(m.key.startsWith('schedule:') || m.envelope?.chatType!=='p2p' || m.envelope.kind!=='instruction')
      return {error:'定时任务只能由本人在私聊中管理，定时触发不能自行创建或修改任务。'};
    if(!args || typeof args!=='object' || Array.isArray(args)) return {error:'参数无效'};
    const a=args as Record<string,unknown>;
    if(Object.keys(a).some(k=>!['operation','kind','frequency','time','content','id'].includes(k))) return {error:'参数无效'};
    if(typeof a.operation!=='string' || !['list','create','pause','resume','delete'].includes(a.operation)) return {error:'操作无效'};
    let command:string;
    if(a.operation==='list') command='/schedule list';
    else if(a.operation==='create') {
      if(typeof a.kind!=='string' || !['reminder','task'].includes(a.kind) || typeof a.frequency!=='string' || !['once','daily','weekly'].includes(a.frequency)
        || typeof a.time!=='string' || /\s/.test(a.time) || typeof a.content!=='string') return {error:'创建参数无效'};
      command=`/schedule add ${a.kind} ${a.frequency} ${a.time} ${a.content}`;
    } else {
      if(typeof a.id!=='string' || !/^S-[A-Fa-f0-9]{12}$/.test(a.id)) return {error:'请先确定任务编号'};
      command=`/schedule ${a.operation} ${a.id}`;
    }
    const key=`schedule-tool:${m.key}:${callId}`;
    return this.store.transaction(()=>{
      const previous=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
      if(previous)return JSON.parse(String(previous.value));
      const synthetic={...m,text:command,envelope:{...m.envelope!,parentId:undefined,rootId:undefined,materials:[],limitations:[]}};
      const result=this.command(synthetic,binding) ?? '操作无效';
      const id=/^已创建 (S-[A-F0-9]{12})/.exec(result)?.[1];
      if(id)this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(`schedule-time:${id}`,String(a.time).match(/(Z|[+-]\d{2}:\d{2})$/)?.[1]??'Z');
      const value={result};
      if(a.operation!=='list') this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(id?{result:`已创建 ${id}；此前工具调用已完成。`}:value));
      return value;
    });
  }
  due(now:number, dispatch:(s:Schedule,source:Incoming)=>void|false):void {
    this.store.transaction(()=>{
      const rows=this.store.db.prepare("SELECT * FROM schedules WHERE state='active' AND nextAt<=? ORDER BY nextAt LIMIT 50").all(now) as unknown as Schedule[];
      for(const row of rows) {
        const source=this.store.get(row.sourceKey);
        if(!source){this.store.db.prepare("UPDATE schedules SET state='paused' WHERE id=?").run(row.id);continue;}
        // A temporarily unavailable runtime must not consume the occurrence.
        if(dispatch(row,source)===false) continue;
        const next=row.intervalMs ? row.nextAt+(Math.floor((now-row.nextAt)/row.intervalMs)+1)*row.intervalMs : row.nextAt;
        this.store.db.prepare("UPDATE schedules SET nextAt=?, state=CASE WHEN state='active' AND intervalMs IS NULL THEN 'completed' ELSE state END WHERE id=?").run(next,row.id);
      }
    });
  }
}
