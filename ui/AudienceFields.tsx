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
export function AudienceFields({value,onChange,id,members=[]}:{value:Audience;onChange:(v:Audience)=>void;id:string;members?:{id:string;label:string}[]}) {
  return <>
    <Text as="label" size="2"><Flex gap="2" align="center"><Checkbox checked={value.organization} onCheckedChange={v=>onChange({...value,organization:v===true})}/>{tr("audience.entireOrganizationIncludingGroups")}</Flex></Text>
    {members.length>0&&<div className="audience-members"><Text as="p" size="2" weight="medium">{tr('audienceAccess.pairedMembers')}</Text><div className="audience-member-list">{members.map(member=><Text as="label" size="2" key={member.id}><Flex gap="2" align="center"><Checkbox disabled={value.organization} checked={value.userIds.includes(member.id)} onCheckedChange={checked=>onChange({...value,userIds:checked===true?[...new Set([...value.userIds,member.id])]:value.userIds.filter(x=>x!==member.id)})}/>{member.label}</Flex></Text>)}</div></div>}
    <AudienceIds id={id} value={value} onChange={onChange}/>
    <Text as="p" size="1" color="gray">{tr("audience.groupGrantAllowsResourceContentSharedGroup")}</Text>
  </>;
}
function AudienceIds({value,onChange,id}:{value:Audience;onChange:(v:Audience)=>void;id:string}) {
  return <>
    <div className="form-grid">
      <Field label={tr("audience.selectedMembersDirectMessagesOpenId")} htmlFor={`${id}-users`}><IdentityInput id={`${id}-users`} disabled={value.organization} value={value.userIds} onChange={ids=>onChange({...value,userIds:ids})}/></Field>
      <Field label={tr("audience.selectedGroupsChatId")} htmlFor={`${id}-chats`}><IdentityInput id={`${id}-chats`} disabled={value.organization} value={value.chatIds} onChange={ids=>onChange({...value,chatIds:ids})}/></Field>
    </div>
  </>;
}
