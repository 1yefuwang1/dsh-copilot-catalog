import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableClient, TransactionAction } from '@azure/data-tables';
import { DomainError, type DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { Config } from '../src/config.js';
import { CloudController, type CloudCore } from '../src/controller.js';
import { CloudControlError } from '../src/protocol.js';
import { SettingsService } from '../src/settings.js';
import { AzureSyncError } from '../src/azure/errors.js';
import type { BlobStore } from '../src/azure/blob.js';
import type { LeaseHandle, LeaseManager } from '../src/azure/lease.js';
import { TableStore } from '../src/azure/table.js';
import { LocalStore } from '../src/local/store.js';
import { encodeCloudRecord, type CloudSessionEntity, type LocalSessionRecord } from '../src/schema.js';
import { planBatch } from '../src/sync/batcher.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { CloudRepository, candidateBlobName, leaseBlobName } from '../src/sync/cloud-repository.js';
import { SessionLeaseManager } from '../src/sync/lease-manager.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { SyncService } from '../src/sync/service.js';
import { PersistenceSessionSource, type SourceSnapshot } from '../src/sync/session-source.js';
import { Uploader } from '../src/sync/uploader.js';
import { batchRow, cloudSession, event, localSession, sessionHeader } from './helpers.js';

const id = 'control-cancel-session';
const owner = 'device-current';
const now = 10_000;
const clone = <T>(value: T): T => structuredClone(value);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function outcome<T>(work: Promise<T>) {
  return work.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
}

async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 500); });
  try { return await Promise.race([work, expired]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const isCancelled = (error: unknown) => (error instanceof AzureSyncError || error instanceof CloudControlError) && error.code === 'CANCELLED';
const isEnableCancelled = (error: unknown) => isCancelled(error) || (error instanceof Error && error.name === 'AbortError');

/** Real control/service/uploader/lease/repository/local/source classes; fake only persistence and cloud transports. */
async function fixture(options: { prior?: 'enabled' | 'detached' | 'untracked'; remote?: boolean; live?: boolean; agentStatus?: 'idle' | 'running' } = {}) {
  const snapshot: SourceSnapshot = { header: sessionHeader({ id }) as never, inheritedEventCount: 0, events: [event(0), event(1)] as never };
  const writes: LocalSessionRecord[] = [];
  const tables = new Map<string, Map<string, unknown>>();
  const domains = { async open() {
    return { table(name: string) {
      let values = tables.get(name);
      if (values === undefined) { values = new Map(); tables.set(name, values); }
      const records = values;
      let lane = Promise.resolve();
      const write = <T>(task: () => T): Promise<T> => {
        const run = lane.then(task);
        lane = run.then(() => undefined, () => undefined);
        return run;
      };
      const saveRecord = (key: string, value: unknown) => {
        records.set(key, clone(value));
        if (name === 'sessions') writes.push(clone(value) as LocalSessionRecord);
      };
      return {
        get: (key: string) => clone(records.get(key)),
        put: (key: string, value: unknown) => write(() => { saveRecord(key, value); }),
        update: (key: string, fn: (current: unknown) => unknown) => write(() => {
          if (!records.has(key)) throw new DomainError('missing-key', 'The fixture record does not exist.');
          const next = fn(clone(records.get(key)));
          saveRecord(key, next); return clone(next);
        }),
        entries: () => new Map([...records].map(([key, value]) => [key, clone(value)])).entries(),
        delete: (key: string) => write(() => records.delete(key)),
      };
    }, async close() {} };
  } } as unknown as DomainFacility;
  const local = new LocalStore(domains); await local.open();
  const prior = options.prior ?? 'enabled';
  if (prior !== 'untracked') await local.putSession(localSession({ sessionId: id, writerEpoch: 7,
    ...(prior === 'detached' ? { enabled: false, detached: true, state: 'disabled', status: 'detached' } : { status: 'ownership-unverified' }),
  }));
  writes.length = 0;
  const source = new PersistenceSessionSource({
    async flush() {},
    async open(sessionId: string, mode: string) {
      assert.equal(sessionId, id); assert.equal(mode, 'read', 'proof/upload must not open a local write handle');
      return { header: clone(snapshot.header), inheritedEventCount: snapshot.inheritedEventCount,
        async read(from: number) { assert.equal(from, 0); return { events: clone(snapshot.events) }; }, async close() {} };
    },
    async stat() { return { header: clone(snapshot.header), eventCount: snapshot.events.length }; },
  } as unknown as SessionPersistence);

  const rows = new Map<string, Record<string, unknown>>();
  const blobs = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
  let revision = 0;
  let creates = 0;
  let transactions = 0;
  let candidatePuts = 0;
  const save = (entity: Record<string, unknown>) => { rows.set(String(entity['rowKey']), { ...clone(entity), etag: `etag-${++revision}` }); };
  const hooks: {
    beforeRead?: () => Promise<void>;
    beforeUpdate?: (entity: Record<string, unknown>) => Promise<void>;
    afterUpdate?: (entity: Record<string, unknown>) => Promise<void>;
    acquireResponse?: (handle: LeaseHandle) => Promise<LeaseHandle>;
    renewResponse?: () => Promise<void>;
    released?: () => void;
  } = {};
  const client = {
    async getEntity(_partition: string, key: string) {
      await hooks.beforeRead?.();
      const row = rows.get(key); if (row === undefined) throw { statusCode: 404 }; return clone(row);
    },
    async createEntity(entity: Record<string, unknown>) {
      if (rows.has(String(entity['rowKey']))) throw { statusCode: 409 };
      creates++; save(entity);
    },
    async updateEntity(entity: Record<string, unknown>, _mode: string, input: { etag: string }) {
      await hooks.beforeUpdate?.(entity);
      if (rows.get(String(entity['rowKey']))?.['etag'] !== input.etag) throw { statusCode: 412 };
      save(entity);
      await hooks.afterUpdate?.(entity);
    },
    async submitTransaction(actions: TransactionAction[]) {
      for (const action of actions) {
        const key = action[1].rowKey;
        if (action[0] === 'create' && rows.has(key)) throw { statusCode: 409 };
        if (action[0] === 'update' && rows.get(key)?.['etag'] !== action[3]?.etag) throw { statusCode: 412 };
      }
      for (const action of actions) { assert.ok(action[0] === 'create' || action[0] === 'update'); save(action[1]); }
      transactions++; return { status: 202, subResponses: [] };
    },
    async *listEntities() { for (const [key, value] of rows) if (key.startsWith('batch:')) yield clone(value); },
  } as unknown as TableClient;
  const blob = {
    async read(name: string) { const value = blobs.get(name); assert.ok(value); return Buffer.from(value.bytes); },
    async putIfAbsent(name: string, bytes: Uint8Array, metadata: Record<string, string>) {
      if (blobs.has(name)) return 'exists';
      candidatePuts++; blobs.set(name, { bytes: Buffer.from(bytes), metadata: clone(metadata) }); return 'created';
    },
    async getMetadata(name: string) { return clone(blobs.get(name)?.metadata ?? {}); },
    async *list(prefix: string) { for (const [name, value] of blobs) if (name.startsWith(prefix)) yield { name, sizeBytes: value.bytes.byteLength }; },
  } as unknown as BlobStore;
  const repository = new CloudRepository(blob, new TableStore(client));
  if (options.remote !== false) {
    const binding = headerHash(snapshot.header, 0);
    const genesis = genesisHash(id, 1, binding);
    const chain = chainEvents(genesis, snapshot.events);
    const plan = planBatch(snapshot.events, 0, { maxEvents: 1_000, maxBytes: 1_048_576 }, genesis); assert.ok(plan);
    const name = candidateBlobName(id, 1, 0, 7, plan.payloadHash);
    const row = batchRow(id, 1, 0, { endSeq: 1, eventCount: 2, blobName: name, payloadHash: plan.payloadHash,
      prevChainHash: genesis, chainHash: plan.chain.chainHash, headHash: plan.chain.headHash, createdEpoch: 7 });
    save(encodeCloudRecord(row)); blobs.set(name, { bytes: plan.gzip, metadata: {} });
    const manifest: CloudSessionEntity = cloudSession({ sessionId: id, writerEpoch: 7,
      headerJson: JSON.stringify(snapshot.header), headerHash: binding, chainHash: chain.chainHash, headHash: chain.headHash,
      eventCount: 2, headSeq: 1, batchCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: name });
    save(encodeCloudRecord(manifest));
  }
  let active: LeaseHandle | undefined;
  let acquires = 0;
  let releases = 0;
  let renews = 0;
  const raw = {
    async acquire(name: string) {
      assert.equal(name, leaseBlobName(id));
      if (active !== undefined) throw new AzureSyncError('CONFLICT', 'Server lease remains held.');
      const handle = { leaseId: `lease-${++acquires}`, client: {} as never };
      active = handle; // The server accepts ownership before the caller receives its response.
      return hooks.acquireResponse === undefined ? handle : hooks.acquireResponse(handle);
    },
    async renew(handle: LeaseHandle) {
      renews++; assert.equal(active?.leaseId, handle.leaseId);
      await hooks.renewResponse?.(); // Renewal was accepted before this response is delayed.
    },
    async release(handle: LeaseHandle) {
      releases++;
      if (active?.leaseId === handle.leaseId) active = undefined;
      hooks.released?.();
    },
  } as unknown as LeaseManager;
  const config = Config({});
  const reader = new RemoteSessionReader(repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 1_048_576 });
  const agent = { status: options.agentStatus ?? 'idle', inbox: { nextTurn: [], nextStep: [] } };
  const runtimes: Array<{ uploader: Uploader; service: SyncService }> = [];
  const rebuild = () => {
    const leases = new SessionLeaseManager({ repository, leases: raw, deviceId: owner, now: () => now });
    const uploader = new Uploader({ config, source, repository, leases, local, deviceId: owner, platform: 'linux', now: () => now, renewEveryMs: 60_000 });
    const service = new SyncService({ uploader, local, source, reader, repository, now: () => now, ownershipProofMs: 10_000,
      agents: { get: () => options.live ? agent as never : undefined } });
    runtimes.push({ uploader, service });
    return { leases, uploader, service };
  };
  const { leases, uploader, service } = rebuild();
  const coreLifetime = new AbortController();
  const core: CloudCore = { service, repository, signal: coreLifetime.signal, testAuth: async () => undefined };
  const controller = new CloudController({ local, settings: new SettingsService({ local, config }), core: async () => core, current: () => core });
  return { local, source, writes, hooks, repository, uploader, leases, service, controller, core, coreLifetime, rebuild,
    record: () => local.getSession(id),
    expireLease: () => { active = undefined; },
    claimForeignLease: () => { assert.equal(active, undefined); active = { leaseId: 'foreign-server-lease', client: {} as never }; },
    counts: () => ({ creates, transactions, candidatePuts, acquires, releases, renews, active: active?.leaseId }),
    async dispose() {
      controller.close();
      for (const runtime of runtimes) { await runtime.uploader.pause(id); await runtime.service.close(100); }
      await local.close();
    },
  };
}

for (const prior of ['untracked', 'detached'] as const) {
  test(`cancelled queued enable cannot opt in a previously ${prior} local copy or permit a later upload`, { timeout: 3_000 }, async () => {
    const f = await fixture({ prior, remote: false });
    const entered = deferred<void>(); const oldResponse = deferred<void>();
    f.hooks.beforeRead = async () => { f.hooks.beforeRead = undefined; entered.resolve(); await oldResponse.promise; };
    const previous = f.uploader.disable(id);
    let enabled: ReturnType<typeof outcome> | undefined;
    try {
      await bounded(entered.promise, 'the old uploader task must reach its stalled cloud read');
      assert.notEqual(f.record()?.enabled, true, 'the old task has no opt-in permission');
      const baseline = f.writes.length;
      const request = new AbortController();
      enabled = outcome(f.service.enable(id, request.signal));
      request.abort(); // beginEnableIntent is still queued behind the old uploader task.
      oldResponse.resolve(); await previous;
      const result = await enabled;
      assert.equal(result.ok, false); if (!result.ok) assert.ok(isEnableCancelled(result.error));
      const intentWrites = f.writes.slice(baseline);
      // Exercise a subsequent ordinary sync, not another enable/resume request.
      const later = await f.service.sync(id);
      assert.equal(intentWrites.some(record => record.enabled || !record.detached), false, 'cancellation must precede every durable opt-in write');
      assert.notEqual(f.record()?.enabled, true);
      assert.equal(later.status, 'disabled');
      assert.equal(await f.repository.getManifest(id), undefined, 'cancelled enable must not grant later cloud-creation permission');
      assert.equal(f.counts().creates, 0); assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().transactions, 0);
      assert.equal(f.counts().acquires, 0); assert.equal(f.uploader.hasHeld(id), false);
    } finally { oldResponse.resolve(); await previous; await enabled; await f.dispose(); }
  });
}

