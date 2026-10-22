import { withHistory } from './runtime-history-fixture.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { boot, loadOverlayPatches, StartupError } from '@deepseek-ai/dsh-app-boot';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionId, SessionLogOffset, SessionStore, type SessionHeader } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime, LlmAdapter, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import * as GuardPlugin from '../src/import/guard.js';
import * as Provider from '../src/import/persistence.js';
import { importFence, type ImportReservation } from '../src/import/journal.js';
import { ImportClaimError, SidClaimStore } from '../src/import/claims.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes, payloadHash } from '../src/sync/canonical.js';
import { Config } from '../src/config.js';
import { Importer } from '../src/sync/importer.js';
import { ImportRecovery } from '../src/sync/recovery.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { batchRow, cloudSession, event, pathMapping, sessionHeader } from './helpers.js';
import { openLocal } from './import-compatibility-fixture.js';
import { gzipSync } from 'node:zlib';

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-foundation-')));
  const cleanup: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanup.reverse()) try { await close(); } catch (error) { errors.push(error); }
    assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false });
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  });
  const cwd = join(root, 'destination'); await mkdir(cwd);
  const ctx = new Context();
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); new LlmRuntime(ctx);
  let llmCalls = 0;
  class Adapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> { llmCalls++; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter() as never);
  const guardScope = ctx.plugin(GuardPlugin, { root: join(root, 'import') }); await guardScope.await();
  const logs = join(root, 'logs');
  const provider = ctx.plugin(Provider, { root: logs, compression: 'none' }); await provider.await();
  const loop = ctx.plugin(AgentLoop, {}); await loop.await();
  cleanup.push(() => guardScope.dispose(), () => provider.dispose(), () => loop.dispose());
  const guard = ctx.cloudImportReadinessV1;
  const sid = SessionId(`import-${randomUUID()}`);
  const header = sessionHeader({ id: sid, cwd, delegationDepth: 0 }) as SessionHeader;
  const operationId = randomUUID();
  const record: ImportReservation = {
    version: 1, operationId, requestHash: 'a'.repeat(64), target: { scope: 'fixture-account', sessionId: sid, generation: 1, headerHash: headerHash(sessionHeader({ id: sid }), 0), inheritedEventCount: 0, eventCount: 1, chainHash: 'b'.repeat(64) },
    intentId: randomUUID(), intentRevision: 0, revision: 0, mode: 'local', finalCwd: cwd, localHeaderHash: headerHash(header, 0),
    mapping: { id: randomUUID(), revision: 'c'.repeat(64), remotePlatform: 'linux', remotePrefix: '/remote/project', localRoot: cwd }, phase: 'reserved', effects: [], createdAt: 1, updatedAt: 1,
  };
  return { root, ctx, guard, sid, header, record, logs, cleanup, get llmCalls() { return llmCalls; } };
}

