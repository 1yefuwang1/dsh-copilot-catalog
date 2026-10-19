import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableClient, TransactionAction } from '@azure/data-tables';
import { Config } from '../src/config.js';
import { AzureSyncError } from '../src/azure/errors.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { LeaseHandle, LeaseManager } from '../src/azure/lease.js';
import { TableStore } from '../src/azure/table.js';
import type { LocalStore } from '../src/local/store.js';
import { batchRowKey, decodeCloudRecord, encodeCloudRecord, cloudSessionEntitySchema, sessionRowKey, type CloudSessionEntity, type LocalSessionRecord } from '../src/schema.js';
import { planBatch } from '../src/sync/batcher.js';
import { genesisHash, headerHash } from '../src/sync/chain.js';
import { CloudRepository, candidateBlobName, type StoredManifest } from '../src/sync/cloud-repository.js';
import { SessionLeaseManager } from '../src/sync/lease-manager.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { SyncService } from '../src/sync/service.js';
import type { SessionSource } from '../src/sync/session-source.js';
import { Uploader } from '../src/sync/uploader.js';
import { batchRow, cloudSession, event, localSession, sessionHeader } from './helpers.js';

const clone = <T>(value: T): T => structuredClone(value);
const owner = 'publication-device';
const now = 10_000;
const code = (expected: string) => (error: unknown) => error instanceof AzureSyncError && error.code === expected;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Conditional, atomic SDK table/blob transports; repository/lease/uploader/service implementations are real. */
function fixture(child = false) {
  const id = child ? 'publication-child' : 'publication-root';
  const rootId = child ? 'publication-root' : id;
  const header = sessionHeader({ id });
  const events = [event(0), event(1)];
  const rawHistory = Buffer.from([JSON.stringify(header), ...events.map(value => JSON.stringify(value)), ''].join('\n'));
  const source: SessionSource = {
    flush: async () => undefined,
    read: async () => ({ header: clone(header) as never, inheritedEventCount: 0, events: clone(events) as never }),
    stat: async () => ({ header: clone(header) as never }),
  };
  const rows = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  let revision = 0;
  let publications = 0;
  let candidateWrites = 0;
  const hooks: {
    beforeGet?: (rowKey: string) => Promise<void>;
    afterPublication?: () => void | Promise<void>;
    ambiguousReply?: boolean;
  } = {};
  const putWire = (key: string, value: Record<string, unknown>) => rows.set(key, { ...clone(value), etag: `etag-${++revision}` });
  const put = (entity: CloudSessionEntity, key = entity.rowKey) => putWire(key, encodeCloudRecord(entity));
  const empty = (sessionId: string, rootSessionId = sessionId) => {
    const h = sessionHeader({ id: sessionId });
    const binding = headerHash(h, 0); const genesis = genesisHash(sessionId, 1, binding);
    return cloudSession({ sessionId, writerEpoch: 7, rootSessionId, rootGeneration: 1,
      headerJson: JSON.stringify(h), headerHash: binding, eventCount: 0, headSeq: -1,
      headHash: genesis, chainHash: genesis, batchCount: 0,
      lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined,
      leaseOwner: undefined, leaseUntil: undefined,
    });
  };
  if (child) put(empty(rootId));
  put(empty(id, rootId));
  const manifest = (sessionId = id): StoredManifest => {
    const value = rows.get(sessionRowKey(sessionId)); assert.ok(value);
    const decoded = decodeCloudRecord(cloudSessionEntitySchema, value, 'fixture manifest'); assert.ok(decoded.etag);
    return { entity: decoded.record, etag: decoded.etag };
  };
  const client = {
    async getEntity(_partition: string, key: string) {
      await hooks.beforeGet?.(key);
      const value = rows.get(key); if (value === undefined) throw { statusCode: 404 };
      return clone(value);
    },
    async updateEntity(value: Record<string, unknown>, _mode: string, options: { etag: string }) {
      const key = String(value['rowKey']);
      if (rows.get(key)?.['etag'] !== options.etag) throw { statusCode: 412 };
      putWire(key, value);
    },
    async createEntity(value: Record<string, unknown>) {
      const key = String(value['rowKey']); if (rows.has(key)) throw { statusCode: 409 }; putWire(key, value);
    },
    async submitTransaction(actions: TransactionAction[]) {
      // Validate every action before applying any: root touches and child commits are atomic.
      for (const action of actions) {
        const key = String(action[1].rowKey);
        if (action[0] === 'create' && rows.has(key)) throw { statusCode: 409 };
        if (action[0] === 'update' && rows.get(key)?.['etag'] !== action[3]?.etag) throw { statusCode: 412 };
      }
      for (const action of actions) putWire(String(action[1].rowKey), action[1]);
      const published = actions.some(action => action[0] === 'create' && String(action[1].rowKey).startsWith('batch:'));
      if (published) {
        publications++; await hooks.afterPublication?.();
        if (hooks.ambiguousReply) throw { statusCode: 412 };
      }
      return { status: 202, subResponses: [] };
    },
    async *listEntities(options: { queryOptions?: { filter?: string } }) {
      const filter = options.queryOptions?.filter ?? '';
      const match = /RowKey ge '([^']+)'/u.exec(filter);
      for (const [key, value] of rows) if (key.startsWith('batch:') && (match === null || key.startsWith(match[1]!))) yield clone(value);
    },
  } as unknown as TableClient;
  const blob = {
    async putIfAbsent(name: string, bytes: Uint8Array, metadata: Record<string, string>) {
      if (candidates.has(name)) return 'exists' as const;
      candidateWrites++; candidates.set(name, { bytes: Buffer.from(bytes), metadata: clone(metadata) }); return 'created' as const;
    },
    async read(name: string) { const value = candidates.get(name); assert.ok(value); return Buffer.from(value.bytes); },
    async getMetadata(name: string) { return clone(candidates.get(name)?.metadata ?? {}); },
  } as unknown as BlobStore;
  const repository = new CloudRepository(blob, new TableStore(client));
  const active = new Map<string, LeaseHandle>();
  let acquires = 0; let releases = 0;
  const rawLeases = {
    async acquire(name: string) {
      if (active.has(name)) throw new AzureSyncError('CONFLICT', 'Fixture lease already held.');
      const handle = { leaseId: `${name}:${++acquires}`, client: {} as never }; active.set(name, handle); return handle;
    },
    async release(handle: LeaseHandle) {
      releases++; for (const [name, current] of active) if (current.leaseId === handle.leaseId) active.delete(name);
    },
    async renew(handle: LeaseHandle) {
      assert.ok([...active.values()].some(value => value.leaseId === handle.leaseId));
    },
  } as unknown as LeaseManager;
  let record = localSession({ sessionId: id, writerEpoch: 7, status: 'retrying' });
  const writes: LocalSessionRecord[] = [];
  let lane = Promise.resolve();
  const local = {
    getSession: () => clone(record),
    putSession: async (next: LocalSessionRecord) => { record = clone(next); writes.push(clone(next)); },
    transactSession(_id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) {
      const run = lane.then(() => { const next = fn(clone(record)); if (next !== undefined) { assert.equal(next.sessionId, _id); record = clone(next); writes.push(clone(next)); } return next; });
      lane = run.then(() => undefined, () => undefined); return run;
    },
    listSessions: () => new Map([[id, clone(record)]]).entries(),
  } as unknown as LocalStore;
  const devices: Uploader[] = [];
  const device = (repo = repository) => {
    const leases = new SessionLeaseManager({ repository, leases: rawLeases, deviceId: owner, now: () => now });
    const uploader = new Uploader({ config: Config({ maxBatchEvents: 10 }), source, repository: repo, leases, local,
      deviceId: owner, platform: 'linux', now: () => now }); devices.push(uploader);
    const reader = new RemoteSessionReader(repo, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
    const service = new SyncService({ uploader, local, source, repository: repo, reader, now: () => now });
    return { uploader, service };
  };
  const publication = () => {
    const proof = manifest();
    const plan = planBatch(events, 0, { maxEvents: 10, maxBytes: 1_048_576 }, proof.entity.chainHash); assert.ok(plan);
    const name = candidateBlobName(id, 1, 0, proof.entity.writerEpoch, plan.payloadHash);
    const row = batchRow(id, 1, 0, { endSeq: 1, eventCount: 2, blobName: name, payloadHash: plan.payloadHash,
      prevChainHash: proof.entity.chainHash, chainHash: plan.chain.chainHash, headHash: plan.chain.headHash, createdEpoch: proof.entity.writerEpoch });
    const next: CloudSessionEntity = { ...proof.entity, eventCount: 2, headSeq: 1, chainHash: row.chainHash,
      headHash: row.headHash, batchCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: name };
    return { proof, row, next, ...(child ? { root: manifest(rootId) } : {}) };
  };
  return {
    id, rootId, repository, source, hooks, rows, writes, manifest, put, putWire, publication, device,
    raw: () => Buffer.from(rawHistory), record: () => clone(record),
    counts: () => ({ publications, candidateWrites, acquires, releases, active: active.size }),
    async close() { hooks.beforeGet = undefined; for (const uploader of devices) await uploader.pause(id); },
  };
}

