import { t as tr } from '../i18n';
import { Icon } from '../Icon';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Checkbox, Code, Flex, Heading, Link, Text, TextField } from '@radix-ui/themes';
import type { AgentConfigPatch, ClaudeGatewayView, ConfigView, ManagementState, Diagnostic } from '../../src/ui-contract';
import { api, message } from '../api';
import { PageSection, SectionHeading } from '../components/PageSection';
import { Choice, Field, Notice } from '../components';
import { AgentReplyTest } from '../AgentReplyTest';
import { ServiceAccessSettings } from '../ServiceAccessSettings';
import { McpSettings } from '../McpSettings';
import { GitHubSettings } from '../GitHubSettings';

const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
const connectionStatus = {
  unchecked: ['connections.statusUnchecked', 'gray'],
  gateway: ['connections.statusGatewayConfigured', 'gray'],
  disabled: ['connections.statusDisabled', 'gray'],
  unavailable: ['connections.statusUnavailable', 'red'],
  checked: ['connections.statusChecked', 'gray'],
  verified: ['connections.statusVerified', 'green'],
  failed: ['connections.statusFailed', 'red'],
  replyFailed: ['connections.statusReplyFailed', 'red'],
  interrupted: ['connections.statusInterrupted', 'red'],
} as const;

function ConnectionDetails({ label, children }: { label: string; children: ReactNode }) {
  return <details className="executor-disclosure">
    <summary><span>{label}</span><Icon name="right" size={14} /></summary>
    <div className="executor-detail-content">{children}</div>
  </details>;
}

