import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent';
import type { WorktreeRecord, OperationRecord } from '../../dist/types.js';
import type { CleanupReceipt, ReopenReceipt } from '../../dist/cleanup-store.js';
import type { CleanupDependencies } from '../../dist/cleanup.js';
import type { ColdFactoryHold } from '../../dist/sessions.js';
import type { RemovalIdentity } from '../../dist/git.js';
import { WorktreeError } from '../../dist/errors.js';
import { deferred, required, hasCode, type DynamicMock } from './fixtures.js';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { GoalService } from '@deepseek-ai/dsh-goal';
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets';
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { releasedV3SessionFormatCodec as v3Codec, restoreReleasedV3Artifact } from '@deepseek-ai/dsh-session-format-v2-to-v3';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { WorktreeCleanup } from '../../dist/cleanup.js';
import { SessionBootstrap } from '../../dist/sessions.js';
import { tempDirectory, tmpBase } from '../helpers.js';

// Resolve public transitive packages through their declared peer owners, never a
// machine-specific harness installation or private source checkout.
// This persisted vocabulary belongs to the transitive plan-mode plugin; the
// fixture appends its event without mounting that optional runtime service.
declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'plan/mode': { active: boolean } } }
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'));
const presetRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'));
const storageRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
const { LlmRuntime, LlmAdapter, createUserMessage } = await import(pathToFileURL(loopRequire.resolve('@deepseek-ai/dsh-llm')).href);
const { SessionProjectionRegistry } = await import(pathToFileURL(loopRequire.resolve('@deepseek-ai/dsh-session-projection')).href);
const { Loader } = await import(pathToFileURL(presetRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href);
const { Storage } = await import(pathToFileURL(storageRequire.resolve('@deepseek-ai/dsh-storage')).href);
const clone = <T>(value: T): T => structuredClone(value);
const route = { provider: 'fixture', model: 'no-network' };
const OID = 'a'.repeat(40), TOPIC = 'b'.repeat(40);
const code = hasCode;
function requestId() { return randomUUID() as Parameters<SessionController['prompt']>[0]['requestId']; }
function table<T>() {
  const rows = new Map<string, T>();
  return { rows, beforePut: undefined as ((id: string, row: T) => void | Promise<void>) | undefined, get: (id: string) => rows.has(id) ? clone(rows.get(id)) : undefined,
    *entries(): Generator<[string, T]> { for (const [id, row] of rows) yield [id, clone(row)]; },
    async put(id: string, row: T) { await this.beforePut?.(id, row); rows.set(id, clone(row)); },
    async delete(id: string) { return rows.delete(id); },
  };
}
class ReadQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<never> { throw Error('Search is not exercised by factory recovery.'); }
  override async searchEvents(): Promise<never> { throw Error('Search is not exercised by factory recovery.'); }
}

/** The current durable log of a session, found without an implementation-private path API. */
async function durableLog(root: string, id: string): Promise<string> {
  const found: { path: string; version: number }[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const log = entry.isFile() ? /^session\.v(\d+)\.jsonl$/u.exec(entry.name) : null;
      if (entry.isDirectory()) await walk(path);
      else if (log !== null && path.includes(id)) found.push({ path, version: Number(log[1]) });
    }
  };
  await walk(root);
  assert.ok(found.length >= 1, 'the session has a durable generation log');
  found.sort((left, right) => right.version - left.version);
  return required(found[0]).path;
}

type V3Event = Parameters<typeof v3Codec.encodeEvent>[0];
type V3Header = Parameters<typeof v3Codec.encodeHeader>[0];
type V3Artifact = Parameters<typeof restoreReleasedV3Artifact>[0];
interface SyntheticV3Source { path: string; bytes: Buffer; eventCount: number; events: readonly V3Event[] }

/** Replace a target-written V4 generation with the checked-in released-V3 body. */
async function replaceSourceWithV3(sourcePath: string, preset: string): Promise<SyntheticV3Source> {
  const directory = dirname(sourcePath);
  const [headerLine] = (await readFile(sourcePath, 'utf8')).split(/\r?\n/u);
  const current = JSON.parse(required(headerLine)) as { id: string; createdAt: number; cwd?: string };
  const fixture = await readFile(new URL('../fixtures/session.v3.events.jsonl', import.meta.url), 'utf8');
  const events = fixture.split(/\r?\n/u).filter(line => line.length > 0).map((line, seq): V3Event => {
    const event = JSON.parse(line) as V3Event;
    assert.equal(event.seq, seq, 'the released V3 fixture is densely sequenced');
    return event;
  });
  assert.ok(events.length > 0, 'the released V3 fixture carries events');
  const header: V3Header = {
    version: 3,
    id: current.id,
    createdAt: current.createdAt,
    ...(current.cwd === undefined ? {} : { cwd: current.cwd }),
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: preset,
  };
  const headerRow = v3Codec.encodeHeader(header, 0);
  const eventRows = events.map(event => v3Codec.encodeEvent(event));
  // Every fixture type belongs to the released V3 dispositions, so no additional
  // installed event vocabulary is needed beyond the artifact's own validation.
  restoreReleasedV3Artifact({ header: v3Codec.decodeHeader(headerRow), events, inheritedEventCount: 0 } as V3Artifact, new Set<string>());
  const path = join(directory, 'session.v3.jsonl');
  const bytes = Buffer.from([JSON.stringify(headerRow), ...eventRows.map(row => JSON.stringify(row))].join('\n') + '\n');
  await writeFile(path, bytes);
  await rm(sourcePath);
  return { path, bytes, eventCount: events.length, events };
}

