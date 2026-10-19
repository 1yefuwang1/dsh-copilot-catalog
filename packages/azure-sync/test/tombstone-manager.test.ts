import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { candidateBlobName, leaseBlobName, type CloudRepository, type StoredManifest, type StoredBatch } from '../src/sync/cloud-repository.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { assertGenerationRow, generationBlobPrefix } from '../src/sync/cleanup.js';
import type { LocalStore } from '../src/local/store.js';
import type { BatchRow, CloudSessionEntity, LocalSessionRecord } from '../src/schema.js';
import { canonicalJson } from '../src/sync/canonical.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { localSession, batchRow, cloudSession, event, sessionHeader, HEX_A } from './helpers.js';

class MemoryRepo {
  manifests = new Map<string, StoredManifest>();
  rows = new Map<string, StoredBatch>();
  blobs = new Set<string>();
  calls: string[] = [];
  failBlob?: string;
  failChild?: string;
  failRow?: string;
  failLease?: string;
  counter = 0;
  blob = { ensureEmptyBlob: async (name: string) => { this.blobs.add(name); this.calls.push(`ensure:${name}`); } };
  constructor(entities: CloudSessionEntity[], rows: BatchRow[] = []) {
    for (const entity of entities) this.manifests.set(entity.sessionId, { entity, etag: `e${++this.counter}` });
    for (const entity of rows) { this.rows.set(entity.rowKey, { entity, etag: `e${++this.counter}` }); this.blobs.add(entity.blobName); }
  }
  async getManifest(id: string) { return this.manifests.get(id); }
  async updateManifest(entity: CloudSessionEntity, etag: string) {
    if (entity.sessionId === this.failChild) throw new AzureSyncError('TRANSIENT', 'injected child failure');
    assert.equal(this.manifests.get(entity.sessionId)?.etag, etag);
    this.manifests.set(entity.sessionId, { entity, etag: `e${++this.counter}` });
    this.calls.push(`manifest:${entity.sessionId}:${entity.state}:${entity.cleanupPending}`);
  }
  async *listDescendants(rootSessionId: string, rootGeneration: number) {
    for (const stored of this.manifests.values()) if (stored.entity.sessionId !== rootSessionId &&
      stored.entity.rootSessionId === rootSessionId && stored.entity.rootGeneration === rootGeneration) yield stored;
  }
  async listBatchRows(id: string, generation: number) {
    return [...this.rows.values()].filter(row => row.entity.sessionId === id && row.entity.generation === generation).map(row => row.entity);
  }
  async *iterateBatchRows(id: string, generation: number) {
    for (const row of this.rows.values()) if (row.entity.sessionId === id && row.entity.generation === generation) yield row;
  }
  async assertCleanup(manifest: StoredManifest) {
    const current = this.manifests.get(manifest.entity.sessionId);
    if (current?.etag !== manifest.etag || current.entity.state !== 'deleted' || current.entity.cleanupPending !== true) {
      throw new AzureSyncError('PRECONDITION', 'stale cleanup');
    }
  }
  async deleteBatchRow(row: StoredBatch, manifest: StoredManifest) {
    await this.assertCleanup(manifest);
    assertGenerationRow(row.entity, manifest.entity.sessionId, manifest.entity.generation, 'account');
    if (row.entity.rowKey === this.failRow) throw new AzureSyncError('TRANSIENT', 'injected row failure');
    this.calls.push(`row:${row.entity.rowKey}`);
    this.rows.delete(row.entity.rowKey);
  }
  async deleteBatchBlob(name: string, manifest: StoredManifest) {
    await this.assertCleanup(manifest);
    if (name === this.failBlob) throw new AzureSyncError('TRANSIENT', 'injected blob failure');
    this.calls.push(`blob:${name}`);
    this.blobs.delete(name);
  }
  async *listGenerationBlobs(id: string, generation: number) {
    for (const name of this.blobs) if (name.startsWith(generationBlobPrefix(id, generation))) yield name;
  }
  async deleteLeaseBlob(manifest: StoredManifest) {
    await this.assertCleanup(manifest);
    const name = leaseBlobName(manifest.entity.sessionId);
    if (name === this.failLease) throw new AzureSyncError('TRANSIENT', 'injected lease failure');
    this.calls.push(`lease:${name}`);
    this.blobs.delete(name);
  }
}

class MemoryLocal implements Pick<LocalStore, 'getSession' | 'listSessions' | 'putSession' | 'transactSession'> {
  private readonly transactions = new Map<string, Promise<void>>();
  constructor(readonly records: Map<string, LocalSessionRecord>) {}
  getSession(id: string) { return this.records.get(id); }
  listSessions() { return this.records.entries(); }
  async putSession(record: LocalSessionRecord) { this.records.set(record.sessionId, record); }
  transactSession(id: string, fn: (record: LocalSessionRecord | undefined) => LocalSessionRecord | undefined): Promise<LocalSessionRecord | undefined> {
    const prior = this.transactions.get(id) ?? Promise.resolve();
    const result = prior.then(async () => {
      const next = fn(this.records.get(id));
      if (next === undefined) return undefined;
      await this.putSession(next);
      return next;
    });
    this.transactions.set(id, result.then(() => undefined, () => undefined));
    return result;
  }
}

function setup(entities: CloudSessionEntity[], rows: BatchRow[] = [], localRecords?: LocalSessionRecord[]) {
  const repo = new MemoryRepo(entities, rows);
  const records = new Map((localRecords ?? entities.map((entity) => localSession({ sessionId: entity.sessionId, generation: entity.generation }))).map((record) => [record.sessionId, record]));
  const local = new MemoryLocal(records);
  return { repo, local, records, manager: new TombstoneManager(repo as unknown as CloudRepository, local, () => 100, 'deleting-device') };
}

function pauseTransaction(local: MemoryLocal, shouldPause: () => boolean) {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transact = local.transactSession.bind(local);
  let paused = false;
  local.transactSession = async (id, fn) => {
    if (!paused && shouldPause()) { paused = true; entered(); await blocked; }
    return transact(id, fn);
  };
  return { reached, release, transact };
}

function boundSession(overrides: Partial<CloudSessionEntity> = {}): CloudSessionEntity {
  const entity = cloudSession(overrides);
  return { ...entity, headerHash: headerHash(JSON.parse(entity.headerJson), entity.inheritedEventCount) };
}

