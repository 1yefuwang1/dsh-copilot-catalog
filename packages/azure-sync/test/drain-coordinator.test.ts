import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DrainCoordinator } from '../src/sync/drain-coordinator.js';
import type { SessionLease } from '../src/sync/lease-manager.js';

test('drain coordinator holds a lease until every quiet-period condition is met', async () => {
  const coordinator = new DrainCoordinator();
  const released: string[] = [];
  const lease = { sessionId: 'session-test' } as SessionLease;
  coordinator.hold(lease);
  coordinator.noteActivity('session-test', 1_000);
  assert.equal(await coordinator.maybeRelease('session-test', 3_000, { inboxSize: 0, agentIdle: true }, async (value) => { released.push(value.sessionId); }), false);
  coordinator.markFlushed('session-test');
  coordinator.markSuffix('session-test');
  assert.equal(await coordinator.maybeRelease('session-test', 2_999, { inboxSize: 0, agentIdle: true }, async (value) => { released.push(value.sessionId); }), false);
  assert.equal(await coordinator.maybeRelease('session-test', 3_000, { inboxSize: 1, agentIdle: true }, async (value) => { released.push(value.sessionId); }), false);
  assert.equal(await coordinator.maybeRelease('session-test', 3_000, { inboxSize: 0, agentIdle: true }, async (value) => { released.push(value.sessionId); }), true);
  assert.deepEqual(released, ['session-test']);
  assert.equal(coordinator.take('session-test'), undefined);
});
