/** A separate process hashes snapshots so verification never stalls reception. */
import { verifyRuntimeRelease } from './release.js';
try {
  const [root, id] = process.argv.slice(2);
  if (process.argv.length !== 4 || !/^[a-f0-9]{64}$/.test(id ?? '')) throw Error('arguments');
  verifyRuntimeRelease(root, id);
} catch { process.exitCode = 1; }
