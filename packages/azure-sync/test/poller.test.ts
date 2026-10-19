import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AzureSyncError } from '../src/azure/errors.js';
import { ManifestPoller } from '../src/sync/poller.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Drain the provider/observer promise continuations without advancing timers.
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test('overlapping manual ticks share one awaited trailing refresh, without overlap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const firstGate = deferred();
  const trailingGate = deferred();
  const signals: AbortSignal[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: (signal) => {
      signals.push(signal);
      return signals.length === 1 ? firstGate.promise : trailingGate.promise;
    },
  });
  t.after(() => poller.stop());
  poller.start();
  poller.start();
  const first = poller.tick();
  const second = poller.tick();
  const third = poller.tick();
  assert.equal(second, third);
  assert.notEqual(first, second);
  let trailingDone = false;
  void second.then(() => { trailingDone = true; });
  t.mock.timers.tick(500);
  assert.equal(signals.length, 1, 'automatic timer must not overlap a manual attempt');
  firstGate.resolve();
  await first;
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.aborted, true, 'success invalidates its attempt signal');
  assert.equal(signals[1]!.aborted, false);
  assert.equal(trailingDone, false, 'manual waiter must wait for the trailing refresh');
  trailingGate.resolve();
  await Promise.all([second, third]);
  assert.equal(trailingDone, true);
  assert.equal(signals[1]!.aborted, true);
  poller.stop();
  await poller.tick();
  t.mock.timers.tick(10_000);
  assert.equal(signals.length, 2);
});

test('stop immediately aborts and releases current/trailing ticks for a never-settling provider', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const errors: unknown[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refreshTimeoutMs: 1_000,
    refresh: (signal) => { signals.push(signal); return new Promise<void>(() => undefined); },
    onError: (error) => { errors.push(error); },
  });
  poller.start();
  const first = poller.tick();
  const trailing = poller.tick();
  assert.equal(poller.stop(), undefined, 'teardown is synchronous');
  await Promise.all([first, trailing]);
  assert.equal(poller.active, false);
  assert.equal(signals[0]!.aborted, true);
  assert.equal((signals[0]!.reason as AzureSyncError).code, 'CANCELLED');
  t.mock.timers.tick(100_000);
  assert.equal(signals.length, 1);
  assert.deepEqual(errors, [], 'intentional stop is not reported as a refresh failure');
  poller.stop();
});

test('timeout bounds a never-settling refresh, aborts it, and services the trailing manual request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const errors: AzureSyncError[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refreshTimeoutMs: 30,
    refresh: (signal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve();
    },
    onError: (error) => { errors.push(error as AzureSyncError); },
  });
  t.after(() => poller.stop());
  poller.start();
  const first = poller.tick();
  const trailing = poller.tick();
  t.mock.timers.tick(29);
  assert.equal(signals[0]!.aborted, false);
  t.mock.timers.tick(1);
  await Promise.all([first, trailing]);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, 'TRANSIENT');
  t.mock.timers.tick(99);
  assert.equal(signals.length, 2, 'trailing success resets automatic delay');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(signals.length, 3);
});

test('late success after stop/restart cannot publish guarded state or disturb a new attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldGate = deferred();
  const newGate = deferred();
  const signals: AbortSignal[] = [];
  let published = 0;
  const errors: unknown[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: async (signal) => {
      signals.push(signal);
      await (signals.length === 1 ? oldGate.promise : newGate.promise);
      signal.throwIfAborted();
      published += 1;
    },
    onError: (error) => { errors.push(error); },
  });
  t.after(() => poller.stop());
  poller.start();
  const oldTick = poller.tick();
  poller.stop();
  await oldTick;
  poller.start();
  const newTick = poller.tick();
  oldGate.resolve();
  await flush();
  assert.equal(published, 0);
  assert.equal(signals[1]!.aborted, false, 'old completion cannot cancel new IO');
  assert.equal(poller.active, true);
  assert.deepEqual(errors, [], 'late rejection caused by cancellation is observed and ignored');
  newGate.resolve();
  await newTick;
  assert.equal(published, 1);
});

test('an uncooperative late success after stop cannot finish or reschedule a restarted attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const oldGate = deferred();
  const newGate = deferred();
  let calls = 0;
  const errors: unknown[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: () => { calls += 1; return calls === 1 ? oldGate.promise : newGate.promise; },
    onError: (error) => { errors.push(error); },
  });
  t.after(() => poller.stop());
  poller.start();
  const oldTick = poller.tick();
  poller.stop();
  await oldTick;
  poller.start();
  const newTick = poller.tick();
  let newDone = false;
  void newTick.then(() => { newDone = true; });
  oldGate.resolve();
  await flush();
  t.mock.timers.tick(500);
  await flush();
  assert.equal(newDone, false);
  assert.equal(calls, 2, 'late success must not schedule another timer');
  assert.deepEqual(errors, []);
  newGate.resolve();
  await newTick;
  assert.equal(newDone, true);
});