async function fixture(t: TestContext) {
  const root = await tempDirectory('worktrees-recovery-factory-owned-');
  const local = resolve(root, 'local'), cwd = resolve(local, 'project'), commonDir = resolve(local, '.git');
  const id = randomUUID(), managed = resolve(root, 'managed');
  const checkoutRoot = resolve(managed, createHash('sha256').update(commonDir).digest('hex').slice(0, 24), id, `worktree-${id}`);
  const historicalCwd = resolve(checkoutRoot, 'project');
  await mkdir(cwd, { recursive: true }); await mkdir(commonDir); await mkdir(historicalCwd, { recursive: true });
  const owner = new Context(), scopes: Array<ReturnType<Context['plugin']>> = [], bootstraps: SessionBootstrap[] = [], cleanups: WorktreeCleanup[] = [], calls: Array<{ signal: AbortSignal }> = [], life: Array<[SessionStartSource, string]> = [], hooks: { entered?: (agent: Agent, source: SessionStartSource) => void | Promise<unknown> } = {};
  let backend: JsonStorageBackend | undefined, facility: DomainFacility | undefined, unregisterPreset: (() => void | Promise<void>) | undefined;
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup.close(); for (const bootstrap of bootstraps.reverse()) await bootstrap.close(); for (const scope of scopes.reverse()) await scope.dispose(); await unregisterPreset?.(); await facility?.closeAll(); await backend?.close(); assert.equal(owner.agents.list().length, 0); assert.equal(dirname(root), tmpBase); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: false }); });
  const mount = async (plugin: DynamicMock, config?: DynamicMock) => { const scope = owner.plugin(plugin, config); scopes.push(scope); await scope.await(); assert.equal(scope.state, 2, `${plugin.name} requires ${(plugin.inject ?? []).filter((name: string) => owner.get(name) === undefined).join(', ')}`); return scope; };
  new SessionStore(owner); new SessionProjectionRegistry(owner); new AgentRegistry(owner);
  new SystemPrompt(owner, { includeHarnessIdentity: false }); new ToolRuntime(owner); new CommandRuntime(owner);
  // Only unused Host I/O ports are fixture adapters. The Agent factory, native
  // Session controller, preset registry, projections, policies, goals, workspace
  // and JSONL durability are the actual pinned 0.2.1 implementations.
  owner.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} }, resources: { register() {} } });
  // Local profile: no remote peer may reach the API controller's session surface.
  owner.provide('remoteAccess', { allows: () => true });
  owner.provide('agentDefaultModel', { currentSelection: () => route, async saveSelection() {} });
  owner.provide('attachments', { imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 1, maxMessageImageBytes: 1024, maxImagePixels: 1024, maxImageDimension: 32, mediaTypes: ['image/png'] }, async admitPromptContent(content: Array<{ type: string }>) { assert.ok(content.every(part => part.type === 'text')); return clone(content); } });
  owner.provide('fileUploads', { registerAgentResolver() { return () => {}; }, resolve() { assert.fail('No file receipts are used'); }, bindPrompt() { return { commit() {}, [Symbol.dispose]() {} }; }, retirePrompt() {} });
  owner.provide('fs', { async resolve(path: string) { assert.ok(path.startsWith(root)); return { path: await realpath(path) }; }, processPath: (value: { path: string }) => value.path, processPathFromHostPath: (path: string) => path });
  owner.provide('shell', { sandboxMode: 'read-only' });
  owner.provide('subprocess', { resolveExecutable() { assert.fail('Factory recovery must not launch a process'); }, spawn() { assert.fail('Factory recovery must not launch a process'); } });
  new LlmRuntime(owner);
  class FixtureAdapter extends LlmAdapter {
    async *stream(options: { signal: AbortSignal }) {
      calls.push(options);
      assert.equal(options.signal.aborted, false);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Fixture completion.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture completion.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  owner.llm.registerAdapter(['fixture'], new FixtureAdapter() as unknown as Parameters<Context['llm']['registerAdapter']>[1]); // Public transitive adapter base is dynamically resolved.
  const sessionLogs = resolve(root, 'session-logs');
  await mount(JsonlSessionPersistence, { root: sessionLogs, compression: 'none' });
  new ReadQuery(owner); new SandboxPolicyService(owner, { mode: 'read-only', workspaceRoot: root }); new ApprovalService(owner, { policy: 'ask' }); new GoalService(owner);
  new Storage(owner); backend = new JsonStorageBackend(resolve(root, 'domain-data')); owner.storage.backend.register('fixture-json', backend);
  facility = new DomainFacility(owner, { backend: 'fixture-json' }); owner.provide('storageDomain', facility); await mount(WorkspaceRegistry);
  new Loader(owner, { baseUrl: import.meta.url });
  new AgentPresetRegistry(owner, AgentPresetRegistry.Config({ default: 'factory-test' }));
  unregisterPreset = await owner.agentPresets.register({ id: 'factory-test', plugins: [] });
  assert.equal((await owner.agentPresets.resolve('factory-test')).id, 'factory-test');
  await mount(PermissionPresetService, { presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } }, defaultPreset: 'read-only' });
  await mount(AgentLoop, {});
  let native!: Awaited<ReturnType<Context['plugin']>>;
  async function newNative() { native = await mount(SessionController, {}); return owner.sessionController; }
  let sessionController = await newNative();
  owner.on('agent/created', async ({ agent, source }) => { life.push([source, agent.id]); await hooks.entered?.(agent, source); return undefined; });
  const sourceId = SessionId(randomUUID());
  await sessionController.create({ cwd: historicalCwd, sessionId: sourceId, agentPreset: 'factory-test' });
  let source = required(owner.agents.get(sourceId));
  await sessionController.prompt({ sessionId: sourceId, requestId: requestId(), mode: 'queue', content: [{ type: 'text', text: 'Historical source request.' }] }, new AbortController().signal);
  await source.whenIdle();
  source.session.append('session/title', { title: 'Historical idle edits retained', messageSeqs: [], source: { kind: 'user' } });
  source.session.append('plan/mode', { active: true });
  owner.goals.create(source, { objective: 'Retain history without authorizing continuation', maxGoalRounds: 5 });
  assert.equal(required(owner.goals.get(source)).activation, 'armed');
  await owner.sessions.flush(source.session);
  await native.dispose(); assert.equal(owner.agents.get(sourceId), undefined);
  sessionController = await newNative();
  const resumed = await sessionController.resolveAgent(sourceId); assert.ok('agent' in resumed, 'error' in resumed ? resumed.error.message : undefined); source = resumed.agent;
  assert.equal(source.session.header.cwd, historicalCwd); assert.equal(required(owner.goals.get(source)).activation, 'disarmed');
  assert.equal(calls.length, 1, 'native cold resume must not infer');
  await native.dispose(); sessionController = await newNative();
  const sourcePath = await durableLog(sessionLogs, sourceId), sourceBytes = await readFile(sourcePath);
  assert.equal(await realpath(checkoutRoot), checkoutRoot); await rm(checkoutRoot, { recursive: true, force: false });
  const record: WorktreeRecord = { id, operationId: randomUUID(), repoRoot: local, commonDir, projectSubdir: 'project', checkoutRoot, effectiveCwd: historicalCwd, remote: 'local', remoteIdentity: 'fixture', remoteBranch: 'main', baseOid: OID, baseRef: `refs/dsh-worktrees/${id}/base`, fetchedAt: 1, createdAt: 1, sessionIds: [sourceId], workspaceId: randomUUID(), branch: null, protected: false, archived: true, state: 'missing', error: null };
  const worktrees = { worktrees: table<WorktreeRecord>(), operations: table<OperationRecord>(), async close() {} }, store = { cleanup: table<CleanupReceipt>(), reopens: table<ReopenReceipt>(), async close() {} };
  await worktrees.worktrees.put(id, record);
  const identity: RemovalIdentity = { checkoutRoot, sourceRoot: local, commonDir, adminDir: resolve(commonDir, 'worktrees', 'fixture'), head: OID, branch: null, checkoutIdentity: 'fixture', sourceIdentity: 'fixture', commonIdentity: 'fixture', adminIdentity: 'fixture', pointerIdentity: 'fixture', pointerHash: 'c'.repeat(64), backlinkIdentity: 'fixture', backlinkHash: 'c'.repeat(64), commonPointerIdentity: 'fixture', commonPointerHash: 'c'.repeat(64), sourceMappingIdentity: 'fixture', sourceMappingHash: '', privateStateHash: 'c'.repeat(64), retainedHeads: [OID] };
  await store.cleanup.put(id, { id, checkoutRoot, commonDir, originalFolder: cwd, sourceRoot: local, sessionIds: [sourceId], phase: 'collected', inactivityDays: 10, lastActivityAt: 1, eligibleAfter: 1, reclaimedAt: 1, recoveryRef: `refs/dsh-worktrees/${id}/gc-head`, identity, createdAt: 1, updatedAt: 1, reason: null });
  const config = { root: managed, gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 1000, fetchTimeoutMs: 1000, operationTimeoutMs: 60000, maxSnapshotBytes: 1048576, maxFiles: 1000, maxRefBytes: 1048576 };
  let queue: Promise<unknown> = Promise.resolve(); const switchCalls: string[] = [];
  const controller: ConstructorParameters<typeof WorktreeCleanup>[4] = { withRepositoryMaintenance(_common, signal, task) { const flight = queue.then(() => task(signal)); queue = flight.catch(() => undefined); return flight; }, hasPendingEffects: () => false,
    async withLocalClaims(_roots, _invocation, _task, held) { assert.equal(required(held).length, 1); throw Object.assign(Error('Independent Local activity cannot be ruled out in this fixture'), { code: 'LOCAL_BUSY' }); } };
  const git: NonNullable<CleanupDependencies['git']> = (_record, guard) => ({
    async inspectRemoval() { assert.fail('Absent reclaimed checkout cannot be inspected'); },
    async preserveRemovalHead() { assert.fail('Recovery must not rewrite preservation refs'); },
    async removeManagedCheckout() { assert.fail('Recovery must not delete a checkout'); }, async removalState() { guard(); return 'absent'; }, async discover() { guard(); return { root: local, commonDir, projectSubdir: 'project', head: OID, branch: 'main' }; }, async localBranches() { guard(); return { branchSource: 'local', currentBranch: 'main', defaultBranch: 'main', branches: [{ name: 'main', oid: OID }, { name: 'topic', oid: TOPIC }], observedAt: Date.now() }; },
    async switchLocalBranch(path, common, branch, oid, signal, verifyOnly) { guard(); assert.equal(required(signal).aborted, false); assert.equal(path, cwd); assert.equal(common, commonDir); assert.equal(verifyOnly, true); assert.equal(branch, 'main'); assert.equal(oid, OID); switchCalls.push(branch); return { head: OID, branch: 'main', dirty: true, changes: 2, untracked: 1 }; } });
  function newCleanup() { const bootstrap = new SessionBootstrap(owner); bootstraps.push(bootstrap); const cleanup = new WorktreeCleanup(owner, config, worktrees, store, controller, { bootstrap, git }); cleanups.push(cleanup); cleanup.start(false); return { cleanup, bootstrap }; }
  const current = newCleanup();
  const prompt = (id: string, mode: 'queue' | 'steer' = 'queue', text = 'Input arriving at factory handover.') => owner.sessionController.prompt({ sessionId: SessionId(id), requestId: requestId(), mode, content: [{ type: 'text', text }] }, new AbortController().signal);
  const reopen = (branch = 'main', oid = OID, signal = new AbortController().signal) => current.cleanup.reopen({ action: 'reopen', sourceSessionId: sourceId, localBranch: branch, localOid: oid }, { origin: 'ui', signal });
  return { ...current, root, owner, store, record, sourceId, sourcePath, sourceBytes, calls, life, hooks, cwd, switchCalls, prompt, reopen, newCleanup };
}
const ownTurns = (agent: Agent) => agent.session.snapshotEvents(agent.session.inheritedEventCount).filter(event => event.type === 'turn/start');

