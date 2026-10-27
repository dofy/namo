import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView, GitHubConfigPatch } from './ui-contract.js';

export async function configureGitHub(file:string,ui:Prompter,manager=new Management(file)):Promise<void> {
  const config:ConfigView=manager.config(),profiles=manager.profiles();
  if(config.feishu.access || config.github?.grants) {
    const local=await ui.confirm(tr('使用本机 gh 登录（无需另建令牌）？'),true);
    const anonymous=!local&&await ui.confirm(tr('仅使用公开仓库（停用私有访问）？'),false);
    const ids=(s:string)=>s.split(/[\s,]+/).filter(Boolean);
    const repositories=ids(await ui.text(tr('共享仓库（owner/repo，逗号分隔）'),config.github?.grants?.map(g=>g.repository).join(',')??''));
    const grants=[];
    for(const repository of repositories) {
      ui.info(repository);
      const organization=await ui.confirm(tr('整个组织（包括群聊）'),false);
      const chatIds=organization?[]:ids(await ui.text(tr('指定群（chat_id）'),''));
      const userIds=organization?[]:ids(await ui.text(tr('指定成员私聊（open_id）'),''));
      grants.push({repository,organization,chatIds,userIds});
    }
    const newGithubToken=local||anonymous?'':await ui.text(tr('新 GitHub 令牌（隐藏输入，留空保留）'),'',true);
    ui.info(tr('群授权允许向该群展示资源内容。未选择组织且名单为空时，不开放访问。'));
    if(!await ui.confirm(tr('保存 GitHub 连接配置？'),false)){ui.info(tr('未保存更改'));return;}
    await manager.saveGitHub(config.revision,{github:{source:local?'gh':anonymous?'anonymous':'token',repositories:[],allowedUserIds:[],grants},...(newGithubToken?{newGithubToken}:{})});
    ui.info(tr('GitHub 配置已保存，下次检查轮询生效。'));return;
  }
  if(!profiles.available||!profiles.entries.length)throw new Error(tr('请先完成应用配置和用户配对'));
  const current=config.github;
  if (await ui.confirm(tr('使用本机 gh 登录（无需另建令牌）？'),true)) {
    let ownerId=profiles.entries.length===1?profiles.entries[0].userId:undefined;
    if (!ownerId) {
      for (const profile of profiles.entries) if (await ui.confirm(tr('允许 {0} 在私聊中读取这些仓库？',profile.name||profile.userId),false)) {ownerId=profile.userId;break;}
    }
    if (!ownerId) {ui.info(tr('未保存更改'));return;}
    ui.info(tr('本机登录可读取该账号有权访问的仓库，只对所选用户的私聊生效。'));
    if (!await ui.confirm(tr('保存 GitHub 连接配置？'),false)) {ui.info(tr('未保存更改'));return;}
    const saved=await manager.saveGitHub(config.revision,{github:{source:'gh',repositories:[],allowedUserIds:[ownerId]}});
    ui.info(tr('已连接本机 GitHub 账号：{0}',saved.github.localGh.login));return;
  }
  if (await ui.confirm(tr('仅使用公开仓库（停用私有访问）？'),false)) {
    if (!await ui.confirm(tr('保存 GitHub 连接配置？'),false)) {ui.info(tr('未保存更改'));return;}
    manager.save(config.revision,{github:{source:'anonymous',repositories:[],allowedUserIds:[]}});
    ui.info(tr('GitHub 配置已保存，下次检查轮询生效。'));return;
  }
  ui.info(tr('GitHub 凭据仅用于指定仓库的检查状态读取，不交给模型，也不授权推送。'));
  ui.info(tr('细粒度令牌请仅授予所选仓库的 Checks、Commit statuses 和 Pull requests 读取权限。'));
  const repositories=(await ui.text(tr('仓库（owner/repo，逗号分隔；输入 - 清空）'),current?.repositories.join(',')??''));
  const allowedUserIds:string[]=[];
  for(const profile of profiles.entries){
    if(await ui.confirm(tr('允许 {0} 在私聊中读取这些仓库？',`${profile.name||profile.userId} (${profile.userId})`),current?.allowedUserIds.includes(profile.userId)??false))allowedUserIds.push(profile.userId);
  }
  const clear=!!current?.credentialConfigured&&await ui.confirm(tr('清除已有 GitHub 凭据？'),false);
  const newGithubToken=clear?'':await ui.text(tr('新 GitHub 令牌（隐藏输入，留空保留）'),'',true);
  const patch:GitHubConfigPatch={github:{source:'token',repositories:repositories==='-'?[]:repositories.split(',').map(x=>x.trim()).filter(Boolean),allowedUserIds},
    ...(clear?{clearGithubToken:true}:newGithubToken?{newGithubToken}:{})};
  ui.info(tr('仓库：{0}',patch.github.repositories.join(', ')||tr('无')));
  ui.info(tr('授权用户：{0}',allowedUserIds.length));
  if(!await ui.confirm(tr('保存 GitHub 连接配置？'),false)){ui.info(tr('未保存更改'));return;}
  manager.save(config.revision,patch);
  ui.info(tr('GitHub 配置已保存，下次检查轮询生效。'));
}
