import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { Task } from './tasks.js';
import { mcpUnknownOperationKey } from './mcp-write-approval.js';

/** Durable dispatch receipt, not an approval. Arguments and credentials are never stored here. */
export function beginMcpOperation(store:Store,task:Task,connection:string,url:string,tool:string,args:Record<string,unknown>):(outcome:'completed'|'unknown')=>void {
  const operation=mcpUnknownOperationKey(connection,url,tool,args);
  const key='mcp-operation:'+createHash('sha256').update(task.id+'\0'+operation).digest('hex');
  const record={taskId:task.id,connection,tool,state:'executing',startedAt:Date.now()};
  store.transaction(()=>{
    // Retain the earlier version's uncertain-dispatch protection after upgrade.
    if(store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(operation))throw Error('mcp_operation_outcome_unknown');
    const legacy=store.db.prepare("SELECT value FROM settings WHERE key>=? AND key<? AND json_valid(value) AND json_extract(value,'$.state') IN ('executing','unknown')").all('mcp-approval:','mcp-approval;');
    for(const row of legacy){
      const prior=JSON.parse(String(row.value));
      if(prior.url&&mcpUnknownOperationKey(prior.connection,prior.url,prior.tool,prior.arguments)===operation)throw Error('mcp_operation_outcome_unknown');
    }
    const previous=store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if(previous&&['executing','unknown'].includes(JSON.parse(String(previous.value)).state))throw Error('mcp_operation_outcome_unknown');
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(record));
  });
  return outcome=>{
    store.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({...record,state:outcome,finishedAt:Date.now()}),key);
  };
}
