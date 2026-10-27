import { useEffect, useState, useRef } from 'react';
import { Button, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { ConfigView } from '../src/ui-contract';
import type { ProjectAccess } from '../src/access-contract';
import { AudienceFields, emptyAudience, IdentityInput } from './AudienceFields';
import { Choice, Field, Notice } from './components';
import { api, message } from './api';
import { t as tr } from './i18n';

const draftFrom=(c:ConfigView)=>({mode:c.feishu.access?'organization':'selected',tenantKey:c.feishu.access?.tenantKey??'',users:c.feishu.allowedUserIds??[],chats:c.feishu.allowedChatIds??[],projects:c.values.projectAccess??{}});
export function ServiceAccessSettings({config,refresh,expired}:{config:ConfigView;refresh:()=>Promise<unknown>;expired:boolean}) {
  const [draft,setDraft]=useState(()=>draftFrom(config)),[revision,setRevision]=useState(config.revision),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const observedRevision=useRef(config.revision);
  const conflict=dirty&&revision!==config.revision;
  const reset=(c:ConfigView)=>{setDraft(draftFrom(c));setRevision(c.revision);setDirty(false);setError('');};
  useEffect(()=>{if(observedRevision.current!==config.revision){if(!dirty&&!busy)reset(config);observedRevision.current=config.revision;}},[config,dirty,busy]);
  useEffect(()=>{if(!dirty)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const edit=(patch:Partial<typeof draft>)=>{setDraft(d=>({...d,...patch}));setDirty(true);setNotice('');};
  const project=(name:string,value:ProjectAccess)=>edit({projects:{...draft.projects,[name]:value}});
  return <section className="form-section"><Heading as="h2" size="5">{tr('组织接入与项目权限')}</Heading>
    <Text as="p" size="2" color="gray">{tr('服务连接由管理员配置；成员无需逐人配对。项目和仓库仍按访问范围分别授权。')}</Text>
    {error&&<Notice error>{error}</Notice>}{notice&&<Notice>{notice}</Notice>}{conflict&&<Notice>{tr('配置已变化，当前草稿保留；请重新载入后修改。')}</Notice>}
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{
      const saved=await api.saveAccess(revision,{serviceAccess:{access:draft.mode==='organization'?{mode:'organization',tenantKey:draft.tenantKey.trim()}:null,allowedUserIds:draft.users,allowedChatIds:draft.chats},projectAccess:draft.projects});reset(saved);setNotice(tr('配置已保存，需要应用配置后启用组织接入。'));await refresh();
    }catch(e){setError(message(e));}finally{setBusy(false);}}}>
      <fieldset disabled={busy||expired}>
        <Field label={tr('服务使用范围')} htmlFor="service-mode"><Choice id="service-mode" value={draft.mode} onChange={mode=>edit({mode})} options={[{value:'organization',label:tr('飞书组织成员')},{value:'selected',label:tr('指定成员（兼容模式）')}]}/></Field>
        {draft.mode==='organization'?<>
          <Flex gap="3" align="end" wrap="wrap"><Field label={tr('飞书组织标识')} htmlFor="service-tenant"><TextField.Root id="service-tenant" value={draft.tenantKey} onChange={e=>edit({tenantKey:e.target.value})}/></Field>
            <Button type="button" variant="soft" onClick={async()=>{setBusy(true);setError('');try{const org=await api.organization();edit({tenantKey:org.tenantKey});setNotice(org.name);}catch(e){setError(message(e));}finally{setBusy(false);}}}>{tr('从当前应用检测组织')}</Button></Flex>
          <Text as="p" size="1" color="gray">{tr('仅接收这个组织的用户事件；飞书后台的应用可用范围仍然生效。')}</Text>
        </>:<Field label={tr('允许的成员（open_id）')} htmlFor="service-users"><IdentityInput id="service-users" value={draft.users} onChange={users=>edit({users})}/></Field>}
        <Field label={tr('限制接入的聊天（留空不限制）')} htmlFor="service-chats"><IdentityInput id="service-chats" value={draft.chats} onChange={chats=>edit({chats})}/></Field>
        <Heading as="h3" size="3" mt="4">{tr('本机项目共享范围')}</Heading>
        <Text as="p" size="2" color="gray">{tr('组织模式默认隔离工作区，不继承额外读取目录、命令联网或本地提交权限。以下规则仅在组织模式生效。')}</Text>
        {Object.keys(config.values.projects).map(name=>{const value=draft.projects[name]??{...emptyAudience(),permission:'read-only' as const};return <details key={name}><summary>{name}</summary>
          <AudienceFields id={`project-${name}`} value={value} onChange={a=>project(name,{...a,permission:value.permission})}/>
          <Field label={tr('项目文件权限')} htmlFor={`permission-${name}`}><Choice id={`permission-${name}`} value={value.permission} onChange={permission=>project(name,{...value,permission:permission as ProjectAccess['permission']})} options={[{value:'read-only',label:tr('只读查看')},{value:'workspace-write',label:tr('允许修改项目文件')}]}/></Field>
        </details>;})}
      </fieldset>
      <Flex gap="3" mt="4"><Button type="submit" loading={busy} disabled={!dirty||expired||conflict}>{tr('保存访问配置')}</Button><Button type="button" variant="soft" disabled={busy} onClick={async()=>{try{reset((await api.state()).config);}catch(e){setError(message(e));}}}>{tr('重新载入')}</Button></Flex>
    </form>
  </section>;
}
