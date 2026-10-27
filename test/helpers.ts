import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Store } from '../src/store.js';

export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition_timeout');
    await setTimeout(10);
  }
}

export function storeFixture(t: { after(fn: () => void): void }, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix)), file = join(dir, 'bot.sqlite'), store = new Store(file);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store };
}

export function writable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  } else chmodSync(path, 0o600);
}

export function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body);
}

/** Real task/run parents for tests focused on child ledgers. */
export function seedRun(store: Store, runId: string, taskId = 'task:' + runId): void {
  if (store.db.prepare('SELECT 1 FROM task_runs WHERE id=?').get(runId)) return;
  store.transaction(() => {
    const key = 'source:' + taskId;
    store.enqueue({key,messageId:key,chatId:'fixture-chat',chatKey:'fixture-chat',senderId:'fixture-owner',text:'fixture source'});
    store.db.prepare('INSERT OR IGNORE INTO workstreams(id,chatKey,scopeKey,ownerId,cwd,policyHash,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(taskId,'fixture-chat','fixture-chat','fixture-owner','/fixture','policy',1);
    store.db.prepare('INSERT OR IGNORE INTO tasks(id,inboxKey,workstreamId,ownerId,chatKey,scopeKey,cwd,policyHash) VALUES(?,?,?,?,?,?,?,?)')
      .run(taskId,key,taskId,'fixture-owner','fixture-chat','fixture-chat','/fixture','policy');
    store.db.prepare('INSERT INTO task_runs(id,taskId,inputVersion,state,startedAt) VALUES(?,?,1,\'succeeded\',1)').run(runId,taskId);
  });
}
