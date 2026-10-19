import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, request as forwardRequest } from 'node:http';
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
import { Uploader } from '../src/sync/uploader.js';
import { SyncService } from '../src/sync/service.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
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

/** Counts observed SDK HTTP attempts at a loopback reverse proxy, NOT adapter calls.
 * No URL, header, body, account key, or conversation content enters the report.
 * The proxy does not alter ordinary requests/responses or substitute cloud state.
 */
function empty() { return { blobWrites: 0, blobReads: 0, blobLists: 0, blobOther: 0, tableReads: 0, tableQueries: 0, tableWrites: 0, tableBatches: 0, tableOther: 0, putBlocks: 0, putBlockLists: 0, leaseOperations: 0, leaseAcquisitions30: 0, leaseAcquisitions60: 0, failedResponses: 0 }; }
type Counts = ReturnType<typeof empty>;
const baseKeys = ['blobWrites', 'blobReads', 'blobLists', 'blobOther', 'tableReads', 'tableQueries', 'tableWrites', 'tableBatches', 'tableOther'] as const;
const total = (value: Counts) => baseKeys.reduce((sum, key) => sum + value[key], 0);
function combine(parts: readonly [Counts, number][]): Counts {
  const result = empty(); for (const [value, times] of parts) for (const key of Object.keys(result) as (keyof Counts)[]) result[key] += value[key] * times; return result;
}
function operationUSD(value: Counts): number {
  return (value.blobWrites + value.blobLists) * 0.05 / 10_000 + (value.blobReads + value.blobOther) * 0.004 / 10_000 + (value.tableReads + value.tableQueries + value.tableWrites + value.tableBatches + value.tableOther) * 0.00036 / 10_000;
}

