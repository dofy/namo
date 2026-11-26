import { SettingToggle } from './SettingToggle';
import { useEffect, useRef, useState } from 'react';
import type { CodexUpdateStatus } from '../../src/ui-contract';
import { api, ApiError } from '../api';
import { ConfirmButton, Notice } from '../components';
import { Icon } from '../Icon';
import { t as tr, type MessageKey } from '../i18n';
import { CliUpdateDetails, CliUpdatePanel } from './CliUpdatePanel';

type Action = 'check' | 'upgrade' | 'automatic' | 'rollback';
const errorKeys: Record<string, MessageKey> = {
  update_busy: 'codexUpdate.busy',
  update_config_changed: 'codexUpdate.configChanged',
  update_unsupported: 'codexUpdate.unsupported',
  update_cli_unavailable: 'codexUpdate.cliUnavailable',
  update_download_failed: 'codexUpdate.downloadFailed',
  update_checksum_failed: 'codexUpdate.checksumFailed',
  codex_download_failed: 'codexUpdate.downloadFailed',
  codex_download_timeout: 'codexUpdate.downloadFailed',
  codex_checksum_mismatch: 'codexUpdate.checksumFailed',
  update_probe_failed: 'codexUpdate.probeFailed',
};
const errorKey = (code: string, fallback: MessageKey) => Object.hasOwn(errorKeys, code) ? errorKeys[code] : fallback;
function errorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return tr('ui.runNamoUiLocalTerminalOpenAuthorized');
  const code = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return tr(errorKey(code, 'codexUpdate.requestFailed'));
}

export function CodexUpdatePanel({ configRevision, disabled, pendingApplication=false }: { configRevision: string; disabled: boolean; pendingApplication?:boolean }) {
  const [status, setStatus] = useState<CodexUpdateStatus | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const requestVersion = useRef(0), mutationPending = useRef(false), mounted = useRef(false);
  const active = status?.state === 'checking' || status?.state === 'installing';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestVersion.current++; };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), version = ++requestVersion.current;
    setStatus(null); setError('');
    void api.codexUpdate(controller.signal).then(value => {
      if (!controller.signal.aborted && version === requestVersion.current) setStatus(value);
    }).catch(cause => { if (!controller.signal.aborted && version === requestVersion.current) setError(errorText(cause)); });
    return () => controller.abort();
  }, [configRevision]);
  useEffect(() => {
    if ((!active && !status?.automatic && status?.state !== 'deferred') || pending) return;
    const controller = new AbortController(), version = requestVersion.current;
    const timer = window.setTimeout(() => {
      void api.codexUpdate(controller.signal).then(value => {
        if (!controller.signal.aborted && version === requestVersion.current) { setStatus(value); setError(''); }
      }).catch(cause => {
        if (!controller.signal.aborted && version === requestVersion.current) {
          setError(errorText(cause));
          // Retain the operation state so a transient read failure does not
          // re-enable update actions while the server may still be working.
          setStatus(previous => previous ? { ...previous } : previous);
        }
      });
    }, active ? 2500 : 30_000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, pending, status]);

  async function act(action: Action, enabled?: boolean): Promise<void> {
    if (mutationPending.current) return;
    mutationPending.current = true;
    const version = ++requestVersion.current;
    setPending(action); setError('');
    try {
      const next = await api.changeCodexUpdate(configRevision, action, enabled);
      if (mounted.current && version === requestVersion.current) setStatus(next);
    } catch (cause) {
      if (mounted.current && version === requestVersion.current) setError(errorText(cause));
    } finally {
      mutationPending.current = false;
      if (mounted.current) setPending(null);
    }
  }

  const busy = pending !== null || active;
  const unavailable = !status?.supported || disabled || busy;
  const canUpdate = !!(status?.supported && status.currentVersion);
  const canRollback = !!(status?.supported && status.previousVersion);
  const stateKeys: Record<CodexUpdateStatus['state'], MessageKey> = {
    idle: 'codexUpdate.idle', checking: 'codexUpdate.checking', installing: 'codexUpdate.installing',
    deferred: 'codexUpdate.deferred', failed: 'codexUpdate.failed',
  };
  const statusText = status && (status.state !== 'idle' || canUpdate) ? tr(stateKeys[status.state]) +
    (status.state === 'idle' && status.latestVersion ? ` · ${tr(status.updateAvailable ? 'codexUpdate.available' : 'codexUpdate.upToDate')}` : '') : undefined;
  return <CliUpdatePanel id="codex-update-title" title={tr('codexUpdate.title')}
    description={tr(status?.currentVersion && !status.managed ? 'codexUpdate.externalHelp' : 'codexUpdate.help')}>
    {pendingApplication&&status?.automatic&&<Notice>{tr('codexUpdate.pendingApplication')}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {status?.error && <Notice error>{tr(errorKey(status.error, 'codexUpdate.failed'))}</Notice>}
    {status && !status.supported && <Notice>{tr('codexUpdate.unsupported')}</Notice>}
    {status?.supported && !status.currentVersion && !busy && <Notice>{tr('codexUpdate.cliUnavailable')}</Notice>}
    {disabled && <Notice>{tr('codexUpdate.settingsDraft')}</Notice>}
    <CliUpdateDetails version={status} latestLabel={tr('codexUpdate.latest')} statusText={statusText}
      check={canUpdate ? { loading: pending === 'check' || status?.state === 'checking', disabled: busy, run: () => void act('check') } : undefined}
      upgrade={canUpdate ? { title: tr('codexUpdate.upgradeTitle'), description: tr('codexUpdate.upgradeDescription', status?.latestVersion ?? ''),
        disabled: unavailable || !status?.updateAvailable, run: () => act('upgrade') } : undefined}>
      {(canUpdate || canRollback) && <ConfirmButton title={tr('codexUpdate.rollbackTitle')} description={tr('codexUpdate.rollbackDescription', status?.previousVersion ?? '')}
        action={tr('codexUpdate.rollback')} disabled={unavailable || !status?.previousVersion} onConfirm={() => act('rollback')}>
        <Icon name="reset" />{tr('codexUpdate.rollback')}
      </ConfirmButton>}
    </CliUpdateDetails>
    {(canUpdate || status?.automatic) && <div className="setting-options"><SettingToggle icon="refresh" title={tr('codexUpdate.automatic')} description={tr('codexUpdate.automaticHelp')} checked={status?.automatic === true} disabled={unavailable} onChange={value => void act('automatic', value)} /></div>}
  </CliUpdatePanel>;
}