type Mutation = { name: string; expected: string; patch: (entity: CloudSessionEntity) => Partial<CloudSessionEntity> };
const mutations: Mutation[] = [
  { name: 'new generation', expected: 'GENERATION_CHANGED', patch: e => {
    const genesis = genesisHash(e.sessionId, 2, e.headerHash);
    return { generation: 2, rootGeneration: e.rootSessionId === e.sessionId ? 2 : e.rootGeneration,
      eventCount: 0, headSeq: -1, chainHash: genesis, headHash: genesis, batchCount: 0,
      lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined };
  } },
  { name: 'tombstone', expected: 'REMOVED_REMOTELY', patch: () => ({ state: 'deleted', enabled: false, leaseOwner: undefined, leaseUntil: undefined }) },
  { name: 'disabled state', expected: 'DISABLED', patch: () => ({ state: 'disabled', enabled: false }) },
  { name: 'active disabled flag', expected: 'DISABLED', patch: () => ({ enabled: false }) },
  { name: 'header bytes', expected: 'CORRUPT_REMOTE', patch: e => ({ headerJson: `${e.headerJson} ` }) },
  { name: 'header binding', expected: 'CORRUPT_REMOTE', patch: () => ({ headerHash: 'd'.repeat(64) }) },
  { name: 'inherited cut', expected: 'CORRUPT_REMOTE', patch: () => ({ inheritedEventCount: 1 }) },
  { name: 'format', expected: 'CORRUPT_REMOTE', patch: () => ({ formatVersion: 5 }) },
  { name: 'partition', expected: 'CORRUPT_REMOTE', patch: () => ({ partitionKey: 'foreign' }) },
  { name: 'row key', expected: 'CORRUPT_REMOTE', patch: () => ({ rowKey: sessionRowKey('foreign') }) },
  { name: 'session identity', expected: 'CORRUPT_REMOTE', patch: () => ({ sessionId: 'foreign', rowKey: sessionRowKey('foreign') }) },
  { name: 'root identity', expected: 'CORRUPT_REMOTE', patch: () => ({ rootSessionId: 'foreign-root' }) },
  { name: 'root generation', expected: 'CORRUPT_REMOTE', patch: () => ({ rootGeneration: 2 }) },
  { name: 'writer epoch', expected: 'LEASE_LOST', patch: e => ({ writerEpoch: e.writerEpoch + 1 }) },
  { name: 'writer owner', expected: 'LEASE_LOST', patch: () => ({ leaseOwner: 'foreign-writer' }) },
  { name: 'event count', expected: 'PRECONDITION', patch: () => ({ eventCount: 3 }) },
  { name: 'head sequence', expected: 'PRECONDITION', patch: () => ({ headSeq: 2 }) },
  { name: 'chain hash', expected: 'PRECONDITION', patch: () => ({ chainHash: 'e'.repeat(64) }) },
  { name: 'head hash', expected: 'PRECONDITION', patch: () => ({ headHash: 'e'.repeat(64) }) },
  { name: 'batch count', expected: 'PRECONDITION', patch: () => ({ batchCount: 2 }) },
  { name: 'tip row key', expected: 'PRECONDITION', patch: e => ({ lastBatchRowKey: batchRowKey(e.sessionId, 1, 1) }) },
  { name: 'tip generation', expected: 'PRECONDITION', patch: () => ({ lastBatchGeneration: 2 }) },
  { name: 'tip blob', expected: 'PRECONDITION', patch: () => ({ lastBatchBlobName: 'v1/sessions/foreign/gen-1/batches/other.jsonl.gz' }) },
];

