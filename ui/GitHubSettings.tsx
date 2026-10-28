import {SettingsPanelDialog} from './SettingsPanelDialog';
import type {ReactNode} from 'react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Flex, Text, TextField } from '@radix-ui/themes';
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

function GitHubEditor({ config, profiles, refresh, expired, onStateChange, cancelControl }: {
  onStateChange:(dirty:boolean,busy:boolean)=>void;cancelControl:ReactNode;
  config: ConfigView; profiles: ProfileState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const [draft, setDraft] = useState(() => fromConfig(config)), [revision, setRevision] = useState(config.revision);
  const [knownRevision, setKnownRevision] = useState(config.revision), [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [authExpired, setAuthExpired] = useState(false), [saveConflict, setSaveConflict] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const observedRevision = useRef(config.revision);
  useEffect(()=>{onStateChange(dirty,busy);},[dirty,busy]);
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
    if (draft.source!=='anonymous' && !paired.some(p=>p.userId===draft.ownerUserId)) {setError(tr("common.selectPairedFeishuAccount"));return;}
    const patch: GitHubConfigPatch = { github: { source:draft.source, repositories:[], allowedUserIds:[],
      ...(draft.source==='anonymous'?{}:{mode:'simple',ownerUserId:draft.ownerUserId}) },
      ...(draft.token ? { newGithubToken: draft.token } : {}), ...(draft.clearToken ? { clearGithubToken: true } : {}) };
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api.saveGitHub(revision, patch); load(saved);
      setNotice(tr("github.settingsSavedApplyService"));
      try { await refresh(); } catch (failure) {
        if (failure instanceof ApiError && failure.status === 401) await handleFailure(failure);
      }
    } catch (failure) { await handleFailure(failure); }
    finally { setBusy(false); }
  }

  return <section className="form-section profiles-page">
    <Flex align="center" justify="between" gap="3" wrap="wrap">
      <Badge color={config.github?.credentialConfigured ? 'green' : 'gray'}>{config.github?.credentialSource==='gh'?tr("github.localLoginConfigured"):config.github?.credentialConfigured ? tr("common.credentialsConfigured") : tr("github.publicRepositories")}</Badge>
    </Flex>
    {conflict && <Notice>{tr("github.githubSettingsChangedDraftPreservedReviewReloading")}</Notice>}
    {locked && <Notice error>{tr("github.localAuthorizationExpiredReopenWorkbenchEditGithub")}</Notice>}
    {error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={busy || locked}>
        <Field label={tr("github.githubAuthentication")} htmlFor="github-source">
          <Choice id="github-source" value={draft.source} disabled={busy||locked} onChange={source=>edit({source:source as Draft['source'],token:'',clearToken:false})}
            options={[{value:'anonymous',label:tr("github.publicRepositories")},{value:'gh',label:tr("github.localGithubLoginRecommended")},{value:'token',label:tr("github.separateTokenAdvanced")}]} />
        </Field>
        {draft.source!=='anonymous' && <>
          <Field label={tr("github.feishuAccount")} htmlFor="github-owner">
            <Choice id="github-owner" value={draft.ownerUserId} disabled={busy||locked} onChange={ownerUserId=>edit({ownerUserId})}
              options={[{value:'',label:tr("github.selectUser")},...paired.map(p=>({value:p.userId,label:p.name||p.userId}))]} />
          </Field>
          <Text as="p" size="2">{tr("common.groupsReadAccessRepositoriesAvailableGithubAccount")}</Text>
          <Text as="p" size="2">{tr("common.privateChatCreateEditMergePublishManage")}</Text>
          <Text as="p" size="2" color="gray">{tr("common.otherPrivateChatsCannotUseAccountNo")}</Text>
          {config.github?.mode!=='simple' && <Notice>{tr("github.saveEnableTheseSimplerRulesExistingAccess")}</Notice>}
        </>}
        {draft.source==='gh' && <>
          <Text as="p" size="1" color="gray">{tr("github.savingConnectsCurrentLocalGhAccountNo")}</Text>
          {config.github?.localGh && <Text as="p" size="2">{tr("github.selectedGithubAccount",config.github.localGh.login)}</Text>}
        </>}
        {draft.source==='token' && <>
          <Text as="p" size="1" color="gray">{tr("github.tokenDeterminesAccessibleRepositoriesOperationsNamoAdds")}</Text>
        <Field label={tr("github.newGithubTokenLeaveBlankKeep")} htmlFor="github-token">
          <TextField.Root id="github-token" type="password" autoComplete="new-password" maxLength={4096} value={draft.token}
            disabled={draft.clearToken} onChange={event => edit({ token: event.target.value })} />
          <Text as="p" size="1" color="gray">{tr("github.savedTokenNeverDisplayedNewTokenGoes")}</Text>
          {config.github?.tokenEnv && <Text as="p" size="1" color="gray">{tr("github.credentialsComeEnteringNewTokenReplacesEnvironment", config.github.tokenEnv)}</Text>}
        </Field>
        {(config.github?.credentialConfigured || config.github?.tokenEnv) && <Text as="label" size="2"><Flex align="center" gap="2">
          <Checkbox checked={draft.clearToken} onCheckedChange={checked => edit({ clearToken: checked === true, token: '' })} />
          {tr("github.clearSavedGithubCredentials")}
        </Flex></Text>}
        </>}
      </fieldset>
      <Flex gap="3" mt="5" wrap="wrap" align="center" className="settings-editor-footer">
        {cancelControl}<Button type="submit" loading={busy} disabled={(!dirty && !needsMigration) || locked || conflict}><Icon name="save" />{tr("github.saveGithubSettings")}</Button>
        <ConfirmButton title={tr("github.reloadGithubSettings")} description={tr("github.currentGithubDraftUnsavedTokenDiscarded")}
          action={tr("common.reload")} disabled={busy || locked} onConfirm={async () => {
            setBusy(true);
            try { const latest = await api.state(); load(latest.config); setNotice(''); await refresh(); }
            catch (failure) { await handleFailure(failure); throw failure; }
            finally { setBusy(false); }
          }}><Icon name="reset" />{tr("common.reload")}</ConfirmButton>
        {dirty && <Text size="1" color="gray">{tr("common.unsavedChanges")}</Text>}
      </Flex>
    </form>
  </section>;
}

export function GitHubSettings(props:{config:ConfigView;profiles:ProfileState;refresh:()=>Promise<unknown>;expired:boolean}) {
 return <SettingsPanelDialog title="GitHub" summary={tr('github.groupsReadPrivateChatCanUseAll')} disabled={props.expired}>{controls=><GitHubEditor {...props} {...controls}/>}</SettingsPanelDialog>;
}
