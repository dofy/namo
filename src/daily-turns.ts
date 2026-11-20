import type { Store } from './store.js';

const reservationPrefix = 'daily-turn-run:';

type DailyTurnCharge = { state: 'unlimited' } | { state: 'charged' | 'exhausted' | 'invalid'; day: string };

export function dailyTurnDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export class DailyTurns {
  constructor(private readonly store: Store) {}

  used(day: string): number {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`daily-turns:${day}`);
    return row ? Number(row.value) : 0;
  }

  /** The caller wraps this in the transaction that admits the model turn. */
  charge(limit: number): DailyTurnCharge {
    if (!limit) return { state: 'unlimited' };
    const day = dailyTurnDay();
    const used = this.used(day);
    if (!Number.isSafeInteger(used) || used < 0) return { state: 'invalid', day };
    if (used >= limit) return { state: 'exhausted', day };
    this.setUsed(day, used + 1);
    return { state: 'charged', day };
  }

  private setUsed(day: string, used: number): void {
    this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`daily-turns:${day}`, String(used));
  }

  reserve(run: string, day: string): void {
    this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(reservationPrefix + run, day);
  }

  clearReservation(run: string): void {
    this.store.db.prepare('DELETE FROM settings WHERE key=?').run(reservationPrefix + run);
  }

  /** After task recovery, only a running task can still need its original charge. */
  pruneFinishedReservations(): void {
    this.store.db.prepare(`DELETE FROM settings WHERE key GLOB ? AND NOT EXISTS (
      SELECT 1 FROM task_runs WHERE id=substr(settings.key, ?) AND state='running'
    )`).run(`${reservationPrefix}*`, reservationPrefix.length + 1);
  }

  /** Only the caller that proves the run never reached the model may refund it. */
  refundUndispatched(run: string): void {
    const key = reservationPrefix + run;
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    const day = row?.value;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    const used = this.used(day);
    if (Number.isSafeInteger(used) && used > 0) this.setUsed(day, used - 1);
    this.clearReservation(run);
  }
}
