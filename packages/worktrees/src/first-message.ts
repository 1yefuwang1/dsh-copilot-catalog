import type { Context } from '@deepseek-ai/cordis';
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { capability } from './runtime.js';
import { WorktreeError } from './errors.js';
import type { WorktreeController } from './service.js';

export function actualUserMessage(agent: Agent, event: SessionEvent): event is SessionEvent<'user/message'> {
  return event.type === 'user/message' && event.surfaceOp === 'append' && !event.sourceEventSeqs?.length
    && event.data.role === 'user' && event.data.source.kind === 'user' && agent.session.isOwnSeq(event.seq);
}
function abortable(task: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    task.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

/** Filtered one-shot observation only for eligible sessions; no token/full-log rescans. */
export class FirstMessageNamer {
  private readonly shutdown = new AbortController();
  private readonly stops: Array<() => void> = [];
  private readonly attachments = new Map<Agent, () => void>();
  private readonly tasks = new Set<Promise<void>>();
  constructor(private readonly owner: Context, private readonly controller: WorktreeController) {}
  start(): void {
    this.stops.push(this.owner.on('agent/created', ({ agent, source }) => { this.attach(agent, source); return undefined; }));
    this.stops.push(this.owner.on('agent/disposed', ({ agent }) => { this.attachments.get(agent)?.(); }));
    for (const agent of capability<{ list(): Agent[] }>(this.owner, 'agents')?.list() ?? []) this.attach(agent, 'resume');
  }
  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
  }
  attach(agent: Agent, source: SessionStartSource = 'startup'): void {
    if (this.shutdown.signal.aborted || this.attachments.has(agent) || agent.session.header.origin === 'subagent') return;
    const record = this.controller.records().find(row => row.firstMessageNaming?.sessionId === agent.id);
    const naming = record?.firstMessageNaming;
    if (record === undefined || naming === undefined || naming.phase === 'complete' || naming.phase === 'skipped') return;
    if (source === 'clear' || source === 'compact') {
      this.track(this.controller.skipFirstMessageName(record.id, 'session-replaced'));
      return;
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, this.shutdown.signal]);
    let claimed = naming.phase !== 'waiting';
    let ended = false;
    let end!: () => void;
    const turnEnd = new Promise<void>(resolve => { end = resolve; });
    let stop!: () => void;
    const launch = (event?: SessionEvent<'user/message'>) => {
      claimed = true;
      this.track((async () => {
        try {
          await this.controller.prepareFirstMessageName(record.id, agent, event, signal);
          if (!ended) await abortable(turnEnd, signal);
          // turn/end is committed while status can still be running. Claim actual idle,
          // not a chat event boundary, so naming never races this agent's Git tools.
          for (;;) {
            await abortable(agent.whenIdle(), signal);
            try { await this.controller.finishFirstMessageName(record.id, agent, signal); break; }
            catch (error) {
              // If waking input won the repository-queue/idle-claim race, wait on
              // that real activity. This reuses the original result, not its prompt.
              if (signal.aborted || !(error instanceof WorktreeError) || error.code !== 'BUSY') throw error;
            }
          }
        } finally { stop(); }
      })());
    };
    const effect = agent.ctx.effect(() => {
      const unlisten = this.owner.on('session/event', (session, event) => {
        if (session !== agent.session || signal.aborted) return;
        if (!claimed && actualUserMessage(agent, event)) launch(event);
        else if (claimed && event.type === 'turn/end' && agent.session.isOwnSeq(event.seq)) { ended = true; end(); }
      });
      return () => { lifetime.abort(); unlisten(); };
    }, 'worktrees: first user message naming');
    const owned = this.owner.effect(() => effect, 'worktrees: naming attachment ownership');
    stop = () => { owned(); effect(); this.attachments.delete(agent); };
    this.attachments.set(agent, stop);
    // One startup/resume scan, never on an event/token. Recover the exact first own
    // authored append, including the crash window before its naming receipt.
    const events = agent.session.ownEvents();
    const first = events.find(event => actualUserMessage(agent, event));
    const seq = naming.messageSeq ?? first?.seq;
    if (seq !== undefined && events.some(event => event.seq > seq && event.type === 'turn/end')) { ended = true; end(); }
    if (claimed || first?.type === 'user/message') launch(first?.type === 'user/message' ? first : undefined);
  }
  async close(): Promise<void> {
    this.shutdown.abort();
    for (const stop of this.stops.splice(0)) stop();
    for (const stop of [...this.attachments.values()]) stop();
    await Promise.allSettled([...this.tasks]);
  }
}
