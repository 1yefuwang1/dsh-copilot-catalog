import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogCacheEntry, opencodeCacheScope } from '../dist/catalog-cache.js';
import { normalizeOpencodeCatalog } from '../dist/opencode.js';
import { createOpencodeCatalogController, type OpencodeCatalogControllerOptions } from '../dist/opencode-controller.js';
import type { CatalogCache, CatalogCacheEntry } from '../dist/catalog-types.js';
import { opencodeCatalogFixture, opencodeDocument, opencodeItem, opencodeResponse } from './opencode-helpers.js';

const NOW = 1_800_000_000_000;
const INTERVAL = 900_000;
const LIVE = () => opencodeResponse(opencodeDocument(opencodeItem('glm-5.3'), opencodeItem('synthetic-live-model')));

function fixture(overrides: Partial<OpencodeCatalogControllerOptions> = {}) {
  const baseline = opencodeCatalogFixture();
  const catalog = structuredClone(baseline);
  const fetches: string[] = [];
  const diagnostics: string[] = [];
  let changed = 0;
  let clock = NOW;
  const options: OpencodeCatalogControllerOptions = {
    catalog,
    baseline,
    cache: () => undefined,
    refreshIntervalMs: () => INTERVAL,
    active: () => true,
    baseUrl: () => undefined,
    now: () => clock,
    fetcher: async (input) => { fetches.push(String(input)); return LIVE(); },
    changed() { changed++; },
    diagnostic(code) { diagnostics.push(code); },
    ...overrides,
  };
  const controller = createOpencodeCatalogController(options);
  return {
    controller, baseline, catalog, fetches, diagnostics, options,
    changed: () => changed,
    advance(ms: number) { clock += ms; },
  };
}

test('the first ensure refreshes, then the interval and a missing model bound later fetches', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.catalog), Object.keys(f.baseline));
  await f.controller.ensure();
  assert.equal(f.fetches.length, 1);
  assert.deepEqual(Object.keys(f.catalog), ['glm-5.3', 'synthetic-live-model']);
  assert.equal(f.changed(), 1);

  await f.controller.ensure();
  assert.equal(f.fetches.length, 1, 'inside the refresh interval the last selection is reused');
  await f.controller.ensure('synthetic-live-model');
  assert.equal(f.fetches.length, 1);

  f.advance(INTERVAL);
  await f.controller.ensure();
  assert.equal(f.fetches.length, 2);

  await f.controller.ensure('unknown-model');
  assert.equal(f.fetches.length, 3, 'a missing model triggers one bounded refresh');
  await f.controller.ensure('another-unknown-model');
  assert.equal(f.fetches.length, 3, 'the miss cooldown prevents a request storm');
  f.advance(60_000);
  await f.controller.ensure('another-unknown-model');
  assert.equal(f.fetches.length, 4);
});

test('concurrent callers share one refresh flight and a cached catalog still precedes the live fetch', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let fetches = 0;
  const f = fixture({
    fetcher: async () => { fetches++; await gate; return LIVE(); },
  });
  const first = f.controller.ensure();
  const second = f.controller.ensure('glm-5.3');
  release();
  await Promise.all([first, second]);
  assert.equal(fetches, 1);
  assert.equal(f.changed(), 1);

  const scope = opencodeCacheScope('https://opencode.ai/inference/go/v1/models');
  const normalized = normalizeOpencodeCatalog(opencodeDocument(opencodeItem('synthetic-cached-model')))!;
  const entry = createCatalogCacheEntry(scope, { data: normalized.data as unknown as Record<string, unknown>[] }, NOW, [], 'opencode-go')!;
  const cache: CatalogCache = {
    async read() { return entry as CatalogCacheEntry; },
    async write() {},
  };
  const offline = fixture({
    cache: () => cache,
    fetcher: async () => { throw new Error('synthetic offline'); },
  });
  await offline.controller.ensure();
  assert.deepEqual(Object.keys(offline.catalog), ['synthetic-cached-model']);
  assert.deepEqual(offline.diagnostics, ['FETCH_FAILED', 'CACHE_FALLBACK:FETCH_FAILED']);
});

test('waiter cancellation is isolated until every waiter is gone, then the flight is dropped', async () => {
  let fetches = 0;
  let aborted = false;
  const f = fixture({
    fetcher: async (_input, init) => {
      fetches++;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init?.signal?.reason); }, { once: true });
      });
    },
  });
  const first = new AbortController();
  const second = new AbortController();
  const a = f.controller.ensure(undefined, first.signal);
  const b = f.controller.ensure(undefined, second.signal);
  first.abort(new Error('synthetic first caller'));
  await assert.rejects(a, /synthetic first caller/u);
  assert.equal(aborted, false, 'one cancelling waiter never cancels the shared flight');
  second.abort(new Error('synthetic second caller'));
  await assert.rejects(b, /synthetic second caller/u);
  assert.equal(aborted, true, 'the last waiter releases the in-flight request');
  assert.equal(fetches, 1);

  f.options.fetcher = async () => { fetches++; return LIVE(); };
  await f.controller.ensure();
  assert.equal(fetches, 2, 'the aborted flight does not poison the next demand-driven refresh');
});

test('invalidate and dispose restore installed descriptors and reset demand', async () => {
  const f = fixture();
  await f.controller.ensure();
  assert.ok(Object.hasOwn(f.catalog, 'synthetic-live-model'));
  f.controller.invalidate();
  assert.deepEqual(f.catalog, f.baseline);
  await f.controller.ensure();
  assert.equal(f.fetches.length, 2);

  f.controller.dispose();
  assert.deepEqual(f.catalog, f.baseline);
  await assert.rejects(f.controller.ensure(), /unloaded/u);
  assert.throws(() => f.controller.refresh(), /unloaded/u, 'refresh reports its lifecycle failure synchronously');
});

test('an inactive route restores once and never performs network access', async () => {
  const f = fixture();
  await f.controller.ensure();
  assert.equal(f.fetches.length, 1);
  const active = f.options.active;
  f.options.active = () => false;
  assert.equal(await f.controller.refresh(), undefined);
  await f.controller.ensure();
  assert.deepEqual(f.catalog, f.baseline);
  const changed = f.changed();
  await f.controller.ensure();
  assert.equal(f.changed(), changed, 'repeated disabled calls do not keep notifying');
  f.options.active = active;
  await f.controller.ensure();
  assert.equal(f.fetches.length, 2, 're-enabling discovery refreshes on the next demand');
});

test('an endpoint change invalidates the published selection before the next refresh', async () => {
  const f = fixture();
  await f.controller.ensure();
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0], 'https://opencode.ai/inference/go/v1/models');
  f.options.baseUrl = () => 'https://gateway.example.com/v1';
  await f.controller.ensure();
  assert.equal(f.fetches.length, 2);
  assert.equal(f.fetches[1], 'https://gateway.example.com/v1/models');
});

test('a failed refresh keeps the last successful selection and reports a controlled diagnostic', async () => {
  const f = fixture();
  await f.controller.ensure();
  f.advance(INTERVAL);
  f.options.fetcher = async () => { throw new Error('synthetic offline'); };
  await f.controller.ensure();
  assert.deepEqual(Object.keys(f.catalog), ['glm-5.3', 'synthetic-live-model']);
  assert.deepEqual(f.diagnostics, ['DISCOVERY_FAILED']);
});
