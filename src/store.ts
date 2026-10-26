import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Incoming {
  key: string; messageId: string; chatKey: string; chatId: string;
  senderId: string; text: string; createdAt?: number;
}
export interface Inbox extends Incoming { seq: number; state: string; cancelRequested: number; }
export interface Outbox {
  id: number; inboxKey: string; chatId: string; kind: string; part: number;
  content: string; uuid: string; state: string; platformId: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(file: string, readOnly = false) {
    if (readOnly) { this.db = new DatabaseSync(file, { readOnly: true }); return; }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
        messageId TEXT NOT NULL, chatKey TEXT NOT NULL, chatId TEXT NOT NULL,
        senderId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued', cancelRequested INTEGER NOT NULL DEFAULT 0,
        threadId TEXT, turnId TEXT, error TEXT, finishedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS inbox_queue ON inbox(state,seq);
      CREATE INDEX IF NOT EXISTS inbox_chat ON inbox(chatKey,seq);
      CREATE TABLE IF NOT EXISTS sessions (
        chatKey TEXT PRIMARY KEY, threadId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, inboxKey TEXT NOT NULL REFERENCES inbox(key),
        chatId TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER NOT NULL,
        content TEXT NOT NULL, uuid TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
        platformId TEXT, error TEXT, createdAt INTEGER NOT NULL,
        UNIQUE(inboxKey,kind,part)
      );
    `);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  bindAccount(appId: string): void {
    this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES('account',?)").run(appId);
      const account = this.db.prepare("SELECT value FROM settings WHERE key='account'").get() as { value: string };
      if (account.value !== appId) throw new Error('此 dataDir 属于另一个飞书应用，请为新应用指定独立 dataDir');
    });
  }
  enqueue(m: Incoming): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO inbox(key,messageId,chatKey,chatId,senderId,text,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(m.key, m.messageId, m.chatKey, m.chatId, m.senderId, m.text, m.createdAt ?? Date.now()).changes === 1;
  }
  get(key: string): Inbox | undefined { return this.db.prepare('SELECT * FROM inbox WHERE key=?').get(key) as unknown as Inbox | undefined; }
  next(excluded: string[]): Inbox | undefined {
    const rows = this.db.prepare(`SELECT i.* FROM inbox i WHERE i.state='queued'
      AND NOT EXISTS (SELECT 1 FROM inbox p WHERE p.chatKey=i.chatKey AND p.seq<i.seq
        AND p.state IN ('queued','running','awaiting_reply')) ORDER BY i.seq LIMIT 100`).all() as unknown as Inbox[];
    return rows.find(r => !excluded.includes(r.chatKey));
  }
  claim(key: string): boolean { return this.db.prepare("UPDATE inbox SET state='running' WHERE key=? AND state='queued'").run(key).changes === 1; }
  thread(chatKey: string): string | undefined { return (this.db.prepare('SELECT threadId FROM sessions WHERE chatKey=?').get(chatKey) as { threadId: string } | undefined)?.threadId; }
  saveThread(chatKey: string, threadId: string): void { this.db.prepare('INSERT INTO sessions VALUES(?,?) ON CONFLICT(chatKey) DO UPDATE SET threadId=excluded.threadId').run(chatKey, threadId); }
  clearThread(chatKey: string): void { this.db.prepare('DELETE FROM sessions WHERE chatKey=?').run(chatKey); }
  project(chatKey: string): string | undefined { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(`project:${chatKey}`) as { value: string } | undefined)?.value; }
  setProject(chatKey: string, project: string): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`project:${chatKey}`, project);
      this.clearThread(chatKey);
    });
  }
  bindWorkspace(chatKey: string, cwd: string): void {
    this.transaction(() => {
      const key = `cwd:${chatKey}`;
      const old = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
      if (old?.value !== cwd) this.clearThread(chatKey);
      this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, cwd);
    });
  }
  hasPending(chatKey: string, except: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM inbox WHERE chatKey=? AND key!=? AND state IN ('queued','running','awaiting_reply') LIMIT 1").get(chatKey, except);
  }
  saveRun(key: string, threadId: string, turnId?: string): void { this.db.prepare('UPDATE inbox SET threadId=?,turnId=? WHERE key=?').run(threadId, turnId ?? null, key); }
  addOutput(key: string, kind: string, content: string): void {
    const input = this.get(key);
    if (!input) throw new Error('inbox_missing');
    const chars = Array.from(content);
    for (let start = 0, part = 0; start < chars.length; start += 2000, part++) {
      this.db.prepare('INSERT OR IGNORE INTO outbox(inboxKey,chatId,kind,part,content,uuid,createdAt) VALUES(?,?,?,?,?,?,?)')
        .run(key, input.chatId, kind, part, chars.slice(start, start + 2000).join(''), randomUUID(), Date.now());
    }
  }
  finish(key: string, text: string, error?: string): void {
    this.transaction(() => {
      this.addOutput(key, 'result', text);
      this.db.prepare("UPDATE inbox SET state='awaiting_reply',error=?,finishedAt=? WHERE key=? AND state='running'").run(error ?? null, Date.now(), key);
    });
  }
  nextOutput(): Outbox | undefined {
    return this.db.prepare(`SELECT o.* FROM outbox o WHERE o.state='pending'
      AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.inboxKey=o.inboxKey AND p.kind=o.kind AND p.id<o.id AND p.state!='sent')
      ORDER BY o.id LIMIT 1`).get() as unknown as Outbox | undefined;
  }
  sending(id: number): boolean { return this.db.prepare("UPDATE outbox SET state='sending' WHERE id=? AND state='pending'").run(id).changes === 1; }
  sent(id: number, platformId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state='sent',platformId=? WHERE id=? AND state='sending'").run(platformId, id);
      this.db.prepare(`UPDATE inbox SET state=CASE WHEN error IS NULL THEN 'replied' ELSE 'failed' END
        WHERE state='awaiting_reply' AND key=(SELECT inboxKey FROM outbox WHERE id=?)
        AND NOT EXISTS (SELECT 1 FROM outbox WHERE inboxKey=inbox.key AND kind='result' AND state!='sent')`).run(id);
    });
  }
  deliveryFailed(id: number, unknown: boolean, reason: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state=?,error=? WHERE id=?").run(unknown ? 'unknown' : 'failed', reason, id);
      this.db.prepare("UPDATE inbox SET state=?,error=? WHERE key=(SELECT inboxKey FROM outbox WHERE id=? AND kind='result')")
        .run(unknown ? 'delivery_unknown' : 'delivery_failed', reason, id);
    });
  }
  cancel(chatKey: string, excludeKey: string): Inbox[] {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM inbox WHERE chatKey=? AND key!=? AND state IN ('queued','running')").all(chatKey, excludeKey) as unknown as Inbox[];
      for (const r of rows) {
        if (r.state === 'running') this.db.prepare('UPDATE inbox SET cancelRequested=1 WHERE key=?').run(r.key);
        else {
          this.addOutput(r.key, 'result', '这条请求已取消。');
          this.db.prepare("UPDATE inbox SET state='awaiting_reply',error='cancelled',finishedAt=? WHERE key=?").run(Date.now(), r.key);
        }
      }
      return rows;
    });
  }
  recover(): { interrupted: number; unknown: number } {
    return this.transaction(() => {
      const outputs = this.db.prepare("SELECT id FROM outbox WHERE state='sending'").all() as { id: number }[];
      for (const row of outputs) {
        this.db.prepare("UPDATE outbox SET state='unknown',error='process_stopped_during_send' WHERE id=?").run(row.id);
        this.db.prepare("UPDATE inbox SET state='delivery_unknown',error='process_stopped_during_send' WHERE key=(SELECT inboxKey FROM outbox WHERE id=? AND kind='result')").run(row.id);
      }
      const rows = this.db.prepare("SELECT key FROM inbox WHERE state='running'").all() as { key: string }[];
      for (const row of rows) {
        this.addOutput(row.key, 'result', '服务在处理这条请求时中断，执行结果未确认。为避免重复执行操作，没有自动重跑；请先查询状态，再决定是否重新提交。');
        this.db.prepare("UPDATE inbox SET state='awaiting_reply',error='interrupted',finishedAt=? WHERE key=?").run(Date.now(), row.key);
      }
      return { interrupted: rows.length, unknown: outputs.length };
    });
  }
  status(chatKey?: string): unknown {
    const states = this.db.prepare(`SELECT state,COUNT(*) AS count FROM inbox ${chatKey ? 'WHERE chatKey=?' : ''} GROUP BY state`).all(...(chatKey ? [chatKey] : []));
    const recent = this.db.prepare(`SELECT messageId,state,createdAt,error FROM inbox ${chatKey ? 'WHERE chatKey=?' : ''} ORDER BY seq DESC LIMIT 5`).all(...(chatKey ? [chatKey] : []));
    const outbox = this.db.prepare(`SELECT o.id,o.state,o.kind,o.platformId FROM outbox o JOIN inbox i ON i.key=o.inboxKey
      WHERE o.state IN ('failed','unknown') ${chatKey ? 'AND i.chatKey=?' : ''} ORDER BY o.id DESC LIMIT 10`).all(...(chatKey ? [chatKey] : []));
    return { states, recent, deliveryIssues: outbox };
  }
  close(): void { this.db.close(); }
}
