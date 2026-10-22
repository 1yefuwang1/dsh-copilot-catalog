import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { AzureSyncError } from '../src/azure/errors.js';
import { Config } from '../src/config.js';
import { CloudController } from '../src/controller.js';
import type { CloudRequest } from '../src/protocol.js';
import { SettingsService } from '../src/settings.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { nodeCwdFs, selectMapping } from '../src/sync/effective-cwd.js';
import { Importer } from '../src/sync/importer.js';
import { ImportService } from '../src/sync/import-service.js';
import { ProjectionWarmer } from '../src/sync/projection-warmer.js';
import { SyncService } from '../src/sync/service.js';
import { Uploader } from '../src/sync/uploader.js';
import { AcceptanceCloud, acceptanceDevice, type AcceptanceDevice } from './acceptance-helpers.js';
import { batchRow, cloudSession, event, localSession, sessionHeader } from './helpers.js';

// Real public host/AgentLoop, JSONL handles, projection folds and JSON domain.
// Only the cloud transport/conditional leases use AcceptanceCloud memory ports;
// these are not Azure/Azurite or browser end-to-end tests. No Agent is resolved.
async function fixture(t: TestContext, options: { generation?: number; preset?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-repair-flow-')));
  const cloud = new AcceptanceCloud();
  const devices: AcceptanceDevice[] = [];
  const controllers: CloudController[] = [];
  const services: SyncService[] = [];
  const id = `session-${randomUUID()}`;
  const generation = options.generation ?? 1;
  const header = sessionHeader({ id, delegationDepth: 0, ...(options.preset ? { agentPreset: 'repair-fixture-preset' } : {}) });
  const events = [
    event(0, 'working-directory/change', { cwd: '/remote/project' }),
    event(1, 'user/message', { content: [{ type: 'text', text: 'Keep this original user input.' }] }),
    event(2, 'session/title', { title: 'Original remote title', messageSeqs: [], source: { kind: 'user' } }),
    event(3, 'working-directory/change', { cwd: '/remote/project/nested' }),
    event(4, 'user/message', { content: [{ type: 'text', text: 'Keep this later user input too.' }] }),
    event(5, 'session/title', { title: 'Full remote snapshot', messageSeqs: [], source: { kind: 'user' } }),
  ];
  const bindingHash = headerHash(header, 0);
  const genesis = genesisHash(id, generation, bindingHash);
  const chain = chainEvents(genesis, events);
  const row = batchRow(id, generation, 0, {
    endSeq: events.length - 1, eventCount: events.length, prevChainHash: genesis,
    chainHash: chain.chainHash, headHash: chain.headHash, payloadHash: chain.payloadHash,
  });
  await cloud.putCandidate(row.blobName, gzipSync(payloadBytes(events)), {});
  cloud.rows.set(row.rowKey, { entity: row, etag: 'seed-row' });
  await cloud.createManifest(cloudSession({
    sessionId: id, generation, writerEpoch: 7, headerJson: JSON.stringify(header), headerHash: bindingHash,
    eventCount: events.length, headSeq: events.length - 1, headHash: chain.headHash, chainHash: chain.chainHash,
    lastBatchRowKey: row.rowKey, lastBatchGeneration: generation, lastBatchBlobName: row.blobName,
  }));
  t.after(async () => {
    for (const controller of controllers) controller.close();
    for (const service of services.reverse()) await service.close();
    for (const device of devices.reverse()) await device.close();
    // Deletion is limited to this freshly created, canonical fixture directory.
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    assert.ok(root.startsWith(join(await realpath(tmpdir()), 'azure-repair-flow-')));
    await rm(root, { recursive: true, force: false });
  });
  const state = { presetAvailable: !options.preset, projectionReady: true };
  async function host() {
    const device = await acceptanceDevice(join(root, 'device'), 'device-b', cloud, '/remote/project');
    devices.push(device);
    const config = Config({ maxBatchEvents: 2 });
    const projection = new ProjectionWarmer({
      pollMs: 1,
      cache: {
        coldSnapshot(header: SessionHeader, inherited: number, events: readonly SessionEvent[]) {
          if (!state.projectionReady) return;
          const restored = device.ctx.sessionProjections.restore({}, events, 0 as never, header, inherited as never);
          device.checkpoints.set(header.id, restored.snapshot);
        },
        cachedSnapshot: header => device.checkpoints.get(header.id),
      },
    });
    let controller!: CloudController;
    const cwdBinding = async (_id: string, header: SessionHeader) => {
      const mapping = header.cwd === undefined ? undefined : selectMapping([...device.local.listMappings()].map(([, value]) => value), header.cwd, 'linux');
      return mapping === undefined ? undefined : { mapping, fs: nodeCwdFs };
    };
    const uploader = new Uploader({
      config, source: device.source, repository: cloud.asRepository(), reader: device.reader, leases: cloud.leases('device-b'), local: device.local,
      deviceId: 'device-b', platform: 'linux', cwdBinding: async (_id, record) => {
        const mapping = record.canonicalCwd === undefined ? undefined : selectMapping([...device.local.listMappings()].map(([, value]) => value), record.canonicalCwd, 'linux');
        return mapping === undefined ? undefined : { mapping, fs: nodeCwdFs };
      }, now: Date.now,
    });
    const importer = new Importer({
      config, persistence: device.ctx.sessionPersistence, repository: cloud.asRepository(), reader: device.reader, local: device.local,
      isOptingOut: id => controller.isOptingOut(id),
      cwdBinding,
      presetAvailable: () => state.presetAvailable,
      projection, now: Date.now,
    });
    const imports = new ImportService(importer);
    const service = new SyncService({
      uploader, local: device.local, imports, reader: device.reader, source: device.source,
      agents: device.ctx.agents, repository: cloud.asRepository(), now: Date.now,
      isOptingOut: id => controller.isOptingOut(id),
    });
    services.push(service);
    const core = { service, repository: cloud.asRepository(), testAuth: async () => {} };
    controller = new CloudController({
      local: device.local, settings: new SettingsService({ local: device.local, config }),
      core: async () => core, current: () => core, source: device.source, now: Date.now,
    });
    controllers.push(controller);
    const run = (request: CloudRequest, signal = new AbortController().signal) => controller.execute(request, { origin: 'rpc', signal });
    let creates = 0;
    const create = device.ctx.sessionPersistence.create.bind(device.ctx.sessionPersistence);
    device.ctx.sessionPersistence.create = ((...args: Parameters<typeof create>) => { creates++; return create(...args); }) as typeof create;
    return {
      device, service, imports, controller, run, get creates() { return creates; },
      async map() { await run({ action: 'map', mapping: { remotePrefix: '/remote/project', localPrefix: device.cwd, remotePlatform: 'linux' } }); },
      async close() { controller.close(); await service.close(); await device.close(); },
    };
  }
  const current = await host();
  return { root, cloud, id, generation, header, events, state, host, current };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Host = Fixture['current'];

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function errorCode(expected: string) {
  return (error: unknown) => error instanceof AzureSyncError && error.code === expected;
}
function cloudBytes(cloud: AcceptanceCloud) {
  return structuredClone({ manifests: [...cloud.manifests], rows: [...cloud.rows], candidates: [...cloud.candidates], leases: [...cloud.activeLeases] });
}
// Adversarial transport fixture only: install another internally verified selected
// snapshot. These mutations do not represent a valid immutable Azure publication.
async function replaceRemote(f: Fixture, events: readonly { readonly seq: number }[] = f.events, header = f.header, inheritedEventCount = 0) {
  const current = await f.cloud.getManifest(f.id); assert.ok(current);
  const bindingHash = headerHash(header, inheritedEventCount);
  const genesis = genesisHash(f.id, current.entity.generation, bindingHash);
  const extendsCurrent = bindingHash === current.entity.headerHash && inheritedEventCount === current.entity.inheritedEventCount &&
    events.length > current.entity.eventCount && current.entity.eventCount > 0 &&
    chainEvents(genesis, events.slice(0, current.entity.eventCount)).chainHash === current.entity.chainHash;
  const startSeq = extendsCurrent ? current.entity.eventCount : 0;
  const previous = extendsCurrent ? current.entity.chainHash : genesis;
  const chain = events.length === 0 ? undefined : chainEvents(previous, events.slice(startSeq));
  let row;
  if (chain !== undefined) {
    row = batchRow(f.id, current.entity.generation, startSeq, {
      endSeq: events.length - 1, eventCount: events.length - startSeq, prevChainHash: previous,
      chainHash: chain.chainHash, headHash: chain.headHash, payloadHash: chain.payloadHash,
      ...(extendsCurrent ? { prevBatchRowKey: current.entity.lastBatchRowKey } : {}),
    });
    await f.cloud.putCandidate(row.blobName, gzipSync(payloadBytes(events.slice(startSeq))), {});
    f.cloud.rows.set(row.rowKey, { entity: row, etag: `fixture-${randomUUID()}` });
  }
  await f.cloud.updateManifest({
    ...current.entity, headerJson: JSON.stringify(header), headerHash: bindingHash, inheritedEventCount,
    eventCount: events.length, headSeq: events.length - 1, headHash: chain?.headHash ?? genesis,
    chainHash: chain?.chainHash ?? genesis, batchCount: row === undefined ? 0 : extendsCurrent ? current.entity.batchCount + 1 : 1,
    lastBatchRowKey: row?.rowKey, lastBatchGeneration: row?.generation, lastBatchBlobName: row?.blobName,
  }, current.etag);
}

async function assertFullSnapshot(f: Fixture, host: Host, allowDisabled = false) {
  const local = await host.device.source.read(f.id); assert.ok(local);
  const remote = await host.device.reader.read(f.id, { allowDisabled }); assert.ok(remote);
  const localized = f.events.map(value => value.type === 'working-directory/change'
    ? { ...value, data: { ...value.data, cwd: value.seq === 0 ? host.device.cwd : join(host.device.cwd, 'nested') } }
    : value);
  assert.deepEqual(local.events, localized, 'all original user data and the complete canonical prefix survive localization');
  assert.deepEqual(remote.events, f.events, 'import never changes the remote canonical prefix');
  assert.deepEqual(local.header, { ...f.header, cwd: host.device.cwd });
  assert.equal(local.inheritedEventCount, 0);
  assert.equal(host.device.local.getSession(f.id)?.generation, f.generation);
  assert.equal(host.device.local.getSession(f.id)?.importState, 'complete');
  assert.equal(host.device.local.getSession(f.id)?.needsFolder, false);
  assert.equal(host.device.local.getSession(f.id)?.mappingUnstable, false);
  assert.equal(host.device.checkpoints.get(f.id)?.values.workingDirectory, join(host.device.cwd, 'nested'));
  assert.equal(host.device.ctx.agents.list().length, 0, 'repair never implicitly resolves a native Agent');
  assert.equal(host.device.llmCalls, 0);
}

// Inject cancellation only AFTER the actual JSON-backed LocalStore transaction
// resolves. JSONL creation/append itself remains the public SDK implementation.
async function cancelAtCheckpoint(f: Fixture, host: Host, partial: boolean) {
  const cancel = new AbortController();
  const cancellation = new Error(partial ? 'cancel-after-durable-prefix' : 'cancel-after-durable-planned');
  const original = host.device.local.transactSession.bind(host.device.local);
  host.device.local.transactSession = (async (...args: Parameters<typeof original>) => {
    const record = await original(...args);
    if (record?.sessionId === f.id && (partial ? record.importAppendedCount === 2 : record.importState === 'planned')) cancel.abort(cancellation);
    return record;
  }) as typeof original;
  try {
    await assert.rejects(host.run({ action: 'pull', sessionId: f.id }, cancel.signal), error => error instanceof Error && 'code' in error && error.code === 'CANCELLED');
  } finally { host.device.local.transactSession = original; }
  assert.equal(cancel.signal.aborted, true, 'the target durable checkpoint was actually reached');
  assert.equal(host.device.local.getSession(f.id)?.importState, partial ? 'appending' : 'planned');
  const snapshot = await host.device.source.read(f.id);
  if (partial) { assert.ok(snapshot); assert.equal(snapshot.events.length, 2); }
  else {
    assert.equal(snapshot, undefined);
    assert.equal(host.creates, 0, 'cancellation happened before the public JSONL create call');
    await assert.rejects(host.device.ctx.sessionPersistence.open(f.id as never, 'read'), error => error instanceof SessionPersistenceNotFoundError);
  }
  return snapshot;
}

test('repair-flow fixture: ordinary mapped public import materializes the complete localized snapshot', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const remoteBefore = cloudBytes(f.cloud);
  await f.current.run({ action: 'pull', sessionId: f.id });
  await assertFullSnapshot(f, f.current);
  assert.equal(f.current.creates, 1);
  assert.deepEqual(cloudBytes(f.cloud), remoteBefore);
});

test('repair-flow fixture: active partial import repairs by appending only its verified suffix', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
  const remoteBefore = cloudBytes(f.cloud);
  await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, f.current);
  assert.deepEqual((await f.current.device.source.read(f.id))?.events.slice(0, prefix.events.length), prefix.events);
  assert.equal(f.current.creates, 1, 'repair opens the existing artifact rather than recreating it');
  assert.deepEqual(cloudBytes(f.cloud), remoteBefore);
});

