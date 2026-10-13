import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Agent, AgentCancelCause, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import type { CreateSessionOptions, Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import type { Scope } from '@deepseek-ai/dsh-scope';
import type { ColdContinuationInput, ColdContinuationResult, ColdFactoryHold } from '../dist/sessions.js';
import type { SessionSettings } from '../dist/types.js';
import { appendSessionTitle, mockAgent, presentValue, type MutableHeader } from './owned-session-fixtures.js';
import { GoalId } from '@deepseek-ai/dsh-goal';
import { CommandId } from '@deepseek-ai/dsh-commands';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId, interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionBootstrap } from '../dist/sessions.js';
import { WorktreeError } from '../dist/errors.js';
import { tempDirectory, tmpBase } from './helpers.js';

const model = { provider: 'github-copilot', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const lastModel = { provider: 'github-copilot', model: 'previous-model' };
type InboxProjection = { 'next-turn': UserMessage[]; 'next-step': UserMessage[] };
interface ProjectionValues { inbox?: InboxProjection; modelSelection?: { next: SessionSettings['model']; lastUsed: SessionSettings['model'] }; agentPreset?: string }
interface PersistedSession { header: MutableHeader; events: SessionEvent[]; inheritedEventCount: SessionLogOffset; projections: ProjectionValues }
interface FixtureBehavior { flushFailure?: boolean; createdFailure?: boolean; synthetic?: boolean; durability?: boolean }
const emptyInbox = (): InboxProjection => ({ 'next-turn': [], 'next-step': [] });
const code = (value: string) => (error: unknown) => error instanceof WorktreeError && error.code === value;
const message: UserMessage = { id: 'pending-message' as UserMessage['id'], role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'unrun work' }] };

