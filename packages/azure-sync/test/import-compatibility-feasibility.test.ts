import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { Loader } from '@deepseek-ai/cordis-plugin-loader';
import { auditStartupEntries, boot, loadOverlayPatches, mountRootInclude, StartupError } from '@deepseek-ai/dsh-app-boot';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { Config } from '../src/config.js';
import { Importer } from '../src/sync/importer.js';
import { ImportRecovery } from '../src/sync/recovery.js';
import { chainEvents, genesisHash, headerHash } from '../src/sync/chain.js';
import { payloadBytes } from '../src/sync/canonical.js';
import { nodeCwdFs } from '../src/sync/effective-cwd.js';
import { batchRow, cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';
import { CompositePlugin, COORDINATOR, exclusiveClaim, GuardPlugin, GUARD, openLocal, type FixtureCoordinator, type Journal } from './import-compatibility-fixture.js';

/** These tests are implementation feasibility prototypes, not completed destination support. */
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'import-compatibility-')));
  t.after(async () => {
    assert.equal(dirname(root), await realpath(tmpdir()));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: false });
  });
  const globalCwd = join(root, 'global-mapping');
  const finalCwd = join(root, 'chosen-destination');
  await mkdir(globalCwd); await mkdir(finalCwd);
  const sid = `session-${randomUUID()}`;
  const journal = join(root, 'destination-journal.json');
  const operationId = randomUUID();
  const setPhase = async (phase: 'reserved' | 'readable' | 'ready', continued = false) => writeFile(journal, JSON.stringify({
    version: 1, reservations: [{ sessionId: sid, operationId, finalCwd, phase, continued }],
  } satisfies Journal));
  await setPhase('reserved');
  return { root, globalCwd, finalCwd, sid, journal, setPhase, logs: join(root, 'logs') };
}

function kernel(ctx: Context, sessions = true) {
  if (sessions) new SessionStore(ctx);
  new AgentRegistry(ctx); new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false });
  new ToolRuntime(ctx); new LlmRuntime(ctx);
}
async function mount(ctx: Context, plugin: Parameters<Context['plugin']>[0], config: unknown = {}) {
  const scope = ctx.plugin(plugin, config); await scope.await();
  assert.equal(scope.state, 2, 'public plugin mounted');
  return scope;
}

async function legacyImporter(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, ctx: Context) {
  const domain = await openLocal(join(f.root, 'domain'));
  t.after(() => domain.close());
  const header = sessionHeader({ id: f.sid });
  const binding = headerHash(header, 0);
  const genesis = genesisHash(f.sid, 1, binding);
  const events = [event(0, 'working-directory/change', { cwd: '/remote/project' })];
  const chain = chainEvents(genesis, events);
  const row = batchRow(f.sid, 1, 0, { ...chain });
  const manifest = { entity: cloudSession({ sessionId: f.sid, headerHash: binding, ...chain, eventCount: 1, lastBatchRowKey: row.rowKey, lastBatchGeneration: 1 }), etag: 'fixture' };
  // Only Azure transport is a fixture. Admission, persistence, LocalStore and recovery are real.
  const repository = { getManifest: async () => manifest, listBatchRows: async () => [row], readCandidate: async () => gzipSync(payloadBytes(events)) };
  const importer = new Importer({ config: Config({}), persistence: ctx.sessionPersistence, repository: repository as never,
    local: domain.local, cwdBinding: async () => ({ mapping: pathMapping({ localPrefix: f.globalCwd }), fs: nodeCwdFs }), now: Date.now });
  return { importer, local: domain.local, expectedChainHash: chain.chainHash };
}

for (const ingress of ['pull', 'repairAll'] as const) {
  test(`counterexample: a separate destination journal is invisible to actual legacy ${ingress}`, async t => {
    const f = await fixture(t); const ctx = new Context(); kernel(ctx);
    const base = await mount(ctx, Jsonl, { root: f.logs, compression: 'none' });
    const loop = await mount(ctx, AgentLoop);
    t.after(async () => { await loop.dispose(); await base.dispose(); });
    const legacy = await legacyImporter(t, f, ctx);
    if (ingress === 'pull') await legacy.importer.import(f.sid);
    else {
      await legacy.local.putSession(localSession({ sessionId: f.sid, imported: true, importState: 'planned', status: 'importing', writerEpoch: 0, importExpectedCount: 1, importExpectedChainHash: legacy.expectedChainHash }));
      assert.deepEqual(await new ImportRecovery(legacy.importer, legacy.local).repairAll(), { repaired: [f.sid], failed: [] });
    }
    const cold = await ctx.sessionPersistence.open(SessionId(f.sid), 'read');
    try { assert.equal(cold.header.cwd, f.globalCwd); assert.equal((await cold.read(0)).events.length, 1); }
    finally { await cold.close(); }
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(f.sid) });
    try { assert.equal(resumed.agent.session.header.cwd, f.globalCwd); }
    finally { await resumed.dispose(); }
    assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).reservations[0].phase, 'reserved');
    assert.notEqual(f.globalCwd, f.finalCwd, 'reserved destination was bypassed, not silently equivalent');
  });
}

