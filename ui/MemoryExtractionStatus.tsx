import { Badge, Flex, Text } from '@radix-ui/themes';
import type { MemoryExtractionJob, MemoryExtractionView } from '../src/ui-contract';
import { getLocale, t as tr } from './i18n';

const stamp = (time:number) => new Date(time).toLocaleString(getLocale());
const errorKeys={
  extraction_failed:'memory.extraction.errorFailed', timeout:'memory.extraction.errorTimeout',
  connection_failed:'memory.extraction.errorConnection', invalid_output:'memory.extraction.errorOutput',
  tool_rejected:'memory.extraction.errorTool',
} as const;
function status(job:MemoryExtractionJob):string {
  if(job.state==='pending')return tr(job.error?'memory.extraction.retrying':'memory.extraction.pending');
  if(job.state==='running')return tr(job.leaseUntil<=Date.now()?'memory.extraction.recovering':'memory.extraction.running');
  if(job.state==='failed')return tr('memory.extraction.failed');
  if(!job.accepted)return tr(job.rejected?'memory.extraction.filtered':'memory.extraction.empty');
  return tr('memory.extraction.completed');
}
function JobStatus({job,maxAttempts}:{job:MemoryExtractionJob;maxAttempts:number}) {
  const reason=job.error?tr(errorKeys[job.error]):null;
  return <div className="memory-extraction-job">
    <Flex gap="2" align="center" wrap="wrap">
      <Badge color={job.state==='failed'?'red':job.state==='running'?'blue':job.state==='pending'?'orange':'gray'}>{status(job)}</Badge>
      {job.project&&<Text size="2">{job.project}</Text>}
      <Text size="1" color="gray">{tr('memory.extraction.attempts',job.attempts,maxAttempts)}</Text>
      <Text size="1" color="gray">{stamp(job.createdAt)}</Text>
    </Flex>
    {job.state==='completed'&&<Text as="p" size="2" color="gray">{tr('memory.extraction.result',job.accepted??0,job.rejected??0)}</Text>}
    {reason&&<Text as="p" size="2" color="gray">{reason}</Text>}
    {job.state==='pending'&&job.error&&<Text as="p" size="1" color="gray">{job.dueAt>Date.now()?tr('memory.extraction.retryAt',stamp(job.dueAt)):tr('memory.extraction.retryWhenIdle')}</Text>}
    {job.state==='failed'&&<Text as="p" size="1" color="gray">{tr('memory.extraction.diagnose')}</Text>}
  </div>;
}
export function MemoryExtractionStatus({value}:{value:MemoryExtractionView}) {
  const latest=value.recent[0];
  return <section className="memory-extraction" aria-label={tr('memory.extraction.title')}>
    <Text as="p" size="2" weight="bold">{tr('memory.extraction.title')}</Text>
    <Text as="p" size="2" color="gray">{tr('memory.extraction.help')}</Text>
    <Flex gap="2" wrap="wrap" role="status">
      <Badge color="gray">{tr('memory.extraction.pendingCount',value.pending)}</Badge>
      <Badge color="blue">{tr('memory.extraction.runningCount',value.running)}</Badge>
      <Badge color={value.failed?'red':'gray'}>{tr('memory.extraction.failedCount',value.failed)}</Badge>
    </Flex>
    {latest?<JobStatus job={latest} maxAttempts={value.maxAttempts}/>:<Text as="p" size="2" color="gray">{tr('memory.extraction.noJobs')}</Text>}
    {value.recent.length>1&&<details>
      <summary>{tr('memory.extraction.recent',value.recent.length)}</summary>
      {value.recent.slice(1).map(job=><JobStatus key={job.id} job={job} maxAttempts={value.maxAttempts}/>)}
      {value.hasMore&&<Text as="p" size="1" color="gray">{tr('memory.extraction.limited')}</Text>}
    </details>}
  </section>;
}