test('repair-flow A: cancelled durable planned import with no JSONL survives host restart and explicit repair creates full snapshot', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const remoteBefore = cloudBytes(f.cloud);
  await cancelAtCheckpoint(f, f.current, false);
  const checkpoint = f.current.device.local.getSession(f.id);
  await f.current.close();
  const restarted = await f.host();
  assert.deepEqual(restarted.device.local.getSession(f.id), checkpoint, 'a new host reopens the actual JSON domain checkpoint');
  assert.equal(await restarted.device.source.read(f.id), undefined);
  await restarted.run({ action: 'pull', sessionId: f.id });
  t.diagnostic(`After ordinary pull: JSONL artifact ${await restarted.device.source.read(f.id) === undefined ? 'absent' : 'present'}. Explicit repair below must finish safely either way.`);
  await restarted.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, restarted);
  assert.equal(restarted.creates, 1);
  assert.deepEqual(cloudBytes(f.cloud), remoteBefore, 'repair is entirely local and cannot republish or acquire a cloud lease');
});

for (const failure of ['needs-folder', 'preset-missing'] as const) {
  async function preflight(t: TestContext) {
    const f = await fixture(t, { generation: 2, preset: failure === 'preset-missing' });
    if (failure === 'preset-missing') await f.current.map();
    await assert.rejects(f.current.run({ action: 'pull', sessionId: f.id }), errorCode(failure === 'needs-folder' ? 'NEEDS_FOLDER' : 'PRESET_MISSING'));
    assert.equal(f.current.device.local.getSession(f.id)?.status, failure);
    assert.equal(f.current.device.local.getSession(f.id)?.importState, 'failed');
    assert.equal(f.current.creates, 0);
    assert.equal(await f.current.device.source.read(f.id), undefined);
    return f;
  }
  test(`repair-flow B: fresh generation-2 ${failure} preflight anchors remote generation before any JSONL create`, { timeout: 20_000 }, async t => {
    const f = await preflight(t);
    assert.equal(f.current.device.local.getSession(f.id)?.generation, 2, 'a first preflight failure is not an observed generation-1 import');
    assert.equal(f.current.device.local.getSession(f.id)?.writerEpoch, 7, 'failure checkpoint records the verified remote attempt, not a synthetic epoch');
  });
  test(`repair-flow B: remedy fresh generation-2 ${failure}, then confirmed public repair creates complete snapshot`, { timeout: 20_000 }, async t => {
    const f = await preflight(t);
    const remoteBefore = cloudBytes(f.cloud);
    if (failure === 'needs-folder') await f.current.map();
    else f.state.presetAvailable = true;
    await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
    await assertFullSnapshot(f, f.current);
    assert.equal(f.current.creates, 1);
    assert.deepEqual(cloudBytes(f.cloud), remoteBefore);
  });
}