test('root-first tombstones all descendants before sweeping rows/blobs/orphans/leases, retaining attachments and future generations', async () => {
  const root = cloudSession({ sessionId: 'root', generation: 2, leaseOwner: 'old-writer', leaseUntil: 500 });
  const child = cloudSession({ sessionId: 'child', rootSessionId: 'root', rootGeneration: 2 });
  const grandchild = cloudSession({ sessionId: 'grandchild', rootSessionId: 'root', rootGeneration: 2 });
  const unrelated = cloudSession({ sessionId: 'unrelated', rootSessionId: 'root', rootGeneration: 3 });
  const rows = [batchRow('root', 2, 0), batchRow('child', 1, 0), batchRow('grandchild', 1, 0), batchRow('root', 3, 0)];
  const { repo, records, manager } = setup([root, child, grandchild, unrelated], rows);
  const orphan = candidateBlobName('root', 2, 9, 4, HEX_A);
  repo.blobs.add(orphan);
  repo.blobs.add('v1/attachments/shared');
  for (const id of ['root', 'child', 'grandchild']) repo.blobs.add(leaseBlobName(id));
  await manager.remove('root', 2);
  assert.equal(repo.calls[0], 'manifest:root:deleted:true');
  const firstBlob = repo.calls.findIndex((call) => call.startsWith('blob:'));
  assert.ok(repo.calls.indexOf('manifest:child:deleted:true') < firstBlob);
  assert.ok(repo.calls.indexOf('manifest:grandchild:deleted:true') < firstBlob);
  assert.deepEqual([...repo.blobs].sort(), ['v1/attachments/shared', rows[3]!.blobName].sort());
  assert.deepEqual([...repo.rows.keys()], [rows[3]!.rowKey]);
  const dead = repo.manifests.get('root')!.entity;
  assert.equal(dead.deletedAt, 100);
  assert.equal(dead.deletedBy, 'deleting-device');
  assert.equal(dead.leaseOwner, undefined);
  assert.equal(dead.cleanupPending, false);
  for (const id of ['root', 'child', 'grandchild']) {
    assert.equal(records.get(id)?.state, 'deleted');
    assert.equal(records.get(id)?.status, 'removed-remotely');
    assert.equal(records.get(id)?.deletedAt, 100);
    assert.equal(records.get(id)?.deletedBy, 'deleting-device');
    assert.equal(records.get(id)?.cleanupPending, false);
    assert.equal(records.get(id)?.lastError, undefined);
  }
  assert.equal(repo.manifests.get('unrelated')?.entity.state, 'active');
});

test('a current explicit root removal revokes an older local opt-out and durably stops admission', async () => {
  const oldOff = localSession({ sessionId: 'root', state: 'disabled', enabled: false, detached: true,
    admissionStopped: false, status: 'detached', resurrectionCancellationId: '00000000-0000-4000-8000-000000000077' });
  const { manager, records } = setup([cloudSession({ sessionId: 'root' })], [], [oldOff]);
  await manager.remove('root', 1);
  assert.equal(records.get('root')?.state, 'deleted');
  assert.equal(records.get('root')?.status, 'removed-remotely');
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(records.get('root')?.detached, false);
  assert.equal(records.get('root')?.admissionStopped, true);
  assert.equal(records.get('root')?.cleanupPending, false);
});

test('root removal snapshots descendant permission fences before root IO, preserving a newer child detach', async () => {
  const { manager, repo, local, records } = setup([cloudSession({ sessionId: 'root' }),
    cloudSession({ sessionId: 'child', rootSessionId: 'root' })]);
  const update = repo.updateManifest.bind(repo);
  let childLatest: LocalSessionRecord | undefined;
  repo.updateManifest = async (entity, etag) => {
    await update(entity, etag);
    if (entity.sessionId === 'root' && entity.cleanupPending === true) {
      childLatest = await local.transactSession('child', current => current === undefined ? undefined : {
        ...current, state: 'disabled', enabled: false, detached: true, admissionStopped: false, status: 'detached',
        resurrectionCancellationId: '00000000-0000-4000-8000-000000000076', lastError: 'new child detach diagnostic',
      });
    }
  };
  await manager.remove('root', 1);
  assert.ok(childLatest);
  assert.deepEqual(records.get('child'), childLatest);
  assert.equal(records.get('root')?.state, 'deleted');
  assert.equal(records.get('root')?.admissionStopped, true);
  assert.equal(repo.manifests.get('child')?.entity.state, 'deleted');
  assert.equal(repo.manifests.get('child')?.entity.cleanupPending, false);
});

test('failed blob delete retains its row, flags pending local state, and existing tombstone retry resumes', async () => {
  const row = batchRow('root', 1, 0);
  const { repo, records, manager } = setup([cloudSession({ sessionId: 'root' })], [row]);
  repo.failBlob = row.blobName;
  await assert.rejects(manager.remove('root', 1), /injected blob/u);
  assert.equal(repo.rows.has(row.rowKey), true);
  assert.equal(repo.manifests.get('root')?.entity.cleanupPending, true);
  assert.match(records.get('root')?.lastError ?? '', /pending/u);
  repo.failBlob = undefined;
  await manager.remove('root', 1);
  assert.equal(repo.rows.size, 0);
  assert.equal(repo.blobs.size, 0);
  assert.equal(repo.manifests.get('root')?.entity.writerEpoch, 2, 'retry must not bump the deletion epoch');
  assert.ok(repo.calls.indexOf(`blob:${row.blobName}`) < repo.calls.indexOf(`row:${row.rowKey}`));
});

test('row and lease deletion failures remain pending and resume after the blob was already deleted', async () => {
  const row = batchRow('root', 1, 0);
  const { repo, manager } = setup([cloudSession({ sessionId: 'root' })], [row]);
  repo.blobs.add(leaseBlobName('root'));
  repo.failRow = row.rowKey;
  await assert.rejects(manager.remove('root', 1), /injected row/u);
  assert.equal(repo.rows.has(row.rowKey), true);
  assert.equal(repo.blobs.has(row.blobName), false);
  repo.failRow = undefined;
  repo.failLease = leaseBlobName('root');
  await assert.rejects(manager.remove('root', 1), /injected lease/u);
  assert.equal(repo.rows.size, 0);
  assert.equal(repo.manifests.get('root')?.entity.cleanupPending, true);
  repo.failLease = undefined;
  await manager.remove('root', 1);
  assert.equal(repo.manifests.get('root')?.entity.cleanupPending, false);
  assert.equal(repo.blobs.size, 0);
});

test('descendant tombstone failure prevents success and root resurrection until repaired', async () => {
  const { repo, manager } = setup([boundSession({ sessionId: 'root' }), cloudSession({ sessionId: 'child', rootSessionId: 'root' })]);
  repo.failChild = 'child';
  await assert.rejects(manager.remove('root', 1), /injected child/u);
  assert.equal(repo.manifests.get('root')?.entity.cleanupPending, true);
  await assert.rejects(manager.resurrect('root', 1), /injected child/u);
  assert.equal(repo.manifests.get('root')?.entity.generation, 1);
  repo.failChild = undefined;
  const active = await manager.resurrect('root', 1);
  assert.equal(active.generation, 2);
  assert.equal(active.rootGeneration, 2);
  assert.equal(repo.manifests.get('child')?.entity.state, 'deleted');
});

