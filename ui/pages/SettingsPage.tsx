import { t as tr, type MessageKey } from '../i18n';
import { Icon, type IconName } from '../Icon';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, Tabs, Text, TextField } from '@radix-ui/themes';
import type { AgentConfigPatch, AgentConnectionView, ConfigValues, ConfigView } from '../../src/ui-contract';
import { api, message } from '../api';
import { Choice, ConfirmButton, Field, Notice } from '../components';
import { PageSection } from '../components/PageSection';
import { SettingToggle } from '../components/SettingToggle';
import { ModelSelect } from '../components/ModelSelect';
import { CodexUpdatePanel } from '../components/CodexUpdatePanel';
import { useToast } from '../Toast';

type MessageOption = 'requireMention' | 'cards' | 'reactions' | 'progressUpdates';
const messageOptions: { key: MessageOption; icon: IconName; title: MessageKey; description: MessageKey }[] = [
  { key: 'requireMention', icon: 'mention', title: 'settings.messageMentionsTitle', description: 'settings.messageMentionsDescription' },
  { key: 'cards', icon: 'cards', title: 'settings.messageCardsTitle', description: 'settings.messageCardsDescription' },
  { key: 'reactions', icon: 'reaction', title: 'settings.messageReactionsTitle', description: 'settings.messageReactionsDescription' },
  { key: 'progressUpdates', icon: 'activity', title: 'settings.messageProgressTitle', description: 'settings.messageProgressDescription' },
];

interface Draft extends Omit<ConfigValues, 'directories' | 'readPaths' | 'denyPaths' | 'timeoutMs' | 'concurrency' | 'progressDelayMs' | 'progressIntervalMs' | 'progressHeartbeatMs'> {
  agentProfile?:string; directories:string[]; readPaths:string; denyPaths:string; timeoutSeconds:string; concurrency:string; newSecret:string;
  progressDelayMs:string;progressIntervalMs:string;progressHeartbeatMs:string;
}
function defaultAgent(config: ConfigView): AgentConnectionView | undefined {
  return config.agentConnections?.profiles.find(agent => agent.id === config.agentConnections?.defaultProfile);
}
function fromConfig(config:ConfigView):Draft {
  const {timeoutMs,...v}=config.values, agent=defaultAgent(config);
  return {...v,agentProfile:agent?.id,bin:agent?.bin??v.bin,directories:v.directories??[],readPaths:'',denyPaths:v.denyPaths.join('\n'),
    timeoutSeconds:String((agent?.timeoutMs??timeoutMs)/1000),concurrency:String(v.concurrency),newSecret:'',
    progressDelayMs:String(v.progressDelayMs??200),progressIntervalMs:String(v.progressIntervalMs??5000),progressHeartbeatMs:String(v.progressHeartbeatMs??30000)};
}
function toPatch(draft:Draft, agent:AgentConnectionView|undefined): Omit<ConfigValues,'bin'|'timeoutMs'> & AgentConfigPatch & {newSecret:string} {
  const {timeoutSeconds,agentProfile,bin,...values}=draft;
  const timeoutMs=Number(timeoutSeconds)*1000;
  const execution=agent && agentProfile===agent.id && (bin!==agent.bin || timeoutMs!==agent.timeoutMs)
    ? {agentExecution:{profile:agentProfile,bin,timeoutMs}} : {};
  return {...values,...execution,directories:draft.directories,
    sandbox:'workspace-write',allowLocalCommits:true,readPaths:[],denyPaths:draft.denyPaths.split('\n').map(x=>x.trim()).filter(Boolean),
    concurrency:Number(draft.concurrency),progressDelayMs:Number(draft.progressDelayMs),
    progressIntervalMs:Number(draft.progressIntervalMs),progressHeartbeatMs:Number(draft.progressHeartbeatMs)};
}