test('repair-flow C: explicit repair completes disabled partial import locally without re-enabling cloud or losing user prefix', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
  const rowsBefore = structuredClone([...f.cloud.rows]);
  const blobsBefore = structuredClone([...f.cloud.candidates]);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
  const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
  assert.equal(stopped.enabled, false); assert.equal(stopped.detached, true);
  assert.equal(stopped.importState, 'appending');
  const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
  assert.equal(manifest.entity.enabled, false); assert.equal(manifest.entity.state, 'disabled');
  assert.deepEqual(await f.current.device.source.read(f.id), prefix);
  assert.deepEqual(structuredClone([...f.cloud.rows]), rowsBefore); assert.deepEqual(structuredClone([...f.cloud.candidates]), blobsBefore);
  const cloudStopped = cloudBytes(f.cloud);
  const writes = f.current.device.writeOpens;
  await assert.rejects(f.current.imports.resume(f.id, { confirmMapping: true }), errorCode('DISABLED'));
  await assert.rejects(f.current.device.reader.read(f.id), errorCode('DISABLED'));
  const retained = await f.current.device.reader.read(f.id, { allowDisabled: true }); assert.ok(retained);
  assert.deepEqual(retained.events, f.events, 'the explicit internal retained-read option can verify all retained remote user data');
  await f.current.run({ action: 'pull', sessionId: f.id });
  assert.deepEqual(f.current.device.local.getSession(f.id), stopped, 'none of repair/pull/retained-read silently opts back in');
  assert.deepEqual(await f.current.device.source.read(f.id), prefix);
  assert.equal(f.current.device.writeOpens, writes);
  assert.deepEqual(cloudBytes(f.cloud), cloudStopped, 'read-only verification neither activates cloud nor acquires ownership');
  await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, f.current, true);
  assert.deepEqual((await f.current.device.source.read(f.id))?.events.slice(0, prefix.events.length), prefix.events);
  const repaired = f.current.device.local.getSession(f.id); assert.ok(repaired);
  assert.equal(repaired.enabled, false); assert.equal(repaired.detached, true); assert.equal(repaired.state, 'disabled');
  assert.equal(repaired.status, 'detached'); assert.equal(repaired.resurrectionCancellationId, stopped.resurrectionCancellationId);
  assert.equal(f.current.device.writeOpens, writes + 1);
  assert.deepEqual(cloudBytes(f.cloud), cloudStopped, 'local repair does not activate, fence, upload or lease the retained cloud');
  await assert.rejects(f.current.device.reader.read(f.id), errorCode('DISABLED'), 'default disabled-reader behavior is unchanged');
});

