import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Code, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { AgentAdapter, AgentProfileSpecView, AgentRegistryPatch, ConfigView } from '../../src/ui-contract';
import { api, ApiError, message } from '../api';
import { Choice, ConfirmButton, Field, Notice } from '../components';
import { Icon } from '../Icon';
import { t as tr } from '../i18n';

interface ProfileRow extends AgentProfileSpecView { key: string; id: string }
interface Draft { defaultProfile: string; profiles: ProfileRow[] }
const adapters: {value:AgentAdapter;label:string}[] = [
  {value:'codex',label:'Codex'}, {value:'claude',label:'Claude Code'}, {value:'cursor',label:'Cursor'},
];
const fromConfig = (config:ConfigView):Draft => ({defaultProfile:config.agents.defaultProfile,
  profiles:Object.entries(config.agents.specs).map(([id,spec])=>({key:crypto.randomUUID(),id,...spec}))});
const saveAgents = (revision:string,patch:AgentRegistryPatch) =>
  (api.save as unknown as (revision:string,patch:AgentRegistryPatch)=>Promise<ConfigView>)(revision,patch);
const quote = (value:string) => "'"+value.split("'").join("'\"'\"'")+"'";

export function AgentRegistrySettings({config,refresh,expired}:{
  config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean;
}) {
  const [draft,setDraft]=useState(()=>fromConfig(config)),[revision,setRevision]=useState(config.revision),[knownRevision,setKnownRevision]=useState(config.revision);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[authExpired,setAuthExpired]=useState(false),[saveConflict,setSaveConflict]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const observedRevision=useRef(config.revision),conflict=saveConflict||(dirty&&revision!==knownRevision),locked=expired||authExpired;
  const defaultOptions=[{value:'codex',label:'codex · Codex'},...draft.profiles.filter(profile=>profile.enabled!==false&&profile.adapter==='codex'&&profile.id)
    .map(profile=>({value:profile.id,label:`${profile.id} · Codex`}))];

  function load(next:ConfigView) {
    setDraft(fromConfig(next));setRevision(next.revision);setKnownRevision(next.revision);setDirty(false);setSaveConflict(false);setError('');
  }
  function edit(update:(current:Draft)=>Draft) {setDraft(update);setDirty(true);setError('');setNotice('');}
  function editProfile(key:string,patch:Partial<ProfileRow>) {edit(current=>{
    const previous=current.profiles.find(profile=>profile.key===key),profiles=current.profiles.map(profile=>profile.key===key?{...profile,...patch}:profile);
    return {...current,profiles,defaultProfile:patch.id!==undefined&&previous&&current.defaultProfile===previous.id?patch.id:current.defaultProfile};
  });}
  useEffect(()=>{
    if(observedRevision.current!==config.revision){setKnownRevision(config.revision);if(!dirty&&!busy)load(config);observedRevision.current=config.revision;}
  },[config,dirty,busy]);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);

  async function handleFailure(failure:unknown) {
    setError(message(failure));
    if(failure instanceof ApiError&&failure.status===401){setAuthExpired(true);try{await refresh();}catch{/* Parent marks the expired workbench session. */}}
    else if(failure instanceof ApiError&&failure.status===409){setSaveConflict(true);try{await refresh();}catch{/* Preserve the registry draft on refresh failure. */}}
  }
  function patch():AgentRegistryPatch {
    const profiles:Record<string,AgentProfileSpecView>={};
    for(const row of draft.profiles){
      const id=row.id.trim();
      if(!/^[a-z][a-z0-9_-]{0,47}$/.test(id)||['codex','constructor','prototype','__proto__'].includes(id))throw Error(tr("agentProfiles.profileIdsMustStartLowercaseLetterContain"));
      if(Object.hasOwn(profiles,id))throw Error(tr("agentProfiles.profileIdsMustUnique"));
      const bin=row.bin?.trim(),model=row.model?.trim();
      profiles[id]={adapter:row.adapter,enabled:row.enabled!==false,...(bin?{bin}:{}),...(model?{model}:{}),...(row.timeoutMs!==undefined?{timeoutMs:row.timeoutMs}:{})};
    }
    if(draft.defaultProfile!=='codex'){
      const selected=profiles[draft.defaultProfile];
      if(!selected||selected.enabled===false||selected.adapter!=='codex')throw Error(tr("agentProfiles.chooseEnabledCodexProfileAvailableRuntimeAdapter"));
    }
    return {agents:{defaultProfile:draft.defaultProfile,memoryProfile:'codex',profiles}};
  }
  async function save() {
    if(!dirty||busy||locked||conflict)return;
    let value:AgentRegistryPatch;try{value=patch();}catch(failure){setError(message(failure));return;}
    setBusy(true);setError('');setNotice('');
    try{
      const saved=await saveAgents(revision,value);load(saved);
      setNotice(tr("agentProfiles.agentProfilesWereSavedButReceiverWas"));
      try{await refresh();}catch(failure){if(failure instanceof ApiError&&failure.status===401)await handleFailure(failure);}
    }catch(failure){await handleFailure(failure);}finally{setBusy(false);}
  }

  return <section className="form-section profiles-page" aria-labelledby="agent-registry-title">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Heading as="h2" size="5" id="agent-registry-title">{tr("agentProfiles.agentProfiles")}</Heading>
      <Badge color="orange">R7.1 · Codex</Badge>
    </Flex>
    <Text as="p" size="2" color="gray">{tr("agentProfiles.installedMeansCommandWasFoundProtocolCompatibility")}</Text>
    <Text as="p" size="1" color="gray">{tr("agentProfiles.memoryProcessingAlwaysUsesBuiltCodexProfile")}</Text>
    {conflict&&<Notice>{tr("agentProfiles.agentProfilesChangedElsewhereDraftPreservedReview")}</Notice>}
    {locked&&<Notice error>{tr("agentProfiles.localAuthorizationExpiredReopenWorkbenchEditingAgent")}</Notice>}
    {error&&<Notice error>{error}</Notice>}{notice&&<Notice>{notice}</Notice>}

    <div className="audit">
      {config.agents.profiles.map(profile=><div key={profile.id}>
        <Flex align="center" gap="2" wrap="wrap"><Text weight="medium" size="2">{profile.id}</Text><Badge>{profile.adapter}</Badge>
          <Badge color={!profile.enabled?'gray':profile.available?'green':'orange'}>{!profile.enabled?tr("status.disabled"):profile.available?tr("agentProfiles.runtimeAdapterAvailableSignCheckedSeparately"):tr("common.comingLaterRelease")}</Badge>
          {profile.id===config.agents.defaultProfile&&<Badge color="blue">{tr("common.default")}</Badge>}
        </Flex>
        <Text as="p" size="1" color="gray">{profile.bin} · {tr("common.isolatedDirectory")} {profile.home}</Text>
        <Text as="p" size="1" color="gray"><Code variant="ghost">namo agent probe --profile {quote(profile.id)} --config {quote(config.file)}</Code></Text>
        {profile.adapter==='codex'?<Text as="p" size="1" color="gray"><Code variant="ghost">namo login --profile {quote(profile.id)} --config {quote(config.file)}</Code></Text>
          :<Text as="p" size="1" color="gray">{tr("agentProfiles.releaseNotProvideLoginCommandAdapterProbe")}</Text>}
      </div>)}
    </div>

    <form onSubmit={event=>{event.preventDefault();void save();}}>
      <fieldset disabled={busy||locked}>
        <Field label={tr("agentProfiles.defaultProfileNewWorkstreams")} htmlFor="agent-default-profile"><Choice id="agent-default-profile" value={draft.defaultProfile}
          options={defaultOptions} disabled={busy||locked} onChange={value=>edit(current=>({...current,defaultProfile:value}))}/></Field>
        <Text as="p" size="1" color="gray">{tr("agentProfiles.savingNotMigrateExistingWorkstreamsQueuedWaiting")}</Text>
        <Heading as="h3" size="3" mt="5">{tr("agentProfiles.customProfiles")}</Heading>
        {!draft.profiles.length&&<Text as="p" size="2" color="gray">{tr("agentProfiles.noCustomProfilesYetYouCanSave")}</Text>}
        {draft.profiles.map((profile,index)=><div className="profile-account" key={profile.key}>
          <Flex align="end" gap="3" wrap="wrap">
            <Field label={tr("agentProfiles.profileId")} htmlFor={`agent-profile-id-${index}`}><TextField.Root id={`agent-profile-id-${index}`} value={profile.id} maxLength={48}
              placeholder="team-codex" onChange={event=>editProfile(profile.key,{id:event.target.value})}/></Field>
            <Field label={tr("agentProfiles.adapter")} htmlFor={`agent-profile-adapter-${index}`}><Choice id={`agent-profile-adapter-${index}`} value={profile.adapter}
              options={adapters} onChange={value=>editProfile(profile.key,{adapter:value as AgentAdapter})}/></Field>
            <Text as="label" size="2"><Flex align="center" gap="2"><Checkbox checked={profile.enabled!==false}
              onCheckedChange={checked=>editProfile(profile.key,{enabled:checked===true})}/>{tr("common.enabled")}</Flex></Text>
            <Button type="button" variant="soft" color="red" onClick={()=>edit(current=>{
              const profiles=current.profiles.filter(item=>item.key!==profile.key);
              return {...current,profiles,defaultProfile:current.defaultProfile===profile.id?'codex':current.defaultProfile};
            })}><Icon name="trash" />{tr("common.remove")}</Button>
          </Flex>
          <div className="form-grid">
            <Field label={tr("agentProfiles.commandFullPathLeaveBlankAdapterDefault")} htmlFor={`agent-profile-bin-${index}`}><TextField.Root id={`agent-profile-bin-${index}`}
              value={profile.bin??''} maxLength={4096} autoComplete="off" onChange={event=>editProfile(profile.key,{bin:event.target.value})}/></Field>
            <Field label={tr("agentProfiles.modelLeaveBlankAdapterDefault")} htmlFor={`agent-profile-model-${index}`}><TextField.Root id={`agent-profile-model-${index}`}
              value={profile.model??''} maxLength={4096} autoComplete="off" onChange={event=>editProfile(profile.key,{model:event.target.value})}/></Field>
          </div>
          {profile.adapter!=='codex'&&<Text as="p" size="1" color="orange">{tr("agentProfiles.adapterSupportsPreregistrationReadProbesCannotExecute")}</Text>}
        </div>)}
        <Button type="button" variant="soft" onClick={()=>edit(current=>({...current,profiles:[...current.profiles,
          {key:crypto.randomUUID(),id:'',adapter:'codex',enabled:true}]}))}><Icon name="plus" />{tr("agentProfiles.addAgentProfile")}</Button>
      </fieldset>
      <Flex gap="3" mt="5" wrap="wrap" align="center">
        <Button type="submit" loading={busy} disabled={!dirty||locked||conflict}><Icon name="save" />{tr("agentProfiles.saveAgentProfiles")}</Button>
        <ConfirmButton title={tr("agentProfiles.reloadAgentProfiles")} description={tr("agentProfiles.currentAgentDraftDiscarded")} action={tr("common.reload")} disabled={busy||locked}
          onConfirm={async()=>{setBusy(true);try{const latest=await api.state();load(latest.config);setNotice('');await refresh();}
            catch(failure){await handleFailure(failure);throw failure;}finally{setBusy(false);}}}><Icon name="reset" />{tr("common.reload")}</ConfirmButton>
        {dirty&&<Text size="1" color="gray">{tr("common.unsavedChanges")}</Text>}
      </Flex>
    </form>
  </section>;
}
