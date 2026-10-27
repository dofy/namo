import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { GitHubAccessError, ScopedGitHubAdapter, parseGitHubAccessConfig, publicGitHubAccess,
  type GitHubAccessConfig } from '../src/github-access.js';
import type { RequiredCheck } from '../src/external-waits.js';

const target = { owner: 'octo-org', repo: 'private-app', pullNumber: 7, headSha: 'a'.repeat(40) };
const checks: RequiredCheck[] = [{ kind: 'check_run', context: 'build', appId: 12 }];
const credential = 'synthetic-private-token-not-a-real-credential';
const config: GitHubAccessConfig = { token: credential, repositories: ['octo-org/private-app'], allowedUserIds: ['alice'] };
const localConfig:GitHubAccessConfig={source:'gh',localGh:{executable:'/usr/bin/gh',configDir:'/tmp/gh-test',login:'owner',userId:42},repositories:[],allowedUserIds:['alice']};

function fixture(t: any, chatType?: 'p2p' | 'group') {
  const dir = mkdtempSync(join(tmpdir(), 'namo-github-access-')), store = new Store(join(dir, 'bot.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.enqueue({ key: 'app:input', messageId: 'input', chatId: 'chat', chatKey: 'app:chat', senderId: 'alice', text: 'Wait for build',
    envelope: { version: 1, kind: 'instruction', type: 'text', scopeKey: 'app:chat', chatType, materials: [], limitations: [] } });
  const tasks = new Tasks(store), task = tasks.create(store.get('app:input')!, { cwd: dir, policyHash: 'test' });
  return { store, task, context: { taskId: task.id, ownerId: 'alice', chatId: 'chat' } };
}

function successfulFetch(requests: { url: string; options: RequestInit | undefined }[]): typeof fetch {
  return async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(String(url).includes('/check-runs?')
      ? { check_runs: [{ name: 'build', app: { id: 12 }, status: 'completed', conclusion: 'success' }] }
      : { head: { sha: target.headSha }, state: 'open' });
  };
}

test('GitHub configuration resolves only explicit dedicated environment names and never ambient token variables', () => {
  assert.equal(parseGitHubAccessConfig(undefined, { GH_TOKEN: credential, GITHUB_TOKEN: credential }), undefined);
  assert.equal(parseGitHubAccessConfig({}, { GH_TOKEN: credential, GITHUB_TOKEN: credential })?.token, undefined);
  assert.equal(parseGitHubAccessConfig({ tokenEnv: 'NAMO_GITHUB_TOKEN' })?.token, undefined);
  const parsed = parseGitHubAccessConfig({ tokenEnv: 'NAMO_GITHUB_TOKEN', repositories: ['Octo-Org/Private-App'], allowedUserIds: ['alice'] },
    { NAMO_GITHUB_TOKEN: credential });
  assert.equal(parsed?.token, credential); assert.equal(parsed?.tokenEnv, 'NAMO_GITHUB_TOKEN');
  assert.deepEqual(parsed?.repositories, ['octo-org/private-app']);
  assert.equal(publicGitHubAccess(parsed).credentialConfigured, true);
  assert.doesNotMatch(JSON.stringify(publicGitHubAccess(parsed)), new RegExp(credential));
  assert.equal(parseGitHubAccessConfig({ tokenEnv: 'NAMO_GITHUB_TOKEN' }, Object.create({ NAMO_GITHUB_TOKEN: credential }))?.token, undefined);
});

test('GitHub configuration rejects broad targets, inherited credentials and invalid values without echoing inputs', () => {
  for (const raw of [null, [], {source:['token']}, {source:12}, { token: credential, tokenEnv: 'NAMO_GITHUB_TOKEN' }, { tokenEnv: 'GH_TOKEN' },
    { tokenEnv: 'GITHUB_TOKEN' }, { tokenEnv: 'NAMO_GITHUB_' }, { baseUrl: 'https://elsewhere.test' },
    { repositories: ['octo-org/*'] }, { repositories: ['https://github.com/octo-org/app'] }, { repositories: ['octo-org/..'] },
    { repositories: ['octo-org/app/child'] }, { repositories: ['elsewhere.test/octo-org/app'] },
    { allowedUserIds: ['*'] }, { token: `secret\n${credential}` }]) {
    assert.throws(() => parseGitHubAccessConfig(raw), error => {
      assert.ok(error instanceof GitHubAccessError); assert.match(error.message, /^github_access_[a-z_]+$/);
      assert.doesNotMatch(error.message, new RegExp(credential)); return true;
    });
  }
});

