import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { header, history, nativeHost, persistenceHost, prompt, wakeConfirmedPending, type CrashSpec } from './import-native-fixture.js';
import type { Journal } from './import-compatibility-fixture.js';

// I1 public-SDK bench, NOT Azure, Git provisioning, startup compatibility, HTTP,
// full-text search, browser E2E, Windows durability, or the whole I1 release gate.
async function directory(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-native-feasibility-')));
  t.after(async () => {
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    assert.ok(root.startsWith(join(await realpath(tmpdir()), 'import-native-feasibility-')));
    await rm(root, { recursive: true, force: false });
  });
  const cwd = join(root, 'project', 'subdir');
  await mkdir(join(cwd, 'nested'), { recursive: true });
  return { root, cwd: await realpath(cwd) };
}
async function snapshot(root: string, id: string, compression: 'none' | 'zstd' = 'none') {
  const host = await persistenceHost(root, compression);
  try {
    const handle = await host.persistence.open(SessionId(id), 'read');
    try { return { header: handle.header, cut: handle.inheritedEventCount, events: (await handle.read()).events }; }
    finally { await handle.close(); }
  } finally { await host.close(); }
}
function worker(t: TestContext, spec: CrashSpec) {
  const child = fork(fileURLToPath(new URL('./import-native-fixture.ts', import.meta.url)), ['--worker', JSON.stringify(spec)], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const messages: Array<Record<string, unknown>> = [];
  const listeners: Array<(value: Record<string, unknown>) => void> = [];
  child.on('message', value => { const message = value as Record<string, unknown>; messages.push(message); for (const listener of [...listeners]) listener(message); });
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  return { child, exited,
    next(phase: string): Promise<Record<string, unknown>> {
      const existing = messages.find(message => message.phase === phase); if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const receive = (message: Record<string, unknown>) => { if (message.phase !== phase) return; cleanup(); resolve(message); };
        const failure = () => { cleanup(); reject(new Error(`worker exited before ${phase}: ${stderr}`)); };
        const timeout = setTimeout(() => { cleanup(); reject(new Error(`worker timed out at ${phase}: ${stderr}`)); }, 20000);
        const cleanup = () => { clearTimeout(timeout); child.off('exit', failure); listeners.splice(listeners.indexOf(receive), 1); };
        listeners.push(receive); child.once('exit', failure);
      });
    },
    advance() { child.send({ continue: true }); },
    async kill() { child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL', stderr); },
    async finish() { child.send({ continue: true }); const [code, signal] = await exited; assert.equal(signal, null); assert.equal(code, 0, stderr); },
  };
}
async function coldProcess(t: TestContext, spec: CrashSpec, action: 'read' | 'claim' = 'read') {
  const process = worker(t, { ...spec, action });
  const result = await process.next('result');
  const [code, signal] = await process.exited; assert.equal(signal, null); assert.equal(code, 0);
  return result;
}

