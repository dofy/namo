import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BUSINESS_SCHEMA } from './schema.js';

/** v15 -> v16. Old names are consumed here only, never exposed as runtime policy. */
export function migrateDirectorySchema(db: DatabaseSync): void {
  const mapping=new Map<string,string>();
  const ambiguous=new Set<string>();
  for(const row of db.prepare("SELECT project,cwd FROM workstreams WHERE project IS NOT NULL UNION SELECT project,cwd FROM tasks WHERE project IS NOT NULL").all()) {
    const name=String(row.project),cwd=String(row.cwd);
    if(mapping.has(name)&&mapping.get(name)!==cwd)ambiguous.add(name);
    else mapping.set(name,cwd);
  }
  const directory=(name:unknown):string|null=>typeof name==='string'&&!ambiguous.has(name)?mapping.get(name)??null:null;
  // Preserve IDs, versions, bodies, tombstones, visibility and lineage. Unknown
  // old names lose only the obsolete resource restriction, never their privacy.
  const memories=db.prepare('SELECT * FROM memories').all();
  const create=BUSINESS_SCHEMA.match(/CREATE TABLE memories \([\s\S]*?\) STRICT;/)![0];
  db.exec(create.replace('CREATE TABLE memories (','CREATE TABLE memories_v16 ('));
  const columns=db.prepare('PRAGMA table_info(memories_v16)').all().map(row=>String(row.name));
  const insert=db.prepare(`INSERT INTO memories_v16(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  for(const row of memories) {
    const value:Record<string,any>={...row,directory:directory(row.project),resourceDirectories:JSON.stringify([...new Set((JSON.parse(String(row.resourceProjects)) as unknown[]).map(directory).filter(Boolean))])};
    if(value.kind==='project_knowledge')value.kind='knowledge';
    if(value.scopeKind==='project')value.scopeKind=value.directory?'directory':'owner';
    if(value.scopeKind==='local'&&!value.directory)value.scopeKind='global';
    insert.run(...columns.map(column=>value[column as keyof typeof value] as string|number|null));
  }
  db.exec('DROP TABLE memories; ALTER TABLE memories_v16 RENAME TO memories;');
  for(const statement of BUSINESS_SCHEMA.match(/CREATE INDEX memories_[^;]+;/g)??[])db.exec(statement);
  db.exec('ALTER TABLE memory_jobs RENAME COLUMN project TO directory');
  for(const row of db.prepare('SELECT id,directory FROM memory_jobs').all())db.prepare('UPDATE memory_jobs SET directory=? WHERE id=?').run(directory(row.directory),row.id);
  for(const row of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'mcp-read-scope:%'").all()) {
    const entries=JSON.parse(String(row.value)) as {taskId:string;version?:number;legacyContext?:string|null}[];
    for(const entry of entries)if(entry.version===2)entry.legacyContext=db.prepare('SELECT project FROM tasks WHERE id=?').get(entry.taskId)?.project as string|null??null;
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(entries),row.key);
  }
  for(const row of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'memory:migration-import:v1:%'").all()) {
    const value=JSON.parse(String(row.value)),memory=db.prepare('SELECT scopeKind,ownerId,directory,chatKey FROM memories WHERE id=?').get(value.memoryId);
    if(!memory)throw Error('migration_memory_import_missing');
    value.scope={kind:memory.scopeKind,ownerId:memory.ownerId,directory:memory.directory,chatKey:memory.chatKey};
    const scope=JSON.stringify([memory.scopeKind,memory.ownerId,memory.directory,memory.chatKey]);
    let key='memory:migration-import:v1:'+createHash('sha256').update(value.fingerprint+'\0'+scope).digest('hex');
    db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
    // Multiple obsolete scopes can converge. Retain every import record while
    // keeping the canonical key available for future duplicate detection.
    if(db.prepare('SELECT 1 FROM settings WHERE key=?').get(key))key+=':'+value.memoryId;
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,JSON.stringify(value));
  }
  db.exec(`ALTER TABLE artifact_deliveries RENAME COLUMN projectRoot TO rootDirectory;
    ALTER TABLE workstreams DROP COLUMN project;
    ALTER TABLE tasks DROP COLUMN project;
    ALTER TABLE git_approvals DROP COLUMN project;`);
  const strip=(raw:string)=>{const value=JSON.parse(raw);if(value&&typeof value==='object')delete value.project;return JSON.stringify(value);};
  for(const row of db.prepare("SELECT key,value FROM settings WHERE key LIKE 'material-project:%'").all()) {
    const key=String(row.key).replace('material-project:','material-binding:');
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,strip(String(row.value)));
    db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
  }
  db.exec("DELETE FROM settings WHERE key LIKE 'project:%'");
  for(const row of db.prepare('SELECT id,binding FROM schedules WHERE binding IS NOT NULL').all())db.prepare('UPDATE schedules SET binding=? WHERE id=?').run(strip(String(row.binding)),row.id);
  db.exec('PRAGMA user_version=16');
}