test('crash after tombstone resumes on resurrection, resets only generation checkpoints, and rejects stale/child actions', async () => {
  const root = boundSession({ sessionId: 'root', state: 'deleted', enabled: false, cleanupPending: true });
  const record = localSession({ sessionId: 'root', imported: true, lastSyncedEventCount: 12, lastSyncedChainHash: HEX_A,
    lastSyncedHeaderHash: HEX_A, importedThroughSeq: 11, importExpectedCount: 12, importState: 'complete', catchUpPending: true, remoteETag: 'old',
    localCwd: '/local/project', canonicalCwd: '/remote/project' });
  const { repo, records, manager } = setup([root, cloudSession({ sessionId: 'child', rootSessionId: 'root' })], [batchRow('root', 1, 0)], [record]);
  const revived = await manager.resurrect('root', 1);
  assert.equal(revived.headSeq, -1);
  assert.equal(revived.eventCount, 0);
  assert.equal(revived.lastBatchRowKey, undefined);
  assert.equal(revived.generation, 2);
  assert.equal(revived.rootGeneration, 2);
  assert.equal(records.get('root')?.lastSyncedEventCount, undefined);
  assert.equal(records.get('root')?.importedThroughSeq, undefined);
  assert.equal(records.get('root')?.importState, undefined);
  assert.equal(records.get('root')?.catchUpPending, false);
  assert.equal(records.get('root')?.imported, false);
  assert.equal(records.get('root')?.canonicalCwd, '/remote/project');
  assert.equal(records.get('root')?.localCwd, '/local/project');
  assert.ok(repo.blobs.has(leaseBlobName('root')));
  await assert.rejects(manager.remove('root', 1), /generation changed/u);
  await assert.rejects(manager.resurrect('root', 1), /generation changed/u);
  await assert.rejects(manager.remove('child', 1), /root session/u);
  await assert.rejects(manager.resurrect('child'), /root session/u);
});

test('explicit remapped re-upload establishes a fresh header/cut/genesis only in the new generation', async () => {
  const oldHeader = sessionHeader({ id: 'root', cwd: 'C:\\Project\\Src' });
  const freshHeader = sessionHeader({ id: 'root', cwd: 'C:\\project\\SRC' });
  const root = cloudSession({ sessionId: 'root', sourcePlatform: 'win32', cwd: oldHeader.cwd,
    headerJson: canonicalJson(oldHeader), headerHash: headerHash(oldHeader, 0), state: 'deleted', enabled: false });
  const record = localSession({ sessionId: 'root', imported: true, remapped: true, localCwd: '/local/project/src',
    canonicalCwd: oldHeader.cwd, importState: 'complete', lastSyncedHeaderHash: root.headerHash });
  const { repo, records, manager } = setup([root], [], [record]);
  const revived = await manager.resurrect('root', 1, { header: freshHeader as never, inheritedEventCount: 3 });
  const binding = headerHash(freshHeader, 3);
  assert.notEqual(binding, root.headerHash);
  assert.equal(revived.headerJson, canonicalJson(freshHeader));
  assert.equal(revived.headerHash, binding);
  assert.equal(revived.inheritedEventCount, 3);
  assert.equal(revived.cwd, freshHeader.cwd);
  assert.equal(revived.chainHash, genesisHash('root', 2, binding));
  assert.equal(revived.headHash, revived.chainHash);
  assert.equal(revived.headSeq, -1);
  assert.equal(revived.rootGeneration, 2);
  assert.equal(records.get('root')?.canonicalCwd, freshHeader.cwd);
  assert.equal(records.get('root')?.localCwd, '/local/project/src');
  assert.equal(records.get('root')?.lastSyncedHeaderHash, undefined);
  assert.equal(records.get('root')?.imported, false);
  assert.equal(repo.manifests.get('root')?.entity.headerHash, binding);
});

test('header reset is rejected for retained disabled/active history and mismatched session identities', async () => {
  for (const state of ['disabled', 'active'] as const) {
    const root = cloudSession({ sessionId: 'root', state, enabled: state === 'active' });
    const { repo, manager } = setup([root], [batchRow('root', 1, 0)]);
    await assert.rejects(manager.resurrect('root', 1, { header: sessionHeader({ id: 'root', cwd: '/different' }) as never,
      inheritedEventCount: 0 }), /Only a deleted/u);
    assert.equal(repo.rows.size, 1);
    assert.equal(repo.calls.length, 0);
    assert.deepEqual(repo.manifests.get('root')?.entity, root);
  }
  const { repo, manager } = setup([cloudSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  await assert.rejects(manager.resurrect('root', 1, { header: sessionHeader({ id: 'other' }) as never, inheritedEventCount: 0 }), /identity/u);
  assert.equal(repo.calls.length, 0);
});

test('disabled re-enable preserves all committed history and local checkpoints without cleanup', async () => {
  const binding = headerHash(sessionHeader({ id: 'root' }), 0);
  const chain = chainEvents(genesisHash('root', 3, binding), [event(0)]);
  const row = batchRow('root', 3, 0, chain);
  const root = boundSession({ sessionId: 'root', state: 'disabled', enabled: false, generation: 3,
    chainHash: chain.chainHash, headHash: chain.headHash, lastBatchGeneration: 3,
    lastBatchRowKey: row.rowKey, lastBatchBlobName: row.blobName });
  const { repo, records, manager } = setup([root], [row], [localSession({ sessionId: 'root', generation: 3, lastSyncedEventCount: 1, lastSyncedChainHash: root.chainHash })]);
  const enabled = await manager.resurrect('root', 3);
  assert.equal(enabled.generation, 3);
  assert.equal(enabled.headSeq, root.headSeq);
  assert.equal(enabled.chainHash, root.chainHash);
  assert.equal(enabled.lastBatchRowKey, root.lastBatchRowKey);
  assert.equal(records.get('root')?.lastSyncedEventCount, 1);
  assert.equal(repo.rows.size, 1);
  assert.equal(repo.blobs.has(row.blobName), true);
  assert.equal(repo.calls.some((call) => /^(blob|lease|row):/u.test(call)), false);
});

for (const expected of [1, undefined]) test(`post-CAS local-write failure retries the same explicit resurrection (${expected === undefined ? 'no expected generation' : 'expected generation one'}) without generation three`, async () => {
  const { repo, records, local, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })], [],
    [localSession({ sessionId: 'root', state: 'deleted', enabled: false, imported: true,
      lastSyncedEventCount: 7, lastSyncedHeaderHash: HEX_A, lastSyncedChainHash: HEX_A, importState: 'complete' })]);
  const put = local.putSession.bind(local);
  let fail = true;
  local.putSession = async record => {
    if (record.state === 'active' && record.generation === 2 && fail) {
      fail = false;
      throw new Error('injected final local checkpoint failure');
    }
    await put(record);
  };
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') {
      const pending = records.get('root')!;
      assert.equal(pending.enabled, false, 'write-ahead intent stays admission-blocked before activation');
      assert.equal(pending.resurrectionIntent?.operationId, entity.resurrectionId);
      assert.equal(pending.resurrectionIntent?.sourceETag, etag);
    }
    await update(entity, etag);
  };
  await assert.rejects(manager.resurrect('root', 1), /final local checkpoint/u);
  const pending = records.get('root')!;
  assert.equal(pending.generation, 1);
  assert.equal(pending.state, 'deleted');
  assert.equal(pending.enabled, false);
  assert.equal(pending.resurrectionIntent?.priorGeneration, 1);
  assert.equal(pending.resurrectionIntent?.targetGeneration, 2);
  const token = pending.resurrectionIntent?.operationId;
  assert.ok(token);
  assert.equal(repo.manifests.get('root')?.entity.resurrectionId, token);
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
  const active = await manager.resurrect('root', expected);
  assert.equal(active.generation, 2);
  assert.equal(active.resurrectionId, token);
  assert.equal(records.get('root')?.generation, 2);
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(records.get('root')?.lastSyncedEventCount, undefined);
  assert.equal(records.get('root')?.importState, undefined);
  assert.equal(records.get('root')?.imported, false);
  assert.equal(repo.calls.filter(call => call.startsWith('manifest:root:active:')).length, 1);
  assert.equal((await manager.resurrect('root')).generation, 2);
});

