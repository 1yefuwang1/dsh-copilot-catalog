import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { gzipSync } from 'node:zlib';
import { Config } from '../src/config.js';
import { EarlyImportClaims, Importer, type ImportDependencies } from '../src/sync/importer.js';
import { ImportService } from '../src/sync/import-service.js';
import type { RemoteSession } from '../src/sync/remote-session.js';
import type { AttachmentSync } from '../src/sync/attachments.js';
import type { CloudRepository, StoredManifest } from '../src/sync/cloud-repository.js';
import { SessionAlreadyExistsError, SessionAlreadyOwnedError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { LocalStore, localDomain } from '../src/local/store.js';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import type { CwdBinding } from '../src/sync/effective-cwd.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';
import { AzureSyncError } from '../src/azure/errors.js';

const storageRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { Storage } = await import(pathToFileURL(storageRequire.resolve('@deepseek-ai/dsh-storage')).href);

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
    handle.closed = false;
    return handle;
  }
  async flush() {}
}

function remoteFixture(withAttachment = false) {
  const sessionId = 'session-test';
  const header = sessionHeader({ id: sessionId });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(sessionId, 1, binding);
  const e0 = event(0);
  const e1 = event(1, 'user/message', withAttachment ? {
    content: [{ type: 'image', attachmentId: 'synthetic-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
  } : {});
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

async function fixture(remote = remoteFixture()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-import-'));
  const localRoot = join(root, 'local');
  await mkdir(localRoot, { recursive: true });
  const real = await realpath(localRoot);
  const records = new Map<string, ReturnType<typeof localSession>>();
  let afterWrite: ((record: ReturnType<typeof localSession>) => void | Promise<void>) | undefined;
  const local = {
    getSession: (id: string) => records.get(id),
    putSession: async (record: ReturnType<typeof localSession>) => { records.set(record.sessionId, record); },
    transactSession: async (id: string, fn: Parameters<LocalStore['transactSession']>[1]) => {
      // The fake's atomic port evaluates latest and commits without an await.
      // Observers run after commit, never by routing through a full-record put.
      const next = fn(records.get(id));
      if (next === undefined) return undefined;
      records.set(id, next);
      await afterWrite?.(next);
      return next;
    },
    deleteSession: async (id: string) => records.delete(id),
    deleteSessionIf: async (id: string, predicate: Parameters<LocalStore['deleteSessionIf']>[1]) => {
      const latest = records.get(id);
      return latest !== undefined && predicate(latest) ? records.delete(id) : false;
    },
    listSessions: () => records.entries(),
  } as unknown as LocalStore;
  const binding: CwdBinding = { mapping: pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' }), fs: nodeCwdFs };
  const persistence = new FakePersistence();
  const projection = { warm: async () => 'complete' } as unknown as ProjectionWarmer;
  const importer = new Importer({
    config: Config({}), persistence: persistence as unknown as SessionPersistence, repository: remote.repository,
    local, cwdBinding: async () => binding, projection, now: () => 1,
  });
  const onWrite = (hook: (record: ReturnType<typeof localSession>) => void | Promise<void>) => { afterWrite = hook; };
  return { root, real, remote, records, local, persistence, importer, binding, onWrite };
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function catchUpFixture(withAttachment = false) {
  const f = await fixture(remoteFixture(withAttachment));
  const manifest = await f.remote.repository.getManifest('session-test');
  assert.ok(manifest);
  const remote: RemoteSession = {
    manifest: structuredClone(manifest), header: f.remote.header as SessionHeader,
    inheritedEventCount: 0, events: [f.remote.e0, f.remote.e1] as unknown as SessionEvent[],
  };
  let currentManifest = manifest;
  const repository = {
    getManifest: async () => currentManifest,
  } as unknown as CloudRepository;
  const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader, { inheritedEventCount: 0 });
  await handle.append([f.remote.e0] as never);
  handle.appendCount = 0;
  await f.local.putSession(localSession({
    sessionId: 'session-test', importState: 'complete', localCwd: f.real, canonicalCwd: '/remote/project',
    lastSyncedEventCount: 1,
  }));
  const controller = new AbortController();
  const options = { signal: controller.signal, isLive: () => false };
  const makeImporter = (overrides: Partial<ImportDependencies> = {}) => new Importer({
    config: Config({ maxBatchEvents: 1 }), persistence: f.persistence as unknown as SessionPersistence,
    repository, local: f.local, cwdBinding: async () => f.binding,
    projection: { warm: async () => 'complete' } as unknown as ProjectionWarmer,
    now: () => 1, ...overrides,
  });
  const changeManifest = (patch: Partial<StoredManifest['entity']>) => {
    currentManifest = { ...currentManifest, entity: { ...currentManifest.entity, ...patch }, etag: 'changed' };
  };
  return { ...f, handle, remoteSession: remote, controller, options, makeImporter, changeManifest };
}

test('catch-up appends only the missing verified prefix and marks synced after warming', async (t) => {
  const f = await catchUpFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await f.makeImporter().catchUp('session-test', f.remoteSession, f.options);
  assert.equal(result.status, 'complete');
  assert.deepEqual(f.handle.events, f.remoteSession.events);
  assert.equal(f.handle.appendCount, 1);
  assert.equal(f.handle.closed, true);
  assert.equal(f.records.get('session-test')?.status, 'synced');
  assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 2);
});

test('catch-up cancellation during late attachment/projection completion never publishes synced', async (t) => {
  for (const phase of ['attachments', 'projection'] as const) {
    await t.test(phase, async (t) => {
      const f = await catchUpFixture(phase === 'attachments');
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const entered = gate();
      const release = gate();
      const postAbortWrites: string[] = [];
      f.onWrite((record) => {
        if (f.controller.signal.aborted) postAbortWrites.push(record.status);
      });
      const importer = f.makeImporter(phase === 'attachments' ? {
        attachments: {
          import: async () => { entered.resolve(); await release.promise; return { imported: ['synthetic-image'], degraded: [], aliases: [] }; },
        } as unknown as AttachmentSync,
      } : {
        projection: {
          warm: async () => { entered.resolve(); await release.promise; return 'complete'; },
        } as unknown as ProjectionWarmer,
      });
      const reason = new AzureSyncError('CANCELLED', 'Synthetic cancellation.');
      const pending = importer.catchUp('session-test', f.remoteSession, f.options);
      const rejected = assert.rejects(pending, (error: unknown) => error === reason);
      await entered.promise;
      assert.equal(f.records.get('session-test')?.importState, phase === 'attachments' ? 'attachments' : 'warming');
      f.controller.abort(reason);
      release.resolve();
      await rejected;
      assert.notEqual(f.records.get('session-test')?.status, 'synced');
      assert.notEqual(f.records.get('session-test')?.importState, 'complete');
      assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
      assert.deepEqual(postAbortWrites, []);
      assert.equal(f.handle.closed, true);
    });
  }
});

test('catch-up abort releases its write handle even when attachment/projection IO never settles', async (t) => {
  for (const phase of ['attachments', 'projection'] as const) {
    await t.test(phase, async (t) => {
      const f = await catchUpFixture(phase === 'attachments');
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const entered = gate();
      const never = () => {
        entered.resolve();
        return new Promise<never>(() => undefined);
      };
      const importer = f.makeImporter(phase === 'attachments'
        ? { attachments: { import: never } as unknown as AttachmentSync }
        : { projection: { warm: never } as unknown as ProjectionWarmer });
      const reason = new AzureSyncError('CANCELLED', 'Synthetic never-settling IO cancellation.');
      // Observe rejection before abort, but do not release or settle the raw
      // provider: catchUp itself, not a service/poller race, must release ownership.
      const observed = importer.catchUp('session-test', f.remoteSession, f.options).then(
        () => ({ kind: 'resolved' } as const),
        (error: unknown) => ({ kind: 'rejected', error } as const),
      );
      await entered.promise;
      assert.equal(f.handle.closed, false);
      assert.equal(f.records.get('session-test')?.importState, phase === 'attachments' ? 'attachments' : 'warming');
      let timer!: ReturnType<typeof setTimeout>;
      const deadline = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), 250);
      });
      t.after(() => clearTimeout(timer));
      f.controller.abort(reason);
      const outcome = await Promise.race([observed, deadline]);
      clearTimeout(timer);
      assert.ok(outcome.kind === 'rejected', `catchUp must reject within 250 ms without waiting for ${phase}; got ${outcome.kind}`);
      assert.equal(outcome.error, reason);
      assert.equal(f.handle.closed, true, 'abort must release the acquired writer before catchUp settles');
      assert.notEqual(f.records.get('session-test')?.status, 'synced');
      assert.notEqual(f.records.get('session-test')?.importState, 'complete');
      assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
    });
  }
});

