import { randomUUID } from 'node:crypto';
import type {} from '@deepseek-ai/dsh-api-session-controller/types';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import type {} from '@deepseek-ai/dsh-plan-mode';
import { realpath, stat } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import { SessionId, SessionSeq, SessionLogOffset, buildForkSeed } from '@deepseek-ai/dsh-session';
import type { SessionObservation } from '@deepseek-ai/dsh-session-query';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy, type ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { hashValue } from './schema.js';
import { WorktreeError } from './errors.js';
import { capability, required, policyOf, type PlanCapability } from './runtime.js';
import type { SessionSettings } from './types.js';
export type { SessionSettings } from './types.js';

interface AgentsCapability { get(id: string): Agent | undefined; list(): Agent[]; create(options: CreateAgentOptions): Promise<AgentHandle> }
interface QueryCapability { observeSession(id: SessionId, options: { signal?: AbortSignal; projectionMode: 'all' }): Promise<SessionObservation> }
interface PresetsCapability { resolve(id?: string): Promise<{ id: string }>; mount(ctx: Context, id?: string): Promise<unknown> }
interface WorkspaceCapability { create(path: string, title?: string): Promise<{ id: string; path: string; attachSession(id: SessionId): Promise<void> }> }
interface ApprovalCapability { config: { policy?: ApprovalPolicy }; overrideOf(session: Agent['session']): ApprovalPolicy | undefined }

export class SessionBootstrap {
  private readonly owner: Context;
  private readonly handles = new Map<string, AgentHandle>();
  constructor(owner: Context) { this.owner = owner; }
  actor(id: string): Agent {
    const agent = required<AgentsCapability>(this.owner, 'agents').get(id);
    if (agent === undefined) throw new WorktreeError('SESSION_NOT_LIVE', 'The source session is no longer live. Open it and retry.');
    if (agent.session.header.origin === 'subagent') throw new WorktreeError('SUBAGENT_SOURCE', 'New top-level worktree conversations require an ordinary source session.');
    return agent;
  }
  isLive(agent: Agent): boolean { return required<AgentsCapability>(this.owner, 'agents').get(agent.id) === agent; }
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
    const values = [...this.handles.values()]; this.handles.clear();
    await Promise.allSettled(values.map(async h => { h.agent.cancel({ kind: 'disposed' }); await h.dispose(); await h.agent.whenIdle(); }));
  }
}