test('private observations require exact repository, owner task and private chat, and return only a scope fingerprint', async t => {
  const f = fixture(t, 'p2p'), requests: { url: string; options: RequestInit | undefined }[] = [];
  const adapter = new ScopedGitHubAdapter(f.store, config, successfulFetch(requests));
  const scope = adapter.authorize(target, f.context);
  assert.match(scope!, /^[a-f0-9]{64}$/);
  assert.equal(scope, adapter.authorize({ ...target, owner: 'OCTO-ORG', repo: 'PRIVATE-APP' }, f.context));
  const result = await adapter.observe(target, checks, Date.now() + 5000, f.context);
  assert.equal(result.authorizationScope, scope); assert.equal(result.checks[0].result, 'passing');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(credential)); assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, 'https://api.github.com');
    assert.equal(request.options?.method, 'GET'); assert.equal(request.options?.redirect, 'error');
    assert.equal(new Headers(request.options?.headers).get('Authorization'), `Bearer ${credential}`);
  }
});

test('private repository requests fail closed before HTTP for missing credentials, foreign tasks, users or chats', async t => {
  const f = fixture(t, 'p2p'); let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; throw new Error('must not fetch'); };
  const adapter = new ScopedGitHubAdapter(f.store, config, fetcher);
  for (const context of [undefined, { ...f.context, taskId: 'missing' }, { ...f.context, ownerId: 'bob' }, { ...f.context, chatId: 'other' }])
    await assert.rejects(adapter.observe(target, checks, Date.now() + 5000, context), /github_access_denied/);
  await assert.rejects(new ScopedGitHubAdapter(f.store, { ...config, allowedUserIds: [] }, fetcher)
    .observe(target, checks, Date.now() + 5000, f.context), /github_access_denied/);
  await assert.rejects(new ScopedGitHubAdapter(f.store, { ...config, token: undefined }, fetcher)
    .observe(target, checks, Date.now() + 5000, f.context), /github_access_credential_missing/);
  f.store.db.prepare("UPDATE inbox SET senderId='bob' WHERE key='app:input'").run();
  await assert.rejects(adapter.observe(target, checks, Date.now() + 5000, f.context), /github_access_denied/);
  assert.equal(requests, 0);
});

test('group and unknown chat types cannot use private credentials', async t => {
  for (const chatType of ['group', undefined] as const) {
    const f = fixture(t, chatType); let called = false;
    const adapter = new ScopedGitHubAdapter(f.store, config, async () => { called = true; throw new Error('must not fetch'); });
    await assert.rejects(adapter.observe(target, checks, Date.now() + 5000, f.context), /github_access_denied/);
    assert.equal(called, false);
  }
});

test('unlisted repositories and empty scopes always use anonymous requests, even when a private token exists', async t => {
  const f = fixture(t, 'p2p'), requests: { url: string; options: RequestInit | undefined }[] = [];
  for (const current of [config, { ...config, repositories: [] }, undefined]) {
    const adapter = new ScopedGitHubAdapter(f.store, current, successfulFetch(requests));
    const unlisted = { ...target, repo: 'public-app' };
    assert.equal(adapter.authorize(unlisted, f.context), undefined);
    const result = await adapter.observe(unlisted, checks, Date.now() + 5000, f.context);
    assert.equal(result.authorizationScope, undefined);
  }
  assert.equal(requests.length, 9);
  assert.ok(requests.every(request => !new Headers(request.options?.headers).has('Authorization')));
});

test('credential rotation, revocation and scope changes invalidate fingerprints while caller mutations cannot expand a running adapter', t => {
  const f = fixture(t, 'p2p'), mutable = structuredClone(config), adapter = new ScopedGitHubAdapter(f.store, mutable);
  const initial = adapter.authorize(target, f.context);
  assert.notEqual(initial, new ScopedGitHubAdapter(f.store, { ...config, token: 'replacement-test-token' }).authorize(target, f.context));
  assert.notEqual(initial, new ScopedGitHubAdapter(f.store, { ...config, repositories: [...config.repositories, 'octo-org/another'] }).authorize(target, f.context));
  assert.notEqual(initial, new ScopedGitHubAdapter(f.store, { ...config, allowedUserIds: ['alice', 'bob'] }).authorize(target, f.context));
  assert.equal(new ScopedGitHubAdapter(f.store, { ...config, repositories: [] }).authorize(target, f.context), undefined);
  mutable.repositories.push('octo-org/another'); mutable.token = 'modified';
  assert.equal(adapter.authorize({ ...target, repo: 'another' }, f.context), undefined);
  assert.equal(adapter.authorize(target, f.context), initial);
});