test('catch-up never appends to a retained-live or already-owned session', async (t) => {
  for (const retained of ['live-callback', 'owned-handle'] as const) {
    await t.test(retained, async (t) => {
      const f = await catchUpFixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      let opens = 0;
      f.persistence.open = async () => { opens += 1; throw new SessionAlreadyOwnedError('session-test' as never); };
      const before = structuredClone(f.handle.events);
      await assert.rejects(f.makeImporter().catchUp('session-test', f.remoteSession, {
        ...f.options, isLive: () => retained === 'live-callback',
      }), (error: unknown) => retained === 'live-callback'
        ? error instanceof AzureSyncError && error.code === 'IMPORT_RACE'
        : error instanceof SessionAlreadyOwnedError);
      assert.equal(opens, retained === 'live-callback' ? 0 : 1);
      assert.equal(f.handle.appendCount, 0);
      assert.deepEqual(f.handle.events, before);
      assert.equal(f.handle.closed, false, 'the retained owner must keep its handle');
      assert.equal(f.records.get('session-test')?.status, 'remote-ahead-live');
      assert.equal(f.records.get('session-test')?.importState, 'complete');
      assert.equal(f.records.get('session-test')?.catchUpPending, false);
    });
  }
});

test('catch-up fences generation/tombstone/disabled changes before writer, append, and finalization', async (t) => {
  const changes = [
    { name: 'generation', patch: { generation: 2 }, code: 'GENERATION_CHANGED' },
    { name: 'tombstone', patch: { state: 'deleted', enabled: false }, code: 'REMOVED_REMOTELY' },
    { name: 'disabled', patch: { state: 'disabled', enabled: false }, code: 'DISABLED' },
  ] as const;
  for (const phase of ['before-writer', 'before-append', 'before-finalize'] as const) {
    for (const change of changes) {
      await t.test(`${phase}/${change.name}`, async (t) => {
        const f = await catchUpFixture();
        t.after(() => rm(f.root, { recursive: true, force: true }));
        let opens = 0;
        const open = f.persistence.open.bind(f.persistence);
        f.persistence.open = async (id) => { opens += 1; return open(id); };
        f.onWrite((record) => {
          if (record.importState === (phase === 'before-writer' ? 'planned' : phase === 'before-append' ? 'appending' : undefined)) {
            f.changeManifest(change.patch);
          }
        });
        const importer = f.makeImporter({
          projection: {
            warm: async () => {
              if (phase === 'before-finalize') f.changeManifest(change.patch);
              return 'complete';
            },
          } as unknown as ProjectionWarmer,
        });
        await assert.rejects(importer.catchUp('session-test', f.remoteSession, f.options),
          (error: unknown) => error instanceof AzureSyncError && error.code === change.code);
        assert.equal(opens, phase === 'before-writer' ? 0 : 1);
        assert.equal(f.handle.appendCount, phase === 'before-finalize' ? 1 : 0);
        assert.equal(f.handle.events.length, phase === 'before-finalize' ? 2 : 1);
        assert.notEqual(f.records.get('session-test')?.status, 'synced');
        assert.notEqual(f.records.get('session-test')?.importState, 'complete');
        assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
        assert.equal(f.records.get('session-test')?.catchUpPending, false);
      });
    }
  }
});

test('catch-up detects a prefix mutation or new local suffix at the write claim and preserves it', async (t) => {
  for (const mutation of ['different-prefix', 'local-advanced'] as const) {
    await t.test(mutation, async (t) => {
      const f = await catchUpFixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const open = f.persistence.open.bind(f.persistence);
      let preserved: SessionEvent[] = [];
      f.persistence.open = async (id) => {
        const handle = await open(id);
        if (mutation === 'different-prefix') {
          handle.events[0] = event(0, 'user/message', { content: [{ type: 'text', text: 'local-only edit' }] }) as unknown as SessionEvent;
        } else {
          handle.events.push(event(1) as unknown as SessionEvent, event(2) as unknown as SessionEvent);
        }
        preserved = structuredClone(handle.events);
        return handle;
      };
      await assert.rejects(f.makeImporter().catchUp('session-test', f.remoteSession, f.options),
        (error: unknown) => error instanceof AzureSyncError && error.code === 'CONFLICT');
      assert.equal(f.handle.appendCount, 0);
      assert.deepEqual(f.handle.events, preserved);
      assert.equal(f.handle.closed, true);
      assert.equal(f.records.get('session-test')?.status, 'conflict');
      assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
      assert.equal(f.records.get('session-test')?.catchUpPending, false);
    });
  }
});

function advancedRemote(remote: RemoteSession, count: number): RemoteSession {
  const events = [...remote.events];
  while (events.length < count) events.push(event(events.length) as unknown as SessionEvent);
  const entity = remote.manifest.entity;
  const commitment = chainEvents(genesisHash(entity.sessionId, entity.generation, entity.headerHash), events);
  return {
    ...remote, events,
    manifest: {
      etag: 'changed',
      entity: { ...entity, eventCount: count, headSeq: count - 1, chainHash: commitment.chainHash, headHash: commitment.headHash },
    },
  };
}

