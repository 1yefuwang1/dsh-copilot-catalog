/**
 * Per-session debounced upload scheduling. One pending timer per session;
 * `flushNow` cancels the debounce and runs the barrier immediately.
 * @module @1yefuwang1/dsh-azure-sync/sync/scheduler
 */
export class UploadScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly run: (sessionId: string) => Promise<void>;
  private readonly delayMs: number;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(run: (sessionId: string) => Promise<void>, delayMs = 750) {
    this.run = run;
    this.delayMs = delayMs;
  }

  schedule(sessionId: string): void {
    if (this.stopped) return;
    const previous = this.timers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      const pending = this.run(sessionId).catch(() => undefined);
      this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending));
    }, this.delayMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  async flushNow(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
    const pending = this.run(sessionId);
    this.pending.add(pending);
    try { await pending; } finally { this.pending.delete(pending); }
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.race([Promise.allSettled([...this.pending]), new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  }
}
