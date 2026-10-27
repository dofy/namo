import type { Store } from './store.js';

export type WorkKind = 'memory' | 'artifact' | 'artifact-intent';

/** Indexed scheduling projection; payload and audit history remain in the durable ledger. */
export class BackgroundWork {
  constructor(private readonly store: Store) {}

  ready(kind: WorkKind, now = Date.now()): boolean {
    return !!this.store.db.prepare('SELECT 1 FROM background_work WHERE kind=? AND readyAt<=? LIMIT 1').get(kind, now);
  }

  records(kind: WorkKind, now = Number.MAX_SAFE_INTEGER): { key: string; value: string }[] {
    return this.store.db.prepare(`SELECT s.key,s.value FROM background_work w JOIN settings s ON s.key=w.key
      WHERE w.kind=? AND w.readyAt<=? ORDER BY w.createdAt,w.key`).all(kind, now) as unknown as { key: string; value: string }[];
  }
}
