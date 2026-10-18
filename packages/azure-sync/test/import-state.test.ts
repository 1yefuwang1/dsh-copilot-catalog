import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceImport, canAdvance, isContinuable, needsRepair } from '../src/sync/import-state.js';
import { AzureSyncError } from '../src/azure/errors.js';

test('import state advances only along the write-ahead graph', () => {
  assert.equal(advanceImport('planned', 'creating'), 'creating');
  assert.equal(advanceImport('creating', 'appending'), 'appending');
  assert.equal(advanceImport('appending', 'attachments'), 'attachments');
  assert.equal(advanceImport('attachments', 'warming'), 'warming');
  assert.equal(advanceImport('warming', 'complete'), 'complete');
  assert.equal(advanceImport('failed', 'planned'), 'planned');
  assert.equal(canAdvance('complete', 'planned'), false);
  assert.throws(() => advanceImport('planned', 'complete'), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_STATE');
  assert.throws(() => advanceImport('bogus' as never, 'planned'), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_RECORD');
});

test('only complete is continuable; degraded/failed remain repairable', () => {
  assert.equal(isContinuable('complete'), true);
  assert.equal(isContinuable('degraded'), false);
  assert.equal(isContinuable('degraded', true), true);
  for (const state of ['planned', 'creating', 'appending', 'attachments', 'warming', 'degraded', 'failed'] as const) {
    assert.equal(isContinuable(state), false);
    assert.equal(needsRepair(state), true);
  }
  assert.equal(needsRepair('complete'), false);
});
