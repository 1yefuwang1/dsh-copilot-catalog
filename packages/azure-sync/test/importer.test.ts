import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Config } from '../src/config.js';
import { Importer } from '../src/sync/importer.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import { SessionAlreadyExistsError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { LocalStore } from '../src/local/store.js';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import type { CwdBinding } from '../src/sync/effective-cwd.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';
import { AzureSyncError } from '../src/azure/errors.js';

class FakeHandle {
  readonly id: string;
  readonly header: SessionHeader;
  readonly inheritedEventCount: number;
  readonly access = 'write';
  events: SessionEvent[] = [];
  appendCount = 0;
  closed = false;
  constructor(header: SessionHeader, inherited: number) { this.id = header.id; this.header = header; this.inheritedEventCount = inherited; }
  async read(offset = 0, length?: number) { return { eventState: 'detached', events: this.events.slice(offset, length === undefined ? undefined : offset + length) }; }
  async append(batch: readonly SessionEvent[]) {
    this.appendCount += 1;
    if (this.failAppendAt !== undefined && this.appendCount >= this.failAppendAt) throw new Error('injected append crash');
    for (const event of batch) { if (event.seq !== this.events.length) throw new Error('non-contiguous'); this.events.push(event); }
  }
  failAppendAt?: number;
  flushCount = 0;
  failFlushAt?: number;
  async flush() { this.flushCount += 1; if (this.failFlushAt !== undefined && this.flushCount >= this.failFlushAt) throw new Error('injected flush crash'); }
  async close() { this.closed = true; }
}

class FakePersistence {
  readonly handles = new Map<string, FakeHandle>();
  async create(header: SessionHeader, options?: { inheritedEventCount?: number }) {
    if (this.handles.has(header.id)) throw new SessionAlreadyExistsError(header.id as never);
    const handle = new FakeHandle(header, options?.inheritedEventCount ?? 0);
    this.handles.set(header.id, handle);
    return handle;
  }
  async open(id: string) {
    const handle = this.handles.get(id);
    if (handle === undefined) throw new Error('not found');
    return handle;
  }
  async flush() {}
}

function remoteFixture() {
  const sessionId = 'session-test';
  const header = sessionHeader({ id: sessionId });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(sessionId, 1, binding);
  const e0 = event(0);
  const e1 = event(1);
  const c0 = chainEvents(genesis, [e0]);
  const c1 = chainEvents(c0.chainHash, [e1]);
  const row0 = batchRow(sessionId, 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: c0.chainHash, headHash: c0.headHash, payloadHash: c0.payloadHash });
  const row1 = batchRow(sessionId, 1, 1, { endSeq: 1, eventCount: 1, prevChainHash: c0.chainHash, chainHash: c1.chainHash, headHash: c1.headHash, payloadHash: c1.payloadHash, prevBatchRowKey: row0.rowKey });
  const entity = cloudSession({ sessionId, headerHash: binding, eventCount: 2, chainHash: c1.chainHash, lastBatchRowKey: row1.rowKey, lastBatchGeneration: 1, batchCount: 2 });
  const manifest: StoredManifest = { entity, etag: 'etag-1' };
  const blobs = new Map([[row0.blobName, gzipSync(payloadBytes([e0]))], [row1.blobName, gzipSync(payloadBytes([e1]))]]);
  const repository = {
    getManifest: async () => manifest,
    listBatchRows: async () => [row0, row1],
    readCandidate: async (name: string) => blobs.get(name) ?? Buffer.alloc(0),
  } as unknown as CloudRepository;
  return { repository, header, e0, e1 };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-import-'));
  const localRoot = join(root, 'local');
  await mkdir(localRoot, { recursive: true });
  const real = await realpath(localRoot);
  const remote = remoteFixture();
  const records = new Map<string, ReturnType<typeof localSession>>();
  const local = {
    getSession: (id: string) => records.get(id),
    putSession: async (record: ReturnType<typeof localSession>) => { records.set(record.sessionId, record); },
    deleteSession: async (id: string) => records.delete(id),
    listSessions: () => records.entries(),
  } as unknown as LocalStore;
  const binding: CwdBinding = { mapping: pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' }), fs: nodeCwdFs };
  const persistence = new FakePersistence();
  const projection = { warm: async () => 'complete' } as unknown as ProjectionWarmer;
  const importer = new Importer({
    config: Config({}), persistence: persistence as unknown as SessionPersistence, repository: remote.repository,
    local, cwdBinding: async () => binding, projection, now: () => 1,
  });
  return { root, real, remote, records, local, persistence, importer, binding };
}

test('importer creates a localized session, appends, provenance-checks, and completes', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await f.importer.import('session-test');
  assert.equal(result.status, 'complete');
  const record = f.records.get('session-test');
  assert.equal(record?.importState, 'complete');
  assert.equal(record?.status, 'synced');
  const handle = f.persistence.handles.get('session-test');
  assert.equal(handle?.events.length, 2);
  assert.equal(handle?.header.cwd, f.real);
  assert.equal(handle?.closed, true);
  assert.equal(record?.localCwd, f.real);
  assert.equal(record?.canonicalCwd, '/remote/project');
  assert.equal(record?.remapped, true);
  assert.equal(record?.generation, 1);
});

test('resume appends only the missing suffix without duplicating events', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const header = { ...f.remote.header, cwd: f.real };
  const handle = await f.persistence.create(header as SessionHeader, { inheritedEventCount: 0 });
  await handle.append([f.remote.e0] as never);
  await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'creating', status: 'importing' }));
  const result = await f.importer.resume('session-test', handle as never);
  assert.equal(result.status, 'complete');
  assert.equal(handle.events.length, 2);
});

