import { SectionHeading } from '../components/PageSection';
import { useEffect, useRef, useState } from 'react';
import { Button, Flex, RadioCards, Text, TextArea, TextField } from '@radix-ui/themes';
import { getLocale, t as tr } from '../i18n';
import { Icon } from '../Icon';
import { SettingToggle } from '../components/SettingToggle';
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
  const active = baseVersion > 0;

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
    if ((!dirty && active) || !canEdit || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await save(baseVersion, draft); load(next); setNotice(c.saved);
      try { await refresh?.(); } catch { /* The save result is authoritative; a later poll may refresh status. */ }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <div className="profiles-page assistant-settings">
    <div className="assistant-state">
      <span className="assistant-state-icon"><Icon name={active ? 'check' : 'settings'} size={21} /></span>
      <div><Text as="p" size="2" weight="medium">{active ? c.active : c.inactive}</Text>
        <Text as="p" size="2" color="gray">{active ? tr('assistant.activeHelp') : c.legacy}</Text></div>
    </div>
    {!editable && <Notice error>{unavailableReason || c.local}</Notice>}
    {conflict && <Notice>{c.conflict}</Notice>}
    {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}

    <form onSubmit={event => { event.preventDefault(); void persist(); }}>
      <fieldset disabled={!canEdit || busy}>
        <section className="assistant-section" aria-labelledby="assistant-identity-title">
          <SectionHeading icon="assistant" id="assistant-identity-title" title={tr('assistant.identityTitle')} description={tr('assistant.identityHelp')} />
          <div className="form-grid">
            <Field label={c.name} htmlFor="assistant-name"><TextField.Root id="assistant-name" value={draft.name} maxLength={60}
              onChange={event => change({ name: event.target.value })} /><Text size="1" color="gray">{c.nameHint}</Text></Field>
            <Field label={c.role} htmlFor="assistant-role"><TextField.Root id="assistant-role" value={draft.role} maxLength={160}
              onChange={event => change({ role: event.target.value })} /><Text size="1" color="gray">{c.roleHint}</Text></Field>
          </div>
          <Field label={c.personality} htmlFor="assistant-personality"><TextArea id="assistant-personality" value={draft.personality} maxLength={1000} rows={3}
            onChange={event => change({ personality: event.target.value })} /><Text size="1" color="gray">{c.personalityHint}</Text></Field>
        </section>
        <section className="assistant-section" aria-labelledby="assistant-style-title">
          <SectionHeading icon="sessions" id="assistant-style-title" title={tr('assistant.styleTitle')} description={tr('assistant.styleHelp')} />
          <div className="form-grid">
            <Field label={c.language} htmlFor="assistant-language"><Choice id="assistant-language" value={draft.defaultLanguage}
              onChange={value => change({ defaultLanguage: value as AssistantPageValues['defaultLanguage'] })}
              options={[{ value: 'auto', label: c.automatic }, { value: 'zh-CN', label: c.chinese }, { value: 'en-US', label: c.english }]} />
              <Text size="1" color="gray">{tr('assistant.languageHelp')}</Text></Field>
            <Field label={c.emoji} htmlFor="assistant-emoji"><Choice id="assistant-emoji" value={draft.emoji}
              onChange={value => change({ emoji: value as AssistantPageValues['emoji'] })}
              options={[{ value: 'never', label: c.never }, { value: 'sparingly', label: c.sparingly }, { value: 'freely', label: c.freely }]} />
              <Text size="1" color="gray">{tr('assistant.emojiHelp')}</Text></Field>
          </div>
          <div className="assistant-choice-group">
            <Text as="p" size="2" weight="medium" id="assistant-length-label">{c.replyLength}</Text>
            <RadioCards.Root className="assistant-choices" aria-labelledby="assistant-length-label" value={draft.replyLength} disabled={!canEdit || busy}
              onValueChange={value => change({ replyLength: value as AssistantPageValues['replyLength'] })}>
              {([{value:'concise',label:c.concise,description:tr('assistant.conciseHelp')},{value:'balanced',label:c.balanced,description:tr('assistant.balancedLengthHelp')},
                {value:'detailed',label:c.detailed,description:tr('assistant.detailedHelp')}] as const).map(option => <RadioCards.Item key={option.value} value={option.value}>
                <span className="assistant-choice-copy"><strong>{option.label}</strong><span>{option.description}</span></span>
              </RadioCards.Item>)}
            </RadioCards.Root>
          </div>
          <div className="assistant-choice-group">
            <Text as="p" size="2" weight="medium" id="assistant-detail-label">{c.detail}</Text>
            <RadioCards.Root className="assistant-choices" aria-labelledby="assistant-detail-label" value={draft.technicalDetail} disabled={!canEdit || busy}
              onValueChange={value => change({ technicalDetail: value as AssistantPageValues['technicalDetail'] })}>
              {([{value:'essential',label:c.essential,description:tr('assistant.essentialHelp')},{value:'balanced',label:c.balanced,description:tr('assistant.balancedDetailHelp')},
                {value:'deep',label:c.deep,description:tr('assistant.deepHelp')}] as const).map(option => <RadioCards.Item key={option.value} value={option.value}>
                <span className="assistant-choice-copy"><strong>{option.label}</strong><span>{option.description}</span></span>
              </RadioCards.Item>)}
            </RadioCards.Root>
          </div>
          <div className="setting-options">
            <SettingToggle icon="tasks" title={c.conclusion} description={tr('assistant.conclusionHelp')} checked={draft.conclusionFirst}
              disabled={!canEdit || busy} onChange={checked => change({ conclusionFirst: checked })} />
            <SettingToggle icon="profiles" title={c.profile} description={c.profileHelp} checked={draft.useProfile}
              disabled={!canEdit || busy} onChange={checked => change({ useProfile: checked })} />
          </div>
        </section>
      </fieldset>
      <details className="assistant-help"><summary>{tr('assistant.scopeTitle')}</summary>
        <Text as="p" size="2" color="gray">{c.intro}</Text>
        <Text as="p" size="2" color="gray">{c.local}</Text>
        <Text as="p" size="2" color="gray">{c.warning}</Text>
      </details>
      <Flex gap="3" wrap="wrap" align="center" className="save-bar assistant-save-bar" data-dirty={dirty}>
        <Text as="p" size="2" color="gray">{dirty ? c.draft : tr('assistant.saveHelp')}</Text>
        <Button type="submit" disabled={(!dirty && active) || !canEdit} loading={busy}><Icon name="save" />{active ? c.save : tr('assistant.enable')}</Button>
        {dirty && <ConfirmButton disabled={busy} title={c.reloadTitle} description={c.reloadDescription} action={c.reload} onConfirm={async () => {
          load(settings); setNotice('');
        }}>{c.reload}</ConfirmButton>}
        <ConfirmButton disabled={busy || dirty || !editable} title={c.resetTitle} description={c.resetDescription} action={c.reset} onConfirm={async () => {
          const next = await reset(settings.version); load(next); setNotice(c.resetDone); try { await refresh?.(); } catch { /* Keep returned state. */ }
        }}>{c.reset}</ConfirmButton>
      </Flex>
    </form>

    <details className="assistant-help assistant-preview">
      <summary>{c.preview}</summary>
      <Text as="p" size="2" color="gray">{c.previewHelp}</Text>
      <Button type="button" variant="soft" disabled={busy} onClick={async () => {
        setError(''); try { setSample(await preview({ ...draft, defaultLanguage: draft.defaultLanguage === 'auto' ? (getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US') : draft.defaultLanguage })); } catch (failure) { setError(errorMessage(failure)); }
      }}>{c.previewAction}</Button>
      {sample && <TextArea mt="3" value={sample} readOnly rows={5} aria-label={c.preview} />}
    </details>
  </div>;
}
