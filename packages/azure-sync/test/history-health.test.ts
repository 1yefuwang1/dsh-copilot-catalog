import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { HistoryPinStore, historyScopeId, historyWatermark } from '../src/sync/history-state.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { bounds, deferred, historyFixture, scope } from './history-fixture.js';

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const damaged = (error: unknown) => error instanceof AzureSyncError && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT'].includes(error.code);
async function metadata() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-health-')));
  const ctx = new Context(); new Storage(ctx);
  const backend = new JsonStorageBackend(join(root, 'metadata')); ctx.storage.backend.register('health-fixture', backend);
  const facility = new DomainFacility(ctx, { backend: 'health-fixture' });
  const pins = new HistoryPinStore(facility); await pins.open();
  return { root, pins, async close() {
    await pins.close(); await facility.closeAll(); await backend.close();
    assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  } };
}

test('untracked preview audit failure survives component/pin restart and cannot trust intact old disk data', async t => {
  const local = await metadata(); t.after(() => local.close()); const f = historyFixture();
  const directory = join(local.root, 'cache'); await mkdir(directory, { mode: 0o700 });
  const options = { ...bounds, scope, pins: local.pins, cache: { directory } };
  const first = new RemoteSessionReader(f.repository, options); t.after(() => first.close());
  await first.read(f.sessionId); // Preview only: no LocalSessionRecord or Native service exists in this fixture.
  const name = f.rows[0]!.blobName, original = Buffer.from(f.blobs.get(name)!);
  f.blobs.set(name, gzipSync(Buffer.from('changed canonical bytes\n')));
  await assert.rejects(first.audit(f.sessionId), damaged);
  const downloads = f.calls.blob;
  await assert.rejects(first.observe(f.sessionId), damaged); assert.equal(f.calls.blob, downloads);
  await first.close(); await local.pins.close(); await local.pins.open();
  const reopened = new RemoteSessionReader(f.repository, options); t.after(() => reopened.close());
  await assert.rejects(reopened.read(f.sessionId), damaged);
  assert.equal(f.calls.blob, downloads, 'durable health refusal precedes old private payload-cache reuse');
  f.blobs.set(name, original);
  assert.equal((await reopened.audit(f.sessionId))?.events.length, 2, 'only explicit raw audit clears the matching failure');
  const repaired = f.calls.blob;
  assert.equal((await reopened.read(f.sessionId))?.events.length, 2);
  assert.equal(f.calls.blob, repaired);
});

test('health failure is scoped to actual endpoint/session/generation and another account audit cannot clear it', async t => {
  const local = await metadata(); t.after(() => local.close());
  const a = historyFixture(), b = historyFixture(2, a.sessionId);
  const other = { ...scope, blobEndpoint: 'https://two.blob.core.windows.net/private', tableEndpoint: 'https://two.table.core.windows.net' };
  const first = new RemoteSessionReader(a.repository, { ...bounds, scope, pins: local.pins });
  const second = new RemoteSessionReader(b.repository, { ...bounds, scope: other, pins: local.pins });
  t.after(() => Promise.all([first.close(), second.close()]));
  await first.read(a.sessionId);
  a.blobs.set(a.rows[0]!.blobName, gzipSync(Buffer.from('broken\n')));
  await assert.rejects(first.audit(a.sessionId), damaged);
  assert.equal((await second.audit(b.sessionId))?.events.length, 2);
  await assert.rejects(first.read(a.sessionId), damaged);
  assert.notEqual(first.scopeId, second.scopeId);
  assert.equal(local.pins.health(historyWatermark(first.scopeId, a.manifest.entity)).failure, 'corrupt-remote');
  assert.equal(local.pins.health(historyWatermark(second.scopeId, b.manifest.entity)).failure, undefined);
});

test('canceled independent audits still occupy the four actual raw transport slots until completion', { timeout: 3000 }, async t => {
  const f = historyFixture(1), gates: Array<ReturnType<typeof deferred<void>>> = [];
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope });
  t.after(async () => { gates.forEach(gate => gate.resolve()); await reader.close(); });
  let entered = deferred();
  f.beforeBlob = async () => { const gate = deferred(); gates.push(gate); entered.resolve(); await gate.promise; };
  for (let i = 0; i < 4; i++) {
    entered = deferred(); const stop = new AbortController();
    const pending = reader.audit(f.sessionId, { signal: stop.signal });
    await entered.promise; stop.abort();
    await assert.rejects(pending, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  }
  const queued = new AbortController(); const fifth = reader.audit(f.sessionId, { signal: queued.signal });
  await new Promise<void>(resolve => setImmediate(() => resolve()));
  assert.equal(f.calls.blob, 4, 'audit bypass is independent, not exempt from the raw transport budget');
  queued.abort(); await assert.rejects(fifth);
  gates.forEach(gate => gate.resolve());
});

test('a stale audit clear cannot erase a newer durable failure revision', async t => {
  const local = await metadata(); t.after(() => local.close()); const f = historyFixture();
  const w = historyWatermark(historyScopeId(scope), f.manifest.entity), initial = local.pins.health(w);
  await local.pins.failHealth(w, 'corrupt-remote', () => {});
  assert.equal(await local.pins.clearHealth(w, initial.revision, () => {}), false);
  const failed = local.pins.health(w); assert.equal(failed.failure, 'corrupt-remote');
  assert.equal(await local.pins.clearHealth(w, failed.revision, () => {}), true);
  const cleared = local.pins.health(w); assert.equal(cleared.failure, undefined); assert.ok(cleared.revision > failed.revision);
  await local.pins.failHealth(w, 'committed-index-corrupt', () => {});
  assert.equal(await local.pins.clearHealth(w, cleared.revision, () => {}), false);
  assert.equal(local.pins.health(w).failure, 'committed-index-corrupt');
});

test('an older successful raw read cannot heal damage discovered by a concurrent newer audit', { timeout: 3000 }, async t => {
  const local = await metadata(); t.after(() => local.close()); const f = historyFixture();
  const older = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins });
  const newer = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: local.pins });
  const entered = deferred(), release = deferred();
  t.after(async () => { release.resolve(); await older.close(); await newer.close(); });
  await older.read(f.sessionId);
  let readLast = false, paused = false;
  f.beforeBlob = name => { if (name === f.rows.at(-1)!.blobName) readLast = true; };
  f.beforeManifest = async () => { if (readLast && !paused) { paused = true; entered.resolve(); await release.promise; } };
  const oldAudit = older.audit(f.sessionId);
  await entered.promise;
  f.blobs.set(f.rows[0]!.blobName, gzipSync(Buffer.from('newly damaged\n')));
  await assert.rejects(newer.audit(f.sessionId), damaged);
  release.resolve();
  await assert.rejects(oldAudit, damaged);
  assert.equal(local.pins.health(historyWatermark(older.scopeId, f.manifest.entity)).failure, 'corrupt-remote');
  await assert.rejects(older.observe(f.sessionId), damaged);
});