test('a moving remote tip before/after the first append retries a fresh verified tip in the same process', async (t) => {
  for (const phase of ['before-first-append', 'after-first-append'] as const) {
    await t.test(phase, async (t) => {
      const f = await catchUpFixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const initial = advancedRemote(f.remoteSession, 3);
      const fresh = advancedRemote(initial, 4);
      f.changeManifest(initial.manifest.entity);
      let moved = false;
      f.onWrite((record) => {
        if (!moved && record.importState === 'appending' &&
          (phase === 'before-first-append' || record.importAppendedCount === 1)) {
          moved = true;
          f.changeManifest(fresh.manifest.entity);
        }
      });
      const importer = f.makeImporter();
      await assert.rejects(importer.catchUp('session-test', initial, f.options),
        (error: unknown) => error instanceof AzureSyncError && error.code === 'TRANSIENT');
      const pending = f.records.get('session-test');
      assert.equal(pending?.catchUpPending, true);
      assert.equal(pending?.importState, 'appending');
      assert.equal(pending?.status, 'retrying');
      assert.equal(pending?.lastSyncedEventCount, 1);
      assert.equal(f.handle.events.length, phase === 'before-first-append' ? 1 : 2);
      assert.equal(pending?.importedThroughSeq, phase === 'before-first-append' ? undefined : 1);
      assert.equal(f.handle.closed, true);
      const result = await importer.catchUp('session-test', fresh, f.options);
      assert.equal(result.status, 'complete');
      assert.deepEqual(f.handle.events, fresh.events);
      assert.equal(f.handle.appendCount, 3, 'each missing event is appended exactly once across attempts');
      assert.equal(f.records.get('session-test')?.catchUpPending, false);
      assert.equal(f.records.get('session-test')?.importState, 'complete');
      assert.equal(f.records.get('session-test')?.status, 'synced');
      assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 4);
    });
  }
});

test('a canceled partial append keeps durable provenance and retries without duplicate events', async (t) => {
  const f = await catchUpFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const remote = advancedRemote(f.remoteSession, 3);
  f.changeManifest(remote.manifest.entity);
  const reason = new AzureSyncError('CANCELLED', 'Synthetic partial catch-up timeout.');
  let interrupted = false;
  f.onWrite((record) => {
    if (!interrupted && record.importAppendedCount === 1) {
      interrupted = true;
      f.controller.abort(reason);
    }
  });
  const importer = f.makeImporter();
  await assert.rejects(importer.catchUp('session-test', remote, f.options), (error: unknown) => error === reason);
  assert.equal(f.handle.events.length, 2);
  assert.equal(f.handle.closed, true);
  assert.equal(f.records.get('session-test')?.catchUpPending, true);
  assert.equal(f.records.get('session-test')?.importState, 'appending');
  assert.equal(f.records.get('session-test')?.importedThroughSeq, 1);
  assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
  const result = await importer.catchUp('session-test', remote, { ...f.options, signal: new AbortController().signal });
  assert.equal(result.status, 'complete');
  assert.deepEqual(f.handle.events, remote.events);
  assert.equal(f.handle.appendCount, 2);
  assert.equal(f.records.get('session-test')?.catchUpPending, false);
  assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 3);
});

test('same-count retry finishes canceled attachment/projection work and rejects late old-attempt publication', async (t) => {
  for (const phase of ['attachments', 'projection'] as const) {
    await t.test(phase, async (t) => {
      const f = await catchUpFixture(phase === 'attachments');
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const entered = gate();
      const releaseOld = gate();
      let calls = 0;
      let writes = 0;
      f.onWrite(() => { writes += 1; });
      const delayFirst = async () => {
        calls += 1;
        if (calls === 1) { entered.resolve(); await releaseOld.promise; }
      };
      const importer = f.makeImporter(phase === 'attachments' ? {
        attachments: { import: async () => { await delayFirst(); return { imported: ['synthetic-image'], degraded: [], aliases: [] }; } } as unknown as AttachmentSync,
      } : {
        projection: { warm: async () => { await delayFirst(); return 'complete'; } } as unknown as ProjectionWarmer,
      });
      const reason = new AzureSyncError('CANCELLED', 'Synthetic finalization timeout.');
      const pending = importer.catchUp('session-test', f.remoteSession, f.options);
      const rejected = assert.rejects(pending, (error: unknown) => error === reason);
      await entered.promise;
      f.controller.abort(reason);
      await rejected; // The raw provider remains pending throughout this await.
      assert.equal(f.handle.closed, true);
      assert.equal(f.handle.events.length, f.remoteSession.events.length);
      assert.equal(f.records.get('session-test')?.catchUpPending, true);
      assert.equal(f.records.get('session-test')?.importState, phase === 'attachments' ? 'attachments' : 'warming');
      assert.equal(f.records.get('session-test')?.lastSyncedEventCount, 1);
      const appendCount = f.handle.appendCount;
      const result = await importer.catchUp('session-test', f.remoteSession, { ...f.options, signal: new AbortController().signal });
      assert.equal(result.status, 'complete');
      assert.equal(calls, 2);
      assert.equal(f.handle.appendCount, appendCount, 'a same-count finalization retry must never append again');
      assert.equal(f.records.get('session-test')?.catchUpPending, false);
      assert.equal(f.records.get('session-test')?.status, 'synced');
      const completed = structuredClone(f.records.get('session-test'));
      const completedWrites = writes;
      releaseOld.resolve();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      assert.deepEqual(f.records.get('session-test'), completed);
      assert.equal(writes, completedWrites, 'an old canceled provider cannot write into the new attempt');
    });
  }
});

test('catch-up cancellation and retry markers never override explicit local disable intent', async (t) => {
  for (const abortSignal of [false, true]) {
    await t.test(`abort-signal=${abortSignal}`, async (t) => {
      const f = await catchUpFixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const entered = gate();
      const release = gate();
      const importer = f.makeImporter({ projection: {
        warm: async () => { entered.resolve(); await release.promise; return 'complete'; },
      } as unknown as ProjectionWarmer });
      const pending = importer.catchUp('session-test', f.remoteSession, f.options);
      const rejected = assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
      await entered.promise;
      const disabled = { ...f.records.get('session-test')!, enabled: false, detached: true, state: 'disabled' as const, status: 'detached' as const };
      await f.local.putSession(disabled);
      if (abortSignal) f.controller.abort(new AzureSyncError('CANCELLED', 'Synthetic user disable.'));
      release.resolve();
      await rejected;
      assert.deepEqual(f.records.get('session-test'), disabled);
      assert.equal(f.handle.closed, true);
      await assert.rejects(importer.catchUp('session-test', f.remoteSession, { ...f.options, signal: new AbortController().signal }),
        (error: unknown) => error instanceof AzureSyncError && error.code === 'DISABLED');
      assert.deepEqual(f.records.get('session-test'), disabled);
    });
  }
});

