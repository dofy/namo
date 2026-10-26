import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Flex, Heading, Switch, Text, TextArea, TextField } from '@radix-ui/themes';
import { getLocale } from '../i18n';
import { Choice, ConfirmButton, Field, Notice } from '../components';

// Browser-only mirror of src/assistant.ts's JSON contract. Keeping this page
// free of server imports prevents Node/SQLite code from entering the UI graph.
export interface AssistantPageValues {
  name: string; role: string; personality: string;
  defaultLanguage: 'auto' | 'zh-CN' | 'en-US';
  replyLength: 'concise' | 'balanced' | 'detailed';
  conclusionFirst: boolean;
  technicalDetail: 'essential' | 'balanced' | 'deep';
  emoji: 'never' | 'sparingly' | 'freely';
  useProfile: boolean;
}
export interface AssistantPageSettings {
  schema: 1; version: number; updatedAt: number | null; active: boolean; values: AssistantPageValues;
}
export interface AssistantPageProps {
  settings: AssistantPageSettings;
  /** False when the local-owner session has expired or the backend is unavailable. */
  editable: boolean;
  unavailableReason?: string;
  save: (expectedVersion: number, values: AssistantPageValues) => Promise<AssistantPageSettings>;
  reset: (expectedVersion: number) => Promise<AssistantPageSettings>;
  preview: (values: AssistantPageValues) => string | Promise<string>;
  refresh?: () => Promise<unknown>;
}

const copy = {
  zh: {
    intro: '设置 Namo 的身份与表达偏好。这里只改变回答方式，不会扩大权限、代替审批或隐藏失败与未验证结果。',
    local: '仅已认证的本机管理入口可以修改；聊天内容不能自动改写全局性格。',
    legacy: '尚未保存助手设置，当前继续使用升级前的提示词行为。保存或恢复默认后，从下一次运行开始生效。',
    active: '已启用', inactive: '沿用旧行为', version: '版本', name: '助手名称', role: '角色', personality: '性格描述',
    language: '默认语言', replyLength: '回复长度', conclusion: '结论优先', detail: '技术细节', emoji: 'Emoji 使用',
    profile: '在回答中使用本人档案', profileHelp: '默认关闭。启用后也只会在已验证用户本人的私聊中使用称呼和语言；时区仅用于日期时间任务。群聊绝不注入私人档案。',
    warning: '设置只影响后续运行；已开始的运行固定原版本。续接旧会话会刷新设置，但旧上下文仍可能残留，冲突明显时应新建工作线。',
    preview: '静态预览', previewHelp: '预览只做本地格式化，不调用模型，也不代表真实模型一定这样回答。', previewAction: '生成预览',
    save: '保存助手设置', saved: '助手设置已保存；后续运行采用新版本，在途运行不变。', reset: '恢复默认',
    resetTitle: '恢复默认助手设置？', resetDescription: '这只恢复助手身份与表达偏好，不会清空档案、会话、任务或权限。',
    resetDone: '已恢复默认；后续运行采用新版本。', draft: '有未保存草稿。', conflict: '助手设置已有新版本。草稿仍保留，请放弃草稿或刷新后重新编辑。',
    reload: '放弃草稿 / 载入已保存设置', reloadTitle: '放弃当前草稿？', reloadDescription: '当前未保存修改会丢失。',
    nameHint: '最多 60 字', roleHint: '最多 160 字', personalityHint: '最多 1000 字；请勿填写密码、密钥或操作授权。',
    automatic: '跟随当前任务', chinese: '简体中文', english: 'English', concise: '精简', balanced: '平衡', detailed: '详细',
    essential: '只保留必要细节', deep: '深入', never: '不使用', sparingly: '少量', freely: '自由使用',
  },
  en: {
    intro: 'Configure Namo’s identity and presentation preferences. These settings never expand permissions, replace approval, or hide failures and unverified results.',
    local: 'Only the authenticated local workbench may edit them. Chat content cannot rewrite the global personality.',
    legacy: 'Assistant settings have never been saved, so upgraded installations keep their previous prompt behavior. Saving or resetting applies from the next run.',
    active: 'Enabled', inactive: 'Legacy behavior', version: 'Version', name: 'Assistant name', role: 'Role', personality: 'Personality description',
    language: 'Default language', replyLength: 'Reply length', conclusion: 'Outcome first', detail: 'Technical detail', emoji: 'Emoji use',
    profile: 'Use my profile in answers', profileHelp: 'Off by default. When enabled, name and language are used only in the verified owner’s direct messages; timezone is used only for date/time tasks. Private profiles are never injected into group chats.',
    warning: 'Changes affect later runs only; active runs keep their snapshot. Resumed sessions refresh settings but may retain older context, so use a new workstream when a conflict matters.',
    preview: 'Static preview', previewHelp: 'The preview is local formatting only. It does not call a model or promise actual model output.', previewAction: 'Generate preview',
    save: 'Save assistant settings', saved: 'Assistant settings saved. Later runs adopt the new version; active runs are unchanged.', reset: 'Restore defaults',
    resetTitle: 'Restore default assistant settings?', resetDescription: 'This resets only assistant identity and presentation. Profiles, sessions, tasks, and permissions remain intact.',
    resetDone: 'Defaults restored. Later runs adopt the new version.', draft: 'There is an unsaved draft.', conflict: 'A newer settings version exists. The draft is preserved; discard it or refresh before editing again.',
    reload: 'Discard draft / load saved settings', reloadTitle: 'Discard this draft?', reloadDescription: 'Unsaved changes will be lost.',
    nameHint: 'Up to 60 characters', roleHint: 'Up to 160 characters', personalityHint: 'Up to 1,000 characters. Do not enter passwords, keys, or operational authorization.',
    automatic: 'Follow the current task', chinese: '简体中文', english: 'English', concise: 'Concise', balanced: 'Balanced', detailed: 'Detailed',
    essential: 'Essential detail only', deep: 'Deep', never: 'Never', sparingly: 'Sparingly', freely: 'Freely',
  },
} as const;

