import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogCacheScope, createCatalogCacheEntry, CATALOG_CACHE_MAX_AGE_MS } from '../dist/catalog-cache.js';
import { syncCopilotCatalog } from '../dist/discovery.js';
import type { CatalogCache, CatalogCacheEntry, CatalogCacheScope } from '../dist/catalog-types.js';
import { accountItem, catalogFixture, discoveryFixture, discoveryOptions, type DiscoveryResponse } from './catalog-helpers.js';

// Construct intentionally fake credentials; never embed credential-like literals.
const syntheticCredential = (label: string): string => ['synthetic', label].join('-');
const ENDPOINT = 'https://api.enterprise.githubcopilot.com';
const NOW = 1_800_000_000_000;
function fixture() {
  const f = discoveryFixture({ now: () => NOW });
  f.record.payload.expires = NOW + 60 * 60_000;
  const scope = catalogCacheScope(f.options.recordKey, ENDPOINT, { credential: f.record.payload });
  const records = new Map<string, unknown>();
  const reads: CatalogCacheScope[] = [];
  const writes: CatalogCacheEntry[] = [];
  const seen: string[] = [];
  const cache: CatalogCache = {
    async read(scope, signal) { signal.throwIfAborted(); reads.push(scope); return records.get(scope.accountKey); },
    async write(scope, entry, signal) { signal.throwIfAborted(); writes.push(structuredClone(entry)); records.set(scope.accountKey, structuredClone(entry)); },
  };
  f.options.cache = cache;
  f.options.baselineCatalog = catalogFixture();
  f.options.onCatalog = (selection, update) => seen.push(`${update.source}:${Object.keys(selection.models).join(',')}`);
  return { ...f, scope, records, reads, writes, seen, cache,
    seed: (id = 'synthetic-cached-model') => records.set(scope.accountKey, createCatalogCacheEntry(scope, { data: [accountItem(id)] }, NOW)),
    sync: () => syncCopilotCatalog(f.credentials, discoveryOptions(f.options)),
  };
}

function nextTurn() { return new Promise<void>((resolve) => setImmediate(resolve)); }

test('startup selects cached raw metadata before refresh, then live data replaces and persists it', async () => {
  const f = fixture();
  f.seed();
  f.record.payload.expires = 0;
  f.options.oauth.refresh = async (grant, signal) => {
    assert.deepEqual(f.seen, ['cache:synthetic-cached-model']);
    assert.equal(signal?.aborted, false);
    return { ...grant, access: syntheticCredential('rotated-access') };
  };
  f.options.fetcher = async () => ({ ok: true, json: async () => ({ data: [accountItem('synthetic-live-model', {
    headers: { Authorization: syntheticCredential('sensitive-auth') }, token: syntheticCredential('sensitive-token'),
  })] }) });
  assert.deepEqual(await f.sync(), { status: 'synced', count: 1, unsupported: [] });
  assert.deepEqual(f.seen, ['cache:synthetic-cached-model', 'live:synthetic-live-model']);
  assert.equal(f.reads.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.accountKey, f.scope.accountKey);
  assert.equal(JSON.stringify(f.writes).includes(syntheticCredential('sensitive')), false);
  assert.deepEqual(Object.keys(f.catalog), ['synthetic-live-model']);
});

test('cache selection is detached, uses bundled metadata and rebinds known descriptors to validated live route', async () => {
  const f = fixture();
  f.seed('gpt-6-sol');
  const baseline = f.options.baselineCatalog!;
  const baselineBefore = structuredClone(baseline);
  f.catalog['gpt-6-sol'].contextWindow = 12;
  f.catalog['gpt-6-sol'].baseUrl = 'https://api.business.githubcopilot.com';
  f.options.fetcher = async () => { throw new Error('synthetic offline failure with secret text'); };
  assert.deepEqual(await f.sync(), { status: 'cached', count: 1, unsupported: [], reason: 'FETCH_FAILED' });
  assert.equal(f.catalog['gpt-6-sol'].contextWindow, baseline['gpt-6-sol']!.contextWindow);
  assert.equal(f.catalog['gpt-6-sol'].baseUrl, ENDPOINT);
  assert.equal(f.catalog['gpt-6-sol'].headers.Authorization, undefined);
  f.catalog['gpt-6-sol'].cost.input = 99;
  assert.deepEqual(baseline, baselineBefore);
});

