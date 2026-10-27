import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// Select current sources so tsc's stale output cannot resurrect deleted tests.
const tests = readdirSync(new URL('test/', root)).filter(name => name.endsWith('.test.ts')).sort()
  .map(name => fileURLToPath(new URL(`dist/test/${name.replace(/\.ts$/, '.js')}`, root)));
if (!tests.length) throw new Error('No test sources found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...process.argv.slice(2), ...tests],
  { cwd: fileURLToPath(root), stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