test('preflight refuses schedule events and a missing binding before create', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const scheduleHeader = sessionHeader({ id: 'session-test' });
  const scheduleBinding = headerHash(scheduleHeader, 0);
  const scheduleGenesis = genesisHash('session-test', 1, scheduleBinding);
  const scheduleEvent = event(0, 'schedule/change');
  const scheduleChain = chainEvents(scheduleGenesis, [scheduleEvent]);
  const scheduleRow = batchRow('session-test', 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: scheduleGenesis, chainHash: scheduleChain.chainHash, headHash: scheduleChain.headHash, payloadHash: scheduleChain.payloadHash });
  const scheduleImporter = new Importer({
    config: Config({}), persistence: f.persistence as unknown as SessionPersistence, repository: {
      getManifest: async () => ({
        entity: cloudSession({ sessionId: 'session-test', headerJson: JSON.stringify(scheduleHeader), headerHash: scheduleBinding, eventCount: 1, chainHash: scheduleChain.chainHash, lastBatchRowKey: scheduleRow.rowKey, lastBatchGeneration: 1 }),
        etag: 'e',
      }),
      listBatchRows: async () => [scheduleRow],
      readCandidate: async () => gzipSync(payloadBytes([scheduleEvent])),
    } as unknown as CloudRepository,
    local: f.local, cwdBinding: async () => f.binding, projection: {} as ProjectionWarmer, now: () => 1,
  });
  await assert.rejects(scheduleImporter.import('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'SCHEDULE_UNSAFE');

  const noBinding = new Importer({
    config: Config({}), persistence: f.persistence as unknown as SessionPersistence, repository: f.remote.repository,
    local: f.local, cwdBinding: async () => undefined, projection: {} as ProjectionWarmer, now: () => 1,
  });
  await assert.rejects(noBinding.import('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'NEEDS_FOLDER');
});

test('ImportGuard vetoes incomplete session creation unless the importer allows it', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const { ImportGuard } = await import('../src/sync/importer.js');
  const guard = new ImportGuard(f.local);
  await f.local.putSession(localSession({ sessionId: 'guarded', importState: 'planned', status: 'importing' }));
  assert.throws(() => guard.assertCreatable('guarded'), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_INCOMPLETE');
  guard.allow('guarded');
  assert.doesNotThrow(() => guard.assertCreatable('guarded'));
  guard.disallow('guarded');
  assert.throws(() => guard.assertCreatable('guarded'));
  await f.local.putSession(localSession({ sessionId: 'acknowledged', importState: 'degraded', degradedAcknowledged: true }));
  assert.doesNotThrow(() => guard.assertCreatable('acknowledged'));
});

test('a crash during append resumes the missing suffix without duplicates', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader, { inheritedEventCount: 0 });
  handle.failAppendAt = 1;
  await assert.rejects(f.importer.import('session-test', handle as never));
  assert.equal(handle.events.length, 0);
  assert.equal(f.records.get('session-test')?.importState, 'failed');
  handle.failAppendAt = undefined;
  const resumed = await f.importer.resume('session-test', handle as never);
  assert.equal(resumed.status, 'complete');
  assert.equal(handle.events.length, 2);
});

test('a crash during flush leaves a failed resumable import and no duplicate append', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader, { inheritedEventCount: 0 });
  handle.failFlushAt = 1;
  await assert.rejects(f.importer.import('session-test', handle as never));
  assert.equal(f.records.get('session-test')?.importState, 'failed');
  handle.failFlushAt = undefined;
  const resumed = await f.importer.resume('session-test', handle as never);
  assert.equal(resumed.status, 'complete');
  assert.equal(handle.events.length, 2);
});

test('a missing preset blocks import before create', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const header = sessionHeader({ id: 'session-test', agentPreset: 'custom' });
  const binding = headerHash(header, 0);
  const genesis = genesisHash('session-test', 1, binding);
  const e0 = event(0);
  const chain = chainEvents(genesis, [e0]);
  const row = batchRow('session-test', 1, 0, { endSeq: 0, eventCount: 1, prevChainHash: genesis, chainHash: chain.chainHash, headHash: chain.headHash, payloadHash: chain.payloadHash });
  const manifest = { entity: cloudSession({ sessionId: 'session-test', headerJson: JSON.stringify(header), headerHash: binding, eventCount: 1, chainHash: chain.chainHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1 }), etag: 'e' };
  const presetImporter = new Importer({
    config: Config({}), persistence: f.persistence as unknown as SessionPersistence, repository: {
      getManifest: async () => manifest,
      listBatchRows: async () => [row],
      readCandidate: async () => gzipSync(payloadBytes([e0])),
    } as unknown as CloudRepository,
    local: f.local, cwdBinding: async () => f.binding, presetAvailable: () => false,
    projection: { warm: async () => 'complete' } as unknown as ProjectionWarmer, now: () => 1,
  });
  await assert.rejects(presetImporter.import('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'PRESET_MISSING');
});

test('resume rejects a write handle with the wrong immutable header or inherited cut', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const decoy = await f.persistence.create({ ...f.remote.header, cwd: '/decoy' } as SessionHeader, { inheritedEventCount: 7 });
  await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'creating', status: 'importing' }));
  await assert.rejects(f.importer.resume('session-test', decoy as never), (error: unknown) => error instanceof AzureSyncError && error.code === 'PROVENANCE_MISMATCH');
  assert.equal(decoy.events.length, 0);
});

test('an existing-id collision restores prior control state instead of stranding the session', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader, { inheritedEventCount: 0 });
  await assert.rejects(f.importer.import('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_RACE');
  assert.equal(f.local.getSession('session-test'), undefined);
  const guard = new (await import('../src/sync/importer.js')).ImportGuard(f.local);
  assert.doesNotThrow(() => guard.assertCreatable('session-test'));
});
