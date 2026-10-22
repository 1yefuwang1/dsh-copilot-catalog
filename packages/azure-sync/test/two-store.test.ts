import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { AzureSyncError } from '../src/azure/errors.js';
import { batchRowKey } from '../src/schema.js';
import { registerSyncLifecycle } from '../src/sync/lifecycle.js';
import { UploadScheduler } from '../src/sync/scheduler.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { chainEvents, genesisHash } from '../src/sync/chain.js';
import { AcceptanceCloud, acceptanceDevice, type AcceptanceDevice } from './acceptance-helpers.js';
import { event } from './helpers.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-two-store-')));
  const cloud = new AcceptanceCloud();
  const devices: AcceptanceDevice[] = [];
  t.after(async () => {
    for (const device of devices.reverse()) await device.close();
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  const a = await acceptanceDevice(join(root, 'a'), 'device-a', cloud); devices.push(a);
  const b = await acceptanceDevice(join(root, 'b'), 'device-b', cloud, a.cwd); devices.push(b);
  const restartA = async () => {
    await a.close();
    const restarted = await acceptanceDevice(join(root, 'a'), 'device-a', cloud, a.cwd); devices.push(restarted);
    return restarted;
  };
  const id = `session-${randomUUID()}`;
  const agent = await a.create(id);
  agent.session.append('session/title', { title: 'Uploaded by A', messageSeqs: [], source: { kind: 'user' } });
  await a.ctx.workingDirectory.ensure(agent);
  await a.uploader.markEnabled(id);
  assert.equal((await a.uploader.sync(id, { release: true })).status, 'synced'); // Release cloud lease, not A's real JSONL owner.
  assert.equal(a.ctx.agents.get(id as never), agent);
  assert.equal((await b.service.importSession(id)).status, 'complete');
  return { root, cloud, a, b, id, agent, restartA };
}

async function advanceB(f: Awaited<ReturnType<typeof fixture>>) {
  const agent = await f.b.resume(f.id);
  agent.session.append('working-directory/change', { cwd: join(f.b.cwd, 'nested') });
  agent.session.append('session/title', { title: 'Continued on B', messageSeqs: [], source: { kind: 'user' } });
  assert.equal(await f.b.ctx.workingDirectory.ensure(agent), join(f.b.cwd, 'nested'));
  const result = await f.b.service.sync(f.id);
  assert.equal(result.status, 'synced');
  assert.ok(result.uploadedBatches > 0);
  return agent;
}

async function assertResurrectionRejectedWithoutEffects(device: AcceptanceDevice, cloud: AcceptanceCloud, id: string) {
  const manifest = await cloud.getManifest(id); assert.ok(manifest);
  const record = device.local.getSession(id); assert.ok(record);
  assert.equal(record.resurrectionIntent, undefined, 'this is not a recorded resurrection completion retry');
  const local = await device.source.read(id);
  const rows = await cloud.listBatchRows(id, manifest.entity.generation);
  const candidates = [...cloud.candidates].map(([name, candidate]) => [name, { bytes: Buffer.from(candidate.bytes), metadata: structuredClone(candidate.metadata) }] as const);
  const leases = structuredClone([...cloud.activeLeases]);
  const held = device.uploader.hasHeld(id);
  const writes = device.writeOpens;
  await assert.rejects(device.service.resurrectInCloud(id), error => error instanceof AzureSyncError && error.code === 'PRECONDITION');
  assert.deepEqual(await cloud.getManifest(id), manifest, 'invalid resurrection must not activate, advance epoch, rewrite header/tip, or change ETag');
  assert.deepEqual(await cloud.listBatchRows(id, manifest.entity.generation), rows);
  assert.deepEqual([...cloud.candidates], candidates);
  assert.deepEqual([...cloud.activeLeases], leases, 'invalid resurrection must not acquire or release a server lease');
  assert.equal(device.uploader.hasHeld(id), held, 'validation must precede uploader.pause');
  assert.equal(device.writeOpens, writes);
  assert.deepEqual(device.local.getSession(id), record, 'invalid resurrection leaves the recorded local opt-in/conflict intent untouched');
  assert.deepEqual(await device.source.read(id), local, 'invalid resurrection never rewrites mapped local JSONL');
}

// This uses actual public AgentLoop, WorkingDirectoryService, and two independent
// JSONL/domain roots. Only cloud transport/leases and optional projection cache
// storage are test ports; the real projection registry computes each cold fold.
test('two stores: retained-live A never opens write; actual host restart cold-appends B suffix and warms cwd projection', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const before = await f.a.source.read(f.id); assert.ok(before);
  const firstManifest = await f.cloud.getManifest(f.id); assert.ok(firstManifest);
  const firstRows = await f.cloud.listBatchRows(f.id, 1);
  await advanceB(f);
  const advanced = await f.cloud.getManifest(f.id); assert.ok(advanced);
  assert.ok(advanced.entity.writerEpoch > firstManifest.entity.writerEpoch, 'B acquires a new writer epoch');
  for (const row of firstRows) assert.deepEqual(f.cloud.rows.get(row.rowKey)?.entity, row, 'committed prefix survives writer epoch change');

  // Add an invalid, unchosen candidate inside the committed watermark. The
  // linked committed index, not blob enumeration/epoch, selects imported bytes.
  const sibling = candidateBlobName(f.id, 1, 0, advanced.entity.writerEpoch + 100, 'f'.repeat(64));
  await f.cloud.putCandidate(sibling, Buffer.from('invalid unchosen sibling'), {});
  const writeOpens = f.a.writeOpens;
  assert.equal((await f.a.service.reconcile(f.id))?.kind, 'remote-ahead');
  assert.equal(f.a.service.status(f.id).status, 'remote-ahead-live');
  assert.deepEqual(await f.a.service.ensureOwnership(f.id), { owned: false, reason: 'remote-ahead-live' });
  await assert.rejects(f.a.service.sync(f.id), error => error instanceof AzureSyncError && error.code === 'CONFLICT');
  assert.equal(f.a.writeOpens, writeOpens, 'refresh/sync/ownership never ask a live Agent for another write handle');
  assert.equal(f.a.ctx.agents.get(f.id as never), f.agent, 'idle/navigation does not dispose the retained host Agent');
  assert.deepEqual((await f.a.source.read(f.id))?.events, before.events, 'live reconciliation preserves the durable local prefix');

  const restarted = await f.restartA();
  assert.equal(restarted.ctx.agents.get(f.id as never), undefined, 'new host has no retained Agent');
  assert.equal(restarted.local.getSession(f.id)?.status, 'remote-ahead-live', 'restart reopens durable sidecar state');
  const coldWriteOpens = restarted.writeOpens;
  assert.equal((await restarted.service.reconcile(f.id))?.kind, 'remote-ahead');
  assert.equal(restarted.writeOpens, coldWriteOpens + 1, 'only cold catch-up acquires write ownership');
  assert.equal(restarted.service.status(f.id).status, 'synced');
  assert.equal(restarted.local.getSession(f.id)?.importState, 'complete');
  const remote = await restarted.reader.read(f.id); assert.ok(remote);
  const local = await restarted.source.read(f.id); assert.ok(local);
  assert.deepEqual(local.events, remote.events, 'A replays exactly the selected canonical history without synthetic closers');
  assert.deepEqual(local.events.slice(0, before.events.length), before.events, 'catch-up preserves the entire original prefix');
  assert.equal(local.header.cwd, f.a.cwd);
  const warmed = restarted.checkpoints.get(f.id); assert.ok(warmed);
  assert.equal(warmed.asOfSeq, local.events.length - 1);
  assert.equal(warmed.values.workingDirectory, join(f.a.cwd, 'nested'), 'actual WorkingDirectory projection sees localized suffix before any live open');
  assert.equal(f.cloud.reads.includes(sibling), false, 'unchosen corrupt sibling was never fetched');
  assert.equal((await restarted.service.reconcile(f.id))?.kind, 'same');
  assert.equal((await f.b.service.reconcile(f.id))?.kind, 'same');
  assert.equal(restarted.service.status(f.id).status, 'synced');
  assert.equal(f.b.service.status(f.id).status, 'synced');
  assert.equal(restarted.local.getSession(f.id)?.lastSyncedChainHash, f.b.local.getSession(f.id)?.lastSyncedChainHash);
  assert.equal(f.cloud.manifests.size, 1, 'catch-up does not fork or overwrite the remote');
});

