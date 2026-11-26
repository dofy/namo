import { useEffect, useState } from 'react';
import { Text } from '@radix-ui/themes';
import type { ClaudeUpdateStatus } from '../../src/ui-contract';
import { api, ApiError } from '../api';
import { Notice } from '../components';
import { t as tr, type MessageKey } from '../i18n';
import { CliUpdateDetails, CliUpdatePanel } from './CliUpdatePanel';
import { SettingToggle } from './SettingToggle';

const messages: Record<Exclude<ClaudeUpdateStatus['state'], 'idle'>, MessageKey> = {
  updating: 'claudeUpdate.updating', updated: 'claudeUpdate.updated',
  unchanged: 'claudeUpdate.unchanged', failed: 'claudeUpdate.failed', deferred: 'claudeUpdate.deferred',
};

function updateError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return tr('ui.runNamoUiLocalTerminalOpenAuthorized');
  switch (error instanceof Error ? error.message : '') {
    case 'update_config_changed': return tr('codexUpdate.configChanged');
    case 'update_busy': return tr('codexUpdate.busy');
    case 'update_cli_unavailable': return tr('claudeUpdate.unavailable');
    case 'update_check_failed': return tr('claudeUpdate.checkFailed');
    case 'update_queue_busy': return tr('claudeUpdate.queueBusy');
    default: return tr('codexUpdate.requestFailed');
  }
}

export function ClaudeUpdatePanel({ configRevision, disabled, pendingApplication }: { configRevision: string; disabled: boolean; pendingApplication: boolean }) {
  const [statuses, setStatuses] = useState<ClaudeUpdateStatus[]>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'check' | 'upgrade' | 'automatic'>();
  const loaded = !!statuses;
  const updating = statuses?.some(status => status.state === 'updating') ?? false;
  const automatic = statuses?.some(status => status.automatic) ?? false;
  const poll = updating || automatic;
  useEffect(() => {
    if (pending || loaded && !poll) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const delay = updating ? 2500 : 30_000;
    const load = async () => {
      try {
        const next = await api.claudeUpdate(controller.signal);
        if (controller.signal.aborted) return;
        setStatuses(next); setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(updateError(cause));
      }
      if (poll && !controller.signal.aborted) timer = window.setTimeout(load, delay);
    };
    if (loaded) timer = window.setTimeout(load, delay);
    else void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [loaded, pending, poll, updating]);

  async function act(action: NonNullable<typeof pending>, profileId: string | null, enabled = false) {
    setPending(action); setError('');
    try {
      setStatuses(await (action === 'automatic' ? api.setClaudeAutomaticUpdate(configRevision, profileId, enabled)
        : api.changeClaudeUpdate(configRevision, profileId, action)));
    } catch (cause) {
      const message = updateError(cause);
      if (action === 'upgrade') throw Error(message);
      setError(message);
    } finally { setPending(undefined); }
  }

  const busy = !!pending || updating;
  return <CliUpdatePanel id="claude-update-title" title={tr('claudeUpdate.title')} description={tr('claudeUpdate.help')}>
    {automatic && pendingApplication && <Notice>{tr('codexUpdate.pendingApplication')}</Notice>}
    {error && <Notice error>{error}</Notice>}
    {!statuses && !error && <Text as="p" size="2" color="gray" role="status">{tr('claudeUpdate.detecting')}</Text>}
    {statuses?.map(status => {
      let statusText: string;
      if (!status.updateSupported) statusText = tr(status.currentVersion ? 'claudeUpdate.external' : 'claudeUpdate.unavailable');
      else if (pending === 'check') statusText = tr('codexUpdate.checking');
      else if (status.state !== 'idle') statusText = tr(messages[status.state]);
      else if (status.latestVersion) statusText = tr(status.updateAvailable ? 'claudeUpdate.available' : 'claudeUpdate.upToDate');
      else statusText = tr('codexUpdate.idle');
      return <div className="cli-update-target" key={status.profileId ?? 'host'}>
        {statuses.length > 1 && <Text as="p" size="2" weight="medium">{status.label}</Text>}
        <CliUpdateDetails version={status} latestLabel={tr('claudeUpdate.latest')} statusText={statusText}
          check={status.updateSupported ? { loading: pending === 'check', disabled: busy, run: () => void act('check', status.profileId) } : undefined}
          upgrade={status.updateSupported ? { title: tr('claudeUpdate.upgradeTitle'), description: tr('claudeUpdate.upgradeDescription'),
            disabled: disabled || busy || !status.updateAvailable, run: () => act('upgrade', status.profileId) } : undefined} />
        {(status.updateSupported || status.automatic) && <div className="setting-options">
          <SettingToggle icon="refresh" title={tr('claudeUpdate.automatic')} description={tr('claudeUpdate.automaticHelp')}
            checked={status.automatic} disabled={disabled || busy} onChange={enabled => void act('automatic', status.profileId, enabled)} />
        </div>}
      </div>;
    })}
  </CliUpdatePanel>;
}
