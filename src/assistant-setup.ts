import { join } from 'node:path';
import { t as tr } from './locale.js';
import type { Config } from './config.js';
import type { Prompter } from './prompts.js';
import { Store } from './store.js';
import { AssistantSettings } from './assistant.js';

export async function optionalAssistantSetup(config:Config,ui:Prompter):Promise<void>{
  if(!await ui.confirm(tr("assistantSetup.customizeAssistantIdentityNowYouCanSkip"),false))return;
  const store=new Store(join(config.dataDir,'bot.sqlite'));
  try{const settings=new AssistantSettings(store),current=settings.read(),values={...current.values};
    values.name=await ui.text(tr("assistantSetup.assistantName"),values.name);
    values.role=await ui.text(tr("assistantSetup.role"),values.role);
    values.personality=await ui.text(tr("assistantSetup.personalityWritingStyle"),values.personality);
    values.defaultLanguage=await ui.text(tr("assistantSetup.languageAutoZhCnEnUs"),values.defaultLanguage) as typeof values.defaultLanguage;
    ui.info(settings.preview(values));
    if(await ui.confirm(tr("assistantSetup.saveTheseSettingsLaterRuns"),false))settings.save(current.version,values,{kind:'local-owner',authenticated:true});
  }finally{store.close();}
}