for (const seeded of [false, true]) test(`public same-SID ${seeded ? 'ordinary seeded fork' : 'ordinary nonblank'} import binds exact native Workspace and project without creating an Agent`, { timeout: 30000 }, async t => {
  const { root, cwd } = await directory(t), id = `cloud-${randomUUID()}`;
  const originalHeader = header(id, '/remote/project/subdir', seeded);
  const localizedHeader = { ...originalHeader, cwd };
  const original = history('/remote/project/subdir', seeded);
  let host = await nativeHost(root, cwd); t.after(() => host.close());
  const parent = await host.ctx.workspaceRegistry.create(dirname(cwd));
  const exact = await host.ctx.workspaceRegistry.create(cwd);
  const handle = await host.ctx.sessionPersistence.create(localizedHeader, { inheritedEventCount: SessionLogOffset(original.cut) });
  await handle.append(original.events); await handle.flush(); await handle.close();
  const initial = await snapshot(join(root, 'logs'), id);
  assert.deepEqual(initial, { header: localizedHeader, cut: original.cut, events: original.events });
  const suffix: SessionEvent[] = [{ seq: SessionSeq(initial.events.length), time: 3000, type: 'working-directory/change', data: { cwd: join(cwd, 'nested') } }];
  const writer = await host.ctx.sessionPersistence.open(SessionId(id), 'write');
  try { await writer.append(suffix); await writer.flush(); } finally { await writer.close(); }
  const completeEvents = [...original.events, ...suffix];
  const before = await snapshot(join(root, 'logs'), id);
  assert.deepEqual(before, { header: localizedHeader, cut: original.cut, events: completeEvents });
  const replayed = host.ctx.sessionProjections.restore({}, completeEvents, SessionLogOffset(0), localizedHeader, SessionLogOffset(original.cut));
  assert.equal(replayed.snapshot.values.workingDirectory, join(cwd, 'nested'), 'replayed current cwd differs without rehoming the immutable native Workspace account');
  assert.equal(host.ctx.agents.list().length, 0); assert.equal(host.ctx.sessions.get(SessionId(id)), undefined);
  await assert.rejects(parent.attachSession(SessionId(id)), /cwd resolves/u);
  await exact.attachSession(SessionId(id));
  await host.projectController.synchronize();
  const selected = host.projectController.folderForPath(cwd); assert.ok(selected);
  const parentSelection = host.projectController.folderForPath(dirname(cwd)); assert.ok(parentSelection);
  await assert.rejects(host.projectController.recordThread({ sessionId: id, projectId: parentSelection.projectId, folderId: parentSelection.folderId, mode: 'local', effectiveCwd: cwd }), error => error instanceof Error && 'code' in error && error.code === 'PROJECT_BINDING_MISMATCH');
  const binding = { sessionId: id, projectId: selected.projectId, folderId: selected.folderId, mode: 'local' as const, effectiveCwd: cwd };
  await host.projectController.recordThread(binding);
  assert.deepEqual(host.projectStore.bindings.get(id), binding);
  assert.deepEqual(exact.sessionIds, [id]); assert.deepEqual(parent.sessionIds, []);
  assert.deepEqual(await snapshot(join(root, 'logs'), id), before, 'required metadata binding never rewrites history/cwd/cut');
  assert.equal(host.ctx.agents.list().length, 0); assert.equal(host.llmCalls, 0);
  assert.deepEqual((await host.ctx.sessionPersistence.list()).map(value => value.header.id), [id]);
  await host.close();
  host = await nativeHost(root, cwd);
  assert.deepEqual((await host.ctx.workspaceRegistry.resolveByPath(cwd))?.sessionIds, [id]);
  assert.deepEqual(host.projectStore.bindings.get(id), binding);
  const observation = await host.query.observeSession(SessionId(id), { projectionMode: 'none' });
  try { assert.deepEqual(observation.header, localizedHeader); assert.deepEqual(observation.events, completeEvents); }
  finally { observation[Symbol.dispose](); }
  assert.equal(host.ctx.agents.list().length, 0); assert.equal(host.llmCalls, 0);
});

test('public empty unseeded flush is readable after restart; unmaterialized close and pre-cancelled first append leave no artifact', { timeout: 20000 }, async t => {
  const { root, cwd } = await directory(t), logs = join(root, 'logs');
  const host = await persistenceHost(logs); t.after(() => host.close());
  const emptyId = `empty-${randomUUID()}`;
  const empty = await host.persistence.create(header(emptyId, cwd));
  await empty.flush(); await empty.close();
  assert.deepEqual(await snapshot(logs, emptyId), { header: header(emptyId, cwd), cut: 0, events: [] });
  for (const seeded of [false, true]) {
    const id = `cancelled-${randomUUID()}`, original = history(cwd, seeded);
    const handle = await host.persistence.create(header(id, cwd, seeded), { inheritedEventCount: SessionLogOffset(original.cut) });
    await assert.rejects(handle.append(original.events, { signal: AbortSignal.abort(new Error('cancel-before-first-append')) }), /cancel-before-first-append/u);
    await handle.close();
    await assert.rejects(snapshot(logs, id), error => error instanceof SessionPersistenceNotFoundError);
  }
});