for (const change of ['detach', 'new-nonce', 'operation-token', 'off-state', 'new-on', 'deleted-record'] as const) {
  test(`atomic final resurrection checkpoint rejects latest ${change} before its SDK callback`, async () => {
    const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
    const gate = pauseTransaction(local, () => repo.manifests.get('root')?.entity.generation === 2);
    const action = manager.resurrect('root', 1);
    const rejected = assert.rejects(action, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
    await gate.reached;
    if (change === 'deleted-record') records.delete('root');
    else await gate.transact('root', current => {
      assert.ok(current?.resurrectionIntent);
      if (change === 'new-nonce') return { ...current, resurrectionCancellationId: '00000000-0000-4000-8000-000000000083' };
      if (change === 'operation-token') {
        const operationId = '00000000-0000-4000-8000-000000000082';
        return { ...current, resurrectionIntent: { ...current.resurrectionIntent, operationId,
          target: { ...current.resurrectionIntent.target, resurrectionId: operationId } } };
      }
      if (change === 'off-state') return { ...current, detached: true, admissionStopped: false, status: 'detached' };
      return { ...current, state: change === 'new-on' ? 'active' : 'disabled', enabled: change === 'new-on',
        detached: change !== 'new-on', admissionStopped: false, status: change === 'new-on' ? 'setup-needed' : 'detached',
        resurrectionIntent: undefined, resurrectionCancellationId: '00000000-0000-4000-8000-000000000081',
        lastError: 'new explicit permission diagnostic' };
    });
    const latest = structuredClone(records.get('root'));
    gate.release();
    await rejected;
    assert.deepEqual(records.get('root'), latest, 'the rejected completion cannot write any old permission or reset newer diagnostics');
    assert.equal(repo.manifests.get('root')?.entity.generation, 2);
    assert.equal(repo.manifests.get('root')?.entity.state, 'disabled', 'only the untouched own-token activation may be compensated');
  });
}

test('a no-op local transaction cannot report a completed resurrection', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const transact = local.transactSession.bind(local);
  local.transactSession = (id, fn) => repo.manifests.get(id)?.entity.generation === 2 ? Promise.resolve(undefined) : transact(id, fn);
  await assert.rejects(manager.resurrect('root', 1), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(records.get('root')?.generation, 1);
  assert.equal(records.get('root')?.enabled, false);
  assert.ok(records.get('root')?.resurrectionIntent);
  assert.equal(repo.manifests.get('root')?.entity.state, 'disabled');
});

test('atomic final completion preserves metadata written after planning when its permission token is unchanged', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const gate = pauseTransaction(local, () => repo.manifests.get('root')?.entity.generation === 2);
  const action = manager.resurrect('root', 1);
  await gate.reached;
  await gate.transact('root', current => current === undefined ? undefined : { ...current, localCwd: '/new/local/root', weArchived: true });
  gate.release();
  assert.equal((await action).generation, 2);
  assert.equal(records.get('root')?.localCwd, '/new/local/root');
  assert.equal(records.get('root')?.weArchived, true);
  assert.equal(records.get('root')?.enabled, true);
});

for (const change of ['detach', 'deleted-record'] as const) test(`atomic intent planning cannot overwrite latest ${change}`, async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  let transactions = 0;
  const gate = pauseTransaction(local, () => ++transactions === 3); // tombstone, cleanup checkpoint, then write-ahead plan
  const action = manager.resurrect('root', 1);
  const rejected = assert.rejects(action, error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  await gate.reached;
  if (change === 'deleted-record') records.delete('root');
  else await gate.transact('root', current => current === undefined ? undefined : { ...current, enabled: false,
    state: 'disabled', detached: true, admissionStopped: false, status: 'detached', resurrectionIntent: undefined,
    resurrectionCancellationId: '00000000-0000-4000-8000-000000000080', lastError: 'new off diagnostic' });
  const latest = structuredClone(records.get('root'));
  gate.release();
  await rejected;
  assert.deepEqual(records.get('root'), latest);
  assert.equal(repo.manifests.get('root')?.entity.generation, 1);
  assert.equal(repo.manifests.get('root')?.entity.state, 'deleted');
});

for (const checkpoint of ['pending', 'complete'] as const) for (const newer of ['off', 'on', 'deleted-record'] as const) {
  test(`old ${checkpoint} tombstone diagnostic cannot override newer ${newer} in the SDK lane`, async () => {
    const { repo, local, records, manager } = setup([cloudSession({ sessionId: 'root' })]);
    let transactions = 0;
    const gate = pauseTransaction(local, () => ++transactions === (checkpoint === 'pending' ? 1 : 2));
    const action = manager.remove('root', 1);
    await gate.reached;
    if (newer === 'deleted-record') records.delete('root');
    else await gate.transact('root', current => current === undefined ? undefined : { ...current,
      enabled: newer === 'on', state: newer === 'on' ? 'active' : 'disabled', detached: newer === 'off',
      admissionStopped: false, status: newer === 'on' ? 'synced' : 'detached', resurrectionIntent: undefined,
      resurrectionCancellationId: '00000000-0000-4000-8000-000000000079', lastError: `latest ${newer} diagnostic` });
    const latest = structuredClone(records.get('root'));
    gate.release();
    await action;
    assert.deepEqual(records.get('root'), latest);
    assert.equal(repo.manifests.get('root')?.entity.cleanupPending, false, 'cloud cleanup still uses its independent generation/ETag fence');
  });
}

