import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView } from './ui-contract.js';
export async function configureAccess(file:string,ui:Prompter,manager=new Management(file)):Promise<void> {
  const c:ConfigView=manager.config();
  const organization=await ui.confirm(tr('允许当前飞书组织的成员使用服务？'),true);
  const tenant=organization?await manager.organization():undefined;
  if(tenant)ui.info(tr('组织：{0}',tenant.name));
  const ids=(text:string)=>text.split(/[\s,]+/).filter(Boolean);
  const allowedUserIds=organization?c.feishu.allowedUserIds??[]:ids(await ui.text(tr('允许的成员（open_id）'),c.feishu.allowedUserIds?.join(',')??''));
  const allowedChatIds=ids(await ui.text(tr('限制接入的聊天（留空不限制）'),c.feishu.allowedChatIds?.join(',')??''));
  ui.info(tr('组织成员默认使用隔离工作区。项目共享范围可在工作台配置。'));
  if(!await ui.confirm(tr('保存访问配置？'),false)){ui.info(tr('未保存更改'));return;}
  manager.save(c.revision,{serviceAccess:{access:tenant?{mode:'organization',tenantKey:tenant.tenantKey}:null,allowedUserIds,allowedChatIds}});
  ui.info(tr('配置已保存，需要应用配置后启用组织接入。'));
}