async function fixture(t: TestContext, behavior: FixtureBehavior = {}) {
  const root = await tempDirectory('worktrees-cold-owned-'); const cwd = resolve(root, 'local');
  await mkdir(cwd); const owner = new Context(); new SessionStore(owner);
  const live = new Map<string, ReturnType<typeof makeAgent>>(); const persisted = new Map<string, PersistedSession>(); const scopes: Scope[] = []; const scopesById = new Map<string, Scope>(); const created: CreateAgentOptions[] = []; const resumed: ResumeAgentOptions[] = []; const lifecycle: [string, ...unknown[]][] = []; const queries: [string, { projectionMode: string }][] = [];
  let disposed = 0; let flushFailure = behavior.flushFailure; let createdFailure = behavior.createdFailure;
  const defaultProjection = { inbox: emptyInbox(), modelSelection: { next: null, lastUsed: null }, agentPreset: 'selected-preset' };
  const source = owner.sessions.create(SessionId(randomUUID()), { meta: { cwd: resolve(root, 'collected-missing-cwd'), agentPreset: 'old-header-preset' } });
  function save(session: Session, projections: ProjectionValues = defaultProjection): PersistedSession {
    const record = { header: structuredClone(session.header), events: structuredClone([...session.snapshotEvents()]), inheritedEventCount: session.inheritedEventCount, projections: structuredClone(projections) };
    persisted.set(session.id, record); return record;
  }
  save(source);
  owner.provide('sessionQuery', { async observeSession(id: string, options: { projectionMode: string }) {
    queries.push([id, options]); const agent = live.get(id); const record = agent ? save(agent.session, agent.projections) : persisted.get(id);
    if (!record) throw Error('missing persisted session');
    const events = structuredClone(record.events);
    if (!agent && behavior.synthetic !== false) events.push(...interruptedTurnClosers(events));
    return { source: agent ? 'live' : 'prepared', header: structuredClone(record.header), inheritedEventCount: record.inheritedEventCount, events, cursor: events.at(-1)?.seq ?? -1, projections: { asOfSeq: events.at(-1)?.seq ?? -1, values: structuredClone(record.projections) }, [Symbol.dispose]() { disposed++; } };
  } });
  owner.provide('sessionPersistence', {
    async stat(id: string) { const record = persisted.get(id); return record ? { header: record.header, revision: 'fixture-revision', eventCount: record.events.length } : undefined; },
    async open(id: string, access: 'read') {
      assert.equal(access, 'read'); const record = persisted.get(id); if (!record) throw Error('missing persisted session');
      lifecycle.push(['read-open', id]);
      return { id, header: structuredClone(record.header), inheritedEventCount: record.inheritedEventCount, access, async read() { return { eventState: 'detached', events: structuredClone(record.events) }; }, async close() { lifecycle.push(['read-close', id]); } };
    },
  });
  owner.provide('agentPresets', { async resolve(id?: string) { lifecycle.push(['resolve-preset', id]); return { id: id ?? 'current-default-preset' }; }, async mount(_ctx: Context, id: string) { lifecycle.push(['mount-preset', id]); } });
  const workspaceId = randomUUID();
  owner.provide('workspaceRegistry', { async create(path: string) { assert.equal(path, cwd); lifecycle.push(['workspace', path]); return { id: workspaceId, path, async attachSession(id: string) { lifecycle.push(['attach', id]); } }; } });
  // Reading old operation policies or creator/global options would be a settings-widening bug.
  for (const name of ['sandboxPolicy', 'approval', 'llm', 'planMode', 'goals']) owner.provide(name, new Proxy({}, { get() { throw Error(`${name} must not be consulted or driven by cold recovery`); } }));
  function makeAgent(id: string, seed: readonly SessionEvent[] | undefined, inheritedEventCount: SessionLogOffset | undefined, meta: CreateSessionOptions['meta'], options: AgentOptions = {}, projections: ProjectionValues) {
    const key = { id, options, status: 'idle', projections: structuredClone(projections), inbox: { nextTurn: structuredClone(projections.inbox?.['next-turn'] ?? []) as (UserMessage | string)[], nextStep: structuredClone(projections.inbox?.['next-step'] ?? []) as UserMessage[], clear() { lifecycle.push(['clear-child', id]); this.nextTurn.length = 0; this.nextStep.length = 0; } }, cancel(cause: AgentCancelCause) { lifecycle.push(['cancel', id, cause.kind]); }, async whenIdle() {} };
    const scope = createScope(owner, key); scopes.push(scope); scopesById.set(id, scope);
    const agent = mockAgent(Object.assign(key, { ctx: scope.ctx, session: scope.ctx.sessions.create(SessionId(id), { seed, inheritedEventCount, meta }) }));
    live.set(id, agent);
    if (behavior.durability !== false) scope.ctx.on('session/flush', session => { lifecycle.push(['flush', session.id]); if (flushFailure) throw Error('durability failure'); save(session, agent.projections); });
    return agent;
  }
  function handle(agent: ReturnType<typeof makeAgent>) { return { agent, async dispose() { live.delete(agent.id); lifecycle.push(['dispose', agent.id]); } }; }
  owner.provide('agents', {
    get: (id: string) => live.get(id), list: () => [...live.values()],
    async create(options: CreateAgentOptions) {
      created.push(options); if (createdFailure) throw Error('unknown create effect');
      const sourceRecord = persisted.get(presentValue(presentValue(options.meta).parentSession));
      const agent = makeAgent(options.sessionId, options.seed, options.inheritedEventCount, options.meta, options.agentOptions, presentValue(sourceRecord).projections);
      agent.inbox.nextTurn.push('preset-input'); await presentValue(options.setup)(agent.ctx, agent);
      await owner.serial('agent/created', { agent, source: 'startup', signal: options.signal ?? new AbortController().signal });
      lifecycle.push(['published', agent.id]); save(agent.session, agent.projections); return handle(agent);
    },
    async resume(options: ResumeAgentOptions) {
      resumed.push(options); const record = persisted.get(options.resumeSessionId);
      assert.ok(record); assert.notEqual(options.resumeSessionId, source.id);
      const agent = makeAgent(options.resumeSessionId, record.events, record.inheritedEventCount, record.header, options.agentOptions, record.projections);
      await presentValue(options.setup)(agent.ctx, agent);
      await owner.serial('agent/created', { agent, source: 'resume', signal: options.signal ?? new AbortController().signal });
      lifecycle.push(['resumed', agent.id]); return handle(agent);
    },
  });
  const bootstrap = new SessionBootstrap(owner);
  t.after(async () => { await bootstrap.close(); for (const scope of scopes) await scope.dispose(); assert.equal(dirname(root), tmpBase); assert.equal(await realpath(root), root); await rm(root, { recursive: true, force: true }); });
  return { root, owner, bootstrap, source, cwd, created, resumed, live, persisted, lifecycle, queries, save, async loseAgent(id: string) { live.delete(id); await presentValue(scopesById.get(id)).dispose(); }, get disposed() { return disposed; }, set flushFailure(value: boolean) { flushFailure = value; }, set createdFailure(value: boolean) { createdFailure = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function closedHistory(f: Fixture) {
  f.source.append('turn/start', { turn: 1 }); f.source.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  appendSessionTitle(f.source, { title: 'Latest idle title', messageSeqs: [], source: { kind: 'user' } });
  f.source.append('sandbox/mode', { mode: 'read-only' }); f.source.append('approval/policy', { policy: 'ask' });
  f.source.append('plan/mode', { active: true }); f.source.append('model/selection', model);
  f.source.append('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { id: GoalId(randomUUID()), revision: 1, objective: 'Preserved, not rearmed', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 1, updatedAt: 1 });
  f.source.append('agent-preset/selected', { agentPreset: 'selected-preset' });
  return f.save(f.source, { inbox: emptyInbox(), modelSelection: { next: model, lastUsed: lastModel }, agentPreset: 'selected-preset' });
}
async function coldInput(f: Fixture): Promise<ColdContinuationInput> { return { sessionId: randomUUID(), cwd: f.cwd, title: 'Local continuation', source: await f.bootstrap.coldSource(f.source.id) }; }

test('cold source keeps the whole idle log, projected intent and detached evidence without a live source', async t => {
  const f = await fixture(t); const record = closedHistory(f); const before = structuredClone(record);
  const source = await f.bootstrap.coldSource(f.source.id);
  assert.equal(f.live.has(f.source.id), false); assert.deepEqual(source.header, before.header); assert.deepEqual(source.events, before.events);
  assert.equal(source.boundary, before.events.length - 1); assert.equal(source.inheritedEventCount, before.events.length); assert.equal(source.rawEventCount, before.events.length); assert.equal(source.syntheticEventCount, 0);
  assert.deepEqual(source.model, model); assert.deepEqual(source.modelSelection, { next: model, lastUsed: lastModel }); assert.equal(source.preset, 'selected-preset');
  const endSeed = presentValue(source.seed.at(-1)); assert.ok(endSeed.type === 'session/end-seed'); assert.equal(endSeed.type, 'session/end-seed'); assert.equal(endSeed.data.inherited, true);
  const repeated = await f.bootstrap.coldSource(f.source.id); assert.equal(repeated.hash, source.hash);
  source.header.cwd = '/mutated-copy'; const first = presentValue(source.events[0]); assert.ok(first.type === 'turn/start'); first.data.turn = 42; assert.deepEqual(presentValue(f.persisted.get(f.source.id)), before);
  assert.equal(f.disposed, 2); assert.ok(f.queries.every(([, options]) => options.projectionMode === 'all'));
});

test('cold create uses exact preallocated ID, full seed, selected preset and no extra policy/message/goal events', async t => {
  const f = await fixture(t); const old = structuredClone(closedHistory(f)); const input = await coldInput(f); let identity: ColdContinuationResult | undefined;
  input.onCreated = async result => { identity = result; f.lifecycle.push(['receipt', result.sessionId]); };
  const result = await f.bootstrap.createColdContinuation(input); const options = presentValue(f.created[0]);
  assert.equal(result.sessionId, input.sessionId); assert.ok(identity); assert.equal(identity.sessionId, input.sessionId); assert.equal(options.sessionId, input.sessionId);
  assert.equal(options.parentAgent, undefined); assert.equal(presentValue(options.meta).cwd, f.cwd); assert.equal(presentValue(options.meta).parentSession, f.source.id); assert.equal(presentValue(options.meta).isSeeded, true); assert.equal(presentValue(options.meta).agentPreset, 'selected-preset');
  assert.equal(options.inheritedEventCount, old.events.length); assert.deepEqual(options.seed, input.source.seed); assert.deepEqual(options.agentOptions, model);
  assert.deepEqual(presentValue(f.persisted.get(result.sessionId)).events, input.source.seed); assert.deepEqual(presentValue(f.persisted.get(f.source.id)), old); assert.deepEqual(result.agent.inbox.nextTurn, []);
  assert.deepEqual(f.lifecycle.filter(([kind]) => ['published', 'receipt', 'attach', 'flush'].includes(kind)).map(([kind]) => kind), ['published', 'receipt', 'attach', 'flush']);
  assert.ok(f.lifecycle.some(([kind, id]) => kind === 'mount-preset' && id === 'selected-preset')); assert.equal(f.resumed.length, 0);
});

test('blank continuation honestly has zero inherited events and current preset defaults without guessed overrides', async t => {
  const f = await fixture(t); const record = presentValue(f.persisted.get(f.source.id)); delete record.header.agentPreset; record.projections = { inbox: emptyInbox(), modelSelection: { next: null, lastUsed: null } };
  const input = await coldInput(f); assert.equal(input.source.boundary, null); assert.equal(input.source.inheritedEventCount, 0); assert.deepEqual(input.source.seed, []); assert.equal(input.source.model, null); assert.equal(input.source.preset, 'current-default-preset');
  const result = await f.bootstrap.createColdContinuation(input);
  assert.equal(result.agent.session.header.isSeeded, true); assert.equal(result.agent.session.header.parentSession, f.source.id);
  assert.deepEqual(presentValue(f.created[0]).agentOptions, {}); assert.deepEqual(presentValue(f.persisted.get(result.sessionId)).events.map(e => e.type), ['session/end-seed']);
  const endSeed = presentValue(presentValue(f.persisted.get(result.sessionId)).events[0]); assert.ok(endSeed.type === 'session/end-seed'); assert.equal(endSeed.data.inherited, true);
  const adopted = await f.bootstrap.ensureColdContinuation(input); assert.equal(adopted.agent, result.agent); assert.equal(f.created.length, 1);
});

test('configuration-only history needs no completed turn, retains explicit policies and projected last-used model', async t => {
  const f = await fixture(t);
  f.source.append('sandbox/mode', { mode: 'workspace-write' }); f.source.append('approval/policy', { policy: 'never' }); appendSessionTitle(f.source, { title: 'Not started', messageSeqs: [], source: { kind: 'user' } });
  const original = structuredClone(f.save(f.source, { inbox: emptyInbox(), modelSelection: { next: null, lastUsed: lastModel }, agentPreset: 'selected-preset' }));
  const input = await coldInput(f); assert.equal(input.source.inheritedEventCount, 3); assert.deepEqual(input.source.model, lastModel);
  const result = await f.bootstrap.createColdContinuation(input); assert.deepEqual(presentValue(f.created[0]).agentOptions, lastModel);
  assert.deepEqual(presentValue(f.persisted.get(result.sessionId)).events.slice(0, 3), original.events);
  assert.ok(!presentValue(f.persisted.get(result.sessionId)).events.some(event => event.type === 'turn/start' || event.type === 'user/message'));
  assert.deepEqual(presentValue(f.persisted.get(f.source.id)), original);
});

test('missing cold durability listener fails after exact identity receipt and attachment without dropping the handle', async t => {
  const f = await fixture(t, { durability: false }); const input = await coldInput(f); let identity: ColdContinuationResult | undefined;
  input.onCreated = async result => { identity = result; };
  await assert.rejects(f.bootstrap.createColdContinuation(input), code('MISSING_DURABILITY_BARRIER')); assert.ok(identity); assert.equal(identity.sessionId, input.sessionId); assert.equal(f.live.get(input.sessionId), identity.agent);
  assert.ok(f.lifecycle.some(([kind, id]) => kind === 'attach' && id === input.sessionId));
  await f.bootstrap.close(); assert.equal(f.live.has(input.sessionId), false);
});

test('cold reads label synthetic interrupted closers and preserve them without writing old raw tail', async t => {
  const f = await fixture(t); f.source.append('turn/start', { turn: 1 }); f.source.append('step/start', { turn: 1, step: 1 }); const raw = structuredClone(f.save(f.source));
  const input = await coldInput(f); assert.equal(input.source.rawEventCount, 2); assert.equal(input.source.syntheticEventCount, 2);
  const tail = presentValue(input.source.events.at(-1)); assert.ok(tail.type === 'turn/end'); assert.equal(tail.data.reason.kind, 'interrupted');
  await f.bootstrap.createColdContinuation(input); assert.deepEqual(presentValue(f.persisted.get(f.source.id)), raw); assert.equal(presentValue(presentValue(presentValue(f.created[0]).seed).find(e => e.type === 'turn/end')).data.reason.kind, 'interrupted');
});

test('cold source rejects live, subagent, pending, unavailable inbox/model/preset decoding and corrupt sources with disposal', async t => {
  const f = await fixture(t); const record = presentValue(f.persisted.get(f.source.id));
  // A presence-only malformed live registry entry must be rejected before it is inspected.
  f.live.set(f.source.id, {} as ReturnType<Fixture['live']['get']> & object); await assert.rejects(f.bootstrap.coldSource(f.source.id), code('SOURCE_BUSY')); f.live.delete(f.source.id);
  record.header.origin = 'subagent'; await assert.rejects(f.bootstrap.coldSource(f.source.id), code('SUBAGENT_SOURCE')); delete record.header.origin;
  presentValue(record.projections.inbox)['next-turn'].push(message); await assert.rejects(f.bootstrap.coldSource(f.source.id), code('SOURCE_BUSY')); record.projections.inbox = emptyInbox();
  f.source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] }); f.save(f.source, {});
  await assert.rejects(f.bootstrap.coldSource(f.source.id), code('UNKNOWN_SOURCE_INBOX'));
  presentValue(presentValue(f.persisted.get(f.source.id)).events[0]).seq = SessionSeq(5); await assert.rejects(f.bootstrap.coldSource(f.source.id), /contiguous|seq/);
  assert.equal(f.disposed, 4);
  f.persisted.set(f.source.id, { ...record, events: [{ type: 'model/selection', seq: SessionSeq(0), time: 1, data: model }], projections: { inbox: emptyInbox() } });
  await assert.rejects(f.bootstrap.coldSource(f.source.id), code('UNKNOWN_SOURCE_MODEL'));
  presentValue(f.persisted.get(f.source.id)).events = [{ type: 'agent-preset/selected', seq: SessionSeq(0), time: 1, data: { agentPreset: 'different' } }];
  await assert.rejects(f.bootstrap.coldSource(f.source.id), code('UNKNOWN_SOURCE_PRESET'));
});

test('a genuinely open observed tail is refused rather than silently cut at the last turn', async t => {
  const f = await fixture(t, { synthetic: false }); f.source.append('turn/start', { turn: 1 }); f.save(f.source);
  await assert.rejects(f.bootstrap.coldSource(f.source.id), code('SESSION_CHANGED')); assert.equal(f.created.length, 0); assert.equal(f.disposed, 1);
});

test('durability failure retains exact created identity and retry adopts it instead of duplicating', async t => {
  const f = await fixture(t, { flushFailure: true }); closedHistory(f); const input = await coldInput(f); let identity: ColdContinuationResult | undefined;
  input.onCreated = async value => { identity = value; };
  await assert.rejects(f.bootstrap.createColdContinuation(input), /durability failure/); assert.ok(identity); assert.equal(identity.sessionId, input.sessionId); assert.equal(f.live.get(input.sessionId), identity.agent);
  f.flushFailure = false; const adopted = await f.bootstrap.ensureColdContinuation(input); assert.equal(adopted.agent, identity.agent); assert.equal(f.created.length, 1); assert.equal(f.resumed.length, 0);
  await f.bootstrap.close(); assert.equal(f.live.has(input.sessionId), false); assert.ok(f.persisted.has(f.source.id));
});

test('callback failure before attachment can be adopted with the same ID and immutable source', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f);
  input.onCreated = async () => { throw Error('receipt failure'); };
  await assert.rejects(f.bootstrap.createColdContinuation(input), /receipt failure/); assert.equal(f.created.length, 1); assert.equal(f.lifecycle.some(([kind]) => kind === 'attach'), false);
  delete input.onCreated; await f.bootstrap.ensureColdContinuation(input); assert.equal(f.created.length, 1);
});