test('an existing workspace whose directory vanished stays a member instead of being re-created', async t => {
  const f = await fixture(t);
  const folder = resolve(f.root, 'vanishing-project');
  await mkdir(folder, { recursive: true });
  const created = await f.owner.workspaceRegistry.create(await realpath(folder), 'Vanishing');
  await rm(folder, { recursive: true, force: true });
  const listed = f.owner.workspaceRegistry.list();
  assert.equal(listed.some(value => value.id === created.id), true, 'the vanished-cwd workspace remains a member');
  assert.deepEqual(f.owner.workspaceRegistry.list(), listed, 'repeat listing stays stable while the cwd is missing');
});

test('real 0.2.1 factory holds create/publication input until explicit current-branch ready receipt, with native controls available', { timeout: 30000 }, async t => {
  const f = await fixture(t), readyEntered = deferred<ReopenReceipt>(), finishReady = deferred();
  f.store.reopens.beforePut = async (_id, row) => { if (row.phase === 'ready') { readyEntered.resolve(row); await finishReady.promise; } };
  // This earlier serial listener admits native input at registry entry, BEFORE
  // the plugin captures its provisional target. The original factory claim must
  // span this handover continuously; a deferred post-factory hold cannot do so.
  f.hooks.entered = async agent => { if (agent.session.header.parentSession === f.sourceId) await f.prompt(agent.id); };
  const opened = f.reopen(); const pending = await Promise.race([readyEntered.promise, opened.then(() => { throw Error('Recovery released before the ready checkpoint was observed.'); })]);
  let target!: Agent; const startPhases: ReopenReceipt['phase'][] = [];
  try {
  target = required(f.owner.agents.get(SessionId(pending.sessionId))); assert.ok(target); assert.notEqual(target.id, f.sourceId); assert.equal(target.session.header.cwd, f.cwd);
  assert.throws(() => target.runMaintenance(async () => {}), /already has active work/u, 'the existing factory initialization claim is still active');
  const resolved = await f.owner.sessionController.resolveAgent(target.id); assert.ok('agent' in resolved); assert.equal(resolved.agent, target);
  const controls = f.owner.sessionController.control(new AbortController().signal)[Symbol.asyncIterator](); const baseline = await controls.next(); assert.ok(baseline.value.value.projections[target.id]); await required(controls.return).call(controls);
  assert.equal(f.owner.permissionPresets.current(target.session), 'read-only'); assert.equal(f.owner.sandboxPolicy.resolve({ session: target.session }).mode, 'read-only');
  assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed');
  await f.prompt(target.id, 'steer', 'Steering arriving while publication is gated.');
  assert.equal(target.inbox.nextTurn.length, 1); assert.equal(target.inbox.nextStep.length, 1); assert.equal(ownTurns(target).length, 0); assert.equal(f.calls.length, 1);
  assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
  f.owner.on('session/event', (session, event) => { if (session.id === target.id && event.type === 'turn/start') startPhases.push(required(f.store.reopens.get(f.sourceId)).phase); });
  } finally { finishReady.resolve(); }
  const result = await opened; await target.whenIdle();
  assert.deepEqual(startPhases, ['ready']);
  assert.equal(result.sessionId, target.id); assert.deepEqual(f.switchCalls, ['main']); assert.equal(ownTurns(target).length, 1); assert.equal(f.calls.length, 2);
  assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed'); assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
  assert.equal(f.owner.agents.get(f.sourceId), undefined, 'recovery never activates the historical source');
  assert.deepEqual(target.session.snapshotEvents().slice(0, (await f.bootstrap.coldSource(f.sourceId)).seed.length), (await f.bootstrap.coldSource(f.sourceId)).seed);
  const repeated = await f.reopen(); assert.equal(repeated.sessionId, result.sessionId); assert.equal(f.switchCalls.length, 1);
  await assert.rejects(f.bootstrap.adoptColdContinuation({ sessionId: target.id, cwd: f.cwd, title: 'Refuse own execution', source: await f.bootstrap.coldSource(f.sourceId), holdInput() {} }), code('COLD_CONTINUATION_CONFLICT'));
});