function AgentDiagnostics({ profile, label, expired, initial = 'unchecked' }: {
  profile: string; label: string; expired: boolean; initial?: 'unchecked' | 'gateway' | 'disabled' | 'unavailable';
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checks, setChecks] = useState<Diagnostic[]>([]);
  const [testing, setTesting] = useState(false);
  const available = initial !== 'disabled' && initial !== 'unavailable';
  const executorChecks = checks.filter(check => check.id === 'config' || (check.id.startsWith('agent.') && check.id !== 'agent.inference'));
  const inference = checks.find(check => check.id === 'agent.inference');
  const [status, color] = connectionStatus[error ? 'interrupted'
    : executorChecks.some(check => check.status === 'fail') ? 'failed'
    : inference?.status === 'ok' ? 'verified'
    : inference?.status === 'fail' ? 'replyFailed'
    : executorChecks.some(check => check.id.startsWith('agent.') && check.status === 'ok') ? 'checked'
    : initial];
  return <>
    <Flex gap="2" wrap="wrap" align="center" justify="between">
      <div role="status"><Badge variant="soft" color={color}>{tr(status)}</Badge></div>
      <Flex className="executor-actions" gap="2" wrap="wrap">
        <Button type="button" variant="soft" disabled={expired || !available || testing} loading={busy} onClick={async () => {
          setBusy(true); setError('');
          try { setChecks(await api.diagnose(false, profile)); }
          catch (e) { setChecks([]); setError(message(e)); }
          finally { setBusy(false); }
        }}><Icon name="activity" />{tr("connections.runDiagnostics")}</Button>
        <AgentReplyTest profile={profile} label={label} disabled={busy || expired || !available} onBusyChange={setTesting}
          onResult={next => { setError(''); setChecks(next); }} />
      </Flex>
    </Flex>
    {(error || checks.length > 0) && <ConnectionDetails label={tr('operations.liveTestDetails')}>
      {error && <Notice error>{error}</Notice>}
      {checks.length > 0 && <div className="diagnostics">{checks.map(check => <div key={check.id}>
        <Text as="p" size="2">{check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×'} {check.message}</Text>
        {check.next && <Text as="p" size="2" color="gray">{check.next}</Text>}
      </div>)}</div>}
    </ConnectionDetails>}
  </>;
}

function CodexConnection({ file, expired }: { file: string; expired: boolean }) {
  return <PageSection icon="assistant" title="Codex">
    <AgentDiagnostics profile="codex" label="Codex" expired={expired} />
    <ConnectionDetails label={tr('connections.loginAndSettings')}>
      <Text as="p" size="2" color="gray">{tr('connections.codexBuiltIn')}</Text>
      <Heading as="h3" size="3">{tr('connections.signReauthorize')}</Heading>
      <Text as="p" size="2" color="gray">{tr('connections.runCommandLocalTerminalCompleteOfficialLogin')}</Text>
      <Code variant="ghost">namo login --profile codex --config {quote(file)}</Code>
      <Text as="p" size="2" color="gray">{tr('connections.diagnosticsCheckEnvironmentConnectionWithoutCallingModel')}</Text>
    </ConnectionDetails>
  </PageSection>;
}

function ExecutorConnections({ config, refresh, expired }: { config: ConfigView; refresh: () => Promise<unknown>; expired: boolean }) {
  const agents = config.agentConnections;
  const claude = agents?.profiles.find(p => p.id === 'claude');
  const available = claude?.adapter !== 'codex' && !!agents;
  const [draft, setDraft] = useState({ enabled: available && !!claude?.enabled, bin: claude?.bin ?? 'claude', model: claude?.model ?? '' });
  const [auth, setAuth] = useState<'login' | ClaudeGatewayView['auth']>(claude?.gateway?.auth ?? 'login');
  const [baseUrl, setBaseUrl] = useState(claude?.gateway?.baseUrl ?? '');
  const [newSecret, setNewSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ target: 'default' | 'claude'; text: string; error?: boolean }>();
  const dirty = draft.enabled !== !!claude?.enabled || draft.bin !== (claude?.bin ?? 'claude') || draft.model !== (claude?.model ?? '')
    || auth !== (claude?.gateway?.auth ?? 'login') || (auth !== 'login' && (baseUrl !== claude?.gateway?.baseUrl || !!newSecret));
  async function save(patch: AgentConfigPatch) {
    const target = patch.defaultAgentProfile === undefined ? 'claude' : 'default';
    setSaving(true); setFeedback(undefined);
    try { await api.saveAgents(config.revision, patch); }
    catch (error) { setFeedback({ target, text: message(error), error: true }); setSaving(false); return; }
    try { await refresh(); setFeedback({ target, text: tr('claude.saved') }); }
    catch { setFeedback({ target, text: tr('settings.savedRefreshFailed'), error: true }); }
    finally { setSaving(false); }
  }
  return <>
    {agents && <div className="page-panel">
      <div className="default-executor">
        <div>
          <Text as="label" htmlFor="default-agent" size="2" weight="medium">{tr('claude.defaultAgent')}</Text>
          <Text as="p" size="2" color="gray" mt="1">{tr('claude.defaultHelp')}</Text>
        </div>
        <Choice id="default-agent" value={agents.defaultProfile} disabled={expired || saving || dirty}
          options={agents.profiles.filter(p => p.enabled).map(p => ({ value: p.id, label: p.label }))}
          onChange={defaultAgentProfile => void save({ defaultAgentProfile })} />
      </div>
      {feedback?.target === 'default' && <Notice error={feedback.error}>{feedback.text}</Notice>}
    </div>}
    <div className="executor-connections">
      <CodexConnection file={config.file} expired={expired} />
      <PageSection icon="assistant" title="Claude Code">
        <AgentDiagnostics profile="claude" label="Claude Code" expired={expired || saving}
          initial={!available ? 'unavailable' : !claude?.enabled ? 'disabled' : claude.gateway ? 'gateway' : 'unchecked'} />
        <ConnectionDetails label={tr('connections.loginAndSettings')}>
          {available && <form onSubmit={event => {
            event.preventDefault();
            const gateway = auth === 'login' ? null : { baseUrl, auth, ...(newSecret ? { newSecret } : {}) };
            void save({ claudeCode: { ...draft, gateway } });
          }}>
            <Flex align="center" gap="2" asChild>
              <Text as="label" size="2"><Checkbox checked={draft.enabled} disabled={expired || saving}
                onCheckedChange={value => setDraft({ ...draft, enabled: value === true })} />{tr('claude.enable')}</Text>
            </Flex>
            <Text as="p" size="2" color="gray" mt="1">{tr('claude.enableHelp')}</Text>
            <div className="form-grid claude-connection-fields">
              <Field label={tr('claude.bin')} htmlFor="claude-bin"><TextField.Root id="claude-bin" value={draft.bin}
                required disabled={expired || saving} onChange={event => setDraft({ ...draft, bin: event.target.value })} /></Field>
              <Field label={tr('claude.model')} htmlFor="claude-model"><TextField.Root id="claude-model" value={draft.model}
                disabled={expired || saving} onChange={event => setDraft({ ...draft, model: event.target.value })} /></Field>
              <Field label={tr('claude.authMethod')} htmlFor="claude-auth" className="gateway-field">
                <Choice id="claude-auth" value={auth} disabled={expired || saving}
                  options={[{ value: 'login', label: tr('claude.authLogin') }, { value: 'bearer', label: tr('claude.authGatewayBearer') },
                    { value: 'api-key', label: tr('claude.authGatewayApiKey') }]}
                  onChange={value => setAuth(value as typeof auth)} />
              </Field>
              {auth !== 'login' && <>
                <Field label={tr('claude.gatewayUrl')} htmlFor="claude-base-url" className="gateway-field"><TextField.Root id="claude-base-url" type="url" value={baseUrl}
                  maxLength={2048} required disabled={expired || saving} onChange={event => setBaseUrl(event.target.value)} /></Field>
                <Field label={tr('claude.gatewayCredential')} htmlFor="claude-gateway-secret" className="gateway-field"><TextField.Root id="claude-gateway-secret"
                  type="password" autoComplete="new-password" value={newSecret} minLength={6} maxLength={4096} required={!claude?.gateway}
                  placeholder={claude?.gateway ? tr('claude.gatewayCredentialSaved') : undefined}
                  disabled={expired || saving} onChange={event => setNewSecret(event.target.value)} /></Field>
              </>}
            </div>
            <Button type="submit" disabled={expired || !dirty} loading={saving}>{tr('claude.save')}</Button>
          </form>}
          {claude?.adapter === 'codex' && <Notice error>{tr('claude.profileConflict')}</Notice>}
          {feedback?.target === 'claude' && <Notice error={feedback.error}>{feedback.text}</Notice>}
          {claude?.adapter === 'claude' && claude.enabled && <div className="connection-help">
            {claude.gateway ? <Text as="p" size="2" color="gray">{tr('claude.gatewayHelp')}</Text> : <>
              <Text as="p" size="2" color="gray">{tr('claude.loginHelp')}</Text>
              <Code variant="ghost">namo login --profile claude --config {quote(config.file)}</Code>
            </>}
          </div>}
        </ConnectionDetails>
      </PageSection>
    </div>
  </>;
}

export function ConnectionsPage({ state, refresh, expired }: {
  state: ManagementState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const { config, profiles } = state;
  return <div id="settings-connections" className="connections-page settings-anchor">
    <ExecutorConnections key={config.revision} config={config} refresh={refresh} expired={expired} />
    <section className="page-panel"><div className="connection"><div><SectionHeading icon="sessions" title={tr("connections.feishuBot")} />
      <Text as="p" size="2" color="gray">{config.feishu.appId}  {config.feishu.access?tr("connections.organizationService"):tr("connections.pairedUsers",config.feishu.pairedUsers)} {config.feishu.secretConfigured ? tr("common.credentialsConfigured") : tr("connections.credentialsMissing")}</Text></div>
      <Link href={config.feishu.domain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">{tr("connections.openDeveloperConsole")}</Link>
    </div>
    <div className="connection-help"><h3>{tr("design.feishuSetup")}</h3><ol className="steps"><li>{tr("connections.enableBotCapabilitiesSetAppAvailabilityScope")}</li><li>{tr("connections.usePersistentConnectionSubscribeImMessageReceive")}</li>
      <li>{tr("connections.requestPermissionsReceiveDirectMessagesGroupMentions")}</li><li>{tr("connections.cardButtonsAlsoRequireCardActionTrigger")}</li></ol>
    {!config.feishu.access && <div className="guide"><Heading as="h3" size="3">{tr("connections.pairAnotherUser")}</Heading>
      <Text as="p" size="2" color="gray">{tr("connections.stopReceiverDuringMaintenanceWindowThenRun")}</Text>
      <Code variant="ghost">{'namo service stop --config ' + quote(config.file) + '\nnamo init --config ' + quote(config.file)}</Code>
      <Text as="p" size="2" color="gray">{tr("connections.setupCannotConnectWhileAnotherReceiverActive")}</Text>
    </div>}
    </div></section>
    <ServiceAccessSettings config={config} profiles={profiles} refresh={refresh} expired={expired} />
    <McpSettings config={config} refresh={refresh} expired={expired} />
    <GitHubSettings config={config} profiles={profiles} refresh={refresh} expired={expired} />
  </div>;
}