test('persisted adoption resumes only the new exact identity after checking seed, directory and lineage', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input);
  // Simulate loss of the exact Agent scope, retaining only its durable header/log.
  await f.loseAgent(child.sessionId); assert.equal(f.owner.sessions.get(SessionId(child.sessionId)), undefined);
  const result = await f.bootstrap.adoptColdContinuation(input); const resumedOptions = presentValue(f.resumed[0]);
  assert.equal(result.sessionId, input.sessionId); assert.notEqual(result.agent, child.agent); assert.equal(resumedOptions.resumeSessionId, input.sessionId); assert.equal(resumedOptions.parentAgent, undefined); assert.deepEqual(resumedOptions.agentOptions, model); assert.equal(f.created.length, 1); assert.deepEqual(presentValue(f.persisted.get(f.source.id)).events, input.source.events);
});

test('adoption preserves target permission, model, preset, plan, title and goal edits rather than reapplying source settings', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input);
  const selectedModel = { provider: 'github-copilot', model: 'target-selected-model', reasoningEffort: 'medium' };
  child.agent.session.append('sandbox/mode', { mode: 'workspace-write' }); child.agent.session.append('approval/policy', { policy: 'never' }); child.agent.session.append('plan/mode', { active: false });
  child.agent.session.append('model/selection', selectedModel); child.agent.session.append('agent-preset/selected', { agentPreset: 'target-user-preset' });
  appendSessionTitle(child.agent.session, { title: 'User renamed target', messageSeqs: [], source: { kind: 'user' } });
  const inheritedChange = presentValue(input.source.events.find(event => event.type === 'goal/change')).data; assert.ok('goal' in inheritedChange);
  const inheritedGoal = inheritedChange.goal;
  child.agent.session.append('goal/change', { kind: 'goal/change', version: 1, operation: 'edit', goal: { ...inheritedGoal, revision: inheritedGoal.revision + 1, objective: 'Target choice retained, not rearmed', maxGoalRounds: 8 }, roundsStarted: 0, createdAt: 1, updatedAt: 2 });
  const fixtureChild = presentValue(f.live.get(child.sessionId)); presentValue(fixtureChild.projections.modelSelection).next = selectedModel; fixtureChild.projections.agentPreset = 'target-user-preset';
  const target = structuredClone(f.save(child.agent.session, presentValue(f.live.get(child.sessionId)).projections));
  const liveAdopted = await f.bootstrap.adoptColdContinuation(input); assert.equal(liveAdopted.agent, child.agent); assert.deepEqual(presentValue(f.persisted.get(child.sessionId)).events, target.events);
  await f.loseAgent(child.sessionId); const result = await f.bootstrap.adoptColdContinuation(input);
  assert.deepEqual(presentValue(f.resumed[0]).agentOptions, selectedModel); assert.ok(f.lifecycle.some(([kind, id]) => kind === 'mount-preset' && id === 'target-user-preset'));
  assert.deepEqual(presentValue(f.persisted.get(result.sessionId)).events, target.events); assert.deepEqual(presentValue(f.persisted.get(f.source.id)).events, input.source.events);
  assert.equal(f.created.length, 1); assert.equal(f.resumed.length, 1);
});