test('terminal recovery callback preserves newer detached permission and diagnostic', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const put = local.putSession.bind(local);
  local.putSession = async record => { if (record.state === 'active') throw new Error('injected checkpoint failure'); await put(record); };
  await assert.rejects(manager.resurrect('root', 1), /checkpoint failure/u);
  local.putSession = put;
  const current = repo.manifests.get('root')!;
  repo.manifests.set('root', { entity: { ...current.entity, generation: 3, rootGeneration: 3 }, etag: 'unrelated-generation' });
  const gate = pauseTransaction(local, () => true);
  const repair = manager.repairPending();
  await gate.reached;
  await gate.transact('root', record => record === undefined ? undefined : { ...record, state: 'disabled', enabled: false,
    detached: true, admissionStopped: false, status: 'detached', resurrectionIntent: undefined,
    resurrectionCancellationId: '00000000-0000-4000-8000-000000000078', lastError: 'new detached diagnostic' });
  const latest = structuredClone(records.get('root'));
  gate.release();
  assert.deepEqual(await repair, { repaired: [], failed: ['root'] });
  assert.deepEqual(records.get('root'), latest);
});

test('intent persistence failure prevents activation and a pre-CAS crash resumes the exact saved proposal', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const put = local.putSession.bind(local);
  local.putSession = async record => {
    if (record.resurrectionIntent !== undefined) throw new Error('injected intent write failure');
    await put(record);
  };
  await assert.rejects(manager.resurrect('root', 1), /intent write/u);
  assert.equal(repo.manifests.get('root')?.entity.generation, 1);
  assert.equal(repo.manifests.get('root')?.entity.state, 'deleted');
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  local.putSession = put;
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') throw new Error('injected crash before activation CAS');
    await update(entity, etag);
  };
  const fresh = sessionHeader({ id: 'root', cwd: '/fresh/header' });
  await assert.rejects(manager.resurrect('root', 1, { header: fresh as never, inheritedEventCount: 4 }), /before activation/u);
  const intent = records.get('root')?.resurrectionIntent;
  assert.ok(intent);
  assert.equal(intent.target.headerHash, headerHash(fresh, 4));
  assert.equal(intent.genesisHash, genesisHash('root', 2, intent.target.headerHash));
  await assert.rejects(manager.resurrect('root', 1, { header: fresh as never, inheritedEventCount: 5 }), /retry header/u);
  repo.updateManifest = update;
  await manager.repairPending();
  assert.equal(repo.manifests.get('root')?.entity.resurrectionId, intent.operationId);
  assert.equal(repo.manifests.get('root')?.entity.headerJson, canonicalJson(fresh));
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
});

for (const loss of ['source-ETag', 'later-generation'] as const) test(`new explicit resurrection revokes older detached opt-out through ${loss} terminalization`, async () => {
  const oldCancellationId = '00000000-0000-4000-8000-000000000091';
  const oldOff = localSession({ sessionId: 'root', state: 'deleted', enabled: false, status: 'detached', detached: true, admissionStopped: false,
    resurrectionCancellationId: oldCancellationId });
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })], [], [oldOff]);
  const update = repo.updateManifest.bind(repo);
  const put = local.putSession.bind(local);
  if (loss === 'source-ETag') repo.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') throw new AzureSyncError('TRANSIENT', 'injected pre-CAS interruption');
    await update(entity, etag);
  };
  else local.putSession = async record => {
    if (record.state === 'active') throw new Error('injected post-CAS checkpoint interruption');
    await put(record);
  };
  await assert.rejects(manager.resurrect('root', 1), /interruption/u);
  const pending = records.get('root')!;
  assert.ok(pending.resurrectionIntent);
  assert.equal(pending.detached, false, 'a NEW explicit resurrection revokes the old off admission bypass before activation');
  assert.equal(pending.admissionStopped, true);
  assert.equal(pending.enabled, false);
  assert.equal(pending.generation, 1);
  assert.equal(pending.resurrectionCancellationId, oldCancellationId);
  // A persisted intent created by an older build may still carry the obsolete
  // detached flag. This is NOT a newer off: neither token nor cancel id changed.
  records.set('root', { ...pending, detached: true });
  repo.updateManifest = update;
  local.putSession = put;
  const current = repo.manifests.get('root')!;
  if (loss === 'source-ETag') await update({ ...current.entity, updatedAt: 999 }, current.etag);
  else repo.manifests.set('root', { entity: { ...current.entity, generation: 3, rootGeneration: 3,
    previousGeneration: 2, resurrectionId: '00000000-0000-4000-8000-000000000090' }, etag: 'unrelated-generation' });
  assert.deepEqual(await manager.repairPending(), { repaired: [], failed: ['root'] });
  const stopped = records.get('root')!;
  assert.equal(stopped.detached, false, 'a lost explicit resurrection remains admission-blocked, not opted out');
  assert.equal(stopped.admissionStopped, true, 'terminal recovery must explicitly block admission for every stopped status');
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.generation, 1, 'terminalization must not adopt the unrelated remote generation');
  assert.equal(stopped.status, loss === 'source-ETag' ? 'conflict' : 'generation-changed');
  assert.equal(stopped.resurrectionIntent, undefined);
  assert.equal(stopped.resurrectionCancellationId, oldCancellationId);
});

test('delayed retry allows verified same-generation committed progression but leaves local raw-prefix checkpoints unset', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const put = local.putSession.bind(local);
  local.putSession = async record => {
    if (record.state === 'active') throw new Error('injected local crash');
    await put(record);
  };
  await assert.rejects(manager.resurrect('root', 1), /local crash/u);
  const active = repo.manifests.get('root')!;
  const chain = chainEvents(active.entity.chainHash, [event(0)]);
  const row = batchRow('root', 2, 0, chain);
  repo.rows.set(row.rowKey, { entity: row, etag: 'committed-after-crash' });
  await repo.updateManifest({ ...active.entity, writerEpoch: active.entity.writerEpoch + 4,
    eventCount: 1, headSeq: 0, batchCount: 1, headHash: row.headHash, chainHash: row.chainHash,
    lastBatchRowKey: row.rowKey, lastBatchGeneration: 2, lastBatchBlobName: row.blobName }, active.etag);
  local.putSession = put;
  const result = await manager.resurrect('root', 1);
  assert.equal(result.eventCount, 1);
  assert.equal(records.get('root')?.generation, 2);
  assert.equal(records.get('root')?.lastSyncedEventCount, undefined, 'activation proof is not a raw local-prefix proof');
  assert.equal(records.get('root')?.lastSyncedChainHash, undefined);
  assert.equal(records.get('root')?.status, 'setup-needed');
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
});

