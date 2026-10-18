import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideLiveCatchup } from '../src/sync/live-guard.js';

test('a live retained Agent never opens a second writer for a remote-ahead suffix', () => {
  const decision = decideLiveCatchup(true, 10, 4);
  assert.equal(decision.blocked, true);
  assert.equal(decision.reason, 'remote-ahead-live');
  assert.equal(decision.openWrite, false);
  assert.equal(decision.restartRequired, true);
  assert.equal(decision.importAllowed, false);
});

test('cold remote-ahead imports with a write handle; same/live-local does nothing', () => {
  const cold = decideLiveCatchup(false, 10, 4);
  assert.deepEqual(cold, { blocked: false, openWrite: true, restartRequired: false, importAllowed: true });
  assert.equal(decideLiveCatchup(true, 4, 4).blocked, false);
});