test('real AgentLoop rejects/requeues once; clean disposal records cancellation, and restart preserves conflict without merging', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await advanceB(f);
  await f.a.service.reconcile(f.id);
  const writes = f.a.writeOpens;
  const scheduler = new UploadScheduler(async id => { await f.a.service.sync(id); }, 60_000);
  const dispose = registerSyncLifecycle({ ctx: f.a.ctx, service: f.a.service, scheduler, local: f.a.local, now: Date.now });
  t.after(async () => { dispose(); await scheduler.stop(); });
  const prompt = f.a.prompt('Do not execute stale history.');
  f.agent.send(prompt, 'next-turn', true);
  await f.agent.whenIdle();
  await f.a.ctx.sessionPersistence.flush();
  assert.equal(f.a.llmCalls, 0, 'pre-step rejects before any model call');
  assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), [prompt.id], 'claimed input is requeued exactly once');
  assert.deepEqual(f.a.local.getSession(f.id)?.admissionReceipt?.messageIds, [prompt.id]);
  assert.equal(f.a.local.getSession(f.id)?.admissionReceipt?.reason, 'remote-ahead-live');
  assert.equal(f.a.writeOpens, writes, 'the actual retained Agent owns the only writer');
  const rejected = await f.a.source.read(f.id); assert.ok(rejected);
  assert.ok(rejected.events.some(value => value.type === 'agent/inbox/spliced'), 'native rejected-turn bookkeeping is durable');
  dispose(); await scheduler.stop();
  const restarted = await f.restartA();
  const coldWrites = restarted.writeOpens;
  assert.equal((await restarted.service.reconcile(f.id))?.kind, 'diverged');
  assert.equal(restarted.service.status(f.id).status, 'conflict');
  assert.deepEqual(await restarted.service.ensureOwnership(f.id), { owned: false, reason: 'conflict' });
  assert.equal(restarted.writeOpens, coldWrites, 'a non-prefix is never appended even after restart');
  const afterRestart = await restarted.source.read(f.id); assert.ok(afterRestart);
  assert.deepEqual(afterRestart.events.slice(0, rejected.events.length), rejected.events, 'conflict preserves the entire rejection/input log prefix');
  // Clean AgentLoop disposal itself may append an outcome:canceled inbox clear.
  // We do not misrepresent that native host policy as retained pending input.
  const disposal = afterRestart.events.slice(rejected.events.length);
  assert.equal(disposal.length, 1, 'clean host disposal records exactly one pending-inbox cancellation');
  assert.equal(disposal[0]?.type, 'agent/inbox/spliced');
  assert.deepEqual(disposal[0]?.data, { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
  assert.deepEqual(restarted.local.getSession(f.id)?.admissionReceipt?.messageIds, [prompt.id], 'the cloud admission receipt remains durable after native cancellation');
});