test('offline fallback retains controlled reason diagnostics for refresh, HTTP, JSON and invalid catalog failures', async () => {
  for (const stage of ['refresh', 'http', 'json', 'empty']) {
    const f = fixture(); f.seed();
    const diagnostic: string[] = [];
    f.options.onDiagnostic = (code) => diagnostic.push(code);
    if (stage === 'refresh') {
      f.record.payload.expires = 0;
      f.options.oauth.refresh = async () => { throw new Error('synthetic-sensitive-refresh-failure'); };
    }
    if (stage === 'http') f.options.fetcher = async () => ({ ok: false, status: 503 });
    if (stage === 'json') f.options.fetcher = async () => ({ ok: true, json: async () => { throw new Error('synthetic-sensitive-json'); } });
    if (stage === 'empty') f.options.fetcher = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const reason = stage === 'http' ? 'HTTP_ERROR' : stage === 'empty' ? 'INVALID_CATALOG'
      : stage === 'refresh' ? 'OAUTH_REFRESH_FAILED' : 'INVALID_JSON';
    assert.deepEqual(await f.sync(), { status: 'cached', count: 1, unsupported: [], reason });
    assert.deepEqual(diagnostic, [reason]);
    assert.equal(f.writes.length, 0);
  }
});

test('foreign, stale and corrupt cache entries cannot become account fallback', async () => {
  for (const kind of ['account', 'endpoint', 'stale', 'future', 'version', 'raw']) {
    const f = fixture(); f.seed();
    const entry = f.records.get(f.scope.accountKey) as CatalogCacheEntry;
    if (kind === 'account') entry.accountKey = 'b'.repeat(64);
    if (kind === 'endpoint') entry.endpoint = 'https://api.business.githubcopilot.com';
    if (kind === 'stale') entry.savedAt = NOW - CATALOG_CACHE_MAX_AGE_MS - 1;
    if (kind === 'future') entry.savedAt = NOW + 1;
    if (kind === 'version') Object.assign(entry, { version: 42 });
    if (kind === 'raw') entry.raw.data[0]!.authorization = syntheticCredential('sensitive');
    f.options.fetcher = async () => { throw new Error('synthetic-offline'); };
    const before = structuredClone(f.catalog);
    await assert.rejects(f.sync(), /synthetic-offline/);
    assert.deepEqual(f.catalog, before);
    assert.deepEqual(f.seen, []);
  }
});

test('two explicit API keys sharing record and endpoint never reuse each other cache', async () => {
  const f = fixture();
  f.options.resolveApiKey = async () => syntheticCredential('api-key-a');
  f.options.baseUrl = ENDPOINT;
  const a = catalogCacheScope(f.options.recordKey, ENDPOINT, { apiKey: syntheticCredential('api-key-a') });
  f.records.set(a.accountKey, createCatalogCacheEntry(a, { data: [accountItem('account-a-model')] }, NOW));
  f.options.fetcher = async () => { throw new Error('synthetic offline'); };
  assert.equal((await f.sync()).status, 'cached');
  f.options.resolveApiKey = async () => syntheticCredential('api-key-b');
  f.options.catalog = catalogFixture();
  f.seen.length = 0;
  await assert.rejects(f.sync(), /synthetic offline/);
  assert.deepEqual(f.seen, []);
  assert.notEqual(f.reads[0]!.accountKey, f.reads[1]!.accountKey);
});

test('a changed OAuth endpoint invalidates startup cache fallback and reads the new endpoint scope', async () => {
  const f = fixture(); f.seed(); f.record.payload.expires = 0;
  f.options.oauth.toAuth = async (grant) => ({ apiKey: grant.access,
    baseUrl: grant.access === syntheticCredential('refreshed') ? 'https://copilot-api.synthetic.ghe.com' : ENDPOINT });
  f.options.oauth.refresh = async (grant) => ({ ...grant, access: syntheticCredential('refreshed') });
  f.options.fetcher = async () => { throw new Error('synthetic offline'); };
  const accounts: CatalogCacheScope[] = [];
  f.options.onAccount = (scope) => accounts.push(scope);
  await assert.rejects(f.sync(), /synthetic offline/);
  assert.equal(f.reads.length, 2);
  assert.notEqual(f.reads[0]!.accountKey, f.reads[1]!.accountKey);
  assert.equal(accounts[1]!.endpoint, 'https://copilot-api.synthetic.ghe.com');
  assert.deepEqual(Object.keys(f.catalog), Object.keys(f.options.baselineCatalog!));
});