test('counterexample: disabling JSONL without a persistent Session/Agent dependency gate permits in-memory target creation', async t => {
  const f = await fixture(t); const ctx = new Context(); kernel(ctx);
  const loop = await mount(ctx, AgentLoop); t.after(() => loop.dispose());
  assert.equal(ctx.get('sessionPersistence'), undefined);
  await assert.rejects(ctx.agents.resume({ resumeSessionId: SessionId(f.sid) }), /persistence is not configured/);
  const created = await ctx.agents.create({ sessionId: SessionId(f.sid), meta: { cwd: f.globalCwd } });
  assert.equal(created.agent.session.id, f.sid, 'public native create has an actual in-memory fallback');
  assert.equal(ctx.sessions.get(SessionId(f.sid))?.header.cwd, f.globalCwd);
  await created.dispose();
});

for (const ingress of ['pull', 'repairAll'] as const) {
  test(`public isolated composite intercepts actual old ${ingress} before native create under global mapping`, async t => {
    const f = await fixture(t); const ctx = new Context();
    const guard = await mount(ctx, GuardPlugin, { journal: f.journal });
    const provider = await mount(ctx, CompositePlugin, { root: f.logs });
    t.after(async () => { await provider.dispose(); await guard.dispose(); });
    const legacy = await legacyImporter(t, f, ctx);
    if (ingress === 'pull') await assert.rejects(legacy.importer.import(f.sid), /DESTINATION_RESERVED/);
    else {
      await legacy.local.putSession(localSession({ sessionId: f.sid, imported: true, importState: 'planned', status: 'importing', writerEpoch: 0, importExpectedCount: 1, importExpectedChainHash: legacy.expectedChainHash }));
      assert.deepEqual(await new ImportRecovery(legacy.importer, legacy.local).repairAll(), { repaired: [], failed: [f.sid] });
    }
    assert.equal(await ctx.sessionPersistence.stat(SessionId(f.sid)), undefined);
    // Existing importer still writes failure/checkpoint metadata: persistence guarding does not
    // prove the new coordinator's stricter "no early LocalSessionRecord" publication ordering.
    assert.equal(legacy.local.getSession(f.sid)?.importState, 'failed');
    assert.equal(JSON.parse(await readFile(f.journal, 'utf8')).reservations[0].phase, 'reserved');
  });
}

test('mounted composite denies native exact-SID create/write-resume until final readable artifact and destination readiness', async t => {
  const f = await fixture(t); const ctx = new Context(); kernel(ctx);
  const guard = await mount(ctx, GuardPlugin, { journal: f.journal });
  const provider = await mount(ctx, CompositePlugin, { root: f.logs });
  const loop = await mount(ctx, AgentLoop);
  t.after(async () => { await loop.dispose(); await provider.dispose(); await guard.dispose(); });
  await assert.rejects(ctx.agents.create({ sessionId: SessionId(f.sid), meta: { cwd: f.globalCwd } }), /DESTINATION_RESERVED/);
  await assert.rejects(ctx.agents.resume({ resumeSessionId: SessionId(f.sid) }), /DESTINATION_RESERVED/);
  assert.equal(ctx.agents.get(SessionId(f.sid)), undefined);
  assert.equal(ctx.sessions.get(SessionId(f.sid)), undefined);
  assert.equal(await ctx.sessionPersistence.stat(SessionId(f.sid)), undefined);
  const coordinator = ctx.get(COORDINATOR) as FixtureCoordinator;
  await coordinator.materialize(sessionHeader({ id: f.sid, cwd: f.finalCwd }) as never);
  await f.setPhase('readable');
  const readable = await ctx.sessionPersistence.open(SessionId(f.sid), 'read');
  assert.equal(readable.header.cwd, f.finalCwd); await readable.close();
  await assert.rejects(ctx.agents.resume({ resumeSessionId: SessionId(f.sid) }), /DESTINATION_RESERVED/);
  await f.setPhase('ready');
  await assert.rejects(ctx.agents.resume({ resumeSessionId: SessionId(f.sid) }), /DESTINATION_RESERVED/, 'Ready is not Continue');
  await f.setPhase('ready', true);
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId(f.sid) });
  assert.equal(resumed.agent.session.header.cwd, f.finalCwd); await resumed.dispose();
  await assert.rejects(ctx.sessionPersistence.create(sessionHeader({ id: f.sid, cwd: f.globalCwd }) as never), /DESTINATION_COORDINATOR_ONLY/);
});

