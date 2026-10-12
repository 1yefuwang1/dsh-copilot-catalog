import { randomUUID } from 'node:crypto';
import type {} from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-plan-mode';
import { realpath, stat } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions, InboxWireState } from '@deepseek-ai/dsh-agent';
import { Session, SessionId, SessionSeq, SessionLogOffset, buildForkSeed, interruptedTurnClosers, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import { isAbsolute } from 'node:path';
import type { SessionObservation } from '@deepseek-ai/dsh-session-query';
import { setSandboxMode, SANDBOX_MODES } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy, APPROVAL_POLICIES, type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { hashValue } from './schema.js';
import { WorktreeError } from './errors.js';
import { capability, required, policyOf, type PlanCapability } from './runtime.js';
import type { SessionSettings } from './types.js';
export type { SessionSettings } from './types.js';

interface AgentsCapability { get(id: string): Agent | undefined; list(): Agent[]; create(options: CreateAgentOptions): Promise<AgentHandle>; resume(options: ResumeAgentOptions): Promise<AgentHandle> }
interface PersistenceCapability {
  stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<SessionPersistenceSnapshot | undefined>;
  open(id: SessionId, access: 'read', options?: { signal?: AbortSignal }): Promise<SessionHandle>;
}

/** A detached cold read. Synthetic recovery events are explicitly distinguished from durable source events. */
export interface ColdContinuationSource {
  readonly sourceSessionId: string;
  readonly header: SessionHeader;
  readonly events: readonly SessionEvent[];
  readonly seed: readonly SessionEvent[];
  readonly boundary: SessionSeq | null;
  readonly inheritedEventCount: SessionLogOffset;
  readonly rawEventCount: number;
  readonly syntheticEventCount: number;
  readonly model: SessionSettings['model'];
  readonly preset: string | null;
  readonly modelSelection: { readonly next: SessionSettings['model']; readonly lastUsed: SessionSettings['model'] };
  readonly hash: string;
}
export interface ColdContinuationResult { agent: Agent; sessionId: string; workspaceId: string }
/** The factory's existing initialization claim, held through serial publication. */
export interface ColdFactoryHold { readonly signal: AbortSignal; readonly task: Promise<void>; release(): void }
export interface ColdContinuationStage extends ColdContinuationResult { readonly completion: Promise<ColdContinuationResult> }
interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}
interface ColdStage {
  readonly input: ColdContinuationInput;
  readonly cwd: string;
  readonly entered: Deferred<ColdContinuationResult>;
  readonly gate: Deferred<void>;
  completion: Promise<ColdContinuationResult>;
  agent?: Agent;
  factory?: ColdFactoryHold;
  result?: ColdContinuationResult;
}
export interface ColdContinuationInput {
  sessionId: string;
  cwd: string;
  title: string;
  source: ColdContinuationSource;
  signal?: AbortSignal;
  onCreated?: (result: ColdContinuationResult) => Promise<void>;
  /** Trusted admission. Factory staging supplies its existing claim; already-published Agents require an ordinary idle hold. */
  holdInput?: (agent: Agent, factory?: ColdFactoryHold) => void;
}

