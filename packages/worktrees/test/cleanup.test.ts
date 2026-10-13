import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { Agent, AgentCancelCause, CancelOptions } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SessionActivity } from '@deepseek-ai/dsh-workspace';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type { CleanupDependencies, CleanupSettings } from '../dist/cleanup.js';
import type { CleanupReceipt, ReopenReceipt } from '../dist/cleanup-store.js';
import type { RemovalIdentity } from '../dist/git.js';
import type { RecoveryInvocation, WorktreeController } from '../dist/service.js';
import type { ColdContinuationInput, ColdContinuationResult } from '../dist/sessions.js';
import type { OperationRecord, RepositoryInfo, WorktreeRecord } from '../dist/types.js';
import type { ProjectThreadBinding } from '../dist/projects.js';
import { deferred, errorCode, mockAgent, presentValue, type MutableHeader } from './owned-session-fixtures.js';
import { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset, buildForkSeed } from '@deepseek-ai/dsh-session';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { cleanupDomain } from '../dist/cleanup-store.js';
import { WorktreeCleanup, historicalWorktreeRoot } from '../dist/cleanup.js';
import { WorktreeError } from '../dist/errors.js';
import { hashValue } from '../dist/schema.js';
import { tempDirectory, tmpBase } from './helpers.js';

const storageRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'));
// Dynamic import preserves storage-domain's exact dependency instance; only construction is used.
const { Storage } = await import(pathToFileURL(storageRequire.resolve('@deepseek-ai/dsh-storage')).href) as { Storage: new (owner: Context) => unknown };
const DAY = 86400000, NOW = 100 * DAY, OID = 'a'.repeat(40), HEAD = 'b'.repeat(40), HASH = 'c'.repeat(64);
const clone = <T>(value: T): T => structuredClone(value);
const code = (expected: string) => (error: unknown) => error instanceof WorktreeError && error.code === expected;
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const abort = () => reject(new WorktreeError('CANCELLED', 'Fixture operation was cancelled.'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
type Trace = [kind: string, ...values: (string | boolean | null | undefined)[]][];
interface FixtureTable<T> {
  map: Map<string, T>;
  beforePut?: (key: string, value: T) => void | Promise<void>;
  get(key: string): T | undefined;
  entries(): IterableIterator<[string, T]>;
  put(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}
function table<T extends { phase?: string; state?: string }>(name: string, trace: Trace): FixtureTable<T> {
  const map = new Map<string, T>();
  return { map, get: (key: string) => map.has(key) ? clone(presentValue(map.get(key))) : undefined,
    *entries(): IterableIterator<[string, T]> { for (const [key, value] of map) yield [key, clone(value)]; },
    async put(key, value) { await this.beforePut?.(key, value); map.set(key, clone(value)); trace.push(['put', name, key, value.phase ?? value.state]); },
    async delete(key) { return map.delete(key); },
  };
}
interface HistoryOptions {
  cwd?: string; at?: number; createdAt?: number; origin?: MutableHeader['origin']; parentSession?: string; listed?: boolean; events?: SessionEvent[];
}
interface HistoryRow {
  header: MutableHeader;
  events: SessionEvent[];
  projections: { inbox?: { 'next-turn': unknown[]; 'next-step': unknown[] }; sessionListMetadata: { blank: boolean; lastPromptAt: number | null } };
  revision: string;
}
interface FixtureOptions { now?: number; settings?: Partial<CleanupSettings>; source?: HistoryOptions; inspectError?: string; useDefaults?: boolean }
interface WriterLease { id: string; header: MutableHeader; inheritedEventCount: number; close(): Promise<void> }
interface CleanupAgentMock {
  id: string; ctx: Context; status: string; session: { header: MutableHeader }; inbox: { nextTurn: unknown[]; nextStep: unknown[] }; claimed: boolean; drives: number;
  seed?: readonly SessionEvent[]; holdTask?: Promise<unknown>; completion?: Promise<ColdContinuationResult>;
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(cause: AgentCancelCause, options?: CancelOptions): void;
  send(value: unknown): void;
}
type CleanupAgent = CleanupAgentMock & Agent;
interface FixtureHooks {
  list?: () => void | Promise<void>;
  observe?: (row: HistoryRow, query: { projectionMode: string; signal?: AbortSignal }) => void | Promise<void>;
  open?: (id: string, signal: AbortSignal, count: number) => void | Promise<void>;
  inspect?: (guard: () => void, signal: AbortSignal) => void | Promise<void>;
  preserve?: (guard: () => void, signal: AbortSignal) => void | Promise<void>;
  beforeRemove?: (guard: () => void, signal: AbortSignal) => void | Promise<void>;
  remove?: (guard: () => void, signal: AbortSignal) => void | Promise<void>;
  switch?: (verifyOnly?: boolean) => void | Promise<void>;
  ensure?: (input: ColdContinuationInput, child: CleanupAgent) => void | Promise<void>;
  claims?: () => void | Promise<void>;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await tempDirectory('worktrees-cleanup-owned-');
  const localRoot = resolve(root, 'local'), originalFolder = resolve(localRoot, 'project'), commonDir = resolve(localRoot, '.git');
  const managedRoot = resolve(root, 'historical-managed'), id = randomUUID();
  const checkoutRoot = resolve(managedRoot, createHash('sha256').update(commonDir).digest('hex').slice(0, 24), id, `worktree-${id}`);
  await mkdir(originalFolder, { recursive: true }); await mkdir(commonDir, { recursive: true }); await mkdir(resolve(checkoutRoot, 'project'), { recursive: true });
  const trace: Trace = [], owner = new Context(), histories = new Map<string, HistoryRow>(), live = new Map<string, CleanupAgent>(), leased = new Set<WriterLease>(), targets = new Map<string, CleanupAgent>(), ensureCalls: ColdContinuationInput[] = [], policyReads: string[] = [];
  let clock = options.now ?? NOW, settings: CleanupSettings = { enabled: true, days: 10, ...options.settings }, state: 'present' | 'absent' | 'partial' | 'replaced' = 'present', disposed = 0, openCalls = 0, pendingEffects = false, spawnCalls = 0;
  const hooks: FixtureHooks = {}, resources: { jobs: { status: string }[]; schedules: { sessionId: string; status: string }[]; terminals: { state: string }[]; activity: SessionActivity[] } = { jobs: [], schedules: [], terminals: [], activity: [] };
  const worktrees = { worktrees: table<WorktreeRecord>('worktrees', trace), operations: table<OperationRecord>('operations', trace), async close() {} };
  const store = { cleanup: table<CleanupReceipt>('cleanup', trace), reopens: table<ReopenReceipt>('reopens', trace), async close() {} };
  const record: WorktreeRecord = { id, operationId: randomUUID(), repoRoot: localRoot, commonDir, projectSubdir: 'project', checkoutRoot, effectiveCwd: resolve(checkoutRoot, 'project'), remote: 'origin', remoteIdentity: 'opaque', remoteBranch: 'main', baseOid: OID, baseRef: `refs/dsh-worktrees/${id}/base`, fetchedAt: DAY, createdAt: DAY, sessionIds: [], workspaceId: randomUUID(), branch: 'old-recorded-branch', protected: false, archived: false, state: 'ready', error: null };
  worktrees.worktrees.map.set(id, clone(record));
  function history({ cwd = record.effectiveCwd, at = NOW - 20 * DAY, createdAt = 2 * DAY, origin, parentSession, listed = false, events }: HistoryOptions = {}): HistoryRow {
    const id = SessionId(randomUUID());
    const header: MutableHeader = { version: SESSION_FORMAT_VERSION, id, createdAt, cwd, isSeeded: false, ...(origin ? { origin } : {}), ...(parentSession ? { parentSession: SessionId(parentSession) } : {}) };
    const messages: SessionEvent[] = events ?? [{ type: 'user/message', seq: SessionSeq(0), time: at, surfaceOp: 'append', data: { id: randomUUID() as import('@deepseek-ai/dsh-session').UserMessage['id'], role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Retained user request' }] } }];
    const row: HistoryRow = { header, events: clone(messages), projections: { inbox: { 'next-turn': [], 'next-step': [] }, sessionListMetadata: { blank: messages.length === 0, lastPromptAt: messages.length ? at : null } }, revision: randomUUID() };
    histories.set(id, row);
    if (listed) { const current = presentValue(worktrees.worktrees.get(record.id)); current.sessionIds.push(id); worktrees.worktrees.map.set(record.id, current); }
    return row;
  }
  const source = history({ listed: true, ...options.source });
  owner.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()] });
  owner.provide('sessionQuery', {
    async listSessions(signal?: AbortSignal) { if (signal?.aborted) throw new WorktreeError('CANCELLED', 'Cancelled corpus read.'); await hooks.list?.(); return [...histories.values()].map(row => ({ header: clone(row.header) })); },
    async observeSession(id: string, query: { projectionMode: string; signal?: AbortSignal }) { assert.equal(query.projectionMode, 'all'); const row = histories.get(id); assert.ok(row); await hooks.observe?.(row, query); return { source: 'prepared', header: clone(row.header), inheritedEventCount: 0, events: clone(row.events), projections: { values: clone(row.projections) }, [Symbol.dispose]() { disposed++; trace.push(['observation-dispose', id]); } }; },
  });
  owner.provide('sessionPersistence', {
    async stat(id: string) { const row = histories.get(id) ?? (targets.has(id) ? { header: presentValue(targets.get(id)).session.header, revision: 'target' } : undefined); return row ? { header: clone(row.header), revision: row.revision } : undefined; },
    async open(id: string, access: 'write', query: { signal: AbortSignal }) {
      assert.equal(access, 'write'); openCalls++; await hooks.open?.(id, query.signal, openCalls); assert.ok(histories.has(id));
      const lease = { id, header: clone(presentValue(histories.get(id)).header), inheritedEventCount: 0, async close() { leased.delete(lease); trace.push(['lease-close', id]); } }; leased.add(lease); trace.push(['lease-open', id]); return lease;
    },
  });
  owner.provide('jobs', { list: () => clone(resources.jobs) });
  owner.provide('schedule', { async catalog() { return clone(resources.schedules); } });
  owner.provide('terminalController', { list: () => clone(resources.terminals) });
  owner.on('workspace/session-activity', async (_request, next) => resources.activity.length ? clone(resources.activity) : next());
  const modes = new Map<string, 'read-only' | 'workspace-write' | 'danger-full-access'>();
  owner.provide('sandboxPolicy', { resolve: ({ session }: { session: CleanupAgent['session'] }) => { policyReads.push(session.header.id); return { mode: modes.get(session.header.id) ?? 'read-only', workspaceRoot: session.header.cwd }; } });
  owner.provide('subprocess', { resolveExecutable() { assert.fail('Fixture must not execute scripts'); }, spawn() { spawnCalls++; assert.fail('Fixture must not spawn subprocesses'); } });
  const identity: RemovalIdentity = { checkoutRoot, sourceRoot: localRoot, commonDir, adminDir: resolve(commonDir, 'worktrees', 'fixture-admin'), head: HEAD, branch: 'actual-current-branch', checkoutIdentity: 'fixture-checkout-inode', sourceIdentity: 'fixture-source-inode', commonIdentity: 'fixture-common-inode', adminIdentity: 'fixture-admin-inode', pointerIdentity: 'fixture-pointer-inode', pointerHash: HASH, backlinkIdentity: 'fixture-backlink-inode', backlinkHash: HASH, commonPointerIdentity: 'fixture-common-pointer-inode', commonPointerHash: HASH, sourceMappingIdentity: 'fixture-source-mapping-inode', sourceMappingHash: '', privateStateHash: HASH, retainedHeads: [HEAD, 'd'.repeat(40)] };
  const repository: RepositoryInfo = { root: localRoot, commonDir, projectSubdir: 'project', head: OID, branch: 'main' };
  let removes = 0, preserves = 0, switchCalls = 0, localClaims = 0, queue: Promise<unknown> = Promise.resolve();
  const git: NonNullable<CleanupDependencies['git']> = (_record, guard, signal) => ({
    async discover(path) { guard(); trace.push(['discover', path]); return clone(repository); },
    async localBranches() { guard(); return { branchSource: 'local', currentBranch: repository.branch, defaultBranch: repository.branch ?? 'HEAD', branches: [{ name: 'main', oid: OID }, { name: 'topic', oid: HEAD }], observedAt: clock }; },
    async inspectRemoval() { guard(); await hooks.inspect?.(guard, signal); if (options.inspectError) throw new WorktreeError(options.inspectError, 'Fixture identity refuses removal.'); trace.push(['inspect']); return clone(identity); },
    async preserveRemovalHead(_record, value) { guard(); assert.deepEqual(value, identity); preserves++; trace.push(['preserve', value.head, ...value.retainedHeads]); await hooks.preserve?.(guard, signal); return `refs/dsh-worktrees/${record.id}/gc-head`; },
    async removeManagedCheckout(_record, value) { guard(); assert.deepEqual(value, identity); await hooks.beforeRemove?.(guard, signal); guard(); removes++; trace.push(['remove']); state = 'absent'; await hooks.remove?.(guard, signal); },
    async removalState(_record, sourceRoot, value) { guard(); assert.equal(sourceRoot, localRoot); assert.deepEqual(value, identity); trace.push(['removal-state', state]); return state; },
    async switchLocalBranch(path, expectedCommon, branch, oid, _signal, verifyOnly) { guard(); switchCalls++; trace.push(['switch-local', path, expectedCommon, branch, oid, verifyOnly]); await hooks.switch?.(verifyOnly); if (verifyOnly && repository.branch !== branch) throw new WorktreeError('BRANCH_CHANGED', 'Fixture no-op selection changed.'); return { head: oid, branch, dirty: true, changes: 3, untracked: 2 }; },
  });
  function agent(id: string, cwd: string, meta: Partial<MutableHeader> = {}): CleanupAgent {
    const maintenance = new AbortController(); const value: CleanupAgentMock = { id, ctx: owner, status: 'idle', session: { header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), cwd, createdAt: clock, isSeeded: true, ...meta } }, inbox: { nextTurn: [], nextStep: [] }, claimed: false, drives: 0,
      runMaintenance(task) { if (this.claimed || this.status !== 'idle') throw new WorktreeError('TARGET_BUSY', 'Not true idle.'); this.claimed = true; trace.push(['hold', id]); const hold = Promise.resolve(task(maintenance.signal)).finally(() => { this.claimed = false; trace.push(['release', id]); if (!maintenance.signal.aborted && this.inbox.nextTurn.length) this.drives++; }); this.holdTask = hold; return hold; },
      cancel(_cause, cancelOptions) { if (!cancelOptions?.keepInbox) { this.inbox.nextTurn.length = 0; this.inbox.nextStep.length = 0; } maintenance.abort(); },
      send(value) { this.inbox.nextTurn.push(value); if (!this.claimed) this.drives++; },
    }; const published = mockAgent(value); live.set(id, published); return published;
  }
  const bootstrap: NonNullable<CleanupDependencies['bootstrap']> = {
    async coldSource(id) {
      assert.equal(id, source.header.id); assert.equal(live.has(id), false); trace.push(['cold-source', id]); const row = presentValue(histories.get(id)), events = clone(row.events);
      return { sourceSessionId: id, header: clone(row.header), events, seed: events.length ? buildForkSeed(events, SessionSeq(events.length - 1)) : [], boundary: events.length ? SessionSeq(events.length - 1) : null, inheritedEventCount: SessionLogOffset(events.length), rawEventCount: events.length, syntheticEventCount: 0, model: null, preset: null, modelSelection: { next: null, lastUsed: null }, hash: hashValue({ header: row.header, events }) };
    },
    async stageColdContinuation(input) {
      ensureCalls.push(input); const receipt = presentValue(store.reopens.get(source.header.id)); assert.equal(receipt.phase, 'planned'); assert.equal(receipt.sessionId, input.sessionId); assert.match(input.sessionId, /^[a-f0-9-]{36}$/u); assert.notEqual(input.sessionId, source.header.id);
      trace.push(['ensure', input.sessionId]); let child = targets.get(input.sessionId);
      if (!child) {
        child = agent(input.sessionId, input.cwd, { parentSession: source.header.id }); child.seed = clone(input.source.seed); targets.set(child.id, child);
        const ready = deferred(), staged = deferred<ColdContinuationResult>();
        const result = { agent: child, sessionId: child.id, workspaceId: 'native-local-workspace' };
        const target = child;
        target.completion = target.runMaintenance(async signal => {
          presentValue(input.signal).addEventListener('abort', () => target.cancel({ kind: 'disposed' }, { keepInbox: true }), { once: true });
          presentValue(input.holdInput)(target, { signal, release: () => ready.resolve(), task: Promise.race([ready.promise, aborted(signal)]) });
          await input.onCreated?.(result); await hooks.ensure?.(input, target); staged.resolve(result);
          await Promise.race([ready.promise, aborted(signal)]);
          await owner.serial('agent/created', { agent: target, source: 'startup', signal });
          return result;
        });
        void target.completion.catch(error => staged.reject(error));
        return { ...await staged.promise, completion: presentValue(child.completion) };
      }
      presentValue(input.holdInput)(child); assert.equal(child.claimed, true);
      const result = { agent: child, sessionId: child.id, workspaceId: 'native-local-workspace' };
      await input.onCreated?.(result); await hooks.ensure?.(input, child); return { ...result, completion: presentValue(child.completion) };
    },
    async close() { for (const value of targets.values()) value.cancel({ kind: 'disposed' }, { keepInbox: true }); trace.push(['bootstrap-close']); },
  };
  const controller: Pick<WorktreeController, 'withRepositoryMaintenance' | 'hasPendingEffects' | 'withLocalClaims'> = {
    withRepositoryMaintenance(common, signal, task) { assert.equal(common, commonDir); const flight = queue.then(() => task(signal)); queue = flight.catch(() => undefined); return flight; },
    hasPendingEffects: () => pendingEffects,
    async withLocalClaims(roots, invocation, _task, held) { localClaims++; assert.deepEqual(roots, [localRoot]); assert.equal(invocation.agent, [...targets.values()][0]); assert.ok(held?.every(value => (value as CleanupAgent).claimed)); await hooks.claims?.(); throw new WorktreeError('LOCAL_BUSY', 'A real Local idle claim refused the switch.'); },
  };
  const projectId = randomUUID(), folderId = randomUUID(); const bindings: ProjectThreadBinding[] = [];
  const projects: NonNullable<CleanupDependencies['projects']> = { selectionForWorktree() { return { projectId, folderId, path: originalFolder }; }, folderForPath(path) { assert.equal(path, originalFolder); return { projectId, folderId, path }; }, async recordThread(value) { bindings.push(clone(value)); } };
  const config = { root: resolve(root, 'new-configured-root'), gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 1000, fetchTimeoutMs: 1000, operationTimeoutMs: 60000, maxSnapshotBytes: 1048576, maxFiles: 1000, maxRefBytes: 1048576 };
  const cleanup = new WorktreeCleanup(owner, config, worktrees, store, controller, { ...(options.useDefaults ? {} : { settings: () => clone(settings) }), now: () => clock, git, bootstrap, projects }); cleanup.start(false);
  t.after(async () => { await cleanup.close(); assert.equal(leased.size, 0); assert.equal(dirname(root), tmpBase); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: true }); });
  const invocation = (): RecoveryInvocation => ({ origin: 'ui', signal: new AbortController().signal });
  const reopen = (branch = 'main', oid = OID) => cleanup.reopen({ action: 'reopen', sourceSessionId: source.header.id, localBranch: branch, localOid: oid }, invocation());
  return { root, managedRoot, localRoot, originalFolder, record, source, histories, owner, live, leased, store, worktrees, cleanup, identity, repository, trace, hooks, resources, modes, bootstrap, bindings, ensureCalls, agent, history, config, reopen, invocation,
    get disposed() { return disposed; }, get removes() { return removes; }, get preserves() { return preserves; }, get switchCalls() { return switchCalls; }, get localClaims() { return localClaims; }, get spawnCalls() { return spawnCalls; }, get policyReads() { return policyReads; }, get targets() { return targets; },
    get settings() { return settings; }, set settings(value: CleanupSettings) { settings = value; }, get now() { return clock; }, set now(value: number) { clock = value; }, set removalState(value: 'present' | 'absent' | 'partial' | 'replaced') { state = value; }, set pendingEffects(value: boolean) { pendingEffects = value; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function receipt(f: Fixture, phase: CleanupReceipt['phase'] = 'collected'): CleanupReceipt {
  return { id: f.record.id, checkoutRoot: f.record.checkoutRoot, commonDir: f.record.commonDir, originalFolder: f.originalFolder, sourceRoot: f.localRoot, sessionIds: [f.source.header.id], phase, inactivityDays: 10, lastActivityAt: NOW - 20 * DAY, eligibleAfter: NOW - 10 * DAY, reclaimedAt: phase === 'collected' ? NOW : null, recoveryRef: `refs/dsh-worktrees/${f.record.id}/gc-head`, identity: clone(f.identity), createdAt: NOW, updatedAt: NOW, reason: null };
}
async function reclaimed(f: Fixture) { await f.cleanup.sweep(); assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'collected'); }

for (const delta of [-1, 0]) test(`messaging-only default 10-day cutoff is exact (${delta} ms), archive and dirty state are irrelevant`, async t => {
  const f = await fixture(t, { useDefaults: true, source: { at: NOW - 10 * DAY - delta } });
  const current = presentValue(f.worktrees.worktrees.get(f.record.id)); current.archived = true; f.worktrees.worktrees.map.set(current.id, current);
  // Minimal legacy title event is opaque to cleanup's messaging-only activity decoder.
  f.source.events.push({ type: 'session/title', seq: SessionSeq(1), time: NOW, data: { title: 'Opening does not reset inactivity' } } as unknown as SessionEvent);
  const original = clone(f.source); await f.cleanup.info(f.source.header.id, new AbortController().signal); // The old activity notification is intentionally dynamic and must not reset messaging time.
  (f.owner.emit as unknown as (event: 'api-session/activity', id: string) => void).call(f.owner, 'api-session/activity', f.source.header.id);
  await f.cleanup.sweep(); const row = presentValue(f.cleanup.summary(f.record.id));
  assert.equal(row.inactivityDays, 10); assert.equal(row.lastActivityAt, NOW - 10 * DAY - delta);
  assert.equal(row.phase, delta === 0 ? 'collected' : 'deferred'); assert.equal(f.removes, delta === 0 ? 1 : 0); assert.deepEqual(f.source, original); assert.equal(f.leased.size, 0); assert.ok(f.disposed > 0);
});

test('new native forks and aliases aggregate recent messaging; missing unsaved project subdirectories remain eligible', async t => {
  const f = await fixture(t); const alias = resolve(f.root, 'checkout-alias'); await symlink(f.record.checkoutRoot, alias, 'dir');
  const fork = f.history({ cwd: resolve(alias, 'missing-unsaved-subdir'), parentSession: f.source.header.id, at: NOW - 2 * DAY });
  await f.cleanup.sweep(); assert.equal(f.removes, 0); assert.equal(presentValue(f.cleanup.summary(f.record.id)).lastActivityAt, NOW - 2 * DAY);
  fork.projections.sessionListMetadata.lastPromptAt = NOW - 20 * DAY; fork.revision = randomUUID(); await f.cleanup.sweep();
  assert.equal(f.removes, 1); assert.ok(presentValue(f.store.cleanup.get(f.record.id)).sessionIds.includes(fork.header.id)); assert.equal(f.leased.size, 0);
});

test('disabled sweep is a metadata no-op for new and already-deferred candidates', async t => {
  const f = await fixture(t, { settings: { enabled: false } }); const original = clone(f.source);
  f.hooks.list = () => { assert.fail('Disabled cleanup must not scan session metadata.'); };
  await f.cleanup.sweep(); assert.equal(f.cleanup.summary(f.record.id), undefined); assert.equal(f.store.cleanup.map.size, 0); assert.equal(f.trace.length, 0); assert.equal(f.removes, 0); assert.equal(f.preserves, 0);
  f.hooks.list = undefined; f.settings = { enabled: true, days: 30 }; await f.cleanup.sweep(); const deferredReceipt = presentValue(f.store.cleanup.get(f.record.id)); assert.equal(deferredReceipt.phase, 'deferred');
  f.settings.enabled = false; f.now += DAY; f.hooks.list = () => { assert.fail('Disabled retry must not scan a deferred candidate.'); };
  await f.cleanup.sweep(); assert.deepEqual(presentValue(f.store.cleanup.get(f.record.id)), deferredReceipt); assert.deepEqual(f.source, original); assert.equal(f.removes, 0); assert.equal(f.leased.size, 0);
  f.store.cleanup.map.set(f.record.id, receipt(f, 'collected')); f.removalState = 'absent'; await f.cleanup.sweep();
  assert.equal(presentValue(f.worktrees.worktrees.get(f.record.id)).state, 'missing'); assert.equal(f.removes, 0); assert.deepEqual(f.source, original);
});

const deferCases: [string, (f: Fixture) => void, string][] = [
  ['protected', f => { const row = presentValue(f.worktrees.worktrees.get(f.record.id)); row.protected = true; f.worktrees.worktrees.map.set(row.id, row); }, 'PROTECTED'],
  ['configured cutoff', f => { f.settings.days = 30; }, 'NOT_EXPIRED'], ['jobs', f => { f.resources.jobs.push({ status: 'running' }); }, 'ACTIVE_JOB'],
  ['stopping jobs', f => { f.resources.jobs.push({ status: 'stopping' }); }, 'ACTIVE_JOB'], ['schedules', f => { f.resources.schedules.push({ sessionId: f.source.header.id, status: 'active' }); }, 'ACTIVE_SCHEDULE'],
  ['terminals', f => { f.resources.terminals.push({ state: 'running' }); }, 'ACTIVE_TERMINAL'], ['workspace activity', f => { f.resources.activity.push({ kind: 'turn' }); }, 'ACTIVE_WORK'],
  ['pending inbox', f => { presentValue(f.source.projections.inbox)['next-turn'].push({ text: 'unrun' }); }, 'PENDING_INPUT'], ['pending operations', f => { f.pendingEffects = true; }, 'PENDING_OPERATION'],
];
for (const [name, configure, reason] of deferCases) test(`${name} defers without preserving/deleting checkout or changing source history`, async t => {
  const f = await fixture(t); configure(f); const original = clone(f.source); await f.cleanup.sweep();
  assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, reason); assert.equal(f.removes, 0); assert.equal(f.preserves, 0); assert.deepEqual(f.source, original); assert.equal(f.leased.size, 0);
});