test('adoption refuses conflicting cwd, lineage, inherited count, seed, projected intent or progressed execution', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input); f.live.delete(child.sessionId);
  const original = structuredClone(presentValue(f.persisted.get(child.sessionId)));
  const conflicts: ((value: PersistedSession) => void)[] = [
    value => { value.header.cwd = resolve(f.root, 'other'); }, value => { value.header.parentSession = SessionId(randomUUID()); },
    value => { value.inheritedEventCount = SessionLogOffset(value.inheritedEventCount - 1); }, value => { const first = presentValue(value.events[0]); assert.ok(first.type === 'turn/start'); first.data.turn = 99; },
    value => { presentValue(value.projections.modelSelection).next = lastModel; },
    value => { value.events.push({ type: 'turn/start', seq: SessionSeq(value.events.length), time: 1, data: { turn: 2 } }); },
  ];
  for (const mutate of conflicts) { const record = structuredClone(original); mutate(record); f.persisted.set(child.sessionId, record); await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('COLD_CONTINUATION_CONFLICT')); }
  assert.equal(f.resumed.length, 0); assert.equal(f.created.length, 1);
});

test('trusted input hold runs after child startup clear and before cold creation publication', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); let held: Agent | undefined;
  input.holdInput = agent => { assert.deepEqual(agent.inbox.nextTurn, []); assert.deepEqual(agent.inbox.nextStep, []); held = agent; f.lifecycle.push(['hold-input', agent.id]); };
  const result = await f.bootstrap.createColdContinuation(input); assert.equal(held, result.agent);
  assert.deepEqual(f.lifecycle.filter(([kind]) => ['clear-child', 'hold-input', 'published', 'attach', 'flush'].includes(kind)).map(([kind]) => kind), ['clear-child', 'hold-input', 'published', 'attach', 'flush']);
  assert.deepEqual(presentValue(f.persisted.get(result.sessionId)).events, input.source.seed);
});