test('completed/degraded catch-ups clear retry intent, while initial incomplete imports remain separate', async (t) => {
  const f = await catchUpFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await f.makeImporter({ projection: { warm: async () => 'partial' } as unknown as ProjectionWarmer })
    .catchUp('session-test', f.remoteSession, f.options);
  assert.equal(result.status, 'degraded');
  assert.equal(f.records.get('session-test')?.catchUpPending, false);
  assert.equal(f.records.get('session-test')?.importState, 'degraded');
  for (const importState of ['planned', 'appending', 'warming', 'failed'] as const) {
    const incomplete = { ...f.records.get('session-test')!, catchUpPending: undefined, importState, status: 'import-incomplete' as const };
    await f.local.putSession(incomplete);
    await assert.rejects(f.makeImporter().catchUp('session-test', f.remoteSession, f.options),
      (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_INCOMPLETE');
    assert.deepEqual(f.records.get('session-test'), incomplete);
  }
});

test('early import claims skip pending catch-ups but still claim failed initial imports', async (t) => {
  const f = await catchUpFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.local.putSession({ ...f.records.get('session-test')!, catchUpPending: true, importState: 'appending', status: 'importing' });
  await f.persistence.create({ ...f.remote.header, id: 'initial-import', cwd: f.real } as SessionHeader, { inheritedEventCount: 0 });
  await f.local.putSession(localSession({ sessionId: 'initial-import', importState: 'failed', status: 'import-incomplete' }));
  const opened: string[] = [];
  const open = f.persistence.open.bind(f.persistence);
  f.persistence.open = async (id) => { opened.push(id); return open(id); };
  const claims = new EarlyImportClaims(f.persistence as unknown as SessionPersistence, f.local);
  const result = await claims.claimAll();
  assert.deepEqual(opened, ['initial-import']);
  assert.deepEqual(result.claimed.map((claim) => claim.sessionId), ['initial-import']);
  assert.deepEqual(result.raced, []);
  await claims.release();
});

function requestImporter(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<ImportDependencies> = {}) {
  return new Importer({
    config: Config({ maxBatchEvents: 1 }), persistence: f.persistence as unknown as SessionPersistence,
    repository: f.remote.repository, local: f.local, cwdBinding: async () => f.binding,
    projection: { warm: async () => 'complete' } as unknown as ProjectionWarmer,
    now: () => 2, ...overrides,
  });
}

async function rejectsPromptly(pending: Promise<unknown>, reason: unknown) {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Abort did not release the import request within 250 ms.')), 250); });
  try { await assert.rejects(Promise.race([pending, timeout]), (error: unknown) => error === reason); }
  finally { clearTimeout(timer); }
}

// All providers here are deliberately signal-unaware. Cancellation belongs to
// the importer itself, not a public command/controller race around its helpers.
test('initial and resumed requests gate every IO boundary and preserve newer local off intent', async (t) => {
  for (const mode of ['initial', 'resume'] as const) {
    for (const phase of ['read', 'binding', 'preset', 'cwd', 'claim', 'stored-read', 'append', 'flush', 'attachments', 'projection', 'list', 'workspace'] as const) {
      await t.test(`${mode}/${phase}`, async (t) => {
        const f = await fixture(remoteFixture(phase === 'attachments'));
        t.after(() => rm(f.root, { recursive: true, force: true }));
        const entered = gate();
        const release = gate();
        const lateClose = gate();
        const controller = new AbortController();
        const reason = new AzureSyncError('CANCELLED', 'Synthetic import cancellation.');
        const io: string[] = [];
        const postAbortWrites: string[] = [];
        const put = f.local.putSession.bind(f.local);
        f.onWrite((record) => {
          if (controller.signal.aborted) postAbortWrites.push(record.status);
        });
        let handle: FakeHandle | undefined;
        if (mode === 'resume') {
          handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader);
          await put(localSession({ sessionId: 'session-test', importState: 'failed', importMappingId: f.binding.mapping.id, importMappingRevision: f.binding.mapping.revision }));
        }
        const delay = async (name: string) => {
          io.push(name);
          if (name === phase) { entered.resolve(); await release.promise; }
        };
        const watchHandle = (value: FakeHandle) => {
          const read = value.read.bind(value);
          const append = value.append.bind(value);
          const flush = value.flush.bind(value);
          value.read = async (...args) => { await delay('stored-read'); return read(...args); };
          value.append = async (events) => { await append(events); await delay('append'); };
          value.flush = async () => { await delay('flush'); return flush(); };
          value.close = async () => { value.closed = true; lateClose.resolve(); };
          return value;
        };
        if (handle !== undefined) watchHandle(handle);
        const create = f.persistence.create.bind(f.persistence);
        f.persistence.create = async (...args) => { await delay('claim'); handle = watchHandle(await create(...args)); return handle; };
        const open = f.persistence.open.bind(f.persistence);
        f.persistence.open = async (...args) => { await delay('claim'); return open(...args); };
        const getManifest = f.remote.repository.getManifest.bind(f.remote.repository);
        f.remote.repository.getManifest = async (...args) => { await delay('read'); return getManifest(...args); };
        const listRows = f.remote.repository.listBatchRows.bind(f.remote.repository);
        f.remote.repository.listBatchRows = async (...args) => { io.push('batch-rows'); return listRows(...args); };
        let overrides: Partial<ImportDependencies> = {
          cwdBinding: async () => {
            await delay('binding');
            return { ...f.binding, fs: {
              realpath: async (path) => { await delay('cwd'); return f.binding.fs.realpath(path); },
              stat: async (path) => { io.push('stat'); return f.binding.fs.stat(path); },
            } };
          },
          attachments: { import: async () => { await delay('attachments'); return { imported: ['synthetic-image'], degraded: [], aliases: [] }; } } as unknown as AttachmentSync,
          projection: { warm: async () => { await delay('projection'); return 'complete'; } } as unknown as ProjectionWarmer,
          sessionController: { list: async () => { await delay('list'); return [{ sessionId: 'session-test' }]; } },
          workspace: { attach: async () => { await delay('workspace'); return { attached: true }; } } as unknown as ImportDependencies['workspace'],
        };
        // Preset resolution is conditional on the immutable remote header.
        if (phase === 'preset') {
          const manifest = await getManifest('session-test');
          assert.ok(manifest);
          const presetHeader = { ...f.remote.header, agentPreset: 'synthetic-preset' };
          const hash = headerHash(presetHeader, 0);
          const events = [f.remote.e0, f.remote.e1];
          const genesis = genesisHash('session-test', 1, hash);
          const chain = chainEvents(genesis, events);
          const row = batchRow('session-test', 1, 0, { ...chain });
          overrides = { ...overrides, repository: {
            getManifest: async () => ({ ...manifest, entity: { ...manifest.entity, headerJson: JSON.stringify(presetHeader), headerHash: hash, chainHash: chain.chainHash, lastBatchRowKey: row.rowKey, batchCount: 1 } }),
            listBatchRows: async () => [row], readCandidate: async () => gzipSync(payloadBytes(events)),
          } as unknown as CloudRepository,
          presetResolver: async () => { await delay('preset'); return true; } };
        }
        const importer = requestImporter(f, overrides);
        const pending = mode === 'initial' ? importer.import('session-test', undefined, controller.signal)
          : importer.resume('session-test', undefined, { signal: controller.signal });
        // Attach a rejection observer before advancing/aborting any provider.
        const observed = pending.catch((error: unknown) => { throw error; });
        void observed.catch(() => undefined);
        await entered.promise;
        const existing = f.records.get('session-test') ?? localSession({ sessionId: 'session-test' });
        const disabled = { ...existing, enabled: false, detached: true, state: 'disabled' as const, status: 'detached' as const };
        await put(disabled);
        controller.abort(reason);
        await rejectsPromptly(observed, reason);
        if (phase !== 'read' && phase !== 'binding' && phase !== 'preset' && phase !== 'cwd' && phase !== 'claim') assert.equal(handle?.closed, true);
        const count = io.length;
        release.resolve();
        if (phase === 'claim') await lateClose.promise;
        // Pure IO continuations may settle, but must not start another raw IO.
        for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
        assert.deepEqual(f.records.get('session-test'), disabled);
        assert.deepEqual(postAbortWrites, []);
        assert.equal(io.length, count, 'no next raw IO may begin after abort');
        assert.equal(handle?.appendCount ?? 0, ['attachments', 'projection', 'list', 'workspace'].includes(phase) ? 2 : phase === 'append' || phase === 'flush' || (phase === 'stored-read' && mode === 'initial') ? 1 : 0);
      });
    }
  }
});

test('initial/resume abort releases handles without waiting for attachment or projection IO', async (t) => {
  for (const mode of ['initial', 'resume'] as const) {
    for (const phase of ['attachments', 'projection'] as const) {
      await t.test(`${mode}/${phase}`, async (t) => {
        const f = await fixture(remoteFixture(phase === 'attachments'));
        t.after(() => rm(f.root, { recursive: true, force: true }));
        const entered = gate();
        const never = () => { entered.resolve(); return new Promise<never>(() => undefined); };
        const controller = new AbortController();
        const reason = new AzureSyncError('CANCELLED', 'Synthetic unresponsive import IO.');
        const importer = requestImporter(f, phase === 'attachments'
          ? { attachments: { import: never } as unknown as AttachmentSync }
          : { projection: { warm: never } as unknown as ProjectionWarmer });
        if (mode === 'resume') {
          await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader);
          await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'appending' }));
        }
        const pending = mode === 'initial' ? importer.import('session-test', undefined, controller.signal)
          : importer.resume('session-test', undefined, { signal: controller.signal });
        void pending.catch(() => undefined);
        await entered.promise;
        controller.abort(reason);
        await rejectsPromptly(pending, reason);
        assert.equal(f.persistence.handles.get('session-test')?.closed, true);
        assert.notEqual(f.records.get('session-test')?.importState, 'complete');
        assert.notEqual(f.records.get('session-test')?.catchUpPending, true, 'initial/resume cancellation is not cold catch-up retry intent');
      });
    }
  }
});