for (const status of ['idle', 'running', 'waiting']) test(`any live ${status} Agent, including a cwd alias, defers`, async t => {
  const f = await fixture(t); const alias = resolve(f.root, 'live-alias'); await symlink(f.record.checkoutRoot, alias, 'dir'); const value = f.agent(randomUUID(), resolve(alias, 'project')); // Preserve the legacy waiting-state mock as well as native idle/running states.
  (value as CleanupAgentMock).status = status;
  await f.cleanup.sweep(); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'LOADED_AGENT'); assert.equal(f.removes, 0); assert.equal(f.preserves, 0);
});

test('historical managed root is independent of current destination setting and full branch/ref/history evidence survives', async t => {
  const f = await fixture(t); assert.equal(historicalWorktreeRoot(f.record), f.managedRoot); assert.notEqual(f.config.root, f.managedRoot);
  const original = clone(f.source); await reclaimed(f); const row = presentValue(f.store.cleanup.get(f.record.id));
  assert.equal(presentValue(row.identity).branch, 'actual-current-branch'); assert.equal(presentValue(row.identity).head, HEAD); assert.deepEqual(presentValue(row.identity).retainedHeads, f.identity.retainedHeads); assert.ok(presentValue(row.recoveryRef).endsWith('/gc-head'));
  assert.equal(presentValue(f.worktrees.worktrees.get(f.record.id)).state, 'missing'); assert.deepEqual(f.source, original);
  const order = f.trace.filter(([name]) => ['preserve', 'remove'].includes(name)).map(([name]) => name); assert.deepEqual(order, ['preserve', 'remove']); assert.equal(f.leased.size, 0);
});

