import { useEffect, useState, useRef } from 'react';
import { Button, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { ConfigView } from '../src/ui-contract';
import type { ProjectAccess } from '../src/access-contract';
import { AudienceFields, emptyAudience, IdentityInput } from './AudienceFields';
import { Choice, Field, Notice } from './components';
import { api, message } from './api';
import { t as tr } from './i18n';

const draftFrom=(c:ConfigView)=>({mode:c.feishu.access?'organization':'selected',tenantKey:c.feishu.access?.tenantKey??'',users:c.feishu.allowedUserIds??[],chats:c.feishu.allowedChatIds??[],projects:c.values.projectAccess??{}});
export function ServiceAccessSettings({config,refresh,expired}:{config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean}) {
  const [draft,setDraft]=useState(()=>draftFrom(config)),[revision,setRevision]=useState(config.revision),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const observedRevision=useRef(config.revision);
  const conflict=dirty&&revision!==config.revision;
  const reset=(c:ConfigView)=>{setDraft(draftFrom(c));setRevision(c.revision);setDirty(false);setError('');};
  useEffect(()=>{if(observedRevision.current!==config.revision){if(!dirty&&!busy)reset(config);observedRevision.current=config.revision;}},[config,dirty,busy]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const edit=(patch:Partial<typeof draft>)=>{setDraft(d=>({...d,...patch}));setDirty(true);setNotice('');};
  const project=(name:string,value:ProjectAccess)=>edit({projects:{...draft.projects,[name]:value}});
  return <section className="form-section"><Heading as="h2" size="5">{tr("serviceAccess.organizationAccessProjectPermissions")}</Heading>
    <Text as="p" size="2" color="gray">{tr("serviceAccess.administratorsConfigureServiceConnectionsMembersNotNeed")}</Text>
    {error&&<Notice error>{error}</Notice>}{notice&&<Notice>{notice}</Notice>}{conflict&&<Notice>{tr("serviceAccess.settingsChangedDraftPreservedReloadEditing")}</Notice>}
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{
      const saved=await api.saveAccess(revision,{serviceAccess:{access:draft.mode==='organization'?{mode:'organization',tenantKey:draft.tenantKey.trim()}:null,allowedUserIds:draft.users,allowedChatIds:draft.chats},projectAccess:draft.projects});reset(saved);setNotice(tr("common.settingsSavedApplyConfigurationActivateOrganizationAccess"));await refresh();
    }catch(e){setError(message(e));}finally{setBusy(false);}}}>
      <fieldset disabled={busy||expired}>
        <Field label={tr("serviceAccess.serviceAudience")} htmlFor="service-mode"><Choice id="service-mode" value={draft.mode} onChange={mode=>edit({mode})} options={[{value:'organization',label:tr("serviceAccess.feishuOrganizationMembers")},{value:'selected',label:tr("serviceAccess.selectedMembersLegacyMode")}]}/></Field>
        {draft.mode==='organization'?<Field label={tr("serviceAccess.feishuTenantKey")} htmlFor="service-tenant">
          <Flex gap="3" align="center" wrap="wrap">
            <TextField.Root id="service-tenant" aria-describedby="service-tenant-help" value={draft.tenantKey} onChange={e=>edit({tenantKey:e.target.value})}/>
            <Button type="button" variant="soft" onClick={async()=>{setBusy(true);setError('');try{const org=await api.organization();edit({tenantKey:org.tenantKey});setNotice(org.name);}catch(e){setError(message(e));}finally{setBusy(false);}}}>{tr("serviceAccess.detectOrganizationApp")}</Button>
          </Flex>
          <Text as="p" id="service-tenant-help" size="1" color="gray">{tr("serviceAccess.userEventsOrganizationAcceptedFeishuAppAvailability")}</Text>
        </Field>:<Field label={tr("common.allowedMembersOpenId")} htmlFor="service-users"><IdentityInput id="service-users" value={draft.users} onChange={users=>edit({users})}/></Field>}
        <Field label={tr("common.restrictChatsLeaveEmptyAllChats")} htmlFor="service-chats"><IdentityInput id="service-chats" value={draft.chats} onChange={chats=>edit({chats})}/></Field>
        <Heading as="h3" size="3" mt="4">{tr("serviceAccess.localProjectSharing")}</Heading>
        <Text as="p" size="2" color="gray">{tr("serviceAccess.organizationMembersUseIsolatedWorkspacesDefaultWithout")}</Text>
        {Object.keys(config.values.projects).map(name=>{const value=draft.projects[name]??{...emptyAudience(),permission:'read-only' as const};return <details key={name}><summary>{name}</summary>
          <AudienceFields id={`project-${name}`} value={value} onChange={a=>project(name,{...a,permission:value.permission})}/>
          <Field label={tr("serviceAccess.projectFilePermissions")} htmlFor={`permission-${name}`}><Choice id={`permission-${name}`} value={value.permission} onChange={permission=>project(name,{...value,permission:permission as ProjectAccess['permission']})} options={[{value:'read-only',label:tr("common.read")},{value:'workspace-write',label:tr("common.allowProjectFileChanges")}]}/></Field>
        </details>;})}
      </fieldset>
      <Flex gap="3" mt="4"><Button type="submit" loading={busy} disabled={!dirty||expired||conflict}>{tr("serviceAccess.saveAccessSettings")}</Button><Button type="button" variant="soft" disabled={busy} onClick={async()=>{try{reset((await api.state()).config);}catch(e){setError(message(e));}}}>{tr("common.reload")}</Button></Flex>
    </form>
  </section>;
}