test('measured real-Azurite HTTP profile supports an explicit retail cost model, never a monthly-bill claim', { timeout: 120_000 }, async t => {
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const prefix = 'azure-cost-profile-', root = await temporaryRoot(prefix);
  const devices: AcceptanceDevice[] = [], services: SyncService[] = [], controllers: CloudController[] = [];
  const proxies: ReturnType<typeof createServer>[] = [];
  t.after(async () => {
    for (const controller of controllers) controller.close(); for (const service of services.reverse()) await service.close();
    for (const device of devices.reverse()) await device.close();
    for (const server of proxies) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    await removeTemporaryRoot(root, prefix);
  });
  let observed: Counts | undefined, inject503 = false;
  async function proxy(target: URL, kind: 'blob' | 'table') {
    assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1', 'never meter a paid/live account');
    const server = createServer((incoming, outgoing) => {
      const counts = observed, url = new URL(incoming.url ?? '/', target.origin), method = incoming.method ?? 'GET', comp = url.searchParams.get('comp');
      if (counts) {
        if (kind === 'table') {
          if (url.pathname.endsWith('/$batch')) counts.tableBatches++;
          else if (method === 'GET') (url.pathname.includes('PartitionKey=') ? counts.tableReads++ : counts.tableQueries++);
          else if (['POST', 'PUT', 'MERGE', 'PATCH', 'DELETE'].includes(method)) counts.tableWrites++;
          else counts.tableOther++;
        } else if (comp === 'list') counts.blobLists++;
        else if (comp === 'lease') {
          counts.blobOther++; counts.leaseOperations++;
          if (incoming.headers['x-ms-lease-action'] === 'acquire') {
            if (incoming.headers['x-ms-lease-duration'] === '30') counts.leaseAcquisitions30++;
            if (incoming.headers['x-ms-lease-duration'] === '60') counts.leaseAcquisitions60++;
          }
        }
        else if (method === 'PUT') { counts.blobWrites++; if (comp === 'block') counts.putBlocks++; if (comp === 'blocklist') counts.putBlockLists++; }
        else if (method === 'GET' && !['container', 'service'].includes(url.searchParams.get('restype') ?? '')) counts.blobReads++;
        else counts.blobOther++;
      }
      if (inject503 && kind === 'blob' && method === 'HEAD') {
        inject503 = false; if (counts) counts.failedResponses++;
        outgoing.writeHead(503, { 'x-ms-error-code': 'ServerBusy', 'content-length': '0' }); outgoing.end(); return;
      }
      const request = forwardRequest({ hostname: target.hostname, port: target.port, method, path: incoming.url, headers: { ...incoming.headers, host: target.host } }, response => {
        if (counts && (response.statusCode ?? 500) >= 400) counts.failedResponses++;
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
      });
      request.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.on('aborted', () => request.destroy()); incoming.pipe(request);
    }); proxies.push(server);
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }
  const original = emulator.connection();
  const blobEndpoint = new URL(/BlobEndpoint=([^;]+)/u.exec(original)![1]!), tableEndpoint = new URL(/TableEndpoint=([^;]+)/u.exec(original)![1]!);
  const blobProxy = await proxy(blobEndpoint, 'blob'), tableProxy = await proxy(tableEndpoint, 'table');
  const connection = original.replace(blobEndpoint.origin, blobProxy).replace(tableEndpoint.origin, tableProxy);
  const blobClient = BlobServiceClient.fromConnectionString(connection, { retryOptions: { maxTries: 2, retryDelayInMs: 1, maxRetryDelayInMs: 1 } });
  const blob = new BlobStore(blobClient.getContainerClient('dsh-state'));
  const table = new TableStore(TableClient.fromConnectionString(connection, 'dshstatesync', { allowInsecureConnection: true }));
  const repository = new CloudRepository(blob, table), profiles: Record<string, Counts> = {};
  async function measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    assert.equal(observed, undefined); const counts = empty(); observed = counts;
    try { return await action(); } finally { observed = undefined; profiles[name] = { ...counts }; }
  }
  const a = await acceptanceDevice(join(root, 'a'), 'device-a', new AcceptanceCloud()); devices.push(a); await a.service.close();
  const b = await acceptanceDevice(join(root, 'b'), 'device-b', new AcceptanceCloud(), a.cwd); devices.push(b); await b.service.close();
  const config = Config({ maxBatchEvents: 1 });
  function makeService(device: AcceptanceDevice, maxBatchEvents: number, imported = false) {
    const binding = { mapping: pathMapping({ remotePrefix: a.cwd, localPrefix: device.cwd, revision: '1'.repeat(64) }), fs: nodeCwdFs };
    const leases = new SessionLeaseManager({ repository, leases: new LeaseManager(blob), deviceId: imported ? 'device-b' : 'device-a', now: Date.now });
    const uploader = new Uploader({ config: Config({ maxBatchEvents }), source: device.source, repository, leases, local: device.local, deviceId: imported ? 'device-b' : 'device-a', platform: 'linux', now: Date.now, renewEveryMs: 1_000_000, ...(imported ? { cwdBinding: async () => binding } : {}) });
    const reader = new RemoteSessionReader(repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: config.maxBatchBytes });
    const warmer = new ProjectionWarmer({ pollMs: 1, cache: {
      coldSnapshot(header: SessionHeader, inherited: number, events: readonly SessionEvent[]) { const restored = device.ctx.sessionProjections.restore({}, events, 0 as never, header, inherited as never); device.checkpoints.set(header.id, restored.snapshot); },
      cachedSnapshot: header => device.checkpoints.get(header.id),
    } });
    const imports = new ImportService(new Importer({ config, persistence: device.ctx.sessionPersistence, repository, local: device.local, cwdBinding: async () => binding, projection: warmer, now: Date.now }));
    const service = new SyncService({ uploader, local: device.local, repository, reader, source: device.source, imports, agents: device.ctx.agents, now: Date.now }); services.push(service);
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
  await measure('idle_one_batch', () => one.service.reconcile(rootOne));
  await measure('idle_eight_batches', () => eight.service.reconcile(rootEight));
  await measure('cold_import_eight_batches', () => imported.service.importSession(rootEight));
  assert.equal(b.local.getSession(rootEight)?.importState, 'complete'); assert.equal(b.ctx.agents.list().length, 0);
  await measure('cold_imported_inspection_eight_batches', () => imported.service.ensureOwnership(rootEight, undefined, { inspection: true }));
  assert.equal(profiles.cold_imported_inspection_eight_batches!.leaseAcquisitions30, 1); assert.equal(imported.uploader.hasHeld(rootEight), false); assert.equal(b.ctx.agents.list().length, 0);
  await measure('idle_imported_eight_batches', () => imported.service.reconcile(rootEight));
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
  try { await measure('incremental_with_one_cas_retry', () => one.service.sync(rootOne)); } finally { repository.commitBatch = originalCommit; }
  assert.equal(attempts, 2); assert.ok(profiles.incremental_with_one_cas_retry!.tableBatches >= 2);
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
  inject503 = true;
  await measure('sdk_head_retry_attempts', () => blob.container.getBlobClient('sdk-only-blocks').getProperties());
  assert.equal(profiles.sdk_head_retry_attempts!.blobOther, 2); assert.equal(profiles.sdk_head_retry_attempts!.failedResponses, 1);
  await measure('catalog_logical_pages_of_one', async () => { let cursor: string | undefined; do { const page = await repository.listManifestsPage({ limit: 1, ...(cursor ? { cursor } : {}) }); cursor = page.nextCursor; } while (cursor); });
  assert.ok(profiles.catalog_logical_pages_of_one!.tableQueries >= 3);
  await measure('retire_off', () => one.service.disable(rootOne));
  assert.equal(a.llmCalls + b.llmCalls, 0, 'public proof paths do not send prompts or call a model');
  assert.equal(profiles.idle_eight_batches!.blobWrites + profiles.idle_eight_batches!.blobOther - profiles.idle_eight_batches!.blobReads, 0);
  assert.equal(profiles.idle_eight_batches!.leaseOperations, 0, 'unchanged idle refresh does not churn leases');
  const assumptions = { days: 30, devices: 2, atMostEnabledSessionRecordsPerDeviceIncludingDescendants: 1, atMostCommittedBatchesPerEnabledThread: 8, pollSeconds: 300, publishedBatchesAcrossSmallThreadLifetimes: 3000, threadLifetimes: 375, modelSteps: 3000, coldImports: 30, coldInspections: 30, forcedTakeovers: 0, attachmentFilesOf10MiB: 100, attachmentRepeatAttempts: 730, catalogPasses: 30, extraCasRetryActions: 30, activeWriterHours: 60, operationContingency: 0.10, retainedBlobGiB: 1, retainedTableGB: 0.1 };
  const polls = assumptions.days * 86400 / assumptions.pollSeconds * assumptions.devices;
  const firstProofs = assumptions.threadLifetimes + assumptions.coldImports;
  const monthly = combine([[profiles.infrastructure!, 1], [profiles.first_opt_in_one_batch!, assumptions.threadLifetimes], [profiles.incremental_sync_eight_existing_batches!, assumptions.publishedBatchesAcrossSmallThreadLifetimes - assumptions.threadLifetimes], [profiles.idle_imported_eight_batches!, polls], [profiles.imported_first_proof_eight_batches!, firstProofs], [profiles.imported_held_proof_eight_batches!, assumptions.modelSteps - firstProofs], [profiles.cold_imported_inspection_eight_batches!, assumptions.coldInspections], [profiles.retire_off!, assumptions.threadLifetimes * assumptions.devices], [profiles.cold_import_eight_batches!, assumptions.coldImports], [profiles.attachment_upload_10_mib!, assumptions.attachmentFilesOf10MiB], [profiles.attachment_repeat_10_mib!, assumptions.attachmentRepeatAttempts], [profiles.attachment_download_10_mib!, assumptions.attachmentFilesOf10MiB], [profiles.background_lease_renew!, assumptions.activeWriterHours * 3600 / 30], [profiles.catalog_logical_pages_of_one!, assumptions.catalogPasses], [profiles.incremental_with_one_cas_retry!, assumptions.extraCasRetryActions]]);
  const operations = operationUSD(monthly), capacity = 0.0208 * assumptions.retainedBlobGiB + 0.045 * assumptions.retainedTableGB, modeledUSD = capacity + operations * (1 + assumptions.operationContingency);
  assert.ok(modeledUSD < 1, 'only this explicit bounded workload targets <$1; not a bill or arbitrary-history guarantee');
  console.log('COST_PROFILE\n' + JSON.stringify({ evidence: 'Azurite loopback HTTP attempts, not Azure billing; body/header/URL data omitted', profiles, assumptions, monthlyRequests: monthly, USD: { capacity, operations, contingency: operations * assumptions.operationContingency, modeledUSD }, notes: ['Valid Table EGT is one billable transaction, not one per entity.', 'Imported per-step proofs re-read history more than unchanged idle refresh.', 'The 10MiB byte source is controlled; Azure requests use actual AttachmentSync, BlobStore and the same actual lease proof guard as Uploader.', '730 attachment repeats cover 100 files times 7 later publications plus 30 extra retry-shaped sync actions; they are not assumed deduplicated free.', 'SDK-only block upload and synthetic transient HEAD are sensitivity checks, not plugin workload.', 'The enabled-record bound includes every subagent descendant; this model has no enabled descendants.', 'First proofs cover all thread lifetimes plus imports; explicit retire Off on both devices and 30 cold inspections are included.', 'Forced takeovers are measured separately but this worked workload assumes zero; add them if used.', 'Retire/turn off threads before exceeding the 8-batch active-history bound; 3000 publications are not one growing thread.', 'Default 3MiB batch cap assumed; egress/tax/features/negotiated pricing excluded.'] }, null, 2));
});
