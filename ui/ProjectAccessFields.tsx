import type { ProjectAccess } from '../src/access-contract';
import type { ConfigView, ProfileState } from '../src/ui-contract';
import { AudienceFields, emptyAudience } from './AudienceFields';
import { Choice, Field } from './components';
import { t as tr } from './i18n';

export const emptyProjectAccess = ():ProjectAccess => ({...emptyAudience(),permission:'read-only'});
export function accessSummary(access?:ProjectAccess):string {
  if(!access||!access.organization&&!access.userIds.length&&!access.chatIds.length)return tr('projectAccess.notGranted');
  if(access.organization)return tr('projectAccess.organization');
  return tr('projectAccess.summary',access.userIds.length,access.chatIds.length);
}
export function ProjectAccessFields({id,value,onChange,config,profiles}:{id:string;value:ProjectAccess;onChange:(value:ProjectAccess)=>void;config:ConfigView;profiles?:ProfileState}) {
  const members=(config.feishu.allowedUserIds??[]).map((memberId,index)=>({id:memberId,label:profiles?.entries.find(p=>p.userId===memberId&&p.appId===config.feishu.appId)?.name||`${tr('projectAccess.member',index+1)} · ${memberId.slice(-8)}`}));
  return <div className="project-access-fields">
    <AudienceFields id={id} value={value} members={members} onChange={audience=>onChange({...audience,permission:value.permission})}/>
    <Field label={tr('projectAccess.permission')} htmlFor={`${id}-permission`}><Choice id={`${id}-permission`} value={value.permission} onChange={permission=>onChange({...value,permission:permission as ProjectAccess['permission']})} options={[{value:'read-only',label:tr('common.read')},{value:'workspace-write',label:tr('common.allowProjectFileChanges')}]}/></Field>
  </div>;
}