for (const action of ['keep-local', 'export-local', 'remove-cloud'] as const) {
  test(`two-store divergence: ${action} preserves local history and applies only its explicit cloud effect`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    await advanceB(f);
    f.agent.session.append('session/title', { title: 'Divergent local title', messageSeqs: [], source: { kind: 'user' } });
    await f.a.ctx.sessionPersistence.flush();
    const localBefore = await f.a.source.read(f.id); assert.ok(localBefore);
    const remoteBefore = await f.cloud.getManifest(f.id); assert.ok(remoteBefore);
    const writes = f.a.writeOpens;
    assert.equal((await f.a.service.reconcile(f.id))?.kind, 'diverged');
    assert.equal(f.a.service.status(f.id).status, 'conflict');
    assert.equal(f.a.writeOpens, writes);
    await assert.rejects(f.a.service.sync(f.id), error => error instanceof AzureSyncError && error.code === 'CONFLICT');
    await assert.rejects(f.a.service.resolveConflict(f.id, 'overwrite-cloud'), error => error instanceof Error);
    if (action === 'remove-cloud') await f.b.uploader.pause(f.id);
    await f.a.service.resolveConflict(f.id, action);
    assert.deepEqual((await f.a.source.read(f.id))?.events, localBefore.events, 'conflict actions never rewrite local JSONL');
    const record = f.a.local.getSession(f.id); assert.ok(record);
    if (action === 'export-local') {
      assert.equal(record.status, 'conflict', 'export alone does not authorize continuation');
      assert.equal(record.enabled, true);
      assert.ok(record.conflictBackupPath);
      assert.equal((await stat(record.conflictBackupPath)).mode & 0o777, 0o600);
      const lines = (await readFile(record.conflictBackupPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(lines[0], { type: 'session', ...localBefore.header, inheritedEventCount: localBefore.inheritedEventCount });
      assert.deepEqual(lines.slice(1), localBefore.events);
      assert.deepEqual(await f.cloud.getManifest(f.id), remoteBefore, 'export leaves remote ETag/history untouched');
    } else {
      assert.equal(record.enabled, false);
      assert.equal(record.detached, true);
      assert.equal(record.status, 'detached');
      if (action === 'keep-local') assert.deepEqual(await f.cloud.getManifest(f.id), remoteBefore, 'keep-local never disables/removes remote');
      else {
        const removed = await f.cloud.getManifest(f.id); assert.ok(removed);
        assert.equal(removed.entity.state, 'deleted');
        assert.equal(removed.entity.cleanupPending, false);
        assert.equal((await f.cloud.listBatchRows(f.id, 1)).length, 0);
        assert.equal(f.cloud.candidates.size, 0);
      }
    }
  });
}

for (const change of ['tombstone', 'generation'] as const) {
  test(`offline A reconnect after remote ${change} stops without writing or resurrecting`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
    const localBefore = await f.a.source.read(f.id);
    if (change === 'tombstone') await f.b.service.removeFromCloud(f.id);
    else await f.cloud.updateManifest({ ...manifest.entity, generation: 2, rootGeneration: 2, writerEpoch: manifest.entity.writerEpoch + 1 }, manifest.etag);
    const remoteBefore = await f.cloud.getManifest(f.id);
    const writes = f.a.writeOpens;
    assert.equal((await f.a.service.reconcile(f.id))?.kind, change === 'tombstone' ? 'deleted' : 'generation-changed');
    assert.equal(f.a.service.status(f.id).status, change === 'tombstone' ? 'removed-remotely' : 'generation-changed');
    assert.equal(f.a.service.status(f.id).enabled, false);
    assert.equal((await f.a.service.ensureOwnership(f.id)).owned, false);
    await f.a.service.sync(f.id);
    assert.deepEqual(await f.cloud.getManifest(f.id), remoteBefore, 'routine reconnect never mutates a tombstone/new generation');
    assert.deepEqual(await f.a.source.read(f.id), localBefore);
    assert.equal(f.a.writeOpens, writes);
  });
}

