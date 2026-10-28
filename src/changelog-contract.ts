export type ChangelogKind = 'feature' | 'fix' | 'performance' | 'style';
export interface AutomaticChange { id: string; kind: ChangelogKind; text: string; known?: 'changelogPage' | 'compactTasks' }
export interface AutomaticRelease { version: string | null; date: string | null; changes: AutomaticChange[] }
export interface AutomaticChangelog { source: 'git' | 'fallback'; releases: AutomaticRelease[] }