function parkTarget(f: Fixture, publicAgent: Agent) {
  const agent = presentValue(f.live.get(publicAgent.id));
  const steering: UserMessage = { ...structuredClone(message), id: 'parked-steering-message' as UserMessage['id'] };
  for (const [target, value] of [['next-turn', message], ['next-step', steering]] as const) agent.session.append('agent/inbox/spliced', { target, start: 0, removedCount: 0, inserted: [value] });
  agent.inbox.nextTurn.push(structuredClone(message)); agent.inbox.nextStep.push(steering);
  agent.projections.inbox = { 'next-turn': agent.inbox.nextTurn.map(value => { assert.ok(typeof value !== 'string'); return structuredClone(value); }), 'next-step': structuredClone(agent.inbox.nextStep) };
  return structuredClone(f.save(agent.session, agent.projections));
}

test('attached adoption preserves parked durable input only with a trusted hold and still refuses own execution', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input); const parked = parkTarget(f, child.agent);
  await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('SOURCE_BUSY'));
  let held: Agent | undefined;
  input.holdInput = agent => { assert.equal(agent.status, 'idle'); held = agent; f.lifecycle.push(['hold-input', agent.id]); };
  const adopted = await f.bootstrap.ensureColdContinuation(input); assert.equal(adopted.agent, child.agent); assert.equal(held, child.agent);
  assert.deepEqual(child.agent.inbox.nextTurn, presentValue(parked.projections.inbox)['next-turn']); assert.deepEqual(child.agent.inbox.nextStep, presentValue(parked.projections.inbox)['next-step']);
  assert.deepEqual(presentValue(f.persisted.get(child.sessionId)).events, parked.events); assert.equal(f.lifecycle.filter(([kind]) => kind === 'clear-child').length, 1); assert.equal(f.created.length, 1); assert.equal(f.resumed.length, 0);
  child.agent.session.append('turn/start', { turn: 2 }); child.agent.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } });
  await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('COLD_CONTINUATION_CONFLICT'));
});

