import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { DestinationAdmissionError, type CoordinatorRegistration } from '../src/import/guard.js';
import { coldReadJsonl, Config as PersistenceConfig } from '../src/import/persistence.js';
import { importFence, type ImportReservation } from '../src/import/journal.js';
import { headerHash } from '../src/sync/chain.js';
import { payloadHash } from '../src/sync/canonical.js';
import { header, history, nativeHost, prompt, route, wakeConfirmedPending, type NativeHost } from './import-native-fixture.js';

// Production independent guard + isolated production JSONL provider + actual
// public Controller/AgentRegistry/AgentLoop, not the earlier prototype provider.
// No Azure/Git network, HTTP authentication, browser, deployment or Windows proof.
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-cwd-production-')));
  const ordinary = join(root, 'ordinary'); await mkdir(ordinary);
  const guardRoot = join(root, 'admission'), hostRoot = join(root, 'host'), logs = join(hostRoot, 'logs');
  let host = await nativeHost(hostRoot, ordinary, { guardRoot });
  const claims: Array<{ release(): Promise<void> }> = [];
  const beforeClose: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of beforeClose.reverse()) await close();
    await host.close(); for (const claim of claims.reverse()) await claim.release();
    assert.equal(dirname(root), await realpath(tmpdir())); assert.equal(await realpath(root), root);
    assert.ok(root.startsWith(join(await realpath(tmpdir()), 'import-cwd-production-')));
    await rm(root, { recursive: true, force: false });
  });
  const current = () => host;
  const config = PersistenceConfig({ root: logs, compression: 'none' });
  const cold = (id: string) => coldReadJsonl(config, id);
  async function restart() { await host.close(); host = await nativeHost(hostRoot, ordinary, { guardRoot }); return host; }
  function reservation(mode: 'local' | 'worktree' = 'worktree'): ImportReservation {
    const id = `cloud-${randomUUID()}`, checkoutRoot = join(root, `checkout-${randomUUID()}`), cwd = mode === 'local' ? ordinary : join(checkoutRoot, 'project');
    const targetHeader = header(id, cwd), originalHeader = header(id, '/remote/repo/project');
    return { version: 1, operationId: randomUUID(), requestHash: 'a'.repeat(64), target: { scope: 'fixture-account', sessionId: id, generation: 1, headerHash: headerHash(originalHeader, 0 as never), inheritedEventCount: 0, eventCount: 2, chainHash: 'b'.repeat(64) }, intentId: randomUUID(), intentRevision: 0, revision: 0, mode,
      finalCwd: cwd, localHeaderHash: headerHash(targetHeader, 0 as never), mapping: { id: randomUUID(), revision: 'c'.repeat(64), remotePlatform: 'linux', remotePrefix: '/remote/repo', localRoot: mode === 'local' ? dirname(ordinary) : checkoutRoot }, phase: 'reserved', effects: [], createdAt: 1, updatedAt: 1 };
  }
  async function claim(record: ImportReservation) { const value = await host.ctx.cloudImportReadinessV1.claims.acquire(record.target.sessionId, record.operationId); claims.push(value); return value; }
  function coordinator() { return host.ctx.cloudImportReadinessV1.registerCoordinator({ version: 1, ready: () => true }); }
  return { root, ordinary, logs, config, guardRoot, hostRoot, beforeClose, current, restart, cold, reservation, claim, coordinator };
}
const denied = (error: unknown) => error instanceof DestinationAdmissionError && error.code === 'RESERVED';
async function noArtifact(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  assert.equal(f.current().ctx.agents.get(SessionId(id)), undefined);
  assert.equal(f.current().ctx.sessions.get(SessionId(id)), undefined);
  await assert.rejects(f.cold(id), error => error instanceof SessionPersistenceNotFoundError);
}