test('late success after timeout cannot reset retry backoff or schedule a second timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let calls = 0;
  const errors: AzureSyncError[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refreshTimeoutMs: 20,
    refresh: () => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve(); },
    onError: (error) => { errors.push(error as AzureSyncError); },
  });
  t.after(() => poller.stop());
  poller.start();
  const first = poller.tick();
  t.mock.timers.tick(20);
  await first;
  gate.resolve();
  await flush();
  t.mock.timers.tick(199);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  assert.deepEqual(errors.map((error) => error.code), ['TRANSIENT']);
});

test('late provider rejection is observed after cancellation without diagnostics or retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let calls = 0;
  const errors: unknown[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: () => { calls += 1; return gate.promise; },
    onError: (error) => { errors.push(error); },
  });
  poller.start();
  const tick = poller.tick();
  poller.stop();
  await tick;
  gate.reject(new Error('late provider failure'));
  await flush();
  t.mock.timers.tick(10_000);
  assert.deepEqual(errors, []);
  assert.equal(calls, 1);
});

test('automatic errors use stable codes and capped exponential backoff that success resets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const errors: AzureSyncError[] = [];
  const poller = new ManifestPoller({
    intervalMs: 100,
    maxBackoffMs: 400,
    refresh: async () => {
      calls += 1;
      if (calls <= 3) throw { statusCode: calls === 1 ? 429 : 503, message: 'provider diagnostics' };
    },
    onError: (error) => { errors.push(error as AzureSyncError); },
  });
  t.after(() => poller.stop());
  poller.start();
  for (const [delay, expected] of [[100, 1], [200, 2], [400, 3], [400, 4], [100, 5]] as const) {
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(calls, expected - 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, expected);
  }
  assert.deepEqual(errors.map((error) => error.code), ['THROTTLED', 'TRANSIENT', 'TRANSIENT']);
  assert.equal(errors.some((error) => error.message.includes('provider diagnostics')), false);
});

test('manual ticks bypass pending backoff rather than being silently dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: async () => { calls += 1; if (calls === 1) throw new Error('failure'); },
  });
  t.after(() => poller.stop());
  poller.start();
  await poller.tick();
  assert.equal(calls, 1);
  await poller.tick();
  assert.equal(calls, 2);
  t.mock.timers.tick(100);
  await flush();
  assert.equal(calls, 3, 'manual success reset the delay and replaced the previous timer');
});

test('auth failure stops automatic and queued manual ticks until explicitly restarted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const failure of [new AzureSyncError('AUTH_REQUIRED', 'Credential required.'), { statusCode: 401 }, { statusCode: 403 }]) {
    const gate = deferred();
    let calls = 0;
    const errors: AzureSyncError[] = [];
    const poller = new ManifestPoller({
      intervalMs: 100,
      refresh: () => { calls += 1; return calls === 1 ? gate.promise : Promise.resolve(); },
      onError: (error) => { errors.push(error as AzureSyncError); },
    });
    poller.start();
    const first = poller.tick();
    const trailing = poller.tick();
    gate.reject(failure);
    await Promise.all([first, trailing]);
    assert.equal(poller.active, false);
    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.code, /^AUTH_(REQUIRED|FAILED)$/);
    await poller.tick();
    t.mock.timers.tick(10_000);
    assert.equal(calls, 1);
    poller.start();
    await poller.tick();
    assert.equal(calls, 2);
    poller.stop();
  }
});

test('synchronous refresh throws and throwing/rejecting error observers cannot strand polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const observer of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    let calls = 0;
    const poller = new ManifestPoller({
      intervalMs: 100,
      refresh: () => { calls += 1; if (calls === 1) throw new Error('provider'); return Promise.resolve(); },
      onError: observer,
    });
    poller.start();
    await poller.tick();
    t.mock.timers.tick(200);
    await flush();
    assert.equal(calls, 2);
    poller.stop();
  }
});

test('an error observer can synchronously stop polling without losing waiters', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let calls = 0;
  const poller = new ManifestPoller({
    intervalMs: 100,
    refresh: () => { calls += 1; return gate.promise; },
    onError: () => poller.stop(),
  });
  poller.start();
  const first = poller.tick();
  const trailing = poller.tick();
  gate.reject(new Error('failure'));
  await Promise.all([first, trailing]);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  assert.equal(poller.active, false);
});

test('poller rejects invalid durations instead of allowing timer overflow/busy loops', () => {
  for (const intervalMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
    assert.throws(() => new ManifestPoller({ intervalMs, refresh: async () => undefined }), RangeError);
  }
  assert.throws(() => new ManifestPoller({ intervalMs: 100, refreshTimeoutMs: 0, refresh: async () => undefined }), RangeError);
  assert.throws(() => new ManifestPoller({ intervalMs: 100, maxBackoffMs: 99, refresh: async () => undefined }), RangeError);
});
