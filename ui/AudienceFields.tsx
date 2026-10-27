import { Checkbox, Flex, Text, TextArea } from '@radix-ui/themes';
import type { Audience } from '../src/access-contract';
import { Field } from './components';
import { t as tr } from './i18n';
import { useEffect, useState } from 'react';
export const emptyAudience = ():Audience => ({organization:false,userIds:[],chatIds:[]});
export const splitIds = (text:string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
export function IdentityInput({id,value,onChange,disabled}:{id:string;value:string[];onChange:(ids:string[])=>void;disabled?:boolean}) {
  const [text,setText]=useState(value.join('\n'));
  useEffect(()=>{if(JSON.stringify(splitIds(text))!==JSON.stringify(value))setText(value.join('\n'));},[value]);
  return <TextArea id={id} disabled={disabled} rows={2} value={text} onChange={e=>{setText(e.target.value);onChange(splitIds(e.target.value));}}/>;
}
export function AudienceFields({value,onChange,id}:{value:Audience;onChange:(v:Audience)=>void;id:string}) {
  return <>
    <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={value.organization} onCheckedChange={v=>onChange({...value,organization:v===true})}/>{tr('整个组织（包括群聊）')}</Flex></Text>
    <div className="form-grid">
      <Field label={tr('指定成员私聊（open_id）')} htmlFor={`${id}-users`}><IdentityInput id={`${id}-users`} disabled={value.organization} value={value.userIds} onChange={ids=>onChange({...value,userIds:ids})}/></Field>
      <Field label={tr('指定群（chat_id）')} htmlFor={`${id}-chats`}><IdentityInput id={`${id}-chats`} disabled={value.organization} value={value.chatIds} onChange={ids=>onChange({...value,chatIds:ids})}/></Field>
    </div>
    <Text as="p" size="1" color="gray">{tr('群授权允许向该群展示资源内容。未选择组织且名单为空时，不开放访问。')}</Text>
  </>;
}