test('the same queued enable with live consent creates and uploads the durable local history', { timeout: 3_000 }, async () => {
  const f = await fixture({ prior: 'untracked', remote: false });
  const entered = deferred<void>(); const oldResponse = deferred<void>();
  f.hooks.beforeRead = async () => { f.hooks.beforeRead = undefined; entered.resolve(); await oldResponse.promise; };
  const previous = f.uploader.disable(id);
  let enabled: Promise<unknown> | undefined;
  try {
    await bounded(entered.promise, 'the old uploader task must reach its stalled cloud read');
    enabled = f.service.enable(id, new AbortController().signal);
    oldResponse.resolve(); await previous;
    assert.deepEqual(await enabled, { status: 'synced', eventCount: 2, uploadedBatches: 1 });
    assert.equal(f.record()?.enabled, true); assert.equal(f.record()?.detached, false);
    assert.equal((await f.repository.getManifest(id))?.entity.eventCount, 2);
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().candidatePuts, 1); assert.equal(f.counts().transactions, 1);
  } finally { oldResponse.resolve(); await previous; await enabled; await f.dispose(); }
});

for (const cancellation of ['request', 'core'] as const) {
  test(`controller ownership ${cancellation} cancellation releases a server-accepted late acquire exactly once`, { timeout: 3_000 }, async () => {
    const f = await fixture();
    const entered = deferred<LeaseHandle>(); const response = deferred<LeaseHandle>(); const released = deferred<void>();
    f.hooks.acquireResponse = async (handle) => { entered.resolve(handle); return response.promise; };
    f.hooks.released = () => released.resolve();
    const request = new AbortController();
    const result = outcome(f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'rpc', signal: request.signal }));
    let accepted: LeaseHandle | undefined;
    try {
      accepted = await bounded(entered.promise, 'the proof must reach a server-accepted acquisition');
      assert.equal(f.counts().active, accepted.leaseId, 'ownership has already been accepted by the server');
      const baseline = f.writes.length;
      (cancellation === 'request' ? request : f.coreLifetime).abort();
      const cancelled = await bounded(result, 'ownership cancellation must settle before an uncooperative acquire responds');
      assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
      assert.equal(f.uploader.hasHeld(id), false);
      response.resolve(accepted); await bounded(released.promise, 'late accepted acquisition must be released'); await turn();
      assert.equal(f.counts().acquires, 1); assert.equal(f.counts().releases, 1); assert.equal(f.counts().active, undefined);
      assert.equal(f.uploader.hasHeld(id), false);
      assert.equal(f.writes.slice(baseline).some(record => record.status === 'syncing'), false, 'late success must not publish local writer status');
      assert.equal(f.record()?.writerEpoch, 7);
      const remote = await f.repository.getManifest(id); assert.ok(remote);
      assert.equal(remote.entity.writerEpoch, 7); assert.equal(remote.entity.leaseOwner, undefined);
    } finally { if (accepted !== undefined) response.resolve(accepted); await result; await f.dispose(); }
  });
}

