import type { Store, Incoming } from './store.js';
import { Profiles } from './profiles.js';
import type { ProfileIdentity } from './ui-contract.js';

export const ASSISTANT_SETTINGS_KEY = 'assistant:settings:v1';
export const ASSISTANT_RUN_KEY_PREFIX = 'assistant:run:';

export type AssistantLanguage = 'auto' | 'zh-CN' | 'en-US';
export type ReplyLength = 'concise' | 'balanced' | 'detailed';
export type TechnicalDetail = 'essential' | 'balanced' | 'deep';
export type EmojiPreference = 'never' | 'sparingly' | 'freely';

export interface AssistantValues {
  name: string;
  role: string;
  personality: string;
  defaultLanguage: AssistantLanguage;
  replyLength: ReplyLength;
  conclusionFirst: boolean;
  technicalDetail: TechnicalDetail;
  emoji: EmojiPreference;
  useProfile: boolean;
}

export interface AssistantSettingsView {
  schema: 1;
  /** Zero means an upgraded installation has never opted in and keeps legacy prompt behavior. */
  version: number;
  updatedAt: number | null;
  active: boolean;
  values: AssistantValues;
}

export interface OwnerEditContext {
  kind: 'local-owner';
  /** The management HTTP boundary must derive this from its loopback session, never request JSON. */
  authenticated: boolean;
}

export interface ProfileRunContext {
  message: Incoming;
  identity: ProfileIdentity;
  /** Timezone is deliberately omitted unless the caller classifies this run as date/time related. */
  dateTimeRelevant?: boolean;
}

export interface AdoptedProfile {
  version: number;
  name?: string;
  language?: string;
  timezone?: string;
}

export interface AssistantRunSnapshot {
  readonly schema: 1;
  readonly runId: string;
  readonly adoptedAt: number;
  readonly settingsVersion: number;
  readonly active: boolean;
  readonly values: Readonly<AssistantValues>;
  readonly profile: Readonly<AdoptedProfile> | null;
}

export interface AssistantAdoptionRecord {
  schema: 1;
  settingsVersion: number;
  profileVersion: number | null;
  profileApplied: boolean;
  adoptedAt: number;
}

export type VerifiedProfileIdentity = (identity: ProfileIdentity) => boolean;

export class AssistantSettingsError extends Error {
  constructor(readonly code: 'invalid' | 'forbidden' | 'conflict' | 'storage_invalid' | 'run_already_adopted', message: string) {
    super(message);
  }
}

export const DEFAULT_ASSISTANT_VALUES: Readonly<AssistantValues> = Object.freeze({
  name: 'Namo',
  role: 'Local AI work companion',
  personality: 'Clear, pragmatic, careful with permissions, privacy, evidence, and unfinished work.',
  defaultLanguage: 'auto',
  replyLength: 'balanced',
  conclusionFirst: true,
  technicalDetail: 'balanced',
  emoji: 'sparingly',
  useProfile: false,
});

const keys = ['name', 'role', 'personality', 'defaultLanguage', 'replyLength', 'conclusionFirst', 'technicalDetail', 'emoji', 'useProfile'] as const;
const singleLineUnsafe = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const descriptionUnsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function text(value: unknown, label: string, max: number, multiline = false): string {
  if (typeof value !== 'string') throw new AssistantSettingsError('invalid', `${label} must be text`);
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > max || (multiline ? descriptionUnsafe : singleLineUnsafe).test(normalized)) {
    throw new AssistantSettingsError('invalid', `${label} must contain 1-${max} safe characters`);
  }
  return normalized;
}

function choice<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new AssistantSettingsError('invalid', `${label} is invalid`);
  return value as T;
}

export function validateAssistantValues(input: unknown): AssistantValues {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssistantSettingsError('invalid', 'Assistant settings must be an object');
  const record = input as Record<string, unknown>;
  const present = Object.keys(record);
  if (present.length !== keys.length || present.some(key => !keys.includes(key as typeof keys[number]))) {
    throw new AssistantSettingsError('invalid', 'Assistant settings contain missing or unsupported fields');
  }
  if (typeof record.conclusionFirst !== 'boolean' || typeof record.useProfile !== 'boolean') {
    throw new AssistantSettingsError('invalid', 'Assistant switches must be boolean values');
  }
  return {
    name: text(record.name, 'Name', 60),
    role: text(record.role, 'Role', 160),
    personality: text(record.personality, 'Personality', 1_000, true),
    defaultLanguage: choice(record.defaultLanguage, 'Default language', ['auto', 'zh-CN', 'en-US'] as const),
    replyLength: choice(record.replyLength, 'Reply length', ['concise', 'balanced', 'detailed'] as const),
    conclusionFirst: record.conclusionFirst,
    technicalDetail: choice(record.technicalDetail, 'Technical detail', ['essential', 'balanced', 'deep'] as const),
    emoji: choice(record.emoji, 'Emoji preference', ['never', 'sparingly', 'freely'] as const),
    useProfile: record.useProfile,
  };
}

