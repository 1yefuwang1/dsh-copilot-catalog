import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { LocalStore } from '../src/local/store.js';
import { encodeCloudRecord, type BatchRow, type LocalSessionRecord } from '../src/schema.js';
import { TableStore } from '../src/azure/table.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { TableClient } from '@azure/data-tables';
import { AzureSyncError } from '../src/azure/errors.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { candidateBlobName, CloudRepository, type StoredManifest } from '../src/sync/cloud-repository.js';
import type { ImportService } from '../src/sync/import-service.js';
import { RemoteSessionReader, type HistoryReadContext } from '../src/sync/remote-session.js';
import { SyncService } from '../src/sync/service.js';
import type { SessionSource } from '../src/sync/session-source.js';
import type { Uploader } from '../src/sync/uploader.js';
import type { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { batchRow, cloudSession, event, localSession, sessionHeader } from './helpers.js';
import { fixtureHistoryScope, trackRetentions } from './runtime-history-fixture.js';
import { historyFixture } from './history-fixture.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function wireFixture(count: number, sessionId: string) {
  const history = historyFixture(count, sessionId), manifestKey = history.manifest.entity.rowKey;
  const rows = new Map<string, Record<string, unknown>>([[manifestKey, { ...encodeCloudRecord(history.manifest.entity), etag: 'wire-1' }],
    ...history.rows.map(row => [row.rowKey, { ...encodeCloudRecord(row), etag: 'batch-1' }] as [string, Record<string, unknown>])]);
  let beforeResponse: ((key: string, captured: Record<string, unknown>) => Promise<void>) | undefined, payloadReads = 0;
  const table = new TableStore({ async getEntity(_partition: string, key: string) {
    const row = rows.get(key); if (!row) throw { statusCode: 404 };
    const captured = structuredClone(row); await beforeResponse?.(key, captured); return captured;
  } } as unknown as TableClient);
  const blob = { async read(name: string, maxBytes: number, context?: HistoryReadContext) {
    await context?.check?.(); payloadReads++;
    const bytes = history.blobs.get(name); if (!bytes) throw new AzureSyncError('NOT_FOUND', 'Missing selected payload.');
    if (bytes.length > maxBytes) throw new AzureSyncError('LIMIT', 'Selected payload exceeds its bound.');
    await context?.check?.(); return Buffer.from(bytes);
  } } as unknown as BlobStore;
  const repository = new CloudRepository(blob, table);
  const reader = new RemoteSessionReader(repository, { scope: fixtureHistoryScope, maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
  return { history, rows, manifestKey, repository, reader, payloadReads: () => payloadReads,
    delay(hook: typeof beforeResponse) { beforeResponse = hook; } };
}

function fixture(options: { remoteCount?: number; localCount?: number; appliedCount?: number; live?: boolean; statWithoutCount?: boolean; memoryBytes?: number } = {}) {
  const id = 'runtime-history';
  const remoteCount = options.remoteCount ?? 100;
  const header = sessionHeader({ id });
  const events = Array.from({ length: Math.max(remoteCount, options.localCount ?? remoteCount) }, (_, n) => event(n));
  const binding = headerHash(header, 0), genesis = genesisHash(id, 1, binding);
  const chain = chainEvents(genesis, events.slice(0, remoteCount));
  const blobName = candidateBlobName(id, 1, 0, 1, chain.payloadHash);
  const row = batchRow(id, 1, 0, { ...chain, endSeq: remoteCount - 1, eventCount: remoteCount, blobName });
  let manifest: StoredManifest = { entity: cloudSession({ sessionId: id, headerHash: binding, eventCount: remoteCount,
    headSeq: remoteCount - 1, headHash: chain.headHash, chainHash: chain.chainHash, lastBatchRowKey: row.rowKey,
    lastBatchGeneration: 1, lastBatchBlobName: blobName }), etag: 'etag-current' };
  const appliedCount = options.appliedCount ?? remoteCount;
  let record = localSession({ sessionId: id, lastSyncedAt: 17, lastSyncedEventCount: appliedCount,
    lastSyncedChainHash: chainEvents(genesis, events.slice(0, appliedCount)).chainHash, lastSyncedHeaderHash: binding });
  let localCount = options.localCount ?? appliedCount, live = options.live ?? false;
  let controls = 0, points = 0, payloads = 0, localReads = 0, stats = 0, uploads = 0, catches = 0, proofs = 0;
  let beforePayload: ((context?: HistoryReadContext) => Promise<void>) | undefined;
  let corrupt = false;
  const repository = { partitionKey: 'account',
    async getManifest() { controls++; return structuredClone(manifest); },
    async getBatch(key: string) { points++; assert.equal(key, row.rowKey); return structuredClone(row); },
    async readCandidate(_name: string, _limit: number, context?: HistoryReadContext) {
      payloads++; await beforePayload?.(context);
      if (corrupt) throw new AzureSyncError('CORRUPT_REMOTE', 'Synthetic missing committed object.');
      return gzipSync(payloadBytes(events.slice(0, remoteCount)));
    },
    async listBatchRows(): Promise<BatchRow[]> { assert.fail('ordinary verification must point-walk'); },
  } as unknown as CloudRepository;
  const local = { getSession: () => record, listSessions: () => new Map([[id, record]]).entries(),
    async transactSession(_id: string, fn: Parameters<LocalStore['transactSession']>[1]) { const next = fn(record); if (next) record = next; return next; },
  } as unknown as LocalStore;
  const snapshot = () => ({ header: header as never, inheritedEventCount: 0, events: events.slice(0, localCount) as never });
  const source: SessionSource = { async flush() {}, async stat() { stats++; return { header: header as never, ...(options.statWithoutCount ? {} : { eventCount: localCount }) }; },
    async read() { localReads++; return snapshot(); } };
  const readerOptions = { scope: fixtureHistoryScope, maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576,
    cache: { memoryBytes: options.memoryBytes ?? 1_048_576, diskBytes: 0 } };
  const reader = new RemoteSessionReader(repository, readerOptions);
  // This fixture explicitly models an already-consented enabled account.
  record = { ...record, publicationScope: reader.scopeId };
  const finished = deferred<void>();
  const uploader = { async snapshotForReconciliation() { return snapshot(); }, async pause() {}, async close() {}, suspend() {},
    hasHeld: () => false, noteActivity() {}, noteFlushed() {},
    async ensureOwnership() { proofs++; return { owned: true }; },
    async sync() { uploads++; finished.resolve(); return { status: 'synced', eventCount: localCount, uploadedBatches: 1 }; },
    async disable() { record = { ...record, enabled: false, detached: true, state: 'disabled', status: 'detached' }; },
  } as unknown as Uploader;
  const imports = { async catchUp(_id: string, remote: Awaited<ReturnType<RemoteSessionReader['read']>>, context: { signal: AbortSignal; isLive: () => boolean }) {
    context.signal.throwIfAborted(); assert.equal(context.isLive(), false); assert.ok(remote); catches++;
    localCount = remote.events.length;
    record = { ...record, lastSyncedAt: 29, lastSyncedEventCount: localCount, lastSyncedChainHash: remote.manifest.entity.chainHash,
      lastSyncedHeaderHash: remote.manifest.entity.headerHash, catchUpPending: false, status: 'synced' };
    finished.resolve();
  } } as unknown as ImportService;
  const tombstones = { async remove() { assert.fail('this observation fixture must not perform destructive recovery'); },
    async resurrect() { assert.fail('this observation fixture must not activate a cloud generation'); } } as unknown as TombstoneManager;
  const buildService = (history: RemoteSessionReader) => new SyncService({ uploader, reader: history, repository, source, imports, local, tombstones, ownershipProofMs: 5_000,
    agents: { get: () => live ? {} as never : undefined }, now: () => 31 });
  const service = buildService(reader);
  return { id, service, reader, finished, record: () => record, setRecord: (patch: Partial<LocalSessionRecord>) => { record = { ...record, ...patch }; },
    setLocalCount: (count: number) => { localCount = count; }, setLive: (value: boolean) => { live = value; },
    changeManifest: (patch: Partial<StoredManifest['entity']>) => { manifest = { entity: { ...manifest.entity, ...patch }, etag: 'etag-new' }; },
    delayPayload: (hook: typeof beforePayload) => { beforePayload = hook; }, corrupt: () => { corrupt = true; }, restore: () => { corrupt = false; },
    replacement: (scope = fixtureHistoryScope) => { const replacementReader = new RemoteSessionReader(repository, { ...readerOptions, scope }); return { reader: replacementReader, service: buildService(replacementReader) }; },
    counts: () => ({ controls, points, payloads, localReads, stats, uploads, catches, proofs }),
    async close() { await service.close(100); await reader.close(); },
  };
}

test('public service audit quarantines strict raw Table decode failures before any local record or payload path', async () => {
  for (const fault of ['headerHash', 'cut', 'semantic-cut'] as const) {
    const f = wireFixture(2, `audit-wire-${fault}`);
    const local = { getSession: () => undefined, async transactSession() { assert.fail('untracked read-only audit must not create local consent or Native state'); } } as unknown as LocalStore;
    const uploader = { async close() {} } as unknown as Uploader;
    const service = new SyncService({ local, uploader, repository: f.repository, reader: f.reader });
    try {
      await f.reader.read(f.history.sessionId); const valid = structuredClone(f.rows.get(f.manifestKey)!);
      f.rows.set(f.manifestKey, { ...valid, ...(fault === 'headerHash' ? { headerHash: 'not-a-canonical-digest' }
        : { inheritedEventCount: { type: 'Int64', value: fault === 'cut' ? '-1' : '1' } }) });
      const reads = f.payloadReads();
      await assert.rejects(service.verifyCloudCopy(f.history.sessionId));
      assert.equal(f.payloadReads(), reads, 'decode/semantic rejection must occur in the audited control precheck');
      f.rows.set(f.manifestKey, valid);
      await f.reader.auditControl(f.history.sessionId, {}); // Control validation alone never clears known damage.
      await assert.rejects(f.reader.read(f.history.sessionId), error => error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE');
      await assert.rejects(f.reader.observe(f.history.sessionId), error => error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE');
      assert.equal(f.payloadReads(), reads, 'warm canonical data cannot hide failed raw audit health');
      const audit = await service.verifyCloudCopy(f.history.sessionId);
      assert.equal(audit.watermark.eventCount, 2); assert.equal(audit.current, true);
      assert.equal(f.payloadReads(), reads + 2, 'only a successful full raw chain/object audit clears the refusal');
      assert.equal((await f.reader.read(f.history.sessionId))?.events.length, 2);
    } finally { await service.close(100); await f.reader.close(); }
  }
});

test('service retries an old captured control response when an independent raw audit advances accepted H', async () => {
  for (const mode of ['reconcile', 'observe'] as const) {
    const f = wireFixture(1, `moving-service-${mode}`), id = f.history.sessionId;
    await f.reader.read(id);
    const initial = (await f.repository.getManifest(id))!;
    let record = localSession({ sessionId: id, publicationScope: f.reader.scopeId, lastSyncedAt: 1,
      lastSyncedEventCount: 1, lastSyncedChainHash: initial.entity.chainHash, lastSyncedHeaderHash: initial.entity.headerHash });
    const localEvents = f.history.events.slice(), snapshot = { header: f.history.header as never, inheritedEventCount: 0, events: localEvents as never };
    const local = { getSession: () => record, listSessions: () => new Map([[id, record]]).entries(),
      async transactSession(_id: string, change: Parameters<LocalStore['transactSession']>[1]) { const next = change(record); if (next) record = next; return next; } } as unknown as LocalStore;
    let uploads = 0, leases = 0;
    const uploader = { async snapshotForReconciliation() { return snapshot; }, async pause() {}, async close() {},
      async sync() { uploads++; assert.fail('remote advance must not publish a local suffix'); },
      async ensureOwnership() { leases++; assert.fail('reconciliation/audit cannot grant or acquire execution ownership'); } } as unknown as Uploader;
    const source = { async flush() {}, async read() { return snapshot; }, async stat() { return { header: snapshot.header, eventCount: 1 }; } };
    const service = new SyncService({ uploader, local, source, reader: f.reader, repository: f.repository, agents: { get: () => ({} as never) } });
    const captured = deferred<void>(), release = deferred<void>(); let first = true;
    f.delay(async key => { if (first && key === f.manifestKey) { first = false; captured.resolve(); await release.promise; } });
    const work = mode === 'reconcile' ? service.reconcile(id) : service.refreshAll();
    void work.catch(() => undefined);
    try {
      await captured.promise;
      const advanced = historyFixture(2, id);
      for (const row of advanced.rows) { f.rows.set(row.rowKey, { ...encodeCloudRecord(row), etag: 'batch-2' }); f.history.blobs.set(row.blobName, advanced.blobs.get(row.blobName)!); }
      f.rows.set(f.manifestKey, { ...encodeCloudRecord(advanced.manifest.entity), etag: 'wire-2' });
      await f.reader.audit(id); const reads = f.payloadReads();
      release.resolve(); const decision = await work;
      if (mode === 'reconcile') assert.equal((decision as { kind?: string })?.kind, 'remote-ahead');
      else await service.waitForHistoryWork(id);
      assert.equal(record.status, 'remote-ahead-live'); assert.equal(record.enabled, true); assert.equal(record.generation, 1);
      assert.equal(record.lastSyncedEventCount, 1, 'independent audit advances only H, never local application L');
      assert.equal((await f.reader.observe(id))?.acceptedPin?.eventCount, 2);
      assert.equal(f.payloadReads(), reads, 'the retried consumer reuses fully verified bytes instead of downloading old batches again');
      assert.equal(uploads, 0); assert.equal(leases, 0);
    } finally { release.resolve(); await work.catch(() => undefined); await service.close(100); await f.reader.close(); }
  }
});

test('known account mismatch refuses explicit destructive recovery and preserves local status before observing foreign stops', async () => {
  for (const stop of ['deleted', 'root-disabled'] as const) {
    const f = fixture(), other = f.replacement({ ...fixtureHistoryScope, container: 'other-fixture' });
    const before = structuredClone(f.record()); let observations = 0;
    if (stop === 'deleted') f.changeManifest({ state: 'deleted', enabled: false });
    const observe = other.reader.observe.bind(other.reader);
    other.reader.observe = async (...args) => { observations++; if (stop === 'root-disabled') throw new AzureSyncError('DISABLED', 'Foreign root disabled.'); return observe(...args); };
    try {
      for (const effect of [() => other.service.removeFromCloud(f.id), () => other.service.resurrectInCloud(f.id), () => other.service.repairSession(f.id)]) {
        await assert.rejects(effect(), error => error instanceof AzureSyncError && error.code === 'OWNERSHIP_UNVERIFIED');
      }
      await other.service.refreshAll();
      assert.equal(observations, 0); assert.equal(f.counts().controls, 0); assert.equal(f.counts().payloads, 0);
      const current = { ...f.record() }, expected = { ...before }; delete current.lastError; delete expected.lastError;
      assert.deepEqual(current, expected, 'foreign stop metadata must not disable, adopt, or rewrite Native account state');
      assert.match(f.record().lastError ?? '', /Explicitly Sync/);
    } finally { await other.service.close(100); await other.reader.close(); await f.close(); }
  }
});

test('a healthy audit in another actual namespace never clears a tracked or legacy-origin health marker', async () => {
  for (const legacy of [false, true]) {
    const f = fixture();
    if (legacy) f.setRecord({ publicationScope: undefined });
    const other = f.replacement({ ...fixtureHistoryScope, container: 'other-fixture' });
    try {
      f.corrupt(); await assert.rejects(f.service.verifyCloudCopy(f.id));
      assert.equal(f.record().remoteAuditFailure, 'corrupt-remote'); assert.equal(f.record().remoteAuditScope, f.reader.scopeId);
      f.restore(); const before = f.counts().payloads;
      await assert.rejects(other.service.verifyCloudCopy(f.id), error => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
      assert.equal(f.counts().payloads, before); assert.equal(f.record().remoteAuditScope, f.reader.scopeId);
      assert.equal(f.record().remoteAuditFailure, 'corrupt-remote');
      await f.service.verifyCloudCopy(f.id);
      assert.equal(f.record().remoteAuditFailure, undefined); assert.equal(f.record().remoteAuditScope, undefined);
      assert.equal(f.record().publicationScope, legacy ? undefined : f.reader.scopeId); assert.equal(f.record().lastSyncedAt, 17);
    } finally { await other.service.close(100); await other.reader.close(); await f.close(); }
  }
});

test('loss of required H cannot turn a retained scoped applied floor into a rollback suffix upload or successful audit', async () => {
  for (const change of ['shorter', 'same-count-fork', 'header'] as const) {
    const f = fixture({ remoteCount: change === 'shorter' ? 50 : 100, localCount: 100, appliedCount: 100 });
    try {
      if (change === 'same-count-fork') f.changeManifest({ chainHash: 'f'.repeat(64) });
      if (change === 'header') f.setRecord({ lastSyncedHeaderHash: 'e'.repeat(64) });
      assert.equal((await f.reader.observe(f.id))?.acceptedPin, undefined, 'simulate a genuinely lost pin domain/new canonical component');
      await f.service.refreshAll();
      assert.equal(f.record().status, 'conflict'); assert.equal(f.counts().payloads, 0); assert.equal(f.counts().points, 0);
      assert.equal(f.counts().uploads, 0); assert.equal(f.counts().catches, 0);
      await assert.rejects(f.service.verifyCloudCopy(f.id), error => error instanceof AzureSyncError && error.code === 'CONFLICT');
      assert.equal((await f.reader.observe(f.id))?.acceptedPin, undefined, 'rejection must precede canonical H admission');
      assert.equal(f.record().lastSyncedEventCount, 100); assert.equal(f.record().lastSyncedAt, 17);
    } finally { await f.close(); }
  }
});

test('persisted audit failure fences a replacement runtime even when its canonical byte cache is healthy', async () => {
  const f = fixture(), replacement = f.replacement();
  try {
    await replacement.reader.read(f.id); // A healthy retained prefix may outlive actual remote object health.
    f.corrupt(); await assert.rejects(f.service.verifyCloudCopy(f.id));
    assert.equal(f.record().remoteAuditFailure, 'corrupt-remote');
    const before = f.counts();
    await assert.rejects(replacement.service.reconcile(f.id));
    await assert.rejects(replacement.service.sync(f.id));
    assert.deepEqual(await replacement.service.ensureOwnership(f.id), { owned: false, reason: 'ownership-unverified' });
    assert.equal(f.counts().payloads, before.payloads); assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0);
    f.restore();
    await replacement.service.verifyCloudCopy(f.id);
    assert.equal(f.record().remoteAuditFailure, undefined); assert.equal(f.record().status, 'retrying');
    assert.equal(f.record().lastSyncedAt, 17); assert.equal(f.record().lastSyncedEventCount, 100); assert.equal(f.counts().proofs, 0);
  } finally { await replacement.service.close(100); await replacement.reader.close(); await f.close(); }
});

test('bypass audit clears only its remote-health marker, never protected conflict/degraded/import blocks', async () => {
  for (const status of ['conflict', 'attachment-unsupported', 'import-incomplete'] as const) {
    const f = fixture(); f.setRecord({ status, lastError: 'Keep the existing protected recovery evidence.' });
    try {
      f.corrupt(); await assert.rejects(f.service.verifyCloudCopy(f.id));
      assert.equal(f.record().status, status); assert.equal(f.record().remoteAuditFailure, 'corrupt-remote');
      assert.equal(f.record().lastError, 'Keep the existing protected recovery evidence.');
      f.restore(); await f.service.verifyCloudCopy(f.id);
      assert.equal(f.record().status, status); assert.equal(f.record().remoteAuditFailure, undefined);
      assert.equal(f.record().lastError, 'Keep the existing protected recovery evidence.'); assert.equal(f.record().lastSyncedAt, 17);
    } finally { await f.close(); }
  }
});

test('stable audit size/data refusal persists, while transient/auth/cancellation never poisons remote health', async () => {
  for (const code of ['LIMIT', 'TRANSIENT', 'AUTH_FAILED', 'CANCELLED'] as const) {
    const f = fixture(); f.delayPayload(async () => { throw new AzureSyncError(code, 'Synthetic bounded audit outcome.'); });
    try {
      await assert.rejects(f.service.verifyCloudCopy(f.id));
      assert.equal(f.record().remoteAuditFailure, code === 'LIMIT' ? 'corrupt-remote' : undefined);
      assert.equal(f.record().lastSyncedAt, 17); assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0);
    } finally { await f.close(); }
  }
});

test('legacy or other-account scope remains blocked through idle observation and strictly scoped read-only audit', async () => {
  for (const publicationScope of [undefined, 'f'.repeat(64)]) {
    const f = fixture({ appliedCount: 50, localCount: 50 });
    f.setRecord({ publicationScope });
    try {
      await f.service.refreshAll();
      assert.equal(f.counts().payloads, 0); assert.equal(f.counts().points, 0); assert.equal(f.counts().catches, 0);
      assert.match(f.record().lastError ?? '', /Explicitly Sync/);
      if (publicationScope === undefined) assert.equal((await f.service.verifyCloudCopy(f.id)).watermark.eventCount, 100);
      else await assert.rejects(f.service.verifyCloudCopy(f.id), error => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
      assert.equal(f.record().publicationScope, publicationScope); assert.equal(f.record().lastSyncedEventCount, 50);
      const io = f.counts(); await f.service.refreshAll();
      assert.equal(f.counts().payloads, io.payloads); assert.equal(f.counts().points, io.points);
      assert.deepEqual(await f.service.ensureOwnership(f.id), { owned: false, reason: 'ownership-unverified' });
      assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0); assert.equal(f.record().publicationScope, publicationScope);
    } finally { await f.close(); }
  }
});

test('runtime/account suspension revokes a proof-timeout preparation before its late response can publish H or L', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const entered = deferred<void>(), release = deferred<void>(); let raw: HistoryReadContext | undefined;
  f.delayPayload(async context => { raw = context; entered.resolve(); await release.promise; });
  try {
    const proof = f.service.ensureOwnership(f.id); await entered.promise; t.mock.timers.tick(5_000);
    assert.deepEqual(await proof, { owned: false, reason: 'ownership-unverified' });
    f.service.suspend(); await turn(); assert.equal(raw?.signal?.aborted, true);
    release.resolve(); await turn();
    assert.equal((await f.reader.observe(f.id))?.acceptedPin, undefined);
    assert.equal(f.record().lastSyncedAt, 17); assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0);
  } finally { release.resolve(); await f.close(); }
});

test('A1/A2 cold and over-budget idle observations are control-only and preserve honest checkpoints', async () => {
  for (const memoryBytes of [1, 1_048_576]) {
    const f = fixture({ memoryBytes }); const before = structuredClone(f.record());
    try {
      for (let n = 0; n < 4; n++) await f.service.refreshAll();
      assert.deepEqual(f.counts(), { controls: 4, points: 0, payloads: 0, localReads: 0, stats: 4, uploads: 0, catches: 0, proofs: 0 });
      assert.deepEqual(f.record(), before, 'an unknown pin/equal local checkpoint is not a new provenance or completion claim');
    } finally { await f.close(); }
  }
});

test('A20 W=H100 with L50 and no pending marker still catches up after read-only acceptance', async () => {
  const f = fixture({ appliedCount: 50, localCount: 50 });
  try {
    await f.reader.read(f.id); f.reader.invalidate(f.id); // Eviction keeps H, never claims native application.
    const before = f.counts().payloads;
    assert.equal(f.record().catchUpPending, undefined);
    await f.service.refreshAll(); await f.finished.promise; await turn();
    assert.equal(f.counts().catches, 1); assert.equal(f.counts().payloads, before + 1);
    assert.equal(f.record().lastSyncedEventCount, 100);
    const idle = f.counts(); await f.service.refreshAll();
    assert.equal(f.counts().payloads, idle.payloads); assert.equal(f.counts().points, idle.points);
    assert.equal(f.counts().controls, idle.controls + 1);
  } finally { await f.close(); }
});

test('A3 fresh stat and missing-count local durable fallback schedule missed-notification suffix work', async () => {
  for (const statWithoutCount of [false, true]) {
    const f = fixture({ remoteCount: 50, localCount: 100, appliedCount: 50, statWithoutCount });
    try {
      await f.service.refreshAll(); await f.finished.promise;
      assert.equal(f.counts().uploads, 1); assert.equal(f.counts().payloads, 1);
      assert.equal(f.counts().localReads, statWithoutCount ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('A22 a registered real worker survives poll abort, remains single-flight, and Off fences late effects', async () => {
  for (const off of [false, true]) {
    const f = fixture({ appliedCount: 50, localCount: 50 }); const entered = deferred<void>(), release = deferred<void>();
    f.delayPayload(async () => { entered.resolve(); await release.promise; });
    try {
      const tick = new AbortController(); await f.service.refreshAll(tick.signal); tick.abort();
      await entered.promise; await f.service.refreshAll(); await turn();
      assert.equal(f.counts().payloads, 1, 'subsequent observations share the registered work, not duplicate bootstrap');
      if (off) await f.service.disable(f.id);
      release.resolve();
      if (!off) await f.finished.promise;
      await turn(); await turn();
      assert.equal(f.counts().catches, off ? 0 : 1);
      if (off) assert.equal(f.record().enabled, false);
    } finally { release.resolve(); await f.close(); }
  }
});

test('A20 a live Agent is refused at actual worker execution, even with an accepted equal remote tip', async () => {
  const f = fixture({ appliedCount: 50, localCount: 50 }); const entered = deferred<void>(), release = deferred<void>();
  f.delayPayload(async () => { entered.resolve(); await release.promise; });
  try {
    await f.service.refreshAll(); await entered.promise; f.setLive(true); release.resolve();
    await turn(); await turn();
    assert.equal(f.record().status, 'remote-ahead-live'); assert.equal(f.counts().catches, 0); assert.equal(f.counts().proofs, 0);
  } finally { release.resolve(); await f.close(); }
});

test('A21 five-second proof expiry detaches only its waiter; bounded preparation completes with no execution effect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); const entered = deferred<void>(), release = deferred<void>(), pins = trackRetentions(f.reader);
  f.delayPayload(async () => { entered.resolve(); await release.promise; });
  try {
    const proof = f.service.ensureOwnership(f.id); await entered.promise;
    assert.ok(pins.active().length >= 2, 'request and independent preparation own separate data-retention handles');
    const requestSignal = pins.entries[0]!.context.signal;
    t.mock.timers.tick(5_000);
    assert.deepEqual(await proof, { owned: false, reason: 'ownership-unverified' });
    assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0); assert.equal(f.record().lastSyncedAt, 17);
    assert.equal(requestSignal?.aborted, true); assert.ok(pins.active().length > 0);
    assert.ok(pins.active().every(pin => pin.context.signal !== requestSignal), 'the retained preparation never reuses the five-second waiter signal');
    release.resolve(); await turn(); await turn();
    assert.equal(pins.active().length, 0, 'finished read-only preparation releases its own pin without inventing a lease');
    assert.deepEqual(await f.service.ensureOwnership(f.id), { owned: true });
    assert.equal(f.counts().proofs, 1, 'only the later request obtains a fresh server ownership proof');
    assert.equal(f.counts().payloads, 1, 'retained prepared canonical bytes are shared with later admission');
  } finally { release.resolve(); await f.close(); }
});

test('A14 explicit sole request cancellation stops preparation before any later IO or effect', async () => {
  const f = fixture(); const entered = deferred<void>(), release = deferred<void>(); let rawContext: HistoryReadContext | undefined;
  f.delayPayload(async context => { rawContext = context; entered.resolve(); await release.promise; });
  const request = new AbortController();
  try {
    const proof = f.service.ensureOwnership(f.id, request.signal); const rejected = assert.rejects(proof);
    await entered.promise; request.abort(); await rejected; await turn();
    assert.equal(rawContext?.signal?.aborted, true); release.resolve(); await turn();
    assert.equal(f.counts().proofs, 0); assert.equal(f.counts().catches, 0); assert.equal(f.record().lastSyncedAt, 17);
  } finally { release.resolve(); await f.close(); }
});

test('A4 materializers receive latest Git/control metadata without history IO', async () => {
  const f = fixture();
  try {
    await f.reader.read(f.id); const before = f.counts();
    f.changeManifest({ gitJson: '{"v":1,"branch":"newest"}', writerEpoch: 99 });
    const remote = await f.reader.read(f.id); assert.equal(remote?.manifest.entity.gitJson, '{"v":1,"branch":"newest"}');
    assert.equal(remote?.manifest.entity.writerEpoch, 99); assert.equal(f.counts().payloads, before.payloads); assert.equal(f.counts().points, before.points);
  } finally { await f.close(); }
});

test('A17 explicit audit bypasses payload/index hits, leaves L untouched and retains remote integrity failure', async () => {
  const f = fixture();
  try {
    await f.reader.read(f.id); const before = structuredClone(f.record()), io = f.counts();
    const audit = await f.service.verifyCloudCopy(f.id);
    assert.equal(audit.watermark.eventCount, 100); assert.equal(audit.watermark.batchCount, 1); assert.equal(audit.current, true);
    assert.equal(f.counts().payloads, io.payloads + 1); assert.equal(f.counts().points, io.points + 1);
    assert.deepEqual(f.record(), before); assert.equal(f.counts().proofs, 0); assert.equal(f.counts().uploads, 0); assert.equal(f.counts().catches, 0);
    f.corrupt(); await assert.rejects(f.service.verifyCloudCopy(f.id));
    assert.equal(f.record().status, 'corrupt-remote'); assert.equal(f.record().lastSyncedAt, 17);
    await assert.rejects(f.reader.read(f.id)); assert.equal(f.record().status, 'corrupt-remote');
    assert.deepEqual(await f.service.ensureOwnership(f.id), { owned: false, reason: 'ownership-unverified' });
  } finally { await f.close(); }
});
