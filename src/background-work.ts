import type { Store } from './store.js';

export type WorkKind = 'memory' | 'artifact' | 'artifact-intent';

/** Native queue indexes; no duplicated JSON ledger or trigger-maintained projection. */
export class BackgroundWork {
  constructor(private readonly store: Store) {}
  ready(kind: WorkKind, now = Date.now()): boolean {
    if (kind === 'memory') return !!this.store.db.prepare(`SELECT 1 FROM memory_jobs
      WHERE (state='pending' AND attempts<3 AND dueAt<=?) OR (state='running' AND leaseUntil<=?) LIMIT 1`).get(now, now);
    if (kind === 'artifact') return !!this.store.db.prepare("SELECT 1 FROM artifact_deliveries WHERE state IN ('pending','uploaded') LIMIT 1").get();
    return !!this.store.db.prepare("SELECT 1 FROM artifact_intents WHERE state='pending' LIMIT 1").get();
  }
}
