/** Current development schema. Historical layouts are deliberately not supported. */
export const CORE_SCHEMA = `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL,
  sourceKey TEXT NOT NULL REFERENCES inbox(key), kind TEXT NOT NULL, content TEXT NOT NULL,
  intervalMs INTEGER, nextAt INTEGER NOT NULL, state TEXT NOT NULL, binding TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX schedules_due ON schedules(state,nextAt);
CREATE TABLE inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
  messageId TEXT NOT NULL, chatKey TEXT NOT NULL, chatId TEXT NOT NULL,
  senderId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', cancelRequested INTEGER NOT NULL DEFAULT 0,
  threadId TEXT, turnId TEXT, error TEXT, finishedAt INTEGER,
  envelope TEXT, taskId TEXT, materialUntil INTEGER
);
CREATE TABLE sessions (
  chatKey TEXT PRIMARY KEY, threadId TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, inboxKey TEXT NOT NULL REFERENCES inbox(key),
  chatId TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER NOT NULL,
  content TEXT NOT NULL, uuid TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
  platformId TEXT, error TEXT, createdAt INTEGER NOT NULL, payload TEXT,
  mutableProgress INTEGER NOT NULL DEFAULT 0, route TEXT, sendStartedAt INTEGER, acceptedAt INTEGER,
  progressRetired INTEGER NOT NULL DEFAULT 0,
  UNIQUE(inboxKey,kind,part)
);
CREATE TABLE workstreams (
  id TEXT PRIMARY KEY, chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL, ownerId TEXT NOT NULL,
  project TEXT, cwd TEXT NOT NULL, policyHash TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE bindings (
  scopeKey TEXT NOT NULL, ownerId TEXT NOT NULL, workstreamId TEXT NOT NULL REFERENCES workstreams(id),
  PRIMARY KEY(scopeKey,ownerId)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, inboxKey TEXT NOT NULL UNIQUE REFERENCES inbox(key),
  workstreamId TEXT NOT NULL REFERENCES workstreams(id), ownerId TEXT NOT NULL,
  chatKey TEXT NOT NULL, scopeKey TEXT NOT NULL, project TEXT, cwd TEXT NOT NULL, policyHash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', inputVersion INTEGER NOT NULL DEFAULT 1,
  startedAt INTEGER, finishedAt INTEGER, error TEXT
);
CREATE TABLE task_messages (
  taskId TEXT NOT NULL REFERENCES tasks(id), inboxKey TEXT NOT NULL REFERENCES inbox(key),
  role TEXT NOT NULL, version INTEGER NOT NULL, dispatch TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(taskId,inboxKey), UNIQUE(inboxKey)
);
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), inputVersion INTEGER NOT NULL,
  state TEXT NOT NULL, threadId TEXT, turnId TEXT, startedAt INTEGER NOT NULL, finishedAt INTEGER, error TEXT
);
CREATE TABLE reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL,
  beforeState TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE card_actions (
  token TEXT PRIMARY KEY, outboxId INTEGER NOT NULL REFERENCES outbox(id),
  taskId TEXT NOT NULL REFERENCES tasks(id), action TEXT NOT NULL,
  inputVersion INTEGER NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER
);
CREATE TABLE user_profiles (
  channel TEXT NOT NULL, appId TEXT NOT NULL, userId TEXT NOT NULL,
  name TEXT NOT NULL, language TEXT NOT NULL, timezone TEXT NOT NULL,
  version INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY(channel,appId,userId)
);
CREATE TABLE profile_changes (
  channel TEXT NOT NULL, appId TEXT NOT NULL, userId TEXT NOT NULL,
  version INTEGER NOT NULL, fields TEXT NOT NULL, source TEXT NOT NULL,
  sourceRef TEXT, createdAt INTEGER NOT NULL,
  PRIMARY KEY(channel,appId,userId,version)
);
CREATE TABLE run_evidence (
  runId TEXT PRIMARY KEY REFERENCES task_runs(id), report TEXT NOT NULL
);
CREATE TABLE runner_jobs (
  runId TEXT PRIMARY KEY REFERENCES task_runs(id), owner TEXT NOT NULL,
  state TEXT NOT NULL, pid INTEGER, runtimePid INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  configRevision TEXT NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT
);
CREATE TABLE runner_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL REFERENCES runner_jobs(runId),
  kind TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE task_waits (
  id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id),
  runId TEXT NOT NULL UNIQUE REFERENCES task_runs(id),
  threadId TEXT NOT NULL, turnId TEXT NOT NULL, callId TEXT NOT NULL,
  question TEXT NOT NULL, inputVersion INTEGER NOT NULL,
  state TEXT NOT NULL, createdAt INTEGER NOT NULL, settledAt INTEGER,
  replyInboxKey TEXT UNIQUE REFERENCES inbox(key), replyVersion INTEGER, choices TEXT
);
CREATE TABLE output_sources (
  inboxKey TEXT NOT NULL REFERENCES inbox(key), kind TEXT NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(inboxKey,kind)
);
CREATE TABLE run_activity (
  runId TEXT PRIMARY KEY REFERENCES task_runs(id), phase TEXT NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE run_progress (
  runId TEXT PRIMARY KEY REFERENCES task_runs(id), report TEXT NOT NULL
);
CREATE TABLE message_feedback (
  inboxKey TEXT PRIMARY KEY REFERENCES inbox(key), state TEXT NOT NULL DEFAULT 'pending',
  reactionId TEXT, error TEXT, updatedAt INTEGER NOT NULL
);
CREATE TABLE progress_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, outboxId INTEGER NOT NULL REFERENCES outbox(id),
  version INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
  content TEXT NOT NULL, createdAt INTEGER NOT NULL, error TEXT, checked INTEGER NOT NULL DEFAULT 0, revision TEXT,
  UNIQUE(outboxId,version)
);
CREATE TABLE execution_bindings (subjectId TEXT PRIMARY KEY, selection TEXT NOT NULL);
CREATE INDEX inbox_queue ON inbox(state,seq);
CREATE INDEX inbox_chat ON inbox(chatKey,seq);
CREATE INDEX tasks_queue ON tasks(state);
CREATE INDEX tasks_workstream ON tasks(workstreamId);
CREATE INDEX tasks_owner ON tasks(ownerId);
CREATE INDEX inbox_created ON inbox(createdAt,seq);
CREATE INDEX bindings_workstream ON bindings(workstreamId);
CREATE INDEX outbox_live_progress ON outbox(id)
  WHERE kind='progress' AND mutableProgress=1 AND state='sent' AND payload IS NOT NULL AND progressRetired=0;
CREATE INDEX task_runs_task_started ON task_runs(taskId,startedAt);
CREATE INDEX runner_events_run_seq ON runner_events(runId,seq);
CREATE INDEX task_waits_task ON task_waits(taskId);
CREATE INDEX outbox_pending ON outbox(id) WHERE state='pending';
CREATE INDEX settings_key_nocase ON settings(key COLLATE NOCASE);
`;

