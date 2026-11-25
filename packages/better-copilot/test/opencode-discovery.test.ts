import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogCacheEntry, opencodeCacheScope } from '../dist/catalog-cache.js';
import { DiscoveryError } from '../dist/discovery.js';
import { normalizeOpencodeCatalog, OPENCODE_GO_MAX_RESPONSE_BYTES } from '../dist/opencode.js';
import { syncOpencodeCatalog, type OpencodeDiscoveryOptions } from '../dist/opencode-discovery.js';
import type { CatalogCache, CatalogCacheEntry, CatalogCacheScope } from '../dist/catalog-types.js';
import { opencodeCatalogFixture, opencodeDocument, opencodeItem, opencodeResponse } from './opencode-helpers.js';

const NOW = 1_800_000_000_000;
const LISTING = 'https://opencode.ai/inference/go/v1/models';

function normalizedDocument(...items: Record<string, unknown>[]): { data: Record<string, unknown>[] } {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(...items));
  if (!normalized) throw new Error('synthetic fixture did not normalize');
  return { data: normalized.data as unknown as Record<string, unknown>[] };
}

function fixture(overrides: Partial<OpencodeDiscoveryOptions> = {}) {
  const baseline = opencodeCatalogFixture();
  const catalog = structuredClone(baseline);
  const records = new Map<string, unknown>();
  const writes: CatalogCacheEntry[] = [];
  const reads: CatalogCacheScope[] = [];
  const seen: string[] = [];
  const diagnostics: string[] = [];
  const requests: { url: URL; init: RequestInit }[] = [];
  const cache: CatalogCache = {
    async read(scope, signal) { signal.throwIfAborted(); reads.push(scope); return records.get(scope.accountKey); },
    async write(scope, entry, signal) {
      signal.throwIfAborted();
      writes.push(structuredClone(entry));
      records.set(scope.accountKey, structuredClone(entry));
    },
  };
  const seed = (...items: Record<string, unknown>[]) => {
    const scope = opencodeCacheScope(LISTING);
    records.set(scope.accountKey, createCatalogCacheEntry(scope, normalizedDocument(...items), NOW, [], 'opencode-go'));
  };
  const options: OpencodeDiscoveryOptions = {
    catalog,
    baselineCatalog: baseline,
    cache,
    now: () => NOW,
    timeoutMs: 1_000,
    fetcher: async (input, init) => {
      requests.push({ url: input as URL, init: init ?? {} });
      return opencodeResponse(opencodeDocument(opencodeItem('glm-5.3'), opencodeItem('kimi-k3.1-pro')));
    },
    onCatalog(selection, update) { seen.push(`${update.source}:${Object.keys(selection.models).join(',')}`); },
    onDiagnostic(code) { diagnostics.push(code); },
    ...overrides,
  };
  return { baseline, catalog, records, writes, reads, seen, diagnostics, requests, cache, seed, options,
    sync: () => syncOpencodeCatalog(options) };
}

test('a cached selection publishes before the live listing and is replaced and persisted after it', async () => {
  const f = fixture();
  f.seed(opencodeItem('synthetic-cached-model'));
  assert.deepEqual(await f.sync(), { status: 'synced', count: 2, unsupported: [] });
  assert.deepEqual(f.seen, ['cache:synthetic-cached-model', 'live:glm-5.3,kimi-k3.1-pro']);
  assert.deepEqual(Object.keys(f.catalog), ['glm-5.3', 'kimi-k3.1-pro']);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.kind, 'opencode-go');
  assert.equal(f.writes[0]!.endpoint, 'https://opencode.ai');
  assert.deepEqual(f.writes[0]!.raw.data.map((item) => item.id), ['glm-5.3', 'kimi-k3.1-pro']);
  assert.equal(f.requests[0]!.url.href, LISTING);
  const headers = f.requests[0]!.init.headers as Headers;
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('authorization'), null, 'the public catalog is never fetched with a credential');
  assert.equal(f.requests[0]!.init.redirect, 'error');
});

test('an offline refresh keeps the cached selection and reports the controlled reason', async () => {
  const f = fixture({ fetcher: async () => { throw new Error('synthetic offline failure with secret text'); } });
  f.seed(opencodeItem('synthetic-cached-model'));
  assert.deepEqual(await f.sync(), {
    status: 'cached', count: 1, unsupported: [], reason: 'FETCH_FAILED',
  });
  assert.deepEqual(Object.keys(f.catalog), ['synthetic-cached-model']);
  assert.deepEqual(f.diagnostics, ['FETCH_FAILED']);
  assert.equal(f.writes.length, 0);
});

