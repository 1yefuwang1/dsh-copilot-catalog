import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogController, MISSING_MODEL_REFRESH_COOLDOWN_MS } from '../dist/catalog-controller.js';
import { createPlugin, providersFacade } from '../dist/plugin.js';
import { Config, minimalDependencies } from './merged-fixtures.js';
import { accountItem, catalogFixture, grantFixture } from './catalog-helpers.js';
import type { CredentialKey, ModelCatalog } from '../dist/catalog-types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function fixture() {
  let time = Date.now();
  let record: unknown = grantFixture();
  let requests = 0;
  let response: () => Promise<Response> = async () => Response.json({ data: [accountItem('gpt-6-sol')] });
  const catalog: ModelCatalog = catalogFixture();
  let revision = 0;
  let endpoint: string | undefined;
  const diagnostics: string[] = [];
  const controller = createCatalogController({
    catalog, baseline: structuredClone(catalog), recordKey: 'synthetic' as CredentialKey,
    credentials: { readRecord: async () => record },
    oauth: { refresh: async value => value, toAuth: async value => ({ apiKey: value.access, baseUrl: 'https://api.individual.githubcopilot.com' }) },
    authOptions: () => ({}), cache: () => undefined, refreshIntervalMs: () => 900_000,
    now: () => time, fetcher: async () => { requests++; return response(); }, timeoutMs: 100,
    changed(value) { revision++; endpoint = value; }, diagnostic(code) { diagnostics.push(code); },
  });
  return { controller, catalog, diagnostics, get requests() { return requests; }, get revision() { return revision; }, get endpoint() { return endpoint; },
    advance(value: number) { time += value; }, setRecord(value: unknown) { record = value; },
    setResponse(value: () => Promise<Response>) { response = value; } };
}

test('startup and demand TTL refresh update the live catalog without requests on every call', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  await f.controller.refresh();
  assert.deepEqual(Object.keys(f.catalog), ['gpt-6-sol']);
  await f.controller.ensure('gpt-6-sol'); await f.controller.ensure(undefined);
  assert.equal(f.requests, 1);
  f.advance(900_000);
  f.setResponse(async () => Response.json({ data: [accountItem('next-catalog-model')] }));
  await f.controller.ensure(undefined);
  assert.deepEqual(Object.keys(f.catalog), ['next-catalog-model']); assert.equal(f.requests, 2);
});

test('one missing-model refresh introduces newly advertised models without a restart', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  await f.controller.refresh();
  f.setResponse(async () => Response.json({ data: [accountItem('gpt-6-sol'), accountItem('new-review-model')] }));
  await f.controller.ensure('new-review-model');
  assert.ok(f.catalog['new-review-model']); assert.equal(f.requests, 2);
  await f.controller.ensure('new-review-model'); assert.equal(f.requests, 2);
});

test('negative model misses share a cooldown rather than causing refresh storms', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  await f.controller.refresh();
  await f.controller.ensure('missing-one'); await f.controller.ensure('missing-two');
  assert.equal(f.requests, 2);
  f.advance(MISSING_MODEL_REFRESH_COOLDOWN_MS); await f.controller.ensure('missing-two');
  assert.equal(f.requests, 3);
});

test('failed same-account refresh retains last good live metadata; a foreign account does not', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  await f.controller.refresh(); const previous = structuredClone(f.catalog);
  f.setResponse(async () => { throw new Error('private-token-must-not-be-logged'); });
  await f.controller.refresh(); assert.deepEqual(f.catalog, previous);
  f.setRecord(grantFixture({ refresh: ['different', 'synthetic', 'account'].join('-') }));
  await f.controller.refresh(); assert.deepEqual(f.catalog, catalogFixture());
  assert.ok(!JSON.stringify(f.diagnostics).includes('private-token'));
});

test('logout and credential invalidation remove account-specific catalog immediately', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  await f.controller.refresh();
  f.controller.invalidate(); assert.deepEqual(f.catalog, catalogFixture()); assert.equal(f.endpoint, undefined);
  f.setRecord(undefined); await f.controller.ensure(undefined);
  assert.deepEqual(f.catalog, catalogFixture()); assert.equal(f.endpoint, undefined);
});

