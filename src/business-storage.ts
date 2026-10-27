import type { DatabaseSync } from 'node:sqlite';
import { RecordTable, scalarFields as fields, jsonFields as json } from './record-table.js';
import type { MemoryMetadata } from './memory.js';
import type { Job } from './auto-memory.js';
import type { Delivery } from './artifact-delivery.js';
import type { ApprovalJob } from './approval-service.js';
import type { GitApprovalRecord } from './approvals.js';
import type { ExternalWait } from './external-waits.js';

export const memoryTable = (db: DatabaseSync) => new RecordTable<MemoryMetadata>(db, 'memories', 'id', {
  ...fields('id version kind status contentChars createdAt updatedAt'), expiresAt: {nullable:true},
  scopeKind:{path:'scope.kind'}, ownerId:{path:'scope.ownerId'}, project:{path:'scope.project',nullable:true}, chatKey:{path:'scope.chatKey',nullable:true},
  sourceKind:{path:'source.kind'}, sourceRef:{path:'source.ref'},
  ...json('dependsOn resourceProjects automatic visibility'),
}, {schema:1});
export function memoryJobs(db: DatabaseSync) {
  const rows = new RecordTable<Omit<Job,'inboxKeys'>>(db, 'memory_jobs', 'id', {
    ...fields('id ownerId chatKey chatType sourceKey state attempts createdAt dueAt leaseUntil accepted rejected error'),
    project:{nullable:true}, lease:{nullable:true},
  }, {version:1});
  const hydrate = (job: Omit<Job,'inboxKeys'>): Job => ({...job,inboxKeys:db.prepare(`SELECT m.inboxKey FROM memory_job_messages m
    JOIN inbox i ON i.key=m.inboxKey WHERE m.jobId=? ORDER BY i.seq`).all(job.id).map(row=>String(row.inboxKey))});
  return {
    get(id: string): Job | undefined { const row=rows.get(id); return row ? hydrate(row) : undefined; },
    list(...args: Parameters<typeof rows.list>): Job[] { return rows.list(...args).map(hydrate); },
    save(job: Job, mode: 'upsert' | 'insert' | 'ignore' = 'upsert'): number {
      db.exec('SAVEPOINT memory_job_write');
      try {
        const changed=rows.save(job,mode);
        if(changed) {
          db.prepare('DELETE FROM memory_job_messages WHERE jobId=?').run(job.id);
          const insert=db.prepare('INSERT INTO memory_job_messages(jobId,inboxKey) VALUES(?,?)');
          for(const key of job.inboxKeys)insert.run(job.id,key);
        }
        db.exec('RELEASE memory_job_write'); return changed;
      } catch(error) { db.exec('ROLLBACK TO memory_job_write; RELEASE memory_job_write'); throw error; }
    },
  };
}
export const deliveries = (db: DatabaseSync) => new RecordTable<Delivery>(db, 'artifact_deliveries', 'id', {
  ...fields('id inboxKey taskId ownerId chatId projectRoot path state uuid createdAt sha256 size fileKey platformId error'),
});
export const approvalJobs = (db: DatabaseSync) => new RecordTable<ApprovalJob>(db, 'approval_jobs', 'inboxKey', {
  ...fields('inboxKey action state createdAt updatedAt'), ...json('args'),
}, {version:1});
export const approvals = (db: DatabaseSync) => new RecordTable<GitApprovalRecord>(db, 'git_approvals', 'id', {
  ...fields('id state revision configRevision commitSummary createdAt expiresAt updatedAt attemptId reason'),
  taskId:{path:'task.taskId'}, ownerId:{path:'task.ownerId'}, chatKey:{path:'task.chatKey'},
  project:{path:'task.project',nullable:true}, cwd:{path:'task.cwd'}, policyHash:{path:'task.policyHash'},
  ...json('target events'),
}, {schemaVersion:1,operation:'git-push',limitedProtection:true});
export const externalWaits = (db: DatabaseSync) => new RecordTable<ExternalWait>(db, 'external_waits', 'id', {
  ...fields('id taskId runId threadId turnId callId ownerId chatId state revision createdAt expiresAt updatedAt lastPolledAt lastObservationHash lastError consumedAt cancelledAt'),
  ...json('target requiredChecks observation'),
}, {version:1});
