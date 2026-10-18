import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { sessionHeader } from './helpers.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('three-argument coldSnapshot writes a checkpoint that is polled into view', async () => {
  const header = sessionHeader() as never;
  let cached: unknown;
  const cache = {
    coldSnapshot: async (_header: unknown, _inherited: unknown, _events: unknown) => { cached = { ready: true }; },
    cachedSnapshot: () => cached,
  };
  const warmer = new ProjectionWarmer({ cache: cache as never, sleep: async () => undefined, polls: 2, pollMs: 0 });
  assert.equal(await warmer.warm('session-test', header, 0, []), 'complete');
});

test('two-argument coldSnapshot and TypeError fallback are supported', async () => {
  const header = sessionHeader() as never;
  let calls = 0;
  const cache = {
    coldSnapshot: async (...args: unknown[]) => {
      calls += 1;
      if (args.length >= 3) throw new TypeError('wrong signature');
      return { ready: true };
    },
    cachedSnapshot: () => ({ ready: true }),
  };
  const warmer = new ProjectionWarmer({ cache: cache as never, sleep: async () => undefined });
  assert.equal(await warmer.warm('session-test', header, 0, []), 'complete');
  assert.equal(calls, 1);
});

test('no cache write path yields partial, never a false synced state', async () => {
  const header = sessionHeader() as never;
  const partial = new ProjectionWarmer({ cache: { coldSnapshot: async () => undefined, cachedSnapshot: () => undefined } as never, sleep: async () => undefined, polls: 2 });
  await assert.rejects(partial.warm('session-test', header, 0, []), (error: unknown) => error instanceof AzureSyncError && error.code === 'PROJECTION_WARM_PARTIAL');
  assert.equal(await new ProjectionWarmer({}).warm('session-test', header, 0, []), 'partial');
});

test('receiver-bound coldSnapshot and stale cache detection', async () => {
  class Cache {
    ready = false;
    coldSnapshot() { this.ready = true; }
    cachedSnapshot() { return this.ready ? { ready: true } : undefined; }
  }
  const cache = new Cache();
  const warmer = new ProjectionWarmer({ cache: cache as never, sleep: async () => undefined });
  assert.equal(await warmer.warm('session-test', sessionHeader() as never, 0, []), 'complete');

  const stale = { marker: 1 };
  const staleCache = { coldSnapshot: async () => undefined, cachedSnapshot: () => stale };
  await assert.rejects(new ProjectionWarmer({ cache: staleCache as never, sleep: async () => undefined, polls: 1 }).warm('session-test', sessionHeader() as never, 0, []), (error: unknown) => error instanceof AzureSyncError && error.code === 'PROJECTION_WARM_PARTIAL');
});
