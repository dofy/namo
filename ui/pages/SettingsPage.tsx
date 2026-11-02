import { t as tr, type MessageKey } from '../i18n';
import { Icon, type IconName } from '../Icon';
import { useEffect, useRef, useState } from 'react';
import { Button, Text, TextArea, TextField } from '@radix-ui/themes';
import type { ConfigValues, ConfigView, ProfileState } from '../../src/ui-contract';
import { api, message } from '../api';
import { ConfirmButton, Field, Notice } from '../components';
import { PageSection } from '../components/PageSection';
import { SettingToggle } from '../components/SettingToggle';
import { ModelSelect } from '../components/ModelSelect';
import { CodexUpdatePanel } from '../components/CodexUpdatePanel';

type MessageOption = 'requireMention' | 'cards' | 'reactions' | 'progressUpdates';
const messageOptions: { key: MessageOption; icon: IconName; title: MessageKey; description: MessageKey }[] = [
  { key: 'requireMention', icon: 'mention', title: 'settings.messageMentionsTitle', description: 'settings.messageMentionsDescription' },
  { key: 'cards', icon: 'cards', title: 'settings.messageCardsTitle', description: 'settings.messageCardsDescription' },
  { key: 'reactions', icon: 'reaction', title: 'settings.messageReactionsTitle', description: 'settings.messageReactionsDescription' },
  { key: 'progressUpdates', icon: 'activity', title: 'settings.messageProgressTitle', description: 'settings.messageProgressDescription' },
];