test('Full-access refusal retains the real factory-held target; native permission command and cancelled/repeated opens never duplicate or drive it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.reopen('topic', TOPIC), code('FULL_ACCESS_REQUIRED'));
  const row = required(f.store.reopens.get(f.sourceId)), target = f.owner.agents.get(SessionId(row.sessionId)); assert.ok(target); assert.equal(row.phase, 'recovery-required');
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0);
  assert.deepEqual(f.owner.sessionController.cancel({ sessionId: target.id }), { accepted: true });
  assert.equal(target.inbox.nextTurn.length, 1, 'native Host cancellation keeps parked input');
  assert.equal(ownTurns(target).length, 0);
  const resolved = await f.owner.sessionController.resolveAgent(target.id); assert.ok('agent' in resolved); assert.equal(resolved.agent, target);
  const permission = await f.owner.commands.execute(resolved.agent, '/permission danger-full-access', [], new AbortController().signal);
  assert.equal(required(permission).result.kind, 'success'); assert.equal(f.owner.sandboxPolicy.resolve({ session: target.session }).mode, 'danger-full-access');
  assert.equal(f.owner.approval.overrideOf(target.session), 'never'); assert.equal(ownTurns(target).length, 0);
  await assert.rejects(f.reopen('topic', TOPIC), code('LOCAL_BUSY')); assert.equal(f.owner.agents.list().length, 1); assert.equal(required(f.store.reopens.get(f.sourceId)).sessionId, target.id);
  const abort = new AbortController(); abort.abort(); await assert.rejects(f.reopen('main', OID, abort.signal), code('CANCELLED')); assert.equal(ownTurns(target).length, 0);
  const result = await f.reopen(); await target.whenIdle(); assert.equal(result.sessionId, target.id); assert.equal(ownTurns(target).length, 1);
  assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes); assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed');
});

