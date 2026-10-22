import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile, rename, symlink, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { AzureSyncError } from '../src/azure/errors.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { HistoryPinStore, historyScopeId, historyWatermark } from '../src/sync/history-state.js';
import { HistoryOwner } from '../src/sync/history-work.js';
import { HistoryRetentionPool } from '../src/sync/history-retention.js';
import { HistoryDirectory } from '../src/sync/history-files.js';
import { chainEvents, genesisHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { candidateBlobName, CloudRepository } from '../src/sync/cloud-repository.js';
import { encodeCloudRecord, sessionRowKey } from '../src/schema.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { TableStore } from '../src/azure/table.js';
import { bounds, deferred, historyFixture, scope } from './history-fixture.js';
import { event } from './helpers.js';
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-storage')).href);
const code = (value: string) => (error: unknown) => error instanceof AzureSyncError && error.code === value;
async function local() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-final-regression-'))); const host = new Context(); new Storage(host);
  const backend = new JsonStorageBackend(join(root, 'metadata')); host.storage.backend.register('history-review', backend);
  const facility = new DomainFacility(host, { backend: 'history-review' }); const pins = new HistoryPinStore(facility); await pins.open();
  return { root, pins, async close() { await pins.close(); await facility.closeAll(); await backend.close(); assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true }); } };
}
function realCodec(f: ReturnType<typeof historyFixture>) {
  let wire: Record<string, unknown> | undefined = encodeCloudRecord(f.manifest.entity); const calls = { manifest: 0, row: 0 };
  const table = { get: async (_partition: string, key: string) => {
    if (key === sessionRowKey(f.sessionId)) { calls.manifest += 1; return wire ? { value: { ...structuredClone(wire), etag: 'codec-etag' } } : undefined; }
    calls.row += 1; const row = f.rows.find(candidate => candidate.rowKey === key); return row ? { value: { ...encodeCloudRecord(row), etag: 'row-etag' } } : undefined;
  } } as unknown as TableStore;
  const blob = { read: (name: string, bound: number, context: Parameters<CloudRepository['readCandidate']>[2]) => f.repository.readCandidate(name, bound, context) } as BlobStore;
  return { repository: new CloudRepository(blob, table), calls, reset() { wire = encodeCloudRecord(f.manifest.entity); }, missing() { wire = undefined; },
    change(field: string, value: unknown, remove = false) { if (!wire) throw new Error('The test control row is absent.'); if (remove) delete wire[field]; else wire[field] = value; } };
}
function fork(f: ReturnType<typeof historyFixture>) {
  const e = event(0, 'user/message', { id: 'a-different-committed-branch' }); const c = chainEvents(genesisHash(f.sessionId, 1, f.manifest.entity.headerHash), [e]);
  const row = f.rows[0]!; Object.assign(row, c, { blobName: candidateBlobName(f.sessionId, 1, 0, row.createdEpoch, c.payloadHash) }); f.blobs.set(row.blobName, gzipSync(payloadBytes([e])));
  Object.assign(f.manifest.entity, { chainHash: c.chainHash, headHash: c.headHash, lastBatchBlobName: row.blobName });
}