test('negative feasibility: seeded header-only materialization cannot be cold reopened; cached header/cut is not a proof', { timeout: 20000 }, async t => {
  const { root, cwd } = await directory(t), logs = join(root, 'logs'), id = `bad-seed-${randomUUID()}`;
  const host = await persistenceHost(logs); t.after(() => host.close());
  const handle = await host.persistence.create(header(id, cwd, true), { inheritedEventCount: SessionLogOffset(2) });
  await handle.flush(); assert.equal(handle.inheritedEventCount, 2); await handle.close();
  await assert.rejects(snapshot(logs, id), /seed|inherited/iu);
  // This is an isolated negative artifact, NEVER a suggested import/recovery path.
});

test('negative feasibility: splitting seed prefix before its existing marker leaves no public cold read/write recovery path', { timeout: 20000 }, async t => {
  const { root, cwd } = await directory(t), logs = join(root, 'logs'), id = `split-seed-${randomUUID()}`;
  const original = history(cwd, true);
  const host = await persistenceHost(logs);
  try {
    const handle = await host.persistence.create(header(id, cwd, true), { inheritedEventCount: SessionLogOffset(original.cut) });
    await handle.append(original.events.slice(0, original.cut)); // Deliberate unsupported first materialization, isolated negative fixture only.
    await handle.flush(); await handle.close();
  } finally { await host.close(); }
  await assert.rejects(snapshot(logs, id), /seed|inherited/iu);
  const cold = await persistenceHost(logs);
  try {
    await assert.rejects(cold.persistence.open(SessionId(id), 'write'), /seed|inherited/iu);
    await assert.rejects(cold.persistence.create(header(id, cwd, true), { inheritedEventCount: SessionLogOffset(original.cut) }));
  } finally { await cold.close(); }
  // A coordinator MUST refuse unsupported backend/capacity before any effect;
  // neither a normal write-open nor recreate may be assumed to repair this.
});

for (const seeded of [false, true]) for (const phase of ['created', 'appended', 'flushed', 'closed'] as const) {
  test(`real process crash after ${phase}: ${seeded ? 'exact original seeded prefix through marker' : 'unseeded prefix'} is absent or independently readable`, { timeout: 30000 }, async t => {
    const { root, cwd } = await directory(t), spec: CrashSpec = { root: join(root, 'logs'), cwd, id: `crash-${randomUUID()}`, seeded };
    const original = history(cwd, seeded);
    const process = worker(t, spec);
    await process.next('created');
    for (const next of ['appended', 'flushed', 'closed']) { if (next === phase || phase !== 'created') { process.advance(); await process.next(next); if (next === phase) break; } else break; }
    if (phase !== 'created') {
      const reader = await coldProcess(t, spec);
      assert.equal(reader.error, undefined); assert.deepEqual(reader.header, header(spec.id, cwd, seeded));
      assert.equal(reader.cut, original.cut); assert.deepEqual(reader.events, original.events);
      if (phase !== 'closed') {
        const claimant = await coldProcess(t, spec, 'claim');
        assert.equal((claimant.error as { name?: string } | undefined)?.name, 'SessionAlreadyOwnedError');
      }
    }
    await process.kill();
    const cold = await coldProcess(t, spec);
    if (phase === 'created') {
      assert.equal((cold.error as { name?: string }).name, 'SessionPersistenceNotFoundError');
      const recovery = await persistenceHost(spec.root);
      try { const handle = await recovery.persistence.create(header(spec.id, cwd, seeded), { inheritedEventCount: SessionLogOffset(original.cut) }); await handle.append(original.events); await handle.flush(); await handle.close(); }
      finally { await recovery.close(); }
    } else {
      assert.equal(cold.error, undefined); assert.deepEqual(cold.header, header(spec.id, cwd, seeded));
      assert.equal(cold.cut, original.cut); assert.deepEqual(cold.events, original.events);
    }
    const recovered = await coldProcess(t, spec, 'claim');
    assert.equal(recovered.error, undefined); assert.equal(recovered.cut, original.cut); assert.deepEqual(recovered.events, original.events);
    if (seeded) {
      const marker = original.events[original.cut]!;
      assert.equal(marker.type, 'session/end-seed'); assert.deepEqual((recovered.events as SessionEvent[])[original.cut], marker);
    }
  });
}