for (const terminal of ['tombstone', 'generation', 'missing'] as const) {
  test(`real AgentLoop terminal ${terminal} stop rejects/requeues direct input until explicit local off authorizes continuation`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const scheduler = new UploadScheduler(async id => { await f.a.service.sync(id); }, 60_000);
    const dispose = registerSyncLifecycle({ ctx: f.a.ctx, service: f.a.service, scheduler, local: f.a.local, now: Date.now });
    t.after(async () => { dispose(); await scheduler.stop(); });
    const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
    if (terminal === 'tombstone') await f.b.service.removeFromCloud(f.id);
    else if (terminal === 'generation') await f.cloud.updateManifest({ ...manifest.entity, generation: 2, rootGeneration: 2, writerEpoch: manifest.entity.writerEpoch + 1 }, manifest.etag);
    else f.cloud.manifests.delete(f.id); // Simulate a previously tracked cloud manifest disappearing.
    await f.a.service.reconcile(f.id);
    const reason = terminal === 'tombstone' ? 'removed-remotely' : terminal === 'generation' ? 'generation-changed' : 'remote-missing';
    const stopped = f.a.local.getSession(f.id); assert.ok(stopped);
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.detached, false, 'a remote terminal stop is not explicit permission to continue locally');
    assert.equal(stopped.status, reason);
    const remoteStopped = await f.cloud.getManifest(f.id);
    const writes = f.a.writeOpens;
    const parked = f.a.prompt(`Do not execute automatically after remote ${terminal}.`);
    f.agent.send(parked, 'next-turn', true);
    await f.agent.whenIdle();
    await f.a.ctx.sessionPersistence.flush();
    assert.equal(f.a.llmCalls, 0, 'the actual lifecycle pre-step gate must reject even though terminal reconciliation set enabled:false');
    assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), [parked.id], 'direct native input is requeued exactly once');
    assert.equal(f.a.local.getSession(f.id)?.admissionReceipt?.reason, reason);
    assert.deepEqual(f.a.local.getSession(f.id)?.admissionReceipt?.messageIds, [parked.id]);
    assert.equal(f.a.local.getSession(f.id)?.status, reason);
    assert.deepEqual(await f.cloud.getManifest(f.id), remoteStopped, 'blocked input never recreates, reactivates, or overwrites cloud history');
    assert.equal(f.a.writeOpens, writes);

    // Only the explicit local opt-out clears the execution stop. Waking input
    // then consumes the previously rejected prompt exactly once as ordinary
    // local history; this is not an ownership-helper-only admission assertion.
    await f.a.service.disable(f.id);
    assert.equal(f.a.service.status(f.id).enabled, false);
    assert.equal(f.a.service.status(f.id).status, 'detached');
    const cloudAfterOff = await f.cloud.getManifest(f.id);
    const authorized = f.a.prompt('Explicitly opted out: continue locally.');
    f.agent.send(authorized, 'next-turn', true);
    await f.agent.whenIdle();
    await f.a.ctx.sessionPersistence.flush();
    assert.equal(f.a.llmCalls, 2, 'both the parked input and new waking input execute only after explicit local opt-out');
    assert.equal(f.agent.inbox.nextTurn.length, 0);
    const events = (await f.a.source.read(f.id))?.events; assert.ok(events);
    for (const id of [parked.id, authorized.id]) assert.equal(events.filter(value => value.type === 'user/message' && value.data.id === id).length, 1, 'no prompt is lost or duplicated across the terminal gate');
    assert.equal(f.a.writeOpens, writes, 'retained local Agent remains the only JSONL writer');
    assert.deepEqual(await f.cloud.getManifest(f.id), cloudAfterOff, 'authorized local turns do not schedule cloud publication');
    if (terminal === 'tombstone') assert.equal((await f.cloud.getManifest(f.id))?.entity.state, 'deleted', 'local continuation never resurrects the tombstone');
    if (terminal === 'missing') assert.equal(await f.cloud.getManifest(f.id), undefined, 'local continuation never recreates the missing cloud copy');
    dispose(); await scheduler.stop();
  });
}