test('repair-flow C: explicit on refuses incomplete copy before permission mutation, then genuinely re-enables after local-only repair', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
  const cloudStopped = cloudBytes(f.cloud);
  const stopped = f.current.device.local.getSession(f.id);
  await assert.rejects(f.current.run({ action: 'toggle', sessionId: f.id, enabled: true }), errorCode('IMPORT_INCOMPLETE'));
  assert.deepEqual(f.current.device.local.getSession(f.id), stopped, 'rejected on preserves the explicit-off nonce and every permission bit');
  assert.deepEqual(await f.current.device.source.read(f.id), prefix);
  assert.deepEqual(cloudBytes(f.cloud), cloudStopped, 'explicit on cannot truncate, activate, rewrite or lease the ahead retained cloud');
  await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, f.current, true);
  const repaired = await f.current.device.source.read(f.id);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: true });
  assert.equal(f.current.device.local.getSession(f.id)?.enabled, true);
  assert.equal(f.current.device.local.getSession(f.id)?.detached, false);
  const reenabled = await f.cloud.getManifest(f.id); assert.ok(reenabled);
  assert.equal(reenabled.entity.enabled, true); assert.equal(reenabled.entity.state, 'active');
  assert.equal(reenabled.entity.generation, f.generation);
  assert.equal(reenabled.entity.eventCount, f.events.length);
  assert.deepEqual(await f.current.device.source.read(f.id), repaired);
  assert.deepEqual(cloudBytes(f.cloud).rows, cloudStopped.rows);
  assert.deepEqual(cloudBytes(f.cloud).candidates, cloudStopped.candidates);
});

