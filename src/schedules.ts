import { randomBytes } from 'node:crypto';
import { Store, type Incoming } from './store.js';
import { scopeOf } from './tasks.js';

interface Schedule {
  id:string; ownerId:string; chatKey:string; scopeKey:string; sourceKey:string;
  kind:'reminder'|'task'; content:string; intervalMs:number|null; nextAt:number;
  state:string; binding:string|null;
}
const HELP = '**定时任务**\n`/schedule list` 查看\n`/schedule add reminder|task once|daily|weekly 2026-11-01T09:00+08:00 内容` 创建\n`/schedule pause|resume|delete S-编号` 管理\n时间必须含 UTC 偏移；daily 和 weekly 按固定间隔重复。仅支持私聊，服务停止时不会运行；恢复后合并错过的触发。';
export class Schedules {
  constructor(private store:Store) {}
  private displayTime(row:Schedule):string {
    const text=this.store.get(row.sourceKey)?.text??'',match=/^\/schedule\s+add\s+(?:reminder|task)\s+(?:once|daily|weekly)\s+\S*?(Z|[+-]\d{2}:\d{2})(?:\s|$)/.exec(text.trim());
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
          const previous=JSON.parse(row.binding??'null'),current=binding() as {project?:unknown;cwd?:unknown};
          if(!previous||!current||typeof previous.cwd!=='string'||typeof current.cwd!=='string'||previous.project!==current.project||previous.cwd!==current.cwd)return '请先切换回该定时任务原来的项目，再恢复；原绑定和任务均已保留。';
          nextBinding=JSON.stringify(current);rebound=nextBinding!==row.binding;
        } catch {return '当前项目或权限不可用，定时任务仍保持暂停。';}
      }
      let next=row.nextAt;
      if(change[1]==='resume' && next<=now) {
        if (!row.intervalMs) next=now+1;
        else next += (Math.floor((now-next)/row.intervalMs)+1)*row.intervalMs;
      }
      this.store.db.prepare('UPDATE schedules SET state=?,nextAt=?,binding=? WHERE id=?').run(change[1]==='pause'?'paused':change[1]==='resume'?'active':'deleted',next,nextBinding,row.id);
      if(change[1]==='resume') {const key=`schedule-status:${row.id}`,saved=this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);if(saved){const status=JSON.parse(String(saved.value));delete status.reason;this.store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(status),key);}}
      return `${row.id} 已${change[1]==='pause'?'暂停':change[1]==='resume'?'恢复':'删除'}${rebound?'，已按当前项目权限重新绑定':''}；已入队或正在执行的任务不会自动撤销。`;
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
    try {if(add[1]==='task') frozen=JSON.stringify(binding());} catch {return '当前项目或权限不可用，尚未创建定时任务。';}
    const id=`S-${randomBytes(6).toString('hex').toUpperCase()}`;
    const interval=add[2]==='daily'?86_400_000:add[2]==='weekly'?604_800_000:null;
    this.store.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,m.senderId,m.chatKey,scopeOf(m),m.key,add[1],content,interval,next,'active',frozen,now);
    return `已创建 ${id} · ${add[1]==='reminder'?'提醒':'任务'} · ${add[2]}\n首次：${time}（${new Date(next).toISOString()}）\n内容：${content}\n服务需保持运行；错过多次时只补一次。`;
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
