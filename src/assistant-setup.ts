import { join } from 'node:path';
import { currentLocale } from './locale.js';
import type { Config } from './config.js';
import type { Prompter } from './prompts.js';
import { Store } from './store.js';
import { AssistantSettings } from './assistant.js';

export async function optionalAssistantSetup(config:Config,ui:Prompter):Promise<void>{
  const text=(en:string,zh:string)=>currentLocale()==='zh-CN'?zh:en;
  if(!await ui.confirm(text('Customize assistant identity now? You can skip and use the workbench later.','现在配置助手身份？可以跳过，稍后在工作台调整。'),false))return;
  const store=new Store(join(config.dataDir,'bot.sqlite'));
  try{const settings=new AssistantSettings(store),current=settings.read(),values={...current.values};
    values.name=await ui.text(text('Assistant name','助手名称'),values.name);
    values.role=await ui.text(text('Role','角色'),values.role);
    values.personality=await ui.text(text('Personality and writing style','性格与表达风格'),values.personality);
    values.defaultLanguage=await ui.text(text('Language: auto / zh-CN / en-US','语言：auto / zh-CN / en-US'),values.defaultLanguage) as typeof values.defaultLanguage;
    ui.info(settings.preview(values));
    if(await ui.confirm(text('Save these settings for later runs?','保存这些设置，用于后续运行？'),false))settings.save(current.version,values,{kind:'local-owner',authenticated:true});
  }finally{store.close();}
}