for (const compression of ['none', 'zstd'] as const) test(`POSIX real in-flight first-materialization SIGKILL (${compression}) preserves all-or-absent seeded prefix at bounded capacity`, { timeout: 45000, skip: process.platform === 'win32' }, async t => {
  const { root, cwd } = await directory(t);
  const spec: CrashSpec = { root: join(root, 'logs'), cwd, id: `in-flight-${randomUUID()}`, seeded: true, count: 128, textBytes: 65536, compression };
  const original = history(cwd, true, spec.count, spec.textBytes);
  assert.equal(original.events.length, original.cut + 1);
  assert.equal(original.events[original.cut]?.type, 'session/end-seed');
  const process = worker(t, spec); await process.next('created');
  let killedAtTemp = false;
  const watcher = watch(spec.root, { recursive: true }, (_event, filename) => {
    if (filename?.endsWith('.tmp') && !killedAtTemp) { killedAtTemp = true; process.child.kill('SIGKILL'); }
  });
  try { process.advance(); await process.exited; } finally { watcher.close(); }
  assert.equal(killedAtTemp, true, 'SIGKILL is triggered by actual native temp materialization, not a fake append callback');
  assert.equal(process.child.signalCode, 'SIGKILL');
  const cold = await snapshot(spec.root, spec.id, compression).catch(error => {
    if (error instanceof SessionPersistenceNotFoundError) return undefined;
    throw error;
  });
  if (cold !== undefined) assert.deepEqual(cold, { header: header(spec.id, cwd, true), cut: original.cut, events: original.events });
  else {
    const recovery = await persistenceHost(spec.root, compression);
    try { const handle = await recovery.persistence.create(header(spec.id, cwd, true), { inheritedEventCount: SessionLogOffset(original.cut) }); await handle.append(original.events); await handle.flush(); await handle.close(); }
    finally { await recovery.close(); }
  }
  assert.deepEqual(await snapshot(spec.root, spec.id, compression), { header: header(spec.id, cwd, true), cut: original.cut, events: original.events });
  t.diagnostic(`Proved first append of ${original.events.length} original events (${Buffer.byteLength(JSON.stringify(original.events))} JSON bytes); no unbounded capacity or Windows claim.`);
});

