import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, type CatalogModel } from '../src/model-catalog.js';

const models = (id: string): CatalogModel[] => [{ id, name: id, isDefault: true }];

test('catalog coalesces discovery and refreshes only after its five-minute TTL', async () => {
  let now = 0, calls = 0;
  let finish!: (value: CatalogModel[]) => void;
  const catalog = new ModelCatalog(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => 'one', () => now);
  const first = catalog.refresh();
  assert.equal(catalog.refresh(), first);
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(catalog.models.length, 0);
  finish(models('old')); await first;
  now = 299_999; await catalog.refresh(); assert.equal(calls, 1);
  now = 300_000; const second = catalog.refresh(); await Promise.resolve(); assert.equal(calls, 2);
  assert.equal(catalog.models[0].id, 'old');
  finish(models('new')); await second; assert.equal(catalog.models[0].id, 'new');
  await catalog.stop();
});

test('catalog retains the last successful entries and retries failures after thirty seconds', async () => {
  let now = 0, calls = 0;
  const catalog = new ModelCatalog(async () => { calls++; if (calls === 2) throw Error('private runtime failure'); return models(`v${calls}`); }, () => 'one', () => now);
  await catalog.refresh(); now = 300_000;
  await catalog.refresh(); assert.equal(catalog.models[0].id, 'v1');
  now += 29_999; await catalog.refresh(); assert.equal(calls, 2);
  now++; await catalog.refresh(); assert.equal(calls, 3); assert.equal(catalog.models[0].id, 'v3');
  await catalog.stop();
});

test('a CLI switch invalidates the cache immediately and discards obsolete in-flight results', async () => {
  let signature = 'one', calls = 0;
  let finish!: (value: CatalogModel[]) => void;
  const catalog = new ModelCatalog(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => signature, () => 0);
  const first = catalog.refresh(); await Promise.resolve(); finish(models('one')); await first;
  signature = 'two'; const second = catalog.refresh(); await Promise.resolve(); assert.equal(calls, 2);
  signature = 'three'; finish(models('two')); await second;
  assert.equal(catalog.models[0].id, 'one');
  const third = catalog.refresh(); await Promise.resolve(); assert.equal(calls, 3);
  finish(models('three')); await third; assert.equal(catalog.models[0].id, 'three');
  await catalog.stop();
});

test('stopping catalog polling prevents new loads and ignores an outstanding discovery', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let finish!: (value: CatalogModel[]) => void;
  const catalog = new ModelCatalog(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => 'one');
  catalog.start(); await Promise.resolve(); assert.equal(calls, 1);
  const stopped = catalog.stop(); finish(models('ignored')); await stopped;
  t.mock.timers.tick(600_000); await catalog.refresh(); await Promise.resolve();
  assert.equal(calls, 1); assert.deepEqual(catalog.models, []);
});

test('background polling retries an initial outage and notices a changed CLI without a command', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0, calls = 0, signature = 'one';
  const catalog = new ModelCatalog(async () => {
    calls++;
    if (calls === 1) throw Error('initial outage');
    return models(signature);
  }, () => signature, () => now);
  catalog.start(); catalog.start(); await catalog.refresh();
  assert.equal(calls, 1); assert.equal(catalog.models.length, 0);
  now = 30_000; t.mock.timers.tick(30_000); await catalog.refresh();
  assert.equal(calls, 2); assert.equal(catalog.models[0].id, 'one');
  signature = 'two'; now += 30_000; t.mock.timers.tick(30_000); await catalog.refresh();
  assert.equal(calls, 3); assert.equal(catalog.models[0].id, 'two');
  await catalog.stop();
});
