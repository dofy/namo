import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

type Field = { path?: string; json?: boolean; nullable?: boolean };
type Fields = Record<string, Field>;
/** Maps domain objects to real SQL columns. JSON is limited to explicitly listed snapshots/arrays.
 * Table, column and predicate strings are static application code; values are always bound. */
export class RecordTable<T extends object> {
  constructor(private db: DatabaseSync, private table: string, private key: string,
    private fields: Fields, private constants: Partial<T> = {}) {}
  private decode(row: Record<string, SQLOutputValue>): T {
    const result: Record<string, any> = { ...this.constants };
    for (const [column, field] of Object.entries(this.fields)) {
      const value = row[column];
      if (value == null && !field.nullable) continue;
      const path = (field.path ?? column).split('.');
      let target = result;
      for (const part of path.slice(0, -1)) target = target[part] ??= {};
      target[path.at(-1)!] = value == null ? null : field.json ? JSON.parse(String(value)) : value;
    }
    return result as T;
  }
  list(predicate = '1', args: SQLInputValue[] = [], suffix = ''): T[] {
    return this.db.prepare(`SELECT ${Object.keys(this.fields).join(',')} FROM ${this.table} WHERE ${predicate} ${suffix}`)
      .all(...args).map(row => this.decode(row));
  }
  get(id: string): T | undefined { return this.list(`${this.key}=?`, [id])[0]; }
  save(record: T, mode: 'upsert' | 'insert' | 'ignore' = 'upsert'): number {
    const entries = Object.entries(this.fields), columns = entries.map(([column]) => column);
    const values = entries.map(([column, field]) => {
      const value = (field.path ?? column).split('.').reduce((obj, key) => obj?.[key], record as any);
      return value == null ? null : field.json ? JSON.stringify(value) : value as SQLInputValue;
    });
    const conflict = mode === 'insert' ? '' : mode === 'ignore' ? `ON CONFLICT(${this.key}) DO NOTHING`
      : `ON CONFLICT(${this.key}) DO UPDATE SET ${columns.filter(c => c !== this.key).map(c => `${c}=excluded.${c}`).join(',')}`;
    return Number(this.db.prepare(`INSERT INTO ${this.table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ${conflict}`).run(...values).changes);
  }
}
export const scalarFields = (names: string): Fields => Object.fromEntries(names.split(' ').map(name => [name, {}]));
export const jsonFields = (names: string): Fields => Object.fromEntries(names.split(' ').map(name => [name, { json: true }]));