for (const loss of ['generation', 'committed-index'] as const) {
  test(`lost explicit resurrection ${loss} supersedes an older detach and blocks real AgentLoop input until a new explicit off`, { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.a.service.removeFromCloud(f.id);
  await f.a.service.disable(f.id);
  assert.equal(f.a.local.getSession(f.id)?.detached, true, 'the earlier explicit local-only choice really was persisted');
  assert.equal((await f.cloud.getManifest(f.id))?.entity.state, 'deleted');
  const originalTransaction = f.a.local.transactSession.bind(f.a.local);
  const checkpointFailure = new Error('Injected local checkpoint failure after resurrection CAS.');
  let injected = false;
  f.a.local.transactSession = (id, transform) => originalTransaction(id, current => {
    const record = transform(current);
    if (!injected && record?.state === 'active' && record.generation === 2) {
      injected = true;
      throw checkpointFailure;
    }
    return record;
  });
  try {
    await assert.rejects(f.a.service.resurrectInCloud(f.id), error => error === checkpointFailure);
  } finally {
    f.a.local.transactSession = originalTransaction;
  }
  assert.equal(injected, true);
  const pending = f.a.local.getSession(f.id); assert.ok(pending);
  assert.ok(pending.resurrectionIntent, 'the explicit resync intent survives the lost final local checkpoint');
  assert.equal(pending.enabled, false);
  const activated = await f.cloud.getManifest(f.id); assert.ok(activated);
  assert.equal(activated.entity.state, 'active');
  assert.equal(activated.entity.generation, 2, 'the cloud CAS really committed before the injected local failure');
  assert.equal(activated.entity.resurrectionId, pending.resurrectionIntent.operationId);
  if (loss === 'generation') {
    const unrelatedGenesis = genesisHash(f.id, 3, activated.entity.headerHash, activated.entity.schemaVersion);
    await f.cloud.updateManifest({ ...activated.entity, generation: 3, rootGeneration: 3, previousGeneration: 2,
      resurrectionId: randomUUID(), writerEpoch: activated.entity.writerEpoch + 1,
      chainHash: unrelatedGenesis, headHash: unrelatedGenesis }, activated.etag);
  } else {
    // Keep this operation's exact gen-2 token/header proof, but claim a committed
    // event whose linked batch row is missing. Recovery must terminalize even
    // though its error is not a generation/deletion/live status enum member.
    await f.cloud.updateManifest({ ...activated.entity, eventCount: 1, headSeq: 0, batchCount: 1,
      lastBatchRowKey: batchRowKey(f.id, 2, 0), lastBatchGeneration: 2,
      lastBatchBlobName: candidateBlobName(f.id, 2, 0, activated.entity.writerEpoch, 'f'.repeat(64)),
      chainHash: 'f'.repeat(64), headHash: 'f'.repeat(64) }, activated.etag);
  }
  const reason = loss === 'generation' ? 'generation-changed' : 'committed-index-corrupt';
  const unrelated = await f.cloud.getManifest(f.id);
  const localBefore = await f.a.source.read(f.id); assert.ok(localBefore);
  const writes = f.a.writeOpens;
  await f.a.service.repairResurrections();
  assert.deepEqual(await f.cloud.getManifest(f.id), unrelated, 'lost-intent repair must not reactivate, fence, or overwrite an unrelated new generation');

  const scheduler = new UploadScheduler(async id => { await f.a.service.sync(id); }, 60_000);
  const dispose = registerSyncLifecycle({ ctx: f.a.ctx, service: f.a.service, scheduler, local: f.a.local, now: Date.now });
  t.after(async () => { dispose(); await scheduler.stop(); });
  const parked = f.a.prompt('My explicit cloud resync lost to a newer generation; do not execute stale local history.');
  f.agent.send(parked, 'next-turn', true);
  await f.agent.whenIdle();
  await f.a.ctx.sessionPersistence.flush();
  assert.equal(f.a.llmCalls, 0, 'an older detached:true must not bypass admission after a newer explicit resync intent is terminalized');
  assert.deepEqual(f.agent.inbox.nextTurn.map(message => message.id), [parked.id]);
  const stopped = f.a.local.getSession(f.id); assert.ok(stopped);
  assert.equal(pending.detached, false, 'creating the newer explicit resurrection intent supersedes the old detach permission');
  assert.equal(stopped.resurrectionIntent, undefined);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.detached, false, 'terminal recovery retains the new cloud-admission stop, not the superseded local-only choice');
  assert.equal(pending.admissionStopped, true);
  assert.equal(stopped.admissionStopped, true, 'terminal recovery retains a dedicated admission stop after clearing its intent token');
  assert.equal(stopped.status, reason);
  assert.equal(stopped.admissionReceipt?.reason, reason);
  assert.deepEqual(stopped.admissionReceipt?.messageIds, [parked.id]);
  assert.deepEqual((await f.a.source.read(f.id))?.events.slice(0, localBefore.events.length), localBefore.events);
  assert.equal(f.a.writeOpens, writes);

  await f.a.service.disable(f.id); // A NEW user action, after terminal recovery.
  assert.equal(f.a.local.getSession(f.id)?.detached, true);
  assert.notEqual(f.a.local.getSession(f.id)?.admissionStopped, true, 'only a new explicit opt-out clears the terminal admission marker');
  assert.equal(f.a.service.status(f.id).status, 'detached');
  const cloudAfterOff = await f.cloud.getManifest(f.id);
  // Waking with steering input admits the parked prompt and this new explicit
  // local instruction together in one actual model step, without dropping input.
  const authorized = f.a.prompt('New explicit opt-out: continue this parked input locally.');
  f.agent.send(authorized, 'next-step', true);
  await f.agent.whenIdle();
  await f.a.ctx.sessionPersistence.flush();
  assert.equal(f.a.llmCalls, 1, 'only the newer explicit local opt-out authorizes one real model step');
  assert.equal(f.agent.inbox.nextTurn.length, 0);
  assert.equal(f.agent.inbox.nextStep.length, 0);
  const events = (await f.a.source.read(f.id))?.events; assert.ok(events);
  for (const id of [parked.id, authorized.id]) assert.equal(events.filter(value => value.type === 'user/message' && value.data.id === id).length, 1);
  assert.deepEqual(await f.cloud.getManifest(f.id), cloudAfterOff);
  assert.equal(f.a.writeOpens, writes);
  dispose(); await scheduler.stop();
  });
}

test('service.sync reconciles a cold remote suffix before upload and leaves the committed cloud tip untouched', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await advanceB(f);
  const remoteBefore = await f.cloud.getManifest(f.id);
  const restarted = await f.restartA();
  const writes = restarted.writeOpens;
  const summary = await restarted.service.sync(f.id);
  assert.equal(summary.status, 'synced');
  assert.equal(summary.uploadedBatches, 0);
  assert.equal(restarted.writeOpens, writes + 1);
  assert.deepEqual(await f.cloud.getManifest(f.id), remoteBefore, 'catch-up is not an upload or an epoch acquisition');
  assert.equal(restarted.service.status(f.id).status, 'synced');
  assert.equal(restarted.checkpoints.get(f.id)?.asOfSeq, summary.eventCount - 1);
});

