/**
 * Bounded manifest poller. A refresh owns a signal only until completion,
 * timeout, or stop; callbacks must check it before committing post-await work.
 * @module @1yefuwang1/dsh-azure-sync/sync/poller
 */
import { AzureSyncError, mapAzureError } from '../azure/errors.js';

export interface PollerOptions {
  readonly intervalMs: number;
  /** Forward the signal to IO and check it before publishing refreshed state. */
  readonly refresh: (signal: AbortSignal) => Promise<void>;
  readonly onError?: (error: unknown) => void;
  /** Maximum logical refresh lifetime, even if refresh ignores cancellation. Default: 30 s. */
  readonly refreshTimeoutMs?: number;
  /** Automatic retry cap; successful refresh resets the delay. Default: max(interval, 5 min). */
  readonly maxBackoffMs?: number;
}

interface PendingTick {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface Attempt extends PendingTick {
  readonly controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
const MAX_TIMER_MS = 2_147_483_647;

function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive integer no greater than ${MAX_TIMER_MS}.`);
  }
  return value;
}

function pendingTick(): PendingTick {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export class ManifestPoller {
  private readonly options: PollerOptions;
  private readonly refreshTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private current?: Attempt;
  private trailing?: PendingTick;
  private failures = 0;

  constructor(options: PollerOptions) {
    duration(options.intervalMs, 'intervalMs');
    this.refreshTimeoutMs = duration(options.refreshTimeoutMs ?? 30_000, 'refreshTimeoutMs');
    this.maxBackoffMs = duration(options.maxBackoffMs ?? Math.max(options.intervalMs, 300_000), 'maxBackoffMs');
    if (this.maxBackoffMs < options.intervalMs) throw new RangeError('maxBackoffMs must be at least intervalMs.');
    this.options = options;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.schedule(this.options.intervalMs);
  }

  /**
   * Explicit refresh bypasses automatic backoff. Calls during one attempt share
   * one trailing refresh and settle only when that refresh finishes or is stopped.
   */
  tick(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.clearTimer();
    if (this.current !== undefined) {
      this.trailing ??= pendingTick();
      return this.trailing.promise;
    }
    return this.begin().promise;
  }

  /** Synchronous and bounded: abort/invalidate IO, release all waiters, never await the provider. */
  stop(): void {
    this.running = false;
    this.clearTimer();
    const current = this.current;
    const trailing = this.trailing;
    this.current = undefined;
    this.trailing = undefined;
    if (current !== undefined) {
      if (current.timer !== undefined) clearTimeout(current.timer);
      current.settled = true;
      current.resolve();
      current.controller.abort(new AzureSyncError('CANCELLED', 'Manifest refresh was stopped.'));
    }
    trailing?.resolve();
  }

  get active(): boolean { return this.running; }

  private begin(pending = pendingTick()): Attempt {
    const attempt: Attempt = { ...pending, controller: new AbortController(), settled: false };
    this.current = attempt;
    attempt.timer = setTimeout(() => {
      this.finish(attempt, { ok: false, error: new AzureSyncError('TRANSIENT', 'Manifest refresh timed out.') });
    }, this.refreshTimeoutMs);
    attempt.timer.unref?.();
    // Register both outcomes even for an uncooperative provider. Late rejection
    // is observed, while identity/settled checks ignore either late outcome.
    try {
      void Promise.resolve(this.options.refresh(attempt.controller.signal)).then(
        () => this.finish(attempt, { ok: true }),
        (error: unknown) => this.finish(attempt, { ok: false, error }),
      );
    } catch (error) {
      this.finish(attempt, { ok: false, error });
    }
    return attempt;
  }

  private finish(attempt: Attempt, outcome: Outcome): void {
    if (this.current !== attempt || attempt.settled) return;
    attempt.settled = true;
    if (attempt.timer !== undefined) clearTimeout(attempt.timer);
    const error = outcome.ok ? undefined : mapAzureError(outcome.error, 'manifest refresh');
    this.failures = error === undefined ? 0 : Math.min(this.failures + 1, 31);
    if (error?.code === 'AUTH_REQUIRED' || error?.code === 'AUTH_FAILED') this.running = false;
    // Invalidate even successful attempts: detached continuations must not use
    // an old signal to publish after the next refresh or a restart.
    attempt.controller.abort(error ?? new AzureSyncError('CANCELLED', 'Manifest refresh completed.'));
    if (error !== undefined) this.reportError(error);
    // Abort/error listeners may stop or restart the poller synchronously.
    if (this.current !== attempt) return;
    this.current = undefined;
    attempt.resolve();
    const trailing = this.trailing;
    this.trailing = undefined;
    if (!this.running) {
      trailing?.resolve();
    } else if (trailing !== undefined) {
      this.begin(trailing);
    } else {
      this.schedule(Math.min(this.maxBackoffMs, this.options.intervalMs * 2 ** this.failures));
    }
  }

  private reportError(error: AzureSyncError): void {
    try {
      // An async observer is permitted by TS's void callback typing. Observe its
      // rejection too, but never let diagnostics break polling or teardown.
      void Promise.resolve(this.options.onError?.(error)).catch(() => undefined);
    } catch { /* Diagnostics must not change refresh lifecycle. */ }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    const timer = setTimeout(() => {
      if (this.timer !== timer || !this.running) return;
      this.timer = undefined;
      this.begin();
    }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
