import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseDrain } from '../src/sync/lease-drain.js';

test('drain waits for idle, empty inbox, two quiet seconds, flush, and suffix', () => {
  const drain = new LeaseDrain();
  drain.noteActivity(1_000);
  assert.equal(drain.ready(3_000, { inboxSize: 0, agentIdle: true }), false);
  drain.markFlushed();
  assert.equal(drain.ready(3_000, { inboxSize: 0, agentIdle: true }), false);
  drain.markSuffixPublished();
  assert.equal(drain.ready(2_999, { inboxSize: 0, agentIdle: true }), false);
  assert.equal(drain.ready(3_000, { inboxSize: 0, agentIdle: true }), true);
  assert.equal(drain.ready(3_000, { inboxSize: 1, agentIdle: true }), false);
  assert.equal(drain.ready(3_000, { inboxSize: 0, agentIdle: false }), false);
});

test('new activity invalidates flush and suffix until they happen again', () => {
  const drain = new LeaseDrain();
  drain.noteActivity(0);
  drain.markFlushed();
  drain.markSuffixPublished();
  assert.equal(drain.ready(2_000, { inboxSize: 0, agentIdle: true }), true);
  drain.noteActivity(2_100);
  assert.equal(drain.ready(4_100, { inboxSize: 0, agentIdle: true }), false);
  drain.markFlushed();
  drain.markSuffixPublished();
  assert.equal(drain.ready(4_100, { inboxSize: 0, agentIdle: true }), true);
});