for (const fault of ['transient-partial', 'cancel-complete'] as const) {
  test(`same-process refreshAll retries ${fault} cold catch-up through real JSONL and warms projections without an epoch write`, { timeout: 20_000 }, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = await fixture(t);
    const bAgent = await advanceB(f);
    for (let index = 0; index < 9; index += 1) bAgent.session.append('session/title', { title: `B durable suffix ${index}`, messageSeqs: [], source: { kind: 'user' } });
    assert.equal((await f.b.service.sync(f.id)).status, 'synced');
    const remote = await f.b.reader.read(f.id); assert.ok(remote);
    const cloudBefore = await f.cloud.getManifest(f.id);
    const cold = await f.restartA();
    const prefix = await cold.source.read(f.id); assert.ok(prefix);
    assert.ok(remote.events.length - prefix.events.length > 4, 'the suffix spans multiple actual importer append/flush batches');
    const persistence = cold.ctx.sessionPersistence;
    const originalOpen = persistence.open.bind(persistence);
    const controller = new AbortController();
    const cancelReason = new DOMException('Canceled after durable suffix, before projection warming.', 'AbortError');
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let appendCalls = 0;
    let injected = false;
    const writes = cold.writeOpens;
    // Fault only the write-handle operation boundary: every successful append,
    // read, flush and close still runs on the actual JSONL persistence handle.
    persistence.open = async (...openArgs: Parameters<typeof persistence.open>) => {
      const handle = await originalOpen(...openArgs);
      if (openArgs[1] !== 'write') return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'append') return async (...args: Parameters<typeof handle.append>) => {
            appendCalls += 1;
            if (fault === 'transient-partial' && appendCalls === 2 && !injected) {
              injected = true;
              throw new AzureSyncError('TRANSIENT', 'Injected interruption after the first durable suffix batch.');
            }
            return handle.append(...args);
          };
          if (property === 'flush') return async (...args: Parameters<typeof handle.flush>) => {
            await handle.flush(...args);
            if (fault === 'cancel-complete' && !injected && (await handle.read(0)).events.length === remote.events.length) {
              injected = true;
              controller.abort(cancelReason);
            }
          };
          if (property === 'close') return async () => {
            try { await handle.close(); }
            finally { resolveClosed(); }
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    try {
      if (fault === 'cancel-complete') {
        // Explicit request cancellation owns reconciliation; a poll tick must
        // never be the lifetime owner of a separately registered real worker.
        await assert.rejects(cold.service.reconcile(f.id, controller.signal), error => error === cancelReason);
      } else {
        await cold.service.refreshAll();
        await assert.rejects(cold.service.waitForHistoryWork(f.id), error => error instanceof AzureSyncError && error.code === 'TRANSIENT');
      }
      await closed;
      // Caller cancellation may settle service's abort race before the importer
      // finally removes its write claim. Yield one event-loop turn, not a retry
      // sleep, after observing the real handle close before issuing fresh work.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(injected, true);
      const interrupted = await cold.source.read(f.id); assert.ok(interrupted);
      assert.ok(interrupted.events.length > prefix.events.length, 'some or all remote suffix bytes are already durable');
      assert.deepEqual(interrupted.events.slice(0, prefix.events.length), prefix.events);
      assert.deepEqual(interrupted.events, remote.events.slice(0, interrupted.events.length), 'only the verified committed prefix was appended');
      if (fault === 'transient-partial') assert.ok(interrupted.events.length < remote.events.length);
      else assert.equal(interrupted.events.length, remote.events.length, 'equal counts still need the interrupted projection phase repaired');
      const pending = cold.local.getSession(f.id); assert.ok(pending);
      assert.equal(pending.enabled, true);
      assert.equal(pending.catchUpPending, true);
      assert.equal(pending.importState, 'appending');
      assert.notEqual(pending.status, 'synced');
      assert.equal(cold.checkpoints.get(f.id), undefined, 'the failed/canceled attempt has not warmed any projection');
      assert.equal(cold.writeOpens, writes + 1);
      assert.deepEqual(await f.cloud.getManifest(f.id), cloudBefore);
      const appendsBeforeRetry = appendCalls;

      // No new host, ImportService, or SyncService instance is created here.
      // Advance the retry clock past bounded backoff, never reset or bypass it.
      t.mock.timers.setTime(Date.now() + 10_000);
      // Observation registers work; the readonly join observes its own lifetime.
      await cold.service.refreshAll();
      await cold.service.waitForHistoryWork(f.id);
      const complete = await cold.source.read(f.id); assert.ok(complete);
      assert.deepEqual(complete.events, remote.events, 'retry neither duplicates nor rewrites the already-durable prefix');
      if (fault === 'cancel-complete') assert.equal(appendCalls, appendsBeforeRetry, 'same-count retry only verifies/finalizes; it appends no duplicate suffix');
      assert.equal(cold.writeOpens, writes + 2, 'retry obtains a fresh real cold writer claim');
      assert.equal(cold.local.getSession(f.id)?.catchUpPending, false);
      assert.equal(cold.local.getSession(f.id)?.importState, 'complete');
      assert.equal(cold.service.status(f.id).status, 'synced');
      assert.equal(cold.checkpoints.get(f.id)?.asOfSeq, remote.events.length - 1);
      assert.equal(cold.checkpoints.get(f.id)?.values.workingDirectory, join(f.a.cwd, 'nested'));
      assert.equal((await f.b.service.reconcile(f.id))?.kind, 'same');
      assert.equal(f.b.service.status(f.id).status, 'synced');
      assert.equal(cold.local.getSession(f.id)?.lastSyncedChainHash, f.b.local.getSession(f.id)?.lastSyncedChainHash);
      assert.equal((await cold.service.sync(f.id)).uploadedBatches, 0);
      assert.deepEqual(await f.cloud.getManifest(f.id), cloudBefore, 'retry, finalization, and a subsequent synced sync never mutate remote ETag/epoch/tip');
    } finally {
      persistence.open = originalOpen;
    }
  });
}

