import { t as tr, getLocale } from '../i18n';
import { Icon } from '../Icon';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Text, TextField } from '@radix-ui/themes';
import type { ProfileState, ProfileValues, UserProfile } from '../../src/ui-contract';
import { api, message } from '../api';
import { Choice, ConfirmButton, Field, Notice } from '../components';

const key = (p: UserProfile) => JSON.stringify([p.channel, p.appId, p.userId]);
const values = (p: UserProfile): ProfileValues => ({ name: p.name, language: p.language, timezone: p.timezone });
export function ProfilesPage({ profiles, expired, refresh }: { profiles: ProfileState; expired: boolean; refresh: () => Promise<unknown> }) {
  const labels = { name: tr("称呼"), language: tr("语言"), timezone: tr("时区") };
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
      setNotice(tr("档案已保存，私聊 /profile 可查看。无需重启服务；配对与权限保持原样。"));
      try { await refresh(); } catch { setNotice(tr("档案已保存；状态刷新失败，请稍后刷新核对。")); }
    } finally { setBusy(false); }
  }
  return <div className="profiles-page">
    <Text as="p" size="2" color="gray">{tr('在助手设置中开启档案使用后，这些偏好会用于本人的私聊任务。')}</Text>
    {!profiles.available && <Notice>{profiles.reason}</Notice>}
    {profiles.available && !profiles.entries.length && <Notice>{tr("尚无已配对用户，请先通过 namo init 完成用户配对。")}</Notice>}
    {selected && <>
      <Field label={tr("已配对用户")} htmlFor="profile-user"><Choice id="profile-user" value={key(selected)} disabled={dirty || busy || !profiles.available}
        onChange={value => { const next = profiles.entries.find(p => key(p) === value); reset(next, profiles.configRevision); setNotice(''); }}
        options={(current ? profiles.entries : [selected, ...profiles.entries]).map(p => ({ value: key(p), label: p.name && profiles.entries.filter(other => other.name === p.name).length === 1 ? p.name : `${p.name || tr("未设置称呼")} · …${p.userId.slice(-8)}` }))} /></Field>
      <details className="profile-account"><summary>{tr('配对账号详情')}</summary>
        <div className="profile-identity"><Badge color="gray">{selected.channel === 'feishu' ? tr("飞书") : 'Lark'}</Badge><Text size="2">{tr("应用：")}{selected.appId}</Text><Text size="2">{tr("用户：")}{selected.userId}</Text></div>
        <Text as="p" size="1" color="gray">{tr("身份来自当前应用的配对配置，平台展示名称尚未同步；下方字段为用户自设资料。修改资料不会关联其他应用的同名用户。")}</Text>
      </details>
      {dirty && <Text as="p" size="1" color="gray">{tr("有未保存草稿，请保存或放弃后再选择其他用户。")}</Text>}
      {(!current || revision !== profiles.configRevision) && <Notice>{tr("配对或应用配置已变化，当前草稿保留；请放弃草稿并重新选择用户。")}</Notice>}
      {current && selected.version !== current.version && dirty && <Notice>{tr("此档案已有新版本。当前草稿保留，保存会检查冲突；请先核对已保存内容。")}</Notice>}
      {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
      <form onSubmit={async event => { event.preventDefault(); if (busy) return; try { await save(draft); } catch (e) { setError(message(e)); } }}>
        <fieldset disabled={busy || !editable}>
          <Field label={tr("希望使用的称呼")} htmlFor="profile-name"><TextField.Root id="profile-name" value={draft.name} maxLength={160} placeholder={tr("例如 小七")} onChange={event => { setDraft(p => ({ ...p, name: event.target.value })); setDirty(true); }} /></Field>
          <div className="form-grid">
            <Field label={tr("语言")} htmlFor="profile-language"><TextField.Root id="profile-language" value={draft.language} maxLength={64} placeholder={tr("例如 zh-CN")} onChange={event => { setDraft(p => ({ ...p, language: event.target.value })); setDirty(true); }} /></Field>
            <Field label={tr("时区")} htmlFor="profile-timezone"><TextField.Root id="profile-timezone" value={draft.timezone} maxLength={64} placeholder={tr("例如 Asia/Shanghai")} onChange={event => { setDraft(p => ({ ...p, timezone: event.target.value })); setDirty(true); }} /></Field>
          </div>
          <Text as="p" size="1" color="gray">{tr("称呼最多 80 字；留空表示未设置。请勿在档案中填写密码或密钥。")}</Text>
        </fieldset>
        <div className="profile-save">
          <Text as="p" size="2" color="gray">{selected.version ? tr("已保存版本 {0}", selected.version) : tr("尚未保存资料")}{selected.updatedAt ? ` · ${new Date(selected.updatedAt).toLocaleString(getLocale())}` : ''}</Text>
          <div className="profile-save-actions"><Button type="submit" disabled={!dirty || !editable} loading={busy}><Icon name="save" />{tr("保存档案")}</Button>
          <ConfirmButton disabled={busy || expired} title={tr("重新载入已保存档案？")} description={tr("当前未保存草稿会被放弃。")} action={tr("载入已保存内容")} onConfirm={async () => {
            const latest = await api.state(); reset(latest.profiles.entries.find(p => key(p) === key(selected)) ?? latest.profiles.entries[0], latest.profiles.configRevision); setNotice(tr("已载入保存的档案。")); await refresh();
          }}><Icon name="reset" />{tr('重新载入')}</ConfirmButton></div>
        </div>
      </form>
      <ConfirmButton danger disabled={busy || dirty || !editable || !Object.values(values(selected)).some(Boolean)} title={tr("清空这位用户的档案？")}
        description={tr("清空称呼、语言和时区，保留配对与权限。修改记录仅保留字段名、来源和版本；历史聊天、备份不随之删除。")} action={tr("清空档案")} onConfirm={() => save({ name: '', language: '', timezone: '' })}><Icon name="trash" />{tr("清空档案")}</ConfirmButton>
      {!!selected.changes.length && <details className="profile-history"><summary>{tr("最近修改")} ({selected.changes.length})</summary><div className="audit">
        {selected.changes.map(change => <div key={change.version}><Text as="p" size="2">{tr("版本")} {change.version} · {change.fields.map(f => labels[f]).join('、')} · {change.source === 'self' ? tr("本人飞书 / Lark 私聊") : tr("本机管理入口")}</Text>
          <Text size="1" color="gray">{new Date(change.createdAt).toLocaleString(getLocale())}{change.sourceRef ? tr(" · 来源消息 {0}", change.sourceRef) : ''}</Text></div>)}
      </div></details>}
    </>}
  </div>;
}