test('real cold resume/adoption verifies the full preallocated prefix and retains durable queued input across factory setup', { timeout: 30000 }, async t => {
  const f = await fixture(t), cold = await f.bootstrap.coldSource(f.sourceId), sessionId = SessionId(randomUUID());
  const seed = clone(cold.seed); const queued = createUserMessage({ content: [{ type: 'text', text: 'Durably parked before cold resume.' }], source: { kind: 'user' } });
  const session = f.owner.sessions.prepare(sessionId, { seed, inheritedEventCount: cold.inheritedEventCount, meta: { cwd: f.cwd, parentSession: f.sourceId, isSeeded: true, agentPreset: required(cold.preset) } });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [queued] });
  const writer = await f.owner.sessionPersistence.create(session.header, { inheritedEventCount: cold.inheritedEventCount });
  await writer.append(session.snapshotEvents()); await writer.flush(); await writer.close();
  let hold!: ColdFactoryHold;
  const stage = await f.bootstrap.stageColdContinuation({ sessionId, cwd: f.cwd, title: 'Cold target', source: cold, holdInput(agent, factory) { assert.ok(factory); hold = factory; assert.equal(required(agent.inbox.nextTurn[0]).id, queued.id); } });
  const target = stage.agent; assert.equal(f.owner.agents.get(sessionId), target); assert.equal(ownTurns(target).length, 0);
  await f.prompt(sessionId, 'steer', 'Input arriving during resumed publication.'); assert.equal(ownTurns(target).length, 0);
  assert.equal(required(target.inbox.nextTurn[0]).id, queued.id); assert.throws(() => target.runMaintenance(async () => {}), /already has active work/u);
  const resolved = await f.owner.sessionController.resolveAgent(sessionId); assert.ok('agent' in resolved); assert.equal(resolved.agent, target);
  // The caller's durable ready decision precedes release of the original claim.
  let ready = false; f.owner.on('session/event', (observed, event) => { if (observed.id === sessionId && event.type === 'turn/start') assert.equal(ready, true); });
  ready = true; hold.release(); await stage.completion; await target.whenIdle();
  assert.equal(ownTurns(target).length, 1); assert.ok(target.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === queued.id));
  assert.deepEqual(target.session.snapshotEvents().slice(0, seed.length), seed); assert.equal(target.session.inheritedEventCount, cold.inheritedEventCount);
  assert.equal(f.owner.sandboxPolicy.resolve({ session: target.session }).mode, 'read-only'); assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed');
  assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes); assert.equal(f.life.filter(([source, id]) => source === 'resume' && id === sessionId).length, 1);
});