test('repair-flow projection: verified degraded copy can be acknowledged after Off without cloud mutation or new permission', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map(); f.state.projectionReady = false;
  const beforeImport = cloudBytes(f.cloud);
  await f.current.run({ action: 'pull', sessionId: f.id });
  const degraded = f.current.device.local.getSession(f.id); assert.ok(degraded);
  assert.equal(degraded.importState, 'degraded'); assert.equal(degraded.status, 'projection-warm-partial');
  assert.equal(degraded.degradedAttachments.length, 0); assert.equal(degraded.degradedAcknowledged, false);
  const verified = await f.current.device.source.read(f.id); assert.ok(verified); assert.equal(verified.events.length, f.events.length);
  assert.deepEqual(cloudBytes(f.cloud), beforeImport);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
  const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
  assert.equal(stopped.enabled, false); assert.equal(stopped.detached, true); assert.ok(stopped.resurrectionCancellationId);
  const cloudStopped = cloudBytes(f.cloud), writes = f.current.device.writeOpens, creates = f.current.creates;
  await f.current.run({ action: 'acknowledge-degraded', sessionId: f.id });
  const acknowledged = f.current.device.local.getSession(f.id); assert.ok(acknowledged);
  assert.deepEqual(acknowledged, { ...stopped, degradedAcknowledged: true });
  assert.equal(f.current.device.writeOpens, writes); assert.equal(f.current.creates, creates);
  assert.deepEqual(await f.current.device.source.read(f.id), verified);
  assert.deepEqual(cloudBytes(f.cloud), cloudStopped, 'acknowledgement does not activate cloud, acquire ownership, upload or change epoch');
  assert.equal(f.current.device.ctx.agents.list().length, 0); assert.equal(f.current.device.llmCalls, 0);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: true });
  assert.equal(f.current.device.local.getSession(f.id)?.enabled, true); assert.equal(f.current.device.local.getSession(f.id)?.detached, false);
  const active = await f.cloud.getManifest(f.id); assert.ok(active);
  assert.equal(active.entity.state, 'active'); assert.equal(active.entity.eventCount, f.events.length);
  assert.ok(active.entity.writerEpoch > stopped.writerEpoch, 'later On uses a genuine new ownership acquisition');
  assert.deepEqual(await f.current.device.source.read(f.id), verified);
});

// Missing-artifact repair must not become permission to adopt another generation.
test('repair-flow safety: confirmed repair never adopts a newer generation for a cancelled metadata-only import', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await cancelAtCheckpoint(f, f.current, false);
  const original = await f.cloud.getManifest(f.id); assert.ok(original);
  await f.cloud.updateManifest({ ...original.entity, generation: 2, rootGeneration: 2 }, original.etag);
  const cloudBefore = cloudBytes(f.cloud);
  const recordBefore = f.current.device.local.getSession(f.id);
  await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode('GENERATION_CHANGED'));
  assert.equal(f.current.creates, 0);
  assert.equal(await f.current.device.source.read(f.id), undefined);
  assert.deepEqual(f.current.device.local.getSession(f.id), recordBefore);
  assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
});

// Existing partial JSONL is never recreated and never has its header/prefix adopted.
test('repair-flow safety: confirmed repair rejects changed header without rewriting existing imported prefix', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
  const original = await f.cloud.getManifest(f.id); assert.ok(original);
  const header = { ...f.header, createdAt: f.header.createdAt + 1 };
  const bindingHash = headerHash(header, 0);
  const genesis = genesisHash(f.id, f.generation, bindingHash);
  const chain = chainEvents(genesis, f.events);
  const row = { ...[...f.cloud.rows.values()][0]!.entity, prevChainHash: genesis, chainHash: chain.chainHash, headHash: chain.headHash };
  f.cloud.rows.set(row.rowKey, { entity: row, etag: 'changed-header-fixture-row' });
  await f.cloud.updateManifest({ ...original.entity, headerJson: JSON.stringify(header), headerHash: bindingHash, chainHash: chain.chainHash, headHash: chain.headHash }, original.etag);
  const cloudBefore = cloudBytes(f.cloud);
  await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode('PROVENANCE_MISMATCH'));
  assert.equal(f.current.creates, 1, 'only the original first import ever calls create');
  assert.deepEqual(await f.current.device.source.read(f.id), prefix);
  assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
});

for (const disabled of [false, true]) {
  for (const changed of ['header', 'cut', 'prefix', 'rollback', 'anchor'] as const) {
    test(`repair-flow anchor: ${disabled ? 'explicit-off partial' : 'missing planned'} repair rejects ${changed} before creating/appending`, { timeout: 20_000 }, async t => {
      const f = await fixture(t); await f.current.map();
      const prefix = await cancelAtCheckpoint(f, f.current, disabled);
      if (disabled) await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
      const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
      if (changed === 'header') await replaceRemote(f, f.events, { ...f.header, createdAt: 2 });
      if (changed === 'cut') await replaceRemote(f, f.events, f.header, 1);
      if (changed === 'prefix') await replaceRemote(f, f.events.map(value => value.seq === 1 ? { ...value, data: { ...value.data, content: [{ type: 'text', text: 'Different user input' }] } } : value));
      if (changed === 'rollback') await replaceRemote(f, f.events.slice(0, 2));
      if (changed === 'anchor') await f.current.device.local.mutateSession(f.id, record => ({ ...record, importExpectedChainHash: 'f'.repeat(64) }));
      const cloudBefore = cloudBytes(f.cloud);
      const creates = f.current.creates;
      const writes = f.current.device.writeOpens;
      await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode(changed === 'rollback' ? 'CONFLICT' : 'PROVENANCE_MISMATCH'));
      assert.equal(f.current.creates, creates);
      assert.equal(f.current.device.writeOpens, writes, 'target proof fails before a write ownership request');
      assert.deepEqual(await f.current.device.source.read(f.id), prefix);
      assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
      assert.equal(f.current.device.local.getSession(f.id)?.enabled, stopped.enabled);
      assert.equal(f.current.device.local.getSession(f.id)?.detached, stopped.detached);
      assert.equal(f.current.device.local.getSession(f.id)?.resurrectionCancellationId, stopped.resurrectionCancellationId);
    });
  }
}

