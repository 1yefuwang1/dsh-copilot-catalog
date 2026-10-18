import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyConflictAction, isConflictAction } from '../src/sync/conflict.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('only the three conservative conflict actions are accepted', async () => {
  assert.equal(isConflictAction('keep-local'), true);
  assert.equal(isConflictAction('overwrite'), false);
  const calls: string[] = [];
  const handlers = {
    keepLocal: () => { calls.push('keep-local'); },
    exportLocal: () => { calls.push('export-local'); },
    removeCloud: () => { calls.push('remove-cloud'); },
  };
  assert.equal(await applyConflictAction('export-local', handlers), 'export-local');
  assert.deepEqual(calls, ['export-local']);
  await assert.rejects(applyConflictAction('fork', handlers), (error: unknown) => error instanceof AzureSyncError && error.code === 'CONFLICT');
});