interface Draft extends Omit<ConfigValues, 'directories' | 'readPaths' | 'denyPaths' | 'timeoutMs' | 'concurrency' | 'progressDelayMs' | 'progressIntervalMs' | 'progressHeartbeatMs'> {
  directories:string; readPaths:string; denyPaths:string; timeoutSeconds:string; concurrency:string; newSecret:string;
  progressDelayMs:string;progressIntervalMs:string;progressHeartbeatMs:string;
}
function fromConfig(config:ConfigView):Draft {
  const v=config.values;
  return {...v,directories:(v.directories??[]).join('\n'),readPaths:'',denyPaths:v.denyPaths.join('\n'),
    timeoutSeconds:String(v.timeoutMs/1000),concurrency:String(v.concurrency),newSecret:'',
    progressDelayMs:String(v.progressDelayMs??200),progressIntervalMs:String(v.progressIntervalMs??5000),progressHeartbeatMs:String(v.progressHeartbeatMs??30000)};
}
function toPatch(draft:Draft):ConfigValues&{newSecret:string} {
  const {timeoutSeconds,...values}=draft;
  return {...values,directories:draft.directories.split('\n').map(x=>x.trim()).filter(Boolean),
    sandbox:'workspace-write',allowLocalCommits:true,readPaths:[],denyPaths:draft.denyPaths.split('\n').map(x=>x.trim()).filter(Boolean),
    concurrency:Number(draft.concurrency),timeoutMs:Number(timeoutSeconds)*1000,
    progressDelayMs:Number(draft.progressDelayMs),progressIntervalMs:Number(draft.progressIntervalMs),progressHeartbeatMs:Number(draft.progressHeartbeatMs)};
}
export function SettingsPage({ config, recoveryAvailable, refresh, notify }: {
  config: ConfigView; profiles?:ProfileState; recoveryAvailable: boolean; refresh: () => Promise<unknown>; notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const observedRevision = useRef(config.revision);
  function reset(value: ConfigView) { setDraft(fromConfig(value)); setRevision(value.revision); setDirty(false); setError(''); }
  useEffect(() => {
    // A completed save may precede a failed status refresh. Do not replace the
    // saved form with a cached, older parent projection when saving finishes.
    if (!dirty && !saving && observedRevision.current !== config.revision && revision !== config.revision) reset(config);
    observedRevision.current = config.revision;
  }, [config, dirty, saving, revision]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(d => ({ ...d, [key]: value })); setDirty(true); }
  return <div className="settings-page"><form onSubmit={async event => {
    event.preventDefault(); if (saving) return; setSaving(true); setError('');
    try { const saved = await api.save(revision, toPatch(draft)); reset(saved); notify(tr("settings.configurationSavedPreviousValuesBackedUpApply")); await refresh(); }
    catch (e) { setError(message(e)); } finally { setSaving(false); }
  }}>
    {error && <Notice error>{error}</Notice>}
    {!config.valid && <Notice>{tr("common.configurationValidationFailedCheckDirectoriesPermissions")}</Notice>}
    {dirty && revision !== config.revision && <Notice>{tr("settings.configurationChangedAnotherPageProgramDraftPreserved")}</Notice>}
    <fieldset disabled={saving}>
      <PageSection icon="settings" title={tr('directories.title')} description={tr('directories.help')}>
        <Field label={tr('directories.paths')} htmlFor="directories"><TextArea id="directories" rows={6} value={draft.directories} onChange={e=>edit('directories',e.target.value)}/></Field>
        <Text as="p" size="1" color="gray">{tr('settings.serviceConfigurationDataLoginDirectoriesRemainExcluded')}</Text>
      </PageSection>
      <PageSection icon="connections" title={tr('settings.executionPermissions')}>
        <SettingToggle icon="connections" title={tr('settings.allowNetworkAccessCommands')} description={tr('design.network')} checked={draft.networkAccess!==false} disabled={saving} onChange={value=>edit('networkAccess',value)}/>
      </PageSection>
      <PageSection icon="play" title={tr("settings.executionSettings")} description={tr("design.execution")}><div className="form-grid">
        <div><ModelSelect id="model" label={tr('model.serviceDefault')} value={draft.model} onChange={value=>edit('model',value)} disabled={saving} inheritLabel={tr('model.codexDefault')} resetKey={revision} />
          <Text as="p" size="1" color="gray">{tr('model.serviceHelp')}</Text></div>
        <Field label={tr("settings.codexCommandFullPath")} htmlFor="bin"><TextField.Root id="bin" required value={draft.bin} onChange={e => edit('bin', e.target.value)} /></Field>
        <Field label={tr("settings.maximumConcurrentTasks")} htmlFor="concurrency"><TextField.Root id="concurrency" type="number" min="4" max="64" required value={draft.concurrency} onChange={e => edit('concurrency', e.target.value)} /></Field>
        <Field label={tr("settings.executionTimeoutSeconds")} htmlFor="timeout"><TextField.Root id="timeout" type="number" min="1" max="7200" required value={draft.timeoutSeconds} onChange={e => edit('timeoutSeconds', e.target.value)} /></Field>
      </div></PageSection>
      <PageSection icon="sessions" title={tr("settings.feishuMessages")} description={tr("design.messages")}>
        <div className="setting-options">{messageOptions.map(option => <SettingToggle key={option.key}
          icon={option.icon} title={tr(option.title)} description={tr(option.description)} checked={draft[option.key] !== false}
          disabled={saving} onChange={value => edit(option.key, value)} />)}</div>
        <details><summary>{tr("design.progressTiming")}</summary><div className="form-grid">
          <Field label={tr("settings.initialProgressNoticeDelayMs")} htmlFor="progress-delay"><TextField.Root id="progress-delay" type="number" min="0" max="120000" required value={draft.progressDelayMs} onChange={e=>edit('progressDelayMs',e.target.value)} /></Field>
          <Field label={tr("settings.minimumProgressUpdateIntervalMs")} htmlFor="progress-interval"><TextField.Root id="progress-interval" type="number" min="5000" max="60000" required value={draft.progressIntervalMs} onChange={e=>edit('progressIntervalMs',e.target.value)} /></Field>
          <Field label={tr("settings.progressHeartbeatIntervalMs")} htmlFor="progress-heartbeat"><TextField.Root id="progress-heartbeat" type="number" min="30000" max="300000" required value={draft.progressHeartbeatMs} onChange={e=>edit('progressHeartbeatMs',e.target.value)} /></Field>
        </div>
        <Text as="p" size="1" color="gray">{tr("settings.progressUpdatesOffRoutineProcessingNoticesNot")}</Text></details>
        <Text as="p" size="1" color="gray">{tr("settings.enablingButtonsSubscribeCardActionTriggerFeishu")}</Text>
        <details><summary>{tr("settings.updateAppSecret")}</summary>
          <Field label={tr("settings.newSecretBlankKeepExisting")} htmlFor="new-secret"><TextField.Root id="new-secret" type="password" autoComplete="new-password" maxLength={256} value={draft.newSecret} onChange={e => edit('newSecret', e.target.value)} /></Field>
          <Text as="p" size="1" color="gray">{tr("settings.writtenLocalConfigurationPageNeverReadsDisplays")}</Text>
        </details>
      </PageSection>
    </fieldset>
    <div className="save-bar" data-dirty={dirty}><Text as="p" size="2" color="gray">{dirty ? tr("common.unsavedChanges") : tr(config.automaticConfiguration?'settings.automaticConfiguration':'settings.applySavedConfigurationUpdateService')}</Text>
      {dirty && <ConfirmButton title={tr("settings.discardUnsavedChanges")} description={tr("settings.loadSavedConfigurationDiscardUnsavedDraft")} action={tr("settings.discardChanges")} disabled={saving}
        onConfirm={async () => { const latest = await api.state(); reset(latest.config); await refresh(); }}><Icon name="reset" />{tr("settings.discardChanges")}</ConfirmButton>}
      <Button type="submit" loading={saving}><Icon name="save" />{tr("settings.saveConfiguration")}</Button>
      {!config.automaticConfiguration&&<ConfirmButton title={tr("settings.confirmApplyConfiguration")} description={tr("settings.restartReceiverItsQueueIdleExistingConfiguration")} action={tr("settings.confirmApply")}
        disabled={dirty || saving || !recoveryAvailable} onConfirm={async () => { const result = await api.apply(revision); notify(result.message, !result.ready); await refresh(); }}><Icon name="play" />{tr("settings.applyConfiguration")}</ConfirmButton>}
    </div>
  </form>
    <CodexUpdatePanel configRevision={config.revision} disabled={dirty || saving || !config.valid} pendingApplication={config.application==='pending'} />
  </div>;
}