test('repair-flow anchor: an empty initial target commits canonical header and cut through genesis before missing-file create', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await replaceRemote(f, []);
  await cancelAtCheckpoint(f, f.current, false);
  assert.equal(f.current.device.local.getSession(f.id)?.importExpectedCount, 0);
  await replaceRemote(f, [], { ...f.header, createdAt: 2 });
  const cloudBefore = cloudBytes(f.cloud);
  await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode('PROVENANCE_MISMATCH'));
  assert.equal(f.current.creates, 0);
  assert.equal(await f.current.device.source.read(f.id), undefined);
  assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
});

test('repair-flow anchor: matching original target may advance; cancellation at advanced warming checkpoint retries without duplication', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await cancelAtCheckpoint(f, f.current, false);
  const originalTarget = f.current.device.local.getSession(f.id); assert.ok(originalTarget);
  f.events.push(event(f.events.length, 'user/message', { content: [{ type: 'text', text: 'Verified later suffix.' }] }));
  await replaceRemote(f);
  const cloudBefore = cloudBytes(f.cloud);
  const cancel = new AbortController();
  const transact = f.current.device.local.transactSession.bind(f.current.device.local);
  f.current.device.local.transactSession = (async (...args: Parameters<typeof transact>) => {
    const next = await transact(...args);
    if (next?.importState === 'warming') cancel.abort();
    return next;
  }) as typeof transact;
  try { await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }, cancel.signal), error => error instanceof Error && 'code' in error && error.code === 'CANCELLED'); }
  finally { f.current.device.local.transactSession = transact; }
  assert.equal(cancel.signal.aborted, true);
  assert.equal(f.current.device.local.getSession(f.id)?.importExpectedCount, f.events.length);
  assert.notEqual(f.current.device.local.getSession(f.id)?.importExpectedChainHash, originalTarget.importExpectedChainHash);
  await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, f.current);
  assert.equal(f.current.creates, 1);
  assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
});

for (const kind of ['native', 'complete', 'catch-up', 'unanchored'] as const) {
  test(`repair-flow safety: missing ${kind} record is never recreated, including a second repair attempt`, { timeout: 20_000 }, async t => {
    const f = await fixture(t); await f.current.map();
    const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
    await f.current.device.local.putSession(localSession({
      sessionId: f.id, publicationScope: f.current.device.reader.scopeId, imported: kind !== 'native', importState: kind === 'complete' ? 'complete' : 'failed',
      importExpectedCount: kind === 'unanchored' ? undefined : f.events.length,
      importExpectedChainHash: kind === 'unanchored' ? undefined : manifest.entity.chainHash,
      ...(kind === 'catch-up' ? { catchUpPending: true } : {}),
    }));
    const cloudBefore = cloudBytes(f.cloud);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (kind === 'catch-up') await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
      else await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), kind === 'unanchored' ? errorCode('IMPORT_INCOMPLETE') : error => error instanceof SessionPersistenceNotFoundError);
      assert.equal(f.current.creates, 0);
      assert.equal(await f.current.device.source.read(f.id), undefined);
      if (kind === 'complete') assert.equal(f.current.device.local.getSession(f.id)?.importState, 'complete', 'failed repair cannot erase known completion and authorize retry recreation');
    }
    assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
  });
}

test('repair-flow C: explicit-off planned missing artifact repairs locally and retains disabled intent across host restart', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await cancelAtCheckpoint(f, f.current, false);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
  const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
  const cloudBefore = cloudBytes(f.cloud);
  await f.current.close();
  const restarted = await f.host();
  assert.deepEqual(restarted.device.local.getSession(f.id), JSON.parse(JSON.stringify(stopped)), 'JSON reopening preserves every stored value; optional undefined properties are omitted');
  await restarted.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  await assertFullSnapshot(f, restarted, true);
  assert.equal(restarted.creates, 1);
  assert.equal(restarted.device.local.getSession(f.id)?.enabled, false);
  assert.equal(restarted.device.local.getSession(f.id)?.detached, true);
  assert.equal(restarted.device.local.getSession(f.id)?.resurrectionCancellationId, stopped.resurrectionCancellationId);
  assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
});

