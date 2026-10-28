import { Badge, Heading, Text } from '@radix-ui/themes';
import { t as tr, type MessageKey } from '../i18n';
import type { AutomaticChange, AutomaticRelease } from '../../src/changelog-contract';

// Curated baseline remains available when a build has no complete Git history.
const releases: { date: string; version: string; changes: MessageKey[] }[] = [
  { date:'2026-10-28', version:'0.2.0', changes:[
    'changelog.modelSelection','changelog.cliUpdates','changelog.versionCommands','changelog.commandReplies','changelog.memoryAndData',
  ] },
  { date:'2026-10-26', version:'0.1.0', changes:[
    'changelog.initialBot','changelog.initialWorkbench','changelog.initialSafety',
  ] },
];
const fallback: AutomaticRelease[] = [{version:null,date:'2026-10-28',changes:[
  {id:'f2acbbf',kind:'feature',text:'',known:'changelogPage'},
  {id:'18ef06e',kind:'style',text:'',known:'compactTasks'},
]}];
const categories:Record<AutomaticChange['kind'],MessageKey>={feature:'changelog.feature',fix:'changelog.fix',performance:'changelog.performance',style:'changelog.improvement'};
const known:Record<NonNullable<AutomaticChange['known']>,MessageKey>={changelogPage:'changelog.changelogPage',compactTasks:'changelog.compactTasks'};

export function ChangelogPage() {
  return <section className="changelog" aria-label={tr('changelog.title')}>
    <div className="changelog-current"><Text size="2" color="gray">{tr('changelog.currentVersion')}</Text>
      <Text size="3" weight="medium">v{__NAMO_VERSION__}</Text></div>
    {__NAMO_CHANGELOG__.source==='git' && <Text as="p" size="1" color="gray" className="changelog-generated">{tr('changelog.generated')}</Text>}
    <div className="changelog-list">{(__NAMO_CHANGELOG__.source==='git'?__NAMO_CHANGELOG__.releases:fallback).map((release,index) => <article className="changelog-entry" key={release.version ?? `pending-${index}`}>
      <div className="changelog-entry-meta">
        <Heading as="h2" size="4">{release.version ? `v${release.version}` : tr(__NAMO_CHANGELOG__.source==='fallback' ? 'changelog.afterVersion' : 'changelog.unreleased')}</Heading>
        {release.version === __NAMO_VERSION__ && <Badge color="orange" variant="soft">{tr('changelog.current')}</Badge>}
        {release.date && <time dateTime={release.date}>{release.date}</time>}
      </div>
      {release.changes.length ? <ul>{release.changes.map(change=><li key={change.id}>{change.known ? tr(known[change.known]) : <><span className="changelog-kind">{tr(categories[change.kind])}</span>{change.text}</>}</li>)}</ul>
        : <Text size="2" color="gray">{tr('changelog.noChanges')}</Text>}
    </article>)}
    {__NAMO_CHANGELOG__.source==='fallback' && __NAMO_VERSION__!=='0.2.0' && <Text as="p" size="2" color="gray">{tr('changelog.historyUnavailable')}</Text>}
    {releases.map(release => <article className="changelog-entry" key={release.version}>
      <div className="changelog-entry-meta"><Heading as="h2" size="4">v{release.version}</Heading>
        {release.version === __NAMO_VERSION__ && <Badge color="orange" variant="soft">{tr('changelog.current')}</Badge>}
        <time dateTime={release.date}>{release.date}</time></div>
      <ul>{release.changes.map(change=><li key={change}>{tr(change)}</li>)}</ul>
    </article>)}</div>
  </section>;
}