test('redirect and transport failures return stable errors without secret response content', async t => {
  const f = fixture(t, 'p2p'); let calls = 0;
  const adapter = new ScopedGitHubAdapter(f.store, config, async (_url, options) => {
    calls++; assert.equal(options?.redirect, 'error'); throw new TypeError(`redirect failed ${credential}`);
  });
  await assert.rejects(adapter.observe(target, checks, Date.now() + 5000, f.context), error => {
    assert.equal((error as Error).message, 'github_read_unknown'); assert.doesNotMatch(String(error), new RegExp(credential)); return true;
  });
  const rejected = new ScopedGitHubAdapter(f.store, config, async () => new Response(credential, { status: 401 }));
  await assert.rejects(rejected.observe(target, checks, Date.now() + 5000, f.context), /github_read_failed/);
  assert.equal(calls, 1);
});

test('task identity changes during an observation discard the private result', async t => {
  const f = fixture(t, 'p2p'), requests: { url: string; options: RequestInit | undefined }[] = [];
  const base = successfulFetch(requests);
  const adapter = new ScopedGitHubAdapter(f.store, config, async (url, options) => {
    const result = await base(url, options);
    if (requests.length === 3) f.store.db.prepare("UPDATE tasks SET ownerId='bob' WHERE id=?").run(f.task.id);
    return result;
  });
  await assert.rejects(adapter.observe(target, checks, Date.now() + 5000, f.context), /github_access_denied/);
});

test('caller mutations during HTTP cannot move an authenticated observation to an unlisted repository', async t => {
  const f = fixture(t, 'p2p'), selectedTarget = { ...target }, requests: { url: string; options: RequestInit | undefined }[] = [];
  const base = successfulFetch(requests);
  const adapter = new ScopedGitHubAdapter(f.store, config, async (url, options) => {
    const result = await base(url, options);
    selectedTarget.repo = 'unlisted'; f.context.ownerId = 'bob';
    return result;
  });
  const result = await adapter.observe(selectedTarget, checks, Date.now() + 5000, f.context);
  assert.equal(result.target.repo, 'private-app');
  assert.ok(requests.every(request => new URL(request.url).pathname.startsWith('/repos/octo-org/private-app/')));
});

test('local gh allows accessible repositories only for one selected owner in a verified private chat',async t=>{
  for(const invalid of [{...localConfig,allowedUserIds:[]},{...localConfig,allowedUserIds:['alice','bob']},{...localConfig,token:credential},
    {...localConfig,repositories:['octo/app']},{...localConfig,localGh:undefined}])assert.throws(()=>parseGitHubAccessConfig(invalid));
  const view=publicGitHubAccess(localConfig);assert.equal(view.credentialSource,'gh');assert.equal(view.localGh?.login,'owner');
  assert.doesNotMatch(JSON.stringify(view),/executable|configDir/);
  for(const chatType of ['group',undefined,'p2p'] as const){
    const f=fixture(t,chatType);let resolutions=0;const requests:{url:string;options:RequestInit|undefined}[]=[];
    const base=successfulFetch(requests);
    const adapter=new ScopedGitHubAdapter(f.store,localConfig,async(url,init)=>String(url).endsWith('/user')?Response.json({login:'owner',id:42}):base(url,init),
      async()=>{resolutions++;return credential;});
    if(chatType!=='p2p') {await assert.rejects(adapter.observe(target,checks,Date.now()+5000,f.context),/github_access_denied/);assert.equal(resolutions,0);}
    else {const output=await adapter.observe({...target,repo:'another-private-repo'},checks,Date.now()+5000,f.context);
      assert.equal(output.checks[0].result,'passing');assert.equal(resolutions,1);assert.doesNotMatch(JSON.stringify(output),new RegExp(credential));
      await assert.rejects(adapter.observe(target,checks,Date.now()+5000,{...f.context,ownerId:'bob'}),/github_access_denied/);assert.equal(resolutions,1);}
  }
});

test('local gh verifies token identity and rejects stale ready observations after logout, permission or check changes',async t=>{
  const f=fixture(t,'p2p');let loggedIn=true,permitted=true,identity=42,conclusion='success',tokenValue=credential;
  const fetcher:typeof fetch=async(url)=>String(url).endsWith('/user')?Response.json({login:'owner',id:identity}):!permitted?new Response('',{status:404}):
    Response.json(String(url).includes('/check-runs?')?{check_runs:[{name:'build',app:{id:12},status:'completed',conclusion}]}:{head:{sha:target.headSha},state:'open'});
  const adapter=new ScopedGitHubAdapter(f.store,localConfig,fetcher,async()=>{if(!loggedIn)throw Error('private-error');return tokenValue;});
  const initial=await adapter.observe(target,checks,Date.now()+5000,f.context);
  tokenValue='rotated-synthetic-credential';await adapter.validateResume(initial,checks,f.context,Date.now()+5000);
  for(const failure of ['logout','permission','identity','check']){
    loggedIn=failure!=='logout';permitted=failure!=='permission';identity=failure==='identity'?43:42;conclusion=failure==='check'?'failure':'success';
    await assert.rejects(adapter.validateResume(initial,checks,f.context,Date.now()+5000));
  }
});
