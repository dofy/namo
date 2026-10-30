import { SectionHeading } from './PageSection';
import { SettingToggle } from './SettingToggle';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import type { CodexUpdateStatus } from '../../src/ui-contract';
import { api, ApiError } from '../api';
import { ConfirmButton, Notice } from '../components';
import { Icon } from '../Icon';
import { getLocale, t as tr, type MessageKey } from '../i18n';

type Action = 'check' | 'upgrade' | 'automatic' | 'rollback';
const errorKeys: Record<string, MessageKey> = {
  update_busy: 'codexUpdate.busy',
  update_config_changed: 'codexUpdate.configChanged',
  update_unsupported: 'codexUpdate.unsupported',
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
  const stateKeys: Record<CodexUpdateStatus['state'], MessageKey> = {
    idle: 'codexUpdate.idle', checking: 'codexUpdate.checking', installing: 'codexUpdate.installing',
    deferred: 'codexUpdate.deferred', failed: 'codexUpdate.failed',
  };
  return <section className="page-panel" aria-labelledby="codex-update-title">
    <div className="section-title">
      <SectionHeading icon="refresh" id="codex-update-title" title={tr('codexUpdate.title')} />
      {status && <Badge color={status.managed ? 'green' : 'gray'}>{tr(status.managed ? 'codexUpdate.managed' : 'codexUpdate.external')}</Badge>}
    </div>
    <Text as="p" size="2" color="gray">{tr('codexUpdate.help')}</Text>
    {pendingApplication&&status?.automatic&&<Notice>{tr('codexUpdate.pendingApplication')}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {status?.error && <Notice error>{tr(errorKey(status.error, 'codexUpdate.failed'))}</Notice>}
    {status && !status.supported && <Notice>{tr('codexUpdate.unsupported')}</Notice>}
    <div className="form-grid">
      <Text as="p" size="2">{tr('codexUpdate.current')}: <Text weight="medium">{status?.currentVersion ?? tr('codexUpdate.unknown')}</Text></Text>
      <Text as="p" size="2">{tr('codexUpdate.latest')}: <Text weight="medium">{status?.latestVersion ?? tr('codexUpdate.notChecked')}</Text></Text>
    </div>
    <Text as="p" size="1" color="gray">{tr('codexUpdate.checked')}: {status?.checkedAt ? new Date(status.checkedAt).toLocaleString(getLocale()) : tr('codexUpdate.notChecked')}</Text>
    {status && <Text as="p" size="2" role="status" aria-live="polite">{tr(stateKeys[status.state])}
      {status.state === 'idle' && status.latestVersion && ` · ${tr(status.updateAvailable ? 'codexUpdate.available' : 'codexUpdate.upToDate')}`}
    </Text>}
    {disabled && <Notice>{tr('codexUpdate.settingsDraft')}</Notice>}
    <Flex gap="3" wrap="wrap" mt="3">
      <Button type="button" variant="soft" loading={pending === 'check' || status?.state === 'checking'} disabled={busy || status?.supported === false}
        onClick={() => void act('check')}><Icon name="refresh" />{tr('codexUpdate.check')}</Button>
      <ConfirmButton title={tr('codexUpdate.upgradeTitle')} description={tr('codexUpdate.upgradeDescription', status?.latestVersion ?? '')}
        action={tr('codexUpdate.upgrade')} disabled={unavailable || !status?.updateAvailable} onConfirm={() => act('upgrade')}>
        <Icon name="play" />{tr('codexUpdate.upgrade')}
      </ConfirmButton>
      <ConfirmButton title={tr('codexUpdate.rollbackTitle')} description={tr('codexUpdate.rollbackDescription', status?.previousVersion ?? '')}
        action={tr('codexUpdate.rollback')} disabled={unavailable || !status?.previousVersion} onConfirm={() => act('rollback')}>
        <Icon name="reset" />{tr('codexUpdate.rollback')}
      </ConfirmButton>
    </Flex>
    <div className="setting-options"><SettingToggle icon="refresh" title={tr('codexUpdate.automatic')} description={tr('codexUpdate.automaticHelp')} checked={status?.automatic === true} disabled={unavailable} onChange={value => void act('automatic', value)} /></div>
  </section>;
}
