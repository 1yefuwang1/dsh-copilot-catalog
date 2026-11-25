import { replaceCatalog } from './catalog.js';
import { MISSING_MODEL_REFRESH_COOLDOWN_MS } from './catalog-controller.js';
import { DiscoveryError } from './discovery.js';
import { syncOpencodeCatalog, type OpencodeSyncResult } from './opencode-discovery.js';
import type { CatalogCache, ModelCatalog } from './catalog-types.js';

export interface OpencodeCatalogControllerOptions {
  /** The applied route's live catalog, mutated in place on publication. */
  catalog: ModelCatalog;
  /** Immutable installed descriptors restored on invalidation/unload. */
  baseline: ModelCatalog;
  cache(): CatalogCache | undefined;
  refreshIntervalMs(): number;
  /** True only while the route exists and live discovery is configured. */
  active(): boolean;
  /** Effective listing baseURL; a change invalidates the published selection. */
  baseUrl(): string | undefined;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  changed(): void;
  diagnostic(code: string): void;
}

/**
 * Demand-driven refresh for the OpenCode Go route. It mirrors the Copilot
 * account controller's policy (single flight, interval, one bounded missing
 * model retry, synchronous publication) without credential or endpoint
 * negotiation: this catalog is public and only depends on the route endpoint.
 */
export function createOpencodeCatalogController(options: OpencodeCatalogControllerOptions) {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  let generation = 0;
  let route = '';
  let lastAttempt: number | undefined;
  let lastMissingAttempt: number | undefined;
  let dirty = true;
  let published = false;
  type Flight = { promise: Promise<OpencodeSyncResult | undefined>; controller: AbortController; waiters: number; settled: boolean };
  let flight: Flight | undefined;

  const publish = (models: ModelCatalog): void => {
    replaceCatalog(options.catalog, models);
    published = true;
    options.changed();
  };
  const restore = (): void => {
    replaceCatalog(options.catalog, options.baseline);
    published = false;
  };
  const invalidate = (): void => {
    generation++;
    flight?.controller.abort(new DiscoveryError('CANCELLED', 'OpenCode Go catalog refresh invalidated'));
    flight = undefined;
    dirty = true;
    lastAttempt = undefined;
    lastMissingAttempt = undefined;
    restore();
    options.changed();
  };

  const join = (owned: Flight, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    owned.waiters++;
    let released = false;
    return waitFor(owned.promise, signal, canceled => {
      if (released) return;
      released = true; owned.waiters--;
      if (canceled && owned.waiters === 0 && !owned.settled) {
        owned.controller.abort(new DiscoveryError('CANCELLED', 'All OpenCode Go catalog refresh callers canceled'));
        if (flight === owned) {
          generation++; flight = undefined; dirty = true; lastAttempt = undefined; lastMissingAttempt = undefined;
        }
      }
    });
  };

  const refresh = (signal?: AbortSignal): Promise<OpencodeSyncResult | undefined> => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    if (flight) return join(flight, signal);
    if (!options.active()) return Promise.resolve(undefined);
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, controller.signal]);
    const revision = generation;
    lastAttempt = now();
    dirty = false;
    const active = (): void => {
      combined.throwIfAborted();
      if (generation !== revision) throw new DiscoveryError('CANCELLED', 'OpenCode Go catalog refresh invalidated');
    };
    // Never mutate the adapter's shared catalog while fetching or validating a response.
    const destination = structuredClone(options.baseline);
    const cache = options.cache();
    const promise = (async (): Promise<OpencodeSyncResult | undefined> => {
      try {
        const result = await syncOpencodeCatalog({
          catalog: destination,
          baselineCatalog: options.baseline,
          ...(cache ? { cache } : {}),
          ...(options.baseUrl() === undefined ? {} : { baseUrl: options.baseUrl() }),
          signal: combined,
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          now,
          onCatalog(selection) {
            active();
            publish(selection.models);
          },
          onDiagnostic(code) { active(); options.diagnostic(code); },
        });
        active();
        if (result.status === 'cached') options.diagnostic(`CACHE_FALLBACK:${result.reason}`);
        return result;
      } catch (error) {
        if (combined.aborted || generation !== revision) {
          if (!lifetime.signal.aborted && generation === revision) {
            dirty = true; lastAttempt = undefined; lastMissingAttempt = undefined;
          }
          throw error;
        }
        options.diagnostic(error instanceof DiscoveryError ? error.code : 'DISCOVERY_FAILED');
        return undefined;
      }
    })();
    const owned: Flight = { promise, controller, waiters: 0, settled: false };
    flight = owned;
    void promise.finally(() => { owned.settled = true; if (flight === owned) flight = undefined; }).catch(() => {});
    return join(owned, signal);
  };

  const ensure = async (model?: string, signal?: AbortSignal): Promise<void> => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    if (!options.active()) {
      // An external settings change may disable discovery or remove the route.
      if (published) invalidate();
      return;
    }
    // Settings endpoints are not credentials, and are safe to compare in memory.
    const currentRoute = JSON.stringify([options.baseUrl() ?? null]);
    if (route !== currentRoute) {
      if (route !== '') invalidate();
      route = currentRoute;
    }
    if (flight) { await join(flight, signal); return; }
    const elapsed = lastAttempt === undefined ? Infinity : now() - lastAttempt;
    const missing = model !== undefined && !Object.hasOwn(options.catalog, model);
    const missingDue = missing && (lastMissingAttempt === undefined || now() - lastMissingAttempt >= MISSING_MODEL_REFRESH_COOLDOWN_MS);
    if (dirty || elapsed < 0 || elapsed >= options.refreshIntervalMs() || missingDue) {
      if (missing) lastMissingAttempt = now();
      await refresh(signal);
    }
  };

  return {
    ensure, refresh, invalidate,
    dispose() {
      lifetime.abort(new DiscoveryError('CANCELLED', 'Catalog plugin unloaded'));
      generation++;
      flight?.controller.abort(); flight = undefined;
      restore();
    },
  };
}

/** Cancel a waiter promptly without detaching or duplicating a shared refresh. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined, release: (canceled: boolean) => void): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); release(true); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal?.removeEventListener('abort', abort); release(false); resolve(value); }, error => { signal?.removeEventListener('abort', abort); release(false); reject(error); });
  });
}
