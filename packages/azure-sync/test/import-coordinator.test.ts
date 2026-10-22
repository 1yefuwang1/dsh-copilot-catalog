import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { CloudController } from '../src/controller.js';
import { SettingsService } from '../src/settings.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { candidateBlobName } from '../src/sync/cloud-repository.js';
import { publicCloudError } from '../src/protocol.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { batchRow, cloudSession, event, sessionHeader } from './helpers.js';
import { AcceptanceCloud } from './acceptance-helpers.js';
import { coordinatorFixture } from './import-coordinator-fixture.js';

async function fixture(t: TestContext, cloud = new AcceptanceCloud(), queryFactory?: (ctx: Context) => SessionQueryEngine) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-coordinator-')));
  const devices: Array<Awaited<ReturnType<typeof coordinatorFixture>>> = [];
  t.after(async () => { for (const host of devices.reverse()) await host.close(); assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const source = join(root, 'remote-source'); await mkdir(source); await mkdir(join(source, 'nested'));
  const sid = SessionId(`session-${randomUUID()}`), operationId = randomUUID();
  const queued = createUserMessage({ content: [{ type: 'text', text: 'Original pending cloud prompt; consume once ONLY after explicit Continue.' }], source: { kind: 'user' } });
  const header = sessionHeader({ id: sid, cwd: source, delegationDepth: 0 });
  const events = [event(0, 'session/title', { title: 'Verified cloud history', messageSeqs: [], source: { kind: 'user' } }), event(1, 'working-directory/change', { cwd: source }),
    { type: 'agent/inbox/spliced', seq: 2, time: 1002, data: { target: 'next-turn', start: 0, inserted: [queued] } }] as SessionEvent[];
  const binding = headerHash(header, 0), genesis = genesisHash(sid, 1, binding), chain = chainEvents(genesis, events);
  const blobName = candidateBlobName(sid, 1, 0, 1, chain.payloadHash);
  const row = batchRow(sid, 1, 0, { ...chain, eventCount: events.length, endSeq: events.length - 1, blobName });
  await cloud.putCandidate(blobName, gzipSync(payloadBytes(events)), {});
  await cloud.createManifest(cloudSession({ sessionId: sid, headerJson: JSON.stringify(header), headerHash: binding, cwd: source, eventCount: events.length, headSeq: events.length - 1, chainHash: chain.chainHash, headHash: chain.headHash,
    lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: blobName }));
  cloud.rows.set(row.rowKey, { entity: row, etag: 'fixture-row' });
  const host = await coordinatorFixture(join(root, 'receiver'), cloud, { queryFactory }); devices.push(host);
  const context = () => ({ origin: 'rpc' as const, signal: new AbortController().signal });
  const plan = () => host.coordinator.execute({ action: 'plan-import', sessionId: sid, generation: 1, operationId, gitContextVersion: 2,
    destination: { kind: 'local', folderPath: host.cwd }, mapping: { remotePlatform: 'linux', remotePrefix: source } }, context());
  return { root, cloud, source, sid, operationId, queued, events, host, context, plan };
}

test('actual public profile coordinator imports original SID at chosen Local cwd, binds native Workspace, Open inert, Continue wakes original pending once', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const capabilities = await f.host.coordinator.execute({ action: 'import-capabilities' }, f.context());
  assert.equal(capabilities.kind, 'import-capabilities'); if (capabilities.kind !== 'import-capabilities') return;
  assert.equal(capabilities.local, true, JSON.stringify(capabilities)); assert.equal(capabilities.worktree, false);
  const plan = await f.plan(); assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  assert.equal(plan.codeMismatch, true, 'non-Git/unknown Local code requires explicit separate acknowledgment');
  assert.equal(f.host.local.getSession(f.sid), undefined); assert.equal(await f.host.guard.journal.read(f.sid), undefined);
  assert.equal(await f.host.ctx.sessionPersistence.stat(f.sid), undefined); assert.equal(f.host.ctx.agents.get(f.sid), undefined);
  assert.equal(f.cloud.activeLeases.size, 0);
  const imported = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context());
  assert.equal(imported.kind, 'import-operation'); if (imported.kind !== 'import-operation') return;
  assert.equal(imported.phase, 'ready', JSON.stringify(imported)); assert.equal(imported.pendingInput, true); assert.equal(imported.cwd, f.host.cwd);
  assert.equal(f.host.llmCalls, 0); assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.cloud.activeLeases.size, 0);
  const record = f.host.local.getSession(f.sid)!; assert.equal(record.destination?.phase, 'ready');
  const workspace = f.host.ctx.workspaceRegistry.list().find(folder => folder.path === f.host.cwd); assert.ok(workspace?.sessionIds.includes(f.sid));
  const read = await f.host.ctx.sessionPersistence.open(f.sid, 'read');
  assert.equal(read.header.id, f.sid); assert.equal(read.header.cwd, f.host.cwd);
  assert.deepEqual((await read.read(0)).events.map(value => value.type), f.events.map(value => value.type)); await read.close();
  await assert.rejects(f.host.native.resolveAgent(f.sid).then(result => { if ('error' in result) throw new Error(JSON.stringify(result.error)); }), /./);
  assert.equal(f.host.ctx.agents.get(f.sid), undefined, 'native history promotion remains denied before Continue');
  const before = f.host.runtimeCalls;
  const held = await f.host.coordinator.execute({ action: 'import-admission', sessionId: f.sid }, f.context());
  assert.equal(f.host.runtimeCalls, before, 'admission sidechannel is local-only');
  assert.equal(held.kind, 'import-admission'); if (held.kind === 'import-admission') { assert.equal(held.ready, true); assert.equal(held.continued, false); }
  await assert.rejects(f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true }, f.context()), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
  const continued = await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true, acknowledgePendingInput: true }, f.context());
  assert.equal(continued.kind, 'import-operation');
  const agent = f.host.ctx.agents.get(f.sid); assert.ok(agent); await agent.whenIdle();
  assert.equal(f.host.llmCalls, 1); assert.deepEqual(agent.inbox.nextTurn, []);
  const admitted = agent.session.snapshotEvents().filter(value => value.type === 'user/message').map(value => value.data.id);
  assert.equal(admitted.filter(id => id === f.queued.id).length, 1);
  const opened = await f.host.coordinator.execute({ action: 'import-admission', sessionId: f.sid }, f.context());
  if (opened.kind === 'import-admission') assert.equal(opened.continued, true); else assert.fail('admission result');
});