for (const child of [false, true]) {
  for (const ambiguous of [false, true]) {
    for (const mutation of mutations) {
      test(`${child ? 'child' : 'root'} ${ambiguous ? 'idempotent' : 'accepted'} publication refuses replaced ${mutation.name} in response reread`, async () => {
        const f = fixture(child); const p = f.publication();
        f.hooks.ambiguousReply = ambiguous;
        f.hooks.afterPublication = () => {
          const current = f.manifest(); f.put({ ...current.entity, ...mutation.patch(current.entity) }, sessionRowKey(f.id));
        };
        await assert.rejects(f.repository.commitBatch(p.proof, p.row, p.next, p.root), code(mutation.expected));
        assert.equal(f.counts().publications, 1, 'the transaction was actually accepted before the race');
        assert.ok(f.rows.has(p.row.rowKey), 'this is a post-commit response race, not a rejected transaction');
      });
    }
    test(`${child ? 'child' : 'root'} ${ambiguous ? 'idempotent' : 'accepted'} publication tolerates legitimate lease deadline/update timestamp drift`, async () => {
      const f = fixture(child); const p = f.publication(); f.hooks.ambiguousReply = ambiguous;
      f.hooks.afterPublication = () => { const current = f.manifest(); f.put({ ...current.entity, updatedAt: now + 1, leaseUntil: now + 120_000 }); };
      const accepted = await f.repository.commitBatch(p.proof, p.row, p.next, p.root);
      assert.equal(accepted.entity.eventCount, 2); assert.equal(accepted.entity.updatedAt, now + 1);
      assert.equal(accepted.entity.leaseUntil, now + 120_000); assert.equal(f.counts().publications, 1);
    });
    test(`${child ? 'child' : 'root'} ${ambiguous ? 'idempotent' : 'accepted'} publication rejects an unsupported response schema`, async () => {
      const f = fixture(child); const p = f.publication(); f.hooks.ambiguousReply = ambiguous;
      f.hooks.afterPublication = () => { f.putWire(sessionRowKey(f.id), { ...encodeCloudRecord(f.manifest().entity), schemaVersion: 5 }); };
      await assert.rejects(f.repository.commitBatch(p.proof, p.row, p.next, p.root), code('INVALID_RECORD'));
      assert.equal(f.counts().publications, 1);
    });
    test(`${child ? 'child' : 'root'} ${ambiguous ? 'idempotent' : 'accepted'} publication refuses a missing response manifest`, async () => {
      const f = fixture(child); const p = f.publication(); f.hooks.ambiguousReply = ambiguous;
      f.hooks.afterPublication = () => { f.rows.delete(sessionRowKey(f.id)); };
      await assert.rejects(f.repository.commitBatch(p.proof, p.row, p.next, p.root), code('CORRUPT_REMOTE'));
    });
  }
}

