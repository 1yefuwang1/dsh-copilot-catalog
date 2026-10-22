import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeHistoryJobs } from '../src/sync/runtime-history-jobs.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(timeoutMs = 120_000) {
  const runtime = new AbortController();
  let authority = 'enabled:scope:generation:nonce';
  const jobs = new RuntimeHistoryJobs({ signal: runtime.signal, timeoutMs, authority: () => authority,
    check: (_id, expected) => { assert.equal(expected, authority, 'authority revoked'); } });
  return { jobs, runtime, revoke: () => { authority = 'off'; } };
}

test('a proof-budget expiry retains its pre-enrolled read-only preparation without another request', async () => {
  const f = fixture(); const pending = deferred<void>(); let starts = 0; let publications = 0;
  const first = f.jobs.prepare('sid', async job => { starts++; await pending.promise; job.check(); publications++; return 'verified bytes'; });
  await turn(); first.release(true);
  const second = f.jobs.prepare('sid', async () => { throw new Error('must share the running owner'); });
  pending.resolve();
  assert.equal(await second.promise, 'verified bytes'); second.release();
  assert.equal(starts, 1); assert.equal(publications, 1);
  f.runtime.abort(); await f.jobs.settle(50);
});

test('true sole cancellation stops next IO and does not invent a preparation owner', async () => {
  const f = fixture(); const pending = deferred<void>(); let nextIO = 0;
  const waiter = f.jobs.prepare('sid', async job => { await pending.promise; job.check(); nextIO++; });
  const rejected = assert.rejects(waiter.promise, { name: 'AbortError' });
  await turn(); waiter.release(); await rejected;
  pending.resolve(); await turn();
  assert.equal(nextIO, 0);
});

test('one request cancellation cannot stop a valid second preparation waiter', async () => {
  const f = fixture(); const pending = deferred<void>();
  const first = f.jobs.prepare('sid', async job => { await pending.promise; job.check(); return 42; });
  const second = f.jobs.prepare('sid', async () => 0);
  first.release(); pending.resolve(); assert.equal(await second.promise, 42); second.release();
});

test('runtime teardown and changed intent fence retained preparations and single-flight workers', async () => {
  for (const change of ['runtime', 'intent'] as const) {
    const f = fixture(); const pending = deferred<void>(); let effects = 0; let starts = 0;
    const first = f.jobs.work('sid', async job => { starts++; await pending.promise; job.check(); effects++; });
    assert.ok(first);
    assert.equal(f.jobs.work('sid', async () => { starts++; }), first);
    const prepared = f.jobs.prepare('sid', async job => { await pending.promise; job.check(); effects++; });
    prepared.release(true);
    const settled = Promise.allSettled([first, prepared.promise]);
    await turn();
    if (change === 'runtime') f.runtime.abort(); else { f.revoke(); f.jobs.invalidate('sid'); }
    await settled; pending.resolve(); await turn();
    assert.equal(starts, 1); assert.equal(effects, 0);
    await f.jobs.settle(25);
  }
});

test('a finite worker deadline is bounded and preserves backoff rather than restarting every tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(120_000); let starts = 0;
  const work = f.jobs.work('sid', async () => { starts++; return new Promise<void>(() => undefined); });
  assert.ok(work); const rejected = assert.rejects(work);
  await turn(); t.mock.timers.tick(120_000); await rejected;
  assert.equal(f.jobs.work('sid', async () => { starts++; }), undefined);
  assert.equal(starts, 1);
});