/** User-owned overlay persists independently of whichever version provides the plugin bundle. */
async function profile(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, mode: 'healthy' | 'missing-provider' | 'missing-guard' | 'old-guard' | 'bad-journal') {
  const config = join(f.root, 'cordis.json');
  await writeFile(config, JSON.stringify([
    { id: 'session-persistence-jsonl', name: import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'), config: { root: f.logs, compression: 'none' } },
    { id: 'session', name: import.meta.resolve('@deepseek-ai/dsh-session') },
    { id: 'agent-loop', name: import.meta.resolve('@deepseek-ai/dsh-agent-loop'), config: { agents: [] } },
  ]));
  if (mode === 'bad-journal') await writeFile(f.journal, JSON.stringify({ version: 2, reservations: [] }));
  const userPatchPath = join(f.root, 'user-profile.patch.json');
  await writeFile(userPatchPath, JSON.stringify([
    { id: 'session-persistence-jsonl', disabled: true },
    { id: 'session', inject: ['sessionPersistence', GUARD] },
    { id: 'agent-loop', inject: ['sessionPersistence', GUARD] },
    { insert: [
      { id: 'mandatory-destination-guard', name: mode === 'missing-guard' ? './missing-independent-guard.mjs' : 'cordis:fixture-guard', config: { journal: f.journal, portVersion: mode === 'old-guard' ? 0 : 1 } },
      { id: 'destination-persistence', name: mode === 'missing-provider' ? './missing-composite-subpath.mjs' : 'cordis:fixture-provider', config: { root: f.logs } },
    ] },
  ]));
  const patches = loadOverlayPatches('feasibility', userPatchPath);
  const prepare = (ctx: Context) => {
    kernel(ctx, false);
    ctx.loader.builtins['fixture-guard'] = GuardPlugin;
    ctx.loader.builtins['fixture-provider'] = CompositePlugin;
  };
  // Mount the actual boot Include/Loader before its audit to inspect pre-admission state.
  const ctx = new Context(); await ctx.plugin(Loader); prepare(ctx);
  t.after(() => ctx.fiber.dispose());
  await mountRootInclude(ctx, config, patches);
  await ctx.loader.await();
  return { ctx, config, patches, prepare };
}

function entry(ctx: Context, id: string) {
  const entries = [...ctx.loader.entries()];
  const value = entries.find(item => item.options.id === id);
  assert.ok(value, `missing ${id}; loaded ids: ${entries.map(item => item.id).join(', ')}`);
  return value;
}

test('public profile injection mounts supported composite and keeps old global base provider disabled', async t => {
  const f = await fixture(t); const p = await profile(t, f, 'healthy');
  await auditStartupEntries(p.ctx, 'feasibility');
  assert.equal(entry(p.ctx, 'session-persistence-jsonl').disabled, true);
  assert.equal(entry(p.ctx, 'agent-loop').fiber?.state, 2);
  assert.ok(p.ctx.get('sessionPersistence')); assert.ok(p.ctx.get('sessions'));
  await assert.rejects(p.ctx.agents.create({ sessionId: SessionId(f.sid), meta: { cwd: f.globalCwd } }), /DESTINATION_RESERVED/);
  const ordinaryId = SessionId(`ordinary-${randomUUID()}`);
  const ordinary = await p.ctx.agents.create({ sessionId: ordinaryId, meta: { cwd: f.globalCwd } });
  ordinary.agent.session.append('session/title', { title: 'Buffered through guard unload', messageSeqs: [], source: { kind: 'user' } });
  await entry(p.ctx, 'mandatory-destination-guard').update({ disabled: true });
  await p.ctx.loader.await();
  assert.equal(p.ctx.get('sessionPersistence'), undefined, 'guard removal unloads dependent composite');
  assert.equal(p.ctx.get('sessions'), undefined, 'profile row injection prevents in-memory fallback');
  assert.equal(p.ctx.get('agentLoop'), undefined);
  await assert.rejects(p.ctx.agents.create({ sessionId: SessionId(f.sid) }), /factory/);
  assert.equal(p.ctx.agents.list().length, 0);
  await ordinary.dispose();
  const coldCtx = new Context();
  const coldScope = await mount(coldCtx, Jsonl, { root: f.logs, compression: 'none' });
  try {
    const handle = await coldCtx.sessionPersistence.open(ordinaryId, 'read');
    try { assert.ok((await handle.read(0)).events.some(value => value.type === 'session/title' && value.data.title === 'Buffered through guard unload')); }
    finally { await handle.close(); }
  } finally { await coldScope.dispose(); }
});

for (const mode of ['missing-provider', 'missing-guard', 'old-guard', 'bad-journal'] as const) {
  test(`persistent profile fails actual boot admission with ${mode}; no base JSONL or native in-memory fallback`, async t => {
    const f = await fixture(t); const p = await profile(t, f, mode);
    assert.equal(entry(p.ctx, 'session-persistence-jsonl').disabled, true);
    assert.equal(p.ctx.get('sessionPersistence'), undefined);
    assert.equal(p.ctx.get('sessions'), undefined);
    assert.equal(p.ctx.get('agentLoop'), undefined);
    assert.equal(p.ctx.agents.list().length, 0);
    await assert.rejects(p.ctx.agents.create({ sessionId: SessionId(f.sid), meta: { cwd: f.globalCwd } }), /factory/);
    await assert.rejects(auditStartupEntries(p.ctx, 'feasibility'), StartupError);
    // A failed apply/import is not the proof: actual entry dependency gating above is.
    await p.ctx.fiber.dispose();
    await assert.rejects(boot('feasibility', p.config, p.patches, p.prepare), StartupError);
  });
}

function child(t: TestContext, mode: 'claim' | 'domain', root: string, sid: string, operation: string) {
  const process = fork(fileURLToPath(new URL('./import-compatibility-fixture.ts', import.meta.url)), [mode, root, sid, operation], { execArgv: ['--import', 'tsx'], silent: true });
  let stderr = '';
  process.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  const messages: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  process.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); });
  const done = new Promise<void>((resolve, reject) => {
    process.on('error', reject);
    process.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`fixture child exit ${code}/${signal}: ${stderr}`)));
  });
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await done.catch(() => undefined); });
  return { process, done, message: () => messages.length ? Promise.resolve(messages.shift()) : new Promise<unknown>(resolve => waiters.push(resolve)) };
}