for (const stopped of [false, true]) test(`production pending-cwd veto: other SID under whole checkout is denied before setup/artifact (${stopped ? 'stopped' : 'pending'})`, { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation();
  const claim = await f.claim(record); let reserved = await coordinator.reserve(claim, record);
  if (stopped) reserved = await host.ctx.cloudImportReadinessV1.journal.cancel(claim, importFence(reserved), { intentId: randomUUID(), intentRevision: 1 });
  await mkdir(reserved.finalCwd, { recursive: true }); await mkdir(join(reserved.mapping.localRoot, 'sibling'));
  for (const cwd of [reserved.mapping.localRoot, reserved.finalCwd, join(reserved.mapping.localRoot, 'sibling')]) {
    const id = `other-${randomUUID()}`;
    await assert.rejects(host.ctx.sessionPersistence.create(header(id, cwd)), denied);
    let setup = 0;
    await assert.rejects(host.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: route, setup: (_ctx, agent) => { setup++; agent.session.append('session/title', { title: 'Must not materialize', messageSeqs: [], source: { kind: 'user' } }); } }), denied);
    assert.equal(setup, 0, 'native factory fails at public persistence admission, before any preset/setup can materialize history');
    await assert.rejects(host.controller.create({ sessionId: SessionId(id), cwd }));
    await noArtifact(f, id);
  }
  if (process.platform !== 'win32') {
    const alias = join(f.root, 'alias'); await symlink(record.mapping.localRoot, alias);
    const id = `alias-${randomUUID()}`; await assert.rejects(host.ctx.sessionPersistence.create(header(id, join(alias, 'project'))), denied); await noArtifact(f, id);
  }
  assert.equal(host.llmCalls, 0); assert.equal(host.preSteps, 0); coordinator.unregister();
});

test('production pending-cwd veto covers future checkout before Git and exact target only through its scoped coordinator', { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation();
  const claim = await f.claim(record); const reserved = await coordinator.reserve(claim, record);
  const id = `future-other-${randomUUID()}`;
  await assert.rejects(host.ctx.sessionPersistence.create(header(id, record.finalCwd)), denied); await noArtifact(f, id);
  await assert.rejects(host.ctx.sessionPersistence.create(header(record.target.sessionId, record.finalCwd)), denied);
  const foreign = `scoped-other-${randomUUID()}`;
  await assert.rejects(coordinator.withWrite(claim, importFence(reserved), new AbortController().signal, async () => {
    const handle = await host.ctx.sessionPersistence.create(header(foreign, record.finalCwd)); await handle.close();
  }), denied);
  await noArtifact(f, foreign);
  await mkdir(record.finalCwd, { recursive: true });
  const events = history(record.finalCwd).events;
  await coordinator.withWrite(claim, importFence(reserved), new AbortController().signal, async () => {
    const handle = await host.ctx.sessionPersistence.create(header(record.target.sessionId, record.finalCwd));
    try { await handle.append(events); await handle.flush(); } finally { await handle.close(); }
  });
  assert.deepEqual((await f.cold(record.target.sessionId)).events, events);
  assert.equal(host.ctx.agents.get(SessionId(record.target.sessionId)), undefined); assert.equal(host.llmCalls, 0); coordinator.unregister();
});

test('production Local-mode reservation preserves ordinary shared-folder native creation', { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation('local');
  const claim = await f.claim(record); await coordinator.reserve(claim, record);
  const id = `shared-${randomUUID()}`;
  const agent = await host.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: f.ordinary }, agentOptions: route });
  try {
    assert.equal(agent.agent.session.header.cwd, f.ordinary);
    assert.equal((await f.cold(id)).events.length, 0, 'blank ordinary Agent checkpoints without a first message');
    const second = await host.controller.create({ cwd: f.ordinary });
    assert.notEqual(second.sessionId, record.target.sessionId); assert.notEqual(second.sessionId, id);
    assert.equal((await f.cold(second.sessionId)).header.cwd, f.ordinary);
    assert.equal(host.llmCalls, 0);
  } finally { await agent.dispose(); coordinator.unregister(); }
});

test('production create/reserve race: deferred other-SID writer wins mutex; reservation cannot commit before its physical boundary', { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation();
  const id = `deferred-${randomUUID()}`, handle = await host.ctx.sessionPersistence.create(header(id, record.finalCwd));
  try {
    const claim = await f.claim(record);
    await assert.rejects(coordinator.reserve(claim, record), /cwd admission|owns cwd|busy|Native create/iu);
    assert.equal(await host.ctx.cloudImportReadinessV1.journal.read(record.target.sessionId), undefined, 'no Git/effect reservation was committed behind the deferred owner');
    await assert.rejects(f.cold(id), error => error instanceof SessionPersistenceNotFoundError);
    await handle.flush();
    assert.deepEqual((await f.cold(id)).events, []);
    await assert.rejects(coordinator.reserve(claim, record), /already accounts|Another native SID/iu);
    assert.equal(await host.ctx.cloudImportReadinessV1.journal.read(record.target.sessionId), undefined);
  } finally { await handle.close(); coordinator.unregister(); }
});