function coldHash(source: Omit<ColdContinuationSource, 'hash' | 'seed'>): string { return hashValue(source); }
function modelIntent(value: unknown): SessionSettings['model'] {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new WorktreeError('INVALID_MODEL', 'The cold source model selection is invalid.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.provider !== 'string' || !candidate.provider || typeof candidate.model !== 'string' || !candidate.model || (candidate.reasoningEffort !== undefined && (typeof candidate.reasoningEffort !== 'string' || !candidate.reasoningEffort))) throw new WorktreeError('INVALID_MODEL', 'The cold source model selection is invalid.');
  return { provider: candidate.provider, model: candidate.model, ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort as string }) };
}
function assertIdleObservation(observation: SessionObservation, allowParkedInbox = false): void {
  const inbox = observation.projections?.values.inbox as InboxWireState | undefined;
  if (inbox === undefined) {
    if (observation.events.some(event => event.type === 'agent/inbox/spliced')) throw new WorktreeError('UNKNOWN_SOURCE_INBOX', 'The durable source inbox cannot be decoded in this profile.');
  } else {
    if (!Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw new WorktreeError('UNKNOWN_SOURCE_INBOX', 'The durable source inbox projection is invalid.');
    if (!allowParkedInbox && (inbox['next-turn'].length || inbox['next-step'].length)) throw new WorktreeError('SOURCE_BUSY', 'The source has unresolved pending input.');
  }
  // Prepared cold reads can have peer-generated interrupted closers. An actually open observed tail is never cut away.
  let turn: number | null = null; let step: number | null = null;
  for (const event of observation.events) {
    if (event.type === 'sandbox/mode' && !SANDBOX_MODES.includes(event.data.mode)) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source sandbox override is invalid.');
    if (event.type === 'approval/policy' && !APPROVAL_POLICIES.includes(event.data.policy)) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source approval override is invalid.');
    if (event.type === 'plan/mode' && typeof event.data.active !== 'boolean') throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source plan mode is invalid.');
    if (event.type === 'turn/start') {
      if (turn !== null) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source has overlapping turns.');
      turn = event.data.turn;
    } else if (event.type === 'step/start') {
      if (turn !== event.data.turn || step !== null) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source has invalid step boundaries.');
      step = event.data.step;
    } else if (event.type === 'step/end') {
      if (turn !== event.data.turn || step !== event.data.step) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source has invalid step boundaries.');
      step = null;
    } else if (event.type === 'turn/end') {
      if (turn !== event.data.turn || step !== null) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source has invalid turn boundaries.');
      turn = null;
    }
  }
  if (turn !== null || step !== null) throw new WorktreeError('SOURCE_BUSY', 'The source still has an open turn or step.');
}
interface QueryCapability { observeSession(id: SessionId, options: { signal?: AbortSignal; projectionMode: 'all' }): Promise<SessionObservation> }
interface PresetsCapability { resolve(id?: string): Promise<{ id: string }>; mount(ctx: Context, id?: string): Promise<unknown> }
interface WorkspaceCapability { create(path: string, title?: string): Promise<{ id: string; path: string; attachSession(id: SessionId): Promise<void> }> }
interface ApprovalCapability { config: { policy?: ApprovalPolicy }; overrideOf(session: Agent['session']): ApprovalPolicy | undefined }

export class SessionBootstrap {
  private readonly owner: Context;
  private readonly handles = new Map<string, AgentHandle>();
  private readonly coldAttempts = new Set<string>();
  private readonly stages = new Map<string, ColdStage>();
  private readonly shutdown = new AbortController();
  private readonly stopStaging: () => void;
  constructor(owner: Context) {
    this.owner = owner;
    this.stopStaging = owner.on('agent/created', async ({ agent, signal }) => {
      const stage = this.stages.get(agent.id);
      if (stage?.agent !== agent) return undefined;
      if (signal === undefined || required<AgentsCapability>(owner, 'agents').get(agent.id) !== agent) throw new WorktreeError('MISSING_FACTORY_CLAIM', 'Cold staging requires the entered, abortable factory publication boundary.');
      const task = stage.completion.then(() => undefined);
      void task.catch(() => undefined);
      const factory: ColdFactoryHold = { signal, task, release: () => stage.gate.resolve() };
      stage.factory = factory;
      // AgentLoop already owns maintenance here. Acquiring another claim would fail,
      // and acquiring one after publication would leave a driver-admission gap.
      stage.input.holdInput?.(agent, factory);
      stage.result = await this.finishCold(stage.input, agent, stage.cwd);
      stage.entered.resolve(stage.result);
      await this.waitForGate(stage.gate.promise, signal);
      return undefined;
    });
  }
  private async waitForGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
    let abort!: () => void;
    const cancelled = new Promise<never>((_fulfill, reject) => {
      abort = () => reject(new WorktreeError('TARGET_HOLD_CANCELLED', 'The continuation factory input hold was cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    try { await Promise.race([gate, cancelled]); } finally { signal.removeEventListener('abort', abort); }
  }
  /** Return an entered real target while its factory claim still parks input.
   * Creation belongs to this bootstrap, not to a single recovery RPC. Completion
   * is independently retained/drained; a refused branch switch can be retried
   * through the target's native permission controls without monopolizing a queue.
   */
  async stageColdContinuation(input: ColdContinuationInput): Promise<ColdContinuationStage> {
    if (input.holdInput === undefined) throw new WorktreeError('MISSING_INPUT_HOLD', 'Cold staging requires an owned publication hold and release decision.');
    input = { ...input, source: structuredClone(input.source), signal: AbortSignal.any([this.shutdown.signal, ...(input.signal === undefined ? [] : [input.signal])]) };
    const cwd = await this.coldDirectory(input);
    const prior = this.stages.get(input.sessionId);
    if (prior !== undefined) {
      if (prior.cwd !== cwd || prior.input.source.hash !== input.source.hash) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The staged continuation has conflicting source or directory evidence.');
      if (prior.result === undefined) return { ...await prior.entered.promise, completion: prior.completion };
      // Re-adoption verifies the entire inherited prefix and refuses own execution;
      // human control edits and parked input remain authoritative and untouched.
      const result = await this.adoptColdContinuation({ ...input, holdInput: agent => input.holdInput?.(agent, prior.factory) });
      return { ...result, completion: prior.completion };
    }
    if (required<AgentsCapability>(this.owner, 'agents').get(input.sessionId) !== undefined) {
      const result = await this.adoptColdContinuation(input);
      return { ...result, completion: Promise.resolve(result) };
    }
    const completion = deferred<ColdContinuationResult>();
    const stage: ColdStage = { input, cwd, entered: deferred(), gate: deferred(), completion: completion.promise };
    this.stages.set(input.sessionId, stage);
    // Start after installing the exact-id capture, and retain the eventual handle
    // independently of the request waiting for the provisional identity.
    void this.ensureColdContinuation(input).then(completion.resolve, completion.reject);
    void stage.completion.catch(error => { stage.entered.reject(error); }).finally(() => {
      if (this.stages.get(input.sessionId) === stage) this.stages.delete(input.sessionId);
    }).catch(() => undefined);
    return { ...await stage.entered.promise, completion: stage.completion };
  }
  actor(id: string): Agent {
    const agent = required<AgentsCapability>(this.owner, 'agents').get(id);
    if (agent === undefined) throw new WorktreeError('SESSION_NOT_LIVE', 'The source session is no longer live. Open it and retry.');
    if (agent.session.header.origin === 'subagent') throw new WorktreeError('SUBAGENT_SOURCE', 'New top-level worktree conversations require an ordinary source session.');
    return agent;
  }
  isLive(agent: Agent): boolean { return required<AgentsCapability>(this.owner, 'agents').get(agent.id) === agent; }
  /** Read history without reviving its Agent or touching its missing execution directory. */
  async coldSource(sourceSessionId: string, signal?: AbortSignal): Promise<ColdContinuationSource> {
    const id = SessionId(sourceSessionId);
    const agents = required<AgentsCapability>(this.owner, 'agents');
    if (agents.get(sourceSessionId) !== undefined) throw new WorktreeError('SOURCE_BUSY', 'Cold continuation requires a source without a live Agent.');
    const observation = await required<QueryCapability>(this.owner, 'sessionQuery').observeSession(id, { signal, projectionMode: 'all' });
    try {
      if (observation.source !== 'prepared' || agents.get(sourceSessionId) !== undefined) throw new WorktreeError('SOURCE_BUSY', 'The source became live during cold observation.');
      if (observation.header.id !== id) throw new WorktreeError('CORRUPT_COLD_SOURCE', 'The source header does not match its requested identity.');
      if (observation.header.origin === 'subagent') throw new WorktreeError('SUBAGENT_SOURCE', 'Cold continuation requires an ordinary source session.');
      const persistence = required<PersistenceCapability>(this.owner, 'sessionPersistence');
      const handle = await persistence.open(id, 'read', { signal });
      let raw: readonly SessionEvent[];
      try {
        raw = (await handle.read(0, undefined, { signal })).events;
        if (hashValue(handle.header) !== hashValue(observation.header) || handle.inheritedEventCount !== observation.inheritedEventCount) throw new WorktreeError('SESSION_CHANGED', 'The cold source header changed while it was observed.');
      } finally { await handle.close(); }
      const expected = [...raw, ...interruptedTurnClosers(raw)];
      if (hashValue(expected) !== hashValue(observation.events)) throw new WorktreeError('SESSION_CHANGED', 'The cold source log changed while it was observed.');
      const header = structuredClone(observation.header); const events = structuredClone([...observation.events]);
      // Use the public replay boundary and installed message interpreters; this detached Session is never published.
      Session.create(id, events, header, observation.inheritedEventCount, this.owner.sessions.messageProjections);
      assertIdleObservation(observation);
      const values = observation.projections?.values;
      const selection = values?.modelSelection;
      if (selection === undefined && events.some(event => event.type === 'model/selection' || event.type === 'request/header')) throw new WorktreeError('UNKNOWN_SOURCE_MODEL', 'The durable source model selection cannot be decoded in this profile.');
      const lastUsed = modelIntent(selection?.lastUsed); const model = modelIntent(selection?.next) ?? lastUsed;
      const selected = values?.agentPreset === undefined ? header.agentPreset : values.agentPreset;
      if (selected !== undefined && selected !== null && (typeof selected !== 'string' || !selected)) throw new WorktreeError('INVALID_PRESET', 'The cold source preset selection is invalid.');
      if (values?.agentPreset === undefined && events.some(event => event.type === 'agent-preset/selected')) throw new WorktreeError('UNKNOWN_SOURCE_PRESET', 'The durable source preset selection cannot be decoded in this profile.');
      const presets = capability<PresetsCapability>(this.owner, 'agentPresets');
      if (presets === undefined && selected != null) throw new WorktreeError('MISSING_PRESET_SERVICE', 'The source preset cannot be resolved in this profile.');
      const preset = presets === undefined ? null : (await presets.resolve(selected ?? undefined)).id;
      const boundary = events.length ? SessionSeq(events.length - 1) : null;
      const seed = boundary === null ? [] : buildForkSeed(events, boundary);
      const evidence = { sourceSessionId, header, events, boundary, inheritedEventCount: SessionLogOffset(events.length), rawEventCount: raw.length, syntheticEventCount: events.length - raw.length, model, preset, modelSelection: { next: model, lastUsed } };
      if (signal?.aborted) throw new WorktreeError('CANCELLED', 'Cold source observation was cancelled.');
      if (agents.get(sourceSessionId) !== undefined) throw new WorktreeError('SOURCE_BUSY', 'The source became live during cold observation.');
      return { ...evidence, seed: structuredClone(seed), hash: coldHash(evidence) };
    } finally { observation[Symbol.dispose](); }
  }
  private async coldDirectory(input: ColdContinuationInput): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.sessionId) || input.sessionId === input.source.sourceSessionId) throw new WorktreeError('INVALID_SESSION_ID', 'Cold continuation requires a distinct preallocated session UUID.');
    if (!isAbsolute(input.cwd)) throw new WorktreeError('MISSING_PROJECT_DIRECTORY', 'The chosen Local directory must be an absolute existing directory.');
    const cwd = await realpath(input.cwd);
    if (cwd !== input.cwd || !(await stat(cwd)).isDirectory()) throw new WorktreeError('MISSING_PROJECT_DIRECTORY', 'The chosen Local directory must be canonical and existing.');
    const { hash, seed, ...evidence } = input.source;
    const expectedSeed = input.source.boundary === null ? [] : buildForkSeed(input.source.events, input.source.boundary);
    if (coldHash(evidence) !== hash || hashValue(seed) !== hashValue(expectedSeed) || input.source.header.id !== input.source.sourceSessionId || input.source.inheritedEventCount !== input.source.events.length || input.source.boundary !== (input.source.events.length ? input.source.events.length - 1 : null) || input.source.rawEventCount + input.source.syntheticEventCount !== input.source.events.length || input.source.header.origin === 'subagent') throw new WorktreeError('COLD_SOURCE_CHANGED', 'The prepared cold source evidence changed.');
    if (input.signal?.aborted) throw new WorktreeError('CANCELLED', 'Cold continuation was cancelled.');
    return cwd;
  }
  private coldAgentOptions(source: Pick<ColdContinuationSource, 'model'>): AgentOptions {
    return source.model === null ? {} : { provider: source.model.provider, model: source.model.model, ...(source.model.reasoningEffort === undefined ? {} : { reasoningEffort: source.model.reasoningEffort as AgentOptions['reasoningEffort'] }) };
  }
  private async mountColdPreset(agentCtx: Context, source: Pick<ColdContinuationSource, 'preset'>): Promise<void> {
    const presets = capability<PresetsCapability>(this.owner, 'agentPresets');
    if (presets !== undefined) {
      const selected = await presets.resolve(source.preset ?? undefined);
      if (selected.id !== source.preset) throw new WorktreeError('COLD_SOURCE_CHANGED', 'The selected preset identity changed.');
      await presets.mount(agentCtx, selected.id);
    } else if (source.preset !== null) throw new WorktreeError('MISSING_PRESET_SERVICE', 'The source preset cannot be mounted in this profile.');
  }
  private async finishCold(input: ColdContinuationInput, agent: Agent, cwd: string): Promise<ColdContinuationResult> {
    const workspace = await required<WorkspaceCapability>(this.owner, 'workspaceRegistry').create(cwd, input.title);
    if (workspace.path !== cwd) throw new WorktreeError('WORKSPACE_IDENTITY', 'The canonical Workspace path does not match the execution directory.');
    const result = { agent, sessionId: agent.id, workspaceId: workspace.id };
    await input.onCreated?.(result);
    await workspace.attachSession(agent.id);
    if (!await this.owner.sessions.flush(agent.session)) throw new WorktreeError('MISSING_DURABILITY_BARRIER', 'No persistence listener participated in the session durability checkpoint.');
    return result;
  }
  /** Create only the journaled identity. An uncertain factory result is never replaced with another identity. */
  async createColdContinuation(input: ColdContinuationInput): Promise<ColdContinuationResult> {
    input = { ...input, source: structuredClone(input.source) };
    const cwd = await this.coldDirectory(input); const agents = required<AgentsCapability>(this.owner, 'agents');
    const persisted = await required<PersistenceCapability>(this.owner, 'sessionPersistence').stat(SessionId(input.sessionId), { signal: input.signal });
    if (agents.get(input.sessionId) !== undefined || persisted !== undefined) throw new WorktreeError('COLD_CONTINUATION_EXISTS', 'The continuation identity already exists; inspect and adopt it instead.');
    if (this.coldAttempts.has(input.sessionId)) throw new WorktreeError('COLD_CONTINUATION_UNKNOWN_EFFECT', 'A prior creation attempt has an unknown outcome; do not create another continuation.');
    this.coldAttempts.add(input.sessionId);
    const handle = await agents.create({
      sessionId: SessionId(input.sessionId), signal: input.signal,
      meta: { cwd, parentSession: SessionId(input.source.sourceSessionId), isSeeded: true, ...(input.source.preset === null ? {} : { agentPreset: input.source.preset }) },
      seed: structuredClone([...input.source.seed]), inheritedEventCount: input.source.inheritedEventCount,
      agentOptions: this.coldAgentOptions(input.source),
      setup: async (agentCtx, child) => {
        await this.mountColdPreset(agentCtx, input.source);
        // No source inbox is cleared. Only preset-generated child startup input is suppressed, before publication.
        child.inbox.clear();
        const stage = this.stages.get(input.sessionId);
        if (stage !== undefined) stage.agent = child;
        else input.holdInput?.(child);
      },
    });
    this.handles.set(handle.agent.id, handle);
    if (handle.agent.id !== input.sessionId) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The factory returned a different continuation identity.');
    return this.stages.get(input.sessionId)?.result ?? this.finishCold(input, handle.agent, cwd);
  }
  private assertColdChild(input: ColdContinuationInput, cwd: string, observation: SessionObservation): Pick<ColdContinuationSource, 'model' | 'preset'> {
    const source = input.source; const header = observation.header;
    if (header.id !== input.sessionId || header.cwd !== cwd || header.parentSession !== source.sourceSessionId || header.origin === 'subagent' || !header.isSeeded || observation.inheritedEventCount !== source.inheritedEventCount || (header.agentPreset ?? null) !== source.preset) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation has conflicting directory, lineage, preset, or inherited boundary.');
    // Empty seeded children receive their inherited marker from Session construction, not an invented turn.
    const prefix = source.seed.length ? source.seed : [{ type: 'session/end-seed', seq: 0, data: { inherited: true } }];
    if (source.seed.length ? hashValue(observation.events.slice(0, prefix.length)) !== hashValue(prefix) : observation.events[0]?.type !== 'session/end-seed' || (observation.events[0].data as { inherited?: true }).inherited !== true) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation does not contain the exact inherited seed.');
    const suffix = observation.events.slice(prefix.length);
    const controls = new Set(['sandbox/mode', 'approval/policy', 'permission/preset', 'plan/mode', 'model/selection', 'agent-preset/selected', 'session/title', 'goal/change', 'agent/inbox/spliced']);
    // Human edits to a provisioned target are its own authority: preserve them, never overwrite them from the source.
    // Execution and unknown effects are different: a target with its own turn/message/request/tool history cannot be silently adopted.
    const policyCommands = new Set<string>();
    for (const event of suffix) {
      if (event.type === 'command/run' && event.data.name === 'permission' && event.data.source.kind === 'user' && !policyCommands.has(event.data.commandId)) { policyCommands.add(event.data.commandId); continue; }
      if (event.type === 'command/done' && policyCommands.delete(event.data.commandId)) continue;
      if (event.type === 'session/end-seed' ? Object.keys(event.data).length !== 0 : !controls.has(event.type)) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation has its own execution or unknown events.');
    }
    if (policyCommands.size) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'A native permission command has an unsettled outcome.');
    try { Session.create(SessionId(input.sessionId), observation.events, header, observation.inheritedEventCount, this.owner.sessions.messageProjections); }
    catch { throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation log is not a valid replay.'); }
    assertIdleObservation(observation, input.holdInput !== undefined);
    let expectedModel = source.model; let expectedPreset = source.preset;
    for (const event of suffix) {
      if (event.type === 'model/selection') expectedModel = modelIntent(event.data);
      if (event.type === 'agent-preset/selected') {
        if (typeof event.data.agentPreset !== 'string' || !event.data.agentPreset) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The target preset selection is invalid.');
        expectedPreset = event.data.agentPreset;
      }
    }
    const selection = observation.projections?.values.modelSelection;
    const model = modelIntent(selection?.next) ?? modelIntent(selection?.lastUsed);
    if (hashValue(model) !== hashValue(expectedModel) || hashValue(modelIntent(selection?.lastUsed)) !== hashValue(source.modelSelection.lastUsed)) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation has conflicting projected model intent.');
    const projectedPreset = observation.projections?.values.agentPreset;
    if ((projectedPreset !== undefined && projectedPreset !== expectedPreset) || (suffix.some(event => event.type === 'agent-preset/selected') && projectedPreset === undefined)) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation has conflicting projected preset intent.');
    return { model, preset: expectedPreset };
  }
  /** Recover a factory effect after creation-before-receipt, without ever resuming the source Agent. */
  async adoptColdContinuation(input: ColdContinuationInput): Promise<ColdContinuationResult> {
    input = { ...input, source: structuredClone(input.source) };
    const cwd = await this.coldDirectory(input); const agents = required<AgentsCapability>(this.owner, 'agents');
    const observation = await required<QueryCapability>(this.owner, 'sessionQuery').observeSession(SessionId(input.sessionId), { signal: input.signal, projectionMode: 'all' });
    let intent: Pick<ColdContinuationSource, 'model' | 'preset'>;
    try { intent = this.assertColdChild(input, cwd, observation); } finally { observation[Symbol.dispose](); }
    let agent = agents.get(input.sessionId);
    if (agent !== undefined) {
      if (agent.status !== 'idle' || (input.holdInput === undefined && (agent.inbox.nextStep.length || agent.inbox.nextTurn.length))) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The existing continuation Agent has active or unheld pending work.');
      input.holdInput?.(agent);
    } else {
      const handle = await agents.resume({ resumeSessionId: SessionId(input.sessionId), agentOptions: this.coldAgentOptions(intent), signal: input.signal,
        setup: async (agentCtx, child) => {
          const lease = await required<QueryCapability>(this.owner, 'sessionQuery').observeSession(SessionId(input.sessionId), { signal: input.signal, projectionMode: 'all' });
          try { if (hashValue(this.assertColdChild(input, cwd, lease)) !== hashValue(intent)) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The target settings changed during resume.'); } finally { lease[Symbol.dispose](); }
          if (child.session.header.cwd !== cwd || child.session.header.parentSession !== input.source.sourceSessionId || child.session.inheritedEventCount !== input.source.inheritedEventCount) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The loaded continuation identity changed during resume.');
          await this.mountColdPreset(agentCtx, intent);
          // A trusted hold parks durable queued input intact; only an already-proved empty target may suppress preset startup input.
          if (input.holdInput === undefined) child.inbox.clear();
          const stage = this.stages.get(input.sessionId);
          if (stage !== undefined) stage.agent = child;
          else input.holdInput?.(child);
        },
      });
      this.handles.set(handle.agent.id, handle); agent = handle.agent;
      if (agent.id !== input.sessionId) throw new WorktreeError('COLD_CONTINUATION_CONFLICT', 'The factory resumed a different continuation identity.');
    }
    return this.stages.get(input.sessionId)?.result ?? this.finishCold(input, agent, cwd);
  }
  async ensureColdContinuation(input: ColdContinuationInput): Promise<ColdContinuationResult> {
    input = { ...input, source: structuredClone(input.source) };
    const agents = required<AgentsCapability>(this.owner, 'agents');
    const existing = agents.get(input.sessionId) !== undefined || await required<PersistenceCapability>(this.owner, 'sessionPersistence').stat(SessionId(input.sessionId), { signal: input.signal }) !== undefined;
    return existing ? this.adoptColdContinuation(input) : this.createColdContinuation(input);
  }
  async settings(agent: Agent, signal?: AbortSignal): Promise<SessionSettings> {
    const query = required<QueryCapability>(this.owner, 'sessionQuery');
    const observation = await query.observeSession(agent.id, { signal, projectionMode: 'all' });
    try {
      if (!this.isLive(agent)) throw new WorktreeError('SESSION_CHANGED', 'The source session generation changed.');
      const values = observation.projections?.values;
      const selection = values?.modelSelection as { next?: SessionSettings['model'] } | undefined;
      const candidate = selection?.next ?? (agent.options.provider && agent.options.model ? {
        provider: agent.options.provider, model: agent.options.model,
        ...(agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: String(agent.options.reasoningEffort) }),
      } : null);
      const model = candidate === null ? null : {
        provider: candidate.provider, model: candidate.model,
        ...(candidate.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.reasoningEffort }),
      };
      if (model !== null && (typeof model.provider !== 'string' || typeof model.model !== 'string' || !model.provider || !model.model)) throw new WorktreeError('INVALID_MODEL', 'The source model selection is not valid. Select a model before preparing a worktree.');
      const presetValue = values?.agentPreset ?? observation.header.agentPreset;
      const preset = typeof presetValue === 'string' ? presetValue : null;
      const approval = capability<ApprovalCapability>(agent.ctx, 'approval');
      const policy = approval?.overrideOf(agent.session) ?? approval?.config.policy ?? 'ask';
      const plan = capability<PlanCapability>(agent.ctx, 'planMode')?.get(agent);
      const base = { model, preset, sandbox: policyOf(agent).mode, approval: policy, plan: plan?.pending ?? plan?.active ?? false };
      return { ...base, hash: hashValue(base) };
    } finally { observation[Symbol.dispose](); }
  }
  async assertBlank(agent: Agent): Promise<void> {
    if (!this.isLive(agent) || agent.status !== 'idle' || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) throw new WorktreeError('SOURCE_BUSY', 'The source must remain an idle blank conversation without queued input.');
    const observation = await required<QueryCapability>(this.owner, 'sessionQuery').observeSession(agent.id, { projectionMode: 'all' });
    try {
      if (observation.events.some(e => e.type === 'turn/start')) throw new WorktreeError('SOURCE_STARTED', 'The source conversation has already started. Prepare another New Conversation instead.');
      if (!this.isLive(agent) || agent.status !== 'idle' || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) throw new WorktreeError('SOURCE_BUSY', 'The source changed while its blank state was checked.');
    } finally { observation[Symbol.dispose](); }
  }
  async create(input: { cwd: string; title: string; source: Agent; settings: SessionSettings; mode: 'new' | 'continue'; signal?: AbortSignal; onCreated?: (result: { agent: Agent; sessionId: string; workspaceId: string }) => Promise<void> }): Promise<{ agent: Agent; sessionId: string; workspaceId: string }> {
    const cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new WorktreeError('MISSING_PROJECT_DIRECTORY', 'The chosen remote tree does not contain the project directory.');
    if (input.signal?.aborted) throw new WorktreeError('CANCELLED', 'Session creation was cancelled.');
    const workspace = await required<WorkspaceCapability>(this.owner, 'workspaceRegistry').create(cwd, input.title);
    if (workspace.path !== cwd) throw new WorktreeError('WORKSPACE_IDENTITY', 'The canonical Workspace path does not match the execution directory.');
    let options: CreateAgentOptions = {
      sessionId: SessionId(randomUUID()),
      meta: { cwd, ...(input.settings.preset === null ? {} : { agentPreset: input.settings.preset }) },
      signal: input.signal,
      agentOptions: input.settings.model === null ? {} : {
        provider: input.settings.model.provider, model: input.settings.model.model,
        ...(input.settings.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.settings.model.reasoningEffort as AgentOptions['reasoningEffort'] }),
      },
      setup: async (agentCtx, child) => {
        const presets = capability<PresetsCapability>(this.owner, 'agentPresets');
        if (presets !== undefined) {
          const selected = await presets.resolve(input.settings.preset ?? undefined);
          await presets.mount(agentCtx, selected.id);
        } else if (input.settings.preset !== null) throw new WorktreeError('MISSING_PRESET_SERVICE', 'The source preset cannot be mounted in this profile.');
        child.inbox.clear();
        setSandboxMode(child.session, input.settings.sandbox);
        setApprovalPolicy(child.session, input.settings.approval);
        child.session.append('plan/mode', { active: input.settings.plan });
        if (input.settings.model !== null) child.session.append('model/selection', input.settings.model);
      },
    };
    if (input.mode === 'continue') {
      const observation = await required<QueryCapability>(this.owner, 'sessionQuery').observeSession(input.source.id, { signal: input.signal, projectionMode: 'all' });
      try {
        let boundary = -1;
        for (let i = 0; i < observation.events.length; i++) if (observation.events[i]?.type === 'turn/end') boundary = i;
        if (boundary < 0) throw new WorktreeError('NO_COMPLETED_TURN', 'This conversation has no completed turn to inherit. Start a fresh conversation instead.');
        if (observation.events[boundary]?.seq !== boundary) throw new WorktreeError('INVALID_FORK_BOUNDARY', 'The source log does not have a contiguous completed-turn boundary.');
        options = { ...options, seed: buildForkSeed(observation.events, SessionSeq(boundary)), inheritedEventCount: SessionLogOffset(boundary + 1), meta: { ...options.meta, parentSession: input.source.id, isSeeded: true } };
      } finally { observation[Symbol.dispose](); }
    }
    const handle = await required<AgentsCapability>(this.owner, 'agents').create(options);
    this.handles.set(handle.agent.id, handle);
    await input.onCreated?.({ agent: handle.agent, sessionId: handle.agent.id, workspaceId: workspace.id });
    await workspace.attachSession(handle.agent.id);
    const flushed = await required<{ flush(session: Agent['session']): Promise<boolean> }>(this.owner, 'sessions').flush(handle.agent.session);
    if (!flushed) throw new WorktreeError('MISSING_DURABILITY_BARRIER', 'No persistence listener participated in the session durability checkpoint.');
    return { agent: handle.agent, sessionId: handle.agent.id, workspaceId: workspace.id };
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.stages.values()].map(stage => stage.completion));
    this.stopStaging();
    const values = [...this.handles.values()]; this.handles.clear();
    await Promise.allSettled(values.map(async h => { h.agent.cancel({ kind: 'disposed' }); await h.dispose(); await h.agent.whenIdle(); }));
  }
}
