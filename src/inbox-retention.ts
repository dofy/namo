import type { Store } from './store.js';

/** Optional forward-only redaction. Existing records predate activation and are never touched. */
export function redactExpiredInbox(store:Store,days:number,now=Date.now()):number {
 if(!Number.isSafeInteger(days)||days<0||days>3650)return 0;
 return store.transaction(()=>{
  const marker='retention:inbox-enabled-at';
  if(days===0){store.db.prepare("UPDATE settings SET value='disabled' WHERE key=? AND value!='disabled'").run(marker);return 0;}
  store.db.prepare("UPDATE settings SET value=? WHERE key=? AND value='disabled'").run(String(now),marker);
  store.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(marker,String(now));
  const enabledAt=Number(store.db.prepare('SELECT value FROM settings WHERE key=?').get(marker)?.value);
  if(!Number.isSafeInteger(enabledAt)||enabledAt<0||enabledAt>now)return 0;
  const rows=store.db.prepare(`SELECT i.key,i.envelope FROM inbox i WHERE i.createdAt>=? AND i.createdAt<=?
    AND i.state='replied'
    AND NOT EXISTS(SELECT 1 FROM schedules s WHERE s.sourceKey=i.key AND s.state IN ('active','paused'))
    AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.inboxKey=i.key AND o.state NOT IN ('sent','confirmed','dismissed','suppressed'))
    AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=i.taskId AND t.state!='succeeded')
    AND NOT EXISTS(SELECT 1 FROM memory_job_messages mj JOIN memory_jobs j ON j.id=mj.jobId WHERE mj.inboxKey=i.key AND j.state IN ('pending','running'))
    AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.key='retention:redacted:'||i.key)
    ORDER BY i.createdAt LIMIT 100`).all(enabledAt,now-days*86_400_000);
  let changed=0;for(const row of rows){
   let envelope:Record<string,unknown>|null=null;
   try {const parsed=typeof row.envelope==='string'?JSON.parse(row.envelope):null;
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)){
      envelope={};for(const field of ['version','type','kind','scopeKey','chatType','tenantKey','threadId','parentId','rootId','sentAt'])if(Object.hasOwn(parsed,field))envelope[field]=parsed[field];
      envelope.materials=[];envelope.limitations=['消息内容已按保留策略清理'];
    }
   } catch {continue;}
   store.db.prepare('UPDATE inbox SET text=?,envelope=? WHERE key=?').run('[内容已按保留策略清理]',envelope?JSON.stringify(envelope):null,row.key);
   store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(`retention:redacted:${String(row.key)}`,String(now));
   changed++;
  }
  return changed;
 });
}
