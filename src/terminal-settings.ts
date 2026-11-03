import { t } from './locale.js';
import { editForm, type Draft, type Field } from './terminal-forms.js';
import type { ConfigPrompter } from './config-prompts.js';
import { ManagementError, type Management } from './management.js';
import type { AssistantView, ConfigView, ProfileState } from './ui-contract.js';

const field=(key:string,label:string,kind:Field['kind'],extra:Partial<Field>={}):Field=>({key,label,kind,...extra});
const labels=():Record<string,string>=>({auto:t('assistant.automatic'),'zh-CN':t('assistant.chinese'),'en-US':t('assistant.english'),concise:t('assistant.concise'),balanced:t('assistant.balanced'),detailed:t('assistant.detailed'),essential:t('assistant.essential'),deep:t('assistant.deep'),never:t('assistant.never'),sparingly:t('assistant.sparingly'),freely:t('assistant.freely')});
const pick=(...values:string[])=>values.map(value=>({value,label:labels()[value]??value}));
const changedPatch=(d:Draft,keys:ReadonlySet<string>):Draft=>Object.fromEntries([...keys].map(key=>[key,d[key]]));
const string=(d:Draft,k:string)=>String(d[k]??'');
const list=(d:Draft,k:string)=>d[k] as string[];

export async function editExecution(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<boolean> {
 const v=view.values;
 const fields:Field[]=[field('model',t('model.serviceDefault'),'text',{clearable:true}),field('bin',t('settings.codexCommandFullPath'),'text'),field('concurrency',t('settings.maximumConcurrentTasks'),'number'),field('timeoutMs',t('terminal.timeout'),'number'),field('networkAccess',t('terminal.network'),'boolean'),field('denyPaths',t('terminal.denyPaths'),'list',{clearable:true})];
 return editForm(ui,t('terminal.menuModel'),{model:v.model,bin:v.bin,concurrency:v.concurrency,timeoutMs:v.timeoutMs,networkAccess:v.networkAccess,denyPaths:v.denyPaths},fields,(d,keys)=>{manager.save(view.revision,changedPatch(d,keys));});
}
export async function editDirectories(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<boolean> {
 return editForm(ui,t('terminal.menuDirectories'),{directories:view.values.directories??[]},[field('directories',t('terminal.directories'),'list',{clearable:true})],d=>{manager.save(view.revision,d);});
}
export async function editFeishu(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<boolean> {
 const v=view.values;
 const fields:Field[]=[field('cards',t('terminal.cards'),'boolean'),field('requireMention',t('terminal.mention'),'boolean'),field('reactions',t('settings.messageReactionsTitle'),'boolean'),field('progressUpdates',t('settings.messageProgressTitle'),'boolean'),field('progressDelayMs',t('settings.initialProgressNoticeDelayMs'),'number'),field('progressIntervalMs',t('settings.minimumProgressUpdateIntervalMs'),'number'),field('progressHeartbeatMs',t('settings.progressHeartbeatIntervalMs'),'number'),field('newSecret',t('terminal.secret'),'secret')];
 return editForm(ui,t('terminal.menuFeishu'),{cards:v.cards,requireMention:v.requireMention,reactions:v.reactions!==false,progressUpdates:v.progressUpdates!==false,progressDelayMs:v.progressDelayMs??200,progressIntervalMs:v.progressIntervalMs??5000,progressHeartbeatMs:v.progressHeartbeatMs??30000,newSecret:''},fields,(d,keys)=>{manager.save(view.revision,changedPatch(d,keys));},false,t('terminal.feishuInfo',view.feishu.appId,view.feishu.domain,view.feishu.pairedUsers));
}
export async function editGitHub(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<boolean> {
 const github=view.github;
 const source=github?.credentialSource==='gh'?'gh':github?.credentialConfigured||github?.tokenEnv?'token':'anonymous';
 const fields:Field[]=[field('source',t('terminal.githubSource'),'choice',{choices:[{value:'anonymous',label:t('terminal.anonymous')},{value:'gh',label:t('terminal.gh')},{value:'token',label:t('terminal.token')}]}),field('token',t('terminal.githubToken'),'secret'),field('clear',t('github.clearSavedGithubCredentials'),'boolean')];
 return editForm(ui,t('terminal.menuGithub'),{source,token:'',clear:false},fields,async d=>{
  const selected=string(d,'source'),token=string(d,'token'),clear=d.clear===true;
  if(selected!=='token'&&(token||clear)||token&&clear)throw new ManagementError(t('terminal.githubCredentialChoice'),400);
  if(selected==='token'&&!token&&!clear&&(!github?.credentialConfigured||github.credentialSource==='gh'))throw new ManagementError(t('terminal.tokenRequired'),400);
  await manager.saveGitHub(view.revision,{github:{source:selected,repositories:[],allowedUserIds:[],...(selected==='anonymous'?{}:{mode:'shared'})},...(token?{newGithubToken:token}:{}),...(clear?{clearGithubToken:true}:{})});
 },false,t('terminal.githubSharing'));
}
export async function editAccess(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<boolean> {
 const f=view.feishu;
 const action=await ui.select(t('serviceAccess.organizationAccessDirectoryPermissions'),[{value:'edit',label:t('terminal.formEdit')},{value:'detect',label:t('terminal.detectOrg')}]);
 const detected=action==='detect'?await manager.organization():undefined;
 if(detected)ui.info(t('terminal.orgDetected',detected.name,detected.tenantKey));
 const fields=[field('mode',t('serviceAccess.serviceAudience'),'choice',{choices:[{value:'organization',label:t('serviceAccess.feishuOrganizationMembers')},{value:'selected',label:t('serviceAccess.selectedMembersLegacyMode')}]}),field('tenantKey',t('serviceAccess.feishuTenantKey'),'text',{clearable:true}),field('users',t('common.allowedMembersOpenId'),'list',{clearable:true}),field('chats',t('common.restrictChatsLeaveEmptyAllChats'),'list',{clearable:true})];
 return editForm(ui,t('serviceAccess.organizationAccessDirectoryPermissions'),{mode:detected?'organization':f.access?'organization':'selected',tenantKey:detected?.tenantKey??f.access?.tenantKey??'',users:f.allowedUserIds??[],chats:f.allowedChatIds??[]},fields,d=>{
  manager.save(view.revision,{serviceAccess:{access:d.mode==='organization'?{mode:'organization',tenantKey:string(d,'tenantKey')}:null,allowedUserIds:list(d,'users'),allowedChatIds:list(d,'chats')}});
 },!!detected);
}
export async function editAssistant(manager:Management,ui:ConfigPrompter):Promise<boolean> {
 const state=manager.state() as {assistant?:AssistantView};if(!state.assistant)throw new ManagementError(t('terminal.missingDb'));const a=state.assistant,v=a.values;
 const fields=[field('name',t('assistant.name'),'text'),field('role',t('assistant.role'),'text'),field('personality',t('terminal.personalityMultiline'),'multiline'),field('defaultLanguage',t('common.language'),'choice',{choices:pick('auto','zh-CN','en-US')}),field('replyLength',t('assistant.replyLength'),'choice',{choices:pick('concise','balanced','detailed')}),field('technicalDetail',t('terminal.assistantDetail'),'choice',{choices:pick('essential','balanced','deep')}),field('emoji',t('assistant.emoji'),'choice',{choices:pick('never','sparingly','freely')}),field('conclusionFirst',t('terminal.assistantConclusion'),'boolean'),field('useProfile',t('terminal.assistantProfile'),'boolean')];
 return editForm(ui,t('assistant.identityTitle'),{...v},fields,d=>{manager.assistant('save',a.version,d);},!a.active);
}
export async function editProfiles(manager:Management,ui:ConfigPrompter):Promise<boolean> {
 const profiles:ProfileState=manager.profiles();if(!profiles.available||!profiles.entries.length)throw new ManagementError(profiles.reason??t('profiles.noPairedUsersYetRunNamoInit'));
 const id=await ui.select(t('profiles.pairedUser'),profiles.entries.map(p=>({value:p.userId,label:`${p.name||t('profiles.nameNotSet')} · ${p.userId}`})));
 const p=profiles.entries.find(p=>p.userId===id)!;
 const type=await ui.select(t('terminal.profileAction'),[{value:'profile',label:t('design.profileIdentity')},{value:'model',label:t('design.profileModel')}]);
 if(type==='model')return editForm(ui,t('design.profileModel'),{model:p.defaultModel??''},[field('model',t('model.userDefault'),'text',{clearable:true})],d=>{manager.saveUserModel(profiles.configRevision,id,p.defaultModel??'',string(d,'model'));});
 return editForm(ui,t('design.profileIdentity'),{name:p.name,language:p.language,timezone:p.timezone},[field('name',t('profiles.preferredName'),'text',{clearable:true}),field('language',t('common.language'),'text',{clearable:true}),field('timezone',t('common.timezone'),'text',{clearable:true})],d=>{manager.saveProfile(profiles.configRevision,id,p.version,d);});
}

export async function editAssistantMenu(manager:Management,ui:ConfigPrompter):Promise<string> {
 const a=(manager.state() as {assistant?:AssistantView}).assistant;if(!a)throw new ManagementError(t('terminal.missingDb'));
 const action=await ui.select(t('terminal.menuAssistant'),[{value:'edit',label:t('terminal.assistantEdit')},{value:'preview',label:t('terminal.assistantPreview')},{value:'reset',label:t('terminal.assistantReset')}]);
 if(action==='edit')return await editAssistant(manager,ui)?t('terminal.saved'):'';
 if(action==='preview')return String(manager.assistant('preview',a.version,a.values));
 if(action==='reset'&&await ui.confirm(t('terminal.assistantReset'))){manager.assistant('reset',a.version,{});return t('terminal.saved');}
 return '';
}
export async function manageUpdates(manager:Management,ui:ConfigPrompter,view:ConfigView):Promise<string> {
 const status=await manager.codexUpdate();
 ui.info(t('terminal.updateStatus',status.currentVersion??'—',status.latestVersion??'—',status.automatic?t('terminal.yes'):t('terminal.no'),status.state));
 const action=await ui.select(t('terminal.menuUpdate'),[{value:'check',label:t('terminal.updateCheck')},{value:'automatic',label:t('terminal.updateAuto')},{value:'upgrade',label:t('terminal.updateUpgrade')},{value:'rollback',label:t('terminal.updateRollback')}]);
 if(action==='automatic') {
  const enabled=await ui.confirm(t('terminal.updateAuto'),status.automatic);
  if(enabled===status.automatic)return '';
  if(!await ui.confirm(t('terminal.confirm')))return '';
  const result=await manager.codexUpdate({action,configRevision:view.revision,enabled});return t('terminal.updateStatus',result.currentVersion??'—',result.latestVersion??'—',result.automatic?t('terminal.yes'):t('terminal.no'),result.state);
 }
 if(!await ui.confirm(t('terminal.updateConfirm')))return '';
 const result=await manager.codexUpdate({action,configRevision:view.revision});return t('terminal.updateStatus',result.currentVersion??'—',result.latestVersion??'—',result.automatic?t('terminal.yes'):t('terminal.no'),result.state);
}
