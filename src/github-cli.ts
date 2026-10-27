import { Management } from './management.js';
import type { Prompter } from './prompts.js';
import { t as tr } from './locale.js';
import type { ConfigView, GitHubConfigPatch } from './ui-contract.js';

export async function configureGitHub(file:string,ui:Prompter,manager=new Management(file)):Promise<void> {
  const config:ConfigView=manager.config(),profiles=manager.profiles();
  const local=await ui.confirm(tr("githubCli.useLocalGhLoginNoSeparateToken"),true);
  const anonymous=!local&&await ui.confirm(tr("githubCli.usePublicRepositoriesDisablePrivateAccess"),false);
  let ownerId=config.github?.ownerUserId;
  const owners=config.feishu.allowedUserIds??[];
  if(!anonymous){
    if(!owners.includes(ownerId??''))ownerId=owners.length===1?owners[0]:undefined;
    if(!ownerId)for(const id of owners){
      const profile=profiles.entries.find(p=>p.userId===id);
      if(await ui.confirm(tr("githubCli.useFeishuAccount",profile?.name||id),false)){ownerId=id;break;}
    }
    if(!ownerId){ui.info(tr("common.changesWereNotSaved"));return;}
    ui.info(tr("common.groupsReadAccessRepositoriesAvailableGithubAccount"));
    ui.info(tr("common.privateChatCreateEditMergePublishManage"));
    ui.info(tr("common.otherPrivateChatsCannotUseAccountNo"));
  }
  const newGithubToken=local||anonymous?'':await ui.text(tr("githubCli.newGithubTokenHiddenInputLeaveBlank"),'',true);
  if(!await ui.confirm(tr("githubCli.saveGithubConnectionSettings"),false)){ui.info(tr("common.changesWereNotSaved"));return;}
  const patch:GitHubConfigPatch={github:{source:local?'gh':anonymous?'anonymous':'token',repositories:[],allowedUserIds:[],
    ...(anonymous?{}:{mode:'simple',ownerUserId:ownerId})},...(newGithubToken?{newGithubToken}:{})};
  await manager.saveGitHub(config.revision,patch);
  ui.info(tr("github.settingsSavedApplyService"));
}