test('a scoped generation mismatch cannot reuse active Native continuation or advertise stale Ready', { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const plan = await f.plan(); if (plan.kind !== 'import-plan') return assert.fail('plan');
  const imported = await f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context());
  if (imported.kind !== 'import-operation') return assert.fail('operation');
  await f.host.coordinator.execute({ action: 'continue-import', sessionId: f.sid, operationId: f.operationId, revision: imported.revision, confirm: true, acknowledgePendingInput: true }, f.context());
  const agent = f.host.ctx.agents.get(f.sid); assert.ok(agent); await agent.whenIdle(); assert.equal(f.host.llmCalls, 1);
  const original = f.host.local.getSession(f.sid)!;
  await f.host.local.putSession({ ...original, generation: 2 }); // Simulates a forbidden legacy generation-adoption checkpoint, not a proof.
  const admission = await f.host.coordinator.execute({ action: 'import-admission', sessionId: f.sid }, f.context());
  if (admission.kind !== 'import-admission') return assert.fail('admission');
  assert.equal(admission.ready, false); assert.equal(admission.continued, false);
  const message = createUserMessage({ content: [{ type: 'text', text: 'Do not execute the wrong generation.' }], source: { kind: 'user' } });
  agent.send(message, 'next-turn', true); await agent.whenIdle();
  assert.equal(f.host.llmCalls, 1); assert.deepEqual(agent.inbox.nextTurn.map(value => value.id), [message.id]);
  const status = await f.host.coordinator.execute({ action: 'import-operation', sessionId: f.sid, operationId: f.operationId }, f.context());
  if (status.kind !== 'import-operation') return assert.fail('status');
  assert.equal(status.phase, 'recovery-required'); assert.equal(status.continuable, false);
  await assert.rejects(f.host.service.resurrectInCloud(f.sid), /generation adoption/);
});

class DelayedCloud extends AcceptanceCloud {
  gate?: Promise<void>;
  entered?: () => void;
  override async readCandidate(name: string): Promise<Buffer> { if (this.gate) { this.entered?.(); await this.gate; } return super.readCandidate(name); }
}
test('cancel before effects is durable/quick despite ignored remote abort, late verification cannot reserve or create, new operation can replan', { timeout: 30_000 }, async t => {
  const cloud = new DelayedCloud(); const f = await fixture(t, cloud);
  const plan = await f.plan(); assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  // Force a cold payload read: a retained verified cache hit legitimately performs no cloud data IO.
  (f.host.runtime.reader as unknown as { invalidate(sessionId?: string): void }).invalidate(f.sid);
  let release!: () => void, entered!: () => void;
  cloud.gate = new Promise(resolve => { release = resolve; }); const blocked = new Promise<void>(resolve => { entered = resolve; }); cloud.entered = entered;
  const commit = f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context())
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  await blocked;
  const stopped = await f.host.coordinator.execute({ action: 'cancel-import', sessionId: f.sid, operationId: f.operationId }, f.context());
  assert.equal(stopped.kind, 'import-operation'); if (stopped.kind === 'import-operation') assert.equal(stopped.phase, 'cancelled');
  assert.equal(f.host.local.getSession(f.sid), undefined); assert.equal(await f.host.guard.journal.read(f.sid), undefined);
  // Logical cancellation now settles before an ignored transport returns. Depending on durable-cancel
  // scheduling it returns the canceled view or the exact cancellation error, never a generic failure.
  const outcome = await commit;
  if (outcome.ok) { assert.equal(outcome.value.kind, 'import-operation'); if (outcome.value.kind === 'import-operation') assert.equal(outcome.value.phase, 'cancelled'); }
  else assert.ok(outcome.error instanceof AzureSyncError && outcome.error.code === 'CANCELLED');
  release(); cloud.gate = undefined;
  assert.equal(f.host.local.getSession(f.sid), undefined); assert.equal(await f.host.ctx.sessionPersistence.stat(f.sid), undefined);
  const replanned = await f.host.coordinator.execute({ action: 'plan-import', sessionId: f.sid, generation: 1, operationId: randomUUID(), gitContextVersion: 2,
    destination: { kind: 'local', folderPath: f.host.cwd }, mapping: { remotePlatform: 'linux', remotePrefix: f.source } }, f.context());
  assert.equal(replanned.kind, 'import-plan'); assert.equal(f.host.llmCalls, 0);
});

