import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { ConfigView, GitHubConfigPatch, ProfileState } from '../src/ui-contract';
import { api, ApiError, message } from './api';
import { Choice, ConfirmButton, Field, Notice } from './components';
import { Icon } from './Icon';
import { t as tr } from './i18n';

interface Draft { source:'gh'|'token'|'anonymous'; ownerUserId:string; token:string; clearToken:boolean }
const fromConfig = (config: ConfigView): Draft => ({
  source:config.github?.credentialSource==='gh'?'gh':config.github?.credentialConfigured||config.github?.tokenEnv?'token':'anonymous',
  ownerUserId:config.github?.ownerUserId ?? (config.github?.allowedUserIds.length===1?config.github.allowedUserIds[0]:(config.feishu.allowedUserIds??[]).length===1?(config.feishu.allowedUserIds??[])[0]:''),
  token:'',clearToken:false,
});

export function GitHubSettings({ config, profiles, refresh, expired }: {
  config: ConfigView; profiles: ProfileState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [knownRevision, setKnownRevision] = useState(config.revision), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [authExpired, setAuthExpired] = useState(false), [saveConflict, setSaveConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const observedRevision = useRef(config.revision);
  const conflict = saveConflict || (dirty && revision !== knownRevision), locked = expired || authExpired;
  const needsMigration = draft.source!=='anonymous' && config.github?.mode!=='simple';
  const paired = (config.feishu.allowedUserIds??[]).map(userId=>({userId,name:profiles.entries.find(p=>p.userId===userId)?.name}));

  function load(next: ConfigView) {
    setDraft(fromConfig(next)); setRevision(next.revision); setKnownRevision(next.revision);
    setDirty(false); setSaveConflict(false); setError('');
  }
  function edit(patch: Partial<Draft>) {
    setDraft(current => ({ ...current, ...patch })); setDirty(true); setError(''); setNotice('');
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
    if ((!dirty && !needsMigration) || busy || locked || conflict) return;
    if (draft.source!=='anonymous' && !paired.some(p=>p.userId===draft.ownerUserId)) {setError('请选择已配对的本人飞书账号');return;}
    const patch: GitHubConfigPatch = { github: { source:draft.source, repositories:[], allowedUserIds:[],
      ...(draft.source==='anonymous'?{}:{mode:'simple',ownerUserId:draft.ownerUserId}) },
      ...(draft.token ? { newGithubToken: draft.token } : {}), ...(draft.clearToken ? { clearGithubToken: true } : {}) };
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.saveGitHub(revision, patch); load(saved);
      setNotice('GitHub 配置已保存，请应用服务配置。新的工作线使用更新后的权限。');
      try { await refresh(); } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) await handleFailure(failure);
      }
    } catch (failure) { await handleFailure(failure); }
    finally { setBusy(false); }
  }

  return <section className="form-section profiles-page" aria-labelledby="github-settings-title">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Heading as="h2" size="5" id="github-settings-title">GitHub</Heading>
      <Badge color={config.github?.credentialConfigured ? 'green' : 'gray'}>{config.github?.credentialSource==='gh'?tr('本机登录已配置'):config.github?.credentialConfigured ? tr('凭据已配置') : tr('仅公开仓库')}</Badge>
    </Flex>
    <Text as="p" size="2" color="gray">{tr('群聊只读，本人私聊使用 GitHub 账号的全部权限。')}</Text>
    {conflict && <Notice>{tr('GitHub 配置已被修改，当前草稿保留。请核对后重新载入已保存配置。')}</Notice>}
    {locked && <Notice error>{tr('本机授权已过期，请重新打开工作台后再修改 GitHub 配置。')}</Notice>}
    {error && <Notice error>{tr(error)}</Notice>}{notice && <Notice>{tr(notice)}</Notice>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || locked}>
        <Field label={tr('GitHub 登录方式')} htmlFor="github-source">
          <Choice id="github-source" value={draft.source} disabled={busy||locked} onChange={source=>edit({source:source as Draft['source'],token:'',clearToken:false})}
            options={[{value:'anonymous',label:tr('仅公开仓库')},{value:'gh',label:tr('本机 GitHub 登录（推荐）')},{value:'token',label:tr('独立令牌（高级）')}]} />
        </Field>
        {draft.source!=='anonymous' && <>
          <Field label={tr('本人飞书账号')} htmlFor="github-owner">
            <Choice id="github-owner" value={draft.ownerUserId} disabled={busy||locked} onChange={ownerUserId=>edit({ownerUserId})}
              options={[{value:'',label:tr('请选择用户')},...paired.map(p=>({value:p.userId,label:p.name||p.userId}))]} />
          </Field>
          <Text as="p" size="2">{tr('群聊：只读访问该 GitHub 账号有权访问的仓库。')}</Text>
          <Text as="p" size="2">{tr('本人私聊：可以创建、修改、合并、发布及管理 GitHub 资源，以账号实际权限为准。')}</Text>
          <Text as="p" size="2" color="gray">{tr('其他人的私聊不使用此账号。无需逐仓库或逐群授权；群聊仍受服务接入范围限制。')}</Text>
          {config.github?.mode!=='simple' && <Notice>{tr('保存后启用上述简化规则；当前配置仍保留原来的授权范围。')}</Notice>}
        </>}
        {draft.source==='gh' && <>
          <Text as="p" size="1" color="gray">{tr('保存时连接本机 gh 当前账号。无需填写令牌；凭据不会交给 Agent。')}</Text>
          {config.github?.localGh && <Text as="p" size="2">{tr('已选择的 GitHub 账号：{0}',config.github.localGh.login)}</Text>}
        </>}
        {draft.source==='token' && <>
          <Text as="p" size="1" color="gray">{tr('令牌本身决定可访问的仓库与操作。Namo 不额外限制本人私聊，群聊始终只读。')}</Text>
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
        </>}
      </fieldset>
      <Flex gap="3" mt="5" wrap="wrap" align="center">
        <Button type="submit" loading={busy} disabled={(!dirty && !needsMigration) || locked || conflict}><Icon name="save" />{tr('保存 GitHub 配置')}</Button>
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
