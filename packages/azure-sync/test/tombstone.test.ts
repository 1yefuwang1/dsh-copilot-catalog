import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDeleteRow, generationScopedRows, resurrect, tombstone } from '../src/sync/tombstone.js';
import { planCleanup } from '../src/sync/cleanup.js';
import { batchRow, cloudSession } from './helpers.js';

test('tombstone disables and bumps the epoch; resurrection creates a new generation', () => {
  const entity = cloudSession({ state: 'active', enabled: true, generation: 3, writerEpoch: 7 });
  const result = tombstone(entity, 100);
  assert.equal(result.entity.state, 'deleted');
  assert.equal(result.entity.enabled, false);
  assert.equal(result.entity.writerEpoch, 8);
  assert.equal(result.entity.previousGeneration, 3);
  const revived = resurrect(result.entity, 200);
  assert.equal(revived.state, 'active');
  assert.equal(revived.generation, 4);
  assert.equal(revived.writerEpoch, 9);
});

test('cleanup is generation-scoped and never touches the new generation', () => {
  const oldRow = batchRow('session-test', 3, 0, { blobName: 'old' });
  const newRow = batchRow('session-test', 4, 0, { blobName: 'new' });
  assert.deepEqual(generationScopedRows([oldRow, newRow], 3), [oldRow]);
  const dead = { state: 'active' as const, generation: 4, previousGeneration: 3 };
  assert.equal(canDeleteRow(oldRow, dead), true);
  assert.equal(canDeleteRow(newRow, dead), false);
  assert.deepEqual(planCleanup([oldRow, newRow], dead).blobNames, ['old']);
});

test('a late old-generation cleanup cannot delete a current row', () => {
  const current = { state: 'active' as const, generation: 4 };
  assert.equal(canDeleteRow(batchRow('session-test', 4, 0), current), false);
});
