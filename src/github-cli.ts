import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView, GitHubConfigPatch } from './ui-contract.js';

export async function configureGitHub(file:string,ui:Prompter,manager=new Management(file)):Promise<void> {
  const config:ConfigView=manager.config(),profiles=manager.profiles();
  const local=await ui.confirm(tr('使用本机 gh 登录（无需另建令牌）？'),true);
  const anonymous=!local&&await ui.confirm(tr('仅使用公开仓库（停用私有访问）？'),false);
  let ownerId=config.github?.ownerUserId;
  const owners=config.feishu.allowedUserIds??[];
  if(!anonymous){
    if(!owners.includes(ownerId??''))ownerId=owners.length===1?owners[0]:undefined;
    if(!ownerId)for(const id of owners){
      const profile=profiles.entries.find(p=>p.userId===id);
      if(await ui.confirm(tr('将 {0} 设为本人飞书账号？',profile?.name||id),false)){ownerId=id;break;}
    }
    if(!ownerId){ui.info(tr('未保存更改'));return;}
    ui.info(tr('群聊：只读访问该 GitHub 账号有权访问的仓库。'));
    ui.info(tr('本人私聊：可以创建、修改、合并、发布及管理 GitHub 资源，以账号实际权限为准。'));
    ui.info(tr('其他人的私聊不使用此账号。无需逐仓库或逐群授权；群聊仍受服务接入范围限制。'));
  }
  const newGithubToken=local||anonymous?'':await ui.text(tr('新 GitHub 令牌（隐藏输入，留空保留）'),'',true);
  if(!await ui.confirm(tr('保存 GitHub 连接配置？'),false)){ui.info(tr('未保存更改'));return;}
  const patch:GitHubConfigPatch={github:{source:local?'gh':anonymous?'anonymous':'token',repositories:[],allowedUserIds:[],
    ...(anonymous?{}:{mode:'simple',ownerUserId:ownerId})},...(newGithubToken?{newGithubToken}:{})};
  await manager.saveGitHub(config.revision,patch);
  ui.info(tr('GitHub 配置已保存，请应用服务配置。新的工作线使用更新后的权限。'));
}
