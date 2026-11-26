import { parseSelectedAction, type ConfigPrompter, type Option } from './config-prompts.js';
import type { MessageKey } from './i18n.js';
import { t } from './locale.js';
import { ManagementError, type Management } from './management.js';
import type { ClaudeUpdateStatus, CodexUpdateStatus, ConfigView } from './ui-contract.js';

type Target = ClaudeUpdateStatus | CodexUpdateStatus;
type Action = 'check' | 'automatic' | 'upgrade' | 'rollback';
const actions = {
  check: ['terminal.updateCheck', 'C'], automatic: ['terminal.updateAuto', 'O'],
  upgrade: ['codexUpdate.upgrade', 'U'], rollback: ['codexUpdate.rollback', 'B'],
} as const;

function availableActions(status: Target): Action[] {
  const claude = 'profileId' in status;
  if (status.state === 'checking' || status.state === 'installing' || status.state === 'updating') return [];
  const supported = claude ? status.updateSupported : status.supported && !!status.currentVersion;
  const result: Action[] = [];
  if (supported) result.push('check');
  if (supported || status.automatic && (claude || status.supported)) result.push('automatic');
  if (supported && status.updateAvailable) result.push('upgrade');
  if (!claude && status.supported && status.previousVersion) result.push('rollback');
  return result;
}

const states: Record<Target['state'], MessageKey> = {
  idle: 'codexUpdate.idle', checking: 'codexUpdate.checking', installing: 'codexUpdate.installing',
  deferred: 'codexUpdate.deferred', failed: 'codexUpdate.failed', updating: 'claudeUpdate.updating',
  updated: 'claudeUpdate.updated', unchanged: 'claudeUpdate.unchanged',
};
function statusText(status: Target): string {
  const claude = 'profileId' in status;
  let state = states[status.state];
  if (claude && !status.updateSupported) state = status.currentVersion ? 'claudeUpdate.external' : 'claudeUpdate.unavailable';
  else if (!claude && !status.supported) state = 'codexUpdate.unsupported';
  else if (!claude && !status.currentVersion && status.state === 'idle') state = 'codexUpdate.cliUnavailable';
  else if (claude && status.state === 'failed') state = 'claudeUpdate.failed';
  else if (claude && status.state === 'deferred') state = 'claudeUpdate.deferred';
  else if (status.state === 'idle' && status.latestVersion) state = status.updateAvailable ? 'codexUpdate.available' : 'codexUpdate.upToDate';
  return t('terminal.updateStatus', claude ? status.label : 'Codex', status.currentVersion ?? '—',
    status.latestVersion ?? '—', t(status.automatic ? 'terminal.yes' : 'terminal.no'), t(state));
}

function updateError(error: unknown, claude: boolean) {
  if (error instanceof ManagementError) {
    switch (error.message) {
      case 'update_queue_busy': return t('claudeUpdate.queueBusy');
      case 'update_busy': return t('codexUpdate.busy');
      case 'update_cli_unavailable': return t(claude ? 'claudeUpdate.unavailable' : 'codexUpdate.cliUnavailable');
      case 'update_config_changed': return t('management.configurationChangedAnotherPageProgramRefreshTry');
      case 'update_check_failed': return t(claude ? 'claudeUpdate.checkFailed' : 'codexUpdate.downloadFailed');
    }
  }
  return t('codexUpdate.requestFailed');
}

export async function manageUpdates(manager: Management, ui: ConfigPrompter, view: ConfigView): Promise<string> {
  const [codex, claude] = await Promise.allSettled([manager.codexUpdate(), manager.claudeUpdate()]);
  const targets: Target[] = [];
  const errors: string[] = [];
  if (codex.status === 'fulfilled') targets.push(codex.value);
  else errors.push(`Codex · ${updateError(codex.reason, false)}`);
  if (claude.status === 'fulfilled') targets.push(...claude.value);
  else errors.push(`Claude Code · ${updateError(claude.reason, true)}`);
  if (!targets.length) return errors.join('\n');
  for (const error of errors) ui.info(error);

  const rows = targets.map(status => ({
    value: 'profileId' in status ? `claude:${status.profileId ?? ''}` : 'codex',
    label: 'profileId' in status ? status.label : 'Codex', detail: status.currentVersion ?? t('codexUpdate.unknown'),
    availableActions: availableActions(status),
  }));
  const shortcuts: Option[] = [];
  for (const key of Object.keys(actions) as Action[]) {
    if (rows.some(row => row.availableActions.includes(key))) {
      const [label, shortcut] = actions[key];
      shortcuts.push({ value: key, label: t(label), shortcut, action: true, targeted: true });
    }
  }
  const selection = await ui.select(t('terminal.menuUpdate'), [...rows, ...shortcuts]);
  const targeted = parseSelectedAction(selection);
  const index = rows.findIndex(row => row.value === (targeted?.[1] ?? selection));
  if (index < 0) return t('terminal.invalidChoice');
  const status = targets[index], row = rows[index];
  const describe = (value: Target) => value.automatic && view.application === 'pending'
    ? statusText(value) + '\n' + t('codexUpdate.pendingApplication') : statusText(value);
  const summary = describe(status);
  if (!row.availableActions.length) return summary;
  ui.screen?.(); ui.info(summary);
  const chosen = targeted?.[0] ?? await ui.select(row.label, row.availableActions.map(action => ({
    value: action, label: t(actions[action][0]),
  })));
  const action = row.availableActions.find(available => available === chosen);
  if (!action) return summary;

  const isClaude = 'profileId' in status;
  let enabled: boolean | undefined;
  if (action === 'automatic') {
    ui.info(t(isClaude ? 'claudeUpdate.automaticHelp' : 'codexUpdate.automaticHelp'));
    enabled = await ui.confirm(t(isClaude ? 'claudeUpdate.automatic' : 'codexUpdate.automatic'), status.automatic);
    if (enabled === status.automatic) return summary;
  }
  let confirm = t('terminal.updateConfirm');
  if (action === 'upgrade') {
    confirm = isClaude ? t('claudeUpdate.upgradeDescription') : t('codexUpdate.upgradeDescription', status.latestVersion);
  } else if (action === 'rollback' && !isClaude) {
    confirm = t('codexUpdate.rollbackDescription', status.previousVersion);
  }
  if (!await ui.confirm(`${row.label} · ${confirm}`)) return t('terminal.cancelled');

  const input = { configRevision: view.revision, ...(enabled === undefined ? {} : { enabled }) };
  try {
    if (!isClaude) return describe(await manager.codexUpdate({ ...input, action }));
    if (action === 'rollback') return t('terminal.invalidChoice');
    const statuses = await manager.claudeUpdate({ ...input, profileId: status.profileId }, action);
    const updated = statuses.find(result => result.profileId === status.profileId);
    return updated ? describe(updated) : t('claudeUpdate.unavailable');
  } catch (error) { return updateError(error, isClaude); }
}