test('production published blank native owner releases mutex without model/input; occupied checkout still refuses import', { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation(); await mkdir(record.finalCwd, { recursive: true });
  const owner = await host.ctx.agents.create({ sessionId: SessionId(`owner-${randomUUID()}`), meta: { cwd: record.finalCwd }, agentOptions: route });
  try {
    assert.deepEqual((await f.cold(owner.agent.id)).events, []);
    const claim = await f.claim(record); await assert.rejects(coordinator.reserve(claim, record), /already accounts|Another native SID/iu);
    const unrelated = f.reservation(); const nextClaim = await f.claim(unrelated); await coordinator.reserve(nextClaim, unrelated);
    assert.equal(host.llmCalls, 0, 'ordinary blank publication neither sends a message nor holds the profile mutex indefinitely');
  } finally { await owner.dispose(); coordinator.unregister(); }
});

test('production step gate covers replayed current cwd as well as immutable native header cwd', { timeout: 30000 }, async t => {
  const f = await fixture(t), host = f.current(), coordinator = f.coordinator(), record = f.reservation();
  const owner = await host.ctx.agents.create({ sessionId: SessionId(`local-${randomUUID()}`), meta: { cwd: f.ordinary }, agentOptions: route });
  try {
    const claim = await f.claim(record); await coordinator.reserve(claim, record); await mkdir(record.finalCwd, { recursive: true });
    await host.ctx.workingDirectory.set(owner.agent, record.finalCwd);
    assert.equal(owner.agent.session.header.cwd, f.ordinary, 'cwd replay does not rehome native membership');
    assert.equal(host.ctx.workingDirectory.get(owner.agent.session), record.finalCwd);
    const message = prompt('Do not run tools/model in another pending checkout.');
    owner.agent.send(message, 'next-turn', true); await owner.agent.whenIdle();
    assert.equal(host.llmCalls, 0);
    assert.ok(owner.agent.inbox.nextTurn.some(value => value.id === message.id), 'native pre-step rejection durably preserves the claimed prompt');
    const raw = await f.cold(owner.agent.id);
    assert.equal(raw.events.some(event => event.type === 'step/start'), false);
  } finally { await owner.dispose(); coordinator.unregister(); }
});

test('production CWD kernel mutex excludes a second Host and process death releases only the lock, not journal authority', { timeout: 30000 }, async t => {
  const f = await fixture(t), record = f.reservation(), coordinator = f.coordinator(), id = `child-${randomUUID()}`;
  const child = fork(fileURLToPath(new URL('./import-native-fixture.ts', import.meta.url)), ['--cwd-writer', JSON.stringify({ hostRoot: f.hostRoot, guardRoot: f.guardRoot, ordinary: f.ordinary, cwd: record.finalCwd, id })], { execArgv: ['--import', 'tsx'], silent: true });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const exited = once(child, 'exit');
  f.beforeClose.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const message = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`child exited before holding CWD mutex: ${stderr}`); })]);
  assert.deepEqual(message[0], { phase: 'cwd-held' });
  const claim = await f.claim(record);
  await assert.rejects(coordinator.reserve(claim, record), /cwd admission|owns cwd|busy|Native create/iu);
  assert.equal(await f.current().ctx.cloudImportReadinessV1.journal.read(record.target.sessionId), undefined);
  child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL', stderr);
  await assert.rejects(f.cold(id), error => error instanceof SessionPersistenceNotFoundError);
  const accepted = await coordinator.reserve(claim, record);
  assert.equal(accepted.target.sessionId, record.target.sessionId);
  assert.equal(accepted.phase, 'reserved', 'OS lock release is not Ready, native materialization, or execution consent');
  coordinator.unregister();
});

