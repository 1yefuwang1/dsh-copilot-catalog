import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient } from '@azure/data-tables';
import { SessionId, type SessionHeader, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { Config } from '../src/config.js';
import { BlobStore } from '../src/azure/blob.js';
import { TableStore } from '../src/azure/table.js';
import { LeaseManager } from '../src/azure/lease.js';
import { CloudRepository, leaseBlobName } from '../src/sync/cloud-repository.js';
import { SessionLeaseManager } from '../src/sync/lease-manager.js';
import { Uploader, type UploadDependencies } from '../src/sync/uploader.js';
import { decodeGitContextJson } from '../src/git/context.js';
import { SyncService } from '../src/sync/service.js';
import { RemoteSessionReader, type HistoryCacheOptions } from '../src/sync/remote-session.js';
import { HistoryPinStore } from '../src/sync/history-state.js';
import { TombstoneManager } from '../src/sync/tombstone-manager.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { CostHttpMeter, assertNoHistory, totalCostRequests as total, combineCostCounts as combine, type CostCounts as Counts } from './cost-http-meter.js';
import { Importer } from '../src/sync/importer.js';
import { ImportService } from '../src/sync/import-service.js';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { AttachmentSync } from '../src/sync/attachments.js';
import { CloudController } from '../src/controller.js';
import { SettingsService } from '../src/settings.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { AcceptanceCloud, acceptanceDevice, type AcceptanceDevice } from './acceptance-helpers.js';
import { event, pathMapping } from './helpers.js';
import { startAzurite, temporaryRoot, removeTemporaryRoot } from './azurite-helpers.js';

/** Legacy retail operation inputs are retained transparently, not represented as a current rate quote. */
function operationUSD(value: Counts): number {
  return (value.blobWrites + value.blobLists) * 0.05 / 10_000 + (value.blobReads + value.blobOther) * 0.004 / 10_000 + (value.tableReads + value.tableQueries + value.tableWrites + value.tableBatches + value.tableOther) * 0.00036 / 10_000;
}

test('measured real-Azurite HTTP profile supports an explicit retail cost model, never a monthly-bill claim', { timeout: 120_000 }, async t => {
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const prefix = 'azure-cost-profile-', root = await temporaryRoot(prefix);
  const devices: AcceptanceDevice[] = [], services: SyncService[] = [], controllers: CloudController[] = [];
  const meter = new CostHttpMeter();
  const histories = new Map<AcceptanceDevice, { reader: RemoteSessionReader; pins: HistoryPinStore; directory: string; cache: HistoryCacheOptions }>();
  t.after(async () => {
    for (const controller of controllers) controller.close(); for (const service of services.reverse()) await service.close();
    for (const { reader, pins } of histories.values()) { await reader.close(); await pins.close(); }
    for (const device of devices.reverse()) await device.close();
    await meter.close();
    await removeTemporaryRoot(root, prefix);
  });
  const original = emulator.connection();
  const blobEndpoint = new URL(/BlobEndpoint=([^;]+)/u.exec(original)![1]!), tableEndpoint = new URL(/TableEndpoint=([^;]+)/u.exec(original)![1]!);
  const blobProxy = await meter.proxy(blobEndpoint, 'blob'), tableProxy = await meter.proxy(tableEndpoint, 'table');
  const connection = original.replace(blobEndpoint.origin, blobProxy).replace(tableEndpoint.origin, tableProxy);
  const blobClient = BlobServiceClient.fromConnectionString(connection, { retryOptions: { maxTries: 2, retryDelayInMs: 1, maxRetryDelayInMs: 1 } });
  const blob = new BlobStore(blobClient.getContainerClient('dsh-state'));
  const table = new TableStore(TableClient.fromConnectionString(connection, 'dshstatesync', { allowInsecureConnection: true }));
  const repository = new CloudRepository(blob, table), profiles = meter.profiles;
  const measure = <T>(name: string, action: () => Promise<T>) => meter.measure(name, action);
  async function historyFor(device: AcceptanceDevice, cache: HistoryCacheOptions = {}) {
    const previous = histories.get(device);
    if (previous) { await previous.reader.close(); await previous.pins.close(); }
    const directory = join(device.root, 'private-history-cache'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const pins = new HistoryPinStore(device.facility); await pins.open();
    const reader = new RemoteSessionReader(repository, { maxCompressedBytes: 6_291_456, maxExpandedBytes: Config({}).maxBatchBytes,
      maxEvents: Config({}).maxEventsPerSession, pins, cache: { directory, ...cache } });
    const history = { reader, pins, directory, cache }; histories.set(device, history); return history;
  }
  const a = await acceptanceDevice(join(root, 'a'), 'device-a', new AcceptanceCloud()); devices.push(a); await a.service.close(); await a.reader.close();
  const b = await acceptanceDevice(join(root, 'b'), 'device-b', new AcceptanceCloud(), a.cwd); devices.push(b); await b.service.close(); await b.reader.close();
  await historyFor(a); await historyFor(b);
  const config = Config({ maxBatchEvents: 1 });
  function makeService(device: AcceptanceDevice, maxBatchEvents: number, imported = false, gitContext?: UploadDependencies['gitContext']) {
    const binding = { mapping: pathMapping({ remotePrefix: a.cwd, localPrefix: device.cwd, revision: '1'.repeat(64) }), fs: nodeCwdFs };
    const history = histories.get(device); assert.ok(history);
    const reader = history.reader, deviceId = device === a ? 'device-a' : device === b ? 'device-b' : 'device-pressure';
    const localConfig = Config({ maxBatchEvents, historyMemoryBytes: history.cache.memoryBytes ?? config.historyMemoryBytes, historyDiskBytes: history.cache.diskBytes ?? config.historyDiskBytes });
    const leases = new SessionLeaseManager({ repository, leases: new LeaseManager(blob), deviceId, now: Date.now });
    const uploader = new Uploader({ config: localConfig, source: device.source, repository, reader, leases, local: device.local, deviceId, platform: 'linux', now: Date.now, renewEveryMs: 1_000_000, ...(imported ? { cwdBinding: async () => binding } : {}), ...(gitContext ? { gitContext } : {}) });
    const warmer = new ProjectionWarmer({ pollMs: 1, cache: {
      coldSnapshot(header: SessionHeader, inherited: number, events: readonly SessionEvent[]) { const restored = device.ctx.sessionProjections.restore({}, events, 0 as never, header, inherited as never); device.checkpoints.set(header.id, restored.snapshot); },
      cachedSnapshot: header => device.checkpoints.get(header.id),
    } });
    const imports = new ImportService(new Importer({ config: localConfig, persistence: device.ctx.sessionPersistence, repository, reader, local: device.local, cwdBinding: async () => binding, projection: warmer, now: Date.now }));
    const tombstones = new TombstoneManager(repository, device.local, Date.now, deviceId, (intent, receipt, context) => reader.confirmGenerationActivation(intent, receipt, context));
    const service = new SyncService({ uploader, local: device.local, repository, reader, source: device.source, imports, agents: device.ctx.agents, tombstones, historyJobTimeoutMs: localConfig.historyJobTimeoutMs, now: Date.now, refreshGitOnSync: !!gitContext }); services.push(service);
    return { service, uploader, leases, reader };
  }
  const one = makeService(a, 1000), eight = makeService(a, 1), steadyEight = makeService(a, 1000), imported = makeService(b, 1, true);
  async function log(id: string, count: number, parent?: string) {
    const header: SessionHeader = { id: SessionId(id), version: 4, createdAt: 1, cwd: a.cwd, isSeeded: false, ...(parent ? { origin: 'subagent', parentSession: SessionId(parent), delegationDepth: 1 } : {}) };
    const handle = await a.ctx.sessionPersistence.create(header);
    try { await handle.append(Array.from({ length: count }, (_, seq) => seq === 0 ? event(seq, 'working-directory/change', { cwd: a.cwd }) : seq === 1 ? event(seq, 'model/selection', { provider: 'fixture', model: 'no-network' }) : event(seq, 'user/message', { content: [{ type: 'text', text: 'Synthetic non-model cost fixture.' }] })) as never); await handle.flush(); }
    finally { await handle.close(); }
  }
  const rootOne = `session-${randomUUID()}`, rootEight = `session-${randomUUID()}`, childId = `session-${randomUUID()}`;
  await measure('infrastructure', async () => { await blob.ensurePrivateContainer(); await table.ensureTable(); });
  await log(rootOne, 1); await log(rootEight, 8);
  await measure('first_opt_in_one_batch', () => one.service.enable(rootOne));
  const foreignRawLeases = new LeaseManager(blob), foreignHandle = await foreignRawLeases.acquire(leaseBlobName(rootOne), 60);
  try { await measure('cold_takeover_one_batch', () => one.service.takeover(rootOne)); } finally { await foreignRawLeases.release(foreignHandle).catch(() => undefined); }
  assert.equal(profiles.first_opt_in_one_batch!.leaseAcquisitions30, 1); assert.equal(profiles.cold_takeover_one_batch!.leaseAcquisitions30, 1); assert.equal(one.uploader.hasHeld(rootOne), false);
  await measure('seed_eight_batches', () => eight.service.enable(rootEight));
  assert.equal((await repository.getManifest(rootOne))!.entity.batchCount, 1); assert.equal((await repository.getManifest(rootEight))!.entity.batchCount, 8);
  await measure('idle_one_batch', () => one.reader.observe(rootOne));
  await measure('idle_eight_batches', () => eight.reader.observe(rootEight));
  await measure('idle_background_all_native_records', () => one.service.refreshAll());
  for (const name of ['idle_one_batch', 'idle_eight_batches', 'idle_background_all_native_records']) assertNoHistory(profiles[name]!);
  await measure('cold_import_eight_batches', () => imported.service.importSession(rootEight));
  assert.equal(b.local.getSession(rootEight)?.importState, 'complete'); assert.equal(b.ctx.agents.list().length, 0);
  await measure('cold_imported_inspection_eight_batches', () => imported.service.ensureOwnership(rootEight, undefined, { inspection: true }));
  assert.equal(profiles.cold_imported_inspection_eight_batches!.leaseAcquisitions30, 1); assert.equal(imported.uploader.hasHeld(rootEight), false); assert.equal(b.ctx.agents.list().length, 0);
  await measure('idle_imported_eight_batches', () => imported.service.refreshAll());
  assertNoHistory(profiles.idle_imported_eight_batches!);
  const controller = new CloudController({ local: a.local, settings: new SettingsService({ local: a.local, config }), core: async () => { throw new Error('local status must not boot cloud'); } }); controllers.push(controller);
  await measure('five_local_status_requests', async () => { for (let index = 0; index < 5; index++) await controller.execute({ action: 'status', sessionId: rootEight }, { origin: 'rpc', signal: new AbortController().signal }); });
  assert.equal(total(profiles.five_local_status_requests!), 0);
  const nativeA = await a.resume(rootEight);
  const nativeSnapshot = await a.source.read(rootEight); assert.ok(nativeSnapshot); assert.ok(nativeSnapshot.events.length >= 8);
  // The actual SDK appends its lifecycle seed marker on resume. Keep that real
  // suffix: no synthetic marker/closer is fabricated or removed by this fixture.
  await measure('native_first_proof_eight_batches', () => eight.service.ensureOwnership(rootEight));
  assert.equal(profiles.native_first_proof_eight_batches!.leaseAcquisitions60, 1); assert.equal(profiles.native_first_proof_eight_batches!.leaseAcquisitions30, 0);
  await measure('native_held_proof_eight_batches', () => eight.service.ensureOwnership(rootEight));
  await measure('release_native_owner', () => eight.uploader.pause(rootEight));
  await b.resume(rootEight);
  await measure('imported_first_proof_eight_batches', () => imported.service.ensureOwnership(rootEight));
  await measure('imported_held_proof_eight_batches', () => imported.service.ensureOwnership(rootEight));
  await measure('release_imported_owner', () => imported.uploader.pause(rootEight));
  // One actual timer-equivalent renew, separately from per-step renew/proof.
  const renewalLease = await eight.leases.acquire(rootEight);
  await measure('background_lease_renew', () => eight.leases.renew(renewalLease)); await eight.leases.release(renewalLease);
  nativeA.session.append('session/title', { title: 'Measured incremental publication', messageSeqs: [], source: { kind: 'user' } }); await a.ctx.sessionPersistence.flush();
  await measure('incremental_sync_eight_existing_batches', async () => { await steadyEight.service.reconcile(rootEight); return steadyEight.uploader.sync(rootEight, { release: true }); });
  assert.equal((await repository.getManifest(rootEight))!.entity.batchCount, 9);
  const append = await a.ctx.sessionPersistence.open(SessionId(rootOne), 'write');
  try { const existing = await append.read(0); await append.append([event(existing.events.length, 'user/message', { content: [{ type: 'text', text: 'Incremental batch.' }] })] as never); await append.flush(); } finally { await append.close(); }
  await measure('incremental_sync_one_batch', () => one.service.sync(rootOne)); assert.equal(profiles.incremental_sync_one_batch!.leaseAcquisitions30, 1);
  await log(childId, 1, rootOne);
  await measure('child_first_publication', () => one.service.enable(childId));
  // Child acquisition, tip and release have multiple EGTs, each billed ONCE,
  // irrespective of the root-touch/entity action count inside that HTTP batch.
  assert.ok(profiles.child_first_publication!.tableBatches > 0); assert.equal(profiles.child_first_publication!.leaseAcquisitions30, 1);
  const originalCommit = repository.commitBatch.bind(repository); let race = true, attempts = 0;
  repository.commitBatch = async (...args) => {
    attempts++; if (race) { race = false; await repository.updateManifest({ ...args[0].entity, updatedAt: Date.now() }, args[0].etag); }
    return originalCommit(...args);
  };
  const again = await a.ctx.sessionPersistence.open(SessionId(rootOne), 'write');
  try { const current = await again.read(0); await again.append([event(current.events.length)] as never); await again.flush(); } finally { await again.close(); }
  try { await measure('candidate_orphan_cas_retry_exception', () => one.service.sync(rootOne)); } finally { repository.commitBatch = originalCommit; }
  assert.equal(attempts, 2); assert.ok(profiles.candidate_orphan_cas_retry_exception!.tableBatches >= 2);
  const attachmentBytes = Buffer.alloc(10 * 1024 * 1024, 65), attachmentId = `cost-${randomUUID()}`;
  const refs = [{ id: attachmentId, kind: 'file' as const, name: 'cost-fixture.bin', raw: { attachmentId, name: 'cost-fixture.bin', bytes: attachmentBytes.byteLength } }];
  const sender = new AttachmentSync({ blob, maxBytes: 20 * 1024 * 1024, now: Date.now, store: { readFileStream: async function* () { yield attachmentBytes; } } as unknown as AttachmentStore });
  const attachmentLease = await one.leases.acquire(rootOne, undefined, 30);
  const authorized = async () => { await one.leases.proof(rootOne, attachmentLease.epoch); };
  try {
    await measure('attachment_upload_10_mib', async () => { assert.deepEqual((await sender.upload(refs, { authorized })).missing, []); });
    await measure('attachment_repeat_10_mib', () => sender.upload(refs, { authorized }));
  } finally { await one.leases.release(attachmentLease); }
  const receiver = new AttachmentSync({ blob, maxBytes: 20 * 1024 * 1024, now: Date.now, store: { saveFileStream: async ({ data: stream }: { data: AsyncIterable<Uint8Array> }) => { let bytes = 0; for await (const chunk of stream) bytes += chunk.byteLength; return { attachmentId, name: 'cost-fixture.bin', bytes }; } } as unknown as AttachmentStore });
  await measure('attachment_download_10_mib', async () => { assert.deepEqual((await receiver.import(refs)).degraded, []); });
  assert.equal(profiles.attachment_upload_10_mib!.putBlocks, 0, 'production BlobStore uses one PutBlob, not the research illustration block split');
  // SDK-only sensitivity: NOT the plugin upload path, excluded from monthly model.
  await measure('sdk_only_four_blocks_not_plugin', () => blob.container.getBlockBlobClient('sdk-only-blocks').uploadStream(Readable.from(Buffer.alloc(2048)), 512, 1));
  assert.equal(profiles.sdk_only_four_blocks_not_plugin!.putBlocks, 4); assert.equal(profiles.sdk_only_four_blocks_not_plugin!.putBlockLists, 1);
  meter.failNextHead();
  await measure('sdk_head_retry_attempts', () => blob.container.getBlobClient('sdk-only-blocks').getProperties());
  assert.equal(profiles.sdk_head_retry_attempts!.blobOther, 2); assert.equal(profiles.sdk_head_retry_attempts!.failedResponses, 1);
  await measure('catalog_logical_pages_of_one', async () => { let cursor: string | undefined; do { const page = await repository.listManifestsPage({ limit: 1, ...(cursor ? { cursor } : {}) }); cursor = page.nextCursor; } while (cursor); });
  assert.ok(profiles.catalog_logical_pages_of_one!.tableQueries >= 3);
  await measure('retire_off', () => one.service.disable(rootOne));
  // New optional Git-v2 path: measured separately, deliberately NOT folded into the old monthly workload.
  const metadataId = `session-${randomUUID()}`; await log(metadataId, 1);
  let metadataHead = 'a'.repeat(40), metadataObservation = 0;
  const metadata = makeService(a, 1000, false, async (_sid, anchor) => ({
    v: 2, observation: { ...anchor, deviceId: 'device-a', observedAt: ++metadataObservation },
    repository: { objectFormat: 'sha1', root: a.cwd, worktree: false },
    creationBase: { kind: 'remote', ref: 'refs/heads/dev', oid: 'a'.repeat(40), remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/fixture' } },
    current: { branchRef: 'refs/heads/fixture', headOid: metadataHead, detached: false, unborn: false, dirty: 'unknown' },
  }));
  await measure('git_v2_seed_one_batch', () => metadata.service.enable(metadataId));
  const metadataBefore = (await repository.getManifest(metadataId))!.entity;
  const metadataHistory = (entity: typeof metadataBefore) => ({ headerHash: entity.headerHash, eventCount: entity.eventCount, batchCount: entity.batchCount, headHash: entity.headHash, chainHash: entity.chainHash, lastBatchRowKey: entity.lastBatchRowKey });
  metadataHead = 'b'.repeat(40);
  await measure('git_v2_no_event_refresh', () => metadata.service.sync(metadataId));
  const metadataAfter = (await repository.getManifest(metadataId))!.entity, observedGit = decodeGitContextJson(metadataAfter.gitJson);
  assert.ok(observedGit?.v === 2); assert.equal(observedGit.current.headOid, metadataHead);
  assert.deepEqual(metadataHistory(metadataAfter), metadataHistory(metadataBefore));
  assert.equal(profiles.git_v2_no_event_refresh!.historyBlobWrites, 0, 'lease preparation can PUT an existing lease object, but metadata refresh writes no history batch');
  assert.ok(profiles.git_v2_no_event_refresh!.tableBatches >= 1);
  await measure('git_v2_repeated_explicit_refresh', () => metadata.service.sync(metadataId));
  await measure('git_v2_verified_one_batch_read', () => metadata.reader.read(metadataId));
  assert.equal(profiles.git_v2_verified_one_batch_read!.leaseOperations, 0);
  assertNoHistory(profiles.git_v2_verified_one_batch_read!);
  assert.equal(one.reader, eight.reader); assert.equal(one.reader, steadyEight.reader); assert.equal(metadata.reader, one.reader);
  for (const name of ['native_first_proof_eight_batches', 'native_held_proof_eight_batches', 'imported_first_proof_eight_batches', 'imported_held_proof_eight_batches']) {
    assertNoHistory(profiles[name]!); assert.ok(profiles[name]!.leaseOperations > 0, 'each warm admission still obtains fresh server lease proof');
  }

  // Strict extension: B previews a four-batch prefix, A publishes exactly K=2,
  // then B must fetch only those selected new rows and canonical objects.
  const suffixId = `session-${randomUUID()}`; await log(suffixId, 4); await eight.service.enable(suffixId); await imported.reader.read(suffixId);
  const suffixHandle = await a.ctx.sessionPersistence.open(SessionId(suffixId), 'write');
  try { await suffixHandle.append([event(4), event(5)] as never); await suffixHandle.flush(); } finally { await suffixHandle.close(); }
  await eight.uploader.sync(suffixId, { release: true });
  await measure('strict_two_batch_suffix', () => imported.reader.read(suffixId));
  assert.equal(profiles.strict_two_batch_suffix!.batchRowPointReads, 2); assert.equal(profiles.strict_two_batch_suffix!.batchIndexQueries, 0);
  assert.equal(profiles.strict_two_batch_suffix!.historyGET, 2); assert.equal(profiles.strict_two_batch_suffix!.historyHEAD, 2); assert.ok(profiles.strict_two_batch_suffix!.historyResponseBytes > 0);
  await measure('strict_suffix_unchanged_hit', () => imported.reader.read(suffixId)); assertNoHistory(profiles.strict_suffix_unchanged_hit!);

  // Separate sessions prevent the two retained public SDK resume markers from
  // becoming competing local branches of the same canonical history.
  const nativeDrainId = `session-${randomUUID()}`, importedDrainId = `session-${randomUUID()}`;
  await log(nativeDrainId, 3); await one.service.enable(nativeDrainId); await a.resume(nativeDrainId); await one.uploader.sync(nativeDrainId, { release: true });
  await log(importedDrainId, 3); await one.service.enable(importedDrainId); await imported.service.importSession(importedDrainId); await b.resume(importedDrainId); await imported.uploader.sync(importedDrainId, { release: true });
  await measure('warm_native_admission_for_drain', async () => { assert.equal((await one.service.ensureOwnership(nativeDrainId)).owned, true); });
  await measure('warm_imported_admission_for_drain', async () => { assert.equal((await imported.service.ensureOwnership(importedDrainId)).owned, true); });
  await new Promise<void>(done => setTimeout(done, 2_100)); // Existing quiet drain window, NOT a raised proof deadline.
  await measure('warm_native_quiet_drain', () => one.service.drain(nativeDrainId));
  await measure('warm_imported_quiet_drain', () => imported.service.drain(importedDrainId));
  assert.equal(one.uploader.hasHeld(nativeDrainId), false); assert.equal(imported.uploader.hasHeld(importedDrainId), false);
  for (const name of ['warm_native_admission_for_drain', 'warm_imported_admission_for_drain', 'warm_native_quiet_drain', 'warm_imported_quiet_drain']) {
    assertNoHistory(profiles[name]!); assert.ok(profiles[name]!.leaseOperations > 0);
  }

  // Close/reopen public durable pins AND create a fresh canonical component.
  // Native/import checkpoints are deliberately not advanced by this read.
  await imported.reader.read(rootEight); await imported.service.close();
  const reopened = await historyFor(b); const restarted = makeService(b, 1, true);
  await measure('disk_and_public_pin_restart', () => restarted.reader.read(rootEight)); assertNoHistory(profiles.disk_and_public_pin_restart!);
  assert.ok(profiles.disk_and_public_pin_restart!.manifestPointReads > 0); assert.equal(reopened.reader, restarted.reader);

  const auditId = `session-${randomUUID()}`; await log(auditId, 2); await eight.service.enable(auditId);
  const localBeforeAudit = a.local.getSession(auditId)!;
  const checkpoint = (value: typeof localBeforeAudit) => [value.lastSyncedAt, value.lastSyncedEventCount, value.lastSyncedHeaderHash, value.lastSyncedChainHash];
  const auditBefore = (await repository.getManifest(auditId))!;
  const audited = await measure('explicit_audit_warm_complete', () => eight.service.verifyCloudCopy(auditId));
  assert.equal(audited.watermark.eventCount, auditBefore.entity.eventCount); assert.equal(audited.watermark.chainHash, auditBefore.entity.chainHash);
  assert.equal(profiles.explicit_audit_warm_complete!.historyGET, 2); assert.equal(profiles.explicit_audit_warm_complete!.historyHEAD, 2);
  assert.equal(profiles.explicit_audit_warm_complete!.batchRowPointReads, 2); assert.equal(profiles.explicit_audit_warm_complete!.leaseOperations, 0);
  assert.ok(profiles.explicit_audit_warm_complete!.historyResponseBytes > 0); assert.deepEqual(checkpoint(a.local.getSession(auditId)!), checkpoint(localBeforeAudit));
  assert.equal((await repository.getManifest(auditId))!.entity.writerEpoch, auditBefore.entity.writerEpoch);
  const auditRow = (await repository.getBatch(auditBefore.entity.lastBatchRowKey!))!;
  const originalPayload = await repository.readCandidate(auditRow.blobName, config.maxBatchBytes * 2);
  await measure('audit_damage_injection_exception', () => blob.container.getBlockBlobClient(auditRow.blobName).upload(Buffer.from('damaged'), 7));
  await measure('explicit_audit_detects_remote_damage', async () => { await assert.rejects(eight.service.verifyCloudCopy(auditId), error => error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE'); });
  assert.ok(profiles.explicit_audit_detects_remote_damage!.historyGET > 0); assert.equal(profiles.explicit_audit_detects_remote_damage!.leaseOperations, 0);
  await measure('cached_hit_cannot_hide_audit_damage', async () => { await assert.rejects(eight.reader.read(auditId), error => error instanceof AzureSyncError && error.code === 'CORRUPT_REMOTE'); });
  assertNoHistory(profiles.cached_hit_cannot_hide_audit_damage!); assert.deepEqual(checkpoint(a.local.getSession(auditId)!), checkpoint(localBeforeAudit));
  await measure('audit_damage_repair_exception', () => blob.container.getBlockBlobClient(auditRow.blobName).upload(originalPayload, originalPayload.length));
  await measure('explicit_audit_repaired_copy', () => eight.service.verifyCloudCopy(auditId));
  assert.equal(profiles.explicit_audit_repaired_copy!.historyGET, 2); assert.equal(profiles.explicit_audit_repaired_copy!.batchRowPointReads, 2);
  await measure('raw_cleanup_after_warm_cache', () => eight.service.removeFromCloud(auditId));
  assert.ok(profiles.raw_cleanup_after_warm_cache!.batchIndexQueries > 0); assert.ok(profiles.raw_cleanup_after_warm_cache!.blobLists > 0);
  await measure('raw_resurrection_verification_after_cache', () => eight.service.resurrectInCloud(auditId));
  assert.ok(profiles.raw_resurrection_verification_after_cache!.batchIndexQueries > 0); assert.ok(profiles.raw_resurrection_verification_after_cache!.blobLists > 0);
  assert.equal((await repository.getManifest(auditId))!.entity.eventCount, 0); assert.equal(profiles.raw_resurrection_verification_after_cache!.leaseOperations, 0);

  // Three deterministic incompressible synthetic histories, each above64KiB
  // compressed; scaled budgets exercise a working set above BOTH retention caps.
  const c = await acceptanceDevice(join(root, 'pressure'), 'device-pressure', new AcceptanceCloud()); devices.push(c); await c.service.close(); await c.reader.close();
  await historyFor(c, { memoryBytes: 0, diskBytes: 0 }); const zero = makeService(c, 1000);
  let pseudoRandom = 0x12345678;
  const synthetic = Buffer.alloc(96 * 1024);
  for (let index = 0; index < synthetic.length; index += 1) { pseudoRandom ^= pseudoRandom << 13; pseudoRandom ^= pseudoRandom >>> 17; pseudoRandom ^= pseudoRandom << 5; synthetic[index] = pseudoRandom & 255; }
  const largeIds: string[] = [], compressedSizes: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `session-${randomUUID()}`; largeIds.push(id);
    const header: SessionHeader = { id: SessionId(id), version: 4, createdAt: 1, cwd: c.cwd, isSeeded: false };
    const handle = await c.ctx.sessionPersistence.create(header);
    try { await handle.append([event(0, 'working-directory/change', { cwd: c.cwd }), event(1, 'model/selection', { provider: 'fixture', model: 'no-network' }), event(2, 'user/message', { content: [{ type: 'text', text: synthetic.toString('base64') + String(index) }] })] as never); await handle.flush(); } finally { await handle.close(); }
    assert.equal((await zero.service.enable(id)).status, 'synced'); assert.equal(c.local.getSession(id)?.publicationScope, zero.reader.scopeId);
    const manifest = (await repository.getManifest(id))!; compressedSizes.push((await blob.container.getBlobClient(manifest.entity.lastBatchBlobName!).getProperties()).contentLength!);
  }
  assert.ok(compressedSizes.every(bytes => bytes > 65_536));
  const checkpointsBeforeIdle = largeIds.map(id => checkpoint(c.local.getSession(id)!));
  await measure('zero_cache_three_large_histories_idle', async () => { for (let pass = 0; pass < 3; pass += 1) await zero.service.refreshAll(); });
  assertNoHistory(profiles.zero_cache_three_large_histories_idle!); assert.equal(profiles.zero_cache_three_large_histories_idle!.manifestPointReads, 9);
  assert.deepEqual(largeIds.map(id => checkpoint(c.local.getSession(id)!)), checkpointsBeforeIdle);
  await measure('zero_cache_materialization_pressure_exception', async () => { await assert.rejects(zero.reader.read(largeIds[0]!), error => error instanceof AzureSyncError && error.code === 'LIMIT'); });
  // Confirmed upload already established the verified size, not retained bytes or execution authority.
  // Capacity refusal must now avoid even the first futile download.
  assertNoHistory(profiles.zero_cache_materialization_pressure_exception!);
  await measure('pressure_does_not_repeat_download', async () => { await assert.rejects(zero.reader.read(largeIds[0]!), error => error instanceof AzureSyncError && error.code === 'LIMIT'); });
  assertNoHistory(profiles.pressure_does_not_repeat_download!);
  await measure('idle_after_pressure_no_implicit_hydration', () => zero.service.refreshAll()); assertNoHistory(profiles.idle_after_pressure_no_implicit_hydration!);
  await zero.service.close(); const memoryBudget = 65_536, diskBudget = 131_072; await historyFor(c, { memoryBytes: memoryBudget, diskBytes: diskBudget }); const pressure = makeService(c, 1000);
  await measure('large_explicit_population_and_whole_prefix_eviction', async () => { for (const id of largeIds) await pressure.reader.read(id); });
  assert.equal(profiles.large_explicit_population_and_whole_prefix_eviction!.historyGET, 3); assert.equal(profiles.large_explicit_population_and_whole_prefix_eviction!.historyHEAD, 3);
  assert.equal(profiles.large_explicit_population_and_whole_prefix_eviction!.historyResponseBytes, compressedSizes.reduce((sum, bytes) => sum + bytes, 0));
  await measure('over_both_budgets_three_large_histories_idle', async () => { for (let pass = 0; pass < 3; pass += 1) await pressure.service.refreshAll(); });
  assertNoHistory(profiles.over_both_budgets_three_large_histories_idle!); assert.equal(profiles.over_both_budgets_three_large_histories_idle!.manifestPointReads, 9);
  assert.deepEqual(largeIds.map(id => checkpoint(c.local.getSession(id)!)), checkpointsBeforeIdle);
  let retainedCompressedBytes = 0, retainedPrefixes = 0;
  for (const namespace of await readdir(histories.get(c)!.directory)) {
    if (!/^[a-f0-9]{64}$/u.test(namespace)) continue; retainedPrefixes += 1;
    for (const name of await readdir(join(histories.get(c)!.directory, namespace))) if (name.endsWith('.gz')) retainedCompressedBytes += (await stat(join(histories.get(c)!.directory, namespace, name))).size;
  }
  assert.ok(retainedCompressedBytes <= diskBudget); assert.equal(retainedPrefixes, 1);
  const largeFixture = { histories: largeIds.length, canonicalTextBytesPerHistory: synthetic.toString('base64').length, compressedSizes, compressedWorkingSetBytes: compressedSizes.reduce((sum, bytes) => sum + bytes, 0), memoryBudget, diskBudget, retainedCompressedBytes, retainedPrefixes };
  assert.equal(a.llmCalls + b.llmCalls + c.llmCalls, 0, 'public proof paths do not send prompts or call a model');
  assert.equal(profiles.idle_eight_batches!.blobWrites + profiles.idle_eight_batches!.blobOther - profiles.idle_eight_batches!.blobReads, 0);
  assert.equal(profiles.idle_eight_batches!.leaseOperations, 0, 'unchanged idle refresh does not churn leases');
  const assumptions = { days: 30, devices: 2, atMostEnabledSessionRecordsPerDeviceIncludingDescendants: 1, atMostCommittedBatchesPerEnabledThread: 8, pollSeconds: 300, publishedBatchesAcrossSmallThreadLifetimes: 3000, threadLifetimes: 375, modelSteps: 3000, coldImports: 30, coldInspections: 30, forcedTakeovers: 0, attachmentFilesOf10MiB: 100, attachmentRepeatAttempts: 730, catalogPasses: 30, extraCasRetryActions: 30, activeWriterHours: 60, operationContingency: 0.10, retainedBlobGiB: 1, retainedTableGB: 0.1 };
  const polls = assumptions.days * 86400 / assumptions.pollSeconds * assumptions.devices;
  const firstProofs = assumptions.threadLifetimes + assumptions.coldImports;
  const monthly = combine([[profiles.infrastructure!, 1], [profiles.first_opt_in_one_batch!, assumptions.threadLifetimes], [profiles.incremental_sync_eight_existing_batches!, assumptions.publishedBatchesAcrossSmallThreadLifetimes - assumptions.threadLifetimes], [profiles.idle_imported_eight_batches!, polls], [profiles.imported_first_proof_eight_batches!, firstProofs], [profiles.imported_held_proof_eight_batches!, assumptions.modelSteps - firstProofs], [profiles.cold_imported_inspection_eight_batches!, assumptions.coldInspections], [profiles.retire_off!, assumptions.threadLifetimes * assumptions.devices], [profiles.cold_import_eight_batches!, assumptions.coldImports], [profiles.attachment_upload_10_mib!, assumptions.attachmentFilesOf10MiB], [profiles.attachment_repeat_10_mib!, assumptions.attachmentRepeatAttempts], [profiles.attachment_download_10_mib!, assumptions.attachmentFilesOf10MiB], [profiles.background_lease_renew!, assumptions.activeWriterHours * 3600 / 30], [profiles.catalog_logical_pages_of_one!, assumptions.catalogPasses], [profiles.candidate_orphan_cas_retry_exception!, assumptions.extraCasRetryActions]]);
  const operations = operationUSD(monthly), capacity = 0.0208 * assumptions.retainedBlobGiB + 0.045 * assumptions.retainedTableGB, modeledUSD = capacity + operations * (1 + assumptions.operationContingency);
  assert.ok(Number.isFinite(modeledUSD) && modeledUSD >= 0, 'arithmetic check only, never a blanket sub-dollar assertion');
  meter.sampleMemory();
  console.log('COST_PROFILE\n' + JSON.stringify({
    evidence: 'Real public SDK -> loopback HTTP proxy -> Azurite; actual attempts and streamed response BODY bytes, not Azure billing. No URL/header/body/content/credential values are retained.',
    counterSemantics: { requestTotals: 'Only nine base operation counters are summed; history/lease/batch/range counters are subsets.', byteTotals: 'historyResponseBytes + tablePointResponseBytes + tableQueryResponseBytes + leaseResponseBytes + otherResponseBytes = totalResponseBytes; batch-row/query byte counters are subsets.', rangeAttempts: 'An HTTP request is counted once even when both its Range header and206 response identify it; retries/failed attempts are counted separately.', excludedWireBytes: 'Headers, TLS/TCP framing and request bodies are not response-body bytes.' },
    profiles, localOperationMetrics: meter.localMetrics, largeFixture,
    memory: { sampledPeakHeapUsedBytes: meter.peakHeapUsed, sampledPeakRssBytes: meter.peakRss, processPeakRssBytes: process.resourceUsage().maxRSS * 1024, scope: 'This Node test process including SDK/native fixture state, not only cache retention; no forced GC. maxRSS uses KiB on this POSIX acceptance run.' },
    legacyBoundedWorkload: { label: 'Historical bounded assumptions retained for comparability, with optimized measured operation vectors; NOT53 active sessions or current regional pricing.', assumptions, monthlyRequests: monthly, retailRateInputsUSD: { blobWriteOrListPer10K: 0.05, blobReadOrOtherPer10K: 0.004, tablePer10K: 0.00036, blobGiBMonth: 0.0208, tableGBMonth: 0.045 }, USD: { capacity, operations, contingency: operations * assumptions.operationContingency, modeledUSD, excludesEgressAndTax: true } },
    exceptionProfiles: ['zero_cache_materialization_pressure_exception', 'candidate_orphan_cas_retry_exception', 'audit_damage_injection_exception', 'audit_damage_repair_exception', 'sdk_only_four_blocks_not_plugin', 'sdk_head_retry_attempts', 'raw_cleanup_after_warm_cache', 'raw_resurrection_verification_after_cache'],
    notes: [
      'Zero-history assertions cover GET, HEAD, canonical response bytes, chosen batch point walks and batch-index queries, including cold/zero/over-budget retention. Fresh manifest control reads remain.',
      'Native/imported admissions and quiet drains reuse their device singleton canonical component but still obtain fresh server lease proofs. No Agent prompt/model execution occurs.',
      'Cold import and explicit audit download real committed history; audit also rereads the actual selected index. A normal cache hit does not attest current remote blob health.',
      'Candidate orphan/adopted PUT-exists/CAS recovery deliberately performs real listing/metadata/HEAD/GET checks and is separated from steady committed-history profiles. The legacy workload explicitly includes30 such extra actions.',
      'Scaled pressure fixture uses three deterministic synthetic histories above64KiB compressed each, not195MiB of private data; memory/disk limits are reduced to exercise the same retention boundary. Reported process memory is not a128MiB heap guarantee.',
      'Per-profile setup, synthetic data seeding, deliberate corruption/repair and quiet-window waiting outside a measurement are not asserted free; profiles represent named actions rather than the entire test process workload. Local wall/CPU metrics include the Node process SDK/proxy/native work and measurement overhead, not isolated verification CPU or the separate emulator process.',
      'The historical cold inspection/takeover labels mean no retained live Agent or lease, not necessarily a cold payload cache. Actual cold canonical download, memory reuse and public-pin/disk restart have distinct vectors.',
      'Optional git_v2 profiles are excluded from the historical model. Source code observations are synthetic and do not prove actual Git publication. Wizard fan-out may invoke additional guarded reads.',
      'Historical model still assumes one enabled record per device including descendants, at most8 committed batches,375 retired thread lifetimes,3000 total publications/steps,30 imports/inspections,100 attachment files and730 repeated upload attempts;3000 publications are not one indefinitely growing thread.',
      'The10MiB attachment download is metered as actual otherResponseBytes, including real range splitting. SDK-only four-block upload and synthetic transient retry are sensitivity checks, not production upload claims.',
      'Valid Table EGT is one base HTTP transaction regardless of contained entity actions. Capacity, egress allowances, regional prices, tax and negotiated features require a separate explicit workload model; there is no live-bill or blanket sub-dollar claim.',
    ],
  }, null, 2));
});
