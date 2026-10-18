/**
 * Host lifecycle hooks: event/flush scheduling, pre-step admission, and explicit
 * non-release at turn-stopping. Actual lease release is owned by the drain path.
 * @module @1yefuwang1/dsh-azure-sync/sync/lifecycle
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LocalStore } from '../local/store.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { admitPreStep } from './admission.js';
import type { UploadScheduler } from './scheduler.js';
import type { SyncService } from './service.js';

export interface LifecycleDependencies {
  readonly ctx: Context;
  readonly service: SyncService;
  readonly scheduler: UploadScheduler;
  readonly local: LocalStore;
  readonly now: () => number;
}

/** Register the sync lifecycle; returns one disposer for all subscriptions. */
export function registerSyncLifecycle(deps: LifecycleDependencies): () => void {
  const disposers: Array<() => void> = [];
  const enabled = (sessionId: string): boolean => deps.local.getSession(sessionId)?.enabled === true;
  const activity = (sessionId: string): void => { deps.service.noteActivity(sessionId); };

  disposers.push(deps.ctx.on('session/event', (session: Session) => {
    if (!enabled(session.id)) return;
    activity(session.id);
    deps.scheduler.schedule(session.id);
  }));
  disposers.push(deps.ctx.on('session/flush', (session: Session) => {
    if (!enabled(session.id)) return;
    deps.service.noteFlushed(session.id);
    deps.scheduler.schedule(session.id);
  }));
  disposers.push(deps.ctx.on('session/created', (session: Session) => {
    if (enabled(session.id)) deps.scheduler.schedule(session.id);
  }));
  disposers.push(deps.ctx.on('agent/pre-step', async (payload, next) => {
    if (!enabled(payload.agent.session.id)) return next();
    activity(payload.agent.session.id);
    const result = await admitPreStep({
      agent: payload.agent as Agent,
      sessionId: payload.agent.session.id,
      messages: payload.messages,
      turn: payload.turn,
      step: payload.step,
      local: deps.local,
      ownership: () => deps.service.ensureOwnership(payload.agent.session.id),
      now: deps.now,
    });
    return result.kind === 'enter' ? next() : { kind: 'reject' };
  }));
  disposers.push(deps.ctx.on('agent/status', (payload) => {
    if (!enabled(payload.agent.session.id)) return;
    if (payload.status === 'running') activity(payload.agent.session.id);
    else void deps.service.drain(payload.agent.session.id).catch(() => undefined);
  }));
  disposers.push(deps.ctx.on('agent/inbox/inserted', (payload) => {
    if (enabled(payload.agent.session.id)) activity(payload.agent.session.id);
  }));
  // Deliberately no agent/turn-stopping release: a turn boundary is not a drain.

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* host teardown is best-effort */ }
    }
  };
}