test('persisted adoption parks input during setup before driver release without clearing queued history', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input); const parked = parkTarget(f, child.agent);
  await f.loseAgent(child.sessionId); await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('SOURCE_BUSY')); assert.equal(f.resumed.length, 0);
  let held: Agent | undefined;
  input.holdInput = agent => {
    assert.equal(agent.status, 'idle'); assert.deepEqual(agent.inbox.nextTurn, presentValue(parked.projections.inbox)['next-turn']); assert.deepEqual(agent.inbox.nextStep, presentValue(parked.projections.inbox)['next-step']);
    held = agent; f.lifecycle.push(['hold-input', agent.id]);
  };
  const adopted = await f.bootstrap.ensureColdContinuation(input); assert.equal(held, adopted.agent); assert.notEqual(held, child.agent);
  assert.deepEqual(presentValue(f.persisted.get(adopted.sessionId)).events, parked.events); assert.deepEqual(adopted.agent.inbox.nextTurn, presentValue(parked.projections.inbox)['next-turn']); assert.deepEqual(adopted.agent.inbox.nextStep, presentValue(parked.projections.inbox)['next-step']);
  assert.deepEqual(f.lifecycle.filter(([kind]) => ['hold-input', 'resumed'].includes(kind)).map(([kind]) => kind), ['hold-input', 'resumed']);
  assert.equal(f.lifecycle.filter(([kind]) => kind === 'clear-child').length, 1); assert.equal(f.created.length, 1); assert.equal(f.resumed.length, 1); assert.deepEqual(presentValue(f.persisted.get(f.source.id)).events, input.source.events);
});