for (const error of ['CHECKOUT_IDENTITY_CHANGED', 'WORKTREE_LOCKED']) test(`${error} refuses forced cleanup while releasing cold writer leases`, async t => {
  const f = await fixture(t, { inspectError: error }); await f.cleanup.sweep(); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, error); assert.equal(f.preserves, 0); assert.equal(f.removes, 0); assert.equal(f.leased.size, 0);
});

test('invalid historical layout and conflicting writer leases fail closed without metadata lock files', async t => {
  const f = await fixture(t); const original = presentValue(f.worktrees.worktrees.get(f.record.id)); f.worktrees.worktrees.map.set(original.id, { ...original, checkoutRoot: resolve(f.root, 'not-managed-layout') });
  await f.cleanup.sweep(); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'UNSAFE_MANAGED_LAYOUT'); assert.equal(f.removes, 0);
  f.worktrees.worktrees.map.set(original.id, original); f.store.cleanup.map.delete(original.id); f.history();
  f.hooks.open = (_id, _signal, count) => { if (count === 2) throw new WorktreeError('WRITER_BUSY', 'Another owner holds this durable thread.'); };
  await f.cleanup.sweep(); assert.equal(presentValue(f.cleanup.summary(original.id)).phase, 'deferred'); assert.equal(f.removes, 0); assert.equal(f.leased.size, 0);
  await assert.rejects(stat(resolve(dirname(original.checkoutRoot), '.cleanup-lock')), error => errorCode(error) === 'ENOENT');
});