test('cold continuation migrates a released V3 source without touching it', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  // A registered non-default preset makes target preset propagation falsifiable.
  const unregisterV3Preset = await f.owner.agentPresets.register({ id: 'v3-preset', plugins: [] });
  t.after(async () => { await unregisterV3Preset(); });
  const v3 = await replaceSourceWithV3(f.sourcePath, 'v3-preset');
  const diskHeader = JSON.parse(required((await readFile(v3.path, 'utf8')).split(/\r?\n/u)[0])) as { version?: number; id?: string; cwd?: string };
  assert.equal(diskHeader.version, 3); assert.equal(diskHeader.id, f.sourceId); assert.equal(diskHeader.cwd, f.record.effectiveCwd);
  assert.deepEqual(await readFile(v3.path), v3.bytes);
  const generations = async () => (await readdir(dirname(v3.path))).filter(name => /^session\.v\d+\.jsonl$/u.test(name)).sort();
  assert.deepEqual(await generations(), ['session.v3.jsonl']);
  await assert.rejects(stat(f.sourcePath), code('ENOENT'));

  const cold = await f.bootstrap.coldSource(f.sourceId);
  assert.equal(cold.header.version, 4); assert.equal(cold.header.cwd, f.record.effectiveCwd); assert.equal(cold.header.isSeeded, false);
  assert.equal(cold.header.agentPreset, 'v3-preset'); assert.equal(cold.preset, 'v3-preset');
  assert.deepEqual(cold.model, { provider: 'fixture', model: 'v3-source-model' });
  assert.equal(cold.events.length, v3.eventCount); assert.equal(cold.inheritedEventCount, v3.eventCount);
  assert.equal(cold.rawEventCount, v3.eventCount); assert.equal(cold.syntheticEventCount, 0);
  assert.deepEqual(cold.events, v3.events, 'the released V3 body survives migration unchanged');
  assert.ok(cold.events.some(event => event.type === 'user/message' && event.data.content.some(part => part.type === 'text' && part.text === 'Historical V3 request.')));
  assert.ok(cold.events.some(event => event.type === 'turn/end'));
  const endSeed = required(cold.seed[v3.eventCount]);
  assert.equal(endSeed.type, 'session/end-seed');
  if (endSeed.type === 'session/end-seed') assert.equal(endSeed.data.inherited, true);
  assert.equal(cold.seed.length, v3.eventCount + 1);

  let hold!: ColdFactoryHold;
  const sessionId = SessionId(randomUUID());
  const stage = await f.bootstrap.stageColdContinuation({ sessionId, cwd: f.cwd, title: 'V3 continuation', source: cold,
    holdInput(agent, factory) { assert.ok(factory); hold = factory; assert.equal(agent.session.header.parentSession, f.sourceId); } });
  const target = stage.agent; assert.equal(f.owner.agents.get(sessionId), target); assert.equal(ownTurns(target).length, 0);
  hold.release(); await stage.completion; await target.whenIdle();
  await f.prompt(sessionId); await target.whenIdle(); assert.equal(ownTurns(target).length, 1);

  assert.equal(target.session.header.version, 4); assert.equal(target.session.header.parentSession, f.sourceId);
  assert.equal(target.session.header.cwd, f.cwd); assert.equal(target.session.header.isSeeded, true);
  assert.equal(target.session.header.agentPreset, 'v3-preset'); assert.equal(target.session.inheritedEventCount, cold.inheritedEventCount);
  assert.deepEqual(target.session.snapshotEvents().slice(0, cold.seed.length), cold.seed);
  assert.equal(f.owner.sandboxPolicy.resolve({ session: target.session }).mode, 'danger-full-access');
  assert.equal(f.owner.approval.overrideOf(target.session), 'never');
  assert.equal(target.options.provider, 'fixture'); assert.equal(target.options.model, 'v3-source-model');

  assert.deepEqual(await readFile(v3.path), v3.bytes); assert.deepEqual(await generations(), ['session.v3.jsonl']);
  await assert.rejects(stat(f.sourcePath), code('ENOENT')); await assert.rejects(stat(f.record.effectiveCwd), code('ENOENT'));
  const targetPath = await durableLog(resolve(f.root, 'session-logs'), sessionId);
  assert.match(targetPath, /session\.v4\.jsonl$/u);
  assert.equal((JSON.parse(required((await readFile(targetPath, 'utf8')).split(/\r?\n/u)[0])) as { version?: number }).version, 4);
  assert.equal(f.owner.agents.get(SessionId(f.sourceId)), undefined);
});

