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
  const labels = { name: tr("profiles.name"), language: tr("common.language"), timezone: tr("common.timezone") };
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
      setNotice(tr("profiles.profileSavedViewProfileDirectMessageNo"));
      try { await refresh(); } catch { setNotice(tr("profiles.profileSavedButRefreshFailedRefreshLater")); }
    } finally { setBusy(false); }
  }
  return <div className="profiles-page">
    <Text as="p" size="2" color="gray">{tr("profiles.enableProfileUseAssistantSettingsApplyThese")}</Text>
    {!profiles.available && <Notice>{profiles.reason}</Notice>}
    {profiles.available && !profiles.entries.length && <Notice>{tr("profiles.noPairedUsersYetRunNamoInit")}</Notice>}
    {selected && <>
      <Field label={tr("profiles.pairedUser")} htmlFor="profile-user"><Choice id="profile-user" value={key(selected)} disabled={dirty || busy || !profiles.available}
        onChange={value => { const next = profiles.entries.find(p => key(p) === value); reset(next, profiles.configRevision); setNotice(''); }}
        options={(current ? profiles.entries : [selected, ...profiles.entries]).map(p => ({ value: key(p), label: p.name && profiles.entries.filter(other => other.name === p.name).length === 1 ? p.name : `${p.name || tr("profiles.nameNotSet")} · …${p.userId.slice(-8)}` }))} /></Field>
      <details className="profile-account"><summary>{tr("profiles.accountDetails")}</summary>
        <div className="profile-identity"><Badge color="gray">{selected.channel === 'feishu' ? tr("profiles.feishu") : 'Lark'}</Badge><Text size="2">{tr("profiles.app")}{selected.appId}</Text><Text size="2">{tr("profiles.user")}{selected.userId}</Text></div>
        <Text as="p" size="1" color="gray">{tr("profiles.identityComesAppsPairingConfigurationPlatformDisplay")}</Text>
      </details>
      {dirty && <Text as="p" size="1" color="gray">{tr("profiles.saveDiscardDraftSelectingAnotherUser")}</Text>}
      {(!current || revision !== profiles.configRevision) && <Notice>{tr("profiles.pairingAppConfigurationChangedDraftPreservedDiscard")}</Notice>}
      {current && selected.version !== current.version && dirty && <Notice>{tr("profiles.newerVersionProfileExistsDraftPreservedReview")}</Notice>}
      {notice && <Notice>{notice}</Notice>}{error && <Notice error>{error}</Notice>}
      <form onSubmit={async event => { event.preventDefault(); if (busy) return; try { await save(draft); } catch (e) { setError(message(e)); } }}>
        <fieldset disabled={busy || !editable}>
          <Field label={tr("profiles.preferredName")} htmlFor="profile-name"><TextField.Root id="profile-name" value={draft.name} maxLength={160} placeholder={tr("profiles.exampleSeven")} onChange={event => { setDraft(p => ({ ...p, name: event.target.value })); setDirty(true); }} /></Field>
          <div className="form-grid">
            <Field label={tr("common.language")} htmlFor="profile-language"><TextField.Root id="profile-language" value={draft.language} maxLength={64} placeholder={tr("profiles.exampleEn")} onChange={event => { setDraft(p => ({ ...p, language: event.target.value })); setDirty(true); }} /></Field>
            <Field label={tr("common.timezone")} htmlFor="profile-timezone"><TextField.Root id="profile-timezone" value={draft.timezone} maxLength={64} placeholder={tr("profiles.exampleAsiaShanghai")} onChange={event => { setDraft(p => ({ ...p, timezone: event.target.value })); setDirty(true); }} /></Field>
          </div>
          <Text as="p" size="1" color="gray">{tr("profiles.upCharactersNameLeaveBlankUnsetNot")}</Text>
        </fieldset>
        <div className="profile-save">
          <Text as="p" size="2" color="gray">{selected.version ? tr("profiles.savedVersion", selected.version) : tr("profiles.noSavedProfile")}{selected.updatedAt ? ` · ${new Date(selected.updatedAt).toLocaleString(getLocale())}` : ''}</Text>
          <div className="profile-save-actions"><Button type="submit" disabled={!dirty || !editable} loading={busy}><Icon name="save" />{tr("profiles.save")}</Button>
          <ConfirmButton disabled={busy || expired} title={tr("profiles.reloadSavedProfile")} description={tr("profiles.unsavedDraftDiscarded")} action={tr("profiles.loadSavedProfile")} onConfirm={async () => {
            const latest = await api.state(); reset(latest.profiles.entries.find(p => key(p) === key(selected)) ?? latest.profiles.entries[0], latest.profiles.configRevision); setNotice(tr("profiles.savedProfileLoaded")); await refresh();
          }}><Icon name="reset" />{tr("common.reload")}</ConfirmButton></div>
        </div>
      </form>
      <ConfirmButton danger disabled={busy || dirty || !editable || !Object.values(values(selected)).some(Boolean)} title={tr("profiles.clearUsersProfile")}
        description={tr("profiles.clearNameLanguageTimeZoneWhileRetaining")} action={tr("profiles.clear")} onConfirm={() => save({ name: '', language: '', timezone: '' })}><Icon name="trash" />{tr("profiles.clear")}</ConfirmButton>
      {!!selected.changes.length && <details className="profile-history"><summary>{tr("profiles.recentChanges")} ({selected.changes.length})</summary><div className="audit">
        {selected.changes.map(change => <div key={change.version}><Text as="p" size="2">{tr("common.version")} {change.version} · {change.fields.map(f => labels[f]).join('、')} · {change.source === 'self' ? tr("profiles.ownersFeishuLarkDirectMessage") : tr("profiles.localWorkbench")}</Text>
          <Text size="1" color="gray">{new Date(change.createdAt).toLocaleString(getLocale())}{change.sourceRef ? tr("profiles.sourceMessage", change.sourceRef) : ''}</Text></div>)}
      </div></details>}
    </>}
  </div>;
}
