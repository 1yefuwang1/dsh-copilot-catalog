import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManifestPoller } from '../src/sync/poller.js';

test('poller coalesces overlapping ticks and stops cleanly', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const poller = new ManifestPoller({ intervalMs: 10_000, refresh: async () => { calls += 1; await gate; } });
  poller.start();
  const first = poller.tick();
  await poller.tick();
  assert.equal(calls, 1);
  release();
  await first;
  await poller.tick();
  assert.equal(calls, 2);
  poller.stop();
  assert.equal(poller.active, false);
});
