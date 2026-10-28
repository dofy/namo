import { Badge, Heading, Text } from '@radix-ui/themes';
import { t as tr, type MessageKey } from '../i18n';

// Update these entries with the release; they ship with the workbench and work offline.
const releases: { title: MessageKey; date: string; version?: string; changes: MessageKey[] }[] = [
  { title:'changelog.afterVersion', date:'2026-10-28', changes:['changelog.changelogPage','changelog.compactTasks'] },
  { title:'changelog.release', date:'2026-10-28', version:'0.2.0', changes:[
    'changelog.modelSelection','changelog.cliUpdates','changelog.versionCommands','changelog.commandReplies','changelog.memoryAndData',
  ] },
  { title:'changelog.release', date:'2026-10-26', version:'0.1.0', changes:[
    'changelog.initialBot','changelog.initialWorkbench','changelog.initialSafety',
  ] },
];

export function ChangelogPage() {
  return <section className="changelog" aria-label={tr('changelog.title')}>
    <div className="changelog-current"><Text size="2" color="gray">{tr('changelog.currentVersion')}</Text>
      <Text size="3" weight="medium">v{__NAMO_VERSION__}</Text></div>
    <div className="changelog-list">{releases.map(release => <article className="changelog-entry" key={release.version ?? 'after-0.2.0'}>
      <div className="changelog-entry-meta">
        <Heading as="h2" size="4">{release.version ? `v${release.version}` : tr(release.title)}</Heading>
        {release.version === __NAMO_VERSION__ && <Badge color="orange" variant="soft">{tr('changelog.current')}</Badge>}
        <time dateTime={release.date}>{release.date}</time>
      </div>
      <ul>{release.changes.map(change=><li key={change}>{tr(change)}</li>)}</ul>
    </article>)}</div>
  </section>;
}
