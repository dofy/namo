import { t as tr } from './locale.js';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { probeAgent, liveAgentTest, type Check } from './agents.js';
import { FeishuSetupConnection } from './feishu-setup.js';
import { serviceStatus } from './service.js';

export async function doctor(file: string, live = false): Promise<Check[]> {
  const checks: Check[] = [{ id: 'node', status: 'ok', message: `Node ${process.version}` }];
  if (!existsSync(file)) return [...checks, { id: 'config', status: 'fail', message: tr("doctor.noConfiguration", file), next: tr("doctor.runNamoInitUseConfigSelectExisting") }];
  let c;
  try { c = loadConfig(file); }
  catch { return [...checks, { id: 'config', status: 'fail', message: tr("doctor.configurationInvalidUnreadableReferencesMissingProjectDirectory"), next: tr("doctor.runNamoInitFixSettingsConfigurationContents") }]; }
  checks.push({ id: 'config', status: 'ok', message: tr("doctor.configuration", c.file) });
  checks.push(...await probeAgent(c));
  const connection = new FeishuSetupConnection(c.feishu);
  try {
    const valid = !!c.feishu.appId && !!c.feishu.appSecret && await connection.credentials();
    checks.push({ id: 'feishu.credentials', status: valid ? 'ok' : 'fail', message: valid ? tr("doctor.feishuAppCredentialsValid") : tr("doctor.feishuCredentialNetworkValidationFailed"), next: valid ? undefined : tr("doctor.runNamoInitCheckAppCredentialsPlatform") });
    if (valid) {
      try { await connection.identity(); checks.push({ id: 'feishu.bot', status: 'ok', message: tr("doctor.botIdentityAccessible") }); }
      catch { checks.push({ id: 'feishu.bot', status: 'fail', message: tr("doctor.botIdentityCouldNotRead"), next: tr("doctor.checkBotCapabilitiesAppPublicationAvailabilityScope") }); }
    }
  } finally { connection.close(); }
  if(c.feishu.access)checks.push({id:'feishu.organization',status:'ok',message:tr("doctor.organizationAccessEnabledMembersNotNeedIndividual")});
  else checks.push({ id: 'feishu.pairing', status: c.feishu.allowedUserIds.length ? 'ok' : 'fail', message: c.feishu.allowedUserIds.length ? tr("doctor.authorizedUsers", c.feishu.allowedUserIds.length) : tr("doctor.noPairedUsersIncomingMessagesNotExecute"), next: c.feishu.allowedUserIds.length ? undefined : tr("doctor.runNamoInitCompleteOneTimePairing") });
  checks.push({id:'feishu.optional-features',status:'warn',message:tr("doctor.checkPermissionsReactionsMessageReadsFileUploads"),next:'im:message.reactions:write_only / im:message.reactions:read / im:message:readonly / im:resource / im:message:send_as_bot'});
  const status = serviceStatus(c);
  checks.push({ id: 'service', status: status.ready ? 'ok' : 'warn', message: status.ready ? tr("doctor.backgroundInstanceReportedConnectionReadiness") : status.running ? tr("doctor.backgroundProcessExistsButConnectionReadinessUnconfirmed") : tr("doctor.backgroundServiceNotRunning"), next: status.ready ? undefined : tr("doctor.runNamoServiceStatusNamoLogsUse") });
  if (live) {
    if (checks.some(c => c.id.startsWith('agent.') && c.status === 'fail')) checks.push({ id: 'agent.inference', status: 'fail', message: tr("doctor.agentPrerequisitesFailedModelWasNotCalled") });
    else {
      try { checks.push({ id: 'agent.inference', status: await liveAgentTest(c) ? 'ok' : 'fail', message: tr("doctor.realAgentResponseMarkerTest") }); }
      catch { checks.push({ id: 'agent.inference', status: 'fail', message: tr("doctor.realAgentCallFailedCheckAccountQuota") }); }
    }
  } else checks.push({ id: 'agent.inference', status: 'warn', message: tr("doctor.modelNotCalledNoInferenceQuotaUsed"), next: tr("doctor.runNamoDoctorLiveExplicitlyTestInference") });
  return checks;
}
