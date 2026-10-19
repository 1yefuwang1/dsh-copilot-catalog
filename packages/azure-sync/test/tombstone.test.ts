import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDeleteRow, generationScopedRows, resurrect, tombstone } from '../src/sync/tombstone.js';
import { planCleanup } from '../src/sync/cleanup.js';
import { batchRow, cloudSession } from './helpers.js';

test('tombstone persists deletion audit and cleanup fence, clears lease mirrors, and is idempotent', () => {
  const entity = cloudSession({ state: 'active', enabled: true, generation: 3, writerEpoch: 7, leaseOwner: 'a', leaseUntil: 300 });
  const { entity: dead } = tombstone(entity, 100, 'device-b');
  assert.equal(dead.state, 'deleted');
  assert.equal(dead.enabled, false);
  assert.equal(dead.writerEpoch, 8);
  assert.equal(dead.previousGeneration, 3);
  assert.equal(dead.deletedAt, 100);
  assert.equal(dead.deletedBy, 'device-b');
  assert.equal(dead.cleanupPending, true);
  assert.equal(dead.leaseOwner, undefined);
  assert.equal(dead.leaseUntil, undefined);
  const again = tombstone(dead, 200, 'device-c').entity;
  assert.equal(again.writerEpoch, 8);
  assert.equal(again.deletedAt, 100);
  assert.equal(again.deletedBy, 'device-b');
  assert.throws(() => resurrect(dead, 200), /resume cleanup/u);
  const revived = resurrect({ ...dead, cleanupPending: false }, 200);
  assert.equal(revived.state, 'active');
  assert.equal(revived.generation, 4);
  assert.equal(revived.rootGeneration, 4);
  assert.equal(revived.writerEpoch, 9);
  assert.equal(revived.eventCount, 0);
  assert.equal(revived.headSeq, -1);
  assert.equal(revived.lastBatchRowKey, undefined);
  assert.equal(revived.deletedAt, undefined);
});

test('cleanup only authorizes the exact tombstone generation, never a resurrected manifest', () => {
  const oldRow = batchRow('session-test', 3, 0);
  const newRow = batchRow('session-test', 4, 0);
  assert.deepEqual(generationScopedRows([oldRow, newRow], 3), [oldRow]);
  const dead = cloudSession({ sessionId: 'session-test', state: 'deleted', generation: 3 });
  assert.equal(canDeleteRow(oldRow, dead), true);
  assert.equal(canDeleteRow(newRow, dead), false);
  assert.deepEqual(planCleanup([oldRow, newRow], dead).blobNames, [oldRow.blobName]);
  assert.equal(canDeleteRow(oldRow, { ...dead, state: 'active', generation: 4, previousGeneration: 3 }), false);
});

test('disabled re-enable retains committed history and explicit child resurrection is rejected', () => {
  const disabled = cloudSession({ state: 'disabled', enabled: false });
  const active = resurrect(disabled, 100);
  assert.equal(active.generation, disabled.generation);
  assert.equal(active.eventCount, disabled.eventCount);
  assert.equal(active.chainHash, disabled.chainHash);
  assert.equal(active.lastBatchRowKey, disabled.lastBatchRowKey);
  assert.equal(active.writerEpoch, disabled.writerEpoch + 1);
  assert.throws(() => resurrect({ ...disabled, rootSessionId: 'root' }, 200), /root session/u);
});