for (const ambiguous of [false, true]) {
  for (const state of ['deleted', 'disabled', 'new-generation'] as const) {
    test(`child ${ambiguous ? 'idempotent' : 'accepted'} publication rechecks its root after the accepted child tip`, async () => {
      const f = fixture(true); const p = f.publication(); f.hooks.ambiguousReply = ambiguous;
      f.hooks.afterPublication = () => {
        const root = f.manifest(f.rootId).entity;
        f.put(state === 'new-generation' ? { ...root, generation: 2, rootGeneration: 2 } : { ...root, state, enabled: false });
      };
      await assert.rejects(f.repository.commitBatch(p.proof, p.row, p.next, p.root), code('GENERATION_CHANGED'));
      assert.equal(f.counts().publications, 1);
    });
  }
}

for (const child of [false, true]) {
  for (const mutation of mutations.filter(value => ['new generation', 'tombstone', 'disabled state', 'header bytes', 'writer epoch', 'tip blob'].includes(value.name))) {
    test(`${child ? 'child' : 'root'} uploader never checkpoints a replaced ${mutation.name} or reuploads its old raw history on reconnect`, async (t) => {
      const f = fixture(child); t.after(() => f.close()); const d = f.device(); const raw = f.raw();
      f.hooks.afterPublication = () => {
        const current = f.manifest(); f.put({ ...current.entity, ...mutation.patch(current.entity) }, sessionRowKey(f.id));
      };
      // The repository reports a retryable tip race; the uploader's independent
      // post-adoption defense classifies an internally inconsistent receipt as corrupt.
      await assert.rejects(d.uploader.sync(f.id, { release: true }), code(mutation.name === 'tip blob' ? 'CORRUPT_REMOTE' : mutation.expected));
      assert.equal(f.record().generation, 1);
      assert.equal(f.record().lastSyncedEventCount, undefined);
      assert.equal(f.record().lastSyncedAt, undefined);
      assert.notEqual(f.record().status, 'synced');
      assert.equal(d.uploader.hasHeld(f.id), false);
      assert.ok(f.writes.every(record => record.generation === 1 && record.lastSyncedAt === undefined));
      assert.deepEqual(f.raw(), raw);
      const published = f.counts().publications; const writes = f.counts().candidateWrites;
      const reconnect = f.device();
      await reconnect.service.sync(f.id).catch(() => undefined);
      assert.equal(f.counts().publications, published, 'ordinary reconnect must not auto-upload old history into a foreign generation/binding');
      assert.equal(f.counts().candidateWrites, writes);
      assert.equal(f.record().generation, 1);
      assert.deepEqual(f.raw(), raw);
    });
  }
}

