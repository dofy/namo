import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Text, TextField } from '@radix-ui/themes';
import { api } from '../api';
import { Choice, Field } from '../components';
import { t as tr } from '../i18n';

type Catalog = { models: {id:string;name:string;isDefault:boolean}[]; loading:boolean; failed:boolean };
const ModelCatalogContext = createContext<Catalog>({models:[],loading:false,failed:false});
/** Both selectors share one discovery request per saved configuration. */
export function ModelCatalogProvider({revision,children}:{revision:string;children:ReactNode}) {
  const [catalog,setCatalog]=useState<Catalog>({models:[],loading:true,failed:false});
  useEffect(()=>{
    const controller=new AbortController();setCatalog({models:[],loading:true,failed:false});
    void api.models(controller.signal).then(models=>{if(!controller.signal.aborted)setCatalog({models,loading:false,failed:false});})
      .catch(()=>{if(!controller.signal.aborted)setCatalog({models:[],loading:false,failed:true});});
    return()=>controller.abort();
  },[revision]);
  return <ModelCatalogContext.Provider value={catalog}>{children}</ModelCatalogContext.Provider>;
}
export function ModelSelect({id,label,value,onChange,disabled,inheritLabel,resetKey}:{
  id:string;label:string;value:string;onChange:(value:string)=>void;disabled?:boolean;inheritLabel:string;resetKey:string;
}) {
  const {models,loading,failed}=useContext(ModelCatalogContext);
  const [custom,setCustom]=useState(false);
  useEffect(()=>setCustom(false),[resetKey]);
  return <div className="model-select">
    <Field label={label} htmlFor={id}><Choice id={id} value={custom?'custom':value?`model:${value}`:'inherit'} disabled={disabled}
      onChange={next=>{setCustom(next==='custom');if(next!=='custom')onChange(next==='inherit'?'':next.slice(6));}}
      options={[{value:'inherit',label:inheritLabel},...models.map(model=>({value:`model:${model.id}`,label:model.name})),
        ...(value&&!models.some(model=>model.id===value)?[{value:`model:${value}`,label:value}]:[]),{value:'custom',label:tr('model.custom')}]} /></Field>
    {custom&&<Field label={tr('model.customId')} htmlFor={`${id}-custom`}><TextField.Root id={`${id}-custom`} value={value} maxLength={128} required autoComplete="off" placeholder={tr('model.customPlaceholder')} disabled={disabled} onChange={event=>onChange(event.target.value)} /></Field>}
    {loading&&<Text as="p" size="1" color="gray">{tr('model.loading')}</Text>}
    {failed&&<Text as="p" size="1" color="gray">{tr('model.catalogUnavailable')}</Text>}
  </div>;
}
