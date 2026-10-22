import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryFetches, HistoryOwner } from '../src/sync/history-work.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { bounds, deferred, historyFixture, scope } from './history-fixture.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';

test('A14 bounded fetch queue admits four raw payload IOs and no canceled queued next IO', async () => {
  const fetches = new HistoryFetches(4); const runtime = new AbortController(); const gate = deferred(); const saturated = deferred(); let active = 0; let peak = 0; let starts = 0;
  const owners = Array.from({ length: 10 }, () => new AbortController());
  const promises = owners.map((controller, i) => fetches.fetch(String(i), new HistoryOwner({ signal: controller.signal }, runtime.signal), async context => {
    await context.check(); starts += 1; active += 1; peak = Math.max(peak, active); if (active === 4) saturated.resolve();
    try { await gate.promise; await context.check(); return Buffer.from('canonical content'); } finally { active -= 1; }
  }));
  await saturated.promise; assert.equal(starts, 4); owners[9]!.abort(); await assert.rejects(promises[9]!, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  gate.resolve(); await Promise.all(promises.slice(0, 9)); assert.equal(peak, 4); assert.equal(starts, 9); await fetches.close();
});
test('A14 ignored aborts retain raw transport slots while logical teardown remains prompt', async () => {
  const fetches = new HistoryFetches(4); const runtime = new AbortController(); const gate = deferred(); const saturated = deferred(); let starts = 0;
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller, i) => fetches.fetch(String(i), new HistoryOwner({ signal: controller.signal }, runtime.signal), async () => { starts += 1; if (starts === 4) saturated.resolve(); await gate.promise; return Buffer.alloc(0); }));
  await saturated.promise; for (const controller of controllers) controller.abort(); await Promise.allSettled(pending);
  const queuedController = new AbortController(); const queued = fetches.fetch('fifth', new HistoryOwner({ signal: queuedController.signal }, runtime.signal), async () => { starts += 1; return Buffer.alloc(0); });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(starts, 4); queuedController.abort();
  await assert.rejects(queued, error => error instanceof AzureSyncError && error.code === 'CANCELLED'); await fetches.close(); gate.resolve();
});
test('A14 no valid owner after an authority check failure prevents subsequent raw IO even without explicit abort', async () => {
  const fetches = new HistoryFetches(4); const runtime = new AbortController(); let valid = true; let second = 0;
  const owner = new HistoryOwner({ check: () => { if (!valid) throw new AzureSyncError('CANCELLED', 'Intent changed.'); } }, runtime.signal);
  await assert.rejects(fetches.fetch('a', owner, async context => {
    await context.check(); valid = false;
    await context.check(); second += 1; return Buffer.alloc(0);
  }), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(second, 0); await fetches.close();
});
test('A21 pre-enrolled independent preparation survives an internal proof waiter timeout but grants no lease/step effect', async () => {
  const f = historyFixture(); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); const began = deferred(); const gate = deferred();
  f.beforeBlob = async () => { began.resolve(); await gate.promise; };
  const proofWaiter = new AbortController(); const proof = reader.read(f.sessionId, { signal: proofWaiter.signal }); const preparation = reader.read(f.sessionId);
  await began.promise; proofWaiter.abort(); await assert.rejects(proof, error => error instanceof AzureSyncError && error.code === 'CANCELLED'); gate.resolve(); await preparation;
  const historyReads = f.calls.blob; assert.equal((await reader.read(f.sessionId))?.events.length, 2); assert.equal(f.calls.blob, historyReads); await reader.close();
});
