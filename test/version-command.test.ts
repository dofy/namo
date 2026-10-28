import { NAMO_VERSION } from '../src/version.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';
import { storeFixture } from './helpers.js';
import type { Incoming } from '../src/store.js';
import { RuntimeVersions } from '../src/runtime-version.js';

function incoming(key:string,text:string):Incoming {
  return {key,messageId:key,chatKey:'chat',chatId:'chat',senderId:'owner',text,
    envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'chat',materials:[],limitations:[]}};
}

test('/version and /status report actual CLI and do not create model tasks',async t=>{
  const {dir,store}=storeFixture(t,'namo-version-command-'),bin=join(dir,'codex');
  writeFileSync(bin,"#!/bin/sh\nprintf 'codex-cli 0.165.0\\n'\n",{mode:0o700});
  const codex={bin,home:join(dir,'home'),timeoutMs:600000,sandbox:'read-only' as const};let runs=0;
  const e=new Engine(store,{async run(){runs++;throw Error('unexpected model');}},{async send(_chat,_text,id){return id;}},{dataDir:dir,concurrency:1,codex});
  e.start();
  try {
    await (e as any).versions.settle();
    e.accept(incoming('version','/version'));e.accept(incoming('status','/status'));
    for(const key of ['version','status']) {
      const out=store.db.prepare("SELECT content FROM outbox WHERE inboxKey=? AND kind='result'").get(key);
      assert.ok(String(out?.content).includes('Namo：`' + NAMO_VERSION + '`'));
      assert.match(String(out?.content),/Codex CLI：`0\.165\.0`/);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM tasks').get()?.n,0);assert.equal(runs,0);
  } finally {await e.stop();}
});

test('runtime version cache detects a binary replacement and fails closed when unavailable',async t=>{
  const {dir}=storeFixture(t,'namo-version-cache-'),bin=join(dir,'codex');
  writeFileSync(bin,"#!/bin/sh\nprintf 'codex-cli 0.165.0\\n'\n",{mode:0o700});
  const c={bin,home:dir,timeoutMs:1000,sandbox:'read-only' as const};const cache=new RuntimeVersions();
  assert.equal(cache.get(c),null);await cache.settle();assert.equal(cache.get(c),'0.165.0');
  writeFileSync(bin,"#!/bin/sh\nprintf 'codex-cli 0.166.123\\n'\n",{mode:0o700});
  assert.equal(cache.get(c),null);await cache.settle();assert.equal(cache.get(c),'0.166.123');
  assert.equal(cache.get({...c,bin:join(dir,'missing')}),null);
});