test('controller cancellation during an accepted held-lease renewal drops the hold with bounded cleanup, including its late response', { timeout: 3_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture({ live: true });
  const entered = deferred<void>(); const response = deferred<void>(); const released = deferred<void>();
  let result: ReturnType<typeof outcome> | undefined;
  try {
    assert.deepEqual(await f.uploader.ensureOwnership(id), { owned: true });
    assert.equal(f.uploader.hasHeld(id), true); f.writes.length = 0;
    f.hooks.renewResponse = async () => { entered.resolve(); await response.promise; };
    f.hooks.released = () => released.resolve();
    const request = new AbortController();
    result = outcome(f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'rpc', signal: request.signal }));
    await bounded(entered.promise, 'the held proof must reach its accepted renewal');
    const baseline = f.writes.length;
    request.abort();
    const cancelled = await bounded(result, 'held renewal cancellation must settle before the raw renewal response');
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
    await bounded(released.promise, 'cancellation must release the already-held server lease immediately');
    assert.equal(f.uploader.hasHeld(id), false);
    response.resolve(); await turn();
    // Unlike a newly acquired handle (exactly once above), renewal already has
    // an owner. Its immediate cancellation cleanup and a separately arriving
    // accepted renewal may both issue idempotent release calls. Permit only
    // these bounded cleanup calls, never retained authority or new renewal IO.
    assert.ok(f.counts().releases >= 1 && f.counts().releases <= 3, 'renewal cleanup is bounded and idempotent');
    const releases = f.counts().releases;
    t.mock.timers.tick(180_000); await turn();
    assert.equal(f.counts().acquires, 1); assert.equal(f.counts().renews, 1, 'cancelled ownership must remove the periodic renewal timer');
    assert.equal(f.counts().releases, releases, 'no new lease IO follows completed cancellation cleanup');
    assert.equal(f.counts().active, undefined);
    assert.equal(f.writes.slice(baseline).some(record => record.status === 'syncing'), false);
    assert.equal((await f.repository.getManifest(id))?.entity.leaseOwner, undefined);
  } finally { response.resolve(); await result; await f.dispose(); }
});