test('actual native cold Open stays readable while write-promotion/prompt/queue/pre-step are held across restart until explicit Continue', { timeout: 45000 }, async t => {
  const { root, cwd } = await directory(t), id = `held-${randomUUID()}`, journal = join(root, 'destination-journal.json');
  const operationId = randomUUID();
  const setContinued = (continued: boolean) => writeFile(journal, JSON.stringify({ version: 1, reservations: [
    { sessionId: id, operationId, finalCwd: cwd, phase: 'ready', continued },
  ] } satisfies Journal));
  // Reservation is durable BEFORE original-SID materialization. The coordinator
  // owns the underlying public provider; native callers only receive its guarded
  // SessionPersistence composition. No target Agent exists during import/Open.
  await setContinued(false);
  const original = history(cwd);
  const queued = prompt('Restored queued input; do not consume on Open.'), later = prompt('Later queued input preserves its order.'), steering = prompt('Restored steering; do not consume on Open.');
  const events = [...original.events,
    { seq: SessionSeq(original.events.length), time: 2000, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [queued, later] } },
    { seq: SessionSeq(original.events.length + 1), time: 2001, type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [steering] } },
  ] as SessionEvent[];
  const base = await persistenceHost(join(root, 'logs'));
  try { const handle = await base.persistence.create(header(id, cwd)); await handle.append(events); await handle.flush(); await handle.close(); }
  finally { await base.close(); }
  const imported = await snapshot(join(root, 'logs'), id);
  let host = await nativeHost(root, cwd, { journal }); t.after(() => host.close());
  for (let round = 0; round < 2; round++) {
    const signal = new AbortController();
    let report!: (message: string) => void;
    const blockedPromotion = new Promise<string>(resolve => { report = resolve; });
    const unlisten = host.ctx.on('api-session/error', (sessionId, message) => { if (sessionId === id) report(message); });
    const stream = host.controller.follow({ address: { kind: 'session', sessionId: SessionId(id) } }, signal.signal)[Symbol.asyncIterator]();
    const first = await stream.next();
    assert.equal(first.done, false); assert.equal(first.value?.type, 'snapshot');
    if (first.value?.type === 'snapshot') {
      assert.equal(first.value.header.id, id);
      assert.deepEqual(first.value.projections.values.inbox, { 'next-turn': [queued, later], 'next-step': [steering] });
    }
    // Actual native follow yields history first, then attempts write promotion.
    const following = stream.next();
    assert.match(await blockedPromotion, /DESTINATION_RESERVED/u);
    for (const mode of ['queue', 'steer'] as const) await assert.rejects(host.controller.prompt({
      sessionId: SessionId(id), requestId: randomUUID() as never, mode,
      content: [{ type: 'text', text: 'Native prompt cannot bypass Open hold.' }],
    }, signal.signal));
    for (const action of [{ kind: 'remove' as const }, { kind: 'edit' as const, content: [{ type: 'text' as const, text: 'Must not edit while held.' }] }, { kind: 'steer' as const }]) {
      await assert.rejects(host.controller.updateQueue({ sessionId: SessionId(id), itemId: queued.id, action }));
    }
    await assert.rejects(host.ctx.agents.resume({ resumeSessionId: SessionId(id) }), /DESTINATION_RESERVED/u);
    await assert.rejects(host.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } }), /DESTINATION_RESERVED/u);
    assert.equal(host.ctx.agents.get(SessionId(id)), undefined, 'no Agent exists to expose a direct send/pre-step bypass');
    assert.equal(host.ctx.sessions.get(SessionId(id)), undefined);
    assert.equal(host.llmCalls, 0); assert.equal(host.preSteps, 0);
    assert.deepEqual(await snapshot(join(root, 'logs'), id), imported, 'history Open and rejected native ingress leave persisted pending input and ALL bytes semantically unchanged');
    const page = await host.controller.page({ address: { kind: 'session', sessionId: SessionId(id) }, throughSeq: events.length - 1 }, signal.signal);
    assert.ok(page.records.length > 0, 'read-only history remains usable after actual background promotion refusal');
    signal.abort(); await following; await stream.return?.(); unlisten();
    if (round === 0) { await host.close(); host = await nativeHost(root, cwd, { journal }); }
  }
  // Production must first confirm pending input + local readiness + fresh cloud
  // ownership/catch-up. This bench intentionally has no Azure lease authority.
  await setContinued(true);
  const resolved = await host.controller.resolveAgent(SessionId(id));
  assert.ok('agent' in resolved); if (!('agent' in resolved)) return;
  const agent = resolved.agent;
  assert.deepEqual(agent.inbox.nextTurn, [queued, later]); assert.deepEqual(agent.inbox.nextStep, [steering]);
  assert.equal(host.llmCalls, 0); assert.equal(host.preSteps, 0, 'resume alone does not wake persisted pending input');
  await wakeConfirmedPending(agent, () => host.ctx.sessionPersistence.flush());
  await agent.whenIdle();
  assert.ok(host.preSteps > 0); assert.ok(host.llmCalls > 0);
  assert.deepEqual(agent.inbox.nextTurn, []); assert.deepEqual(agent.inbox.nextStep, []);
  const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id);
  for (const message of [queued, later, steering]) assert.equal(admitted.filter(id => id === message.id).length, 1, 'Continue consumes each original pending identity once, without a synthetic/duplicate prompt');
  assert.ok(admitted.indexOf(queued.id) < admitted.indexOf(later.id));
});
