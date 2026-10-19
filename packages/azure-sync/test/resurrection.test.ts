import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { Context } from '@deepseek-ai/cordis';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { Storage } from '@deepseek-ai/dsh-storage';
import { LocalStore } from '../src/local/store.js';
import { Config } from '../src/config.js';
import { batchRowKey } from '../src/schema.js';
import { canonicalJson, payloadBytes } from '../src/sync/canonical.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { batchMetadata, candidateBlobName } from '../src/sync/cloud-repository.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { Importer } from '../src/sync/importer.js';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { SyncService } from '../src/sync/service.js';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { Uploader } from '../src/sync/uploader.js';
import { AcceptanceCloud, acceptanceDevice } from './acceptance-helpers.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';

test('real remapped Windows-source import is explicitly resurrected with a fresh canonical header and fully reuploaded into generation two', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-resurrection-')));
  const cloud = new AcceptanceCloud();
  const device = await acceptanceDevice(join(root, 'local'), 'device-b', cloud);
  let service: SyncService | undefined;
  t.after(async () => {
    await service?.close();
    await device.close();
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  const id = `session-${randomUUID()}`;
  const oldHeader = sessionHeader({ id, cwd: 'C:\\PROJECT\\Src' });
  const events = [event(0, 'working-directory/change', { cwd: 'C:\\PROJECT\\Src\\nested' }),
    event(1, 'session/title', { title: 'Imported Windows history', messageSeqs: [], source: { kind: 'user' } })];
  const oldBinding = headerHash(oldHeader, 0);
  const chain = chainEvents(genesisHash(id, 1, oldBinding), events);
  const name = candidateBlobName(id, 1, 0, 1, chain.payloadHash);
  const row = batchRow(id, 1, 0, { ...chain, endSeq: 1, eventCount: 2, blobName: name });
  const manifest = cloudSession({ sessionId: id, headerJson: canonicalJson(oldHeader), headerHash: oldBinding,
    cwd: oldHeader.cwd, sourcePlatform: 'win32', headHash: chain.headHash, chainHash: chain.chainHash,
    eventCount: 2, headSeq: 1, lastBatchRowKey: row.rowKey,
    lastBatchGeneration: 1, lastBatchBlobName: name, batchCount: 1 });
  await cloud.createManifest(manifest);
  await cloud.putCandidate(name, gzipSync(payloadBytes(events)), { ...batchMetadata(row, oldBinding) });
  cloud.rows.set(row.rowKey, { entity: row, etag: 'old-generation-row' });
  const mapping = pathMapping({ remotePrefix: 'C:/project/src', remotePlatform: 'win32', localPrefix: device.cwd });
  const binding = { mapping, fs: nodeCwdFs };
  const config = Config({ maxBatchEvents: 4 });
  const checkpoints = new Map<string, ReturnType<typeof device.ctx.sessionProjections.snapshot>>();
  const projection = new ProjectionWarmer({ pollMs: 1, cache: {
    coldSnapshot(header: SessionHeader, inherited: number, values: readonly SessionEvent[]) {
      const restored = device.ctx.sessionProjections.restore({}, values, 0 as never, header, inherited as never);
      checkpoints.set(header.id, restored.snapshot);
    },
    cachedSnapshot(header: SessionHeader) { return checkpoints.get(header.id); },
  } as never });
  const importer = new Importer({ config, persistence: device.ctx.sessionPersistence, repository: cloud.asRepository(),
    local: device.local, cwdBinding: async () => binding, projection, now: Date.now });
  assert.equal((await importer.import(id)).status, 'complete');
  const imported = device.local.getSession(id);
  assert.ok(imported?.imported && imported.remapped);
  const localized = await device.source.read(id);
  assert.ok(localized);
  assert.equal(localized.header.cwd, device.cwd);
  assert.equal(localized.events[0]?.type, 'working-directory/change');
  assert.equal((localized.events[0]?.data as { cwd: string }).cwd, join(device.cwd, 'nested'));
  const uploader = new Uploader({ config, source: device.source, repository: cloud.asRepository(), leases: cloud.leases('device-b'),
    local: device.local, deviceId: 'device-b', platform: 'linux', cwdBinding: async () => binding, now: Date.now });
  service = new SyncService({ uploader, local: device.local, repository: cloud.asRepository(), reader: device.reader,
    source: device.source, agents: device.ctx.agents,
    tombstones: new TombstoneManager(cloud.asRepository(), device.local, Date.now, 'device-b'), now: Date.now });
  await service.removeFromCloud(id);
  assert.equal((await cloud.getManifest(id))?.entity.cleanupPending, false);
  assert.equal((await cloud.listBatchRows(id, 1)).length, 0);
  assert.equal(cloud.candidates.size, 0);
  const fresh = await uploader.snapshotForResurrection(id);
  assert.ok(fresh);
  assert.equal(fresh.header.cwd, 'C:/project/src');
  assert.notEqual(headerHash(fresh.header, fresh.inheritedEventCount), oldBinding, 'new source-case/separator normalization is a new explicit commitment');
  const transact = device.local.transactSession.bind(device.local);
  let failedCheckpoint = false;
  device.local.transactSession = (sessionId, fn) => transact(sessionId, current => {
    const record = fn(current);
    if (!failedCheckpoint && record?.state === 'active' && record.generation === 2 && record.resurrectionIntent === undefined) {
      failedCheckpoint = true;
      throw new Error('injected post-CAS local checkpoint failure');
    }
    return record;
  });
  await assert.rejects(service.resurrectInCloud(id), /post-CAS local checkpoint/u);
  assert.equal(failedCheckpoint, true);
  assert.equal((await cloud.getManifest(id))?.entity.generation, 2);
  assert.equal(device.local.getSession(id)?.generation, 1);
  assert.equal(device.local.getSession(id)?.state, 'deleted');
  assert.equal(device.local.getSession(id)?.enabled, false);
  const operationId = device.local.getSession(id)?.resurrectionIntent?.operationId;
  assert.ok(operationId);
  assert.equal((await cloud.getManifest(id))?.entity.resurrectionId, operationId);
  assert.deepEqual(await device.source.read(id), localized, 'failed checkpoint never deletes or resets localized JSONL');
  device.local.transactSession = transact;
  // Service passes the still-local expected generation ONE while cloud is already
  // active generation TWO (and supplies no fresh header on this exact retry).
  const revived = await service.resurrectInCloud(id);
  assert.equal(revived.generation, 2);
  assert.equal(revived.resurrectionId, operationId);
  assert.equal(device.local.getSession(id)?.resurrectionIntent, undefined);
  assert.equal(revived.rootGeneration, 2);
  assert.equal(revived.headSeq, -1);
  assert.equal(revived.headerHash, headerHash(fresh.header, fresh.inheritedEventCount));
  assert.equal(revived.chainHash, genesisHash(id, 2, revived.headerHash));
  assert.equal(device.local.getSession(id)?.imported, false);
  assert.equal(device.local.getSession(id)?.lastSyncedEventCount, undefined);
  assert.equal(device.local.getSession(id)?.canonicalCwd, 'C:/project/src');
  const result = await service.sync(id);
  assert.equal(result.status, 'synced');
  assert.equal(result.eventCount, localized.events.length);
  const uploaded = await device.reader.read(id);
  assert.ok(uploaded);
  assert.equal(uploaded.manifest.entity.generation, 2);
  assert.equal(uploaded.header.cwd, 'C:/project/src');
  assert.equal(uploaded.events[0]?.type, 'working-directory/change');
  assert.equal((uploaded.events[0]?.data as { cwd: string }).cwd, 'C:/project/src/nested');
  assert.ok(cloud.rows.has(batchRowKey(id, 2, 0)));
  assert.equal((await cloud.listBatchRows(id, 1)).length, 0);
  assert.deepEqual(await device.source.read(id), localized, 'explicit cloud re-upload never rewrites localized durable JSONL');
});

for (const newer of ['detach', 'local-deletion'] as const) test(`real SDK transaction callback rejects a final resurrection checkpoint after newer ${newer}`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-resurrection-atomic-')));
  const ctx = new Context();
  new Storage(ctx);
  const backend = new JsonStorageBackend(join(root, 'domain'));
  ctx.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(ctx, { backend: 'fixture-json' });
  const local = new LocalStore(facility);
  await local.open();
  t.after(async () => {
    await local.close(); await facility.closeAll(); await backend.close();
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  const id = `session-${randomUUID()}`;
  const header = sessionHeader({ id });
  const cloud = new AcceptanceCloud();
  await cloud.createManifest(cloudSession({ sessionId: id, state: 'deleted', enabled: false,
    headerJson: canonicalJson(header), headerHash: headerHash(header, 0) }));
  await local.putSession(localSession({ sessionId: id, state: 'deleted', enabled: false }));
  const transact = local.transactSession.bind(local);
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let gate = true;
  local.transactSession = async (sessionId, fn) => {
    if (gate && cloud.manifests.get(sessionId)?.entity.generation === 2) {
      gate = false;
      entered();
      await blocked; // pause BEFORE SDK callback evaluation, not after it captured a record
    }
    return transact(sessionId, fn);
  };
  const manager = new TombstoneManager(cloud.asRepository(), local, Date.now, 'device-a');
  const action = manager.resurrect(id, 1);
  const rejected = assert.rejects(action, error => error instanceof Error && (error as { code?: string }).code === 'CANCELLED');
  await reached;
  if (newer === 'local-deletion') await local.deleteSession(id);
  else await transact(id, current => current === undefined ? undefined : { ...current, enabled: false,
    state: 'disabled', detached: true, admissionStopped: false, status: 'detached', resurrectionIntent: undefined,
    resurrectionCancellationId: randomUUID(), lastError: 'latest durable detach diagnostic' });
  const latest = structuredClone(local.getSession(id));
  release();
  await rejected;
  assert.deepEqual(local.getSession(id), latest);
  assert.equal((await cloud.getManifest(id))?.entity.generation, 2);
  assert.equal((await cloud.getManifest(id))?.entity.state, 'disabled');
  // Reopen the actual SDK/domain lane: no stale active checkpoint or resurrected
  // local row may have reached the durable medium after the newer permission.
  await local.close();
  await local.open();
  assert.equal(canonicalJson(local.getSession(id) ?? null), canonicalJson(latest ?? null));
});

for (const crash of ['before-CAS', 'after-CAS'] as const) test(`durable local-domain reopen recovers only the recorded explicit resurrection ${crash}`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-resurrection-reopen-')));
  const open = async () => {
    const ctx = new Context();
    new Storage(ctx);
    const backend = new JsonStorageBackend(join(root, 'domain'));
    ctx.storage.backend.register('fixture-json', backend);
    const facility = new DomainFacility(ctx, { backend: 'fixture-json' });
    const local = new LocalStore(facility);
    await local.open();
    return { local, async close() { await local.close(); await facility.closeAll(); await backend.close(); } };
  };
  let store = await open();
  t.after(async () => {
    await store.close();
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  const id = `session-${randomUUID()}`;
  const cloud = new AcceptanceCloud();
  const header = sessionHeader({ id });
  const binding = headerHash(header, 3);
  const genesis = genesisHash(id, 1, binding);
  await cloud.createManifest(cloudSession({ sessionId: id, state: 'deleted', enabled: false, cleanupPending: false,
    headerJson: canonicalJson(header), headerHash: binding, inheritedEventCount: 3,
    eventCount: 0, headSeq: -1, headHash: genesis, chainHash: genesis, batchCount: 0,
    lastBatchRowKey: undefined, lastBatchGeneration: undefined, lastBatchBlobName: undefined }));
  await store.local.putSession(localSession({ sessionId: id, generation: 1, state: 'deleted', enabled: false,
    imported: true, importState: 'complete', lastSyncedEventCount: 5,
    lastSyncedHeaderHash: binding, lastSyncedChainHash: genesis }));
  // An unrelated remote generation must not become an implicit explicit intent.
  const unrelatedId = `unrelated-${randomUUID()}`;
  await store.local.putSession(localSession({ sessionId: unrelatedId, generation: 1, state: 'deleted', enabled: false }));
  await cloud.createManifest(cloudSession({ sessionId: unrelatedId, generation: 2 }));
  const update = cloud.updateManifest.bind(cloud);
  const transact = store.local.transactSession.bind(store.local);
  if (crash === 'before-CAS') cloud.updateManifest = async (entity, etag) => {
    if (entity.state === 'active') throw new Error('injected process crash before cloud CAS');
    await update(entity, etag);
  };
  else store.local.transactSession = (sessionId, fn) => transact(sessionId, current => {
    const record = fn(current);
    if (record?.state === 'active' && record.generation === 2) throw new Error('injected process crash after cloud CAS');
    return record;
  });
  const manager = new TombstoneManager(cloud.asRepository(), store.local, () => 100, 'device-a');
  await assert.rejects(manager.resurrect(id, 1), /injected process crash/u);
  const intent = structuredClone(store.local.getSession(id)?.resurrectionIntent);
  assert.ok(intent);
  assert.equal(store.local.getSession(id)?.generation, 1);
  const cloudAfterCrash = await cloud.getManifest(id);
  assert.equal(cloudAfterCrash?.entity.generation, crash === 'before-CAS' ? 1 : 2);
  await store.close();
  cloud.updateManifest = update;
  store = await open();
  assert.equal(canonicalJson(store.local.getSession(id)?.resurrectionIntent), canonicalJson(intent), 'write-ahead intent survives domain/backend recreation');
  assert.equal(store.local.getSession(id)?.enabled, false);
  const recovered = new TombstoneManager(cloud.asRepository(), store.local, () => 200, 'device-a');
  await recovered.repairPending();
  const remote = await cloud.getManifest(id);
  assert.equal(remote?.entity.generation, 2);
  assert.equal(remote?.entity.resurrectionId, intent.operationId);
  assert.equal(remote?.entity.headerJson, intent.target.headerJson);
  assert.equal(remote?.entity.headerHash, intent.target.headerHash);
  assert.equal(remote?.entity.inheritedEventCount, 3);
  assert.equal(remote?.entity.chainHash, intent.genesisHash);
  if (crash === 'after-CAS') assert.equal(remote?.etag, cloudAfterCrash?.etag, 'startup checkpoint repair does not republish the cloud generation');
  const repaired = store.local.getSession(id);
  assert.equal(repaired?.generation, 2);
  assert.equal(repaired?.enabled, true);
  assert.equal(repaired?.resurrectionIntent, undefined);
  assert.equal(repaired?.lastSyncedEventCount, undefined);
  assert.equal(repaired?.importState, undefined);
  assert.equal(repaired?.imported, false);
  assert.equal(store.local.getSession(unrelatedId)?.generation, 1);
  assert.equal(store.local.getSession(unrelatedId)?.enabled, false);
  const etag = remote?.etag;
  await recovered.repairPending();
  assert.equal((await cloud.getManifest(id))?.etag, etag, 'repeated startup repair is a no-op after the checkpoint commits');
});