function AgentModelSetting({agent,revision,disabled,refresh,onDirtyChange}:{
  agent:AgentConnectionView;revision:string;disabled:boolean;refresh:()=>Promise<unknown>;onDirtyChange:(dirty:boolean)=>void;
}) {
  const [edit,setEdit]=useState<{base:string;value:string}>();
  const [confirmed,setConfirmed]=useState<{previous:string;value:string}>();
  const [saving,setSaving]=useState(false), toast=useToast();
  useEffect(()=>{
    if(confirmed && agent.model!==confirmed.previous)setConfirmed(undefined);
  },[agent.model,confirmed]);
  const current=confirmed?.previous===agent.model ? confirmed.value : agent.model;
  const value=edit?.value??current;
  const dirty=!!edit && value.trim()!==current;
  useEffect(()=>onDirtyChange(dirty),[dirty,onDirtyChange]);
  function change(value:string) {
    setEdit({base:edit?.base??current,value});
  }
  async function saveModel() {
    if (!dirty || !edit || disabled || saving) return;
    setSaving(true);
    try {
      const saved=await api.saveAgentModel(revision,agent.id,edit.base,value.trim());
      setConfirmed({previous:agent.model,value:saved.model});setEdit(undefined);onDirtyChange(false);
      toast(tr('model.saved'));
      try {await refresh();} catch {toast(tr('settings.savedRefreshFailed'),true);}
    } catch(error) {toast(message(error),true);}
    finally {setSaving(false);}
  }
  const blocked=disabled||saving||!!agent.modelError;
  return <div className="agent-model-field" onKeyDown={event=>{
    if(event.key==='Enter' && event.target instanceof HTMLInputElement){event.preventDefault();if(!blocked)void saveModel();}
  }}>
    {agent.adapter==='codex'
      ? <ModelSelect profile={agent.id} id="agent-model" label={tr('model.agentModel')} value={value} onChange={change} disabled={blocked}
          inheritLabel={tr('model.runtimeDefault')} resetKey={current}/>
      : <Field label={tr('model.agentModel')} htmlFor="agent-model"><TextField.Root id="agent-model" value={value} maxLength={128}
          disabled={blocked} placeholder={tr('model.runtimeDefault')} onChange={event=>change(event.target.value)} /></Field>}
    <Text as="p" size="1" color="gray">{tr('model.agentHelp')}</Text>
    {agent.modelError && <Notice error>{agent.modelError}</Notice>}
    {dirty && edit?.base!==current && <Notice>{tr('settings.configurationChangedAnotherPageProgramDraftPreserved')}</Notice>}
    {dirty && <div className="agent-model-actions">
      <Button type="button" disabled={blocked} loading={saving} onClick={()=>void saveModel()}>{tr('model.save')}</Button>
      <Button type="button" variant="soft" color="gray" disabled={saving} onClick={()=>{setEdit(undefined);onDirtyChange(false);}}>{tr('settings.discardChanges')}</Button>
    </div>}
  </div>;
}
function DirectoryPicker({directories,onChange,onPicking}:{directories:string[];onChange:(value:string[])=>void;onPicking:(value:boolean)=>void}) {
  const [open,setOpen]=useState(false),[path,setPath]=useState<string|undefined>();
  const [listing,setListing]=useState<Awaited<ReturnType<typeof api.directories>>|null>(null);
  const [error,setError]=useState(''),[loading,setLoading]=useState(false),[picking,setPicking]=useState(false),[notice,setNotice]=useState('');
  const nested=directories.some((directory,index)=>directories.some((other,i)=>i!==index&&directory.startsWith(other.endsWith('/')?other:other+'/')));
  function add(directory:string) {
    if(directories.includes(directory)){setNotice(tr('directories.alreadyAdded'));return;}
    setNotice('');onChange([...directories,directory]);
  }
  async function choose() {
    setNotice('');setPicking(true);onPicking(true);
    try {
      const result=await api.chooseDirectory();
      if(result.status==='selected')add(result.path);
      else if(result.status==='unavailable'){setPath(undefined);setOpen(true);}
    } catch(e){setNotice(message(e));}
    finally {setPicking(false);onPicking(false);}
  }
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setLoading(true);setError('');setListing(null);
    api.directories(path,controller.signal).then(setListing).catch(e=>{if(!controller.signal.aborted)setError(message(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[open,path]);
  return <div className="directory-picker">
    <div className="directory-list" aria-label={tr('directories.list')}>
      {directories.length===0?<Text size="2" color="gray">{tr('directories.empty')}</Text>:directories.map((directory,index)=><div className="directory-row" key={`${directory}-${index}`}>
        <span className="directory-path">{directory}</span><Button type="button" variant="soft" color="gray" aria-label={tr('directories.removeNamed',directory)} onClick={()=>onChange(directories.filter((_,i)=>i!==index))}><Icon name="trash"/>{tr('directories.remove')}</Button>
      </div>)}
    </div>
    {nested&&<Notice>{tr('directories.nestedNotice')}</Notice>}
    {notice&&<Notice>{notice}</Notice>}
    <div className="directory-footer"><Text as="p" size="1" color="gray">{tr('settings.serviceConfigurationDataLoginDirectoriesRemainExcluded')}</Text>
      <Button type="button" variant="soft" loading={picking} disabled={picking} onClick={choose}><Icon name="plus"/>{tr('directories.choose')}</Button></div>
    <Dialog.Root open={open} onOpenChange={value=>{setOpen(value);if(value)setPath(undefined);}}>
      <Dialog.Content maxWidth="640px">
        <Dialog.Title>{tr('directories.choose')}</Dialog.Title><Dialog.Description size="2" color="gray">{tr('directories.browseHelp')}</Dialog.Description>
        {listing&&<><div className="directory-location"><Button type="button" variant="soft" color="gray" disabled={!listing.parent||loading} onClick={()=>setPath(listing.parent??undefined)}><Icon name="left"/>{tr('directories.parent')}</Button><span className="directory-path">{listing.path}</span></div>
          <div className="directory-entries">{listing.directories.length===0?<Text size="2" color="gray">{tr('directories.noChildren')}</Text>:listing.directories.map(item=><button type="button" className="directory-entry" key={item.path} onClick={()=>setPath(item.path)}><span>{item.name}</span><Icon name="right"/></button>)}</div></>}
        {loading&&<Text as="p" size="2" color="gray" role="status">{tr('directories.loading')}</Text>}
        {error&&<><Notice error>{error}</Notice><Button type="button" variant="soft" onClick={()=>setPath(undefined)}>{tr('directories.home')}</Button></>}
        <div className="directory-actions"><Button type="button" variant="soft" color="gray" onClick={()=>setOpen(false)}>{tr('common.close')}</Button>
          <Button type="button" disabled={!listing||!listing.selectable||directories.includes(listing.path)} onClick={()=>{if(listing){add(listing.path);setOpen(false);}}}>{listing&&directories.includes(listing.path)?tr('directories.alreadyAdded'):tr('directories.addCurrent')}</Button></div>
      </Dialog.Content>
    </Dialog.Root>
  </div>;
}
export function SettingsPage({ config, expired, recoveryAvailable, refresh, notify, tab, onTabChange, operations }: {
  tab: string; onTabChange: (tab: 'work' | 'feishu') => void; operations: ReactNode;
  config: ConfigView; expired: boolean; recoveryAvailable: boolean; refresh: () => Promise<unknown>; notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [pickingDirectory,setPickingDirectory]=useState(false);
  const toast = useToast();
  const agent = config.agentConnections?.profiles.find(profile=>profile.id===draft.agentProfile) ?? defaultAgent(config);
  const [modelDirty,setModelDirty]=useState(false), [switching,setSwitching]=useState(false);
  const observedRevision = useRef(config.revision);
  const invalidField = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const field = invalidField.current;
    if (!field || field.closest('[hidden]')) return;
    invalidField.current = null;
    field.focus();
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.reportValidity();
  }, [tab]);
  function reset(value: ConfigView) { setDraft(fromConfig(value)); setRevision(value.revision); setDirty(false); }
  useEffect(() => {
    // A completed save may precede a failed status refresh. Do not replace the
    // saved form with a cached, older parent projection when saving finishes.
    if (!dirty && !saving && observedRevision.current !== config.revision && revision !== config.revision) reset(config);
    observedRevision.current = config.revision;
  }, [config, dirty, saving, revision]);
  useEffect(() => {
    if (!dirty && !modelDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty,modelDirty]);
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(d => ({ ...d, [key]: value })); setDirty(true); }
  async function selectDefaultAgent(profile: string) {
    if (dirty||modelDirty||switching||saving||expired) return;
    setSwitching(true);
    try {
      const saved=await api.saveAgents(config.revision,{defaultAgentProfile:profile});reset(saved);
      try {await refresh();} catch {toast(tr('settings.savedRefreshFailed'),true);}
    } catch(error) {toast(message(error),true);}
    finally {setSwitching(false);}
  }
  return <div className="settings-page"><form noValidate hidden={tab !== 'work' && tab !== 'feishu' && !dirty} onSubmit={async event => {
    event.preventDefault(); if (saving||pickingDirectory) return;
    const invalid = event.currentTarget.querySelector<HTMLElement>('input:invalid, textarea:invalid, select:invalid');
    if (invalid) {
      const targetTab = invalid.closest('[data-settings-form=feishu]') ? 'feishu' : 'work';
      if (tab === targetTab) {
        invalid.focus();
        if (invalid instanceof HTMLInputElement || invalid instanceof HTMLTextAreaElement) invalid.reportValidity();
      } else {
        invalidField.current = invalid;
        onTabChange(targetTab);
      }
      return;
    }
    setSaving(true);
    try {
      const saved = await api.save(revision, toPatch(draft,agent)); reset(saved);
      toast(tr("settings.configurationSavedPreviousValuesBackedUpApply"));
      try { await refresh(); } catch { toast(tr("settings.savedRefreshFailed"), true); }
    } catch (e) { toast(message(e), true); } finally { setSaving(false); }
  }}>
    {!config.valid && <Notice>{tr("common.configurationValidationFailedCheckDirectoriesPermissions")}</Notice>}
    {dirty && revision !== config.revision && <Notice>{tr("settings.configurationChangedAnotherPageProgramDraftPreserved")}</Notice>}
    <fieldset disabled={saving||switching||pickingDirectory||expired}>
      <Tabs.Content value="work" forceMount hidden={tab !== 'work'} data-settings-form="work" className="settings-tab-panel"><PageSection icon="settings" title={tr('directories.title')} description={tr(agent?.adapter==='claude'?'directories.claudeHelp':'directories.help')}>
        <DirectoryPicker directories={draft.directories} onChange={value=>edit('directories',value)} onPicking={setPickingDirectory}/>
      </PageSection>
      {agent && <PageSection icon="connections" title={tr('settings.executionPermissions')}>
        <SettingToggle icon="connections" title={tr('settings.allowNetworkAccessCommands')} description={tr('settings.agentNetworkHelp')} checked={draft.networkAccess!==false}
          disabled={saving||switching} onChange={value=>edit('networkAccess',value)}/>
      </PageSection>}
      <PageSection icon="play" title={tr('settings.executionSettings')} description={tr('settings.agentExecutionHelp')}>
        <div className="form-grid">
          {agent && <>
            <Field label={tr('claude.defaultAgent')} htmlFor="default-agent"><Choice id="default-agent" value={draft.agentProfile??agent.id}
              disabled={dirty||modelDirty||saving||switching||expired} options={(config.agentConnections?.profiles??[]).filter(profile=>profile.enabled).map(profile=>({value:profile.id,label:profile.label}))}
              onChange={profile=>void selectDefaultAgent(profile)} /></Field>
            <AgentModelSetting key={agent.id} agent={agent} revision={revision} disabled={saving||switching||expired||config.agentModelEditing===false}
              refresh={refresh} onDirtyChange={setModelDirty}/>
            <Field label={tr('settings.agentCommandPath',agent.label)} htmlFor="bin"><TextField.Root id="bin" required value={draft.bin} onChange={e=>edit('bin',e.target.value)}/></Field>
            <Field label={tr('settings.executionTimeoutSeconds')} htmlFor="timeout"><TextField.Root id="timeout" type="number" min="1" max="7200" required
              value={draft.timeoutSeconds} onChange={e=>edit('timeoutSeconds',e.target.value)}/></Field>
          </>}
          <Field label={tr('settings.maximumConcurrentTasks')} htmlFor="concurrency"><TextField.Root id="concurrency" type="number" min="4" max="64" required value={draft.concurrency} onChange={e=>edit('concurrency',e.target.value)}/></Field>
        </div>
        {config.agentModelEditing===false && <Notice>{tr('model.receiverRequiresUpgrade')}</Notice>}
      </PageSection>
      </Tabs.Content><Tabs.Content value="feishu" forceMount hidden={tab !== 'feishu'} data-settings-form="feishu" className="settings-tab-panel"><PageSection icon="sessions" title={tr("settings.feishuMessages")} description={tr("design.messages")}>
        <div className="setting-options">{messageOptions.map(option => <SettingToggle key={option.key}
          icon={option.icon} title={tr(option.title)} description={tr(option.description)} checked={draft[option.key] !== false}
          disabled={saving} onChange={value => edit(option.key, value)} />)}</div>
        <div className="settings-subsection"><h3>{tr("design.progressTiming")}</h3><div className="form-grid">
          <Field label={tr("settings.initialProgressNoticeDelayMs")} htmlFor="progress-delay"><TextField.Root id="progress-delay" type="number" min="0" max="120000" required value={draft.progressDelayMs} onChange={e=>edit('progressDelayMs',e.target.value)} /></Field>
          <Field label={tr("settings.minimumProgressUpdateIntervalMs")} htmlFor="progress-interval"><TextField.Root id="progress-interval" type="number" min="5000" max="60000" required value={draft.progressIntervalMs} onChange={e=>edit('progressIntervalMs',e.target.value)} /></Field>
          <Field label={tr("settings.progressHeartbeatIntervalMs")} htmlFor="progress-heartbeat"><TextField.Root id="progress-heartbeat" type="number" min="30000" max="300000" required value={draft.progressHeartbeatMs} onChange={e=>edit('progressHeartbeatMs',e.target.value)} /></Field>
        </div>
        <Text as="p" size="1" color="gray">{tr("settings.progressUpdatesOffRoutineProcessingNoticesNot")}</Text></div>
        <Text as="p" size="1" color="gray">{tr("settings.enablingButtonsSubscribeCardActionTriggerFeishu")}</Text>
        <div className="settings-subsection"><h3>{tr("settings.updateAppSecret")}</h3>
          <Field label={tr("settings.newSecretBlankKeepExisting")} htmlFor="new-secret"><TextField.Root id="new-secret" type="password" autoComplete="new-password" maxLength={256} value={draft.newSecret} onChange={e => edit('newSecret', e.target.value)} /></Field>
          <Text as="p" size="1" color="gray">{tr("settings.writtenLocalConfigurationPageNeverReadsDisplays")}</Text>
        </div>
      </PageSection></Tabs.Content>
    </fieldset>
    <div className="save-bar" data-dirty={dirty}><Text as="p" size="2" color="gray">{dirty ? tr("common.unsavedChanges") : tr(config.automaticConfiguration?'settings.automaticConfiguration':'settings.applySavedConfigurationUpdateService')}</Text>
      {dirty && <ConfirmButton title={tr("settings.discardUnsavedChanges")} description={tr("settings.loadSavedConfigurationDiscardUnsavedDraft")} action={tr("settings.discardChanges")} disabled={saving||pickingDirectory}
        onConfirm={async () => { const latest = await api.state(); reset(latest.config); await refresh(); }}><Icon name="reset" />{tr("settings.discardChanges")}</ConfirmButton>}
      <Button type="submit" loading={saving} disabled={pickingDirectory}><Icon name="save" />{tr("settings.saveConfiguration")}</Button>
      {!config.automaticConfiguration&&<ConfirmButton title={tr("settings.confirmApplyConfiguration")} description={tr("settings.restartReceiverItsQueueIdleExistingConfiguration")} action={tr("settings.confirmApply")}
        disabled={dirty || saving || pickingDirectory || !recoveryAvailable} onConfirm={async () => { const result = await api.apply(revision); notify(result.message, !result.ready); await refresh(); }}><Icon name="play" />{tr("settings.applyConfiguration")}</ConfirmButton>}
    </div>
  </form>
    <Tabs.Content value="maintenance" forceMount hidden={tab !== 'maintenance'} className="settings-tab-panel"><CodexUpdatePanel configRevision={config.revision} disabled={dirty || saving || !config.valid} pendingApplication={config.application==='pending'} />{operations}</Tabs.Content>
  </div>;
}