test('provider facade invalidates real adapter input identity while keeping settings immutable', () => {
  let revision = 0;
  let endpoint = 'https://api.individual.githubcopilot.com';
  const raw = { 'github-copilot': {} };
  const facade = providersFacade({ get: () => raw }, () => endpoint, () => revision);
  const first = facade.get(); assert.equal(facade.get(), first);
  revision++; const second = facade.get(); assert.notEqual(second, first);
  assert.deepEqual(second, first); assert.deepEqual(raw, { 'github-copilot': {} });
  endpoint = 'https://api.business.githubcopilot.com'; assert.notEqual(facade.get(), second);
  assert.equal(facade.get()['github-copilot']?.baseURL, endpoint);
});

test('canceling the first waiter does not cancel a shared refresh requested by another caller', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  const started = deferred<void>(); const response = deferred<Response>();
  f.setResponse(() => { started.resolve(); return response.promise; });
  const owner = new AbortController(); const joining = new AbortController();
  const first = f.controller.ensure('gpt-6-sol', owner.signal); await started.promise;
  const second = f.controller.ensure('gpt-6-sol', joining.signal);
  owner.abort(new Error('only owner canceled'));
  await assert.rejects(first, /only owner canceled/);
  response.resolve(Response.json({ data: [accountItem('shared-new-model')] }));
  await second; assert.equal(f.requests, 1); assert.ok(f.catalog['shared-new-model']);
});

test('all canceled waiters block late publication and allow an immediate fresh attempt', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  const started = deferred<void>(); const response = deferred<Response>();
  f.setResponse(() => { started.resolve(); return response.promise; });
  const abort = new AbortController(); const first = f.controller.ensure('gpt-6-sol', abort.signal); await started.promise;
  abort.abort(new Error('cancel sole owner')); await assert.rejects(first, /cancel sole owner/);
  f.setResponse(async () => Response.json({ data: [accountItem('fresh-attempt')] }));
  await f.controller.ensure('gpt-6-sol'); assert.equal(f.requests, 2); assert.ok(f.catalog['fresh-attempt']);
  const revision = f.revision;
  response.resolve(Response.json({ data: [accountItem('late-stale-result')] }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.revision, revision); assert.deepEqual(Object.keys(f.catalog), ['fresh-attempt']);
});

test('invalidated account generation cannot publish an old response over a newer account', async t => {
  const f = fixture(); t.after(f.controller.dispose);
  const started = deferred<void>(); const response = deferred<Response>();
  f.setResponse(() => { started.resolve(); return response.promise; });
  const old = f.controller.refresh(); await started.promise;
  f.controller.invalidate(); f.setRecord(grantFixture({ refresh: ['new', 'account'].join('-') }));
  f.setResponse(async () => Response.json({ data: [accountItem('new-account-model')] }));
  await f.controller.refresh();
  response.resolve(Response.json({ data: [accountItem('old-account-model')] }));
  await assert.rejects(old);
  assert.deepEqual(Object.keys(f.catalog), ['new-account-model']);
});

test('unload cancels owned discovery, restores bundled models and prevents subsequent work', async () => {
  const f = fixture(); const started = deferred<void>(); const response = deferred<Response>();
  f.setResponse(() => { started.resolve(); return response.promise; });
  const pending = f.controller.refresh(); await started.promise;
  f.controller.dispose(); response.resolve(Response.json({ data: [accountItem('late-model')] }));
  await assert.rejects(pending); assert.deepEqual(f.catalog, catalogFixture());
  await assert.rejects(f.controller.ensure('gpt-6-sol'));
});

test('storage open failure remains optional and does not block mounting the adapter', async () => {
  let mounted = false; const effects: (() => unknown)[] = [];
  const ctx = {
    get(name: string) { return name === 'storageDomain' ? { open: async () => { throw new Error('private storage details'); } } : undefined; },
    effect(execute: () => () => unknown) { effects.push(execute()); },
    inject() {}, on() {}, emit() {},
  };
  const dependency = minimalDependencies(); dependency.original.apply = (() => { mounted = true; }) as never;
  const config = Config(); await createPlugin(dependency).apply(ctx as never, config);
  assert.equal(mounted, true);
  for (const dispose of effects.reverse()) await dispose();
});