test('a missing committed link is corrupt, never replaced by an unchosen candidate or appended locally', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await advanceB(f);
  const restarted = await f.restartA();
  const before = await restarted.source.read(f.id);
  const rows = await f.cloud.listBatchRows(f.id, 1);
  assert.ok(rows.length >= 2);
  const prefix = rows.find(row => row.prevBatchRowKey === undefined); assert.ok(prefix);
  f.cloud.rows.delete(prefix.rowKey); // Simulate external Table corruption, not a runtime cleanup.
  const writes = restarted.writeOpens;
  await assert.rejects(restarted.service.reconcile(f.id), error => error instanceof AzureSyncError && error.code === 'COMMITTED_INDEX_CORRUPT');
  assert.equal(restarted.writeOpens, writes);
  assert.deepEqual(await restarted.source.read(f.id), before);
});

test('mapped imported B cannot resurrect an active cloud copy or disturb its existing held lease', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  // A retained Agent owns lifecycle authority. Cold control calls now release
  // their operation leases, so create the real idle host Agent for this guard.
  await f.b.resume(f.id);
  assert.equal((await f.b.service.enable(f.id)).status, 'synced');
  assert.equal(f.b.uploader.hasHeld(f.id), true);
  assert.equal(f.cloud.activeLeases.get(f.id)?.owner, 'device-b');
  await assertResurrectionRejectedWithoutEffects(f.b, f.cloud, f.id);
  assert.equal((await f.b.service.reconcile(f.id))?.kind, 'same');
  assert.equal(f.b.service.status(f.id).status, 'synced');
});

for (const appendWhileDisabled of [false, true]) {
  test(`imported mapped B explicitly re-enables retained disabled history${appendWhileDisabled ? ' with a new local cwd/title suffix' : ' without resetting its tip'}`, { timeout: 20_000 }, async t => {
    const f = await fixture(t);
    const imported = await f.b.source.read(f.id); assert.ok(imported);
    const agent = appendWhileDisabled ? await f.b.resume(f.id) : undefined;
    assert.equal(imported.header.cwd, f.b.cwd);
    assert.notEqual(imported.header.cwd, f.a.cwd, 'the imported header really uses a different device mapping');
    const original = await f.cloud.getManifest(f.id); assert.ok(original);
    const originalRows = await f.cloud.listBatchRows(f.id, original.entity.generation);
    const originalCandidates = [...f.cloud.candidates].map(([name, candidate]) => [name, { bytes: Buffer.from(candidate.bytes), metadata: structuredClone(candidate.metadata) }] as const);
    await f.b.service.disable(f.id);
    const disabled = await f.cloud.getManifest(f.id); assert.ok(disabled);
    assert.equal(disabled.entity.state, 'disabled');
    assert.equal(disabled.entity.enabled, false);
    assert.equal(disabled.entity.generation, original.entity.generation);
    assert.equal(disabled.entity.chainHash, original.entity.chainHash);
    assert.equal(disabled.entity.lastBatchRowKey, original.entity.lastBatchRowKey);
    if (appendWhileDisabled) {
      assert.ok(agent);
      agent.session.append('working-directory/change', { cwd: join(f.b.cwd, 'nested') });
      agent.session.append('session/title', { title: 'Local edits while cloud sync is disabled', messageSeqs: [], source: { kind: 'user' } });
      assert.equal(await f.b.ctx.workingDirectory.ensure(agent), join(f.b.cwd, 'nested'));
    }
    await f.b.ctx.sessionPersistence.flush();
    const beforeEnable = await f.b.source.read(f.id); assert.ok(beforeEnable);
    assert.equal((await f.b.service.sync(f.id)).status, 'disabled', 'routine sync cannot reactivate retained disabled cloud history');
    assert.deepEqual(await f.cloud.getManifest(f.id), disabled);
    await assertResurrectionRejectedWithoutEffects(f.b, f.cloud, f.id);
    const writes = f.b.writeOpens;
    const summary = await f.b.service.enable(f.id);
    assert.equal(summary.status, 'synced');
    assert.equal(summary.uploadedBatches, appendWhileDisabled ? 1 : 0);
    assert.equal(summary.eventCount, beforeEnable.events.length);
    const active = await f.cloud.getManifest(f.id); assert.ok(active);
    assert.equal(active.entity.state, 'active');
    assert.equal(active.entity.enabled, true);
    assert.ok(active.entity.writerEpoch > disabled.entity.writerEpoch);
    assert.equal(active.entity.generation, original.entity.generation, 'explicit re-enable is not resurrection');
    assert.equal(active.entity.rootGeneration, original.entity.rootGeneration);
    assert.equal(active.entity.headerJson, original.entity.headerJson);
    assert.equal(active.entity.headerHash, original.entity.headerHash);
    assert.equal(active.entity.inheritedEventCount, original.entity.inheritedEventCount);
    for (const row of originalRows) assert.deepEqual(f.cloud.rows.get(row.rowKey)?.entity, row, 'retained committed rows are never reset or rewritten');
    for (const [name, candidate] of originalCandidates) assert.deepEqual(f.cloud.candidates.get(name), candidate, 'retained immutable candidate bytes stay unchanged');
    if (!appendWhileDisabled) {
      assert.equal(active.entity.lastBatchRowKey, original.entity.lastBatchRowKey);
      assert.equal(active.entity.lastBatchBlobName, original.entity.lastBatchBlobName);
      assert.equal(active.entity.eventCount, original.entity.eventCount);
      assert.equal(active.entity.chainHash, original.entity.chainHash);
      assert.equal(active.entity.batchCount, original.entity.batchCount);
    } else {
      assert.equal(active.entity.batchCount, original.entity.batchCount + 1);
      const tip = f.cloud.rows.get(active.entity.lastBatchRowKey!); assert.ok(tip);
      assert.equal(tip.entity.prevBatchRowKey, original.entity.lastBatchRowKey, 'new disabled-period suffix links onto the retained tip');
    }
    const remote = await f.b.reader.read(f.id); assert.ok(remote);
    assert.deepEqual(remote.events.slice(0, imported.events.length), (await f.a.source.read(f.id))?.events);
    if (appendWhileDisabled) assert.deepEqual(remote.events.at(-2)?.data, { cwd: join(f.a.cwd, 'nested') }, 'only the new local cwd is forward-canonicalized for cloud publication');
    assert.deepEqual(await f.b.source.read(f.id), beforeEnable, 're-enable never rewrites localized JSONL');
    assert.equal(f.b.writeOpens, writes, 'explicit re-enable validates history without acquiring another local write handle');
    assert.equal((await f.b.service.reconcile(f.id))?.kind, 'same');
    assert.equal(f.b.service.status(f.id).status, 'synced');
  });
}

