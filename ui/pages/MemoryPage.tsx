import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Flex, Separator, Text, TextArea, TextField } from '@radix-ui/themes';
import type { MemoryViewItem as MemoryPageItem, MemoryViewKind as MemoryPageKind, MemoryViewScope as MemoryPageScope, MemoryViewState } from '../../src/ui-contract';
import { getLocale } from '../i18n';
import { Choice, ConfirmButton, Field, Notice } from '../components';
import { api } from '../api';

const labels = {
  zh: {
    intro: 'Namo 默认从对话中提取和更新有价值的长期记忆，无需逐条确认。在这里查看、纠正或删除。', owner: '用户', search: '搜索记忆',
    add: '手动新增记忆（可选）', manualIntro: '通常无需手动保存。只有希望补充尚未在对话中提到的内容时，才需要填写。', kind: '类型', scope: '可见范围', project: '项目', chat: '聊天标识', text: '正文', save: '明确保存',
    preference: '长期偏好', user_fact: '用户资料', project_knowledge: '项目知识', task_summary: '任务摘要', history_quote: '历史原话', handoff: '交接',
    globalScope: '全局记忆', localScope: '项目细节', shared: '可跨会话使用', private: '本人私有', chatPrivate: '限来源聊天', automatic: '自动提取', refresh: '刷新记忆', ownerScope: '本人私聊（原范围）', projectScope: '本人 + 项目私聊', chatScope: '指定聊天', active: '已启用', pending_review: '待审阅', disabled: '已停用', deleted: '已删除', capacity: '容量', entries: '条', chars: '字',
    usable: '可用于新运行', unusable: '不会用于新运行', expires: '到期', never: '不过期', source: '来源', details: '来源与版本', version: '版本', empty: '没有符合条件的记忆。',
    correct: '纠正正文', correctAction: '保存纠正', disable: '停用', disableTitle: '停用这条记忆？', disableDescription: '后续任务不再使用这条记忆，正文仍保留。已有会话可能还保留相关内容。',
    remove: '删除', deleteTitle: '删除这条记忆？', deleteDescription: '删除后无法恢复，后续任务不再使用。历史消息、备份和已有会话中的内容会保留。',
    activate: '审阅并启用', cancel: '取消', conflict: '保存失败。若版本已变化，请保留草稿、刷新并核对后重试。', saved: '变更已保存；只影响后续检索和新运行。',
    migration: '迁移待审阅材料', migrationIntro: '这些材料来自属于当前配置的本机迁移记录。需要导入时，在“手动新增记忆”中选择可见范围；导入后仍须明确审阅启用。',
    importAction: '导入为待审阅', imported: '已绑定', notEligible: '仅展示，不能导入为记忆', bytes: '字节', fingerprint: '指纹', noImports: '没有属于当前配置的迁移审阅材料。',
    privacy: '全局人物与项目知识可按话题跨会话使用；项目细节用于对应项目。私有内容和来源聊天限定的内容仍按场合筛选，临时要求留在当前会话。',
  },
  en: {
    intro: 'Namo automatically extracts and updates useful long-term memories from conversations, without confirming every item. Review, correct, or delete them here.', owner: 'User', search: 'Search memories',
    add: 'Add a memory manually (optional)', manualIntro: 'You normally do not need to save memories manually. Use this to add information that has not appeared in a conversation.', kind: 'Type', scope: 'Visibility', project: 'Project', chat: 'Chat key', text: 'Content', save: 'Save explicitly',
    preference: 'Preference', user_fact: 'User fact', project_knowledge: 'Project knowledge', task_summary: 'Task summary', history_quote: 'History quote', handoff: 'Handoff',
    globalScope: 'Global memory', localScope: 'Project details', shared: 'Available across conversations', private: 'Owner private', chatPrivate: 'Source chat only', automatic: 'Automatically extracted', refresh: 'Refresh memories', ownerScope: 'Owner direct messages (legacy)', projectScope: 'Owner + project direct messages', chatScope: 'Exact chat', active: 'Active', pending_review: 'Pending review', disabled: 'Disabled', deleted: 'Deleted', capacity: 'Capacity', entries: 'items', chars: 'characters',
    usable: 'Available to new runs', unusable: 'Not used by new runs', expires: 'Expires', never: 'Never', source: 'Source', details: 'Source and version', version: 'Version', empty: 'No matching memories.',
    correct: 'Correct content', correctAction: 'Save correction', disable: 'Disable', disableTitle: 'Disable this memory?', disableDescription: 'Future tasks stop using this memory. Its content is kept, and existing conversations may still contain it.',
    remove: 'Delete', deleteTitle: 'Delete this memory?', deleteDescription: 'Deletion cannot be undone. Future tasks stop using this memory; messages, backups, and existing conversations are kept.',
    activate: 'Review and activate', cancel: 'Cancel', conflict: 'Save failed. If the version changed, keep the draft, refresh, and review before retrying.', saved: 'Change saved. It affects later searches and new runs only.',
    migration: 'Migration review material', migrationIntro: 'These local artifacts belong to the current configuration. Choose visibility under the optional manual form before importing. Imported material still requires explicit review and activation.',
    importAction: 'Import as pending review', imported: 'Already bound', notEligible: 'Shown for review only; cannot become memory', bytes: 'bytes', fingerprint: 'Fingerprint', noImports: 'No migration review material belongs to this configuration.',
    privacy: 'Global people and project knowledge can be used across conversations when relevant; project details stay with their project. Private and chat-restricted content is filtered for the audience. Temporary requests stay in the current session.',
  },
} as const;

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusColor = (status: MemoryPageItem['status']) => status === 'active' ? 'green' : status === 'pending_review' ? 'orange' : 'gray';