test('native resume of a journaled pending target is factory-gated after reload and adopted without nested maintenance', { timeout: 30000 }, async t => {
  const f = await fixture(t); await assert.rejects(f.reopen('topic', TOPIC), code('FULL_ACCESS_REQUIRED'));
  const pending = required(f.store.reopens.get(f.sourceId)); await f.cleanup.close(); assert.equal(f.owner.agents.get(SessionId(pending.sessionId)), undefined);
  const next = f.newCleanup(), entered = deferred<Agent>();
  f.hooks.entered = agent => { if (agent.id === pending.sessionId) entered.resolve(agent); };
  const nativeResume = f.owner.sessionController.resolveAgent(SessionId(pending.sessionId));
  const target = await Promise.race([entered.promise, nativeResume.then(result => { throw Error('error' in result ? result.error.message : 'Native resume was not gated.'); })]);
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0); assert.throws(() => target.runMaintenance(async () => {}), /already has active work/u);
  const result = await next.cleanup.reopen({ action: 'reopen', sourceSessionId: f.sourceId, localBranch: 'main', localOid: OID }, { origin: 'ui', signal: new AbortController().signal });
  assert.equal(result.sessionId, target.id); const resolved = await nativeResume; assert.ok('agent' in resolved); assert.equal(resolved.agent, target); await target.whenIdle();
  assert.equal(ownTurns(target).length, 1); assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed'); assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});

test('shutdown also waits for rollback and writer release of a pending target resumed by the native service', { timeout: 30000 }, async t => {
  const f = await fixture(t); await assert.rejects(f.reopen('topic', TOPIC), code('FULL_ACCESS_REQUIRED'));
  const pending = required(f.store.reopens.get(f.sourceId)); await f.cleanup.close();
  const next = f.newCleanup(), entered = deferred<Agent>();
  f.hooks.entered = agent => { if (agent.id === pending.sessionId) entered.resolve(agent); };
  const nativeResume = f.owner.sessionController.resolveAgent(SessionId(pending.sessionId)); const target = await entered.promise;
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0);
  await assert.rejects(next.cleanup.reopen({ action: 'reopen', sourceSessionId: f.sourceId, localBranch: 'topic', localOid: TOPIC }, { origin: 'ui', signal: new AbortController().signal }), code('FULL_ACCESS_REQUIRED'));
  await next.cleanup.close();
  assert.equal(f.owner.agents.get(target.id), undefined, 'close waits for the native composite teardown, not only gate rejection');
  assert.ok('error' in await nativeResume);
  const writer = await f.owner.sessionPersistence.open(target.id, 'write'); await writer.close();
  assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});

test('a bootstrap factory listener failure after READY preserves commitment and permits native same-target retry', { timeout: 30000 }, async t => {
  const f = await fixture(t), phases: ReopenReceipt['phase'][] = []; let armed = true;
  f.store.reopens.beforePut = (_id, row) => { phases.push(row.phase); };
  f.hooks.entered = agent => { if (agent.session.header.parentSession === f.sourceId) return f.prompt(agent.id); };
  // Registered after staging and cleanup: this rejection occurs only after the
  // validated branch/Workspace/history have been durably committed and released.
  f.owner.on('agent/created', ({ agent }) => {
    if (armed && agent.session.header.parentSession === f.sourceId) {
      armed = false; assert.equal(required(f.store.reopens.get(f.sourceId)).phase, 'ready');
      assert.equal(ownTurns(agent).length, 0); throw Error('One-shot downstream publication failure');
    }
    return undefined;
  });
  let failure: unknown;
  await assert.rejects(f.reopen(), error => { failure = error; return code('CONTINUATION_PUBLICATION_FAILED')(error); });
  const receipt = required(f.store.reopens.get(f.sourceId));
  assert.equal(receipt.phase, 'ready'); assert.equal(receipt.localBranch, 'main'); assert.equal(receipt.localOid, OID); assert.ok(receipt.workspaceId);
  assert.ok(failure instanceof WorktreeError); assert.equal(required(failure.details).sessionId, receipt.sessionId); assert.equal(f.owner.agents.get(SessionId(receipt.sessionId)), undefined);
  assert.deepEqual(phases.slice(phases.indexOf('ready')), ['ready']);
  const info = await f.cleanup.info(f.sourceId, new AbortController().signal); assert.equal(info.continuationSessionId, receipt.sessionId); assert.equal(info.pendingSessionId, undefined);
  f.hooks.entered = undefined;
  const resumed = await f.owner.sessionController.resolveAgent(SessionId(receipt.sessionId)); assert.ok('agent' in resumed, 'error' in resumed ? resumed.error.message : undefined);
  const target = resumed.agent; assert.equal(target.session.header.cwd, f.cwd); assert.equal(target.session.header.parentSession, f.sourceId);
  assert.equal(f.owner.sandboxPolicy.resolve({ session: target.session }).mode, 'read-only'); assert.equal(required(f.owner.goals.get(target)).activation, 'disarmed');
  assert.equal(ownTurns(target).length, 0); await f.prompt(target.id); await target.whenIdle(); assert.equal(ownTurns(target).length, 1);
  assert.equal((await f.reopen('topic', TOPIC)).sessionId, target.id); assert.deepEqual(f.switchCalls, ['main']);
  assert.equal(f.owner.agents.list().length, 1); assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});