test('a cold manual controller ownership inspection releases its proof lease instead of renewing it forever', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture();
  try {
    const result = await f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'rpc', signal: new AbortController().signal });
    assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result));
    assert.deepEqual(result['detail'], { owned: true });
    assert.equal(f.counts().acquires, 1); assert.equal(f.counts().releases, 1);
    assert.equal(f.uploader.hasHeld(id), false); assert.equal(f.counts().active, undefined);
    assert.equal((await f.repository.getManifest(id))?.entity.leaseOwner, undefined);
    t.mock.timers.tick(180_000); await turn();
    assert.equal(f.counts().renews, 0, 'cold/manual inspection must not leave a periodic renewal timer');
    assert.equal(f.counts().releases, 1);
  } finally { await f.dispose(); }
});

test('manual ownership inspection of a retained idle Agent schedules the normal quiet drain, not immediate release', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = await fixture({ live: true });
  try {
    await f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'rpc', signal: new AbortController().signal });
    assert.equal(f.uploader.hasHeld(id), true); assert.equal(f.counts().releases, 0);
    t.mock.timers.tick(2_100); await turn();
    assert.equal(f.uploader.hasHeld(id), false, 'manual proof with an idle Agent must have a scheduled quiet-drain owner');
    assert.equal(f.counts().releases, 1); assert.equal(f.counts().active, undefined);
    assert.equal((await f.repository.getManifest(id))?.entity.eventCount, 2, 'drain preserves the verified committed history');
  } finally { await f.dispose(); }
});

