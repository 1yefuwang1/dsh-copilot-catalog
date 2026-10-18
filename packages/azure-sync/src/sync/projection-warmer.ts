/**
 * Projection warm-up with the runtime's dual coldSnapshot signatures. The
 * checkpoint is written asynchronously, so a successful cold call is followed by
 * a bounded cachedSnapshot poll; no write path yields a partial result.
 * @module @1yefuwang1/dsh-azure-sync/sync/projection-warmer
 */
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type { SessionQueryEngine, SessionObservation } from '@deepseek-ai/dsh-session-query';
import { AzureSyncError } from '../azure/errors.js';

export interface ProjectionCache {
  readonly coldSnapshot: (...args: never[]) => unknown;
  cachedSnapshot(header: SessionHeader): unknown;
}

export interface ProjectionWarmerDeps {
  readonly query?: SessionQueryEngine;
  readonly cache?: ProjectionCache;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly polls?: number;
  readonly pollMs?: number;
}

export type WarmResult = 'complete' | 'partial';

export class ProjectionWarmer {
  private readonly deps: ProjectionWarmerDeps;

  constructor(deps: ProjectionWarmerDeps) {
    this.deps = deps;
  }

  async warm(sessionId: string, header: SessionHeader, inheritedEventCount: number, events: readonly SessionEvent[]): Promise<WarmResult> {
    if (this.deps.query !== undefined) {
      let observation: SessionObservation | undefined;
      try { observation = await this.deps.query.observeSession(sessionId as never, { projectionMode: 'all' }); }
      finally { observation?.[Symbol.dispose](); }
    }
    const cache = this.deps.cache;
    if (cache === undefined) return 'partial';
    const cold = cache.coldSnapshot as unknown as (...args: unknown[]) => unknown;
    const before = cache.cachedSnapshot(header);
    let wrote = false;
    try {
      if (cold.length >= 3) {
        await cold.call(cache, header, inheritedEventCount, events);
        wrote = true;
      } else {
        await cold.call(cache, sessionId, new AbortController().signal);
        wrote = true;
      }
    } catch (error) {
      if (!(error instanceof TypeError)) return 'partial';
      try {
        if (cold.length >= 3) { await cold.call(cache, sessionId, new AbortController().signal); }
        else { await cold.call(cache, header, inheritedEventCount, events); }
        wrote = true;
      } catch { return 'partial'; }
    }
    if (!wrote) return 'partial';
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
    for (let attempt = 0; attempt < (this.deps.polls ?? 20); attempt += 1) {
      const current = cache.cachedSnapshot(header);
      if (current !== undefined && current !== before) return 'complete';
      await sleep(this.deps.pollMs ?? 50);
    }
    const final = cache.cachedSnapshot(header);
    if (final !== undefined && final !== before) return 'complete';
    throw new AzureSyncError('PROJECTION_WARM_PARTIAL', 'The projection cache accepted no checkpoint for the imported session.');
  }
}