test('counterexample: public storage-domain per-SID queues are not cross-process pre-effect claims', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const root = join(f.root, 'claim-domain'); await mkdir(root);
  const a = child(t, 'domain', root, f.sid, 'a'); const b = child(t, 'domain', root, f.sid, 'b');
  assert.deepEqual(await a.message(), { phase: 'ready' }); assert.deepEqual(await b.message(), { phase: 'ready' });
  a.process.send('go'); b.process.send('go');
  assert.deepEqual(await a.message(), { acquired: true }); assert.deepEqual(await b.message(), { acquired: true });
  await Promise.all([a.done, b.done]);
  assert.deepEqual((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n').sort(), ['a', 'b']);
});

test('bounded exclusive filesystem SID claim wins once across actual processes and refuses dead-owner retry', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const root = join(f.root, 'exclusive-claims'); await mkdir(root);
  const a = child(t, 'claim', root, f.sid, 'a'); const b = child(t, 'claim', root, f.sid, 'b');
  const results = await Promise.all([a.message(), b.message()]) as Array<{ acquired: boolean }>;
  await Promise.all([a.done, b.done]);
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.equal((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n').length, 1);
  const retry = child(t, 'claim', root, f.sid, 'retry');
  assert.deepEqual(await retry.message(), { acquired: false, state: 'dead-owner-recovery-required' }); await retry.done;
  assert.equal((await readFile(join(root, 'effects'), 'utf8')).trim().split('\n').length, 1);
});

test('empty, malformed, and symlink-like uncertain claims never become pre-effect permission', async t => {
  const f = await fixture(t); const root = join(f.root, 'uncertain-claims'); await mkdir(root);
  const claim = join(root, `${createHash('sha256').update(f.sid).digest('hex')}.claim`);
  await mkdir(claim);
  assert.deepEqual(await exclusiveClaim(root, f.sid, 'retry'), { acquired: false, state: 'uncertain' });
  await writeFile(join(claim, 'owner.json'), '{');
  assert.deepEqual(await exclusiveClaim(root, f.sid, 'retry'), { acquired: false, state: 'uncertain' });
  await writeFile(join(claim, 'owner.json'), JSON.stringify({ host: '', pid: process.pid }));
  assert.deepEqual(await exclusiveClaim(root, f.sid, 'retry'), { acquired: false, state: 'uncertain' });
  const linkedSid = `${f.sid}-symlink`;
  await symlink(f.finalCwd, join(root, `${createHash('sha256').update(linkedSid).digest('hex')}.claim`));
  assert.deepEqual(await exclusiveClaim(root, linkedSid, 'retry'), { acquired: false, state: 'uncertain' });
});
