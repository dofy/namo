import type { Store } from './store.js';
import type { ProfileChange, ProfileIdentity, ProfileValues, UserProfile } from './ui-contract.js';

export class ProfileError extends Error {}
const fields = ['name', 'language', 'timezone'] as const;

function validatePatch(input: unknown): Partial<ProfileValues> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileError('档案内容无效');
  const entries = Object.entries(input);
  if (!entries.length || entries.some(([key]) => !fields.includes(key as keyof ProfileValues))) throw new ProfileError('只能修改称呼、语言和时区');
  const patch: Partial<ProfileValues> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw)) throw new ProfileError('档案字段必须是单行文字，不能包含控制字符');
    let value = raw.trim();
    if (Array.from(value).length > (key === 'name' ? 80 : 64)) throw new ProfileError('称呼最多 80 字，语言和时区最多 64 字');
    if (value && key === 'language') {
      try { value = Intl.getCanonicalLocales(value)[0]!; } catch { throw new ProfileError('语言格式无效，例如 zh-CN 或 en-US'); }
    }
    if (value && key === 'timezone') {
      try { value = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
      catch { throw new ProfileError('时区无效，例如 Asia/Shanghai 或 UTC'); }
    }
    patch[key as keyof ProfileValues] = value;
  }
  return patch;
}

/** Profiles are data only; they never change authorization or enter model prompts. */
export class Profiles {
  constructor(private store: Store, readonly identity: ProfileIdentity) {
    if (!['feishu', 'lark'].includes(identity.channel) || !identity.appId || !identity.userId) throw new ProfileError('档案身份不完整');
    const account = store.db.prepare("SELECT value FROM settings WHERE key='account'").get()?.value;
    if (account && account !== identity.appId) throw new ProfileError('应用与数据目录不匹配，不能读取或修改档案');
  }
  private key(): [string, string, string] { return [this.identity.channel, this.identity.appId, this.identity.userId]; }
  get(): UserProfile {
    const row = this.store.db.prepare('SELECT name,language,timezone,version,updatedAt FROM user_profiles WHERE channel=? AND appId=? AND userId=?').get(...this.key());
    const changes = this.store.db.prepare('SELECT version,fields,source,sourceRef,createdAt FROM profile_changes WHERE channel=? AND appId=? AND userId=? ORDER BY version DESC LIMIT 10').all(...this.key());
    return { ...this.identity, ...(row as unknown as ProfileValues & { version: number; updatedAt: number } ?? { name: '', language: '', timezone: '', version: 0, updatedAt: null }),
      changes: changes.map(change => ({ ...change, fields: JSON.parse(String(change.fields)) })) as unknown as ProfileChange[] };
  }
  update(version: number, input: unknown, origin: { source: 'self'; sourceRef: string } | { source: 'local-owner' }): UserProfile {
    if (!Number.isSafeInteger(version) || version < 0) throw new ProfileError('档案版本无效，请重新查看档案');
    const patch = validatePatch(input);
    return this.store.transaction(() => {
      const before = this.get();
      if (before.version !== version) throw new ProfileError('档案已被修改，草稿未覆盖已保存内容；请重新查看并核对版本');
      // Self-service writes must trace to an accepted private text message from
      // this sender. Neither quoted authors nor caller-supplied names are identity.
      if (origin.source === 'self') {
        const m = this.store.get(origin.sourceRef);
        if (!m || m.senderId !== this.identity.userId || m.envelope?.chatType !== 'p2p' || m.envelope.type !== 'text' || m.envelope.kind !== 'instruction'
          || m.envelope.parentId || m.envelope.rootId || m.envelope.materials.length || m.key !== `${this.identity.appId}:${m.messageId}`)
          throw new ProfileError('只能通过本人的独立私聊文字修改档案');
      }
      const changed = fields.filter(field => patch[field] !== undefined && patch[field] !== before[field]);
      if (!changed.length) return before;
      const next = { ...before, ...patch, version: version + 1, updatedAt: Date.now() };
      this.store.db.prepare(`INSERT INTO user_profiles(channel,appId,userId,name,language,timezone,version,updatedAt) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(channel,appId,userId) DO UPDATE SET name=excluded.name,language=excluded.language,timezone=excluded.timezone,version=excluded.version,updatedAt=excluded.updatedAt`)
        .run(...this.key(), next.name, next.language, next.timezone, next.version, next.updatedAt);
      this.store.db.prepare('INSERT INTO profile_changes(channel,appId,userId,version,fields,source,sourceRef,createdAt) VALUES(?,?,?,?,?,?,?,?)')
        .run(...this.key(), next.version, JSON.stringify(changed), origin.source, origin.source === 'self' ? origin.sourceRef : null, next.updatedAt);
      return this.get();
    });
  }
}
