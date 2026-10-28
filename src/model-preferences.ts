import type { Store } from './store.js';
import type { ProfileIdentity } from './ui-contract.js';

export class ModelPreferenceError extends Error {}
const key = (identity: ProfileIdentity) => `user-model:${JSON.stringify([identity.channel, identity.appId, identity.userId])}`;

export function validateModel(value: unknown): string {
  if (typeof value !== 'string' || (value !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)))
    throw new ModelPreferenceError('模型名称无效，请使用 Codex 模型 ID，或留空使用默认模型。');
  return value;
}

export function userModel(store: Store, identity: ProfileIdentity): string {
  const row = store.db.prepare('SELECT value FROM settings WHERE key=?').get(key(identity));
  return row ? validateModel(row.value) : '';
}

export function setUserModel(store: Store, identity: ProfileIdentity, model: unknown): string {
  const value = validateModel(model);
  store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(identity), value);
  return value;
}