test('production foundation: opaque coordinator alone creates exact target; cold proof, ready and Continue remain distinct', async t => {
  const f = await setup(t);
  const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => true });
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId); f.cleanup.push(() => claim.release());
  let record = await coordinator.reserve(claim, f.record);
  await assert.rejects(f.ctx.agents.create({ sessionId: f.sid, meta: { cwd: f.root } }), /coordinator/);
  await assert.rejects(f.ctx.agents.resume({ resumeSessionId: f.sid }), /Continue/);
  assert.equal(f.ctx.sessions.get(f.sid), undefined);
  const events = [event(0, 'session/title', { title: 'Imported', messageSeqs: [], source: { kind: 'user' } })];
  await coordinator.withWrite(claim, importFence(record), new AbortController().signal, async () => {
    const handle = await f.ctx.sessionPersistence.create(f.header);
    try { await handle.append(events as never); await handle.flush(); } finally { await handle.close(); }
  });
  await assert.rejects(f.ctx.sessionPersistence.open(f.sid, 'read'), /proven readable/);
  const artifact = { headerHash: record.localHeaderHash, inheritedEventCount: 0, prefixCount: 1, prefixHash: payloadHash(events) };
  const independent = await Provider.coldReadJsonl(Provider.Config({ root: f.logs, compression: 'none' }), f.sid);
  assert.deepEqual(independent.header, f.header); assert.deepEqual(independent.events, events);
  const proof = await coordinator.proveReadable(claim, importFence(record), artifact);
  assert.equal(await f.guard.verifyProof(JSON.parse(JSON.stringify(proof)), { operationId: record.operationId, sessionId: f.sid, intentId: record.intentId }), false);
  record = await f.guard.journal.update(claim, importFence(record), current => ({ ...current, phase: 'initial-readable', artifact, revision: current.revision + 1, updatedAt: 2 }));
  const read = await f.ctx.sessionPersistence.open(f.sid, 'read');
  assert.equal(read.header.cwd, f.header.cwd); assert.deepEqual((await read.read(0)).events, events); await read.close();
  record = await f.guard.journal.update(claim, importFence(record), current => ({ ...current, phase: 'ready', binding: { workspaceId: 'fixture-workspace' }, revision: current.revision + 1, updatedAt: 3 }));
  await assert.rejects(f.ctx.agents.resume({ resumeSessionId: f.sid }), /Continue/);
  const readyFence = importFence(record);
  record = await coordinator.grantContinue(claim, readyFence, proof);
  assert.deepEqual(await coordinator.grantContinue(claim, readyFence, proof), record, 'duplicate activated Continue does not replace the grant ID/revision');
  const resumed = await f.ctx.agents.resume({ resumeSessionId: f.sid, agentOptions: { provider: 'fixture', model: 'fixture' } });
  assert.equal(resumed.agent.session.header.cwd, f.header.cwd); assert.equal(f.llmCalls, 0);
  await resumed.dispose(); coordinator.unregister(); await claim.release();
  await f.ctx.fiber.dispose();
  // A persisted Continue receipt survives, but this fresh mandatory guard has no
  // process-local activation. Read-only Open must not reactivate a restored inbox.
  const fresh = new Context();
  await fresh.plugin(GuardPlugin, { root: join(f.root, 'import') });
  await fresh.plugin(Provider, { root: f.logs, compression: 'none' });
  f.cleanup.push(() => fresh.fiber.dispose());
  const freshCoordinator = fresh.cloudImportReadinessV1.registerCoordinator({ version: 1, ready: () => true });
  const reopened = await fresh.sessionPersistence.open(f.sid, 'read'); await reopened.close();
  await assert.rejects(fresh.sessionPersistence.open(f.sid, 'write'), /Continue/);
  assert.equal(await fresh.cloudImportReadinessV1.verifyProof(proof, { operationId: record.operationId, sessionId: f.sid, intentId: record.intentId }), false);
  const freshClaim = await fresh.cloudImportReadinessV1.claims.acquire(f.sid, record.operationId); f.cleanup.push(() => freshClaim.release());
  const freshProof = await freshCoordinator.proveReadable(freshClaim, importFence(record), artifact);
  const activated = await freshCoordinator.grantContinue(freshClaim, importFence(record), freshProof);
  assert.notEqual(activated.continueReceipt?.grantId, record.continueReceipt?.grantId);
  const writer = await fresh.sessionPersistence.open(f.sid, 'write'); await writer.close(); freshCoordinator.unregister();
});

