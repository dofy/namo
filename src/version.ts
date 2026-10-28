import { readFileSync } from 'node:fs';

/** Read from the running release, not the source checkout. */
export const NAMO_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
