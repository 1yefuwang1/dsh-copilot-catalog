import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UploadScheduler } from '../src/sync/scheduler.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('scheduler debounces one session and flushNow cancels the pending timer', async () => {
  const runs: string[] = [];
  const scheduler = new UploadScheduler(async (id) => { runs.push(id); }, 15);
  scheduler.schedule('a');
  scheduler.schedule('a');
  scheduler.schedule('b');
  await wait(40);
  assert.deepEqual(runs.sort(), ['a', 'b']);
  scheduler.schedule('c');
  await scheduler.flushNow('c');
  assert.deepEqual(runs.sort(), ['a', 'b', 'c']);
  scheduler.stop();
  scheduler.schedule('d');
  await wait(25);
  assert.deepEqual(runs.sort(), ['a', 'b', 'c']);
});
