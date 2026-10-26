import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('git approval configuration defaults closed and validates explicit targets without exposing credentials', t => {
  const root = mkdtempSync(join(tmpdir(), 'namo-approval-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json'); const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save({}); assert.deepEqual(loadConfig(file).gitApprovals, { gitBin: undefined, sshCommand: undefined, maxTtlMs: 900000, remotes: [] });
  save({ gitApprovals: { gitBin: '/usr/bin/git', maxTtlMs: 60000, remotes: [{ name: 'origin', url: 'https://example.invalid/org/repo.git', transport: 'https', credentialHelpers: ['osxkeychain'] }] } });
  const configured = loadConfig(file).gitApprovals!; assert.equal(configured.gitBin, '/usr/bin/git'); assert.equal(configured.remotes.length, 1); assert.deepEqual(configured.remotes[0]?.credentialHelpers, ['osxkeychain']);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'ext' }] } }); assert.throws(() => loadConfig(file), /remote/);
  save({ gitApprovals: { remotes: [{ name: 'origin', url: 'x', transport: 'https' }, { name: 'origin', url: 'y', transport: 'https' }] } }); assert.throws(() => loadConfig(file), /unique/);
  save({ gitApprovals: { maxTtlMs: 999 } }); assert.throws(() => loadConfig(file), /maxTtlMs/);
});
