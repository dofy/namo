import { agentLoginCommand } from './agents.js';
import type { ConfigPrompter, Option } from './config-prompts.js';
import { t } from './locale.js';
import { ManagementError, type Management } from './management.js';
import { editForm, type Draft } from './terminal-forms.js';
import type { AgentConnectionView, ConfigView } from './ui-contract.js';

async function editClaudeConnection(manager: Management, ui: ConfigPrompter, view: ConfigView, profile?: AgentConnectionView) {
  const gateway = profile?.gateway;
  const usesGateway = (draft: Draft) => draft.auth !== 'login';
  return editForm(ui, 'Claude Code', {
    enabled: !!profile?.enabled, auth: gateway?.auth ?? 'login', baseUrl: gateway?.baseUrl ?? '', newSecret: '',
  }, [
    { key: 'enabled', label: t('claude.enable'), kind: 'boolean' },
    { key: 'auth', label: t('claude.authMethod'), kind: 'choice', choices: [
      { value: 'login', label: t('claude.authLogin') },
      { value: 'bearer', label: t('claude.authGatewayBearer') },
      { value: 'api-key', label: t('claude.authGatewayApiKey') },
    ] },
    { key: 'baseUrl', label: t('claude.gatewayUrl'), kind: 'text', visible: usesGateway },
    { key: 'newSecret', label: t('claude.gatewayCredential'), kind: 'secret', visible: usesGateway, clearable: true },
  ], draft => {
    manager.save(view.revision, { claudeCode: {
      enabled: draft.enabled, gateway: usesGateway(draft)
        ? { auth: draft.auth, baseUrl: draft.baseUrl, newSecret: draft.newSecret } : null,
    } });
  }, false, gateway ? t('claude.gatewayCredentialSaved') : t('claude.enableHelp'));
}

export async function manageAgentConnections(manager: Management, ui: ConfigPrompter, view: ConfigView): Promise<string> {
  const registry = view.agentConnections;
  if (!registry) throw new ManagementError(t('claude.configInvalid'));
  const options: Option[] = registry.profiles.map(profile => ({
    value: profile.id, label: profile.label, disabled: !profile.enabled && profile.id !== 'claude',
    detail: !profile.enabled ? t('connections.statusDisabled') : profile.gateway ? t('connections.statusGatewayConfigured') : undefined,
  }));
  if (!options.some(option => option.value === 'claude'))
    options.push({ value: 'claude', label: 'Claude Code', detail: t('connections.statusDisabled') });

  const id = await ui.select(t('terminal.menuLogin'), options, registry.defaultProfile);
  const profile = registry.profiles.find(item => item.id === id);
  const editable = id === 'claude' && (!profile || profile.adapter === 'claude');
  if (!profile?.enabled) {
    if (!editable) throw new ManagementError(t('claude.configInvalid'));
    return t(await editClaudeConnection(manager, ui, view, profile) ? 'terminal.saved' : 'terminal.cancelled');
  }

  ui.screen?.();
  if (id === 'claude' && !editable) ui.info(t('claude.profileConflict'));
  if (profile.gateway) ui.info(t('claude.gatewayHelp'));
  else {
    const login = agentLoginCommand(id, view.file);
    ui.info(login);
    if (profile.adapter === 'codex') ui.info(login + ' --device-auth');
  }
  const action = await ui.select(profile.label, [
    ...(editable ? [{ value: 'settings', label: t('connections.loginAndSettings') }] : []),
    { value: 'diagnose', label: t('connections.runDiagnostics') },
    { value: 'live', label: t('operations.liveTest', profile.label) },
  ]);
  if (action === 'settings' && editable)
    return t(await editClaudeConnection(manager, ui, view, profile) ? 'terminal.saved' : 'terminal.cancelled');
  const live = action === 'live';
  if (live && !await ui.confirm(t('operations.liveTestHelp', profile.label))) return t('terminal.cancelled');
  const results = await manager.diagnose(live, live, id);
  return results.map(check => `[${check.status}] ${check.message}${check.next ? '\n  ' + check.next : ''}`).join('\n');
}