function remoteHistory(header: SessionHeader, events: readonly SessionEvent[], generation = 1): CloudRepository {
  const hash = headerHash(header, 0);
  const genesis = genesisHash(header.id, generation, hash);
  const chain = chainEvents(genesis, events);
  const row = batchRow(header.id, generation, 0, { ...chain });
  const manifest = {
    entity: cloudSession({ sessionId: header.id, generation, headerJson: JSON.stringify(header), headerHash: hash, eventCount: events.length, chainHash: chain.chainHash, headHash: chain.headHash, lastBatchRowKey: row.rowKey, lastBatchGeneration: generation }),
    etag: 'synthetic-history',
  };
  return { getManifest: async () => manifest, listBatchRows: async () => [row], readCandidate: async () => gzipSync(payloadBytes(events)) } as unknown as CloudRepository;
}

test('mapping reconfirmation changes pins only after immutable header/cut and entire stored prefix proof', async (t) => {
  for (const variant of ['exact', 'unconfirmed', 'new-root', 'prefix-cwd', 'prefix-payload', 'inherited-cut'] as const) {
    await t.test(variant, async (t) => {
      const f = await fixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      await mkdir(join(f.real, 'sub'));
      await mkdir(join(f.real, 'other'));
      const events = [event(0), event(1, 'working-directory/change', { cwd: '/remote/project/sub' }), event(2)] as unknown as SessionEvent[];
      const repository = remoteHistory(f.remote.header as SessionHeader, events);
      const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader, { inheritedEventCount: variant === 'inherited-cut' ? 1 : 0 });
      await handle.append([events[0], { ...events[1], data: { cwd: join(f.real, variant === 'prefix-cwd' ? 'other' : 'sub') } }] as SessionEvent[]);
      if (variant === 'prefix-payload') handle.events[0] = event(0, 'user/message', { content: [{ type: 'text', text: 'synthetic local-only text' }] }) as unknown as SessionEvent;
      handle.appendCount = 0;
      const oldPin = { id: f.binding.mapping.id, revision: f.binding.mapping.revision };
      await f.local.putSession(localSession({
        sessionId: 'session-test', importState: 'failed', status: 'mapping-unstable', mappingUnstable: true,
        catchUpPending: true, importMappingId: oldPin.id, importMappingRevision: oldPin.revision,
        imported: false,
      }));
      let newRoot = f.real;
      if (variant === 'new-root') {
        newRoot = join(f.root, 'new-root');
        await mkdir(join(newRoot, 'sub'), { recursive: true });
      }
      const binding: CwdBinding = { ...f.binding, mapping: { ...f.binding.mapping, id: 'reconfirmed-mapping', revision: 'b'.repeat(64), localPrefix: newRoot } };
      const before = structuredClone(handle.events);
      let pinWrites = 0;
      f.onWrite((record) => {
        if (record.importMappingRevision === binding.mapping.revision) pinWrites += 1;
      });
      const append = handle.append.bind(handle);
      handle.append = async (batch) => {
        assert.equal(f.records.get('session-test')?.importMappingId, binding.mapping.id, 'new pins must publish after proof and before first suffix append');
        assert.equal(f.records.get('session-test')?.importMappingRevision, binding.mapping.revision);
        assert.deepEqual(handle.events, before, 'the old local prefix must never be rewritten');
        return append(batch);
      };
      const importer = requestImporter(f, { repository, cwdBinding: async () => binding });
      const pending = importer.resume('session-test', handle as never, { confirmMapping: variant !== 'unconfirmed' });
      if (variant === 'exact') {
        const result = await pending;
        assert.equal(result.status, 'complete');
        assert.equal(handle.events.length, 3);
        assert.deepEqual(handle.events.slice(0, 2), before);
        assert.equal(handle.appendCount, 1);
        assert.equal(f.records.get('session-test')?.importMappingId, binding.mapping.id);
        assert.equal(f.records.get('session-test')?.importMappingRevision, binding.mapping.revision);
        assert.equal(f.records.get('session-test')?.mappingUnstable, true, 'the parent repair service owns clearing stopped/unstable admission flags after success');
        assert.equal(f.records.get('session-test')?.catchUpPending, false);
        assert.equal(f.records.get('session-test')?.imported, true, 'a proven native copy now retains canonical imported provenance');
        assert.equal(handle.closed, true);
      } else {
        await assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === (variant === 'unconfirmed' ? 'MAPPING_UNSTABLE' : 'PROVENANCE_MISMATCH'));
        assert.deepEqual(handle.events, before);
        assert.equal(handle.appendCount, 0);
        assert.equal(pinWrites, 0, 'not even a temporary new pin may be persisted before full proof');
        assert.equal(f.records.get('session-test')?.importMappingId, oldPin.id);
        assert.equal(f.records.get('session-test')?.importMappingRevision, oldPin.revision);
        assert.equal(f.records.get('session-test')?.mappingUnstable, true);
        assert.equal(handle.closed, false, 'ordinary repair failure retains its borrowed early claim');
      }
    });
  }
});