export const BUSINESS_SCHEMA = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  kind TEXT NOT NULL CHECK(kind IN ('preference','user_fact','project_knowledge','task_summary','history_quote','handoff')),
  status TEXT NOT NULL CHECK(status IN ('active','pending_review','disabled','deleted')),
  scopeKind TEXT NOT NULL CHECK(scopeKind IN ('owner','project','chat','global','local')),
  ownerId TEXT NOT NULL, project TEXT, chatKey TEXT,
  sourceKind TEXT NOT NULL CHECK(sourceKind IN ('message','document','local-owner','migration','handoff','automatic')), sourceRef TEXT NOT NULL,
  dependsOn TEXT NOT NULL CHECK(json_valid(dependsOn) AND json_type(dependsOn)='array'),
  resourceProjects TEXT NOT NULL CHECK(json_valid(resourceProjects) AND json_type(resourceProjects)='array'),
  automatic TEXT CHECK(automatic IS NULL OR (json_valid(automatic) AND json_type(automatic)='object')),
  visibility TEXT CHECK(visibility IS NULL OR (json_valid(visibility) AND json_type(visibility)='object')),
  contentChars INTEGER NOT NULL CHECK(contentChars>=0), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER,
  UNIQUE(id,version), CHECK(status!='deleted' OR contentChars=0)
) STRICT;
CREATE INDEX memories_owner ON memories(ownerId,status,scopeKind,project,chatKey);
CREATE INDEX memories_shared ON memories(scopeKind,status);
CREATE TABLE memory_contents (
  memoryId TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL,
  FOREIGN KEY(memoryId,version) REFERENCES memories(id,version) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE memory_changes (
  memoryId TEXT NOT NULL REFERENCES memories(id), version INTEGER NOT NULL CHECK(version>0),
  action TEXT NOT NULL CHECK(action IN ('saved','corrected','disabled','deleted','activated')),
  sourceKind TEXT NOT NULL, sourceRef TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(memoryId,version)
) STRICT;
CREATE TABLE memory_snapshots (
  runId TEXT PRIMARY KEY NOT NULL REFERENCES task_runs(id), createdAt INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)), items TEXT NOT NULL CHECK(json_valid(items) AND json_type(items)='array')
) STRICT;
CREATE TABLE memory_blocks (fingerprint TEXT PRIMARY KEY NOT NULL, memoryId TEXT NOT NULL REFERENCES memories(id)) STRICT;
CREATE INDEX memory_blocks_memory ON memory_blocks(memoryId);
CREATE TABLE memory_jobs (
  id TEXT PRIMARY KEY NOT NULL, sourceKey TEXT NOT NULL,
  ownerId TEXT NOT NULL, chatKey TEXT NOT NULL, chatType TEXT NOT NULL CHECK(chatType IN ('p2p','group')), project TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL CHECK(attempts>=0 AND attempts<=3), createdAt INTEGER NOT NULL, dueAt INTEGER NOT NULL,
  leaseUntil INTEGER NOT NULL, lease TEXT, accepted INTEGER CHECK(accepted>=0), rejected INTEGER CHECK(rejected>=0), error TEXT,
  CHECK((state='running' AND lease IS NOT NULL AND leaseUntil>0) OR (state!='running' AND lease IS NULL AND leaseUntil=0))
) STRICT;
CREATE INDEX memory_jobs_pending ON memory_jobs(dueAt,createdAt,id) WHERE state='pending' AND attempts<3;
CREATE INDEX memory_jobs_running ON memory_jobs(leaseUntil,createdAt,id) WHERE state='running';