test('legacy Off during real projection backpressure retains exact SID/artifact; explicit repair remains detached and complete retained replay is local-only', { timeout: 30_000 }, async t => {
  let release!: () => void, entered!: () => void, held = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observing = new Promise<void>(resolve => { entered = resolve; });
  class GateQuery extends SessionQueryEngine {
    async searchSessions(): Promise<never> { throw new Error('No search in fixture.'); }
    async searchEvents(): Promise<never> { throw new Error('No search in fixture.'); }
    override async observeSession(sid: Parameters<SessionQueryEngine['observeSession']>[0], options?: Parameters<SessionQueryEngine['observeSession']>[1]) {
      if (held) { entered(); await gate; }
      return super.observeSession(sid, options);
    }
  }
  const f = await fixture(t, new AcceptanceCloud(), ctx => new GateQuery(ctx));
  const plan = await f.plan(); assert.equal(plan.kind, 'import-plan'); if (plan.kind !== 'import-plan') return;
  const commit = f.host.coordinator.execute({ action: 'commit-import', sessionId: f.sid, operationId: f.operationId, revision: plan.revision, confirm: true, acknowledgeCodeMismatch: true }, f.context());
  await observing;
  assert.ok((await f.host.guard.journal.read(f.sid))?.artifact, 'readable initial artifact preceded the LocalSessionRecord');
  assert.equal(f.host.local.getSession(f.sid)?.importState, 'warming');
  assert.equal((await f.host.ctx.sessionPersistence.list()).some(item => item.header.id === f.sid), false, 'global discovery still hides pending import');
  const settings = new SettingsService({ local: f.host.local, config: f.host.runtime.config });
  const core = { service: f.host.service, repository: f.cloud.asRepository(), testAuth: async () => {}, signal: f.host.runtime.signal };
  const controls = new CloudController({ local: f.host.local, settings, source: f.host.source, destinations: f.host.coordinator, current: () => core, core: async () => core });
  const off = await controls.execute({ action: 'toggle', sessionId: f.sid, enabled: false }, f.context());
  assert.equal((off as { kind: string }).kind, 'action');
  const stopped = f.host.local.getSession(f.sid)!;
  assert.equal(stopped.enabled, false); assert.equal(stopped.detached, true); assert.equal(stopped.destination?.phase, 'cancelled');
  const cancellationId = stopped.resurrectionCancellationId;
  held = false; release(); await commit;
  const operation = await f.host.coordinator.execute({ action: 'import-operation', sessionId: f.sid, operationId: f.operationId }, f.context());
  assert.equal(operation.kind, 'import-operation'); if (operation.kind !== 'import-operation') return;
  assert.equal(operation.phase, 'cancelled');
  const repaired = await f.host.coordinator.execute({ action: 'resume-import', sessionId: f.sid, operationId: f.operationId, revision: operation.revision, confirm: true }, f.context());
  assert.equal(repaired.kind, 'import-operation'); if (repaired.kind !== 'import-operation') return;
  assert.equal(repaired.phase, 'cancelled', JSON.stringify(repaired)); assert.equal(repaired.continuable, false);
  const current = f.host.local.getSession(f.sid)!;
  assert.equal(current.importState, 'complete'); assert.equal(current.enabled, false); assert.equal(current.detached, true); assert.equal(current.state, 'disabled'); assert.equal(current.resurrectionCancellationId, cancellationId);
  assert.equal(f.host.ctx.agents.get(f.sid), undefined); assert.equal(f.host.llmCalls, 0); assert.equal(f.cloud.activeLeases.size, 0);
  assert.ok((await f.host.guard.journal.read(f.sid))?.historyArtifact);
  const before = f.host.runtimeCalls;
  const again = await f.host.coordinator.execute({ action: 'resume-import', sessionId: f.sid, operationId: f.operationId, revision: repaired.revision, confirm: true }, f.context());
  assert.equal(again.kind, 'import-operation'); assert.equal(f.host.runtimeCalls, before, 'already-proven retained bytes do not boot auth or request a cloud lease');
  await assert.rejects(f.host.service.resurrectInCloud(f.sid), /generation adoption/);
  const snapshot = await f.host.source.read(f.sid); assert.ok(snapshot);
  assert.equal(snapshot.header.id, f.sid); assert.equal(snapshot.header.cwd, f.host.cwd); assert.equal(snapshot.events.length, f.events.length);
  controls.close();
});
