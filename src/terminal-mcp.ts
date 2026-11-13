import { t } from './locale.js';
import { editForm, type Draft, type Field } from './terminal-forms.js';
import { ManagementError, type Management } from './management.js';
import { Back, parseSelectedAction, type ConfigPrompter } from './config-prompts.js';
import type { McpConnectionPatch, McpConnectionView } from './ui-contract.js';
import { terminalOAuth } from './terminal-config.js';
import { beginMcpOAuth } from './mcp-oauth.js';

const safe=(c:McpConnectionView):McpConnectionPatch=>({id:c.id,type:c.type,url:c.url,...(c.oauthScope?{oauthScope:c.oauthScope}:{}),...(c.ownerUserId?{ownerUserId:c.ownerUserId}:{})});

async function editor(manager:Management,ui:ConfigPrompter,previous?:McpConnectionView):Promise<boolean> {
 const view=manager.config(),revision=view.revision;
 const fields:Field[]=[...(!previous?[{key:'id',label:t('terminal.mcpId'),kind:'text' as const}]:[]),{key:'url',label:t('terminal.mcpUrl'),kind:'text'},
  {key:'scope',label:t('terminal.scope'),kind:'text',clearable:true},{key:'method',label:t('terminal.mcpMethod'),kind:'choice',choices:[
   {value:'keep',label:t('terminal.mcpKeep')},{value:'oauth',label:t('terminal.oauth')},{value:'token',label:t('terminal.token')},{value:'clear',label:t('terminal.mcpClear')}]},
  {key:'token',label:t('terminal.mcpToken'),kind:'secret'}];
 return editForm(ui,previous?.id??t('terminal.mcpAdd'),{id:previous?.id??'',url:previous?.url??'',scope:previous?.oauthScope??'',method:'keep',token:''},fields,async(d:Draft)=>{
  const id=String(d.id),scope=String(d.scope),method=String(d.method),token=String(d.token);
  const draft:McpConnectionPatch={id,type:'remote',url:String(d.url),...(scope?{oauthScope:scope}:{}),...(previous?.ownerUserId?{ownerUserId:previous.ownerUserId}:{})};
  if(method==='oauth') {
   let error='';const ok=await terminalOAuth(manager,ui,revision,previous?.id??'',draft,beginMcpOAuth,message=>{error=message;});
   if(!ok)throw new ManagementError(error||t('terminal.oauthIncomplete'));return;
  }
  if(method==='token'&&!token)throw new ManagementError(t('terminal.tokenRequired'),400);
  if(method!=='token'&&token)throw new ManagementError(t('terminal.mcpTokenMethod'),400);
  const connections=(view.mcpConnections as McpConnectionView[]).filter(c=>c.id!==previous?.id).map(safe);
  connections.push({...draft,...(method==='token'?{newToken:token}:method==='clear'?{clearToken:true}:{})});
  manager.save(revision,{mcpConnections:connections});
 });
}
export async function manageMcp(manager:Management,ui:ConfigPrompter):Promise<string> {
 let active:string|undefined;
 for(;;){
  const view=manager.config(),connections=view.mcpConnections as McpConnectionView[];
  ui.screen?.();
  const choice=await ui.select(t('terminal.mcpManage'),[...(connections.length?connections.map(c=>({value:c.id,label:`${c.id} · ${c.credentialSource??(c.credentialConfigured?'token':'anonymous')}`,availableActions:['edit','test','scope','remove']})):[{value:'$empty',label:t('terminal.listEmpty'),disabled:true}]),
   ...(connections.length?[{value:'edit',label:t('terminal.mcpEditSelected'),action:true,shortcut:'E',targeted:true},{value:'test',label:t('terminal.mcpTestSelected'),action:true,shortcut:'T',targeted:true},{value:'scope',label:t('terminal.mcpScopeSelected'),action:true,shortcut:'O',targeted:true},{value:'remove',label:t('terminal.mcpRemoveSelected'),action:true,shortcut:'D',targeted:true}]:[]),{value:'$add',label:t('terminal.mcpAddAction'),action:true,shortcut:'A'},{value:'$import',label:t('terminal.mcpImport'),action:true,shortcut:'I'}],active);
  const target=parseSelectedAction(choice),selected=target?.[1]??choice;
  if(connections.some(c=>c.id===selected))active=selected;
  try {
   if(selected==='$add'){if(await editor(manager,ui))return t('terminal.saved');continue;}
   if(selected==='$import') {
    const catalog=manager.codexMcpCatalog(),entries=catalog.entries.filter(entry=>entry.importable);
    if(!entries.length)return t('terminal.mcpNoImport');
    ui.screen?.();const id=await ui.select(t('terminal.mcpImport'),entries.map(entry=>({value:entry.id,label:`${entry.id} · ${entry.host??entry.transport}`})));
    ui.screen?.();if(await ui.confirm(t('terminal.mcpImportConfirm',id))){manager.importCodexMcp(view.revision,catalog.revision,[id]);return t('terminal.mcpImported');}continue;
   }
   const item=connections.find(c=>c.id===selected);if(!item)continue;
    const action=target?.[0]??'edit';
    try {
     if(action==='edit'){if(await editor(manager,ui,item))return t('terminal.saved');continue;}
     if(action==='test'){const result=await manager.testMcp(view.revision,item.id);return t('terminal.mcpResult',result.toolCount);}
     if(action==='scope'){const result=await manager.mcpOAuthScopes(view.revision,item.url);return t('terminal.mcpScopesResult',result.scopes.join(' '));}
     if(action==='remove'){ui.screen?.();if(await ui.confirm(t('terminal.mcpRemoveConfirm',item.id))){manager.save(view.revision,{mcpConnections:connections.filter(c=>c.id!==item.id).map(safe)});return t('terminal.mcpRemoved');}}
    }catch(error){if(!(error instanceof Back))throw error;}
  }catch(error){if(!(error instanceof Back))throw error;}
 }
}