CREATE TABLE memory_job_sources (
  sourceKey TEXT PRIMARY KEY NOT NULL, jobId TEXT NOT NULL REFERENCES memory_jobs(id)
) STRICT;
CREATE INDEX memory_job_sources_job ON memory_job_sources(jobId);
CREATE TABLE memory_job_messages (
  jobId TEXT NOT NULL REFERENCES memory_jobs(id), inboxKey TEXT NOT NULL REFERENCES inbox(key), PRIMARY KEY(jobId,inboxKey)
) STRICT;
CREATE INDEX memory_job_messages_inbox ON memory_job_messages(inboxKey);
CREATE TABLE artifact_deliveries (
  id TEXT PRIMARY KEY NOT NULL, inboxKey TEXT NOT NULL REFERENCES inbox(key), taskId TEXT NOT NULL REFERENCES tasks(id),
  ownerId TEXT NOT NULL, chatId TEXT NOT NULL, projectRoot TEXT NOT NULL, path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','uploading','uploaded','sending','sent','failed','unknown')),
  uuid TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
  fileKey TEXT, platformId TEXT, error TEXT,
  CHECK(state NOT IN ('uploaded','sending','sent') OR fileKey IS NOT NULL), CHECK(state!='sent' OR platformId IS NOT NULL)
) STRICT;
CREATE INDEX artifact_deliveries_task ON artifact_deliveries(taskId,createdAt);
CREATE INDEX artifact_deliveries_inbox ON artifact_deliveries(inboxKey);
CREATE INDEX artifact_deliveries_state ON artifact_deliveries(state,createdAt,id);
CREATE TABLE artifact_intents (
  taskId TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id), inboxKey TEXT NOT NULL REFERENCES inbox(key), path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processed'))
) STRICT;
CREATE INDEX artifact_intents_pending ON artifact_intents(taskId) WHERE state='pending';
CREATE INDEX artifact_intents_inbox ON artifact_intents(inboxKey);
CREATE TABLE git_approvals (
  id TEXT PRIMARY KEY NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id), ownerId TEXT NOT NULL, chatKey TEXT NOT NULL,
  project TEXT, cwd TEXT NOT NULL, policyHash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired','invalidated','executing','succeeded','failed','unknown')),
  revision INTEGER NOT NULL CHECK(revision>=0), configRevision TEXT NOT NULL, commitSummary TEXT NOT NULL,
  createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, attemptId TEXT, reason TEXT,
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  events TEXT NOT NULL CHECK(json_valid(events) AND json_type(events)='array')
) STRICT;
CREATE INDEX git_approvals_task ON git_approvals(taskId);
CREATE INDEX git_approvals_created ON git_approvals(createdAt DESC,id);
CREATE INDEX git_approvals_state ON git_approvals(state,expiresAt);
CREATE TABLE approval_jobs (
  inboxKey TEXT PRIMARY KEY NOT NULL REFERENCES inbox(key), action TEXT NOT NULL CHECK(action IN ('request','approve','reject','status')),
  args TEXT NOT NULL CHECK(json_valid(args) AND json_type(args)='array'),
  state TEXT NOT NULL CHECK(state IN ('queued','running','done')), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
) STRICT;
CREATE INDEX approval_jobs_queue ON approval_jobs(state,createdAt,inboxKey);
CREATE TABLE external_waits (
  id TEXT PRIMARY KEY NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id), runId TEXT NOT NULL REFERENCES task_runs(id),
  threadId TEXT NOT NULL, turnId TEXT NOT NULL, callId TEXT NOT NULL, ownerId TEXT NOT NULL, chatId TEXT NOT NULL,
  target TEXT NOT NULL CHECK(json_valid(target) AND json_type(target)='object'),
  requiredChecks TEXT NOT NULL CHECK(json_valid(requiredChecks) AND json_type(requiredChecks)='array'),
  state TEXT NOT NULL CHECK(state IN ('open','ready','consumed','timed_out','cancelled','stale_head')),
  revision INTEGER NOT NULL CHECK(revision>=0), createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  lastPolledAt INTEGER, observation TEXT CHECK(observation IS NULL OR (json_valid(observation) AND json_type(observation)='object')),
  lastObservationHash TEXT, lastError TEXT, consumedAt INTEGER, cancelledAt INTEGER,
  UNIQUE(runId,callId)
) STRICT;
CREATE INDEX external_waits_task ON external_waits(taskId,id);
CREATE INDEX external_waits_state ON external_waits(state,expiresAt,id);
CREATE UNIQUE INDEX external_waits_active_task ON external_waits(taskId) WHERE state IN ('open','ready');
CREATE TABLE external_wait_links (
  taskWaitId TEXT PRIMARY KEY NOT NULL REFERENCES task_waits(id), externalWaitId TEXT NOT NULL UNIQUE REFERENCES external_waits(id)
) STRICT;
`;
