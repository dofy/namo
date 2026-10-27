import { t as tr } from './i18n';
import { Badge, Heading, Text } from '@radix-ui/themes';
import type { EvidenceItem, RunEvidence } from '../src/ui-contract';
import { Notice } from './components';

const labels = () => ({ running: tr("status.running"), completed: tr("status.finished"), failed: tr("status.failed"), declined: tr("evidence.declined"), unknown: tr("evidence.unknownResult") });
const actions = () => ({ add: tr("common.add"), update: tr("common.update"), delete: tr("common.delete") });
function Outcome({ item }: { item: EvidenceItem }) {
  const failed = item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0);
  return <Badge color={failed ? 'red' : item.status === 'completed' ? 'blue' : 'gray'}>
    {labels()[item.status]}{item.exitCode !== undefined ? tr("evidence.exitCode") + item.exitCode : ''}
  </Badge>;
}

export function Evidence({ reports = [] }: { reports?: RunEvidence[] }) {
  return <section className="evidence" aria-label={tr("evidence.executionEvidence")}>
    <Heading as="h2" size="4">{tr("evidence.executionEvidence")}</Heading>
    <Text as="p" size="2" color="gray">{tr("evidence.recordsComeExecutionEventsExitCodeDescribes")}</Text>
    {!reports.length && <Notice>{tr("evidence.noEvidenceWasCapturedTaskHistoricalRecords")}</Notice>}
    {reports.map((report, index) => {
      const commands = report.items.filter(i => i.kind === 'command');
      const patches = report.items.filter(i => i.kind === 'files');
      const artifacts = report.items.filter(i => i.kind === 'artifact');
      const created = patches.flatMap(i => i.status === 'completed' ? (i.files ?? []).filter(f => f.action === 'add').map(f => ({
        path: f.movedTo ?? f.path, exists: f.existsAtFinish,
      })) : []);
      return <div className="evidence-run" key={report.runId}>
        <div className="detail-summary"><Text size="2" weight="medium">{tr("evidence.run")} {index + 1}</Text>
          <Badge color={report.state === 'partial' ? 'orange' : 'gray'}>{report.state === 'collecting' ? tr("evidence.recording") : report.state === 'partial' ? tr("evidence.partialRecord") : tr("evidence.recordingFinished")}</Badge>
        </div>
        {report.state === 'partial' && <Notice>{tr("evidence.executionDidNotFinishCleanlyActionsWithout")}</Notice>}
        {(report.truncated || report.items.some(i => i.limited)) && <Notice>{tr("evidence.someEventsPathsWereOmittedBecauseCapture")}</Notice>}
        <Heading as="h3" size="3">{tr("evidence.fileChanges")}</Heading>
        {!patches.length && <Text as="p" size="2" color="gray">{tr("evidence.noFilePatchesRecordedCommandsOtherTools")}</Text>}
        {patches.map(item => <div className="evidence-entry" key={item.id}>
          <Outcome item={item} />
          {(item.files ?? []).map((file, n) => <Text as="p" size="2" key={n}>{actions()[file.action]} · <code>{file.path}</code>{file.movedTo && <> → <code>{file.movedTo}</code></>}</Text>)}
          {!item.files?.length && <Text as="p" size="2" color="gray">{tr("evidence.pathsPatchNotShown")}</Text>}
        </div>)}
        <Heading as="h3" size="3">{tr("evidence.commands")}</Heading>
        {!commands.length && <Text as="p" size="2" color="gray">{tr("evidence.noCommandsRecordedVerificationStatusUnknown")}</Text>}
        {commands.map(item => <div className="evidence-entry" key={item.id}>
          <div className="evidence-command"><code>{item.label}</code><Outcome item={item} /></div>
          <Text as="p" size="1" color="gray">{tr("evidence.directory")}{item.cwd ?? tr("evidence.notShown")}{item.durationMs !== undefined && ' · ' + item.durationMs + ' ms'}{item.exitCode === undefined && tr("evidence.noExitCode")}</Text>
        </div>)}
        <Heading as="h3" size="3">{tr("evidence.artifactsCommitEvidence")}</Heading>
        {!created.length && !artifacts.length && <Text as="p" size="2" color="gray">{tr("evidence.noNewFilesImageArtifactsRecorded")}</Text>}
        {created.map((file, n) => <Text as="p" size="2" key={n}><code>{file.path}</code> · {file.exists === undefined ? tr("evidence.notChecked") : file.exists ? tr("evidence.fileExistedCompletionContentsUnverified") : tr("evidence.fileExistenceUnconfirmedCompletion")}</Text>)}
        {artifacts.map(item => <div className="evidence-entry" key={item.id}><Outcome item={item} /><Text as="p" size="2">
          {item.path ?? tr("evidence.artifactPathNotShown")} · {item.existsAtFinish === undefined ? tr("evidence.fileExistenceUnconfirmed") : item.existsAtFinish ? tr("evidence.fileExistedCompletionContentsUnverified") : tr("evidence.fileExistenceUnconfirmedCompletion")}
        </Text></div>)}
        <Text as="p" size="2" color="gray">{report.git.status === 'changed'
          ? 'HEAD ' + report.git.before?.slice(0, 12) + ' → ' + report.git.after?.slice(0, 12) + tr("evidence.headChangeConfirmedCommitOwnershipPushStatus")
          : report.git.status === 'unchanged' ? tr("evidence.headWasUnchangedCompletionWorkingTreeMay")
          : report.git.after ? tr("evidence.finalHead") + report.git.after.slice(0, 12) + tr("evidence.noComparableBaselineVerifiedCommitOwnership") : tr("evidence.noComparableGitHeadProjectRoot")}</Text>
        {report.items.some(i => i.kind === 'tool') && <Text as="p" size="2" color="gray">{tr("evidence.otherToolsWereCalledTheirContentExternal")}</Text>}
      </div>;
    })}
  </section>;
}