test('staging returns an entered identity and durability receipt while factory publication remains gated', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); let hold: ColdFactoryHold | undefined;
  input.holdInput = (agent, factory) => { assert.ok(factory); assert.equal(f.live.get(agent.id), agent); hold = factory; f.lifecycle.push(['factory-held', agent.id]); };
  const stage = await f.bootstrap.stageColdContinuation(input);
  assert.equal(stage.agent.id, input.sessionId); assert.equal(f.lifecycle.some(([kind]) => kind === 'published'), false);
  assert.ok(f.lifecycle.some(([kind]) => kind === 'flush')); assert.deepEqual(presentValue(f.persisted.get(stage.sessionId)).events, input.source.seed);
  const again = await f.bootstrap.stageColdContinuation(input); assert.equal(again.agent, stage.agent); assert.equal(again.completion, stage.completion); assert.equal(f.created.length, 1);
  presentValue(hold).release(); const completed = await stage.completion; assert.equal(completed.agent, stage.agent); assert.ok(f.lifecycle.some(([kind]) => kind === 'published'));
});

test('shutdown aborts and drains a staged factory without waiting for its deferred release', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); let hold: ColdFactoryHold | undefined;
  input.holdInput = (_agent, factory) => { hold = factory; };
  const stage = await f.bootstrap.stageColdContinuation(input); const rejected = assert.rejects(stage.completion, code('TARGET_HOLD_CANCELLED'));
  await f.bootstrap.close(); await rejected; assert.equal(presentValue(hold).signal.aborted, true); assert.equal(f.lifecycle.some(([kind]) => kind === 'published'), false);
});

