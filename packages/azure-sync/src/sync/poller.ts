/**
 * Bounded manifest poller. No overlapping ticks; stop is synchronous and
 * unrefs its timer so plugin teardown cannot be held open.
 * @module @1yefuwang1/dsh-azure-sync/sync/poller
 */
export interface PollerOptions {
  readonly intervalMs: number;
  readonly refresh: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export class ManifestPoller {
  private readonly options: PollerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private ticking = false;
  private stopped = true;

  constructor(options: PollerOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = true;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try { await this.options.refresh(); }
    catch (error) { this.options.onError?.(error); }
    finally { this.ticking = false; }
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  get active(): boolean { return this.running; }
}
