import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView, GitHubConfigPatch } from './ui-contract.js';

export async function configureGitHub(file:string,ui:Prompter):Promise<void> {
  const manager=new Management(file),config:ConfigView=manager.config(),profiles=manager.profiles();
  if(!profiles.available||!profiles.entries.length)throw new Error(tr('请先完成应用配置和用户配对'));
  const current=config.github;
  ui.info(tr('GitHub 凭据仅用于指定仓库的检查状态读取，不交给模型，也不授权推送。'));
  ui.info(tr('细粒度令牌请仅授予所选仓库的 Checks、Commit statuses 和 Pull requests 读取权限。'));
  const repositories=(await ui.text(tr('仓库（owner/repo，逗号分隔；输入 - 清空）'),current?.repositories.join(',')??''));
  const allowedUserIds:string[]=[];
  for(const profile of profiles.entries){
    if(await ui.confirm(tr('允许 {0} 在私聊中读取这些仓库？',`${profile.name||profile.userId} (${profile.userId})`),current?.allowedUserIds.includes(profile.userId)??false))allowedUserIds.push(profile.userId);
  }
  const clear=!!current?.credentialConfigured&&await ui.confirm(tr('清除已有 GitHub 凭据？'),false);
  const newGithubToken=clear?'':await ui.text(tr('新 GitHub 令牌（隐藏输入，留空保留）'),'',true);
  const patch:GitHubConfigPatch={github:{repositories:repositories==='-'?[]:repositories.split(',').map(x=>x.trim()).filter(Boolean),allowedUserIds},
    ...(clear?{clearGithubToken:true}:newGithubToken?{newGithubToken}:{})};
  ui.info(tr('仓库：{0}',patch.github.repositories.join(', ')||tr('无')));
  ui.info(tr('授权用户：{0}',allowedUserIds.length));
  if(!await ui.confirm(tr('保存 GitHub 连接配置？'),false)){ui.info(tr('未保存更改'));return;}
  manager.save(config.revision,patch);
  ui.info(tr('GitHub 配置已保存，下次检查轮询生效。'));
}
