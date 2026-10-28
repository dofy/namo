import { OperationsPanel } from '../OperationsPanel';
import { t as tr } from '../i18n';
import { Icon } from '../Icon';
import { useState } from 'react';
import { Button, Code, Flex, Heading, Link, Text } from '@radix-ui/themes';
import type { ManagementState, Diagnostic } from '../../src/ui-contract';
import { api, message } from '../api';
import { SectionHeading } from '../components/PageSection';
import { Notice } from '../components';
import { CodexReplyTest } from '../CodexReplyTest';
import { ServiceAccessSettings } from '../ServiceAccessSettings';
import { McpSettings } from '../McpSettings';
import { GitHubSettings } from '../GitHubSettings';

const quote = (value: string) => "'" + value.split("'").join("'\"'\"'") + "'";
export function ConnectionsPage({ state, refresh, expired }: {
  state: ManagementState; refresh: () => Promise<unknown>; expired: boolean;
}) {
  const { config, profiles } = state;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [checks, setChecks] = useState<Diagnostic[]>([]);
  const [testing, setTesting] = useState(false);
  return <div className="connections-page">
    <section className="page-panel">
    <div className="connection"><SectionHeading icon="assistant" title="Codex" description={tr("connections.officialAppServerIsolatedLogin")} />
      <Flex gap="2" wrap="wrap"><Button variant="soft" disabled={expired || testing} loading={busy} onClick={async () => {
        setBusy(true); setError('');
        try { setChecks(await api.diagnose()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}><Icon name="activity" />{tr("connections.runDiagnostics")}</Button>
    <CodexReplyTest disabled={busy || expired} onBusyChange={setTesting} onResult={next => { setError(''); setChecks(next); }}/></Flex>
    </div>
    {error && <Notice error>{error}</Notice>}
    <div className="diagnostics" aria-live="polite">{checks.map(check => <div key={check.id}>
      <Text as="p" size="2">{check.status === 'ok' ? '✓' : check.status === 'warn' ? '!' : '×'} {check.message}</Text>
      {check.next && <Text as="p" size="2" color="gray">{check.next}</Text>}
    </div>)}</div>
    <details className="connection-help"><summary>{tr("design.codexLogin")}</summary><div className="guide"><Heading as="h3" size="3">{tr("connections.signReauthorize")}</Heading>
      <Text as="p" size="2" color="gray">{tr("connections.runCommandLocalTerminalCompleteOfficialLogin")}</Text>
      <Code variant="ghost">namo login --config {quote(config.file)}</Code>
      <Text as="p" size="2" color="gray">{tr("connections.diagnosticsCheckEnvironmentConnectionWithoutCallingModel")}</Text>
    </div>
    </details></section>
    <section className="page-panel"><div className="connection"><div><SectionHeading icon="sessions" title={tr("connections.feishuBot")} />
      <Text as="p" size="2" color="gray">{config.feishu.appId}  {config.feishu.access?tr("connections.organizationService"):tr("connections.pairedUsers",config.feishu.pairedUsers)} {config.feishu.secretConfigured ? tr("common.credentialsConfigured") : tr("connections.credentialsMissing")}</Text></div>
      <Link href={config.feishu.domain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">{tr("connections.openDeveloperConsole")}</Link>
    </div>
    <details className="connection-help"><summary>{tr("design.feishuSetup")}</summary><ol className="steps"><li>{tr("connections.enableBotCapabilitiesSetAppAvailabilityScope")}</li><li>{tr("connections.usePersistentConnectionSubscribeImMessageReceive")}</li>
      <li>{tr("connections.requestPermissionsReceiveDirectMessagesGroupMentions")}</li><li>{tr("connections.cardButtonsAlsoRequireCardActionTrigger")}</li></ol>
    {!config.feishu.access && <div className="guide"><Heading as="h3" size="3">{tr("connections.pairAnotherUser")}</Heading>
      <Text as="p" size="2" color="gray">{tr("connections.stopReceiverDuringMaintenanceWindowThenRun")}</Text>
      <Code variant="ghost">{'namo service stop --config ' + quote(config.file) + '\nnamo init --config ' + quote(config.file)}</Code>
      <Text as="p" size="2" color="gray">{tr("connections.setupCannotConnectWhileAnotherReceiverActive")}</Text>
    </div>}
    </details></section>
    <ServiceAccessSettings config={config} refresh={refresh} expired={expired} />
    <McpSettings config={config} refresh={refresh} expired={expired} />
    <GitHubSettings config={config} profiles={profiles} refresh={refresh} expired={expired} />
    <OperationsPanel state={state} expired={expired}/>
  </div>;
}