test('native permission command lifecycle is preserved for held adoption, but other commands and incomplete commands are not guessed safe', async t => {
  const f = await fixture(t); closedHistory(f); const input = await coldInput(f); const child = await f.bootstrap.createColdContinuation(input);
  input.holdInput = () => {};
  const commandId = CommandId(randomUUID()); child.agent.session.append('command/run', { commandId, name: 'permission', args: 'danger-full-access', source: { kind: 'user' } });
  await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('COLD_CONTINUATION_CONFLICT'));
  child.agent.session.append('permission/preset', { preset: 'danger-full-access' }); child.agent.session.append('sandbox/mode', { mode: 'danger-full-access' });
  child.agent.session.append('command/done', { commandId, kind: 'success', text: 'preset danger-full-access' });
  const before = f.save(child.agent.session, presentValue(f.live.get(child.sessionId)).projections); const adopted = await f.bootstrap.adoptColdContinuation(input);
  assert.equal(adopted.agent, child.agent); assert.deepEqual(presentValue(f.persisted.get(child.sessionId)).events, before.events);
  child.agent.session.append('command/run', { commandId: CommandId(randomUUID()), name: 'arbitrary-effect', source: { kind: 'user' } });
  await assert.rejects(f.bootstrap.adoptColdContinuation(input), code('COLD_CONTINUATION_CONFLICT'));
});

test('unknown factory effects, evidence tampering and invalid target identity never produce duplicate continuations', async t => {
  const f = await fixture(t, { createdFailure: true }); const input = await coldInput(f);
  await assert.rejects(f.bootstrap.createColdContinuation(input), /unknown create effect/); f.createdFailure = false;
  await assert.rejects(f.bootstrap.ensureColdContinuation(input), code('COLD_CONTINUATION_UNKNOWN_EFFECT')); assert.equal(f.created.length, 1);
  await assert.rejects(f.bootstrap.createColdContinuation({ ...input, sessionId: 'not-an-id' }), code('INVALID_SESSION_ID'));
  await assert.rejects(f.bootstrap.createColdContinuation({ ...input, sessionId: f.source.id }), code('INVALID_SESSION_ID'));
  await assert.rejects(f.bootstrap.createColdContinuation({ ...input, sessionId: randomUUID(), cwd: 'relative' }), code('MISSING_PROJECT_DIRECTORY'));
  // Deliberate detached-evidence tampering exercises the source hash guard.
  (input.source as { model: SessionSettings['model'] }).model = model; await assert.rejects(f.bootstrap.createColdContinuation({ ...input, sessionId: randomUUID() }), code('COLD_SOURCE_CHANGED')); assert.equal(f.created.length, 1);
});
