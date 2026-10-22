/** Bounded runtime-owned work. These owners carry no lease or execution authority. */
import { AzureSyncError } from '../azure/errors.js';

export interface RuntimeHistoryJob<T> {
  readonly promise: Promise<T>;
  readonly signal: AbortSignal;
  readonly check: () => void;
}

interface Entry<T> extends RuntimeHistoryJob<T> {
  readonly controller: AbortController;
  readonly key: string;
  readonly authority: string;
  waiters: number;
  preparationRetained: boolean;
}

export interface PreparationWaiter<T> {
  readonly promise: Promise<T>;
  /** A proof-budget expiry retains only the already enrolled read-only owner. */
  release(proofBudgetExpired?: boolean): void;
}

/** Single flights survive poll completion/proof timeout, never intent/runtime revocation. */
export class RuntimeHistoryJobs {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly failures = new Map<string, { authority: string; count: number; retryAt: number; error: unknown }>();

  constructor(private readonly options: {
    readonly signal: AbortSignal;
    readonly authority: (sessionId: string) => string;
    readonly check: (sessionId: string, authority: string) => void;
    readonly timeoutMs?: number;
    readonly now?: () => number;
  }) {}

  private start<T>(kind: 'prepare' | 'work', sessionId: string, task: (job: RuntimeHistoryJob<T>) => Promise<T>): Entry<T> | undefined {
    this.options.signal.throwIfAborted();
    const key = `${kind}:${sessionId}`;
    const authority = this.options.authority(sessionId);
    this.options.check(sessionId, authority);
    const previous = this.entries.get(key);
    if (previous?.authority === authority && !previous.signal.aborted) return previous as Entry<T>;
    previous?.controller.abort();
    const failed = this.failures.get(key);
    if (failed?.authority === authority && failed.retryAt > (this.options.now ?? Date.now)()) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.options.signal]);
    const check = () => { signal.throwIfAborted(); this.options.check(sessionId, authority); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = this.options.timeoutMs ?? 120_000;
    timer = setTimeout(() => controller.abort(new AzureSyncError('CANCELLED', 'The bounded history preparation or sync job expired.')), timeout);
    timer.unref?.();
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const entry: Entry<T> = {
      key, authority, controller, signal, check, waiters: 0, preparationRetained: false,
      promise: Promise.resolve(undefined as T),
    };
    const work = Promise.resolve().then(() => { check(); return task(entry); }).then(value => { check(); return value; });
    const promise = Promise.race([work, cancelled]).then(value => {
      if (this.entries.get(key) === entry) this.failures.delete(key);
      return value;
    }, error => {
      // Explicit cancellation is not a retry failure. A finite deadline is: keep
      // its backoff so a stalled/cold history is not restarted by every tick.
      if ((!signal.aborted || controller.signal.reason instanceof AzureSyncError) && this.entries.get(key) === entry) {
        const count = failed?.authority === authority ? failed.count + 1 : 1;
        this.failures.set(key, { authority, count, error, retryAt: (this.options.now ?? Date.now)() + Math.min(300_000, 1_000 * 2 ** Math.min(count, 8)) });
      }
      throw error;
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    Object.assign(entry, { promise });
    this.entries.set(key, entry as Entry<unknown>);
    // Owners are runtime-tracked even when their last proof waiter has timed out.
    void promise.catch(() => undefined);
    return entry;
  }

  prepare<T>(sessionId: string, task: (job: RuntimeHistoryJob<T>) => Promise<T>): PreparationWaiter<T> {
    const entry = this.start('prepare', sessionId, task);
    if (entry === undefined) throw new AzureSyncError('TRANSIENT', 'History preparation is backing off after an earlier failure; retry shortly.');
    entry.waiters++;
    let released = false;
    return { promise: entry.promise, release: (proofBudgetExpired = false) => {
      if (released) return;
      released = true;
      entry.waiters--;
      if (proofBudgetExpired && !entry.signal.aborted) {
        try { entry.check(); entry.preparationRetained = true; }
        catch { entry.controller.abort(); }
      }
      if (entry.waiters === 0 && !entry.preparationRetained) entry.controller.abort();
    } };
  }

  work<T>(sessionId: string, task: (job: RuntimeHistoryJob<T>) => Promise<T>): Promise<T> | undefined {
    return this.start('work', sessionId, task)?.promise;
  }

  /** Join only existing work or its retained failure; never enroll an owner or reset backoff. */
  waitForWork(sessionId: string): Promise<void> {
    const key = `work:${sessionId}`, active = this.entries.get(key);
    if (active) return active.promise.then(() => undefined);
    const failure = this.failures.get(key);
    return failure?.authority === this.options.authority(sessionId) ? Promise.reject(failure.error) : Promise.resolve();
  }

  invalidate(sessionId: string): void {
    for (const kind of ['prepare', 'work']) {
      const key = `${kind}:${sessionId}`;
      this.entries.get(key)?.controller.abort();
      this.failures.delete(key);
    }
  }

  async settle(timeoutMs: number): Promise<void> {
    const work = Promise.allSettled([...this.entries.values()].map(entry => entry.promise));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); timer.unref?.(); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