for (const mutation of ['different-token', 'later-generation', 'header', 'cut', 'previous-generation', 'root', 'genesis', 'disabled', 'deleted'] as const) {
  test(`pending resurrection never adopts ${mutation} remote progression`, async () => {
    const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
    const put = local.putSession.bind(local);
    local.putSession = async record => {
      if (record.state === 'active') throw new Error('injected local crash');
      await put(record);
    };
    await assert.rejects(manager.resurrect('root', 1), /local crash/u);
    const current = repo.manifests.get('root')!;
    const entity = { ...current.entity };
    if (mutation === 'different-token') entity.resurrectionId = '00000000-0000-4000-8000-000000000099';
    if (mutation === 'later-generation') { entity.generation = 3; entity.rootGeneration = 3; entity.previousGeneration = 2; }
    if (mutation === 'header') entity.headerJson = canonicalJson(sessionHeader({ id: 'root', cwd: '/other' }));
    if (mutation === 'cut') entity.inheritedEventCount += 1;
    if (mutation === 'previous-generation') entity.previousGeneration = 9;
    if (mutation === 'root') entity.rootSessionId = 'unrelated-root';
    if (mutation === 'genesis') entity.chainHash = HEX_A;
    if (mutation === 'disabled') { entity.state = 'disabled'; entity.enabled = false; }
    if (mutation === 'deleted') { entity.state = 'deleted'; entity.enabled = false; }
    repo.manifests.set('root', { entity, etag: 'unrelated-remote-update' });
    local.putSession = put;
    const pending = structuredClone(records.get('root'));
    const calls = [...repo.calls];
    await assert.rejects(manager.resurrect('root', 1), AzureSyncError);
    assert.equal(records.get('root')?.generation, pending?.generation, 'terminalization does not adopt the remote generation');
    assert.equal(records.get('root')?.enabled, false);
    assert.equal(records.get('root')?.resurrectionIntent, undefined, 'definitively lost completion is no longer an immortal startup intent');
    assert.equal(records.get('root')?.detached, false);
    assert.equal(records.get('root')?.admissionStopped, true, `terminal ${mutation} must stay admission-blocked after clearing the intent`);
    assert.deepEqual(await manager.repairPending(), { repaired: [], failed: [] });
    assert.deepEqual(repo.calls, calls, 'recovery cannot retry CAS against unrelated progression');
    assert.deepEqual(repo.manifests.get('root')?.entity, entity);
  });
}

test('without a recorded operation neither explicit no-expected retry nor startup adopts an unrelated new generation', async () => {
  const entity = boundSession({ sessionId: 'root', generation: 2 });
  const record = localSession({ sessionId: 'root', generation: 1, state: 'deleted', enabled: false });
  const { repo, records, manager } = setup([entity], [], [record]);
  await assert.rejects(manager.resurrect('root'), /generation changed/u);
  await manager.repairPending();
  assert.deepEqual(records.get('root'), record);
  assert.equal(repo.calls.length, 0);
});

for (const when of ['before-CAS', 'after-CAS'] as const) test(`cleared local intent cancels stale resurrection ${when} without local re-enable`, async () => {
  const { repo, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const cancel = () => {
    const record = records.get('root')!;
    records.set('root', { ...record, enabled: false, state: 'disabled', status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
      resurrectionCancellationId: '00000000-0000-4000-8000-000000000098' });
  };
  if (when === 'before-CAS') repo.blob.ensureEmptyBlob = async () => { cancel(); };
  else {
    const update = repo.updateManifest.bind(repo);
    repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.state === 'active') cancel(); };
  }
  await assert.rejects(manager.resurrect('root', 1), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(records.get('root')?.generation, 1);
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(repo.manifests.get('root')?.entity.generation, when === 'before-CAS' ? 1 : 2);
  assert.equal(repo.manifests.get('root')?.entity.state, when === 'before-CAS' ? 'deleted' : 'disabled');
  assert.equal(records.get('root')?.detached, true, 'a NEWER explicit off keeps its opt-out admission semantics');
  assert.equal(records.get('root')?.admissionStopped, false);
  assert.equal(records.get('root')?.resurrectionCancellationId, '00000000-0000-4000-8000-000000000098');
  if (when === 'after-CAS') assert.equal(repo.manifests.get('root')?.entity.writerEpoch, 3, 'late own activation is conditionally fenced by a newer disable epoch');
  await manager.repairPending();
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(records.get('root')?.detached, true);
  assert.equal(records.get('root')?.admissionStopped, false);
  assert.equal(records.get('root')?.resurrectionCancellationId, '00000000-0000-4000-8000-000000000098');
});

test('disabled re-enable write failure repairs the same generation and retains its exact header, committed tip and local checkpoints', async () => {
  const header = sessionHeader({ id: 'root' });
  const binding = headerHash(header, 2);
  const chain = chainEvents(genesisHash('root', 3, binding), [event(0)]);
  const row = batchRow('root', 3, 0, chain);
  const root = boundSession({ sessionId: 'root', generation: 3, state: 'disabled', enabled: false,
    inheritedEventCount: 2, headerJson: JSON.stringify(header), chainHash: row.chainHash, headHash: row.headHash,
    lastBatchRowKey: row.rowKey, lastBatchGeneration: 3, lastBatchBlobName: row.blobName });
  const record = localSession({ sessionId: 'root', generation: 3, state: 'disabled', enabled: false, imported: true,
    lastSyncedEventCount: 1, lastSyncedChainHash: root.chainHash, lastSyncedHeaderHash: root.headerHash, importState: 'complete', catchUpPending: true });
  const { repo, local, records, manager } = setup([root], [row], [record]);
  const put = local.putSession.bind(local);
  local.putSession = async next => { if (next.state === 'active') throw new Error('injected re-enable local failure'); await put(next); };
  await assert.rejects(manager.resurrect('root', 3), /re-enable local/u);
  assert.equal(records.get('root')?.enabled, false);
  const token = records.get('root')?.resurrectionIntent?.operationId;
  assert.ok(token);
  local.putSession = put;
  await manager.repairPending();
  const active = repo.manifests.get('root')!.entity;
  assert.equal(active.generation, 3);
  assert.equal(active.resurrectionId, token);
  assert.equal(active.headerJson, root.headerJson);
  assert.equal(active.headerHash, root.headerHash);
  assert.equal(active.inheritedEventCount, 2);
  assert.equal(active.lastBatchRowKey, row.rowKey);
  assert.equal(active.chainHash, root.chainHash);
  assert.equal(records.get('root')?.importState, 'complete');
  assert.equal(records.get('root')?.catchUpPending, true);
  assert.equal(records.get('root')?.imported, true);
  assert.equal(records.get('root')?.lastSyncedEventCount, 1);
  assert.equal(records.get('root')?.lastSyncedChainHash, record.lastSyncedChainHash);
  assert.equal(records.get('root')?.lastSyncedHeaderHash, record.lastSyncedHeaderHash);
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(repo.rows.has(row.rowKey), true);
  assert.equal(repo.calls.filter(call => call.startsWith('manifest:root:active:')).length, 1);
  assert.equal(repo.calls.some(call => /^(blob|lease|row):/u.test(call)), false);
});

