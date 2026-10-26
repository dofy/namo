import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Heading, Text, TextField } from '@radix-ui/themes';
import type { ProfileState, ProfileValues, UserProfile } from '../../src/ui-contract';
import { api, message } from '../api';
import { Choice, ConfirmButton, Field, Notice } from '../components';

const key = (p: UserProfile) => JSON.stringify([p.channel, p.appId, p.userId]);
const values = (p: UserProfile): ProfileValues => ({ name: p.name, language: p.language, timezone: p.timezone });
const labels = { name: '称呼', language: '语言', timezone: '时区' };
export function ProfilesPage({ profiles, expired, refresh }: { profiles: ProfileState; expired: boolean; refresh: () => Promise<unknown> }) {
  const [selected, setSelected] = useState<UserProfile | undefined>(profiles.entries[0]);
  const [draft, setDraft] = useState<ProfileValues>(selected ? values(selected) : { name: '', language: '', timezone: '' });
  const [revision, setRevision] = useState(profiles.configRevision), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const observed = useRef(profiles);
  const current = profiles.entries.find(p => selected && key(p) === key(selected));
  const editable = profiles.available && !!current && revision === profiles.configRevision && !expired;
  function reset(profile: UserProfile | undefined, configRevision: string) {
    setSelected(profile); setDraft(profile ? values(profile) : { name: '', language: '', timezone: '' });
    setRevision(configRevision); setDirty(false); setError('');
  }
  useEffect(() => {
    if (observed.current !== profiles && !dirty && !busy) {
      // Never move backwards when a successful save precedes a failed poll.
      if (current && selected && current.version >= selected.version) reset(current, profiles.configRevision);
      else if (!current) reset(profiles.entries[0], profiles.configRevision);
    }
    observed.current = profiles;
  }, [profiles, dirty, busy, current, selected]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  async function save(patch: ProfileValues) {
    if (!selected || !editable) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.saveProfile(revision, selected, patch); reset(saved, revision);
      setNotice('档案已保存，私聊 /profile 可查看。无需重启服务；配对与权限保持原样。');
      try { await refresh(); } catch { setNotice('档案已保存；状态刷新失败，请稍后刷新核对。'); }
    } finally { setBusy(false); }
  }
  return <div className="profiles-page">
    <Text as="p" size="2" color="gray">档案仅向本人私聊及本机管理入口展示。当前用于查看和管理，尚未自动用于 Agent 回答或调度。</Text>
    {!profiles.available && <Notice>{profiles.reason}</Notice>}
    {profiles.available && !profiles.entries.length && <Notice>尚无已配对用户，请先通过 namo init 完成用户配对。</Notice>}
    {selected && <>
      <Field label="已配对用户" htmlFor="profile-user"><Choice id="profile-user" value={key(selected)} disabled={dirty || busy || !profiles.available}
        onChange={value => { const next = profiles.entries.find(p => key(p) === value); reset(next, profiles.configRevision); setNotice(''); }}
        options={(current ? profiles.entries : [selected, ...profiles.entries]).map(p => ({ value: key(p), label: `${p.name || '未设置称呼'} · ${p.userId}` }))} /></Field>
      <Text as="p" size="1" color="gray">身份来自当前应用的配对配置，平台展示名称尚未同步；下方字段为用户自设资料。修改资料不会关联其他应用的同名用户。</Text>
      <div className="profile-identity"><Badge color="gray">{selected.channel === 'feishu' ? '飞书' : 'Lark'}</Badge><Text size="2">应用：{selected.appId}</Text><Text size="2">用户：{selected.userId}</Text></div>
      {dirty && <Text as="p" size="1" color="gray">有未保存草稿，请保存或放弃后再选择其他用户。</Text>}
      {(!current || revision !== profiles.configRevision) && <Notice>配对或应用配置已变化，当前草稿保留；请放弃草稿并重新选择用户。</Notice>}
      {current && selected.version !== current.version && dirty && <Notice>此档案已有新版本。当前草稿保留，保存会检查冲突；请先核对已保存内容。</Notice>}
      {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
      <form onSubmit={async event => { event.preventDefault(); if (busy) return; try { await save(draft); } catch (e) { setError(message(e)); } }}>
        <fieldset disabled={busy || !editable}>
          <Field label="希望使用的称呼" htmlFor="profile-name"><TextField.Root id="profile-name" value={draft.name} maxLength={160} placeholder="例如 小七" onChange={event => { setDraft(p => ({ ...p, name: event.target.value })); setDirty(true); }} /></Field>
          <div className="form-grid">
            <Field label="语言" htmlFor="profile-language"><TextField.Root id="profile-language" value={draft.language} maxLength={64} placeholder="例如 zh-CN" onChange={event => { setDraft(p => ({ ...p, language: event.target.value })); setDirty(true); }} /></Field>
            <Field label="时区" htmlFor="profile-timezone"><TextField.Root id="profile-timezone" value={draft.timezone} maxLength={64} placeholder="例如 Asia/Shanghai" onChange={event => { setDraft(p => ({ ...p, timezone: event.target.value })); setDirty(true); }} /></Field>
          </div>
          <Text as="p" size="1" color="gray">称呼最多 80 字；留空表示未设置。请勿在档案中填写密码或密钥。</Text>
        </fieldset>
        <div className="save-bar">
          <Text as="p" size="2" color="gray">{selected.version ? `已保存版本 ${selected.version}` : '尚未保存资料'}{selected.updatedAt ? ` · ${new Date(selected.updatedAt).toLocaleString()}` : ''}</Text>
          <ConfirmButton disabled={busy || expired} title="重新载入已保存档案？" description="当前未保存草稿会被放弃。" action="载入已保存内容" onConfirm={async () => {
            const latest = await api.state(); reset(latest.profiles.entries.find(p => key(p) === key(selected)) ?? latest.profiles.entries[0], latest.profiles.configRevision); setNotice('已载入保存的档案。'); await refresh();
          }}>放弃草稿 / 重新载入</ConfirmButton>
          <Button type="submit" disabled={!dirty || !editable} loading={busy}>保存档案</Button>
        </div>
      </form>
      <ConfirmButton danger disabled={busy || dirty || !editable || !Object.values(values(selected)).some(Boolean)} title="清空这位用户的档案？"
        description="清空称呼、语言和时区，保留配对与权限。修改记录仅保留字段名、来源和版本；历史聊天、备份不随之删除。" action="清空档案" onConfirm={() => save({ name: '', language: '', timezone: '' })}>清空档案</ConfirmButton>
      {!!selected.changes.length && <section className="audit"><Heading as="h2" size="4">最近修改</Heading>
        {selected.changes.map(change => <div key={change.version}><Text as="p" size="2">版本 {change.version} · {change.fields.map(f => labels[f]).join('、')} · {change.source === 'self' ? '本人飞书 / Lark 私聊' : '本机管理入口'}</Text>
          <Text size="1" color="gray">{new Date(change.createdAt).toLocaleString()}{change.sourceRef ? ` · 来源消息 ${change.sourceRef}` : ''}</Text></div>)}
      </section>}
    </>}
  </div>;
}