test('imported mapped B cannot reactivate or overwrite a divergent retained disabled prefix', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const agent = await f.b.resume(f.id);
  agent.session.append('session/title', { title: 'B divergent local suffix', messageSeqs: [], source: { kind: 'user' } });
  f.agent.session.append('session/title', { title: 'A different committed suffix', messageSeqs: [], source: { kind: 'user' } });
  assert.equal((await f.a.uploader.sync(f.id, { release: true })).status, 'synced');
  await f.b.service.disable(f.id);
  await f.b.ctx.sessionPersistence.flush();
  const disabled = await f.cloud.getManifest(f.id); assert.ok(disabled);
  assert.equal(disabled.entity.state, 'disabled');
  const localBefore = await f.b.source.read(f.id); assert.ok(localBefore);
  assert.ok(localBefore.events.length >= disabled.entity.eventCount, 'B has a local suffix, not merely missing remote events; retained-prefix verification is required');
  const rows = await f.cloud.listBatchRows(f.id, disabled.entity.generation);
  const candidates = [...f.cloud.candidates].map(([name, candidate]) => [name, { bytes: Buffer.from(candidate.bytes), metadata: structuredClone(candidate.metadata) }] as const);
  const writes = f.b.writeOpens;
  await assertResurrectionRejectedWithoutEffects(f.b, f.cloud, f.id);
  await assert.rejects(f.b.service.enable(f.id), error => error instanceof AzureSyncError && ['CONFLICT', 'PROVENANCE_MISMATCH'].includes(error.code));
  assert.deepEqual(await f.cloud.getManifest(f.id), disabled, 'prefix verification must fail before any cloud reactivation, lease epoch, or tip mutation');
  assert.deepEqual(await f.cloud.listBatchRows(f.id, disabled.entity.generation), rows);
  assert.deepEqual([...f.cloud.candidates], candidates);
  assert.deepEqual(await f.b.source.read(f.id), localBefore, 'both local and retained remote suffixes are preserved');
  assert.equal(f.b.writeOpens, writes);
  assert.equal(f.b.service.status(f.id).status, 'conflict');
  assert.equal(f.cloud.activeLeases.has(f.id), false, 'rejected re-enable must not leak a server write lease');
});

test('unchosen old-epoch candidate has valid divergent JSONL but never becomes a committed import prefix', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const manifest = await f.cloud.getManifest(f.id); assert.ok(manifest);
  const events = [event(0, 'working-directory/change', { cwd: '/unapproved/decoy' })];
  const chain = chainEvents(genesisHash(f.id, 1, manifest.entity.headerHash), events);
  const sibling = candidateBlobName(f.id, 1, 0, Math.max(0, manifest.entity.writerEpoch - 1), chain.payloadHash);
  await f.cloud.putCandidate(sibling, gzipSync(payloadBytes(events)), {});
  const selected = await f.b.reader.read(f.id); assert.ok(selected);
  assert.equal(selected.events.some(value => value.type === 'working-directory/change' && value.data.cwd === '/unapproved/decoy'), false);
  assert.equal(f.cloud.reads.includes(sibling), false);
  assert.equal((await f.b.service.reconcile(f.id))?.kind, 'same');
  assert.equal(f.b.service.status(f.id).status, 'synced');
});