test('newer cancellation during cleanup cancels both in-flight and older queued resurrection before intent creation', async () => {
  const { repo, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const update = repo.updateManifest.bind(repo);
  let first = true;
  repo.updateManifest = async (entity, etag) => {
    if (first && entity.state === 'deleted') { first = false; reached(); await blocked; }
    await update(entity, etag);
  };
  const firstAction = manager.resurrect('root', 1);
  const queuedAction = manager.resurrect('root', 1);
  const settled = Promise.allSettled([firstAction, queuedAction]);
  await entered;
  const record = records.get('root')!;
  records.set('root', { ...record, enabled: false, state: 'disabled', status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
    resurrectionCancellationId: '00000000-0000-4000-8000-000000000097' });
  release();
  for (const result of await settled) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal((result.reason as AzureSyncError).code, 'CANCELLED');
  }
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(repo.manifests.get('root')?.entity.generation, 1);
  assert.equal(repo.manifests.get('root')?.entity.state, 'deleted');
  assert.equal(repo.calls.some(call => call.startsWith('manifest:root:active:')), false);
  assert.equal(records.get('root')?.detached, true);
  assert.equal(records.get('root')?.admissionStopped, false);
  assert.equal(records.get('root')?.resurrectionCancellationId, '00000000-0000-4000-8000-000000000097');
  // A NEW explicit action after off captures the newer cancellation marker and
  // revokes that opt-out, while both OLDER canceled actions must preserve it.
  assert.equal((await manager.resurrect('root', 1)).generation, 2);
  assert.equal(records.get('root')?.detached, false);
  assert.equal(records.get('root')?.admissionStopped, false);
});

test('startup repair terminalizes a lost operation but still repairs independent recorded intents', async () => {
  const { repo, local, records, manager } = setup([
    boundSession({ sessionId: 'stale', state: 'deleted', enabled: false }),
    boundSession({ sessionId: 'recoverable', state: 'deleted', enabled: false }),
  ]);
  const put = local.putSession.bind(local);
  local.putSession = async record => { if (record.state === 'active') throw new Error('injected crash'); await put(record); };
  await assert.rejects(manager.resurrect('stale', 1), /crash/u);
  await assert.rejects(manager.resurrect('recoverable', 1), /crash/u);
  const stale = repo.manifests.get('stale')!;
  repo.manifests.set('stale', { entity: { ...stale.entity, generation: 3, rootGeneration: 3,
    previousGeneration: 2 }, etag: 'later-unrelated-generation' });
  local.putSession = put;
  assert.deepEqual(await manager.repairPending(), { repaired: ['recoverable'], failed: ['stale'] });
  assert.equal(records.get('stale')?.generation, 1);
  assert.equal(records.get('stale')?.enabled, false);
  assert.equal(records.get('stale')?.status, 'generation-changed');
  assert.equal(records.get('stale')?.resurrectionIntent, undefined);
  assert.equal(records.get('recoverable')?.generation, 2);
  assert.equal(records.get('recoverable')?.enabled, true);
  assert.equal(records.get('recoverable')?.resurrectionIntent, undefined);
  assert.deepEqual(await manager.repairPending(), { repaired: [], failed: [] });
});

test('lost original source ETag terminalizes an uncommitted intent without activating or adopting', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') throw new AzureSyncError('TRANSIENT', 'injected failure before CAS');
    await update(entity, etag);
  };
  await assert.rejects(manager.resurrect('root', 1), /before CAS/u);
  assert.ok(local.getSession('root')?.resurrectionIntent);
  repo.updateManifest = update;
  const current = repo.manifests.get('root')!;
  await update({ ...current.entity, updatedAt: 1234 }, current.etag);
  assert.deepEqual(await manager.repairPending(), { repaired: [], failed: ['root'] });
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(records.get('root')?.status, 'conflict');
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(records.get('root')?.generation, 1);
  assert.equal(repo.manifests.get('root')?.entity.state, 'deleted');
  assert.equal(repo.manifests.get('root')?.entity.generation, 1);
  assert.equal(repo.calls.some(call => call.startsWith('manifest:root:active:')), false);
});

for (const code of ['TRANSIENT', 'AUTH_REQUIRED', 'AUTH_FAILED'] as const) test(`startup preserves recorded intent after ${code} and reports only that record as failed`, async () => {
  const { repo, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') throw new AzureSyncError(code, 'injected retryable/auth failure');
    await update(entity, etag);
  };
  await assert.rejects(manager.resurrect('root', 1), /retryable/u);
  const intent = structuredClone(records.get('root')?.resurrectionIntent);
  assert.ok(intent);
  assert.deepEqual(await manager.repairPending(), { repaired: [], failed: ['root'] });
  assert.deepEqual(records.get('root')?.resurrectionIntent, intent);
  assert.equal(records.get('root')?.enabled, false);
  repo.updateManifest = update;
  assert.deepEqual(await manager.repairPending(), { repaired: ['root'], failed: [] });
  assert.equal(records.get('root')?.generation, 2);
});

for (const action of ['explicit', 'startup-repair'] as const) test(`${action} signal fences a newer off before its durable cancellation write becomes visible`, async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const controller = new AbortController();
  const put = local.putSession.bind(local);
  let activeWrites = 0;
  local.putSession = async record => { if (record.state === 'active') activeWrites += 1; await put(record); };
  if (action === 'startup-repair') {
    local.putSession = async record => { if (record.state === 'active') throw new Error('injected old process crash'); await put(record); };
    await assert.rejects(manager.resurrect('root', 1), /old process crash/u);
    local.putSession = async record => { if (record.state === 'active') activeWrites += 1; await put(record); };
    const get = repo.getManifest.bind(repo);
    let abort = true;
    repo.getManifest = async id => {
      const current = await get(id);
      if (abort && current?.entity.state === 'active') { abort = false; controller.abort(); }
      return current;
    };
    assert.deepEqual(await manager.repairPending(() => controller.signal), { repaired: [], failed: ['root'] });
  } else {
    const update = repo.updateManifest.bind(repo);
    repo.updateManifest = async (entity, etag) => { await update(entity, etag); if (entity.state === 'active') controller.abort(); };
    await assert.rejects(manager.resurrect('root', 1, undefined, controller.signal), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  }
  assert.equal(activeWrites, 0, 'an invisible queued off write must not be followed by a queued active checkpoint');
  assert.equal(records.get('root')?.generation, 1);
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
  assert.equal(repo.manifests.get('root')?.entity.state, 'disabled');
  const pending = records.get('root')!;
  await put({ ...pending, state: 'disabled', enabled: false, status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
    resurrectionCancellationId: '00000000-0000-4000-8000-000000000093' });
  assert.deepEqual(await manager.repairPending(), { repaired: [], failed: [] });
});

