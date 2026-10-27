import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { t as tr } from './locale.js';
import type { Prompter } from './prompts.js';
import { loadConfig } from './config.js';
import { activeData } from './service.js';
import { inspectOpenClawSource, previewOpenClawMigration, importOpenClawMigration, cutoverManualGate, type ImportOptions } from './migration.js';

export async function migrateInteractive(file:string,ui:Prompter):Promise<void>{
  const idle=()=>{if(existsSync(file)&&activeData(loadConfig(file).dataDir))throw new Error(tr("migration.targetReceiverRunningStopExplicitlyImportingChoose"));};
  idle();
  ui.info(tr("migration.readPreviewFirstImportStopOpenclawStart"));
  const sourceFile=resolve(await ui.text(tr("migration.openclawOpenclawJsonPath")));
  const sourceInstanceId=await ui.text(tr("migration.sourceInstanceLabel"));
  const inspection=inspectOpenClawSource({sourceFile,sourceInstanceId});ui.info(JSON.stringify(inspection,null,2));
  if(inspection.status!=='supported')return;
  const accountId=await ui.text(tr("migration.accountIdPreviewExactSelection"));
  const preview=previewOpenClawMigration({sourceFile,sourceInstanceId,accountId,targetConfigFile:file});ui.info(JSON.stringify(preview,null,2));
  const options:ImportOptions={conflictResolutions:{},permissions:{users:'keep-target',chats:'keep-target',mention:'require'},approvedCandidateIds:[]};
  for(const conflict of preview.conflicts)options.conflictResolutions![conflict.path]=await ui.confirm(tr("migration.replaceSourceValue",conflict.path),false)?'use-source':'keep-target';
  if(await ui.confirm(tr("migration.importReviewedSourceUserAllowlist"),false))options.permissions!.users='use-source';
  if(await ui.confirm(tr("migration.importReviewedSourceChatAllowlist"),false))options.permissions!.chats='use-source';
  if(preview.proposed.workspaceProjectAvailable)options.project={importWorkspace:await ui.confirm(tr("migration.importSourceWorkspaceProject"),false),projectName:preview.proposed.projectName};
  for(const candidate of preview.candidates)if(await ui.confirm(tr("migration.copyReviewCandidate",candidate.name),false))options.approvedCandidateIds!.push(candidate.id);
  if(!await ui.confirm(tr("migration.applyExactPreviewTargetConfiguration"),false))return;
  idle();const result=importOpenClawMigration(preview,{sourceFile,options});ui.info(JSON.stringify(result,null,2));
  ui.info(cutoverManualGate(result.record).join('\n'));
}
