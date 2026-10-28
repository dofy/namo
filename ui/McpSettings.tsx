import { useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Flex, Heading, Link, Text, TextField } from '@radix-ui/themes';
import type { ConfigView, McpConnectionPatch } from '../src/ui-contract';
import { AudienceFields, emptyAudience, IdentityInput } from './AudienceFields';
import { Field, Notice } from './components';
import { api, message } from './api';
import { t as tr } from './i18n';

const mcpMessage=(error:unknown)=>{const value=message(error);return value==='codex_mcp_duplicate'?tr('mcp.importDuplicate'):value==='codex_mcp_config_changed'?tr('mcp.importChanged'):value==='codex_mcp_config_invalid'?tr('mcp.importInvalid'):value==='codex_mcp_selection_unsupported'?tr('mcp.importUnsupported'):value==='mcp_credential_target_changed'?tr('mcp.targetChanged'):value==='mcp_connection_failed'?tr('mcp.testFailed'):value==='mcp_config_changed'?tr('mcp.conflict'):value==='mcp_connection_not_enabled'?tr('mcp.notEnabled'):value==='mcp_invalid_config'?tr('mcp.invalid'):value==='mcp_oauth_failed'?tr('mcp.oauthFailed'):value;};

type Draft=McpConnectionPatch & {credentialConfigured:boolean;credentialSource?:'oauth'};
const drafts=(c:ConfigView):Draft[] => (c.mcpConnections??[]).map(v=>({...v,newToken:''}));
export function McpSettings({config,refresh,expired}:{config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean}) {
  const [items,setItems]=useState(()=>drafts(config)),[revision,setRevision]=useState(config.revision),[dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [catalog,setCatalog]=useState<Awaited<ReturnType<typeof api.codexMcp>>|null>(null),[selected,setSelected]=useState<string[]>([]);
  const [authLink,setAuthLink]=useState<{id:string;url:string}|null>(null),[waitingForAuth,setWaitingForAuth]=useState(false);
  const conflict=dirty&&revision!==config.revision;
  const reset=(c:ConfigView)=>{setItems(drafts(c));setRevision(c.revision);setDirty(false);setAuthLink(null);setWaitingForAuth(false);};
  useEffect(()=>{if(!dirty&&!busy&&revision!==config.revision)reset(config);},[config,dirty,busy,revision]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  useEffect(()=>{
    if(!waitingForAuth||dirty)return;
    let active=true,checking=false;
    const check=()=>{if(!active||checking||document.visibilityState!=='visible')return;checking=true;
      void api.state().then(async latest=>{if(active&&latest.config.revision!==revision){reset(latest.config);setNotice(tr('mcp.settingsUpdated'));await refresh();}})
        .catch(()=>{/* A later focus or manual reload can retry. */}).finally(()=>{checking=false;});};
    window.addEventListener('focus',check);document.addEventListener('visibilitychange',check);
    return()=>{active=false;window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);};
  },[waitingForAuth,dirty,revision,refresh]);
  const update=(index:number,patch:Partial<Draft>)=>{setItems(values=>values.map((item,i)=>i===index?{...item,...patch}:item));setDirty(true);setNotice('');};
  const authorize=async(item:Draft)=>{
    let popup:Window|null=null;
    try{popup=window.open('about:blank','_blank');if(popup){popup.opener=null;try{popup.document.title=tr('mcp.opening');popup.document.body.textContent=tr('mcp.opening');}catch{/* Navigation can continue without a loading message. */}}}catch{/* Use the fallback link if opening is blocked. */}
    setBusy(true);setError('');setNotice('');setAuthLink(null);
    try{
      const result=await api.startMcpOAuth(revision,item.id),url=new URL(result.url);
      if(url.protocol!=='https:'||url.username||url.password||new URL(result.issuer).protocol!=='https:')throw new Error('mcp_oauth_failed');
      let opened=false;
      if(popup&&!popup.closed)try{popup.location.replace(url.href);opened=true;}catch{/* The user can open the link below. */}
      if(!opened){popup?.close();setAuthLink({id:item.id,url:url.href});}
      setWaitingForAuth(true);setNotice(item.credentialConfigured?tr('mcp.waitingExisting'):tr('mcp.waitingNew'));
    }catch(e){popup?.close();setError(mcpMessage(e));}finally{setBusy(false);}
  };
  return <section className="form-section"><Heading as="h2" size="5">{tr('mcp.title')}</Heading>
    <Text as="p" size="2" color="gray">{tr('mcp.intro')}</Text>
    <Text as="p" size="2" color="gray">{tr('mcp.accessNote')}</Text>
    {error&&<Notice error>{error}</Notice>}{notice&&<Notice>{notice}</Notice>}{conflict&&<Notice>{tr('mcp.conflict')}</Notice>}
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{
      const patch=items.map(({credentialConfigured:_,credentialSource:_source,...item})=>item);
      const saved=await api.saveMcp(revision,patch);reset(saved);setNotice(tr('mcp.saved'));await refresh();
    }catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>
      <fieldset disabled={busy||expired}>
        {items.map((item,index)=><div className="guide" key={index}>
          <Flex justify="between" align="center" gap="3" wrap="wrap"><Flex align="center" gap="2" wrap="wrap">
            <Heading as="h3" size="3">{tr('mcp.remote')} · {item.id||'—'}</Heading>
            <Badge color={item.credentialConfigured?'green':'gray'}>{item.credentialConfigured?tr('mcp.authorizationSaved'):tr('mcp.optionalAuth')}</Badge>
            <Badge color={item.enabled?'blue':'gray'}>{item.enabled?tr('mcp.connectionEnabled'):tr('mcp.connectionDisabled')}</Badge>
          </Flex><Flex gap="2" wrap="wrap">
            <Button type="button" variant="soft" disabled={dirty||!item.id} onClick={()=>void authorize(item)}>{item.credentialConfigured?tr('mcp.reauthorize'):tr('mcp.oauth')}</Button>
            <Button type="button" variant="soft" disabled={dirty||!item.enabled} onClick={async()=>{setBusy(true);setError('');setNotice('');try{const result=await api.testMcp(revision,item.id);setNotice(tr('mcp.testOk',result.toolCount));}catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>{tr('mcp.test')}</Button>
          </Flex></Flex>
          <Text as="p" size="2" color="gray">{tr('mcp.remoteSummary')}</Text>
          <Text as="p" size="2" color="gray">{item.audience.organization?tr('mcp.audienceOrganization'):tr('mcp.audienceCounts',item.audience.userIds.length,item.audience.chatIds.length)} {item.projects.length?tr('mcp.projectCount',item.projects.length):tr('mcp.allProjects')}</Text>
          {authLink?.id===item.id&&<Text as="p" size="2"><Link href={authLink.url} target="_blank" rel="noopener noreferrer">{tr('mcp.popupBlocked')}</Link></Text>}
          <details open={!item.credentialConfigured}>
            <summary>{tr('mcp.advancedSettings')}</summary>
            <Field label={tr('mcp.id')} htmlFor={`mcp-id-${index}`}><TextField.Root id={`mcp-id-${index}`} value={item.id} disabled={item.credentialConfigured} onChange={e=>update(index,{id:e.target.value})}/></Field>
            <Field label={tr('mcp.remoteUrl')} htmlFor={`mcp-url-${index}`}><TextField.Root id={`mcp-url-${index}`} value={item.url??''} placeholder="https://example.com/mcp" onChange={e=>update(index,{url:e.target.value})}/></Field>
            <Field label={tr('mcp.oauthScope')} htmlFor={`mcp-scope-${index}`}><TextField.Root id={`mcp-scope-${index}`} value={item.oauthScope??''} onChange={e=>update(index,{oauthScope:e.target.value})} placeholder={tr('mcp.oauthScopePlaceholder')}/></Field>
            <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={item.enabled} onCheckedChange={v=>update(index,{enabled:v===true})}/>{tr('mcp.remoteEnabled')}</Flex></Text>
            <Field label={tr('mcp.remoteAuth')} htmlFor={`mcp-token-${index}`}><TextField.Root id={`mcp-token-${index}`} type="password" autoComplete="new-password" value={item.newToken??''} onChange={e=>update(index,{newToken:e.target.value,clearToken:false})} placeholder={item.credentialConfigured?(item.credentialSource==='oauth'?tr('mcp.oauthConfigured'):tr('mcp.configured')):tr('mcp.remoteTokenPlaceholder')}/></Field>
            {item.credentialConfigured&&<Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={item.clearToken??false} onCheckedChange={v=>update(index,{clearToken:v===true,newToken:'',...(v===true?{enabled:false}:{})})}/>{tr('mcp.clearAuthorization')}</Flex></Text>}
            <Text as="p" size="1" color="gray">{tr('mcp.remoteAuthHelp')}</Text>
            <AudienceFields id={`mcp-${index}`} value={item.audience} onChange={audience=>update(index,{audience})}/>
            <Field label={tr('mcp.projects')} htmlFor={`mcp-projects-${index}`}><IdentityInput id={`mcp-projects-${index}`} value={item.projects} onChange={projects=>update(index,{projects})}/></Field>
            <Button type="button" variant="soft" color="red" onClick={()=>{setItems(v=>v.filter((_,i)=>i!==index));setDirty(true);}}>{tr('mcp.remove')}</Button>
          </details>
        </div>)}
        <Flex gap="3" wrap="wrap"><Button type="button" variant="soft" onClick={()=>{setItems(v=>[...v,{id:'',type:'remote',url:'',enabled:false,audience:emptyAudience(),projects:[],credentialConfigured:false,newToken:''}]);setDirty(true);}}>{tr('mcp.addRemote')}</Button><Button type="button" variant="soft" disabled={dirty||conflict} onClick={async()=>{setBusy(true);setError('');try{setCatalog(await api.codexMcp());setSelected([]);}catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>{tr('mcp.import')}</Button></Flex>
        {catalog&&<div className="guide"><Heading as="h3" size="3">{tr('mcp.import')}</Heading><Text as="p" size="2" color="gray">{tr('mcp.importIntro')}</Text>{catalog.entries.length===0&&<Text as="p">{tr('mcp.importNone')}</Text>}{catalog.entries.map(entry=><Text as="label" size="2" key={entry.id}><Flex gap="2" align="center" wrap="wrap"><Checkbox disabled={!entry.importable} checked={selected.includes(entry.id)} onCheckedChange={v=>setSelected(old=>v===true?[...old,entry.id]:old.filter(id=>id!==entry.id))}/><strong>{entry.id}</strong><Text color="gray">{entry.host??entry.transport} · {entry.importable?(entry.requiresOwnAuth?tr('mcp.importAuth'):'HTTPS'):(entry.reason==='local_process'?tr('mcp.reasonLocal'):entry.reason==='invalid_url'?tr('mcp.reasonUrl'):entry.reason==='url_parameters'?tr('mcp.reasonParams'):tr('mcp.reasonOther'))}</Text></Flex></Text>)}<Button type="button" disabled={!selected.length} onClick={async()=>{setBusy(true);setError('');try{const saved=await api.importCodexMcp(revision,catalog.revision,selected);reset(saved);setCatalog(null);setNotice(tr('mcp.imported'));await refresh();}catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>{tr('mcp.importSelected')}</Button></div>}
      </fieldset>
      <Flex gap="3" mt="4"><Button type="submit" loading={busy} disabled={!dirty||expired||conflict}>{tr('mcp.save')}</Button><Button type="button" variant="soft" disabled={busy} onClick={async()=>{try{reset((await api.state()).config);setError('');}catch(e){setError(mcpMessage(e));}}}>{tr('common.reload')}</Button></Flex>
    </form>
  </section>;
}