test('active Agent manual inspection and native pre-step ownership proofs retain lifecycle authority', async () => {
  const f = await fixture({ live: true, agentStatus: 'running' });
  try {
    await f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'command', signal: new AbortController().signal });
    assert.equal(f.uploader.hasHeld(id), true); assert.equal(f.counts().releases, 0);
    assert.deepEqual(await f.service.ensureOwnership(id), { owned: true });
    assert.equal(f.uploader.hasHeld(id), true); assert.equal(f.counts().releases, 0);
    assert.equal(f.counts().acquires, 1); assert.equal(f.counts().renews, 1);
    assert.equal((await f.repository.getManifest(id))?.entity.leaseOwner, owner);
  } finally { await f.dispose(); }
});

test('a newer opt-out preempts an older enable awaiting core setup before any uploader token exists', { timeout: 3_000 }, async () => {
  const f = await fixture({ prior: 'detached', remote: false });
  const entered = deferred<void>(); const response = deferred<void>();
  let enables = 0;
  const enable = f.service.enable.bind(f.service);
  f.service.enable = async (...args) => { enables++; return enable(...args); };
  const controller = new CloudController({ local: f.local, settings: new SettingsService({ local: f.local, config: Config({}) }),
    core: async () => { entered.resolve(); await response.promise; return f.core; }, current: () => undefined });
  const older = outcome(controller.execute({ action: 'toggle', enabled: true, sessionId: id }, { origin: 'rpc', signal: new AbortController().signal }));
  try {
    await bounded(entered.promise, 'the older controller request must reach stalled core setup');
    assert.equal(enables, 0, 'the older enable has not reached SyncService or received an uploader intent token');
    const baseline = f.writes.length;
    await bounded(controller.execute({ action: 'toggle', enabled: false, sessionId: id }, { origin: 'rpc', signal: new AbortController().signal }), 'local opt-out must not wait for older core setup');
    assert.ok(f.writes.length > baseline, 'the newer opt-out must be durably saved before setup resumes');
    assert.equal(f.record()?.enabled, false); assert.equal(f.record()?.detached, true);
    const cancelled = await bounded(older, 'superseded core setup must not occupy the controller queue forever');
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
    response.resolve(); await turn();
    assert.equal(enables, 0, 'the late core result must not dispatch the obsolete enable');
    assert.equal(f.writes.slice(baseline).some(record => record.enabled || !record.detached), false);
    assert.equal((await f.service.sync(id)).status, 'disabled');
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().candidatePuts, 0);
  } finally { response.resolve(); await older; controller.close(); await f.dispose(); }
});

test('a newer opt-out invalidates an older queued enable behind an unrelated stalled request before its dispatch', { timeout: 3_000 }, async () => {
  const f = await fixture({ prior: 'detached', remote: false });
  const entered = deferred<void>(); const response = deferred<void>();
  let enables = 0; let coreCalls = 0;
  const enable = f.service.enable.bind(f.service);
  f.service.enable = async (...args) => { enables++; return enable(...args); };
  const core: CloudCore = { ...f.core, testAuth: async () => { entered.resolve(); await response.promise; } };
  const controller = new CloudController({ local: f.local, settings: new SettingsService({ local: f.local, config: Config({}) }),
    core: async () => { coreCalls++; return core; }, current: () => core });
  const unrelated = outcome(controller.execute({ action: 'test-auth' }, { origin: 'rpc', signal: new AbortController().signal }));
  let older: ReturnType<typeof outcome> | undefined;
  try {
    await bounded(entered.promise, 'the unrelated auth request must reach its stalled transport');
    older = outcome(controller.execute({ action: 'toggle', enabled: true, sessionId: id }, { origin: 'rpc', signal: new AbortController().signal }));
    const baseline = f.writes.length;
    await bounded(controller.execute({ action: 'toggle', enabled: false, sessionId: id }, { origin: 'rpc', signal: new AbortController().signal }), 'local opt-out must bypass unrelated stalled cloud work');
    assert.ok(f.writes.length > baseline);
    assert.equal(f.record()?.enabled, false); assert.equal(f.record()?.detached, true);
    assert.equal(enables, 0); assert.equal(coreCalls, 1, 'the old enable is still queued, not in setup or service');
    response.resolve();
    assert.equal((await unrelated).ok, true);
    const cancelled = await bounded(older, 'the obsolete queued enable must reject before dispatch');
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
    assert.equal(enables, 0); assert.equal(coreCalls, 1);
    assert.equal(f.writes.slice(baseline).some(record => record.enabled || !record.detached), false);
    assert.equal((await f.service.sync(id)).status, 'disabled');
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().candidatePuts, 0);
  } finally { response.resolve(); await unrelated; await older; controller.close(); await f.dispose(); }
});