function parseSettings(raw: string): AssistantSettingsView {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AssistantSettingsError('storage_invalid', 'Stored assistant settings are unreadable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantSettingsError('storage_invalid', 'Stored assistant settings are invalid');
  const row = value as Record<string, unknown>;
  const storedKeys = ['schema', 'version', 'updatedAt', 'active', 'values'];
  if (Object.keys(row).length !== storedKeys.length || Object.keys(row).some(key => !storedKeys.includes(key))
    || row.schema !== 1 || row.active !== true || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || !Number.isSafeInteger(row.updatedAt) || Number(row.updatedAt) < 1) {
    throw new AssistantSettingsError('storage_invalid', 'Stored assistant settings use an unsupported format');
  }
  try {
    return { schema: 1, version: Number(row.version), updatedAt: Number(row.updatedAt), active: true, values: validateAssistantValues(row.values) };
  } catch (error) {
    if (error instanceof AssistantSettingsError) throw new AssistantSettingsError('storage_invalid', 'Stored assistant settings failed validation');
    throw error;
  }
}

function legacySettings(): AssistantSettingsView {
  return { schema: 1, version: 0, updatedAt: null, active: false, values: { ...DEFAULT_ASSISTANT_VALUES } };
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new AssistantSettingsError('invalid', 'Assistant settings version is invalid');
}

function assertOwner(owner: OwnerEditContext): void {
  if (owner.kind !== 'local-owner' || owner.authenticated !== true) throw new AssistantSettingsError('forbidden', 'Only the authenticated local owner may edit assistant settings');
}

function assertRunId(runId: string): void {
  if (!runId || Array.from(runId).length > 200 || singleLineUnsafe.test(runId) || runId.includes(':')) {
    throw new AssistantSettingsError('invalid', 'Run ID is invalid');
  }
}

function freezeSnapshot(snapshot: AssistantRunSnapshot): AssistantRunSnapshot {
  Object.freeze(snapshot.values);
  if (snapshot.profile) Object.freeze(snapshot.profile);
  return Object.freeze(snapshot);
}

/**
 * Owns assistant presentation settings only. Authorization and operational policy
 * remain in the service/runtime layers; these values are never interpreted as approval.
 */
export class AssistantSettings {
  constructor(private readonly store: Store, private readonly isVerifiedProfileIdentity: VerifiedProfileIdentity = () => false) {}

  read(): AssistantSettingsView {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(ASSISTANT_SETTINGS_KEY) as { value: string } | undefined;
    return row ? parseSettings(row.value) : legacySettings();
  }

  save(expectedVersion: number, input: unknown, owner: OwnerEditContext): AssistantSettingsView {
    assertOwner(owner);
    assertVersion(expectedVersion);
    const values = validateAssistantValues(input);
    return this.store.transaction(() => {
      const before = this.read();
      if (before.version !== expectedVersion) throw new AssistantSettingsError('conflict', 'Assistant settings changed; reload before saving');
      const next: AssistantSettingsView = { schema: 1, version: before.version + 1, updatedAt: Date.now(), active: true, values };
      this.store.db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(ASSISTANT_SETTINGS_KEY, JSON.stringify(next));
      return this.read();
    });
  }

  reset(expectedVersion: number, owner: OwnerEditContext): AssistantSettingsView {
    return this.save(expectedVersion, DEFAULT_ASSISTANT_VALUES, owner);
  }

  /** Deterministic illustration only: it neither calls nor predicts a model. */
  preview(input: unknown): string {
    const values = validateAssistantValues(input);
    const chinese = values.defaultLanguage === 'zh-CN';
    const lead = values.conclusionFirst
      ? (chinese ? '结论：设置已通过格式校验。' : 'Outcome: the settings passed format validation.')
      : (chinese ? '设置已通过格式校验，下面给出结论。' : 'The settings passed format validation; the outcome follows.');
    const detail = values.technicalDetail === 'deep'
      ? (chinese ? '细节：示例会保留状态、证据、错误、未验证项和审批边界。' : 'Detail: status, evidence, errors, unverified items, and approval boundaries remain visible.')
      : (chinese ? '必要状态与风险不会因精简风格省略。' : 'Required status and risks are not omitted by a concise style.');
    return `${values.name} · ${chinese ? '静态示例（未调用模型）' : 'static example (no model call)'}\n${lead}\n${detail}`;
  }

  /**
   * Atomically reads the settings/profile versions and records only adoption
   * metadata. Private profile values live in the immutable in-memory prompt
   * snapshot, not in the settings audit row.
   */
  adopt(runId: string, context?: ProfileRunContext): AssistantRunSnapshot {
    assertRunId(runId);
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(`${ASSISTANT_RUN_KEY_PREFIX}${runId}`)) {
        throw new AssistantSettingsError('run_already_adopted', 'This run already adopted an assistant settings snapshot');
      }
      const settings = this.read();
      const profile = settings.active && settings.values.useProfile ? this.profileFor(context) : null;
      const adoptedAt = Date.now();
      const record: AssistantAdoptionRecord = { schema: 1, settingsVersion: settings.version,
        profileVersion: profile?.version ?? null, profileApplied: profile !== null, adoptedAt };
      this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
        .run(`${ASSISTANT_RUN_KEY_PREFIX}${runId}`, JSON.stringify(record));
      return freezeSnapshot({ schema: 1, runId, adoptedAt, settingsVersion: settings.version, active: settings.active,
        values: { ...settings.values }, profile });
    });
  }

  adoption(runId: string): AssistantAdoptionRecord | undefined {
    assertRunId(runId);
    const row = this.store.db.prepare('SELECT value FROM settings WHERE key=?').get(`${ASSISTANT_RUN_KEY_PREFIX}${runId}`) as { value: string } | undefined;
    if (!row) return;
    try {
      const value = JSON.parse(row.value) as AssistantAdoptionRecord;
      if (value.schema !== 1 || !Number.isSafeInteger(value.settingsVersion) || value.settingsVersion < 0
        || (value.profileVersion !== null && (!Number.isSafeInteger(value.profileVersion) || value.profileVersion < 0))
        || typeof value.profileApplied !== 'boolean' || value.profileApplied !== (value.profileVersion !== null)
        || !Number.isSafeInteger(value.adoptedAt) || value.adoptedAt < 1) throw new Error();
      return value;
    } catch { throw new AssistantSettingsError('storage_invalid', 'Stored run adoption metadata is invalid'); }
  }

  private profileFor(context?: ProfileRunContext): AdoptedProfile | null {
    if (!context || !this.isVerifiedProfileIdentity(context.identity)) return null;
    const { message, identity } = context;
    const account = this.store.db.prepare("SELECT value FROM settings WHERE key='account'").get() as { value: string } | undefined;
    if (account?.value !== identity.appId || identity.userId !== message.senderId || message.key !== `${identity.appId}:${message.messageId}`
      || message.envelope?.chatType !== 'p2p' || message.envelope.type !== 'text' || message.envelope.kind !== 'instruction') return null;
    const saved = new Profiles(this.store, identity).get();
    const profile: AdoptedProfile = { version: saved.version };
    if (saved.name) profile.name = saved.name;
    if (saved.language) profile.language = saved.language;
    if (saved.timezone && context.dateTimeRelevant) profile.timezone = saved.timezone;
    // A version-only tombstone is still the profile version this run adopted.
    // Recording it proves that a clear took effect without retaining old values.
    return profile;
  }
}