test('cold catch-up cannot silently replace existing completed or pending mapping pins', async (t) => {
  for (const pending of [false, true]) {
    await t.test(`pending=${pending}`, async (t) => {
      const f = await catchUpFixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const original = { ...f.records.get('session-test')!, catchUpPending: pending, importMappingId: 'original-mapping', importMappingRevision: 'c'.repeat(64) };
      await f.local.putSession(original);
      let opens = 0;
      f.persistence.open = async () => { opens += 1; return f.handle; };
      await assert.rejects(f.makeImporter().catchUp('session-test', f.remoteSession, f.options), (error: unknown) => error instanceof AzureSyncError && error.code === 'MAPPING_UNSTABLE');
      assert.equal(opens, 0);
      assert.equal(f.handle.appendCount, 0);
      assert.equal(f.records.get('session-test')?.importMappingId, original.importMappingId);
      assert.equal(f.records.get('session-test')?.importMappingRevision, original.importMappingRevision);
    });
  }
});

test('first import persists the remote generation before create, but resume never adopts a replacement generation', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const events = [f.remote.e0, f.remote.e1] as unknown as SessionEvent[];
  const gen2 = remoteHistory(f.remote.header as SessionHeader, events, 2);
  let createGeneration: number | undefined;
  let opens = 0;
  const create = f.persistence.create.bind(f.persistence);
  f.persistence.create = async (...args) => { createGeneration = f.records.get('session-test')?.generation; return create(...args); };
  await requestImporter(f, { repository: gen2 }).import('session-test');
  assert.equal(createGeneration, 2);
  assert.equal(f.records.get('session-test')?.generation, 2);
  const handle = f.persistence.handles.get('session-test')!;
  const before = structuredClone(handle.events);
  await f.local.putSession({ ...f.records.get('session-test')!, generation: 1, importState: 'appending' });
  f.persistence.open = async () => { opens += 1; return handle; };
  await assert.rejects(requestImporter(f, { repository: gen2 }).resume('session-test', undefined, { confirmMapping: true }), (error: unknown) => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  assert.equal(opens, 0);
  assert.equal(f.records.get('session-test')?.generation, 1);
  assert.deepEqual(handle.events, before);
});

test('façade keeps early claims on ordinary failure and discards them only after cancellation closes ownership', async (t) => {
  for (const method of ['importSession', 'resume'] as const) {
    await t.test(method, async (t) => {
      const f = await fixture();
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader);
      await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'failed', importMappingId: 'old-pin', importMappingRevision: 'old-revision' }));
      const claims = new EarlyImportClaims(f.persistence as unknown as SessionPersistence, f.local);
      await claims.claimAll();
      const importer = requestImporter(f);
      const service = new ImportService(importer, claims);
      await assert.rejects(service[method]('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'MAPPING_UNSTABLE');
      assert.equal(handle.closed, false);
      const retained = claims.take('session-test');
      assert.equal(retained, handle);
      claims.restore('session-test', retained!);
      const preabort = new AbortController();
      const reason = new AzureSyncError('CANCELLED', 'Synthetic cancelled façade request.');
      preabort.abort(reason);
      const cancelled = method === 'importSession' ? service.importSession('session-test', preabort.signal)
        : service.resume('session-test', { signal: preabort.signal, confirmMapping: true });
      await assert.rejects(cancelled, (error: unknown) => error === reason);
      assert.equal(claims.take('session-test'), handle, 'a pre-aborted call never borrows the early claim');
      claims.restore('session-test', handle as never);
      await f.local.putSession({ ...f.records.get('session-test')!, importMappingId: f.binding.mapping.id, importMappingRevision: f.binding.mapping.revision });
      const entered = gate();
      const controller = new AbortController();
      const blocked = new ImportService(requestImporter(f, { projection: { warm: () => { entered.resolve(); return new Promise<never>(() => undefined); } } as unknown as ProjectionWarmer }), claims);
      const pending = method === 'importSession' ? blocked.importSession('session-test', controller.signal)
        : blocked.resume('session-test', { signal: controller.signal });
      void pending.catch(() => undefined);
      await entered.promise;
      controller.abort(reason);
      await rejectsPromptly(pending, reason);
      assert.equal(handle.closed, true);
      assert.equal(claims.take('session-test'), undefined, 'closed borrowed handles must never return to early claims');
    });
  }
});

test('an un-signaled local opt-out cancels resumed finalization without restoring a closed early claim', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader);
  await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'failed' }));
  const claims = new EarlyImportClaims(f.persistence as unknown as SessionPersistence, f.local);
  await claims.claimAll();
  const entered = gate();
  const release = gate();
  const service = new ImportService(requestImporter(f, { projection: { warm: async () => { entered.resolve(); await release.promise; return 'complete'; } } as unknown as ProjectionWarmer }), claims);
  const pending = service.resume('session-test');
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await entered.promise;
  const disabled = { ...f.records.get('session-test')!, enabled: false, state: 'disabled' as const, detached: true, status: 'detached' as const };
  await f.local.putSession(disabled);
  release.resolve();
  await rejected;
  assert.deepEqual(f.records.get('session-test'), disabled);
  assert.equal(handle.closed, true);
  assert.equal(claims.take('session-test'), undefined);
});

