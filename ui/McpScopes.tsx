import {useId,useState} from 'react';
import {Button,Checkbox,Flex,Text,TextField} from '@radix-ui/themes';
import {api} from './api';
import {t as tr} from './i18n';
import {Field,Notice} from './components';

/** Discovery is scoped to the exact draft URL; it never changes selected permissions. */
export function McpScopes({url,revision,value,onChange}:{url:string;revision:string;value:string;onChange:(value:string)=>void}) {
 const fieldId=useId();
 const [result,setResult]=useState<{url:string;data:Awaited<ReturnType<typeof api.mcpOAuthScopes>>}|null>(null);
 const [busy,setBusy]=useState(false),[failed,setFailed]=useState(false);
 const data=result?.url===url?result.data:null,selected=value.split(/\s+/).filter(Boolean);
 const choices=[...new Set([...(data?.scopes??[]),...selected])];
 return <div className="mcp-scopes">
  <div className="mcp-scopes-header"><div><Text as="p" size="2" weight="medium">{tr('mcp.oauthScope')}</Text><Text as="p" size="1" color="gray">{tr('mcp.authorizationHelp')}</Text></div><Button type="button" variant="soft" size="1" loading={busy} disabled={!url} onClick={async()=>{setBusy(true);setFailed(false);try{setResult({url,data:await api.mcpOAuthScopes(revision,url)});}catch{setFailed(true);}finally{setBusy(false);}}}>{tr('mcp.discoverScopes')}</Button></div>
  {failed&&<Notice error>{tr('mcp.scopeDiscoveryFailed')}</Notice>}
  {data&&<Text as="p" size="1" color="gray">{data.published?tr('mcp.scopeSelectionHelp'):tr('mcp.scopesUnpublished')}</Text>}
  {data&&choices.length>0&&<div className="mcp-scope-list"><div className="mcp-scope-list-heading"><Text size="1" weight="medium">{tr('mcp.scopeSelection')}</Text><Text size="1" color="gray">{tr('mcp.scopeSelected',new Set(selected).size)}</Text></div>{choices.map(scope=><Text as="label" size="2" className="mcp-scope-option" key={scope}><Flex gap="2" align="center" wrap="wrap"><Checkbox checked={selected.includes(scope)} onCheckedChange={checked=>onChange((checked===true?[...selected,scope]:selected.filter(v=>v!==scope)).join(' '))}/><code>{scope}</code>{!data.scopes.includes(scope)&&<Text color="orange">{tr('mcp.scopeNotAdvertised')}</Text>}</Flex></Text>)}</div>}
  <Text as="p" size="1" color="gray">{tr('mcp.scopeDefaultHelp')}</Text>
  <details className="mcp-advanced"><summary>{tr('mcp.manualScopes')}</summary><Field label={tr('mcp.oauthScope')} htmlFor={fieldId}><TextField.Root id={fieldId} value={value} onChange={e=>onChange(e.target.value)} placeholder={tr('mcp.oauthScopePlaceholder')}/></Field></details>
 </div>;
}
