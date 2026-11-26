import { readFileSync } from 'node:fs';

/** Read from the running release, not the source checkout. */
export const NAMO_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export function newerVersion(candidate: string, current: string | null): boolean {
  if (!current) return true;
  const next = candidate.split('.').map(Number);
  const installed = current.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== installed[i]) return next[i] > installed[i];
  }
  return current.includes('-');
}
