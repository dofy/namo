import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeAgent, probeCursorAcp } from '../src/agent-probes.js';

function fixture(t: { after: (fn: () => void) => void }, name: string,
  source: string | ((dir: string) => string)): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'namo-agent-probe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${typeof source === 'function' ? source(dir) : source}`, { mode: 0o700 });
  return { dir, bin };
}

const CLAUDE = String.raw`
const args=process.argv.slice(2);
if(process.env.NAMO_PROBE_SECRET)process.exit(31);
if(args[0]==='--version'){console.log('2.1.311 (Claude Code)');process.exit(0)}
if(args[0]==='--help'){console.log('--print --input-format --output-format --resume --permission-mode');process.exit(0)}
if(args[0]==='auth'&&args[1]==='status'){console.log(JSON.stringify({loggedIn:false,authMethod:'none',account:'PRIVATE_ACCOUNT'}));process.exit(1)}
process.exit(2);
`;

const CURSOR = String.raw`
import{createInterface}from'node:readline';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('2026.10.22-27dcf5f');process.exit(0)}
if(args[0]==='status'){console.log('You are not authenticated with Cursor. PRIVATE_ACCOUNT');process.exit(0)}
if(args[0]==='acp')createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'cursor_login',name:'Private label'}]}})+'\n')});
`;