test('no ordinary durable backing thread defers instead of treating absent history as expired', async t => {
  const f = await fixture(t); f.source.header.origin = 'subagent'; await f.cleanup.sweep();
  assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'deferred'); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'NO_BACKING_THREAD'); assert.equal(f.removes, 0); assert.equal(f.preserves, 0);
});

test('durable pending-inbox decoding fails closed and fresh activity after writer claims blocks the effect', async t => {
  const f = await fixture(t); delete f.source.projections.inbox; f.source.events.push({ type: 'agent/inbox/spliced', seq: SessionSeq(1), time: NOW, data: { target: 'next-turn', start: 0, inserted: [] } });
  await f.cleanup.sweep(); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'INBOX_UNKNOWN'); assert.equal(f.removes, 0);
  f.source.projections.inbox = { 'next-turn': [], 'next-step': [] }; f.source.revision = randomUUID();
  f.hooks.open = () => { f.source.projections.sessionListMetadata.lastPromptAt = NOW; f.source.revision = randomUUID(); };
  await f.cleanup.sweep(); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'ACTIVITY_CHANGED'); assert.equal(f.removes, 0); assert.equal(f.leased.size, 0);
});

test('final admission guard catches settings changes before an irreversible effect', async t => {
  const f = await fixture(t); f.hooks.beforeRemove = guard => { f.settings.enabled = false; guard(); };
  await f.cleanup.sweep(); assert.equal(f.removes, 0); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'CLEANUP_CHANGED'); assert.equal(f.leased.size, 0);
});