export function MemoryPage({ editable, unavailableReason }: { editable: boolean; unavailableReason?: string }) {
  const c = getLocale() === 'zh-CN' ? labels.zh : labels.en;
  const [state, setState] = useState<MemoryViewState>();
  const [query, setQuery] = useState(''), [kind, setKind] = useState<Exclude<MemoryPageKind, 'handoff'>>('preference');
  const [scopeKind, setScopeKind] = useState<MemoryPageScope['kind']>('owner'), [project, setProject] = useState(''), [chatKey, setChatKey] = useState('');
  const [draft, setDraft] = useState(''), [editing, setEditing] = useState<string | null>(null), [editText, setEditText] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    void api.memories(undefined, controller.signal).then(setState).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const ownerId=state?.ownerId;
  useEffect(() => {
    if(!ownerId||busy||editing||draft||!editable)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      try {const next=await api.memories(ownerId,controller.signal);if(!controller.signal.aborted)setState(next);}
      catch(failure){if(!controller.signal.aborted)setError(errorMessage(failure));}
      finally{if(!controller.signal.aborted)timer=setTimeout(tick,5000);}
    };
    timer=setTimeout(tick,5000);
    return()=>{clearTimeout(timer);controller.abort();};
  },[ownerId,busy,editing,draft,editable]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const items=state?.items??[];
    return needle ? items.filter(item => `${item.id} ${item.text ?? ''} ${item.source.ref}`.toLocaleLowerCase().includes(needle)) : items;
  }, [state, query]);
  const names: Record<MemoryPageKind, string> = { preference: c.preference, user_fact: c.user_fact, project_knowledge: c.project_knowledge,
    task_summary: c.task_summary, history_quote: c.history_quote, handoff: c.handoff };
  const scopeNames: Record<MemoryPageScope['kind'], string> = { owner: c.ownerScope, project: c.projectScope, chat: c.chatScope, global: c.globalScope, local: c.localScope };
  const privacyName = (item: MemoryPageItem) => item.visibility?.privacy === 'shared' ? c.shared : item.visibility?.privacy === 'chat' || item.scope.kind === 'chat' ? c.chatPrivate : c.private;
  const selectedScope = ():MemoryPageScope => ({kind:scopeKind,ownerId:state!.ownerId,
    project:scopeKind==='owner'||!project.trim()?null:project.trim(),chatKey:scopeKind==='chat'?chatKey.trim():null});
  const sameScope=(left:MemoryPageScope,right:MemoryPageScope)=>left.kind===right.kind&&left.ownerId===right.ownerId&&left.project===right.project&&left.chatKey===right.chatKey;

  async function act(action: () => Promise<MemoryViewState>, announce = true) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { setState(await action()); if (announce) setNotice(c.saved); }
    catch (failure) { setError(`${errorMessage(failure)} ${c.conflict}`); }
    finally { setBusy(false); }
  }

  return <div className="profiles-page">
    <Text as="p" size="2" color="gray">{c.intro}</Text>
    <Text as="p" size="2" color="gray">{c.privacy}</Text>
    {!editable && <Notice error>{unavailableReason || c.conflict}</Notice>}
    {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
    <div className="form-grid">
      <Field label={c.owner} htmlFor="memory-owner"><Choice id="memory-owner" value={state?.ownerId??''} disabled={busy||!state}
        onChange={value => { setEditing(null);setScopeKind('owner');setProject('');setChatKey('');setNotice('');setError('');setBusy(true);void api.memories(value).then(setState).catch(failure=>setError(errorMessage(failure))).finally(()=>setBusy(false)); }}
        options={(state?.owners??[]).map(owner => ({ value: owner.id, label: owner.label }))} /></Field>
      <Field label={c.search} htmlFor="memory-search"><TextField.Root id="memory-search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} /></Field>
    </div>
    <Button variant="soft" color="gray" disabled={busy || !state} onClick={() => void act(() => api.memories(state!.ownerId), false)}>{c.refresh}</Button>
    {state&&<Text as="p" size="1" color="gray">{c.capacity}: {state.items.filter(item=>item.status!=='deleted').length} / {state.limits.ownerEntries} {c.entries} · {state.items.reduce((sum,item)=>sum+item.contentChars,0)} / {state.limits.ownerChars} {c.chars}</Text>}

    <Separator my="5" size="4" />
    {!filtered.length && <Text size="2" color="gray">{c.empty}</Text>}
    {filtered.map(item => <section className="audit" key={`${item.id}:${item.version}`}>
      <Flex gap="2" align="center" wrap="wrap"><Badge color={statusColor(item.status)}>{c[item.status]}</Badge><Badge color={item.usable ? 'green' : 'gray'}>{item.usable ? c.usable : c.unusable}</Badge>
        <Text size="2" weight="bold">{names[item.kind]}</Text><Badge color="gray">{scopeNames[item.scope.kind]}{item.scope.project ? ` · ${item.scope.project}` : ''}</Badge><Badge color={item.visibility?.privacy === 'shared' ? 'blue' : 'gray'}>{privacyName(item)}</Badge>{item.source.kind === 'automatic' && <Badge color="blue">{c.automatic}</Badge>}</Flex>
      <details><summary>{c.details}</summary><Text as="p" size="1" color="gray">{item.id} · {c.version} {item.version}</Text><Text as="p" size="1" color="gray">{scopeNames[item.scope.kind]}{item.scope.project ? ` · ${item.scope.project}` : ''}{item.scope.chatKey ? ` · ${item.scope.chatKey}` : ''}
        {` · ${c.source}: ${item.source.kind} / ${item.source.ref} · ${c.expires}: ${item.expiresAt ? new Date(item.expiresAt).toLocaleString(getLocale()) : c.never}`}</Text></details>
      {item.text !== null && editing !== item.id && <Text as="p" size="2" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</Text>}
      {editing === item.id && <><Field label={c.correct} htmlFor={`memory-edit-${item.id}`}><TextArea id={`memory-edit-${item.id}`} value={editText} maxLength={3000} rows={5}
        onChange={event => setEditText(event.target.value)} /></Field><Flex gap="2"><Button disabled={!editText.trim() || busy} onClick={() => void act(async () => {
          const next=await api.memory({action:'correct',ownerId:state!.ownerId,id:item.id,version:item.version,text:editText}); setEditing(null); setEditText('');return next;
        })}>{c.correctAction}</Button><Button variant="soft" color="gray" onClick={() => setEditing(null)}>{c.cancel}</Button></Flex></>}
      <Flex gap="2" mt="3" wrap="wrap">
        {item.text !== null && !['pending_review','deleted'].includes(item.status) && editing !== item.id && <Button variant="soft" disabled={!editable || busy}
          onClick={() => { setEditing(item.id); setEditText(item.text ?? ''); }}>{c.correct}</Button>}
        {item.status === 'pending_review' && <Button disabled={!editable || busy} onClick={() => void act(() => api.memory({action:'activate',ownerId:state!.ownerId,id:item.id,version:item.version}))}>{c.activate}</Button>}
        {!['disabled', 'deleted'].includes(item.status) && <ConfirmButton disabled={!editable || busy} title={c.disableTitle} description={c.disableDescription} action={c.disable}
          onConfirm={() => act(() => api.memory({action:'disable',ownerId:state!.ownerId,id:item.id,version:item.version}))}>{c.disable}</ConfirmButton>}
        {item.status !== 'deleted' && <ConfirmButton danger disabled={!editable || busy} title={c.deleteTitle} description={c.deleteDescription} action={c.remove}
          onConfirm={() => act(() => api.memory({action:'delete',ownerId:state!.ownerId,id:item.id,version:item.version}))}>{c.remove}</ConfirmButton>}
      </Flex>
    </section>)}

    <details>
      <summary>{c.add}</summary>
      <Text as="p" size="2" color="gray">{c.manualIntro}</Text>
      <section className="audit">
      <div className="form-grid">
        <Field label={c.kind} htmlFor="memory-kind"><Choice id="memory-kind" value={kind} disabled={!editable || busy}
          onChange={value => setKind(value as typeof kind)} options={(['preference', 'user_fact', 'project_knowledge', 'task_summary', 'history_quote'] as const).map(value => ({ value, label: names[value] }))} /></Field>
        <Field label={c.scope} htmlFor="memory-scope"><Choice id="memory-scope" value={scopeKind} disabled={!editable || busy}
          onChange={value => {const next=value as MemoryPageScope['kind'];setScopeKind(next);if(next==='project')setProject(state?.projects[0]??'');if(next==='chat'){const first=state?.chats[0];setChatKey(first?.chatKey??'');setProject(first?.project??'');}}}
          options={(['owner', 'project', 'chat'] as const).map(value => ({ value, label: scopeNames[value] }))} /></Field>
        {scopeKind === 'project' && <Field label={c.project} htmlFor="memory-project"><Choice id="memory-project" value={project} disabled={!editable||busy||!state?.projects.length}
          onChange={setProject} options={(state?.projects??[]).map(value=>({value,label:value}))} /></Field>}
        {scopeKind === 'chat' && <Field label={c.chat} htmlFor="memory-chat"><Choice id="memory-chat" value={JSON.stringify([chatKey,project||null])} disabled={!editable||busy||!state?.chats.length}
          onChange={value=>{const [chat,nextProject]=JSON.parse(value) as [string,string|null];setChatKey(chat);setProject(nextProject??'');}}
          options={(state?.chats??[]).map(item=>({value:JSON.stringify([item.chatKey,item.project]),label:`${item.chatKey}${item.project?` · ${item.project}`:''}`}))} /></Field>}
      </div>
      <Field label={c.text} htmlFor="memory-text"><TextArea id="memory-text" value={draft} maxLength={state?.limits.entryChars??3000} rows={5} disabled={!editable || busy}
        onChange={event => setDraft(event.target.value)} /></Field>
      <Button disabled={!editable || busy || !state || !draft.trim() || (scopeKind === 'project' && !project.trim()) || (scopeKind === 'chat' && !chatKey.trim())}
        onClick={() => void act(async () => {
          const next=await api.memory({action:'save',ownerId:state!.ownerId,input:{kind,scope:{kind:scopeKind,ownerId:state!.ownerId,project:scopeKind==='owner'||!project.trim()?null:project.trim(),chatKey:scopeKind==='chat'?chatKey.trim():null},text:draft}});
          setDraft('');return next;
        })}>{c.save}</Button>
      </section>
    </details>

    <details>
      <summary>{c.migration}</summary>
      <section className="audit">
      <Text as="p" size="2" color="gray">{c.migrationIntro}</Text>
      {!(state?.imports??[]).length && <Text size="2" color="gray">{c.noImports}</Text>}
      {(state?.imports??[]).map(candidate=>{
        const scope=state?selectedScope():undefined,existing=scope?candidate.imports.find(item=>sameScope(item.scope,scope)):undefined;
        return <section className="audit" key={`${candidate.migrationId}:${candidate.candidateId}`}>
          <Flex gap="2" align="center" wrap="wrap"><Badge color={candidate.eligible?'orange':'gray'}>{candidate.candidateKind}</Badge>
            <Text size="2" weight="bold">{candidate.name}</Text>{existing&&<Badge color="gray">{c.imported} · {c[existing.status]}</Badge>}</Flex>
          <Text as="p" size="1" color="gray">{c.source}: OpenClaw / {candidate.source.instanceId} / {candidate.source.accountId} / {candidate.source.version}
            {` · ${candidate.bytes} ${c.bytes} · ${c.fingerprint}: ${candidate.fingerprint.slice(0,16)}…`}</Text>
          {!candidate.eligible&&<Notice>{c.notEligible}</Notice>}
          <Button variant="soft" disabled={!editable||busy||!state||!candidate.eligible||!!existing||(scopeKind==='project'&&!project.trim())||(scopeKind==='chat'&&!chatKey.trim())}
            onClick={()=>void act(()=>api.memory({action:'import',ownerId:state!.ownerId,input:{migrationId:candidate.migrationId,candidateId:candidate.candidateId,fingerprint:candidate.fingerprint,scope:selectedScope()}}))}>
            {existing?c.imported:candidate.eligible?c.importAction:c.notEligible}
          </Button>
        </section>;
      })}
      </section>
    </details>
  </div>;
}