test('timeout can return already published cache, but late response cannot write or notify registry', async () => {
  const f = fixture(); f.seed(); f.options.timeoutMs = 10;
  let release!: (response: DiscoveryResponse) => void;
  f.options.fetcher = async () => new Promise((resolve) => { release = resolve; });
  assert.deepEqual(await f.sync(), { status: 'cached', count: 1, unsupported: [], reason: 'TIMEOUT' });
  release({ ok: true, json: async () => ({ data: [accountItem('late-live-model')] }) });
  await nextTurn();
  assert.deepEqual(f.seen, ['cache:synthetic-cached-model']);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(Object.keys(f.catalog), ['synthetic-cached-model']);
});

test('a monotonic deadline crossed during synchronous metadata work blocks writes and registry publication before timers fire', async t => {
  const f = fixture(); f.seed(); f.options.timeoutMs = 10;
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  f.options.fetcher = async () => ({ ok: true, json: async () => {
    clock = 25;
    return { data: [accountItem('synchronously-late-model')] };
  } });
  assert.deepEqual(await f.sync(), { status: 'cached', count: 1, unsupported: [], reason: 'TIMEOUT' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.seen, ['cache:synthetic-cached-model']);
  assert.deepEqual(Object.keys(f.catalog), ['synthetic-cached-model']);
});

test('external cancellation rejects even with cache and blocks callbacks or writes from noncooperative work', async () => {
  for (const stage of ['read', 'fetch', 'write']) {
    const f = fixture(); f.seed();
    const controller = new AbortController(); f.options.signal = controller.signal;
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (stage === 'read') f.cache.read = async () => { entered(); await gate; return f.records.get(f.scope.accountKey); };
    if (stage === 'fetch') f.options.fetcher = async () => { entered(); await gate; return { ok: true, json: async () => ({ data: [accountItem('late-model')] }) }; };
    if (stage === 'write') f.cache.write = async (_scope, _entry, signal) => { entered(); await gate; signal.throwIfAborted(); f.writes.push(_entry); };
    const operation = f.sync(); await entry;
    controller.abort(new Error('synthetic-sensitive-abort-reason'));
    await assert.rejects(operation, { code: 'CANCELLED' });
    const notifications = [...f.seen];
    release(); await nextTurn();
    assert.deepEqual(f.seen, notifications);
    assert.equal(f.writes.length, 0);
  }
});

test('pre-cancelled discovery performs no credential reads, cache reads or registry notifications', async () => {
  const f = fixture(); f.seed();
  const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal;
  await assert.rejects(f.sync(), { code: 'CANCELLED' });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.seen, []);
});

test('throwing live registry callback is not mislabeled as a successful cached fallback', async () => {
  const f = fixture(); f.seed();
  f.options.onCatalog = (_selection, update) => {
    if (update.source === 'live') throw new Error('synthetic-sensitive-callback-error');
  };
  await assert.rejects(f.sync(), { code: 'CATALOG_CALLBACK_FAILED' });
});

test('current credentials echoed in provider model names are stripped before persistence', async () => {
  const f = fixture();
  f.options.fetcher = async () => ({ ok: true, json: async () => ({ data: [accountItem('synthetic-live', {
    name: `Provider echoes ${f.record.payload.access} and ${f.record.payload.refresh}`,
  })] }) });
  assert.equal((await f.sync()).status, 'synced');
  assert.equal(f.writes[0]!.raw.data[0]!.name, undefined);
  assert.equal(JSON.stringify(f.writes).includes(f.record.payload.access), false);
  assert.equal(JSON.stringify(f.writes).includes(f.record.payload.refresh), false);
});

test('cache read/write failures are contained while live discovery succeeds', async () => {
  const f = fixture();
  const diagnostics: string[] = [];
  f.options.onDiagnostic = (code) => diagnostics.push(code);
  f.cache.read = async () => { throw new Error('synthetic-sensitive-read-error'); };
  f.cache.write = async () => { throw new Error('synthetic-sensitive-write-error'); };
  assert.equal((await f.sync()).status, 'synced');
  assert.deepEqual(diagnostics, ['CACHE_READ_FAILED', 'CACHE_WRITE_FAILED']);
  assert.deepEqual(f.seen, ['live:gpt-6-sol']);
});

test('a late cache read after deadline cannot adopt models or update account registry', async () => {
  const f = fixture(); f.seed(); f.options.timeoutMs = 10;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  f.cache.read = async () => { await gate; return f.records.get(f.scope.accountKey); };
  await assert.rejects(f.sync(), { code: 'TIMEOUT' });
  release(); await nextTurn();
  assert.deepEqual(f.seen, []);
  assert.deepEqual(f.writes, []);
});