test('production journal: concurrent latest-intent fencing, immutable identities, retained cancellation/effects, strict reads', async t => {
  const f = await setup(t); const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => true });
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId); f.cleanup.push(() => claim.release());
  let record = await coordinator.reserve(claim, f.record);
  const fence = importFence(record);
  const changes = await Promise.allSettled([1, 2].map(() => f.guard.journal.update(claim, fence, current => ({ ...current, phase: 'destination-prepared', revision: current.revision + 1, updatedAt: 2 }))));
  assert.equal(changes.filter(change => change.status === 'fulfilled').length, 1);
  record = (await f.guard.journal.read(f.sid))!;
  await assert.rejects(f.guard.journal.update(claim, importFence(record), current => ({ ...current, finalCwd: f.root, revision: current.revision + 1 })), /immutable/);
  record = await f.guard.journal.update(claim, importFence(record), current => ({ ...current, revision: current.revision + 1, effects: [{ kind: 'destination', receiptHash: 'd'.repeat(64), at: 2 }] }));
  const old = importFence(record);
  record = await f.guard.journal.cancel(claim, old, { intentId: randomUUID(), intentRevision: 1 }, 4);
  assert.equal(record.effects.length, 1); assert.equal(record.phase, 'cancelled');
  await assert.rejects(f.guard.journal.update(claim, old, current => ({ ...current, phase: 'ready', revision: current.revision + 1 })), /intent revision/);
  await assert.rejects(f.guard.journal.update(claim, importFence(record), current => ({ ...current, phase: 'reserved', revision: current.revision + 1 })), /cancelled/);
  const forged = { ...record, surprise: true };
  const { sidKey } = await import('../src/import/claims.js');
  await writeFile(join(f.guard.journal.root, `${sidKey(f.sid)}.json`), JSON.stringify(forged));
  await assert.rejects(f.guard.journal.read(f.sid), /unsupported or unreadable/);
  coordinator.unregister();
});

test('production scoped writer cannot materialize after a newer cancellation', async t => {
  const f = await setup(t); const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => true });
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId); f.cleanup.push(() => claim.release());
  const record = await coordinator.reserve(claim, f.record);
  await assert.rejects(coordinator.withWrite(claim, importFence(record), new AbortController().signal, async () => {
    const handle = await f.ctx.sessionPersistence.create(f.header);
    await f.guard.journal.cancel(claim, importFence(record), { intentId: randomUUID(), intentRevision: 1 }, 3);
    try { await assert.rejects(handle.append([event(0)] as never), /authority changed/); }
    finally { await handle.close(); }
  }), /authority changed/);
  await assert.rejects(Provider.coldReadJsonl(Provider.Config({ root: f.logs, compression: 'none' }), f.sid), /not found/);
  assert.equal((await f.guard.journal.read(f.sid))?.phase, 'cancelled');
  coordinator.unregister();
});

test('production provider blocks actual legacy cold pull and repair without coordinator access or global native artifact', async t => {
  const f = await setup(t); const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => true });
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId); f.cleanup.push(() => claim.release());
  await coordinator.reserve(claim, f.record);
  const local = await openLocal(join(f.root, 'legacy-domain')); f.cleanup.push(() => local.close());
  const header = sessionHeader({ id: f.sid, delegationDepth: 0 });
  const events = [event(0, 'working-directory/change', { cwd: '/remote/project' })];
  const binding = headerHash(header, 0); const genesis = genesisHash(f.sid, 1, binding); const chain = chainEvents(genesis, events);
  const row = batchRow(f.sid, 1, 0, { ...chain });
  const manifest = { entity: cloudSession({ sessionId: f.sid, headerJson: JSON.stringify(header), headerHash: binding, headHash: chain.headHash, chainHash: chain.chainHash, eventCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1, lastBatchBlobName: row.blobName }), etag: 'fixture' };
  const mapping = pathMapping({ localPrefix: f.root }); // Intentionally NOT the reserved final cwd.
  const importer = new Importer(withHistory({ config: Config({}), persistence: f.ctx.sessionPersistence, local: local.local,
    repository: { getManifest: async () => manifest, listBatchRows: async () => [row], readCandidate: async () => gzipSync(payloadBytes(events)) } as never,
    cwdBinding: async () => ({ mapping, fs: nodeCwdFs }), now: Date.now }));
  await assert.rejects(importer.import(f.sid), /destination import coordinator/);
  assert.equal(local.local.getSession(f.sid)?.importState, 'failed', 'negative evidence: legacy early metadata still exists, but cannot authorize native creation');
  assert.deepEqual(await new ImportRecovery(importer, local.local).repairAll(), { repaired: [], failed: [f.sid] });
  await assert.rejects(Provider.coldReadJsonl(Provider.Config({ root: f.logs, compression: 'none' }), f.sid), /not found/);
  assert.equal(f.ctx.agents.get(f.sid), undefined); assert.equal(f.ctx.sessions.get(f.sid), undefined);
  coordinator.unregister();
});