const valuesOf = (settings: AssistantPageSettings): AssistantPageValues => ({ ...settings.values });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AssistantPage({ settings, editable, unavailableReason, save, reset, preview, refresh }: AssistantPageProps) {
  const c = getLocale() === 'zh-CN' ? copy.zh : copy.en;
  const [draft, setDraft] = useState(() => valuesOf(settings));
  const [baseVersion, setBaseVersion] = useState(settings.version);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [sample, setSample] = useState('');
  const observed = useRef(settings);
  const conflict = settings.version !== baseVersion;
  const canEdit = editable && !conflict;

  function load(next: AssistantPageSettings) {
    setDraft(valuesOf(next)); setBaseVersion(next.version); setDirty(false); setError(''); setSample('');
  }
  function change(patch: Partial<AssistantPageValues>) {
    setDraft(current => ({ ...current, ...patch })); setDirty(true); setNotice(''); setSample('');
  }
  useEffect(() => {
    if (observed.current !== settings && !dirty && !busy && settings.version >= baseVersion) load(settings);
    observed.current = settings;
  }, [settings, dirty, busy, baseVersion]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function persist() {
    if (!dirty || !canEdit || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await save(baseVersion, draft); load(next); setNotice(c.saved);
      try { await refresh?.(); } catch { /* The save result is authoritative; a later poll may refresh status. */ }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="profiles-page">
    <Flex gap="3" align="center" wrap="wrap">
      <Badge color={settings.active ? 'green' : 'gray'}>{settings.active ? c.active : c.inactive}</Badge>
      <Text size="2" color="gray">{c.version} {settings.version}</Text>
    </Flex>
    <Text as="p" size="2" color="gray">{c.intro}</Text>
    <Text as="p" size="1" color="gray">{c.local}</Text>
    {!settings.active && <Notice>{c.legacy}</Notice>}
    {!editable && <Notice error>{unavailableReason || c.local}</Notice>}
    {conflict && <Notice>{c.conflict}</Notice>}
    {dirty && <Text as="p" size="1" color="gray">{c.draft}</Text>}
    {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}

    <form onSubmit={event => { event.preventDefault(); void persist(); }}>
      <fieldset disabled={!canEdit || busy}>
        <div className="form-grid">
          <Field label={c.name} htmlFor="assistant-name"><TextField.Root id="assistant-name" value={draft.name} maxLength={60}
            onChange={event => change({ name: event.target.value })} /><Text size="1" color="gray">{c.nameHint}</Text></Field>
          <Field label={c.role} htmlFor="assistant-role"><TextField.Root id="assistant-role" value={draft.role} maxLength={160}
            onChange={event => change({ role: event.target.value })} /><Text size="1" color="gray">{c.roleHint}</Text></Field>
        </div>
        <Field label={c.personality} htmlFor="assistant-personality"><TextArea id="assistant-personality" value={draft.personality} maxLength={1000} rows={5}
          onChange={event => change({ personality: event.target.value })} /><Text size="1" color="gray">{c.personalityHint}</Text></Field>
        <div className="form-grid">
          <Field label={c.language} htmlFor="assistant-language"><Choice id="assistant-language" value={draft.defaultLanguage}
            onChange={value => change({ defaultLanguage: value as AssistantPageValues['defaultLanguage'] })}
            options={[{ value: 'auto', label: c.automatic }, { value: 'zh-CN', label: c.chinese }, { value: 'en-US', label: c.english }]} /></Field>
          <Field label={c.replyLength} htmlFor="assistant-length"><Choice id="assistant-length" value={draft.replyLength}
            onChange={value => change({ replyLength: value as AssistantPageValues['replyLength'] })}
            options={[{ value: 'concise', label: c.concise }, { value: 'balanced', label: c.balanced }, { value: 'detailed', label: c.detailed }]} /></Field>
          <Field label={c.detail} htmlFor="assistant-detail"><Choice id="assistant-detail" value={draft.technicalDetail}
            onChange={value => change({ technicalDetail: value as AssistantPageValues['technicalDetail'] })}
            options={[{ value: 'essential', label: c.essential }, { value: 'balanced', label: c.balanced }, { value: 'deep', label: c.deep }]} /></Field>
          <Field label={c.emoji} htmlFor="assistant-emoji"><Choice id="assistant-emoji" value={draft.emoji}
            onChange={value => change({ emoji: value as AssistantPageValues['emoji'] })}
            options={[{ value: 'never', label: c.never }, { value: 'sparingly', label: c.sparingly }, { value: 'freely', label: c.freely }]} /></Field>
        </div>
        <Flex direction="column" gap="4" my="4">
          <Text as="label" size="2" weight="medium"><Flex gap="3" align="center"><Switch checked={draft.conclusionFirst}
            onCheckedChange={checked => change({ conclusionFirst: checked })} />{c.conclusion}</Flex></Text>
          <div><Text as="label" size="2" weight="medium"><Flex gap="3" align="center"><Switch checked={draft.useProfile}
            onCheckedChange={checked => change({ useProfile: checked })} />{c.profile}</Flex></Text>
            <Text as="p" size="1" color="gray">{c.profileHelp}</Text></div>
        </Flex>
      </fieldset>
      <Notice>{c.warning}</Notice>
      <Flex gap="3" wrap="wrap" align="center" className="save-bar">
        <ConfirmButton disabled={busy || !dirty} title={c.reloadTitle} description={c.reloadDescription} action={c.reload} onConfirm={async () => {
          load(settings); setNotice('');
        }}>{c.reload}</ConfirmButton>
        <Button type="submit" disabled={!dirty || !canEdit} loading={busy}>{c.save}</Button>
        <ConfirmButton disabled={busy || dirty || !editable} title={c.resetTitle} description={c.resetDescription} action={c.reset} onConfirm={async () => {
          const next = await reset(settings.version); load(next); setNotice(c.resetDone); try { await refresh?.(); } catch { /* Keep returned state. */ }
        }}>{c.reset}</ConfirmButton>
      </Flex>
    </form>

    <section className="audit">
      <Heading as="h2" size="4">{c.preview}</Heading>
      <Text as="p" size="1" color="gray">{c.previewHelp}</Text>
      <Button type="button" variant="soft" disabled={busy} onClick={async () => {
        setError(''); try { setSample(await preview(draft)); } catch (failure) { setError(errorMessage(failure)); }
      }}>{c.previewAction}</Button>
      {sample && <TextArea mt="3" value={sample} readOnly rows={5} aria-label={c.preview} />}
    </section>
  </div>;
}