test('sweep coalesces in flight and cancellation drains every previously opened cold writer lease', async t => {
  const f = await fixture(t); f.history(); const entered = deferred();
  f.hooks.open = async (_id, signal, count) => { if (count === 2) { entered.resolve(); await aborted(signal); } };
  const first = f.cleanup.sweep(); const second = f.cleanup.sweep(); assert.equal(first, second); await entered.promise; assert.equal(f.leased.size, 1);
  await f.cleanup.close(); await first; assert.equal(f.removes, 0); assert.equal(f.leased.size, 0); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'CANCELLED');
});

test('failed collected receipt reconciles exact removal identity without repeating deletion, even when cleanup is disabled', async t => {
  const f = await fixture(t); let fail = true;
  f.store.cleanup.beforePut = (_key, row) => { if (row.phase === 'collected' && fail) { fail = false; throw Error('injected receipt failure'); } };
  await f.cleanup.sweep(); assert.equal(f.removes, 1); assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'recovery-required'); assert.equal(f.leased.size, 0);
  f.settings.enabled = false; await f.cleanup.sweep(); assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'collected'); assert.equal(f.removes, 1); assert.equal(presentValue(f.worktrees.worktrees.get(f.record.id)).state, 'missing');
});

for (const phase of ['removing', 'recovery-required'] as const) test(`${phase} restart reconciliation refuses partial or replaced state instead of retrying destructive effects`, async t => {
  const f = await fixture(t); f.store.cleanup.map.set(f.record.id, receipt(f, phase)); f.removalState = 'partial';
  await f.cleanup.sweep(); assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'recovery-required'); assert.equal(presentValue(presentValue(f.cleanup.summary(f.record.id)).reason).code, 'REMOVAL_UNCERTAIN'); assert.equal(f.removes, 0);
  f.removalState = 'replaced'; await f.cleanup.sweep(); assert.equal(f.removes, 0); assert.equal(presentValue(f.cleanup.summary(f.record.id)).phase, 'recovery-required');
});

