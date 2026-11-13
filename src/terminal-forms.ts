import { Back, Home, parseSelectedAction, type ConfigPrompter, type Option } from './config-prompts.js';
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
function listOptions(field:Field,entries:string[],original:string[]):Option[] {
 if(!entries.length)return [{value:`$list:${field.key}:empty`,label:t('terminal.listEmpty'),disabled:true,availableActions:['$add']}];
 return entries.map((entry,index)=>({value:`$list:${field.key}:${index}`,label:safe(entry),
  changed:entries.slice(0,index+1).filter(item=>item===entry).length>original.filter(item=>item===entry).length,
  availableActions:['$edit','$delete','$add']}));
}
function listShortcuts(field:Field,hasEntries:boolean):Option[] {
 return [...(hasEntries?[{value:'$edit',label:t('terminal.listEditSelected'),action:true,shortcut:'E',targeted:true}]:[]),
  {value:'$add',label:t('terminal.listAddAction',field.label),action:true,shortcut:'A',targeted:true},
  ...(hasEntries?[{value:'$delete',label:t('terminal.listDeleteSelected'),action:true,shortcut:'D',targeted:true}]:[])];
}
async function updateList(ui:ConfigPrompter,entries:string[],selected:string,action:string|undefined):Promise<{entries:string[];index:number}|undefined> {
 const next=[...entries],index=Number(selected.slice(selected.lastIndexOf(':')+1));
 if(action==='$add'){
  ui.screen?.();const value=await ui.text(t('terminal.listNew'));if(!value)return;
  next.push(value);return {entries:next,index:next.length-1};
 }
 if(!Number.isInteger(index)||index<0||index>=next.length)return;
 if(action==='$delete')next.splice(index,1);
 else {ui.screen?.();next[index]=await ui.text(t('terminal.listEdit'),next[index]);}
 return {entries:next,index:Math.min(index,Math.max(0,next.length-1))};
}
async function goHome(ui:ConfigPrompter,error:Home,dirty:boolean):Promise<void> {
 if(!dirty||error.confirmed)throw error;
 for(;;){
  try {ui.screen?.();if(await ui.confirm(t('terminal.discard')))throw new Home(true);return;}
  catch(confirmError){if(confirmError instanceof Home && !confirmError.confirmed)continue;if(confirmError instanceof Back)return;throw confirmError;}
 }
}
async function editList(ui:ConfigPrompter,field:Field,initial:string[],parentDirty:()=>boolean):Promise<string[]> {
 let entries=[...initial],active:string|undefined;
 for(;;){
  ui.screen?.();let selected:string;
  try {selected=await ui.select(field.label,[...listOptions(field,entries,initial),...listShortcuts(field,entries.length>0),{value:'$back',label:t('terminal.actionBack'),action:true,shortcut:'Esc'}],active);}
  catch(error){if(error instanceof Back)return entries;if(error instanceof Home){await goHome(ui,error,parentDirty()||JSON.stringify(entries)!==JSON.stringify(initial));continue;}throw error;}
  if(selected==='$back')return entries;
  const target=parseSelectedAction(selected);if(target)selected=target[1];active=selected;
  try {const result=await updateList(ui,entries,selected,target?.[0]);if(result){entries=result.entries;active=entries.length?`$list:${field.key}:${result.index}`:`$list:${field.key}:empty`;}}
  catch(error){if(error instanceof Home){await goHome(ui,error,parentDirty()||JSON.stringify(entries)!==JSON.stringify(initial));continue;}if(!(error instanceof Back))throw error;}
 }
}
/** Edit in memory; only the explicit save option invokes the version-checked writer. */
export async function editForm(ui:ConfigPrompter,title:string,initial:Draft,fields:Field[],save:(draft:Draft,changed:ReadonlySet<string>)=>void|Promise<void>, allowUnchanged=false,context=''):Promise<boolean> {
 const draft=structuredClone(initial);let notice='';let dirty=false;let active=fields[0]?.key;
 for (;;) {
  ui.screen?.();if(context)ui.info(context);if(notice){ui.info(notice);notice='';}
  const singleList=fields.length===1&&fields[0].kind==='list'?fields[0]:undefined;
  const options:Option[]=singleList?listOptions(singleList,draft[singleList.key] as string[],initial[singleList.key] as string[]):fields.map(f=>({value:f.key,label:f.label,
   detail:f.kind==='list'?t('terminal.listCount',(draft[f.key] as string[]).length):shown(f,draft[f.key]),
   changed:JSON.stringify(draft[f.key])!==JSON.stringify(initial[f.key]),availableActions:['$edit',...(f.kind!=='list'&&f.clearable&&draft[f.key]?['$clear']:[])]}));
  const clearable=fields.some(f=>f.kind!=='list'&&f.clearable);
  let selected:string;
  try {selected=await ui.select(dirty?`${title} · ${t('common.unsavedChanges')}`:title,[...options,
   ...(singleList?listShortcuts(singleList,(draft[singleList.key] as string[]).length>0):[{value:'$edit',label:t('terminal.listEditSelected'),action:true,shortcut:'E',targeted:true}]),
   ...(clearable?[{value:'$clear',label:t('terminal.clearSelected'),action:true,shortcut:'X',targeted:true}]:[]),
   {value:'$save',label:t('terminal.saveAll'),action:true,shortcut:'S'},{value:'$back',label:t('terminal.actionBack'),action:true,shortcut:'Esc'}],active);}
  catch(error){if(error instanceof Home){await goHome(ui,error,dirty);continue;}if(!(error instanceof Back))throw error;selected='$back';}
  const target=parseSelectedAction(selected);if(target){selected=target[1];active=selected;}
  else if(selected!=='$save'&&selected!=='$back')active=selected;
  if(selected==='$back'){
   if(!dirty)return false;
   try {ui.screen?.();if(await ui.confirm(t('terminal.discard')))return false;}catch(error){if(error instanceof Home){await goHome(ui,error,dirty);continue;}if(!(error instanceof Back))throw error;}
   continue;
  }
  if(selected==='$save'){
   if(!dirty&&!allowUnchanged){notice=t('terminal.noChanges');continue;}
   try {
    ui.screen?.();if(!await ui.confirm(t('terminal.confirm')))continue;
    const changed=new Set(fields.filter(f=>JSON.stringify(draft[f.key])!==JSON.stringify(initial[f.key])).map(f=>f.key));
    await save(draft,changed);return true;
   }catch(error){if(error instanceof Home){await goHome(ui,error,dirty);continue;}if(error instanceof Back)continue;if(error instanceof ManagementError){notice=error.message;continue;}throw error;}
  }
  if(singleList){
   try {
    const result=await updateList(ui,draft[singleList.key] as string[],selected,target?.[0]);if(!result)continue;
    draft[singleList.key]=result.entries;
    dirty=JSON.stringify(result.entries)!==JSON.stringify(initial[singleList.key]);
    active=result.entries.length?`$list:${singleList.key}:${result.index}`:`$list:${singleList.key}:empty`;
   }catch(error){if(error instanceof Home){await goHome(ui,error,dirty);continue;}if(!(error instanceof Back))throw error;}
   continue;
  }
  const field=fields.find(f=>f.key===selected);if(!field)continue;
  try {
   const old=draft[field.key];let next:Draft[string];
   ui.screen?.();
   if(field.kind==='list')next=await editList(ui,field,old as string[],()=>dirty);
   else if(target?.[0]==='$clear'&&field.clearable)next='';
   else if(field.kind==='boolean')next=await ui.confirm(field.label,old===true);
   else if(field.kind==='choice')next=await ui.select(field.label,field.choices??[],String(old));
   else {
      const current=field.kind==='secret'?'':Array.isArray(old)?old.join(';'):field.kind==='multiline'?String(old??'').replace(/\\/g,'\\\\').replace(/\n/g,'\\n'):String(old??'');
      ui.screen?.();const input=await ui.text(field.label,current,field.kind==='secret');
      next=field.kind==='number'?Number(input):field.kind==='multiline'?input.replace(/\\(n|\\)/g,(_match,char:string)=>char==='n'?'\n':'\\'):input;
      if(field.kind==='secret'&&!input)continue;
   }
   if(JSON.stringify(next)!==JSON.stringify(old)){draft[field.key]=next;dirty=fields.some(f=>JSON.stringify(draft[f.key])!==JSON.stringify(initial[f.key]));}
  }catch(error){if(error instanceof Home){await goHome(ui,error,dirty);continue;}if(error instanceof Back)continue;throw error;}
 }
}