test('synchronous root opt-out fences old initial/resume/catch-up callbacks while the local cache is still enabled', async (t) => {
  for (const mode of ['initial', 'resume', 'catch-up'] as const) {
    for (const phase of ['entry', 'read', 'binding', 'claim', 'stored-read', 'projection'] as const) {
      await t.test(`${mode}/${phase}`, async (t) => {
        const f = await catchUpFixture();
        t.after(() => rm(f.root, { recursive: true, force: true }));
        if (mode === 'initial') f.persistence.handles.delete('session-test');
        if (mode !== 'catch-up') await f.local.putSession({ ...f.records.get('session-test')!, importState: 'failed', status: 'import-incomplete' });
        const entered = gate();
        const release = gate();
        const lateClose = gate();
        let optingOut = phase === 'entry';
        let writes = 0;
        let creates = 0;
        let opens = 0;
        let reads = 0;
        f.onWrite(() => { writes += 1; });
        const delay = async (name: string) => {
          if (phase === name) { entered.resolve(); await release.promise; }
        };
        const watchHandle = (handle: FakeHandle) => {
          const read = handle.read.bind(handle);
          const close = handle.close.bind(handle);
          handle.read = async (...args) => { await delay('stored-read'); return read(...args); };
          handle.close = async () => { await close(); lateClose.resolve(); };
          return handle;
        };
        if (mode !== 'initial') watchHandle(f.handle);
        const create = f.persistence.create.bind(f.persistence);
        f.persistence.create = async (...args) => { creates += 1; await delay('claim'); return watchHandle(await create(...args)); };
        const open = f.persistence.open.bind(f.persistence);
        f.persistence.open = async (...args) => { opens += 1; await delay('claim'); return open(...args); };
        const getManifest = f.remote.repository.getManifest.bind(f.remote.repository);
        const repository = {
          ...f.remote.repository,
          getManifest: async (...args: Parameters<CloudRepository['getManifest']>) => { reads += 1; await delay('read'); return getManifest(...args); },
        } as unknown as CloudRepository;
        const overrides: Partial<ImportDependencies> = {
          repository,
          isOptingOut: (sid) => sid === 'session-test' && optingOut,
          cwdBinding: async () => { await delay('binding'); return f.binding; },
          projection: { warm: async () => { await delay('projection'); return 'complete'; } } as unknown as ProjectionWarmer,
        };
        // Retain an old source reference across a simulated core rebuild. Both
        // versions observe root intent independently of durable-cache visibility.
        const oldImporter = mode === 'catch-up' ? f.makeImporter(overrides) : requestImporter(f, overrides);
        const currentImporter = mode === 'catch-up' ? f.makeImporter(overrides) : requestImporter(f, overrides);
        const invoke = (importer: Importer) => mode === 'initial' ? importer.import('session-test')
          : mode === 'resume' ? importer.resume('session-test')
            : importer.catchUp('session-test', f.remoteSession, f.options);
        const original = structuredClone(f.records.get('session-test'));
        const pending = invoke(oldImporter);
        const rejected = assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
        if (phase !== 'entry') await entered.promise;
        const recordAtOff = structuredClone(f.records.get('session-test'));
        const handleAtOff = f.persistence.handles.get('session-test');
        const eventsAtOff = structuredClone(handleAtOff?.events ?? []);
        const appendsAtOff = handleAtOff?.appendCount ?? 0;
        const writesAtOff = writes;
        optingOut = true; // durableOff has not updated getSession yet.
        assert.equal(f.local.getSession('session-test')?.enabled, true);
        release.resolve();
        await rejected;
        if (phase === 'claim') await lateClose.promise;
        const handle = f.persistence.handles.get('session-test');
        assert.deepEqual(f.records.get('session-test'), recordAtOff, 'neither failure checkpoints nor collision rollback may overwrite the pending off write');
        assert.equal(writes, writesAtOff);
        assert.deepEqual(handle?.events ?? [], eventsAtOff);
        assert.equal(handle?.appendCount ?? 0, appendsAtOff, 'no later suffix append is allowed while opting out');
        if (phase === 'claim' || phase === 'stored-read' || phase === 'projection') assert.equal(handle?.closed, true);
        if (phase === 'entry') {
          assert.deepEqual(f.records.get('session-test'), original);
          assert.equal(creates, 0);
          assert.equal(opens, 0);
          assert.equal(reads, 0);
        }
        const counts = { writes, creates, opens, reads };
        await assert.rejects(invoke(currentImporter), (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
        assert.deepEqual({ writes, creates, opens, reads }, counts, 'a rebuilt source must also reject before IO despite the stale enabled cache');
        assert.deepEqual(f.records.get('session-test'), recordAtOff);
      });
    }
  }
});

test('root opt-out prevents an old create collision from restoring stale enabled metadata', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.local.putSession(localSession({ sessionId: 'session-test', status: 'synced' }));
  let optingOut = false;
  let writes = 0;
  let deletes = 0;
  f.onWrite(() => { writes += 1; });
  f.local.deleteSession = async () => { deletes += 1; return true; };
  f.persistence.create = async () => {
    optingOut = true;
    throw new SessionAlreadyExistsError('session-test' as never);
  };
  const importer = requestImporter(f, { isOptingOut: () => optingOut });
  await assert.rejects(importer.import('session-test'), (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(f.local.getSession('session-test')?.enabled, true);
  assert.equal(f.local.getSession('session-test')?.importState, 'planned', 'the last safe checkpoint is preserved instead of restored or failed');
  assert.equal(writes, 1, 'only the pre-opt-out planned checkpoint is allowed');
  assert.equal(deletes, 0);
});

test('startup repair discards its early claim on pending root opt-out without a stale-cache write', async (t) => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const handle = await f.persistence.create({ ...f.remote.header, cwd: f.real } as SessionHeader);
  await f.local.putSession(localSession({ sessionId: 'session-test', importState: 'failed' }));
  const claims = new EarlyImportClaims(f.persistence as unknown as SessionPersistence, f.local);
  await claims.claimAll();
  const entered = gate();
  const release = gate();
  let optingOut = false;
  let writes = 0;
  f.onWrite(() => { writes += 1; });
  const service = new ImportService(requestImporter(f, {
    isOptingOut: () => optingOut,
    cwdBinding: async () => { entered.resolve(); await release.promise; return f.binding; },
  }), claims);
  const original = structuredClone(f.records.get('session-test'));
  const pending = service.resume('session-test');
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await entered.promise;
  optingOut = true;
  release.resolve();
  await rejected;
  assert.equal(f.local.getSession('session-test')?.enabled, true, 'the durable off write is still pending');
  assert.deepEqual(f.records.get('session-test'), original);
  assert.equal(writes, 0);
  assert.deepEqual(handle.events, []);
  assert.equal(handle.closed, true);
  assert.equal(claims.take('session-test'), undefined, 'a canceled repair must not restore its closed early claim');
});

test('SDK-chain checkpoints reject a newer detached CID even when the old runtime read cache remains enabled', async (t) => {
  for (const mode of ['initial-missing', 'initial-existing', 'resume-status', 'resume-claimed', 'resume-pins', 'cold', 'collision-missing', 'collision-existing'] as const) {
    await t.test(mode, async (t) => {
      const f = await catchUpFixture();
      const host = new Context();
      new Storage(host);
      const backend = new JsonStorageBackend(resolve(f.root, 'sidecar'));
      host.storage.backend.register('import-atomic-json', backend);
      const facility = new DomainFacility(host, { backend: 'import-atomic-json' });
      const local = new LocalStore(facility);
      await local.open();
      const domain = facility.get(localDomain.name);
      assert.ok(domain);
      // Another runtime writes through the actual public SDK table, outside
      // this LocalStore instance's private transaction lane and read snapshot.
      const otherRuntime = domain.table('sessions');
      t.after(async () => {
        await local.close();
        await facility.closeAll();
        await backend.close();
        await rm(f.root, { recursive: true, force: true });
      });
      const collision = mode === 'collision-missing' || mode === 'collision-existing';
      const initial = mode === 'initial-missing' || mode === 'initial-existing' || collision;
      if (initial && !collision) f.persistence.handles.delete('session-test');
      if (mode !== 'initial-missing' && mode !== 'collision-missing') await local.putSession(localSession({
        sessionId: 'session-test', importState: mode === 'cold' ? 'complete' : 'failed',
        status: mode === 'cold' ? 'synced' : 'mapping-unstable',
        localCwd: f.real, canonicalCwd: '/remote/project', mappingUnstable: mode !== 'cold',
        admissionStopped: mode !== 'cold', importMappingId: f.binding.mapping.id,
        importMappingRevision: f.binding.mapping.revision,
      }));
      const beforeEvents = structuredClone(f.persistence.handles.get('session-test')?.events ?? []);
      const claims = mode === 'resume-claimed' ? new EarlyImportClaims(f.persistence as unknown as SessionPersistence, local) : undefined;
      await claims?.claimAll();
      let opens = 0;
      let creates = 0;
      const open = f.persistence.open.bind(f.persistence);
      const create = f.persistence.create.bind(f.persistence);
      f.persistence.open = async (...args) => { opens += 1; return open(...args); };
      f.persistence.create = async (...args) => { creates += 1; return create(...args); };
      const entered = gate();
      const release = gate();
      const transact = local.transactSession.bind(local);
      let transactions = 0;
      let callbacks = 0;
      local.transactSession = async (id, fn) => {
        transactions += 1;
        if (transactions === (mode === 'collision-existing' ? 2 : 1) && mode !== 'collision-missing') { entered.resolve(); await release.promise; }
        return transact(id, (latest) => { callbacks += 1; return fn(latest); });
      };
      if (mode === 'collision-missing') {
        const deleteIf = local.deleteSessionIf.bind(local);
        local.deleteSessionIf = async (id, predicate) => {
          entered.resolve();
          await release.promise;
          return deleteIf(id, (latest) => { callbacks += 1; return predicate(latest); });
        };
      }
      const newBinding = { ...f.binding, mapping: { ...f.binding.mapping, id: pathMapping().id, revision: 'b'.repeat(64) } };
      const importer = requestImporter(f, {
        local,
        cwdBinding: async () => mode === 'resume-status' || mode === 'resume-claimed' ? undefined : mode === 'resume-pins' ? newBinding : f.binding,
      });
      const pending = mode === 'cold' ? importer.catchUp('session-test', f.remoteSession, f.options)
        : initial ? importer.import('session-test')
          : mode === 'resume-claimed' ? new ImportService(importer, claims).resume('session-test')
            : importer.resume('session-test', undefined, { confirmMapping: mode === 'resume-pins' });
      const rejected = assert.rejects(pending, (error: unknown) => error instanceof AzureSyncError && error.code === 'CANCELLED');
      await entered.promise;
      const stale = local.getSession('session-test');
      const liveGet = local.getSession.bind(local);
      local.getSession = (id) => id === 'session-test' ? stale : liveGet(id);
      const detached = localSession({
        ...(stale ?? localSession({ sessionId: 'session-test' })), enabled: false, detached: true,
        state: 'disabled', status: 'detached', admissionStopped: false, mappingUnstable: true,
        resurrectionCancellationId: pathMapping().id,
        importMappingId: pathMapping().id, importMappingRevision: 'c'.repeat(64),
      });
      await otherRuntime.put('session-test', detached);
      const expected = otherRuntime.get('session-test');
      assert.deepEqual(local.getSession('session-test'), stale, 'the old runtime still has its pre-off snapshot');
      release.resolve();
      await rejected;
      assert.ok(callbacks >= 1, 'the actual SDK update callback evaluated the latest other-runtime record');
      assert.deepEqual(otherRuntime.get('session-test'), expected, 'no status, mapping pin, stopped flag, or import metadata may be restored');
      assert.deepEqual(f.persistence.handles.get('session-test')?.events ?? [], beforeEvents);
      assert.equal(creates, collision ? 1 : 0, 'only the already-failed create may precede a collision rollback checkpoint');
      assert.equal(opens, mode === 'resume-pins' ? 1 : 0, 'a canceled planned/status checkpoint must not start a writer');
      if (mode === 'resume-pins' || mode === 'resume-claimed') assert.equal(f.handle.closed, true, 'acquired and borrowed claims are released even with a stale cache');
      if (claims !== undefined) assert.equal(claims.take('session-test'), undefined, 'a revoked startup repair cannot restore its closed borrowed handle');
      local.getSession = liveGet;
      assert.deepEqual(local.getSession('session-test'), expected);
    });
  }
});

test('late old import finalization cannot overwrite a newer successful resume', async (t) => {
  for (const phase of ['attachments', 'projection'] as const) {
    await t.test(phase, async (t) => {
      const f = await fixture(remoteFixture(phase === 'attachments'));
      t.after(() => rm(f.root, { recursive: true, force: true }));
      const entered = gate();
      const release = gate();
      let calls = 0;
      const delayed = async () => { if (++calls === 1) { entered.resolve(); await release.promise; } };
      const importer = requestImporter(f, phase === 'attachments'
        ? { attachments: { import: async () => { await delayed(); return { imported: ['synthetic-image'], degraded: [], aliases: [] }; } } as unknown as AttachmentSync }
        : { projection: { warm: async () => { await delayed(); return 'complete'; } } as unknown as ProjectionWarmer });
      const controller = new AbortController();
      const reason = new AzureSyncError('CANCELLED', 'Synthetic old request.');
      const pending = importer.import('session-test', undefined, controller.signal);
      void pending.catch(() => undefined);
      await entered.promise;
      controller.abort(reason);
      await rejectsPromptly(pending, reason);
      const appends = f.persistence.handles.get('session-test')!.appendCount;
      await importer.resume('session-test');
      const completed = structuredClone(f.records.get('session-test'));
      release.resolve();
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
      assert.deepEqual(f.records.get('session-test'), completed);
      assert.equal(f.persistence.handles.get('session-test')!.appendCount, appends);
      assert.equal(calls, 2);
    });
  }
});
