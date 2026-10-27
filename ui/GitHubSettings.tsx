import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Flex, Heading, Text, TextArea, TextField } from '@radix-ui/themes';
import type { ConfigView, GitHubConfigPatch, ProfileState } from '../src/ui-contract';
import { api, ApiError, message } from './api';
import { ConfirmButton, Field, Notice } from './components';
import { Icon } from './Icon';
import { t as tr } from './i18n';

interface Draft { repositories: string; allowedUserIds: string[]; token: string; clearToken: boolean }
const fromConfig = (config: ConfigView): Draft => ({ repositories: (config.github?.repositories ?? []).join('\n'),
  allowedUserIds: [...(config.github?.allowedUserIds ?? [])], token: '', clearToken: false });

export function GitHubSettings({ config, profiles, refresh, expired }: {
  config: ConfigView; profiles: ProfileState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [knownRevision, setKnownRevision] = useState(config.revision), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [authExpired, setAuthExpired] = useState(false), [saveConflict, setSaveConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const observedRevision = useRef(config.revision);
  const conflict = saveConflict || (dirty && revision !== knownRevision), locked = expired || authExpired;
  const paired = [...new Map(profiles.entries.map(profile => [profile.userId, profile])).values()];
  const unpaired = draft.allowedUserIds.filter(userId => !paired.some(profile => profile.userId === userId));

  function load(next: ConfigView) {
    setDraft(fromConfig(next)); setRevision(next.revision); setKnownRevision(next.revision);
    setDirty(false); setSaveConflict(false); setError('');
  }
  function edit(patch: Partial<Draft>) {
    setDraft(current => ({ ...current, ...patch })); setDirty(true); setError(''); setNotice('');
  }
  function selectUser(userId: string, checked: boolean) {
    edit({ allowedUserIds: checked ? [...new Set([...draft.allowedUserIds, userId])] : draft.allowedUserIds.filter(id => id !== userId) });
  }
  useEffect(() => {
    if (observedRevision.current !== config.revision) {
      setKnownRevision(config.revision);
      if (!dirty && !busy) load(config);
      observedRevision.current = config.revision;
    }
  }, [config, dirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function handleFailure(failure: unknown) {
    setError(message(failure));
    if (failure instanceof ApiError && failure.status === 401) {
      setAuthExpired(true); setDraft(current => ({ ...current, token: '' }));
      try { await refresh(); } catch { /* Parent marks the expired workbench session. */ }
    } else if (failure instanceof ApiError && failure.status === 409) {
      setSaveConflict(true);
      try { await refresh(); } catch { /* Preserve the draft when the status refresh also fails. */ }
    }
  }
  async function save() {
    if (!dirty || busy || locked || conflict) return;
    const repositories = [...new Set(draft.repositories.split('\n').map(value => value.trim().toLowerCase()).filter(Boolean))];
    if (repositories.length > 200 || repositories.some(value => !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(value)
      || ['.', '..'].includes(value.split('/')[1]!))) {
      setError('仓库请按 owner/repo 每行一个填写，不支持网址或通配符。'); return;
    }
    const patch: GitHubConfigPatch = { github: { repositories, allowedUserIds: draft.allowedUserIds },
      ...(draft.token ? { newGithubToken: draft.token } : {}), ...(draft.clearToken ? { clearGithubToken: true } : {}) };
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.saveGitHub(revision, patch); load(saved);
      setNotice('GitHub 配置已保存，从下一次检查轮询开始生效。');
      try { await refresh(); } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) await handleFailure(failure);
      }
    } catch (failure) { await handleFailure(failure); }
    finally { setBusy(false); }
  }

  return <section className="form-section profiles-page" aria-labelledby="github-settings-title">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Heading as="h2" size="5" id="github-settings-title">GitHub</Heading>
      <Badge color={config.github?.credentialConfigured ? 'green' : 'gray'}>{config.github?.credentialConfigured ? tr('凭据已配置') : tr('仅公开仓库')}</Badge>
    </Flex>
    <Text as="p" size="2" color="gray">{tr('等待私有仓库 PR 的检查结果。凭据仅用于所选用户的私聊和下列仓库。')}</Text>
    <Text as="p" size="1" color="gray">{tr('请使用仅开放所选仓库的细粒度令牌，授予 Checks、Commit statuses 和 Pull requests 的只读权限。')}</Text>
    {conflict && <Notice>{tr('GitHub 配置已被修改，当前草稿保留。请核对后重新载入已保存配置。')}</Notice>}
    {locked && <Notice error>{tr('本机授权已过期，请重新打开工作台后再修改 GitHub 配置。')}</Notice>}
    {error && <Notice error>{tr(error)}</Notice>}{notice && <Notice>{tr(notice)}</Notice>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || locked}>
        <div className="form-grid">
          <Field label={tr('允许的 GitHub 仓库')} htmlFor="github-repositories">
            <TextArea id="github-repositories" rows={4} maxLength={28400} placeholder="owner/repository" spellCheck={false}
              autoComplete="off" value={draft.repositories} onChange={event => edit({ repositories: event.target.value })} />
            <Text as="p" size="1" color="gray">{tr('每行一个 owner/repo；留空时不使用私有凭据。')}</Text>
          </Field>
          <div className="field">
            <Text as="p" size="2" weight="medium" m="0" id="github-users-label">{tr('允许使用的配对用户')}</Text>
            {!profiles.available && <Text as="p" size="1" color="gray">{tr('配对用户暂不可用，请刷新后再选择。')}</Text>}
            {profiles.available && !paired.length && <Text as="p" size="1" color="gray">{tr('尚无已配对用户，请先完成飞书配对。')}</Text>}
            <Flex direction="column" gap="3" role="group" aria-labelledby="github-users-label">
              {paired.map(profile => {
                const sameName = paired.filter(other => other.name === profile.name).length > 1;
                const label = profile.name && !sameName ? profile.name : `${profile.name || tr('未设置称呼')} · …${profile.userId.slice(-8)}`;
                return <Text as="label" size="2" key={profile.userId}><Flex align="center" gap="2">
                  <Checkbox checked={draft.allowedUserIds.includes(profile.userId)} disabled={!profiles.available || busy || locked}
                    onCheckedChange={checked => selectUser(profile.userId, checked === true)} />{label}
                </Flex></Text>;
              })}
              {unpaired.map(userId => <Text as="label" size="2" key={userId}><Flex align="center" gap="2">
                <Checkbox checked disabled={busy || locked} onCheckedChange={checked => selectUser(userId, checked === true)} />
                {tr('已不在配对列表：{0}', `…${userId.slice(-8)}`)}
              </Flex></Text>)}
            </Flex>
            <Text as="p" size="1" color="gray">{tr('只对本人私聊生效，群聊不会使用私有凭据。')}</Text>
          </div>
        </div>
        <Field label={tr('新 GitHub 令牌（留空保留）')} htmlFor="github-token">
          <TextField.Root id="github-token" type="password" autoComplete="new-password" maxLength={4096} value={draft.token}
            disabled={draft.clearToken} onChange={event => edit({ token: event.target.value })} />
          <Text as="p" size="1" color="gray">{tr('原令牌不会回显。新令牌只提交到本机配置，不会写入浏览器存储或发给 Agent。')}</Text>
          {config.github?.tokenEnv && <Text as="p" size="1" color="gray">{tr('凭据来自环境变量 {0}；输入新令牌会替换此来源。', config.github.tokenEnv)}</Text>}
        </Field>
        {(config.github?.credentialConfigured || config.github?.tokenEnv) && <Text as="label" size="2"><Flex align="center" gap="2">
          <Checkbox checked={draft.clearToken} onCheckedChange={checked => edit({ clearToken: checked === true, token: '' })} />
          {tr('清除已保存的 GitHub 凭据')}
        </Flex></Text>}
      </fieldset>
      <Flex gap="3" mt="5" wrap="wrap" align="center">
        <Button type="submit" loading={busy} disabled={!dirty || locked || conflict}><Icon name="save" />{tr('保存 GitHub 配置')}</Button>
        <ConfirmButton title={tr('重新载入 GitHub 配置？')} description={tr('当前 GitHub 草稿和未保存的令牌将被丢弃。')}
          action={tr('重新载入')} disabled={busy || locked} onConfirm={async () => {
            setBusy(true);
            try { const latest = await api.state(); load(latest.config); setNotice(''); await refresh(); }
            catch (failure) { await handleFailure(failure); throw failure; }
            finally { setBusy(false); }
          }}><Icon name="reset" />{tr('重新载入')}</ConfirmButton>
        {dirty && <Text size="1" color="gray">{tr('有未保存修改。')}</Text>}
      </Flex>
    </form>
  </section>;
}
