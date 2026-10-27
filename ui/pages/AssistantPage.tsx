import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Flex, Heading, Switch, Text, TextArea, TextField } from '@radix-ui/themes';
import { t as tr } from '../i18n';
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

const copy = () => ({
  intro: tr("assistant.intro"),
  local: tr("assistant.local"),
  legacy: tr("assistant.legacy"),
  active: tr("assistant.active"),
  inactive: tr("assistant.inactive"),
  version: tr("assistant.version"),
  name: tr("assistant.name"),
  role: tr("assistant.role"),
  personality: tr("assistant.personality"),
  language: tr("assistant.language"),
  replyLength: tr("assistant.replyLength"),
  conclusion: tr("assistant.conclusion"),
  detail: tr("assistant.detail"),
  emoji: tr("assistant.emoji"),
  profile: tr("assistant.profile"),
  profileHelp: tr("assistant.profileHelp"),
  warning: tr("assistant.warning"),
  preview: tr("assistant.preview"),
  previewHelp: tr("assistant.previewHelp"),
  previewAction: tr("assistant.previewAction"),
  save: tr("assistant.save"),
  saved: tr("assistant.saved"),
  reset: tr("assistant.reset"),
  resetTitle: tr("assistant.resetTitle"),
  resetDescription: tr("assistant.resetDescription"),
  resetDone: tr("assistant.resetDone"),
  draft: tr("assistant.draft"),
  conflict: tr("assistant.conflict"),
  reload: tr("assistant.reload"),
  reloadTitle: tr("assistant.reloadTitle"),
  reloadDescription: tr("assistant.reloadDescription"),
  nameHint: tr("assistant.nameHint"),
  roleHint: tr("assistant.roleHint"),
  personalityHint: tr("assistant.personalityHint"),
  automatic: tr("assistant.automatic"),
  chinese: tr("assistant.chinese"),
  english: tr("assistant.english"),
  concise: tr("assistant.concise"),
  balanced: tr("assistant.balanced"),
  detailed: tr("assistant.detailed"),
  essential: tr("assistant.essential"),
  deep: tr("assistant.deep"),
  never: tr("assistant.never"),
  sparingly: tr("assistant.sparingly"),
  freely: tr("assistant.freely"),
});

const valuesOf = (settings: AssistantPageSettings): AssistantPageValues => ({ ...settings.values });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AssistantPage({ settings, editable, unavailableReason, save, reset, preview, refresh }: AssistantPageProps) {
  const c = copy();
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
