import { useEffect, useState } from 'react';
import { Button, Checkbox, Flex, Heading, Link, Text, TextField } from '@radix-ui/themes';
import type { ConfigView, McpConnectionPatch } from '../src/ui-contract';
import { AudienceFields, emptyAudience, IdentityInput } from './AudienceFields';
import { Field, Notice } from './components';
import { api, message } from './api';
import { t as tr } from './i18n';

const mcpMessage=(error:unknown)=>{const value=message(error);return value==='mcp_connection_failed'?tr('mcp.testFailed'):value==='mcp_config_changed'?tr('mcp.conflict'):value==='mcp_connection_not_enabled'?tr('mcp.notEnabled'):value==='mcp_invalid_config'?tr('mcp.invalid'):value==='mcp_oauth_failed'?tr('mcp.oauthFailed'):value;};

type Draft=McpConnectionPatch & {credentialConfigured:boolean;credentialSource?:'oauth'};
const drafts=(c:ConfigView):Draft[] => (c.mcpConnections??[]).map(v=>({...v,newToken:''}));
export function McpSettings({config,refresh,expired}:{config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean}) {
  const [items,setItems]=useState(()=>drafts(config)),[revision,setRevision]=useState(config.revision),[dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [authLink,setAuthLink]=useState<{id:string;url:string}|null>(null);
  const conflict=dirty&&revision!==config.revision;
  const reset=(c:ConfigView)=>{setItems(drafts(c));setRevision(c.revision);setDirty(false);setAuthLink(null);};
  useEffect(()=>{if(!dirty&&!busy&&revision!==config.revision)reset(config);},[config,dirty,busy,revision]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const update=(index:number,patch:Partial<Draft>)=>{setItems(values=>values.map((item,i)=>i===index?{...item,...patch}:item));setDirty(true);setNotice('');};
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
          <Flex justify="between" align="center" gap="2" wrap="wrap"><Heading as="h3" size="3">Linear · {item.id||tr('mcp.newConnection')}</Heading>
            <Flex gap="2"><Button type="button" variant="soft" disabled={dirty||!item.id} onClick={async()=>{setBusy(true);setError('');setAuthLink(null);try{const result=await api.startMcpOAuth(revision,item.id);setAuthLink({id:item.id,url:result.url});}catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>{tr('mcp.oauth')}</Button><Button type="button" variant="soft" disabled={dirty||!item.enabled||!item.credentialConfigured} onClick={async()=>{setBusy(true);setError('');try{const result=await api.testMcp(revision,item.id);setNotice(tr('mcp.testOk',result.toolCount));}catch(e){setError(mcpMessage(e));}finally{setBusy(false);}}}>{tr('mcp.test')}</Button><Button type="button" variant="soft" color="red" onClick={()=>{setItems(v=>v.filter((_,i)=>i!==index));setDirty(true);}}>{tr('mcp.remove')}</Button></Flex></Flex>
          {authLink?.id===item.id&&<Text as="p" size="2"><Link href={authLink.url} target="_blank" rel="noopener noreferrer">{tr('mcp.oauthContinue')}</Link> {tr('mcp.oauthReturn')}</Text>}
          <Field label={tr('mcp.id')} htmlFor={`mcp-id-${index}`}><TextField.Root id={`mcp-id-${index}`} value={item.id} disabled={item.credentialConfigured} onChange={e=>update(index,{id:e.target.value})}/></Field>
          <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={item.enabled} onCheckedChange={v=>update(index,{enabled:v===true})}/>{tr('mcp.enabled')}</Flex></Text>
          <Field label={tr('mcp.token')} htmlFor={`mcp-token-${index}`}><TextField.Root id={`mcp-token-${index}`} type="password" autoComplete="new-password" value={item.newToken??''} onChange={e=>update(index,{newToken:e.target.value,clearToken:false})} placeholder={item.credentialConfigured?(item.credentialSource==='oauth'?tr('mcp.oauthConfigured'):tr('mcp.configured')):tr('mcp.tokenPlaceholder')}/></Field>
          {item.credentialConfigured&&<Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={item.clearToken??false} onCheckedChange={v=>update(index,{clearToken:v===true,newToken:''})}/>{tr('mcp.clearToken')}</Flex></Text>}
          <Text as="p" size="1" color="gray">{tr('mcp.tokenHelp')}</Text>
          <AudienceFields id={`mcp-${index}`} value={item.audience} onChange={audience=>update(index,{audience})}/>
          <Field label={tr('mcp.projects')} htmlFor={`mcp-projects-${index}`}><IdentityInput id={`mcp-projects-${index}`} value={item.projects} onChange={projects=>update(index,{projects})}/></Field>
        </div>)}
        <Button type="button" variant="soft" onClick={()=>{setItems(v=>[...v,{id:'',type:'linear',enabled:false,audience:emptyAudience(),projects:[],credentialConfigured:false,newToken:''}]);setDirty(true);}}>{tr('mcp.addLinear')}</Button>
      </fieldset>
      <Flex gap="3" mt="4"><Button type="submit" loading={busy} disabled={!dirty||expired||conflict}>{tr('mcp.save')}</Button><Button type="button" variant="soft" disabled={busy} onClick={async()=>{try{reset((await api.state()).config);setError('');}catch(e){setError(mcpMessage(e));}}}>{tr('common.reload')}</Button></Flex>
    </form>
  </section>;
}