test('production native-create claim prevents destination reservation during deferred materialization and refuses native collision after flush', async t => {
  const f = await setup(t); const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => true });
  const handle = await f.ctx.sessionPersistence.create(f.header);
  await assert.rejects(f.guard.claims.acquire(f.sid, f.record.operationId), error => error instanceof ImportClaimError && error.code === 'BUSY');
  await handle.flush();
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId); f.cleanup.push(() => claim.release());
  await assert.rejects(coordinator.reserve(claim, f.record), /already exists/);
  assert.equal(await f.guard.journal.read(f.sid), undefined);
  await handle.close(); coordinator.unregister();
});

test('production independent admission rejects cached live Agent after coordinator/capability loss and durably requeues claimed input', async t => {
  const f = await setup(t); let available = true;
  const coordinator = f.guard.registerCoordinator({ version: 1, ready: () => available });
  const claim = await f.guard.claims.acquire(f.sid, f.record.operationId);
  let record = await coordinator.reserve(claim, f.record);
  const events = [event(0, 'session/title', { title: 'Imported', messageSeqs: [], source: { kind: 'user' } })];
  await coordinator.withWrite(claim, importFence(record), new AbortController().signal, async () => {
    const handle = await f.ctx.sessionPersistence.create(f.header);
    try { await handle.append(events as never); await handle.flush(); } finally { await handle.close(); }
  });
  const artifact = { headerHash: record.localHeaderHash, inheritedEventCount: 0, prefixCount: 1, prefixHash: payloadHash(events) };
  const independent = await Provider.coldReadJsonl(Provider.Config({ root: f.logs, compression: 'none' }), f.sid);
  assert.deepEqual(independent.header, f.header); assert.deepEqual(independent.events, events);
  const proof = await coordinator.proveReadable(claim, importFence(record), artifact);
  record = await f.guard.journal.update(claim, importFence(record), current => ({ ...current, phase: 'ready', artifact, binding: { workspaceId: 'fixture-workspace' }, revision: current.revision + 1, updatedAt: 2 }));
  await coordinator.grantContinue(claim, importFence(record), proof); await claim.release();
  const handle = await f.ctx.agents.resume({ resumeSessionId: f.sid, agentOptions: { provider: 'fixture', model: 'fixture' } });
  available = false;
  const message = createUserMessage({ content: [{ type: 'text', text: 'Do not execute without the compatible capability.' }], source: { kind: 'user' } });
  handle.agent.send(message, 'next-turn', true); await handle.agent.whenIdle();
  assert.equal(f.llmCalls, 0); assert.deepEqual(handle.agent.inbox.nextTurn.map(value => value.id), [message.id]);
  coordinator.unregister();
  const next = createUserMessage({ content: [{ type: 'text', text: 'The missing coordinator is not permission.' }], source: { kind: 'user' } });
  handle.agent.send(next, 'next-step', true); await handle.agent.whenIdle();
  assert.equal(f.llmCalls, 0);
  const cold = await Provider.coldReadJsonl(Provider.Config({ root: f.logs, compression: 'none' }), f.sid);
  const restored = f.ctx.sessionProjections.restore({}, cold.events, SessionLogOffset(0), cold.header, SessionLogOffset(0));
  assert.deepEqual(handle.agent.inbox.nextTurn, [next, message]);
  assert.deepEqual(restored.snapshot.values.inbox, { 'next-turn': [next, message], 'next-step': [] });
  // Inspect before ordinary Native disposal clears queues; no further model call was admitted.
  await handle.dispose();
});