test('collected historical cwd admission fails before publication while unrelated ENOENT is not presented as reclaimed', async t => {
  const f = await fixture(t); await reclaimed(f); const old = f.agent(randomUUID(), resolve(f.record.checkoutRoot, 'missing-project'));
  await assert.rejects(f.owner.serial('agent/created', { agent: old, source: 'resume' }), code('WORKTREE_RECLAIMED')); f.live.delete(old.id);
  const unrelated = f.agent(randomUUID(), resolve(f.root, 'unrelated-missing-directory'));
  await assert.rejects(f.owner.serial('agent/created', { agent: unrelated, source: 'resume' }), error => errorCode(error) !== 'WORKTREE_RECLAIMED'); f.live.delete(unrelated.id);
});

test('first reopen requires an explicit Local branch; dirty same-branch Local uses strict verify-only and immutable source history', async t => {
  const f = await fixture(t); const original = clone(f.source); await reclaimed(f);
  assert.throws(() => f.cleanup.reopen({ action: 'reopen', sourceSessionId: f.source.header.id }, f.invocation()), /requires localBranch/u);
  const result = await f.reopen(); assert.notEqual(result.sessionId, f.source.header.id); assert.equal(result.cwd, f.originalFolder); assert.equal(result.branch, 'main');
  assert.equal(presentValue(f.trace.find(([name]) => name === 'switch-local')).at(-1), true); assert.equal(f.localClaims, 0); assert.equal(f.policyReads.length, 0); assert.equal(f.spawnCalls, 0); assert.deepEqual(f.source, original);
  assert.deepEqual(f.bindings, [{ sessionId: result.sessionId, projectId: presentValue(f.bindings[0]).projectId, folderId: presentValue(f.bindings[0]).folderId, mode: 'local', effectiveCwd: f.originalFolder }]);
  const target = presentValue(f.targets.get(result.sessionId)); await target.holdTask; assert.equal(target.claimed, false); assert.deepEqual(target.seed, presentValue(f.ensureCalls[0]).source.seed);
  assert.equal(f.trace.filter(([kind]) => kind === 'hold').length, 1, 'factory initialization is the only claim; setup and publication cannot nest another');
  const readyAt = f.trace.findIndex(([kind, table, , phase]) => kind === 'put' && table === 'reopens' && phase === 'ready');
  assert.ok(readyAt < f.trace.findIndex(([kind]) => kind === 'release'), 'ready is journaled before factory input is released');
});

test('parallel duplicate opens use one prejournaled target UUID and ready redirects never recreate or resolve old Agent', async t => {
  const f = await fixture(t); await reclaimed(f); const [first, second] = await Promise.all([f.reopen(), f.reopen()]);
  assert.equal(first.sessionId, second.sessionId); assert.equal(f.ensureCalls.length, 1); assert.equal(f.targets.size, 1);
  const planned = f.trace.findIndex(([kind, table, key, phase]) => kind === 'put' && table === 'reopens' && key === f.source.header.id && phase === 'planned');
  assert.ok(planned >= 0 && planned < f.trace.findIndex(([kind]) => kind === 'ensure'));
  const info = await f.cleanup.info(f.source.header.id, new AbortController().signal); assert.equal(info.continuationSessionId, first.sessionId);
  const redirected = await f.cleanup.info(first.sessionId, new AbortController().signal); assert.equal(redirected.continuationSessionId, first.sessionId);
  assert.equal((await f.reopen()).sessionId, first.sessionId); assert.equal(f.ensureCalls.length, 1);
});

test('different branch uses actual target policy and Local idle claims; failure retains same held target and its queued input', async t => {
  const f = await fixture(t); await reclaimed(f);
  f.hooks.ensure = (_input, child) => { child.send({ id: 'parked', text: 'Do not start until branch choice is ready' }); assert.equal(child.drives, 0); };
  await assert.rejects(f.reopen('topic', HEAD), code('FULL_ACCESS_REQUIRED')); const pending = presentValue(f.store.reopens.get(f.source.header.id)), child = presentValue(f.targets.get(pending.sessionId));
  assert.equal(pending.phase, 'recovery-required'); assert.equal(child.claimed, true); assert.equal(child.drives, 0); assert.equal(child.inbox.nextTurn.length, 1); assert.equal(f.localClaims, 0); assert.deepEqual(f.policyReads, [child.id]);
  const info = await f.cleanup.info(f.source.header.id, new AbortController().signal); assert.equal(info.pendingSessionId, child.id);
  f.modes.set(child.id, 'danger-full-access'); f.hooks.ensure = undefined;
  await assert.rejects(f.reopen('topic', HEAD), code('LOCAL_BUSY')); assert.equal(f.localClaims, 1); assert.equal(f.targets.size, 1); assert.equal(presentValue(f.store.reopens.get(f.source.header.id)).sessionId, child.id); assert.equal(child.inbox.nextTurn.length, 1); assert.equal(child.drives, 0);
  await f.reopen('main', OID); await child.holdTask; assert.equal(child.claimed, false); assert.equal(child.inbox.nextTurn.length, 1); assert.equal(child.drives, 1); assert.equal(f.spawnCalls, 0);
});