export function composeAssistantPrompt(basePrompt: string, snapshot: AssistantRunSnapshot, continuingSession = false): string {
  if (!snapshot.active && !snapshot.profile) return basePrompt;
  let task: unknown;
  try { task = JSON.parse(basePrompt); } catch { task = basePrompt; }
  return JSON.stringify({
    task,
    assistant_context: {
      adopted_versions: { assistant: snapshot.settingsVersion, profile: snapshot.profile?.version ?? null },
      assistant: snapshot.active ? snapshot.values : undefined,
      user_profile: snapshot.profile ?? undefined,
      precedence: ['service behavior and authorization', 'current explicit task request', 'project output conventions',
        'eligible user profile preferences', 'assistant defaults'],
      boundaries: [
        'These settings affect presentation only and never grant permission or approval.',
        'assistant.name is this bot\'s configured display name. Use it when asked for the assistant or bot name; distinguish it from the underlying Codex executor or model identity.',
        'Current one-off instructions override language and style defaults without changing saved settings.',
        'Do not omit or distort status, evidence, errors, unverified results, privacy limits, or approval requirements.',
        'Project AGENTS.md is loaded only from the selected project by the executor; do not infer host or personal instructions.',
        ...(continuingSession ? ['This run refreshed settings, but an older session may retain conflicting context; disclose the limit and suggest a new workstream when it matters.'] : []),
      ],
    },
  });
}