test('Claude keeps installation, protocol surface, SDK identity, and auth status independent', async t => {
  const { dir, bin } = fixture(t, 'claude', CLAUDE);
  const manifest = join(dir, 'package.json');
  const home = join(dir, 'home');
  const configDir = join(dir, 'config');
  mkdirSync(home);
  mkdirSync(configDir);
  writeFileSync(manifest, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.311', privateValue: 'PRIVATE' }));
  const previous = process.env.NAMO_PROBE_SECRET;
  process.env.NAMO_PROBE_SECRET = 'must-not-reach-child';
  t.after(() => {
    if (previous === undefined) delete process.env.NAMO_PROBE_SECRET;
    else process.env.NAMO_PROBE_SECRET = previous;
  });

  const report = await probeClaudeAgent({ bin, home, configDir, sdkPackageJson: manifest, timeoutMs: 1_000 });
  assert.equal(report.version, '2.1.311');
  assert.deepEqual(report.installed, { status: 'supported', evidence: 'claude_version_verified' });
  assert.deepEqual(report.protocol, { status: 'unverified', evidence: 'claude_stream_json_surface_detected' });
  assert.deepEqual(report.auth, { status: 'unavailable', evidence: 'claude_auth_not_logged_in' });
  assert.deepEqual(report.components?.sdk, { status: 'supported', evidence: 'claude_sdk_manifest_verified', version: '0.3.311' });
  assert.equal(report.capabilities.externalWait.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|must-not-reach-child/);
});

test('Cursor verifies binary identity and ACP initialize without claiming auth or task execution', async t => {
  const { dir, bin } = fixture(t, 'agent', CURSOR);
  const home = join(dir, 'home');
  const configDir = join(dir, 'config');
  mkdirSync(home);
  mkdirSync(configDir);
  const report = await probeCursorAcp({ bin, home, configDir, timeoutMs: 1_000 });
  assert.equal(report.version, '2026.10.22-27dcf5f');
  assert.equal(report.installed.status, 'supported');
  assert.deepEqual(report.protocol, { status: 'supported', evidence: 'cursor_acp_initialize_v1' });
  assert.deepEqual(report.auth, { status: 'unavailable', evidence: 'cursor_auth_not_logged_in' });
  assert.deepEqual(report.capabilities.sessionLoad, { status: 'unverified', evidence: 'cursor_acp_load_session_advertised_only' });
  assert.equal(report.capabilities.sessionNew.status, 'unverified');
  assert.equal(report.capabilities.cancel.status, 'unverified');
  assert.equal(report.capabilities.permissionRequest.status, 'unverified');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('auth is skipped unless a dedicated home and config directory are both explicit', async t => {
  const claudeFixture = fixture(t, 'claude', CLAUDE);
  const cursorFixture = fixture(t, 'agent', CURSOR);
  const [claude, cursor] = await Promise.all([
    probeClaudeAgent({ bin: claudeFixture.bin, timeoutMs: 1_000 }),
    probeCursorAcp({ bin: cursorFixture.bin, timeoutMs: 1_000 }),
  ]);
  assert.deepEqual(claude.auth, { status: 'unverified', evidence: 'claude_dedicated_profile_not_selected' });
  assert.deepEqual(cursor.auth, { status: 'unverified', evidence: 'cursor_dedicated_profile_not_selected' });
});

test('missing executables make install, protocol, auth, and capabilities unavailable', async () => {
  const claude = await probeClaudeAgent({ bin: '/definitely/missing/namo-claude' });
  const cursor = await probeCursorAcp({ bin: '/definitely/missing/namo-agent' });
  for (const report of [claude, cursor]) {
    assert.equal(report.installed.status, 'unavailable');
    assert.equal(report.protocol.status, 'unavailable');
    assert.equal(report.auth.status, 'unavailable');
    assert.equal(report.capabilities.sessionLoad.status, 'unavailable');
  }
});

test('version probe timeout stays bounded and does not become an installed claim', async t => {
  const { bin } = fixture(t, 'claude', `setInterval(()=>{},1000);`);
  const started = Date.now();
  const report = await probeClaudeAgent({ bin, timeoutMs: 50 });
  assert.equal(report.installed.status, 'unverified');
  assert.equal(report.installed.evidence, 'claude_version_timeout');
  assert.ok(Date.now() - started < 1_000);
});

test('combined output cap kills a noisy process and never returns raw stderr', async t => {
  const { bin } = fixture(t, 'claude', `
if(process.argv[2]==='--version'){process.stdout.write('2.1.311');process.stderr.write('PRIVATE_SECRET'.repeat(1000));setInterval(()=>{},1000)}
`);
  const report = await probeClaudeAgent({ bin, timeoutMs: 1_000, maxOutputBytes: 1_024 });
  assert.deepEqual(report.installed, { status: 'unverified', evidence: 'claude_version_output_limit' });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_SECRET/);
});

test('malformed ACP output is unavailable even when Cursor version identity is valid', async t => {
  const { bin } = fixture(t, 'agent', String.raw`
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('2026.10.22-27dcf5f');process.exit(0)}
if(args[0]==='status'){console.log('not authenticated');process.exit(0)}
if(args[0]==='acp'){console.log('not-json');setInterval(()=>{},1000)}
`);
  const report = await probeCursorAcp({ bin, timeoutMs: 1_000 });
  assert.deepEqual(report.protocol, { status: 'unavailable', evidence: 'cursor_acp_malformed_json' });
  assert.equal(report.installed.status, 'supported');
  assert.deepEqual(report.auth, { status: 'unverified', evidence: 'cursor_dedicated_profile_not_selected' });
});

test('a generic executable named agent is not trusted from a semver-shaped response', async t => {
  const { bin } = fixture(t, 'agent', `if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0)}`);
  const report = await probeCursorAcp({ bin, timeoutMs: 1_000 });
  assert.deepEqual(report.installed, { status: 'unverified', evidence: 'cursor_identity_unverified' });
  assert.equal(report.protocol.status, 'unavailable');
});

test('Claude identity mismatch closes stdin safely and never executes auth status', async t => {
  const { dir, bin } = fixture(t, 'claude', fixtureDir => `
import{writeFileSync}from'node:fs';
process.stdin.destroy();
if(process.argv[2]==='--version'){console.log('1.2.3 generic wrapper');process.exit(0)}
if(process.argv[2]==='auth'){writeFileSync(${JSON.stringify(join(fixtureDir, 'auth-called'))},'bad');process.exit(0)}
`);
  const home = join(dir, 'home'); const configDir = join(dir, 'config');
  mkdirSync(home); mkdirSync(configDir);
  const report = await probeClaudeAgent({ bin, home, configDir, timeoutMs: 1_000 });
  assert.deepEqual(report.installed, { status: 'unverified', evidence: 'claude_identity_unverified' });
  assert.deepEqual(report.auth, { status: 'unverified', evidence: 'claude_auth_not_probed_unverified_identity' });
  assert.equal(existsSync(join(dir, 'auth-called')), false);
});

test('POSIX timeout kills wrapper descendants that keep probe stdio open', async t => {
  if (process.platform === 'win32') return t.skip('Windows only promises child-process cleanup');
  const { dir, bin } = fixture(t, 'claude', fixtureDir => `
import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
if(process.argv[2]==='--version'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
 writeFileSync(${JSON.stringify(join(fixtureDir, 'grandchild.pid'))},String(child.pid));
 process.exit(0);
}
`);
  const started = Date.now();
  const report = await probeClaudeAgent({ bin, timeoutMs: 1_000 });
  assert.deepEqual(report.installed, { status: 'unverified', evidence: 'claude_version_timeout' });
  assert.deepEqual(report.processCleanup, { status: 'supported', evidence: 'posix_process_group_cleanup' });
  assert.ok(Date.now() - started < 2_000);
  const pid = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 10 && alive; attempt += 1) {
    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
    catch { alive = false; }
  }
  assert.equal(alive, false);
});

test('Cursor unauthenticated text and nonzero success-looking status never count as authentication', async t => {
  for (const [text, exit] of [['Unauthenticated',0],['Authenticated',1],['No status available; previously authenticated',0]] as const) {
    const {dir,bin}=fixture(t,'agent',()=>`
if(process.argv[2]==='--version')console.log('2026.10.22-27dcf5f');
else if(process.argv[2]==='status'){console.log(${JSON.stringify(text)});process.exit(${exit});}
else if(process.argv[2]==='acp'){process.stdin.on('data',()=>{console.log(JSON.stringify({id:1,result:{protocolVersion:1,authMethods:[{id:'cursor_login'}]}}));});}
`);
    const home=join(dir,'home'),configDir=join(dir,'config');mkdirSync(home);mkdirSync(configDir);
    const report=await probeCursorAcp({bin,home,configDir,timeoutMs:1000});
    assert.notEqual(report.auth.status,'supported');
  }
});
test('Claude loggedIn true with failing process status is not authenticated evidence', async t => {
  const {dir,bin}=fixture(t,'claude',()=>`
if(process.argv[2]==='--version')console.log('2.1.311 (Claude Code)');
else if(process.argv[2]==='--help')console.log('--print --input-format --output-format --resume --permission-mode');
else if(process.argv[2]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(1);}
`);
  const home=join(dir,'home'),configDir=join(dir,'config');mkdirSync(home);mkdirSync(configDir);
  const report=await probeClaudeAgent({bin,home,configDir,timeoutMs:1000});
  assert.deepEqual(report.auth,{status:'unverified',evidence:'claude_auth_status_failed'});
});