test('without a cached selection a failure propagates and never publishes a partial catalog', async () => {
  const offline = fixture({ fetcher: async () => { throw new Error('synthetic offline'); } });
  await assert.rejects(offline.sync(), /synthetic offline/u);
  assert.deepEqual(offline.seen, []);
  assert.deepEqual(offline.catalog, offline.baseline);

  const http = fixture({ fetcher: async () => opencodeResponse({ data: [] }, 503) });
  await assert.rejects(http.sync(), (error) => error instanceof DiscoveryError && error.code === 'HTTP_ERROR');

  const html = fixture({ fetcher: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.sync(), (error) => error instanceof DiscoveryError && error.code === 'INVALID_JSON');

  const malformed = fixture({ fetcher: async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(malformed.sync(), (error) => error instanceof DiscoveryError && error.code === 'INVALID_JSON');

  const empty = fixture({ fetcher: async () => opencodeResponse(opencodeDocument(opencodeItem('synthetic-embedding', { type: 'embedding' }))) });
  await assert.rejects(empty.sync(), (error) => error instanceof DiscoveryError && error.code === 'INVALID_CATALOG');
});

test('a declared oversized listing is refused before JSON is parsed', async () => {
  const f = fixture({ fetcher: async () => new Response('{}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(OPENCODE_GO_MAX_RESPONSE_BYTES + 1) },
  }) });
  await assert.rejects(f.sync(), (error) => error instanceof DiscoveryError && error.code === 'RESPONSE_TOO_LARGE');
});

test('a custom endpoint redirects only the listing URL and scopes its own cache digest', async () => {
  const f = fixture({ baseUrl: 'https://gateway.example.com/v1' });
  f.seed(opencodeItem('synthetic-public-model'));
  assert.deepEqual(await f.sync(), { status: 'synced', count: 2, unsupported: [] });
  assert.equal(f.requests[0]!.url.href, 'https://gateway.example.com/v1/models');
  // The seed used the public listing scope, so the custom route must not read it.
  assert.deepEqual(f.seen, ['live:glm-5.3,kimi-k3.1-pro']);
  assert.equal(f.writes[0]!.endpoint, 'https://gateway.example.com');
});

test('an invalid endpoint is refused before any cache or network access', async () => {
  const f = fixture({ baseUrl: 'http://opencode.ai/inference/go' });
  await assert.rejects(f.sync(), (error) => error instanceof DiscoveryError && error.code === 'UNTRUSTED_ENDPOINT');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.reads, []);
});

test('timeout and caller cancellation are controlled and never publish late data', async () => {
  const stalling = fixture({
    timeoutMs: 10,
    fetcher: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
    }),
  });
  await assert.rejects(stalling.sync(), (error) => error instanceof DiscoveryError && error.code === 'TIMEOUT');
  assert.deepEqual(stalling.seen, []);

  const aborted = new AbortController();
  aborted.abort(new Error('synthetic caller abort'));
  const cancelled = fixture({ signal: aborted.signal });
  await assert.rejects(cancelled.sync(), (error) => error instanceof DiscoveryError && error.code === 'CANCELLED');
  assert.deepEqual(cancelled.requests, []);
});

test('a cache write failure degrades to live publication with a controlled diagnostic', async () => {
  const failing: CatalogCache = {
    async read() { return undefined; },
    async write() { throw new Error('synthetic storage failure'); },
  };
  const f = fixture({ cache: failing });
  assert.deepEqual(await f.sync(), { status: 'synced', count: 2, unsupported: [] });
  assert.deepEqual(f.diagnostics, ['CACHE_WRITE_FAILED']);
  assert.deepEqual(Object.keys(f.catalog), ['glm-5.3', 'kimi-k3.1-pro']);
  assert.deepEqual(f.seen, ['live:glm-5.3,kimi-k3.1-pro']);
});

test('rejected and unselectable cache records fall through to the live listing', async () => {
  for (const [kind, diagnostic] of [
    ['foreign', 'CACHE_REJECTED'],
    ['unsanitized', 'CACHE_REJECTED'],
    ['unselectable', 'CACHE_INVALID_CATALOG'],
  ] as const) {
    const f = fixture();
    const scope = opencodeCacheScope(LISTING);
    const valid = createCatalogCacheEntry(scope, normalizedDocument(opencodeItem('synthetic-cached-model')), NOW, [], 'opencode-go')!;
    if (kind === 'foreign') f.records.set(scope.accountKey, { ...valid, endpoint: 'https://elsewhere.example' });
    if (kind === 'unsanitized') f.records.set(scope.accountKey, { ...valid, raw: { data: [{ id: 'synthetic-cached-model' }] } });
    if (kind === 'unselectable') {
      const unusable = normalizeOpencodeCatalog(opencodeDocument(opencodeItem('no-protocol', {
        api: { 'some-future-api': {} }, recommended_api: 'some-future-api',
      })))!;
      f.records.set(scope.accountKey, createCatalogCacheEntry(scope,
        { data: unusable.data as unknown as Record<string, unknown>[] }, NOW, [], 'opencode-go'));
    }
    assert.deepEqual(await f.sync(), { status: 'synced', count: 2, unsupported: [] });
    assert.deepEqual(f.diagnostics, [diagnostic]);
    assert.deepEqual(f.seen, ['live:glm-5.3,kimi-k3.1-pro']);
  }
});

test('an immutable destination fails closed instead of publishing into a shared catalog', async () => {
  const f = fixture();
  f.options.catalog = Object.freeze(structuredClone(f.baseline));
  await assert.rejects(f.sync(), (error) => error instanceof DiscoveryError && error.code === 'IMMUTABLE_CATALOG');
  assert.deepEqual(f.seen, []);
});