test('P1 initial audit semantic/header failures quarantine untracked warmed previews durably', async t => {
  const l = await local(); t.after(() => l.close());
  for (const patch of [{ headSeq: 99 }, { headerJson: '{' }, { headerHash: 'f'.repeat(64) }, { batchCount: 0 }, { eventCount: -1 }]) {
    const f = historyFixture(1, `untracked-${Object.keys(patch)[0]}`); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins });
    await reader.read(f.sessionId); const good = structuredClone(f.manifest), w = historyWatermark(reader.scopeId, good.entity);
    Object.assign(f.manifest.entity, patch); await assert.rejects(reader.audit(f.sessionId)); f.manifest = good;
    assert.ok(l.pins.health(w).failure); await reader.close(); await l.pins.close(); await l.pins.open();
    const reopened = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }); const downloads = f.calls.blob;
    await assert.rejects(reopened.read(f.sessionId), error => error instanceof AzureSyncError && ['CORRUPT_REMOTE', 'COMMITTED_INDEX_CORRUPT'].includes(error.code)); assert.equal(f.calls.blob, downloads);
    assert.equal((await reopened.audit(f.sessionId))?.events.length, 1); assert.equal((await reopened.read(f.sessionId))?.events.length, 1); await reopened.close();
  }
});
test('P1 real repository decode quarantines malformed or missing immutable fields using minimal same-generation H routing', async t => {
  const l = await local(); t.after(() => l.close());
  const cases: Array<[string, unknown, boolean?]> = [ ['headerHash', 'malformed'], ['headerHash', undefined, true], ['inheritedEventCount', -1], ['inheritedEventCount', undefined, true],
    ['rootSessionId', {}], ['rootSessionId', undefined, true], ['rootGeneration', '-not-an-integer'], ['rootGeneration', undefined, true], ['schemaVersion', undefined, true] ];
  for (let i = 0; i < cases.length; i += 1) {
    const f = historyFixture(1, `wire-invalid-${i}`), codec = realCodec(f), reader = new RemoteSessionReader(codec.repository, { ...bounds, scope, pins: l.pins });
    await reader.read(f.sessionId); const w = historyWatermark(reader.scopeId, f.manifest.entity), [field, value, remove] = cases[i]!;
    codec.change(field, value, remove); const before = codec.calls.manifest;
    await assert.rejects(i % 2 ? reader.auditControl(f.sessionId) : reader.audit(f.sessionId));
    assert.equal(codec.calls.manifest - before, 2, 'strict repository decode is followed by one immutable routing-only raw Table reread');
    assert.ok(l.pins.health(w).failure); codec.reset(); const downloaded = f.calls.blob;
    await assert.rejects(reader.read(f.sessionId), code('CORRUPT_REMOTE')); assert.equal(f.calls.blob, downloaded);
    const health = l.pins.health(w); assert.ok(await reader.auditControl(f.sessionId)); assert.deepEqual(l.pins.health(w), health, 'auditControl never clears health or reads history'); assert.equal(f.calls.blob, downloaded);
    await reader.audit(f.sessionId); assert.equal((await reader.read(f.sessionId))?.events.length, 1); await reader.close();
  }
});
test('P1 real codec routing and eligibility mismatches cannot poison another accepted binding', async t => {
  const l = await local(); t.after(() => l.close());
  for (const change of [ ['partitionKey', 'another-partition'], ['sessionId', 'another-session'], ['generation', 2], ['state', 'deleted'], ['enabled', false] ] as const) {
    const f = historyFixture(1, `wire-isolated-${change[0]}`), codec = realCodec(f), reader = new RemoteSessionReader(codec.repository, { ...bounds, scope, pins: l.pins });
    await reader.read(f.sessionId); const w = historyWatermark(reader.scopeId, f.manifest.entity);
    codec.change('headerHash', 'malformed'); codec.change(change[0], change[1]); await assert.rejects(reader.auditControl(f.sessionId)); assert.equal(l.pins.health(w).failure, undefined);
    codec.reset(); assert.equal((await reader.read(f.sessionId))?.events.length, 1); await reader.close();
  }
});
test('P1 missing accepted manifest is quarantined, unknown absence and wrong expected scope/generation are not', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1), codec = realCodec(f), reader = new RemoteSessionReader(codec.repository, { ...bounds, scope, pins: l.pins }); t.after(() => reader.close());
  await reader.read(f.sessionId); const w = historyWatermark(reader.scopeId, f.manifest.entity); codec.missing();
  await assert.rejects(reader.auditControl(f.sessionId, { expectedGeneration: 2 }), code('NOT_FOUND')); assert.equal(l.pins.health(w).failure, undefined);
  await assert.rejects(reader.auditControl(f.sessionId, { expectedScope: 'f'.repeat(64) }), code('NOT_FOUND')); assert.equal(l.pins.health(w).failure, undefined);
  await assert.rejects(reader.auditControl(f.sessionId, { expectedGeneration: 1 }), code('NOT_FOUND')); assert.equal(l.pins.health(w).failure, 'corrupt-remote');
  codec.reset(); await assert.rejects(reader.read(f.sessionId), code('CORRUPT_REMOTE')); await reader.audit(f.sessionId); assert.equal((await reader.read(f.sessionId))?.events.length, 1);
  const unknown = historyFixture(1, 'never-accepted'), missing = realCodec(unknown), fresh = new RemoteSessionReader(missing.repository, { ...bounds, scope, pins: l.pins }); t.after(() => fresh.close()); missing.missing();
  assert.equal(await fresh.auditControl(unknown.sessionId), undefined); assert.equal(await fresh.audit(unknown.sessionId), undefined);
  assert.equal(l.pins.health(historyWatermark(fresh.scopeId, unknown.manifest.entity)).failure, undefined);
});
test('P1 auditControl is fresh copied control only and cannot admit H or clear health', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1), codec = realCodec(f), reader = new RemoteSessionReader(codec.repository, { ...bounds, scope, pins: l.pins }); t.after(() => reader.close());
  const result = await reader.auditControl(f.sessionId); assert.ok(result); result.entity.headerHash = 'e'.repeat(64);
  const w = historyWatermark(reader.scopeId, f.manifest.entity); assert.equal(l.pins.get(w), undefined); assert.equal(f.calls.blob, 0); assert.equal(codec.calls.row, 0);
  assert.equal((await reader.auditControl(f.sessionId))?.entity.headerHash, w.headerHash); await l.pins.failHealth(w, 'corrupt-remote', () => {}); const health = l.pins.health(w);
  assert.ok(await reader.auditControl(f.sessionId)); assert.deepEqual(l.pins.health(w), health); assert.equal(l.pins.get(w), undefined); assert.equal(f.calls.blob, 0); assert.equal(codec.calls.row, 0);
});
test('P1 eligibility and a different generation cannot poison the accepted generation health', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins });
  await reader.read(f.sessionId); const good = structuredClone(f.manifest), w = historyWatermark(reader.scopeId, good.entity);
  f.manifest.entity.headerJson = '{'; await assert.rejects(reader.audit(f.sessionId, { expectedGeneration: 2 }), code('GENERATION_CHANGED'));
  assert.equal(l.pins.health(w).failure, undefined);
  f.manifest = { ...good, entity: { ...good.entity, generation: 2, rootGeneration: 2, headerJson: '{' } };
  await assert.rejects(reader.audit(f.sessionId, { expectedGeneration: 2 })); assert.equal(l.pins.health(w).failure, undefined);
  f.manifest = good; assert.equal((await reader.read(f.sessionId))?.events.length, 1); await reader.close();
});
test('P2 H acceptance rechecks exact ancestry of a concurrently accepted branch inside its lane', async t => {
  const l = await local(); t.after(() => l.close()); const candidate = historyFixture(2), other = historyFixture(1, candidate.sessionId); fork(other);
  const entered = deferred(), resume = deferred(); const original = l.pins.accept.bind(l.pins); let paused = false;
  l.pins.accept = async (w, check) => { if (!paused && w.eventCount === 2) { paused = true; entered.resolve(); await resume.promise; } return original(w, check); };
  const a = new RemoteSessionReader(candidate.repository, { ...bounds, scope, pins: l.pins }), b = new RemoteSessionReader(other.repository, { ...bounds, scope, pins: l.pins });
  t.after(async () => { resume.resolve(); await a.close(); await b.close(); });
  const pending = a.read(candidate.sessionId); await entered.promise; await b.audit(other.sessionId); resume.resolve();
  await assert.rejects(pending, code('CONFLICT'));
  const accepted = l.pins.get(historyWatermark(a.scopeId, candidate.manifest.entity))!; assert.equal(accepted.eventCount, 1); assert.equal(accepted.chainHash, other.manifest.entity.chainHash);
});
test('P2 a valid concurrent accepted prefix is extended without a false fork', async t => {
  const l = await local(); t.after(() => l.close()); const candidate = historyFixture(2), lower = historyFixture(1, candidate.sessionId);
  const entered = deferred(), resume = deferred(); const original = l.pins.accept.bind(l.pins); let paused = false;
  l.pins.accept = async (w, check) => { if (!paused && w.eventCount === 2) { paused = true; entered.resolve(); await resume.promise; } return original(w, check); };
  const a = new RemoteSessionReader(candidate.repository, { ...bounds, scope, pins: l.pins }), b = new RemoteSessionReader(lower.repository, { ...bounds, scope, pins: l.pins });
  t.after(async () => { resume.resolve(); await a.close(); await b.close(); });
  const pending = a.read(candidate.sessionId); await entered.promise; await b.audit(lower.sessionId); resume.resolve(); assert.equal((await pending)?.events.length, 2);
});
test('P2 post-put H guard revocation restores its exact previous floor or absence', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(2), full = historyWatermark(historyScopeId(scope), f.manifest.entity), lower = historyWatermark(historyScopeId(scope), historyFixture(1, f.sessionId).manifest.entity);
  await l.pins.accept(lower); let afterPut = false;
  await assert.rejects(l.pins.accept(full, () => { if (l.pins.get(full)?.eventCount === 2) { afterPut = true; throw new AzureSyncError('CANCELLED', 'Revoked after put.'); } }), code('CANCELLED'));
  assert.equal(afterPut, true); assert.deepEqual(l.pins.get(full), lower);
  const absent = historyWatermark(historyScopeId(scope), historyFixture(1, 'formerly-absent').manifest.entity);
  await assert.rejects(l.pins.accept(absent, () => { if (l.pins.get(absent)) throw new AzureSyncError('CANCELLED', 'Revoked initial put.'); }), code('CANCELLED')); assert.equal(l.pins.get(absent), undefined);
  await l.pins.accept(full); assert.deepEqual(l.pins.get(full), full, 'a later independently valid acceptance is not erased');
});
test('P2 post-put health-clear revocation restores failure at a newer revision, never ABA', async t => {
  const l = await local(); t.after(() => l.close()); const w = historyWatermark(historyScopeId(scope), historyFixture(1).manifest.entity);
  await l.pins.failHealth(w, 'corrupt-remote', () => {}); const failed = l.pins.health(w); let clearedVisible = false;
  await assert.rejects(l.pins.clearHealth(w, failed.revision, () => { if (l.pins.health(w).failure === undefined) { clearedVisible = true; throw new AzureSyncError('CANCELLED', 'Revoked health clear.'); } }), code('CANCELLED'));
  const restored = l.pins.health(w); assert.equal(clearedVisible, true); assert.equal(restored.failure, failed.failure); assert.ok(restored.revision > failed.revision + 1);
  assert.equal(await l.pins.clearHealth(w, failed.revision, () => {}), false); assert.equal(l.pins.health(w).failure, failed.failure);
  assert.equal(await l.pins.clearHealth(w, restored.revision, () => {}), true);
});
test('P2 initial read and observe metadata snapshots retry when H advances during the first control wait', async t => {
  const l = await local(); t.after(() => l.close());
  for (const method of ['read', 'observe'] as const) {
    const f = historyFixture(2, `first-control-${method}`), full = structuredClone(f.manifest), tip = f.rows[0]!;
    const lower = { ...full, entity: { ...full.entity, eventCount: 1, headSeq: 0, headHash: tip.headHash, chainHash: tip.chainHash, batchCount: 1, lastBatchRowKey: tip.rowKey, lastBatchBlobName: tip.blobName } }; f.manifest = lower;
    const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }), auditor = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }); await reader.read(f.sessionId);
    const captured = deferred(), release = deferred(), original = f.repository.getManifest.bind(f.repository); let pause = true;
    f.repository.getManifest = async (...args) => { const value = await original(...args); if (pause) { pause = false; captured.resolve(); await release.promise; } return value; };
    const pending = reader[method](f.sessionId); await captured.promise; f.manifest = full; await auditor.audit(f.sessionId); const blobs = f.calls.blob, rows = f.calls.row; release.resolve();
    const result = await pending; assert.equal(result?.manifest.entity.eventCount, 2);
    assert.equal(f.calls.blob, blobs + (method === 'read' ? 1 : 0)); assert.equal(f.calls.row, rows + (method === 'read' ? 1 : 0));
    f.manifest = lower; const manifests = f.calls.manifest; await assert.rejects(reader[method](f.sessionId), code('CONFLICT')); assert.equal(f.calls.manifest, manifests + 1, 'a stable fresh rollback is not retried as movement');
    await reader.close(); await auditor.close();
  }
});
test('P2 a binding change during an absent control wait is refused without poisoning either generation', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1), reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }); t.after(() => reader.close());
  await reader.read(f.sessionId); const old = historyWatermark(reader.scopeId, f.manifest.entity), empty = { ...old, generation: 2, rootGeneration: 2, eventCount: 0, headSeq: -1, batchCount: 0 };
  empty.headHash = empty.chainHash = genesisHash(f.sessionId, 2, old.headerHash); delete empty.lastBatchRowKey; delete empty.lastBatchGeneration; delete empty.lastBatchBlobName; f.clearManifest();
  const captured = deferred(), release = deferred(), original = f.repository.getManifest.bind(f.repository); let pause = true;
  f.repository.getManifest = async (...args) => { const value = await original(...args); if (pause) { pause = false; captured.resolve(); await release.promise; } return value; };
  const pending = reader.auditControl(f.sessionId); await captured.promise; await l.pins.activateGeneration(old, empty, () => {}); release.resolve(); await assert.rejects(pending, code('GENERATION_CHANGED'));
  assert.equal(l.pins.health(old).failure, undefined); assert.equal(l.pins.health(empty).failure, undefined);
});
test('P2 an initially absent captured response cannot poison a newly accepted healthy manifest', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1), full = structuredClone(f.manifest); f.clearManifest();
  const reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }), auditor = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }); t.after(() => Promise.all([reader.close(), auditor.close()]));
  const captured = deferred(), release = deferred(), original = f.repository.getManifest.bind(f.repository); let pause = true;
  f.repository.getManifest = async (...args) => { const value = await original(...args); if (pause) { pause = false; captured.resolve(); await release.promise; } return value; };
  const pending = reader.auditControl(f.sessionId); await captured.promise; f.manifest = full; await auditor.audit(f.sessionId); const downloads = f.calls.blob; release.resolve();
  assert.equal((await pending)?.entity.eventCount, 1); assert.equal(f.calls.blob, downloads); assert.equal(l.pins.health(historyWatermark(reader.scopeId, full.entity)).failure, undefined);
});
test('P2 a newer legitimate accepted tip makes an older in-flight read retry, not terminalize', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(3), full = structuredClone(f.manifest), tip = f.rows[1]!;
  f.manifest = { ...full, entity: { ...full.entity, eventCount: 2, headSeq: 1, headHash: tip.headHash, chainHash: tip.chainHash, batchCount: 2, lastBatchRowKey: tip.rowKey, lastBatchBlobName: tip.blobName } };
  const entered = deferred(), resume = deferred(); const original = l.pins.accept.bind(l.pins); let paused = false;
  l.pins.accept = async (w, check) => { if (!paused && w.eventCount === 2) { paused = true; entered.resolve(); await resume.promise; } return original(w, check); };
  const older = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }), newer = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins });
  t.after(async () => { resume.resolve(); await older.close(); await newer.close(); });
  const pending = older.read(f.sessionId); await entered.promise; f.manifest = full; await newer.audit(f.sessionId); resume.resolve(); assert.equal((await pending)?.events.length, 3);
});
test('P2 a provisional health clear cannot let another cached reader or observation escape compensation', async t => {
  const l = await local(); t.after(() => l.close()); const f = historyFixture(1), reader = new RemoteSessionReader(f.repository, { ...bounds, scope, pins: l.pins }); t.after(() => reader.close());
  await reader.read(f.sessionId); const w = historyWatermark(reader.scopeId, f.manifest.entity); await l.pins.failHealth(w, 'corrupt-remote', () => {});
  const entered = deferred(), release = deferred(); let paused = false;
  const clear = l.pins.clearHealth(w, l.pins.health(w).revision, async () => { if (!paused && l.pins.health(w).failure === undefined) { paused = true; entered.resolve(); await release.promise; throw new AzureSyncError('CANCELLED', 'Revoked clear.'); } });
  await entered.promise;
  let served = false; const read = reader.read(f.sessionId).then(value => { served = true; return value; }); const observe = reader.observe(f.sessionId);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(served, false); release.resolve();
  await assert.rejects(clear, code('CANCELLED')); await assert.rejects(read, code('CORRUPT_REMOTE')); await assert.rejects(observe, code('CORRUPT_REMOTE'));
});
test('P2 aggregate retained owners cannot alternate full-history downloads under a one-prefix disk budget', async t => {
  const l = await local(); t.after(() => l.close()); const a = historyFixture(1, 'active-a'), b = historyFixture(1, 'active-b'), fixtures = [a, b];
  const repository = { partitionKey: 'account', getManifest: async (sid: string) => fixtures.find(f => f.sessionId === sid)?.repository.getManifest(sid),
    getBatch: async (key: string) => fixtures.find(f => f.rows.some(row => row.rowKey === key))?.repository.getBatch(key),
    readCandidate: async (name: string, bound: number, context: Parameters<CloudRepository['readCandidate']>[2]) => fixtures.find(f => f.blobs.has(name))!.repository.readCandidate(name, bound, context),
  } as CloudRepository;
  const budget = Math.max(...fixtures.map(f => [...f.blobs.values()][0]!.length)) + 10;
  const reader = new RemoteSessionReader(repository, { ...bounds, scope, pins: l.pins, cache: { directory: join(l.root, 'cache'), memoryBytes: 0, diskBytes: budget } }); t.after(() => reader.close());
  const heldA = reader.retain(a.sessionId, { expectedGeneration: 1 }), heldB = reader.retain(b.sessionId, { expectedGeneration: 1 });
  assert.equal(a.calls.blob + b.calls.blob, 0, 'retention enrollment starts no IO'); await reader.read(a.sessionId);
  await assert.rejects(reader.read(b.sessionId), code('LIMIT')); const downloads = b.calls.blob; assert.equal(downloads, 1);
  for (let i = 0; i < 3; i += 1) { await assert.rejects(reader.read(b.sessionId), code('LIMIT')); await reader.observe(a.sessionId); await reader.observe(b.sessionId); await reader.read(a.sessionId); }
  assert.equal(a.calls.blob, 1); assert.equal(b.calls.blob, downloads, 'failed implicit-owner release does not reset aggregate pressure');
  const handoffA = reader.retain(a.sessionId, { expectedGeneration: 1 }); heldA.release(); await assert.rejects(reader.read(b.sessionId), code('LIMIT')); assert.equal(b.calls.blob, downloads);
  handoffA.release(); assert.equal((await reader.read(b.sessionId))?.events.length, 1); assert.equal(b.calls.blob, downloads + 1); heldB.release(); heldB.release();
});
test('P2 canceling one pending reservation owner cannot release a valid second owner capacity', async () => {
  const pool = new HistoryRetentionPool(180, 0), runtime = new AbortController();
  const a = new HistoryOwner({}, runtime.signal), b = new HistoryOwner({}, runtime.signal), c = new HistoryOwner({}, runtime.signal);
  const w = historyWatermark(historyScopeId(scope), historyFixture(1, 'shared').manifest.entity), other = historyWatermark(historyScopeId(scope), historyFixture(1, 'other').manifest.entity);
  const held = pool.enroll(w.sessionId, a); held.bind(w);
  const first = pool.enroll(w.sessionId, a), second = pool.enroll(w.sessionId, b), third = pool.enroll(other.sessionId, c); first.bind(w); second.bind(w); third.bind(other);
  const one = await pool.reserve({ watermark: w, memory: 126, disk: 126 }, a), two = await pool.reserve({ watermark: w, memory: 126, disk: 126 }, b); assert.equal(one, two);
  pool.rollback(one, a); first.release(); await assert.rejects(pool.reserve({ watermark: other, memory: 126, disk: 126 }, c), code('LIMIT'));
  pool.commit(two); pool.rollback(two, b); second.release(); await assert.rejects(pool.reserve({ watermark: other, memory: 126, disk: 126 }, c), code('LIMIT'));
  held.release(); await pool.reserve({ watermark: other, memory: 126, disk: 126 }, c); third.release();
});
test('P2 retained guard revocation and runtime close release residency without unbounded guard waits', { timeout: 3000 }, async t => {
  const f = historyFixture(1); const reader = new RemoteSessionReader(f.repository, { ...bounds, scope }); t.after(() => reader.close());
  const hung = deferred(), entered = deferred(); const retained = reader.retain(f.sessionId, { check: async () => { entered.resolve(); await hung.promise; } });
  const cancel = new AbortController(), pending = reader.read(f.sessionId, { signal: cancel.signal }); await entered.promise; cancel.abort(); await assert.rejects(pending, code('CANCELLED'));
  await reader.close(); retained.release(); hung.resolve();
});
test('P2 namespace path swaps cannot redirect body reads/writes or chmod an outside directory', async t => {
  const l = await local(); t.after(() => l.close()); const cache = join(l.root, 'cache'), namespace = 'a'.repeat(64), outside = join(l.root, 'outside'), moved = join(l.root, 'moved');
  await mkdir(cache, { mode: 0o700 }); await mkdir(join(cache, namespace), { mode: 0o700 }); await mkdir(outside, { mode: 0o755 }); await chmod(outside, 0o755);
  await writeFile(join(cache, namespace, 'object.gz'), 'inside', { mode: 0o600 }); await writeFile(join(outside, 'object.gz'), 'outside-must-not-be-read', { mode: 0o600 });
  const runtime = new AbortController(), ordinary = new HistoryOwner({}, runtime.signal), root = await HistoryDirectory.root(cache, ordinary), directory = await root.directory(namespace, ordinary);
  let swapped = false; const delayed = new HistoryOwner({ check: async () => { if (!swapped) { swapped = true; await rename(join(cache, namespace), moved); await symlink(outside, join(cache, namespace)); } } }, runtime.signal);
  try {
    assert.equal((await directory.read('object.gz', 1024, delayed)).toString(), 'inside');
    await directory.atomic('object.gz', Buffer.from('updated-inside'), ordinary);
    assert.equal(await readFile(join(outside, 'object.gz'), 'utf8'), 'outside-must-not-be-read'); assert.equal((await stat(outside)).mode & 0o777, 0o755);
    assert.equal(await readFile(join(moved, 'object.gz'), 'utf8'), 'updated-inside'); await assert.rejects(root.directory(namespace, ordinary));
  } finally { await directory.close(); await root.close(); }
});
test('P2 unsafe existing private directory permissions are refused, never repaired by following chmod', async t => {
  const l = await local(); t.after(() => l.close()); const unsafe = join(l.root, 'unsafe'); await mkdir(unsafe, { mode: 0o755 }); await chmod(unsafe, 0o755);
  await assert.rejects(HistoryDirectory.root(unsafe, new HistoryOwner({}, new AbortController().signal)), code('INVALID_CONFIG')); assert.equal((await stat(unsafe)).mode & 0o777, 0o755);
});