test('a native factory post-gate listener failure cannot downgrade the same READY commitment', { timeout: 30000 }, async t => {
  const f = await fixture(t); await assert.rejects(f.reopen('topic', TOPIC), code('FULL_ACCESS_REQUIRED'));
  const pending = required(f.store.reopens.get(f.sourceId)); await f.cleanup.close();
  const next = f.newCleanup(), entered = deferred<Agent>(); let armed = true;
  f.hooks.entered = agent => { if (agent.id === pending.sessionId) entered.resolve(agent); };
  f.owner.on('agent/created', ({ agent }) => {
    if (armed && agent.id === pending.sessionId) {
      armed = false; assert.equal(required(f.store.reopens.get(f.sourceId)).phase, 'ready');
      assert.equal(ownTurns(agent).length, 0); throw Error('One-shot native post-gate publication failure');
    }
    return undefined;
  });
  const nativeResume = f.owner.sessionController.resolveAgent(SessionId(pending.sessionId)); const target = await entered.promise;
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0);
  const result = await next.cleanup.reopen({ action: 'reopen', sourceSessionId: f.sourceId, localBranch: 'main', localOid: OID }, { origin: 'ui', signal: new AbortController().signal });
  assert.equal(result.sessionId, pending.sessionId); assert.ok('error' in await nativeResume);
  const receipt = required(f.store.reopens.get(f.sourceId)); assert.equal(receipt.phase, 'ready'); assert.equal(receipt.sessionId, pending.sessionId); assert.equal(receipt.localBranch, 'main');
  const retry = await f.owner.sessionController.resolveAgent(SessionId(pending.sessionId)); assert.ok('agent' in retry, 'error' in retry ? retry.error.message : undefined);
  assert.equal(retry.agent.session.header.cwd, f.cwd); assert.equal(required(f.owner.goals.get(retry.agent)).activation, 'disarmed');
  assert.equal(f.owner.sandboxPolicy.resolve({ session: retry.agent.session }).mode, 'read-only');
  await f.prompt(retry.agent.id); await retry.agent.whenIdle(); assert.equal(ownTurns(retry.agent).length, 1);
  assert.equal((await next.cleanup.info(f.sourceId, new AbortController().signal)).continuationSessionId, retry.agent.id);
  assert.equal(f.owner.agents.list().length, 1); assert.deepEqual(f.switchCalls, ['main']); assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});

test('a rejected READY journal is precommit failure: retain the same held target and pending fence until retry', { timeout: 30000 }, async t => {
  const f = await fixture(t); let fail = true;
  f.store.reopens.beforePut = (_id, row) => { if (fail && row.phase === 'ready') { fail = false; throw Error('Injected ready journal failure'); } };
  await assert.rejects(f.reopen(), /Injected ready journal failure/u);
  const pending = required(f.store.reopens.get(f.sourceId)), target = required(f.owner.agents.get(SessionId(pending.sessionId)));
  assert.equal(pending.phase, 'recovery-required'); assert.ok(target); assert.equal((await f.cleanup.info(f.sourceId, new AbortController().signal)).pendingSessionId, target.id);
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0); assert.throws(() => target.runMaintenance(async () => {}), /already has active work/u);
  const result = await f.reopen(); await target.whenIdle(); assert.equal(result.sessionId, pending.sessionId); assert.equal(ownTurns(target).length, 1);
  assert.equal(required(f.store.reopens.get(f.sourceId)).phase, 'ready'); assert.equal(f.owner.agents.list().length, 1); assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});

test('shutdown drains a refused factory publication and releases its writer without source activation or a new turn', { timeout: 30000 }, async t => {
  const f = await fixture(t); await assert.rejects(f.reopen('topic', TOPIC), code('FULL_ACCESS_REQUIRED'));
  const row = required(f.store.reopens.get(f.sourceId)), target = f.owner.agents.get(SessionId(row.sessionId)); assert.ok(target);
  await f.prompt(target.id); assert.equal(ownTurns(target).length, 0); await f.cleanup.close();
  assert.equal(f.owner.agents.get(target.id), undefined); assert.equal(f.owner.agents.get(f.sourceId), undefined);
  const writer = await f.owner.sessionPersistence.open(target.id, 'write'); const events = (await writer.read()).events; await writer.close();
  assert.equal(events.slice(target.session.inheritedEventCount).some(event => event.type === 'turn/start'), false);
  assert.deepEqual(await readFile(f.sourcePath), f.sourceBytes);
});