test('a timed-out old-runtime opt-out queued behind stalled IO cannot disable a replacement runtime enable', { timeout: 3_000 }, async () => {
  const f = await fixture();
  const entered = deferred<void>(); const response = deferred<void>();
  const flush = f.source.flush.bind(f.source);
  let first = true;
  f.source.flush = async () => { if (first) { first = false; entered.resolve(); await response.promise; } await flush(); };
  const oldSync = outcome(f.uploader.sync(id, { release: false }));
  try {
    await bounded(entered.promise, 'the original uploader must reach stalled source IO');
    await bounded(f.uploader.disable(id, 10), 'local opt-out must return within its short deadline');
    assert.equal(f.record()?.enabled, false); assert.equal(f.record()?.detached, true);
    const oldNonce = f.record()?.resurrectionCancellationId;
    await bounded(f.service.close(10), 'retiring the old runtime must stay bounded');
    const replacement = f.rebuild();
    assert.equal((await replacement.service.enable(id)).status, 'synced');
    const localAfterEnable = clone(f.record());
    const remoteAfterEnable = await f.repository.getManifest(id);
    assert.equal(localAfterEnable?.enabled, true); assert.equal(localAfterEnable?.detached, false);
    const baseline = f.writes.length;
    response.resolve();
    const cancelled = await oldSync;
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
    await f.uploader.releaseInspection(id, () => false); // Wait behind the old queued disable without releasing anyone's proof.
    assert.deepEqual(f.record(), localAfterEnable, 'retired cleanup must not overwrite replacement opt-in or its sync metadata');
    assert.deepEqual(await f.repository.getManifest(id), remoteAfterEnable, 'retired cleanup must not fence the replacement cloud epoch');
    assert.notEqual(localAfterEnable?.resurrectionCancellationId, oldNonce, 'new opt-in must replace the durable intent nonce');
    assert.equal(f.writes.slice(baseline).some(record => !record.enabled || record.detached), false);
  } finally { response.resolve(); await oldSync; await f.uploader.releaseInspection(id, () => false); await f.dispose(); }
});

for (const phase of ['pending', 'accepted'] as const) {
  test(`an old ${phase} opt-out CAS response arriving after replacement enable cannot chase its ETag or patch its local intent`, { timeout: 3_000 }, async () => {
    const f = await fixture();
    const entered = deferred<void>(); const response = deferred<void>();
    let disableAttempts = 0;
    const intercept = async (entity: Record<string, unknown>) => {
      if (entity['state'] !== 'disabled' || entity['leaseOwner'] !== undefined) return;
      disableAttempts++;
      if (disableAttempts === 1) { entered.resolve(); await response.promise; }
    };
    if (phase === 'pending') f.hooks.beforeUpdate = intercept;
    else f.hooks.afterUpdate = intercept;
    const oldDisable = f.uploader.disable(id, 10);
    try {
      await bounded(entered.promise, 'the original opt-out must reach its pending cloud CAS');
      await bounded(oldDisable, 'pending shared opt-out must not prevent saving local off');
      await bounded(f.service.close(10), 'old runtime teardown must return while its CAS transport is pending');
      // The real server lease can expire while a previous runtime's SDK response
      // remains pending. The replacement then acquires its own fresh epoch.
      f.expireLease();
      const replacement = f.rebuild();
      assert.equal((await replacement.service.enable(id)).status, 'synced');
      const localAfterEnable = clone(f.record());
      const remoteAfterEnable = await f.repository.getManifest(id);
      const baseline = f.writes.length;
      response.resolve();
      await f.uploader.releaseInspection(id, () => false);
      assert.equal(disableAttempts, 1, 'a stale opt-out must not retry against a newly read replacement ETag');
      assert.deepEqual(f.record(), localAfterEnable, 'old success/failure/timeout diagnostics must not patch a newer local intent');
      assert.deepEqual(await f.repository.getManifest(id), remoteAfterEnable);
      assert.equal(f.writes.slice(baseline).some(record => !record.enabled || record.detached), false);
    } finally { response.resolve(); await oldDisable; await f.uploader.releaseInspection(id, () => false); await f.dispose(); }
  });
}

