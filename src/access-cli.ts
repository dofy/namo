import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView } from './ui-contract.js';
export async function configureAccess(file:string,ui:Prompter,manager=new Management(file)):Promise<void> {
  const c:ConfigView=manager.config();
  const organization=await ui.confirm(tr("accessCli.allowMembersFeishuOrganizationUseService"),true);
  const tenant=organization?await manager.organization():undefined;
  if(tenant)ui.info(tr("accessCli.organization",tenant.name));
  const ids=(text:string)=>text.split(/[\s,]+/).filter(Boolean);
  const allowedUserIds=organization?c.feishu.allowedUserIds??[]:ids(await ui.text(tr("common.allowedMembersOpenId"),c.feishu.allowedUserIds?.join(',')??''));
  const allowedChatIds=ids(await ui.text(tr("common.restrictChatsLeaveEmptyAllChats"),c.feishu.allowedChatIds?.join(',')??''));
  ui.info(tr("accessCli.organizationMembersUseIsolatedWorkspacesDefaultConfigure"));
  if(!await ui.confirm(tr("accessCli.saveAccessSettings"),false)){ui.info(tr("common.changesWereNotSaved"));return;}
  manager.save(c.revision,{serviceAccess:{access:tenant?{mode:'organization',tenantKey:tenant.tenantKey}:null,allowedUserIds,allowedChatIds}});
  ui.info(tr("common.settingsSavedApplyConfigurationActivateOrganizationAccess"));
}
