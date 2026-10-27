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
    <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={value.organization} onCheckedChange={v=>onChange({...value,organization:v===true})}/>{tr("audience.entireOrganizationIncludingGroups")}</Flex></Text>
    <div className="form-grid">
      <Field label={tr("audience.selectedMembersDirectMessagesOpenId")} htmlFor={`${id}-users`}><IdentityInput id={`${id}-users`} disabled={value.organization} value={value.userIds} onChange={ids=>onChange({...value,userIds:ids})}/></Field>
      <Field label={tr("audience.selectedGroupsChatId")} htmlFor={`${id}-chats`}><IdentityInput id={`${id}-chats`} disabled={value.organization} value={value.chatIds} onChange={ids=>onChange({...value,chatIds:ids})}/></Field>
    </div>
    <Text as="p" size="1" color="gray">{tr("audience.groupGrantAllowsResourceContentSharedGroup")}</Text>
  </>;
}
