import { SectionHeading } from './components/PageSection';
import {duplicateMcpEndpoint,mcpEndpointKey} from '../src/mcp-endpoint-contract';
import {useEffect,useState} from 'react';
import {Badge,Button,Checkbox,Dialog,Flex,Heading,Link,Text,TextField} from '@radix-ui/themes';
import type {ConfigView,McpConnectionPatch} from '../src/ui-contract';
import {AudienceFields,emptyAudience,IdentityInput} from './AudienceFields';
import {ConfirmButton,EditorCloseButton,Field,Notice} from './components';
import {useEditorExit} from './useEditorExit';
import {McpScopes} from './McpScopes';
import {api,message} from './api';
import {getLocale,t as tr} from './i18n';

type Draft=McpConnectionPatch;
type Editor={originalId:string;revision:string;draft:Draft};
const patch=(v:ConfigView['mcpConnections'][number]):Draft=>({id:v.id,type:v.type,url:v.url,enabled:v.enabled,audience:v.audience,projects:v.projects,...(v.oauthScope?{oauthScope:v.oauthScope}:{})});
const errorMessage=(error:unknown)=>{const code=message(error);const keys={mcp_duplicate_endpoint:'mcp.endpointDuplicate',mcp_oauth_invalid_scope:'mcp.scopeInvalid',mcp_oauth_scope:'mcp.scopeGrantedMismatch',mcp_config_changed:'mcp.conflict',mcp_credential_target_changed:'mcp.targetChanged',mcp_oauth_failed:'mcp.oauthFailed',mcp_connection_failed:'mcp.testFailed',mcp_invalid_config:'mcp.invalid',codex_mcp_duplicate:'mcp.importDuplicate',codex_mcp_config_changed:'mcp.importChanged'} as const;return code in keys?tr(keys[code as keyof typeof keys]):code;};
export function McpSettings({config,refresh,expired}:{config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean}) {
 const [editor,setEditor]=useState<Editor|null>(null),[busy,setBusy]=useState(false),[waiting,setWaiting]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[authLink,setAuthLink]=useState(''),[testingId,setTestingId]=useState('');
 const [catalog,setCatalog]=useState<Awaited<ReturnType<typeof api.codexMcp>>|null>(null),[selected,setSelected]=useState<string[]>([]);
 const prior=config.mcpConnections.find(c=>c.id===editor?.originalId),draft=editor?.draft;
 const dirty=!!editor&&JSON.stringify(draft)!==JSON.stringify(prior?patch(prior):{});
 const conflict=!!editor&&editor.revision!==config.revision;
 const duplicate=draft?duplicateMcpEndpoint(config.mcpConnections,draft):undefined;
 const createsDuplicate=!!duplicate&&(!prior||mcpEndpointKey(prior.url)!==mcpEndpointKey(draft!.url));
 const credentialChange=!!prior?.credentialConfigured&&!draft?.clearToken&&!draft?.newToken&&(prior.url!==draft?.url||prior.credentialSource==='oauth'&&(prior.oauthScope??'')!==(draft?.oauthScope??''));
 const update=(value:Partial<Draft>)=>{setEditor(old=>old?{...old,draft:{...old.draft,...value}}:old);setError('');};
 const open=(id?:string)=>{setError('');setNotice('');setAuthLink('');setWaiting(false);const value=config.mcpConnections.find(c=>c.id===id);setEditor({originalId:id??'',revision:config.revision,draft:value?patch(value):{id:'',type:'remote',url:'',enabled:false,audience:emptyAudience(),projects:[]}});};
 const close=async()=>{if(busy)return;if(waiting&&editor)await api.cancelMcpOAuth(editor.originalId);setEditor(null);setWaiting(false);setAuthLink('');setError('');};
 const exit=useEditorExit({open:!!editor,dirty:!!editor&&(dirty||waiting),busy:!!editor&&busy,onClose:close,description:waiting?tr('mcp.discardAuthorization'):undefined});
 useEffect(()=>{
  if(!waiting||!editor)return;let active=true,checking=false;
  const check=async()=>{if(checking||document.visibilityState!=='visible')return;checking=true;try{const latest=(await api.state()).config;if(active&&latest.revision!==editor.revision){setWaiting(false);setEditor(null);setNotice(tr('mcp.settingsUpdated'));await refresh();}}catch{/* Manual refresh remains available. */}finally{checking=false;}};
  const timer=setInterval(()=>void check(),2000);window.addEventListener('focus',check);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',check);};
 },[waiting,editor,refresh]);
 const importExit=useEditorExit({open:!!catalog,dirty:!!catalog&&selected.length>0,busy:!!catalog&&busy,onClose:()=>{setCatalog(null);setSelected([]);}});
 const validate=()=>{if(createsDuplicate)throw new Error(tr('mcp.endpointExists',duplicate!.id));if(!draft||!/^[a-z][a-z0-9_-]{0,47}$/.test(draft.id))throw new Error(tr('mcp.invalidId'));};
 const save=async()=>{if(!editor||!draft)return;setBusy(true);setError('');try{validate();const values=config.mcpConnections.filter(c=>c.id!==editor.originalId).map(patch);await api.saveMcp(editor.revision,[...values,draft]);setEditor(null);setNotice(tr('mcp.saved'));await refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 const authorize=async()=>{
  if(!editor||!draft)return;let popup:Window|null=null;
  try{validate();popup=window.open(`/oauth-preparing?lang=${encodeURIComponent(getLocale())}`,'_blank');if(popup)popup.opener=null;}catch(e){setError(errorMessage(e));return;}
  setBusy(true);setError('');setAuthLink('');
  try{const {newToken:_token,clearToken:_clear,...definition}=draft;const result=await api.startMcpOAuth(editor.revision,editor.originalId,definition),url=new URL(result.url);
   if(url.protocol!=='https:'||url.username||url.password)throw new Error('mcp_oauth_failed');
   let opened=false;if(popup&&!popup.closed)try{popup.location.replace(url.href);opened=true;}catch{/* Use fallback. */}
   if(!opened){popup?.close();setAuthLink(url.href);}setWaiting(true);
  }catch(e){popup?.close();setError(errorMessage(e));}finally{setBusy(false);}
 };
 return <section className="page-panel"><Flex justify="between" align="center" gap="3" wrap="wrap"><SectionHeading icon="connections" title={tr('mcp.title')} /><Flex gap="2" wrap="wrap"><Button type="button" disabled={expired||busy} onClick={()=>open()}>{tr('mcp.addRemote')}</Button><Button type="button" variant="soft" disabled={expired||busy} onClick={async()=>{setBusy(true);setError('');try{setCatalog(await api.codexMcp());setSelected([]);}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>{tr('mcp.import')}</Button></Flex></Flex>
  <Text as="p" size="2" color="gray">{tr('mcp.intro')}</Text>{notice&&<Notice>{notice}</Notice>}{!editor&&error&&<Notice error>{error}</Notice>}
  {config.mcpConnections.map(item=><div className="mcp-connection-row" key={item.id}><div><Flex gap="2" align="center" wrap="wrap"><Heading as="h3" size="3">{item.id}</Heading>{duplicateMcpEndpoint(config.mcpConnections,item)&&<Badge color="orange">{tr('mcp.duplicateBadge')}</Badge>}<Badge color={item.credentialConfigured?'green':'gray'}>{item.credentialConfigured?tr('mcp.authorizationSaved'):tr('mcp.optionalAuth')}</Badge><Badge color={item.enabled?'blue':'gray'}>{item.enabled?tr('mcp.connectionEnabled'):tr('mcp.connectionDisabled')}</Badge></Flex><Text as="p" size="2" color="gray" className="mcp-url">{item.url}</Text>{duplicateMcpEndpoint(config.mcpConnections,item)&&<Text as="p" size="1" color="orange">{tr('mcp.existingDuplicate',duplicateMcpEndpoint(config.mcpConnections,item)!.id)}</Text>}<Text as="p" size="1" color="gray">{item.audience.organization?tr('mcp.audienceOrganization'):tr('mcp.audienceCounts',item.audience.userIds.length,item.audience.chatIds.length)} {item.projects.length?tr('mcp.projectCount',item.projects.length):tr('mcp.allProjects')}</Text></div><Flex gap="2" wrap="wrap"><Button type="button" variant="soft" disabled={expired||busy} onClick={()=>open(item.id)}>{tr('mcp.edit')}</Button><Button type="button" variant="soft" disabled={expired||busy} loading={testingId===item.id} onClick={async()=>{setBusy(true);setTestingId(item.id);setError('');setNotice('');try{const r=await api.testMcp(config.revision,item.id);setNotice(tr('mcp.testOk',r.toolCount));}catch(e){setError(errorMessage(e));}finally{setBusy(false);setTestingId('');}}}>{tr('mcp.test')}</Button></Flex></div>)}
  <Dialog.Root open={!!editor} onOpenChange={value=>{if(!value)exit.requestClose();}}><Dialog.Content maxWidth="760px" className="settings-editor mcp-editor" onEscapeKeyDown={e=>{if(exit.blocked)e.preventDefault();}} onPointerDownOutside={e=>{if(exit.blocked)e.preventDefault();}}>
   <div className="editor-dialog-header"><Dialog.Title>{editor?.originalId?tr('mcp.editConnection',editor.originalId):tr('mcp.addRemote')}</Dialog.Title><EditorCloseButton busy={exit.blocked} onClose={exit.requestClose}/></div><Dialog.Description size="2" color="gray">{tr('mcp.editorHelp')}</Dialog.Description>
   {exit.confirmation}{editor&&draft&&<form onSubmit={e=>{e.preventDefault();void save();}}><div className="settings-editor-body">
    {error&&<Notice error>{error}</Notice>}{duplicate&&<Notice error={createsDuplicate}>{tr('mcp.endpointExists',duplicate.id)}</Notice>}{conflict&&<Notice error>{tr('mcp.conflict')}</Notice>}{credentialChange&&<Notice>{tr('mcp.reauthRequired')}</Notice>}
    {waiting&&<Notice>{tr('mcp.waitingExisting')}{authLink&&<Text as="p"><Link href={authLink} target="_blank" rel="noopener noreferrer">{tr('mcp.popupBlocked')}</Link></Text>}</Notice>}
    <fieldset disabled={exit.blocked||waiting||expired||conflict}>
     <section className="mcp-editor-section" aria-labelledby="mcp-connection-heading"><div className="mcp-section-heading"><Heading as="h3" size="3" id="mcp-connection-heading">{tr('mcp.connectionDetails')}</Heading><Text as="p" size="1" color="gray">{tr('mcp.connectionDetailsHelp')}</Text></div>
      <Field label={tr('mcp.id')} htmlFor="mcp-editor-id"><TextField.Root id="mcp-editor-id" value={draft.id} disabled={!!editor.originalId} onChange={e=>update({id:e.target.value})}/></Field>
      <Field label={tr('mcp.remoteUrl')} htmlFor="mcp-editor-url"><TextField.Root id="mcp-editor-url" value={draft.url} placeholder="https://example.com/mcp" onChange={e=>update({url:e.target.value})}/></Field>
      <div className="mcp-enable-control"><Text as="label" size="2" weight="medium"><Flex gap="2" align="center"><Checkbox aria-describedby="mcp-enabled-help" checked={draft.enabled} onCheckedChange={v=>update({enabled:v===true})}/>{tr('mcp.remoteEnabled')}</Flex></Text><Text as="p" id="mcp-enabled-help" size="1" color="gray">{tr('mcp.remoteEnabledHelp')}</Text></div>
     </section>
     <section className="mcp-editor-section" aria-labelledby="mcp-authorization-heading"><div className="mcp-section-heading"><Heading as="h3" size="3" id="mcp-authorization-heading">{tr('mcp.authorizationTitle')}</Heading>{prior?.credentialConfigured&&<Badge color="green" variant="soft">{tr('mcp.authorizationSaved')}</Badge>}</div>
     <McpScopes url={draft.url} revision={editor.revision} value={draft.oauthScope??''} onChange={oauthScope=>update({oauthScope})}/>
     <details className="mcp-advanced mcp-credentials"><summary>{tr('mcp.credentialAdvanced')}</summary><Text as="p" size="1" color="gray">{tr('mcp.advancedHelp')}</Text><Field label={tr('mcp.remoteAuth')} htmlFor="mcp-editor-token"><TextField.Root id="mcp-editor-token" type="password" autoComplete="new-password" value={draft.newToken??''} onChange={e=>update({newToken:e.target.value,clearToken:false})} placeholder={prior?.credentialConfigured?tr('mcp.configured'):tr('mcp.remoteTokenPlaceholder')}/></Field>{prior?.credentialConfigured&&<Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={draft.clearToken??false} onCheckedChange={v=>update({clearToken:v===true,newToken:'',...(v===true?{enabled:false}:{})})}/>{tr('mcp.clearAuthorization')}</Flex></Text>}</details>
     </section>
     <section className="mcp-editor-section" aria-labelledby="mcp-access-heading"><div className="mcp-section-heading"><Heading as="h3" size="3" id="mcp-access-heading">{tr('mcp.accessTitle')}</Heading></div><Text as="p" size="1" color="gray">{tr('mcp.accessNote')}</Text>
     <AudienceFields id="mcp-editor" value={draft.audience} onChange={audience=>update({audience})}/>
     <Field label={tr('mcp.projects')} htmlFor="mcp-editor-projects"><IdentityInput id="mcp-editor-projects" value={draft.projects} onChange={projects=>update({projects})}/></Field>
     </section>
    </fieldset>
   </div><Flex gap="3" justify="end" align="center" wrap="wrap" className="settings-editor-footer">
    {editor.originalId&&<ConfirmButton danger disabled={exit.blocked||waiting||expired||conflict} title={tr('mcp.remove')} description={tr('mcp.removeHelp')} onConfirm={async()=>{setBusy(true);try{await api.saveMcp(editor.revision,config.mcpConnections.filter(v=>v.id!==editor.originalId).map(patch));setEditor(null);await refresh();}finally{setBusy(false);}}}>{tr('mcp.remove')}</ConfirmButton>}
    <Button type="button" variant="soft" color="gray" disabled={exit.blocked} onClick={exit.requestClose}>{tr('mcp.cancelEdit')}</Button>
    {waiting&&<Button type="button" variant="soft" disabled={exit.blocked} onClick={async()=>{setBusy(true);try{await api.cancelMcpOAuth(editor.originalId);setWaiting(false);setAuthLink('');}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>{tr('mcp.retryAuthorization')}</Button>}
    {!waiting&&<><Button type="submit" variant="soft" disabled={!dirty||exit.blocked||expired||conflict||credentialChange||createsDuplicate}>{tr('mcp.save')}</Button><Button type="button" disabled={exit.blocked||expired||conflict||!!draft.newToken||!!draft.clearToken||createsDuplicate} loading={busy} onClick={()=>void authorize()}>{dirty?tr('mcp.saveAuthorize'):prior?.credentialConfigured?tr('mcp.reauthorize'):tr('mcp.oauth')}</Button></>}
   </Flex></form>}
  </Dialog.Content></Dialog.Root>
  <Dialog.Root open={!!catalog} onOpenChange={value=>{if(!value)importExit.requestClose();}}><Dialog.Content maxWidth="680px" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}><div className="editor-dialog-header"><Dialog.Title>{tr('mcp.import')}</Dialog.Title><EditorCloseButton busy={importExit.blocked} onClose={importExit.requestClose}/></div><Dialog.Description size="2">{tr('mcp.importIntro')}</Dialog.Description>{importExit.confirmation}{catalog&&<><Flex direction="column" gap="3" my="4">{catalog.entries.map(entry=><Text as="label" size="2" key={entry.id}><Flex gap="2" align="center" wrap="wrap"><Checkbox disabled={busy||!entry.importable} checked={selected.includes(entry.id)} onCheckedChange={v=>setSelected(old=>v===true?[...old,entry.id]:old.filter(id=>id!==entry.id))}/><strong>{entry.id}</strong><Text color="gray">{entry.host??entry.transport} · {entry.duplicateOf?tr('mcp.importDuplicateOf',entry.duplicateOf):entry.importable?tr('mcp.importAuth'):tr('mcp.importUnavailable')}</Text></Flex></Text>)}</Flex>{error&&<Notice error>{error}</Notice>}<Flex gap="3" justify="end"><Button type="button" variant="soft" disabled={importExit.blocked} onClick={importExit.requestClose}>{tr('common.close')}</Button><Button type="button" disabled={busy||!selected.length} loading={busy} onClick={async()=>{setBusy(true);setError('');try{await api.importCodexMcp(config.revision,catalog.revision,selected);setCatalog(null);setNotice(tr('mcp.imported'));await refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}}>{tr('mcp.importSelected')}</Button></Flex></>}</Dialog.Content></Dialog.Root>
 </section>;
}
