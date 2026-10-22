/** Per-call authority and bounded subscriber-owned immutable work. */
import { AzureSyncError } from '../azure/errors.js';

export interface HistoryReadContext {
  readonly signal?: AbortSignal;
  readonly check?: () => void | Promise<void>;
  readonly allowDisabled?: boolean;
  readonly expectedGeneration?: number;
  readonly expectedRootSessionId?: string;
  readonly expectedRootGeneration?: number;
  readonly expectedScope?: string;
}
export function cancelled(): AzureSyncError { return new AzureSyncError('CANCELLED', 'History verification was cancelled.'); }
export class HistoryOwner {
  readonly signal: AbortSignal;
  constructor(readonly context: HistoryReadContext, runtime: AbortSignal) { this.signal = context.signal ? AbortSignal.any([context.signal, runtime]) : runtime; }
  async check(): Promise<void> {
    if (this.signal.aborted) throw cancelled();
    await this.context.check?.();
    if (this.signal.aborted) throw cancelled();
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    if (this.signal.aborted) throw cancelled();
    let abort: (() => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => { abort = () => reject(cancelled()); this.signal.addEventListener('abort', abort, { once: true }); });
    try { const value = await Promise.race([promise, cancellation]); await this.check(); return value; }
    finally { if (abort) this.signal.removeEventListener('abort', abort); }
  }
  async io<T>(fn: () => Promise<T>): Promise<T> { await this.check(); return this.wait(fn()); }
}
export class HistorySemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new AzureSyncError('INVALID_CONFIG', 'History concurrency must be a positive integer.');
  }
  async acquire(owner: HistoryOwner): Promise<() => void> {
    await owner.check();
    while (this.active >= this.limit) {
      let wake!: () => void;
      const ready = new Promise<void>(resolve => { wake = resolve; this.queue.push(resolve); });
      try { await owner.wait(ready); }
      finally { const index = this.queue.indexOf(wake); if (index >= 0) this.queue.splice(index, 1); }
    }
    await owner.check();
    // No await between this increment and the final capacity test.
    if (this.active >= this.limit) return this.acquire(owner);
    this.active += 1;
    let released = false;
    return () => { if (released) return; released = true; this.active -= 1; for (const wake of this.queue.splice(0)) wake(); };
  }
}
interface FetchJob { readonly owners: Set<HistoryOwner>; readonly controller: AbortController; readonly promise: Promise<Buffer>; }
export class HistoryFetches {
  private readonly jobs = new Map<string, FetchJob>();
  private readonly semaphore: HistorySemaphore;
  constructor(limit: number) { this.semaphore = new HistorySemaphore(limit); }
  async fetch(key: string, owner: HistoryOwner, load: (context: { signal: AbortSignal; check: () => Promise<void> }) => Promise<Buffer>): Promise<Buffer> {
    await owner.check();
    let job = this.jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const owners = new Set<HistoryOwner>([owner]);
      const controller = new AbortController();
      const check = async () => {
        for (const candidate of [...owners]) { try { await candidate.check(); } catch { owners.delete(candidate); } }
        if (owners.size === 0 || controller.signal.aborted) { controller.abort(); throw cancelled(); }
      };
      const sharedOwner = new HistoryOwner({ check }, controller.signal);
      // The microtask starts only after the job and its first owner are registered.
      const promise = Promise.resolve().then(async () => {
        const release = await this.semaphore.acquire(sharedOwner);
        let transport: Promise<Buffer> | undefined;
        try {
          await check(); transport = load({ signal: controller.signal, check });
          const bytes = await sharedOwner.wait(transport); await check(); return Buffer.from(bytes);
        } finally {
          // Ignored abort detaches subscribers promptly, but still occupies its raw-transport slot.
          // A retry must not create an unbounded fleet of ignored in-flight requests.
          if (transport) void transport.then(release, release);
          else release();
        }
      });
      job = { owners, controller, promise };
      this.jobs.set(key, job);
      const captured = job;
      void promise.then(() => {}, () => {}).finally(() => { if (this.jobs.get(key) === captured) this.jobs.delete(key); });
    } else job.owners.add(owner);
    try { return Buffer.from(await owner.wait(job.promise)); }
    finally { job.owners.delete(owner); if (job.owners.size === 0) job.controller.abort(); }
  }
  async close(): Promise<void> {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    // Transport can ignore cancellation; active authority has already been fenced.
    await Promise.allSettled(jobs.map(job => job.promise));
    this.jobs.clear();
  }
}