test('cancellation during an already-started local checkpoint is checked after durability and compensates only its cloud activation', async () => {
  const { repo, local, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const controller = new AbortController();
  const put = local.putSession.bind(local);
  local.putSession = async record => { await put(record); if (record.state === 'active') controller.abort(); };
  await assert.rejects(manager.resurrect('root', 1, undefined, controller.signal), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
  assert.equal(repo.manifests.get('root')?.entity.state, 'disabled');
  assert.equal(repo.manifests.get('root')?.entity.writerEpoch, 3);
  const current = records.get('root')!;
  await put({ ...current, state: 'disabled', enabled: false, status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
    resurrectionCancellationId: '00000000-0000-4000-8000-000000000092' });
  assert.equal(records.get('root')?.enabled, false);
});

test('startup captures every recorded session action signal before the first repair await', async () => {
  const { repo, local, records, manager } = setup([
    boundSession({ sessionId: 'first', state: 'deleted', enabled: false }),
    boundSession({ sessionId: 'second', state: 'deleted', enabled: false }),
  ]);
  const put = local.putSession.bind(local);
  local.putSession = async record => { if (record.state === 'active') throw new Error('injected checkpoint crash'); await put(record); };
  await assert.rejects(manager.resurrect('first', 1), /checkpoint crash/u);
  await assert.rejects(manager.resurrect('second', 1), /checkpoint crash/u);
  local.putSession = put;
  const controllers = new Map([['first', new AbortController()], ['second', new AbortController()]]);
  const captured: string[] = [];
  const get = repo.getManifest.bind(repo);
  let invalidate = true;
  repo.getManifest = async id => {
    const current = await get(id);
    if (id === 'first' && invalidate) {
      invalidate = false;
      assert.deepEqual(captured, ['first', 'second']);
      controllers.get('second')!.abort();
      controllers.set('second', new AbortController()); // what a newer service off does synchronously
    }
    return current;
  };
  const report = await manager.repairPending(id => { captured.push(id); return controllers.get(id)!.signal; });
  assert.deepEqual(report, { repaired: ['first'], failed: ['second'] });
  assert.equal(records.get('first')?.generation, 2);
  assert.equal(records.get('first')?.enabled, true);
  assert.equal(records.get('second')?.generation, 1);
  assert.equal(records.get('second')?.enabled, false);
  assert.equal(repo.manifests.get('second')?.entity.state, 'disabled');
});

test('a lost activation CAS response cannot skip compensation after newer explicit off', async () => {
  const { repo, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
  const update = repo.updateManifest.bind(repo);
  repo.updateManifest = async (entity, etag) => {
    await update(entity, etag);
    if (entity.state !== 'active') return;
    const record = records.get('root')!;
    records.set('root', { ...record, enabled: false, state: 'disabled', status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
      resurrectionCancellationId: '00000000-0000-4000-8000-000000000094' });
    throw new AzureSyncError('TRANSIENT', 'activation CAS committed but response was lost');
  };
  await assert.rejects(manager.resurrect('root', 1), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
  assert.equal(repo.manifests.get('root')?.entity.generation, 2);
  assert.equal(repo.manifests.get('root')?.entity.state, 'disabled');
  assert.equal(repo.manifests.get('root')?.entity.writerEpoch, 3);
  assert.equal(records.get('root')?.generation, 1);
  assert.equal(records.get('root')?.enabled, false);
  assert.equal(records.get('root')?.resurrectionIntent, undefined);
  assert.equal(records.get('root')?.detached, true);
  assert.equal(records.get('root')?.admissionStopped, false);
  assert.equal(records.get('root')?.resurrectionCancellationId, '00000000-0000-4000-8000-000000000094');
});

for (const progression of ['new-owner', 'new-token', 'new-generation', 'committed-tip', 'ETag-race'] as const) {
  test(`late-cancellation compensation never touches ${progression}`, async () => {
    const { repo, records, manager } = setup([boundSession({ sessionId: 'root', state: 'deleted', enabled: false })]);
    const update = repo.updateManifest.bind(repo);
    let progressed: StoredManifest | undefined;
    repo.updateManifest = async (entity, etag) => {
      if (entity.state === 'disabled' && progression === 'ETag-race') {
        const current = repo.manifests.get('root')!;
        progressed = { entity: { ...current.entity, writerEpoch: current.entity.writerEpoch + 1,
          leaseOwner: 'new-writer', leaseUntil: 1000 }, etag: 'new-owner-after-compensation-read' };
        repo.manifests.set('root', progressed);
        throw new AzureSyncError('PRECONDITION', 'newer owner won compensation CAS');
      }
      await update(entity, etag);
      if (entity.state !== 'active') return;
      const record = records.get('root')!;
      records.set('root', { ...record, enabled: false, state: 'disabled', status: 'detached', detached: true, admissionStopped: false, resurrectionIntent: undefined,
        resurrectionCancellationId: '00000000-0000-4000-8000-000000000096' });
      if (progression === 'ETag-race') return;
      const current = repo.manifests.get('root')!;
      const next = { ...current.entity };
      if (progression === 'new-owner') { next.writerEpoch += 1; next.leaseOwner = 'new-writer'; next.leaseUntil = 1000; }
      if (progression === 'new-token') next.resurrectionId = '00000000-0000-4000-8000-000000000095';
      if (progression === 'new-generation') { next.generation = 3; next.rootGeneration = 3; next.previousGeneration = 2; }
      if (progression === 'committed-tip') { next.eventCount = 1; next.headSeq = 0; next.chainHash = HEX_A; }
      progressed = { entity: next, etag: 'newer-remote-progression' };
      repo.manifests.set('root', progressed);
    };
    await assert.rejects(manager.resurrect('root', 1), error => error instanceof AzureSyncError && error.code === 'CANCELLED');
    assert.ok(progressed);
    assert.deepEqual(repo.manifests.get('root'), progressed);
    assert.equal(records.get('root')?.enabled, false);
    assert.equal(records.get('root')?.generation, 1);
    assert.equal(records.get('root')?.resurrectionIntent, undefined);
    assert.equal(records.get('root')?.detached, true);
    assert.equal(records.get('root')?.admissionStopped, false);
    assert.equal(records.get('root')?.resurrectionCancellationId, '00000000-0000-4000-8000-000000000096');
  });
}