async function materializeHeld(f: Awaited<ReturnType<typeof fixture>>, coordinator: CoordinatorRegistration, record: ImportReservation) {
  const host = f.current(), claim = await f.claim(record); let current = await coordinator.reserve(claim, record);
  const original = history(record.finalCwd).events, queued = prompt('Original pending input, held across Open and restart.'), steering = prompt('Original pending steering.');
  const events: SessionEvent[] = [...original,
    { type: 'agent/inbox/spliced', seq: SessionSeq(original.length), time: 2000, data: { target: 'next-turn', start: 0, inserted: [queued] } },
    { type: 'agent/inbox/spliced', seq: SessionSeq(original.length + 1), time: 2001, data: { target: 'next-step', start: 0, inserted: [steering] } },
  ];
  // This helper binds the actual reviewed event count before any reservation.
  assert.equal(record.target.eventCount, events.length);
  await coordinator.withWrite(claim, importFence(current), new AbortController().signal, async () => {
    const handle = await host.ctx.sessionPersistence.create(header(record.target.sessionId, record.finalCwd));
    try { await handle.append(events); await handle.flush(); } finally { await handle.close(); }
  });
  const artifact = { headerHash: current.localHeaderHash, inheritedEventCount: 0, prefixCount: events.length, prefixHash: payloadHash(events) };
  current = await host.ctx.cloudImportReadinessV1.journal.update(claim, importFence(current), value => ({ ...value, phase: 'history-verified', artifact, revision: value.revision + 1, updatedAt: 2 }));
  return { claim, record: current, artifact, events, queued, steering };
}
async function openHeld(host: NativeHost, id: string) {
  const signal = new AbortController();
  let report!: (value: string) => void; const rejected = new Promise<string>(done => { report = done; });
  const stop = host.ctx.on('api-session/error', (sid, error) => { if (sid === id) report(error); });
  const stream = host.controller.follow({ address: { kind: 'session', sessionId: SessionId(id) } }, signal.signal)[Symbol.asyncIterator]();
  const first = await stream.next(); assert.equal(first.value?.type, 'snapshot');
  const following = stream.next(); await rejected;
  assert.equal(host.ctx.agents.get(SessionId(id)), undefined); assert.equal(host.llmCalls, 0); assert.equal(host.preSteps, 0);
  return { first: first.value, async close() { signal.abort(); await following; await stream.return?.(); stop(); } };
}

test('production provider no-promote Open preserves exact original inbox across restart and explicit Continue consumes each once', { timeout: 45000 }, async t => {
  const f = await fixture(t); let coordinator = f.coordinator();
  const base = f.reservation('local'), record: ImportReservation = { ...base, target: { ...base.target, eventCount: 4 } };
  let materialized = await materializeHeld(f, coordinator, record);
  const before = await f.cold(record.target.sessionId);
  for (let round = 0; round < 2; round++) {
    const host = f.current(), opened = await openHeld(host, record.target.sessionId);
    if (opened.first?.type === 'snapshot') assert.deepEqual(opened.first.projections.values.inbox, { 'next-turn': [materialized.queued], 'next-step': [materialized.steering] });
    await assert.rejects(host.controller.prompt({ sessionId: SessionId(record.target.sessionId), requestId: randomUUID() as never, mode: 'queue', content: [{ type: 'text', text: 'Must remain a client draft until Continue.' }] }, new AbortController().signal));
    await assert.rejects(host.controller.updateQueue({ sessionId: SessionId(record.target.sessionId), itemId: materialized.queued.id, action: { kind: 'remove' } }));
    assert.deepEqual(await f.cold(record.target.sessionId), before);
    assert.equal((await host.ctx.sessionPersistence.list()).some(value => value.header.id === record.target.sessionId), false, 'pending import is not published to Native workspace discovery');
    await opened.close();
    if (round === 0) {
      coordinator.unregister(); await materialized.claim.release(); await f.restart(); coordinator = f.coordinator();
      const claim = await f.claim(record); materialized = { ...materialized, claim };
    }
  }
  const host = f.current(), guard = host.ctx.cloudImportReadinessV1;
  const latest = (await guard.journal.read(record.target.sessionId))!;
  const workspace = await coordinator.withWrite(materialized.claim, importFence(latest), new AbortController().signal, async () => {
    const value = await host.ctx.workspaceRegistry.create(record.finalCwd);
    await value.attachSession(SessionId(record.target.sessionId)); return value;
  });
  const ready = await guard.journal.update(materialized.claim, importFence(latest), value => ({ ...value, phase: 'ready', binding: { workspaceId: workspace.id }, revision: value.revision + 1, updatedAt: 3 }));
  const proof = await coordinator.proveReadable(materialized.claim, importFence(ready), materialized.artifact);
  await coordinator.grantContinue(materialized.claim, importFence(ready), proof);
  const resolved = await host.controller.resolveAgent(SessionId(record.target.sessionId)); assert.ok('agent' in resolved); if (!('agent' in resolved)) return;
  assert.deepEqual(resolved.agent.inbox.nextTurn, [materialized.queued]); assert.deepEqual(resolved.agent.inbox.nextStep, [materialized.steering]);
  await wakeConfirmedPending(resolved.agent, () => host.ctx.sessions.flush(resolved.agent.session).then(() => undefined)); await resolved.agent.whenIdle();
  assert.ok(host.llmCalls > 0);
  const delivered = resolved.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id);
  for (const message of [materialized.queued, materialized.steering]) assert.equal(delivered.filter(id => id === message.id).length, 1);
  coordinator.unregister();
});