for (const mode of ['healthy', 'missing-provider', 'unsupported-journal'] as const) {
  test(`production profile overlay keeps base JSONL disabled and native fallback fenced: ${mode}`, async t => {
    const f = await setup(t); await f.ctx.fiber.dispose();
    const config = join(f.root, 'cordis.json'); const patch = join(f.root, 'persistent-user.patch.json');
    await writeFile(config, JSON.stringify([
      { id: 'session-persistence-jsonl', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: f.logs, compression: 'none' } },
      { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') },
      { id: 'agent-loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } },
    ]));
    await writeFile(patch, JSON.stringify([
      { id: 'session-persistence-jsonl', disabled: true },
      { id: 'session', inject: ['sessionPersistence', GuardPlugin.CLOUD_IMPORT_READINESS] },
      { id: 'agent-loop', inject: ['sessionPersistence', GuardPlugin.CLOUD_IMPORT_READINESS] },
      { insert: [
        { id: 'mandatory-import-guard', name: 'cordis:production-guard', config: { root: join(f.root, 'import') } },
        { id: 'mandatory-import-provider', name: mode === 'missing-provider' ? './missing-import-persistence-export.mjs' : 'cordis:production-provider', config: { root: f.logs, compression: 'none' } },
      ] },
    ]));
    if (mode === 'unsupported-journal') await writeFile(join(f.root, 'import', 'journal', 'format.json'), JSON.stringify({ version: 2, protocol: 'destination-import-journal' }));
    const prepare = (ctx: Context) => {
      new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx); new LlmRuntime(ctx);
      ctx.loader.builtins['production-guard'] = GuardPlugin; ctx.loader.builtins['production-provider'] = Provider;
    };
    if (mode !== 'healthy') {
      await assert.rejects(boot('foundation', config, loadOverlayPatches('foundation', patch), prepare), StartupError);
      return;
    }
    const ctx = await boot('foundation', config, loadOverlayPatches('foundation', patch), prepare); f.cleanup.push(() => ctx.fiber.dispose());
    assert.equal([...ctx.loader.entries()].find(value => value.options.id === 'session-persistence-jsonl')?.disabled, true);
    assert.equal(ctx.cloudImportReadinessV1.version, 1); assert.ok(ctx.get('sessions')); assert.ok(ctx.get('agentLoop'));
    // Remove the real independent guard: provider, SessionStore and AgentLoop must
    // unload through the persisted profile dependencies, not create in-memory SIDs.
    const row = [...ctx.loader.entries()].find(value => value.options.id === 'mandatory-import-guard'); assert.ok(row);
    await row.update({ disabled: true }); await ctx.loader.await();
    assert.equal(ctx.get('sessionPersistence'), undefined); assert.equal(ctx.get('sessions'), undefined); assert.equal(ctx.get('agentLoop'), undefined);
    await assert.rejects(ctx.agents.create({ sessionId: f.sid }), /factory/);
  });
}

test('production filesystem claim coordinates real processes and refuses crashed-owner retry without effects', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'production-claim-')));
  t.after(async () => { assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const sid = `session-${randomUUID()}`;
  const run = (op: string) => {
    const child = fork(fileURLToPath(new URL('./import-compatibility-fixture.ts', import.meta.url)), ['production-claim', root, sid, op], { execArgv: ['--import', 'tsx'], silent: true });
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    const result = new Promise<{ acquired: boolean; code?: string }>((resolve, reject) => { child.once('message', value => resolve(value as { acquired: boolean })); child.once('error', reject); });
    const exited = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`))));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited.catch(() => undefined); });
    return { result, exited };
  };
  const a = run('a'); const b = run('b');
  const values = await Promise.all([a.result, b.result]); await Promise.all([a.exited, b.exited]);
  assert.equal(values.filter(value => value.acquired).length, 1);
  const store = await SidClaimStore.open(root);
  await assert.rejects(store.acquire(sid, 'retry'), error => error instanceof ImportClaimError && error.code === 'RECOVERY_REQUIRED');
});
