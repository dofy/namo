import type { Store } from './store.js';
import type { ProfileIdentity } from './ui-contract.js';
import type { CatalogModel } from './model-catalog.js';

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

/** Model IDs are inline code so the Feishu rich-text reply keeps each name selectable. */
export function formatModelReply(current: string, models: readonly CatalogModel[]): string {
  const selected = current ? `\`${current}\`` : '跟随服务默认';
  const options = models.length
    ? models.map(model => `- \`${model.id}\`${[model.id === current ? '当前' : '', model.isDefault ? '推荐' : ''].filter(Boolean).map(label => ` · ${label}`).join('')}`).join('\n')
    : '模型列表暂不可用，可手动输入 Codex 模型 ID。';
  const example = models.find(model => model.isDefault)?.id ?? models[0]?.id;
  return `**个人默认模型**\n${selected}\n\n**可选模型**\n${options}\n\n**切换模型**\n`
    + (example ? `示例：\`/model ${example}\`\n` : '发送 /model 模型ID 设置。\n')
    + '`/model default` 恢复服务默认。\n\n切换只影响新任务；模型可用性以实际运行结果为准。';
}
