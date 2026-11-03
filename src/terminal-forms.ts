import { Back, type ConfigPrompter } from './config-prompts.js';
import { ManagementError } from './management.js';
import { t } from './locale.js';

export type Field = { key:string; label:string; kind:'text'|'multiline'|'secret'|'number'|'boolean'|'list'|'choice'; choices?:{value:string;label:string}[]; clearable?:boolean };
export type Draft = Record<string,string|number|boolean|string[]>;
const safe = (value:string) => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,' ').slice(0,120);
function shown(field:Field,value:Draft[string]):string {
 if(field.kind==='secret')return value ? '••••' : '—';
 if(field.kind==='choice')return safe(field.choices?.find(option=>option.value===value)?.label??String(value??'')) || '—';
 if(Array.isArray(value))return value.length ? value.map(safe).join('; ') : '—';
 if(typeof value==='boolean')return value?t('terminal.yes'):t('terminal.no');
 return safe(String(value ?? '')) || '—';
}
/** Edit in memory; only the explicit save option invokes the version-checked writer. */
export async function editForm(ui:ConfigPrompter,title:string,initial:Draft,fields:Field[],save:(draft:Draft,changed:ReadonlySet<string>)=>void|Promise<void>, allowUnchanged=false,context=''):Promise<boolean> {
 const draft=structuredClone(initial);let notice='';let dirty=false;let active=fields[0]?.key;
 for (;;) {
  ui.screen?.();if(context)ui.info(context);if(notice){ui.info(notice);notice='';}
  let selected:string;
  try {selected=await ui.select(dirty?`${title} · ${t('common.unsavedChanges')}`:title,[...fields.map(f=>({value:f.key,label:f.label,detail:shown(f,draft[f.key]),changed:JSON.stringify(draft[f.key])!==JSON.stringify(initial[f.key])})),
   {value:'$save',label:t('terminal.actionSave'),action:true,shortcut:'S'},{value:'$back',label:t('terminal.actionBack'),action:true,shortcut:'Esc'}],active);active=selected;}
  catch(error){if(!(error instanceof Back))throw error;selected='$back';}
  if(selected==='$back'){
   if(!dirty)return false;
   try {if(await ui.confirm(t('terminal.discard')))return false;}catch(error){if(!(error instanceof Back))throw error;}
   continue;
  }
  if(selected==='$save'){
   if(!dirty&&!allowUnchanged){notice=t('terminal.noChanges');continue;}
   try {
    if(!await ui.confirm(t('terminal.confirm')))continue;
    const changed=new Set(fields.filter(f=>JSON.stringify(draft[f.key])!==JSON.stringify(initial[f.key])).map(f=>f.key));
    await save(draft,changed);return true;
   }catch(error){if(error instanceof Back)continue;if(error instanceof ManagementError){notice=error.message;continue;}throw error;}
  }
  const field=fields.find(f=>f.key===selected);if(!field)continue;
  try {
   const old=draft[field.key];let next:Draft[string];
   if(field.kind==='boolean')next=await ui.confirm(field.label,old===true);
   else if(field.kind==='choice')next=await ui.select(field.label,field.choices??[],String(old));
   else {
    if(field.clearable && old && await ui.select(field.label,[{value:'edit',label:t('terminal.formEdit')},{value:'clear',label:t('terminal.formClear')}])==='clear') {
      next=field.kind==='list'?[]:'';
    } else {
      const current=field.kind==='secret'?'':Array.isArray(old)?old.join(';'):field.kind==='multiline'?String(old??'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n'):String(old??'');
      const input=await ui.text(field.label,current,field.kind==='secret');
      next=field.kind==='number'?Number(input):field.kind==='list'?input.split(';').map(x=>x.trim()).filter(Boolean):field.kind==='multiline'?input.replace(/\\(n|\\)/g,(_match,char:string)=>char==='n'?'\n':'\\'):input;
      if(field.kind==='secret'&&!input)continue;
    }
   }
   if(JSON.stringify(next)!==JSON.stringify(old)){draft[field.key]=next;dirty=true;}
  }catch(error){if(error instanceof Back)continue;throw error;}
 }
}