for (const collision of ['exists', 'owned'] as const) {
  test(`repair-flow create race: concurrent ${collision} native artifact is preserved, never adopted or overwritten`, { timeout: 20_000 }, async t => {
    const f = await fixture(t); await f.current.map();
    await cancelAtCheckpoint(f, f.current, false);
    const persistence = f.current.device.ctx.sessionPersistence;
    const create = persistence.create.bind(persistence);
    let foreign: Awaited<ReturnType<typeof create>> | undefined;
    persistence.create = (async (header, options) => {
      foreign = await create({ ...header, createdAt: 2 }, options);
      await foreign.append([event(0, 'user/message', { content: [{ type: 'text', text: 'Concurrent native user data.' }] })] as never);
      await foreign.flush();
      if (collision === 'exists') await foreign.close();
      return create(header, options);
    }) as typeof create;
    const cloudBefore = cloudBytes(f.cloud);
    try { await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode('IMPORT_RACE')); }
    finally { persistence.create = create; await foreign?.close(); }
    const preserved = await f.current.device.source.read(f.id); assert.ok(preserved);
    assert.equal(preserved.header.createdAt, 2);
    assert.equal(preserved.events.length, 1);
    assert.deepEqual(preserved.events[0]?.data, { id: 'message-0', role: 'user', content: [{ type: 'text', text: 'Concurrent native user data.' }], source: { kind: 'user' } });
    assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
  });
}

test('repair-flow cancellation: newer explicit off preempts repair waiting on missing-open and forbids its later create', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await cancelAtCheckpoint(f, f.current, false);
  const persistence = f.current.device.ctx.sessionPersistence;
  const open = persistence.open.bind(persistence);
  const entered = gate();
  const release = gate();
  persistence.open = (async (...args: Parameters<typeof open>) => {
    try { return await open(...args); }
    catch (error) {
      if (args[0] === f.id && args[1] === 'write' && error instanceof SessionPersistenceNotFoundError) { entered.resolve(); await release.promise; }
      throw error;
    }
  }) as typeof open;
  const repair = f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  const rejected = assert.rejects(repair, error => error instanceof Error && 'code' in error && error.code === 'CANCELLED');
  try {
    await entered.promise;
    await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
    await rejected;
    const stopped = f.current.device.local.getSession(f.id);
    release.resolve(); persistence.open = open;
    assert.equal(f.current.creates, 0);
    assert.equal(await f.current.device.source.read(f.id), undefined);
    assert.deepEqual(f.current.device.local.getSession(f.id), stopped);
  } finally { release.resolve(); persistence.open = open; }
});

for (const changed of ['generation', 'removed'] as const) {
  test(`repair-flow C: explicit-off repair rejects remote ${changed} without adopting or appending`, { timeout: 20_000 }, async t => {
    const f = await fixture(t); await f.current.map();
    const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
    await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
    const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
    const current = await f.cloud.getManifest(f.id); assert.ok(current);
    await f.cloud.updateManifest(changed === 'generation' ? { ...current.entity, generation: 2, rootGeneration: 2 }
      : { ...current.entity, state: 'deleted', enabled: false }, current.etag);
    const cloudBefore = cloudBytes(f.cloud);
    const writes = f.current.device.writeOpens;
    await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode(changed === 'generation' ? 'GENERATION_CHANGED' : 'REMOVED_REMOTELY'));
    assert.equal(f.current.device.writeOpens, writes);
    assert.deepEqual(await f.current.device.source.read(f.id), prefix);
    assert.equal(f.current.device.local.getSession(f.id)?.generation, stopped.generation);
    assert.equal(f.current.device.local.getSession(f.id)?.resurrectionCancellationId, stopped.resurrectionCancellationId);
    assert.equal(f.current.device.local.getSession(f.id)?.enabled, false);
    assert.equal(f.current.device.local.getSession(f.id)?.detached, true);
    assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
  });
}

for (const kind of ['native', 'catch-up', 'terminal', 'unanchored'] as const) {
  test(`repair-flow C: explicit off never turns ${kind} state into general retained repair permission`, { timeout: 20_000 }, async t => {
    const f = await fixture(t); await f.current.map();
    const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
    await f.current.device.local.putSession(localSession({
      sessionId: f.id, publicationScope: f.current.device.reader.scopeId, imported: kind !== 'native', enabled: false, detached: true, state: kind === 'terminal' ? 'deleted' : 'disabled',
      importState: 'failed', status: 'detached', resurrectionCancellationId: randomUUID(),
      importExpectedCount: kind === 'unanchored' ? undefined : f.events.length,
      importExpectedChainHash: kind === 'unanchored' ? undefined : manifest.entity.chainHash,
      ...(kind === 'catch-up' ? { catchUpPending: true } : {}),
    }));
    const stopped = f.current.device.local.getSession(f.id);
    const cloudBefore = cloudBytes(f.cloud);
    await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), errorCode('DISABLED'));
    assert.deepEqual(f.current.device.local.getSession(f.id), stopped);
    assert.equal(f.current.creates, 0);
    assert.equal(await f.current.device.source.read(f.id), undefined);
    assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
  });
}

test('repair-flow safety: a sparse completed checkpoint cannot become creatable after a folder-preflight failure', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
  await f.current.device.local.putSession(localSession({
    sessionId: f.id, publicationScope: f.current.device.reader.scopeId, imported: true, importState: 'complete', importExpectedCount: f.events.length,
    importExpectedChainHash: manifest.entity.chainHash,
  }));
  await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id }), errorCode('NEEDS_FOLDER'));
  assert.equal(f.current.device.local.getSession(f.id)?.importState, 'complete');
  await f.current.map();
  await assert.rejects(f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true }), error => error instanceof SessionPersistenceNotFoundError);
  assert.equal(f.current.creates, 0);
  assert.equal(await f.current.device.source.read(f.id), undefined);
});