test('READY is a durable commitment, not downgraded when a later factory listener rejects publication', async t => {
  const f = await fixture(t); await reclaimed(f); let armed = true;
  f.owner.on('agent/created', ({ agent }) => { if (armed && agent.session.header.parentSession === f.source.header.id) { armed = false; throw Error('Post-commit publication failure'); } return undefined; });
  await assert.rejects(f.reopen(), code('CONTINUATION_PUBLICATION_FAILED'));
  const row = presentValue(f.store.reopens.get(f.source.header.id)); assert.equal(row.phase, 'ready'); assert.equal(row.localBranch, 'main'); assert.ok(row.workspaceId);
  assert.equal((await f.cleanup.info(f.source.header.id, new AbortController().signal)).continuationSessionId, row.sessionId);
  assert.equal((await f.reopen('topic', HEAD)).sessionId, row.sessionId); assert.equal(f.ensureCalls.length, 1); assert.equal(f.switchCalls, 1);
  const phases = f.trace.filter(([kind, name]) => kind === 'put' && name === 'reopens').map(([, , , phase]) => phase);
  assert.deepEqual(phases.slice(phases.indexOf('ready')), ['ready']);
});

test('failed READY storage does not release input or treat the in-memory ready candidate as committed', async t => {
  const f = await fixture(t); await reclaimed(f); let fail = true;
  f.store.reopens.beforePut = (_id, row) => { if (fail && row.phase === 'ready') { fail = false; throw Error('Ready journal write failed'); } };
  f.hooks.ensure = (_input, child) => child.send({ id: 'parked-on-precommit-failure' });
  await assert.rejects(f.reopen(), /Ready journal write failed/u);
  const row = presentValue(f.store.reopens.get(f.source.header.id)), child = presentValue(f.targets.get(row.sessionId));
  assert.equal(row.phase, 'recovery-required'); assert.equal(child.claimed, true); assert.equal(child.drives, 0);
  assert.equal((await f.cleanup.info(f.source.header.id, new AbortController().signal)).pendingSessionId, child.id);
  f.hooks.ensure = undefined; const result = await f.reopen(); await child.holdTask;
  assert.equal(result.sessionId, row.sessionId); assert.equal(child.drives, 1); assert.equal(f.targets.size, 1);
});

test('real JSON companion domain persists exact cleanup and redirect receipts, including directory sourceMappingHash absence', async t => {
  const f = await fixture(t); await reclaimed(f); const reopened = await f.reopen(); const sourceBefore = clone(f.source);
  new Storage(f.owner); const backend = new JsonStorageBackend(resolve(f.root, 'receipt-storage')); f.owner.storage.backend.register('fixture-json', backend);
  const facility = new DomainFacility(f.owner, { backend: 'fixture-json' }); let domain: Domain<typeof cleanupDomain> | undefined;
  try {
    domain = await facility.open(cleanupDomain); const cleanupReceipt = presentValue(f.store.cleanup.get(f.record.id)), reopenReceipt = presentValue(f.store.reopens.get(f.source.header.id));
    assert.equal(presentValue(cleanupReceipt.identity).sourceMappingHash, ''); await domain.table('cleanup').put(f.record.id, cleanupReceipt); await domain.table('reopens').put(f.source.header.id, reopenReceipt); await domain.close();
    domain = await facility.open(cleanupDomain); assert.deepEqual(domain.table('cleanup').get(f.record.id), cleanupReceipt); assert.deepEqual(domain.table('reopens').get(f.source.header.id), reopenReceipt);
    assert.equal(presentValue(domain.table('reopens').get(f.source.header.id)).sessionId, reopened.sessionId); assert.deepEqual(f.source, sourceBefore);
  } finally { await domain?.close(); await facility.closeAll(); await backend.close(); }
});

test('lifecycle wait wakes on durable state changes and abort/shutdown drain without resetting activity', async t => {
  const f = await fixture(t); const first = await f.cleanup.info(f.source.header.id, new AbortController().signal), original = clone(f.source);
  const waited = f.cleanup.wait(f.source.header.id, first.revision, new AbortController().signal); await f.cleanup.sweep(); assert.ok((await waited).revision > first.revision); assert.deepEqual(f.source, original);
  const next = await f.cleanup.info(f.source.header.id, new AbortController().signal), abort = new AbortController(); const cancelled = f.cleanup.wait(f.source.header.id, next.revision, abort.signal); abort.abort(); await assert.rejects(cancelled, code('CANCELLED'));
  const closing = f.cleanup.wait(f.source.header.id, next.revision, new AbortController().signal); const rejected = assert.rejects(closing, code('CANCELLED')); await f.cleanup.close(); await rejected;
});