for (const child of [false, true]) {
  test(`${child ? 'child' : 'root'} uploader independently rejects a foreign-generation wrapper result that bypasses repository defenses`, async (t) => {
    const f = fixture(child); t.after(() => f.close()); const raw = f.raw();
    const wrapper = Object.create(f.repository) as CloudRepository;
    wrapper.commitBatch = async (...args: Parameters<CloudRepository['commitBatch']>) => {
      const accepted = await f.repository.commitBatch(...args);
      const foreign = { ...accepted.entity, generation: 2, rootGeneration: child ? accepted.entity.rootGeneration : 2,
        eventCount: 0, headSeq: -1, batchCount: 0, lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined };
      const genesis = genesisHash(f.id, 2, foreign.headerHash);
      foreign.chainHash = genesis; foreign.headHash = genesis;
      f.put(foreign);
      return f.manifest();
    };
    const d = f.device(wrapper);
    await assert.rejects(d.uploader.sync(f.id, { release: true }), code('GENERATION_CHANGED'));
    assert.equal(f.record().generation, 1); assert.equal(f.record().lastSyncedAt, undefined);
    assert.equal(f.record().enabled, false); assert.equal(d.uploader.hasHeld(f.id), false);
    assert.deepEqual(f.raw(), raw);
    const before = f.counts(); await f.device().service.sync(f.id);
    assert.equal(f.counts().publications, before.publications); assert.equal(f.counts().candidateWrites, before.candidateWrites);
    assert.equal(f.manifest().entity.generation, 2); assert.equal(f.manifest().entity.eventCount, 0);
    assert.deepEqual(f.raw(), raw);
  });
}

test('a completed detach in another service cancels a child writer stalled at its root precommit read', { timeout: 2_000 }, async (t) => {
  const f = fixture(true); t.after(() => f.close()); const uploading = f.device(); const other = f.device(); const raw = f.raw();
  const entered = deferred<void>(); const rootRead = deferred<void>(); let blocked = false;
  f.hooks.beforeGet = async key => {
    if (!blocked && key === sessionRowKey(f.rootId) && f.counts().candidateWrites > 0) { blocked = true; entered.resolve(); await rootRead.promise; }
  };
  const rejected = assert.rejects(uploading.uploader.sync(f.id, { release: true }), code('CANCELLED'));
  await entered.promise;
  assert.equal(f.counts().publications, 0); assert.equal(f.counts().candidateWrites, 1);
  await other.service.detach(f.id);
  assert.equal(f.record().enabled, false); assert.equal(f.record().detached, true);
  rootRead.resolve(); await rejected;
  assert.equal(f.counts().publications, 0);
  assert.equal([...f.rows.keys()].filter(key => key.startsWith('batch:')).length, 0);
  assert.equal(f.manifest().entity.eventCount, 0); assert.equal(f.manifest().entity.batchCount, 0);
  assert.equal(f.record().enabled, false); assert.equal(f.record().detached, true);
  assert.equal(f.record().lastSyncedAt, undefined); assert.equal(uploading.uploader.hasHeld(f.id), false);
  assert.equal(f.counts().active, 0); assert.deepEqual(f.raw(), raw);
});