test('repair-flow authority: changed durable initial target during missing-open cancels the stale repair before create', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  await cancelAtCheckpoint(f, f.current, false);
  const persistence = f.current.device.ctx.sessionPersistence;
  const open = persistence.open.bind(persistence);
  const entered = gate(); const release = gate();
  persistence.open = (async (...args: Parameters<typeof open>) => {
    try { return await open(...args); }
    catch (error) {
      if (args[0] === f.id && args[1] === 'write' && error instanceof SessionPersistenceNotFoundError) { entered.resolve(); await release.promise; }
      throw error;
    }
  }) as typeof open;
  const repair = f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  const rejected = assert.rejects(repair, errorCode('CANCELLED'));
  try {
    await entered.promise;
    await f.current.device.local.mutateSession(f.id, record => ({ ...record, importExpectedChainHash: 'f'.repeat(64) }));
    const changed = f.current.device.local.getSession(f.id);
    release.resolve(); await rejected; persistence.open = open;
    assert.equal(f.current.creates, 0);
    assert.equal(await f.current.device.source.read(f.id), undefined);
    assert.deepEqual(f.current.device.local.getSession(f.id), changed);
  } finally { release.resolve(); persistence.open = open; }
});

test('repair-flow native model: generation-2 mapping wizard repair imports the entire actual public host snapshot, not a header/model-only prefix', { timeout: 20_000 }, async t => {
  const f = await fixture(t, { generation: 2 });
  const native = await acceptanceDevice(join(f.root, 'native-producer'), 'device-a', f.cloud);
  try {
    const agent = await native.create(f.id); // Explicit fixture creation, never an implicit repair resolution.
    agent.send(native.prompt('Retain this actual native model/input history.'), 'next-turn', true);
    await agent.whenIdle();
    assert.equal(native.llmCalls, 1, 'the actual public AgentLoop used only the no-network fixture adapter');
    agent.session.append('session/title', { title: 'Native full snapshot', messageSeqs: [], source: { kind: 'user' } });
    await native.ctx.workingDirectory.ensure(agent);
    await native.ctx.sessionPersistence.flush();
    const original = await native.source.read(f.id); assert.ok(original);
    assert.ok(original.events.some(value => value.type === 'assistant/message'), 'the public host persisted the actual native model completion and its provenance');
    assert.equal(original.header.cwd, native.cwd);
    await replaceRemote(f, original.events, { ...original.header, cwd: native.cwd }, original.inheritedEventCount);
    await assert.rejects(f.current.run({ action: 'pull', sessionId: f.id }), errorCode('NEEDS_FOLDER'));
    assert.equal(f.current.device.local.getSession(f.id)?.generation, 2);
    assert.equal(f.current.creates, 0);
    await f.current.run({ action: 'map', mapping: { remotePrefix: native.cwd, localPrefix: f.current.device.cwd, remotePlatform: 'linux' } });
    const cloudBefore = cloudBytes(f.cloud);
    await f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
    const imported = await f.current.device.source.read(f.id); assert.ok(imported);
    assert.deepEqual(imported.header, { ...original.header, cwd: f.current.device.cwd });
    assert.deepEqual(imported.events, original.events.map(value => value.type === 'working-directory/change'
      ? { ...value, data: { ...value.data, cwd: f.current.device.cwd } } : value));
    assert.equal(imported.events.length, original.events.length);
    assert.deepEqual((await f.current.device.reader.read(f.id))?.events, original.events);
    assert.equal(f.current.device.local.getSession(f.id)?.importState, 'complete');
    assert.equal(f.current.device.ctx.agents.list().length, 0);
    assert.equal(f.current.device.llmCalls, 0);
    assert.deepEqual(cloudBytes(f.cloud), cloudBefore);
  } finally { await native.close(); }
});

test('repair-flow C: a newer explicit off CID cancels retained download and late bytes cannot append or publish completion', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.current.map();
  const prefix = await cancelAtCheckpoint(f, f.current, true); assert.ok(prefix);
  await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
  const old = f.current.device.local.getSession(f.id); assert.ok(old);
  const read = f.cloud.readCandidate.bind(f.cloud);
  const entered = gate(); const release = gate(); const late = gate();
  f.cloud.readCandidate = async name => {
    const bytes = await read(name); entered.resolve(); await release.promise; late.resolve(); return bytes;
  };
  const repair = f.current.run({ action: 'repair', sessionId: f.id, confirmMapping: true });
  const rejected = assert.rejects(repair, error => error instanceof Error && 'code' in error && error.code === 'CANCELLED');
  try {
    await entered.promise;
    await f.current.run({ action: 'toggle', sessionId: f.id, enabled: false });
    await rejected;
    const stopped = f.current.device.local.getSession(f.id); assert.ok(stopped);
    assert.notEqual(stopped.resurrectionCancellationId, old.resurrectionCancellationId);
    const cloudStopped = cloudBytes(f.cloud);
    release.resolve(); await late.promise; f.cloud.readCandidate = read;
    assert.deepEqual(await f.current.device.source.read(f.id), prefix);
    assert.deepEqual(f.current.device.local.getSession(f.id), stopped);
    assert.deepEqual(cloudBytes(f.cloud), cloudStopped);
    assert.equal(f.current.creates, 1);
  } finally { release.resolve(); f.cloud.readCandidate = read; }
});
