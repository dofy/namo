import { PageSection, EmptyState } from '../components/PageSection';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Flex, Spinner, Text, TextArea, TextField } from '@radix-ui/themes';
import type { MemoryViewItem as MemoryPageItem, MemoryViewKind as MemoryPageKind, MemoryViewScope as MemoryPageScope, MemoryViewState } from '../../src/ui-contract';
import { t as tr, getLocale } from '../i18n';
import { Choice, ConfirmButton, Field, Notice } from '../components';
import { api } from '../api';
import { MemoryExtractionStatus } from '../MemoryExtractionStatus';

const labels = () => ({
  intro: tr("memory.intro"),
  owner: tr("memory.owner"),
  search: tr("memory.search"),
  add: tr("memory.add"),
  manualIntro: tr("memory.manualIntro"),
  kind: tr("memory.kind"),
  scope: tr("memory.scope"),
  project: tr("memory.project"),
  chat: tr("memory.chat"),
  text: tr("memory.text"),
  save: tr("memory.save"),
  preference: tr("memory.preference"),
  user_fact: tr("memory.userFact"),
  project_knowledge: tr("memory.projectKnowledge"),
  task_summary: tr("memory.taskSummary"),
  history_quote: tr("memory.historyQuote"),
  handoff: tr("memory.handoff"),
  globalScope: tr("memory.globalScope"),
  localScope: tr("memory.localScope"),
  shared: tr("memory.shared"),
  private: tr("memory.private"),
  chatPrivate: tr("memory.chatPrivate"),
  automatic: tr("memory.automatic"),
  refresh: tr("memory.refresh"),
  ownerScope: tr("memory.ownerScope"),
  projectScope: tr("memory.projectScope"),
  chatScope: tr("memory.chatScope"),
  active: tr("memory.active"),
  pending_review: tr("memory.pendingReview"),
  disabled: tr("memory.disabled"),
  deleted: tr("memory.deleted"),
  capacity: tr("memory.capacity"),
  entries: tr("memory.entries"),
  chars: tr("memory.chars"),
  usable: tr("memory.usable"),
  unusable: tr("memory.unusable"),
  expires: tr("memory.expires"),
  never: tr("memory.never"),
  source: tr("memory.source"),
  details: tr("memory.details"),
  version: tr("memory.version"),
  empty: tr("memory.empty"),
  correct: tr("memory.correct"),
  correctAction: tr("memory.correctAction"),
  disable: tr("memory.disable"),
  disableTitle: tr("memory.disableTitle"),
  disableDescription: tr("memory.disableDescription"),
  remove: tr("memory.remove"),
  deleteTitle: tr("memory.deleteTitle"),
  deleteDescription: tr("memory.deleteDescription"),
  activate: tr("memory.activate"),
  cancel: tr("memory.cancel"),
  conflict: tr("memory.conflict"),
  saved: tr("memory.saved"),
  migration: tr("memory.migration"),
  migrationIntro: tr("memory.migrationIntro"),
  importAction: tr("memory.importAction"),
  imported: tr("memory.imported"),
  notEligible: tr("memory.notEligible"),
  bytes: tr("memory.bytes"),
  fingerprint: tr("memory.fingerprint"),
  noImports: tr("memory.noImports"),
  privacy: tr("memory.privacy"),
});

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const statusColor = (status: MemoryPageItem['status']) => status === 'active' ? 'green' : status === 'pending_review' ? 'orange' : 'gray';

export function MemoryPage({ active, editable, unavailableReason }: { active: boolean; editable: boolean; unavailableReason?: string }) {
  const c = labels();
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
    if(!active||!ownerId||busy||editing||draft||!editable)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      try {const next=await api.memories(ownerId,controller.signal);if(!controller.signal.aborted)setState(next);}
      catch(failure){if(!controller.signal.aborted)setError(errorMessage(failure));}
      finally{if(!controller.signal.aborted)timer=setTimeout(tick,5000);}
    };
    timer=setTimeout(tick,5000);
    return()=>{clearTimeout(timer);controller.abort();};
  },[active,ownerId,busy,editing,draft,editable]);
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

  return <div className="profiles-page memory-page">
    <Text as="p" size="2" color="gray">{c.intro}</Text>
    <Text as="p" size="2" color="gray">{c.privacy}</Text>
    {!editable && <Notice error>{unavailableReason || c.conflict}</Notice>}
    {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
    <PageSection icon="search" title={tr("design.memoryBrowse")} description={tr("design.memoryHelp")}><div className="form-grid">
      <Field label={c.owner} htmlFor="memory-owner"><Choice id="memory-owner" value={state?.ownerId??''} disabled={busy||!state}
        onChange={value => { setEditing(null);setScopeKind('owner');setProject('');setChatKey('');setNotice('');setError('');setBusy(true);void api.memories(value).then(setState).catch(failure=>setError(errorMessage(failure))).finally(()=>setBusy(false)); }}
        options={(state?.owners??[]).map(owner => ({ value: owner.id, label: owner.label }))} /></Field>
      <Field label={c.search} htmlFor="memory-search"><TextField.Root id="memory-search" value={query} maxLength={120} onChange={event => setQuery(event.target.value)} /></Field>
    </div>
    <Flex direction="column" align="start" gap="2">
      <Button variant="soft" color="gray" disabled={busy || !state} onClick={() => void act(() => api.memories(state!.ownerId), false)}>{c.refresh}</Button>
      {state&&<Text as="p" size="1" color="gray">{c.capacity}: {state.items.filter(item=>item.status!=='deleted').length} / {state.limits.ownerEntries} {c.entries} · {state.items.reduce((sum,item)=>sum+item.contentChars,0)} / {state.limits.ownerChars} {c.chars}</Text>}
    </Flex></PageSection>
    {state?.extraction&&<MemoryExtractionStatus value={state.extraction}/>}

    {busy && !state && <div className="loading" role="status"><Spinner />{tr("tasks.loadingRecords")}</div>}
    {!busy && state && !filtered.length && <EmptyState icon="memory" title={c.empty} description={query ? tr("design.memorySearchEmpty") : tr("design.memoryEmpty")} />}
    {filtered.map(item => <section className="audit memory-entry" key={`${item.id}:${item.version}`}>
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

    <details className="disclosure-panel">
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

    <details className="disclosure-panel">
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
