import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentLocale } from './locale.js';
import type { Prompter } from './prompts.js';
import { loadConfig } from './config.js';
import { activeData } from './service.js';
import { inspectOpenClawSource, previewOpenClawMigration, importOpenClawMigration, cutoverManualGate, type ImportOptions } from './migration.js';

export async function migrateInteractive(file:string,ui:Prompter):Promise<void>{
  const say=(en:string,zh:string)=>currentLocale()==='zh-CN'?zh:en;
  const idle=()=>{if(existsSync(file)&&activeData(loadConfig(file).dataDir))throw new Error(say('Target receiver is running. Stop it explicitly before importing, or choose a separate configuration.','目标接收端正在运行。导入前请明确停止该实例，或指定另一份独立配置。'));};
  idle();
  ui.info(say('Read-only preview first. Import does not stop OpenClaw or start Namo.','先进行只读预览。导入不会停止 OpenClaw，也不会启动 Namo。'));
  const sourceFile=resolve(await ui.text(say('OpenClaw openclaw.json path','OpenClaw openclaw.json 路径')));
  const sourceInstanceId=await ui.text(say('Source instance label','来源实例名称'));
  const inspection=inspectOpenClawSource({sourceFile,sourceInstanceId});ui.info(JSON.stringify(inspection,null,2));
  if(inspection.status!=='supported')return;
  const accountId=await ui.text(say('Account ID from the preview (exact selection)','预览中的 account ID（明确选择）'));
  const preview=previewOpenClawMigration({sourceFile,sourceInstanceId,accountId,targetConfigFile:file});ui.info(JSON.stringify(preview,null,2));
  const options:ImportOptions={conflictResolutions:{},permissions:{users:'keep-target',chats:'keep-target',mention:'require'},approvedCandidateIds:[]};
  for(const conflict of preview.conflicts)options.conflictResolutions![conflict.path]=await ui.confirm(say(`Replace ${conflict.path} with the source value?`,`用来源值替换 ${conflict.path}？`),false)?'use-source':'keep-target';
  if(await ui.confirm(say('Import the reviewed source user allowlist?','导入已核对的来源用户白名单？'),false))options.permissions!.users='use-source';
  if(await ui.confirm(say('Import the reviewed source chat allowlist?','导入已核对的来源会话白名单？'),false))options.permissions!.chats='use-source';
  if(preview.proposed.workspaceProjectAvailable)options.project={importWorkspace:await ui.confirm(say('Import the source workspace as a project?','将来源工作目录导入为项目？'),false),projectName:preview.proposed.projectName};
  for(const candidate of preview.candidates)if(await ui.confirm(say(`Copy ${candidate.name} as a pending-review candidate (not active memory)?`,`把 ${candidate.name} 复制为待审核候选（不会启用为记忆）？`),false))options.approvedCandidateIds!.push(candidate.id);
  if(!await ui.confirm(say('Apply this exact preview to the target configuration?','将这份明确的预览写入目标配置？'),false))return;
  idle();const result=importOpenClawMigration(preview,{sourceFile,options});ui.info(JSON.stringify(result,null,2));
  ui.info(cutoverManualGate(result.record).join('\n'));
}