for (const prior of ['untracked', 'detached'] as const) {
  test(`an older service enable for a ${prior} copy cannot authorize after another runtime durably detaches it`, { timeout: 3_000 }, async () => {
    const f = await fixture({ prior, remote: false });
    const entered = deferred<void>(); const response = deferred<void>();
    const transact = f.local.transactSession.bind(f.local);
    let first = true;
    f.local.transactSession = async (sessionId, transform) => {
      if (first) { first = false; entered.resolve(); await response.promise; }
      // Delay invocation of the actual atomic API, not a stale full-record put:
      // its original transform must inspect the new safety nonce in the SDK lane.
      return transact(sessionId, transform);
    };
    const olderEnable = outcome(f.service.enable(id)); // Deliberately no request signal or shared controller registry.
    try {
      await bounded(entered.promise, 'the older enable must reach its deferred local authorization transform');
      const replacement = f.rebuild();
      await replacement.service.detach(id);
      const detached = clone(f.record());
      assert.equal(detached?.enabled, false); assert.equal(detached?.detached, true);
      assert.equal(typeof detached?.resurrectionCancellationId, 'string');
      const baseline = f.writes.length;
      response.resolve();
      const cancelled = await olderEnable;
      assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
      assert.deepEqual(f.record(), detached, 'the deferred authorizing transform must preserve the newer detach nonce and all its metadata');
      assert.equal(f.writes.slice(baseline).some(record => record.enabled || !record.detached), false);
      assert.equal((await f.uploader.sync(id)).status, 'disabled');
      assert.equal(await f.repository.getManifest(id), undefined);
      assert.equal(f.counts().creates, 0); assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().acquires, 0);
      assert.equal((await replacement.service.enable(id)).status, 'synced', 'a genuinely new opt-in remains available after the old intent is cancelled');
      assert.equal(f.record()?.enabled, true); assert.equal(f.record()?.detached, false);
      assert.notEqual(f.record()?.resurrectionCancellationId, detached?.resurrectionCancellationId);
      assert.equal((await f.repository.getManifest(id))?.entity.eventCount, 2);
      assert.equal(f.counts().creates, 1); assert.equal(f.counts().candidatePuts, 1);
    } finally { response.resolve(); await olderEnable; await f.dispose(); }
  });
}

test('an enabled sync checkpoint cannot restore metadata or publish payload after another runtime detaches the session', { timeout: 3_000 }, async () => {
  const f = await fixture({ remote: false });
  const entered = deferred<void>(); const response = deferred<void>();
  const transact = f.local.transactSession.bind(f.local);
  let first = true;
  f.local.transactSession = async (sessionId, transform) => {
    if (first) { first = false; entered.resolve(); await response.promise; }
    return transact(sessionId, transform);
  };
  const oldSync = outcome(f.service.sync(id)); // Existing consent, no enable request, external signal, registry, or retired runtime.
  try {
    await bounded(entered.promise, 'the enabled sync must reach its first deferred checkpoint transform');
    assert.equal(f.counts().acquires, 1, 'the sync reached its actual owned upload workflow');
    assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().transactions, 0);
    const replacement = f.rebuild();
    await replacement.service.detach(id);
    const detached = clone(f.record());
    assert.equal(detached?.enabled, false); assert.equal(detached?.detached, true);
    const baseline = f.writes.length;
    response.resolve();
    const cancelled = await oldSync;
    assert.equal(cancelled.ok, false); if (!cancelled.ok) assert.ok(isCancelled(cancelled.error));
    assert.deepEqual(f.record(), detached, 'a stale checkpoint must not restore syncing status, old consent, or old nonce');
    assert.equal(f.writes.length, baseline, 'the cancelled checkpoint must not append any local metadata write');
    assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().transactions, 0, 'no event payload may commit after the durable stop');
    assert.equal(f.counts().active, undefined); assert.equal(f.uploader.hasHeld(id), false);
    const manifest = await f.repository.getManifest(id); assert.ok(manifest);
    assert.equal(manifest.entity.eventCount, 0); assert.equal(manifest.entity.batchCount, 0);
    await f.service.refreshAll(); await replacement.service.refreshAll();
    assert.equal((await f.service.sync(id)).status, 'disabled');
    assert.deepEqual(f.record(), detached);
    assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().transactions, 0);
  } finally { response.resolve(); await oldSync; await f.dispose(); }
});

test('a stale same-prefix reconciliation status patch cannot restore detached metadata or recreate a deleted local record', { timeout: 3_000 }, async () => {
  for (const removeLocal of [false, true]) {
    const f = await fixture();
    const entered = deferred<void>(); const response = deferred<void>();
    const transact = f.local.transactSession.bind(f.local);
    let first = true;
    f.local.transactSession = async (sessionId, transform) => {
      if (first) { first = false; entered.resolve(); await response.promise; }
      return transact(sessionId, transform);
    };
    const remoteBefore = await f.repository.getManifest(id);
    const oldReconcile = outcome(f.service.reconcile(id));
    try {
      await bounded(entered.promise, 'same-prefix reconciliation must reach its deferred synced-status patch');
      const replacement = f.rebuild();
      await replacement.service.detach(id);
      const detached = clone(f.record());
      assert.equal(detached?.enabled, false); assert.equal(detached?.detached, true);
      if (removeLocal) await f.local.deleteSession(id);
      const baseline = f.writes.length;
      response.resolve();
      const completed = await oldReconcile;
      assert.equal(completed.ok, true); if (completed.ok) assert.equal(completed.value?.kind, 'same');
      assert.deepEqual(f.record(), removeLocal ? undefined : detached, 'the old status patch must neither restore stale metadata nor create a removed record');
      assert.equal(f.writes.length, baseline, 'superseded or missing records do not receive stale status writes');
      await f.service.refreshAll(); await replacement.service.refreshAll();
      assert.deepEqual(f.record(), removeLocal ? undefined : detached);
      assert.deepEqual(await f.repository.getManifest(id), remoteBefore);
      assert.equal(f.counts().creates, 0); assert.equal(f.counts().candidatePuts, 0); assert.equal(f.counts().transactions, 0);
      assert.equal(f.counts().acquires, 0); assert.equal(f.uploader.hasHeld(id), false);
    } finally { response.resolve(); await oldReconcile; await f.dispose(); }
  }
});

test('a newer opt-out stamps the generation committed by an older pending SDK write instead of silently succeeding without stopping', async () => {
  const f = await fixture({ remote: false });
  try {
    const olderMetadata = f.local.putSession({ ...f.record()!, generation: 2, conflictBackupPath: '/local/older-import-backup.jsonl' });
    assert.equal(f.record()?.generation, 1, 'the SDK cache has not observed its earlier queued metadata write at API entry');
    const newerOff = f.uploader.disable(id);
    await olderMetadata; await newerOff;
    assert.equal(f.record()?.generation, 2, 'opt-out must preserve the latest generation from the serialized permission transform');
    assert.equal(f.record()?.enabled, false); assert.equal(f.record()?.detached, true); assert.equal(f.record()?.state, 'disabled');
    assert.equal(f.record()?.status, 'detached');
    assert.equal(f.record()?.conflictBackupPath, '/local/older-import-backup.jsonl');
    assert.equal(typeof f.record()?.resurrectionCancellationId, 'string');
    assert.equal(f.counts().creates, 0); assert.equal(f.counts().acquires, 0);
  } finally { await f.dispose(); }
});

test('the current durable opt-out still fences a foreign server owner and preserves unrelated local metadata', async () => {
  const f = await fixture();
  try {
    const before = await f.repository.getManifest(id); assert.ok(before);
    f.claimForeignLease();
    await f.repository.updateManifest({ ...before.entity, leaseOwner: 'device-foreign', leaseUntil: now + 60_000 }, before.etag);
    await f.local.putSession({ ...f.record()!, conflictBackupPath: '/local/preserved-backup.jsonl', lastSyncedEventCount: 2 });
    await f.uploader.disable(id);
    const remote = await f.repository.getManifest(id); assert.ok(remote);
    assert.equal(remote.entity.state, 'disabled'); assert.equal(remote.entity.enabled, false);
    assert.ok(remote.entity.writerEpoch > before.entity.writerEpoch);
    assert.equal(remote.entity.leaseOwner, undefined); assert.equal(remote.entity.leaseUntil, undefined);
    assert.equal(f.record()?.enabled, false); assert.equal(f.record()?.detached, true); assert.equal(f.record()?.status, 'detached');
    assert.equal(f.record()?.lastError, undefined, 'the current shared CAS opt-out is confirmed, not merely local');
    assert.equal(f.record()?.conflictBackupPath, '/local/preserved-backup.jsonl'); assert.equal(f.record()?.lastSyncedEventCount, 2);
    assert.equal(f.uploader.hasHeld(id), false);
  } finally { await f.dispose(); }
});

test('a pre-cancelled controller ownership request performs no proof or local mutation', async () => {
  const f = await fixture();
  try {
    const request = new AbortController(); request.abort();
    await assert.rejects(f.controller.execute({ action: 'check-ownership', sessionId: id }, { origin: 'rpc', signal: request.signal }), isCancelled);
    assert.equal(f.counts().acquires, 0); assert.equal(f.counts().renews, 0); assert.equal(f.counts().releases, 0);
    assert.equal(f.writes.length, 0); assert.equal(f.uploader.hasHeld(id), false);
  } finally { await f.dispose(); }
});
