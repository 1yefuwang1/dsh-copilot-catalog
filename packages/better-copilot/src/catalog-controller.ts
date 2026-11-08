import { replaceCatalog } from './catalog.js';
import { DiscoveryError, syncCopilotCatalog } from './discovery.js';
import type { CatalogCache, CatalogCacheScope, CopilotAuthOptions, CredentialKey, CredentialReader, ModelCatalog, CopilotOAuth, SyncResult } from './catalog-types.js';

export const MISSING_MODEL_REFRESH_COOLDOWN_MS = 60_000;

export interface CatalogControllerOptions {
  catalog: ModelCatalog;
  baseline: ModelCatalog;
  credentials?: CredentialReader;
  oauth: CopilotOAuth;
  recordKey: CredentialKey;
  authOptions(): CopilotAuthOptions;
  cache(): CatalogCache | undefined;
  refreshIntervalMs(): number;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  changed(endpoint: string | undefined): void;
  diagnostic(code: string): void;
}

/** Refresh in one bounded flight; publication is synchronous and generation-guarded. */
export function createCatalogController(options: CatalogControllerOptions) {
  const now = options.now ?? Date.now;
  const lifetime = new AbortController();
  let generation = 0;
  let account: string | undefined;
  let endpoint: string | undefined;
  let lastAttempt: number | undefined;
  let lastMissingAttempt: number | undefined;
  let dirty = true;
  type Flight = { promise: Promise<SyncResult | undefined>; controller: AbortController; waiters: number; settled: boolean };
  let flight: Flight | undefined;
  const join = (owned: Flight, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    owned.waiters++;
    let released = false;
    return waitFor(owned.promise, signal, canceled => {
      if (released) return;
      released = true; owned.waiters--;
      if (canceled && owned.waiters === 0 && !owned.settled) {
        owned.controller.abort(new DiscoveryError('CANCELLED', 'All catalog refresh callers canceled'));
        if (flight === owned) { generation++; flight = undefined; dirty = true; lastAttempt = undefined; lastMissingAttempt = undefined; }
      }
    });
  };
  let route = '';

  const publish = (catalog: ModelCatalog, nextEndpoint: string | undefined) => {
    replaceCatalog(options.catalog, catalog);
    endpoint = nextEndpoint;
    options.changed(endpoint);
  };
  const invalidate = () => {
    generation++;
    flight?.controller.abort(new DiscoveryError('CANCELLED', 'Catalog refresh invalidated'));
    flight = undefined;
    dirty = true;
    lastAttempt = undefined;
    lastMissingAttempt = undefined;
    account = undefined;
    publish(options.baseline, undefined);
  };

  const refresh = (signal?: AbortSignal): Promise<SyncResult | undefined> => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    if (flight) return join(flight, signal);
    const controller = new AbortController();
    const combined = AbortSignal.any([lifetime.signal, controller.signal]);
    const revision = generation;
    lastAttempt = now();
    dirty = false;
    const active = () => { combined.throwIfAborted(); if (generation !== revision) throw new DiscoveryError('CANCELLED', 'Catalog refresh invalidated'); };
    // Never mutate the adapter's shared catalog while fetching or validating a response.
    const destination = structuredClone(options.baseline);
    let identified = false;
    const promise = (async (): Promise<SyncResult | undefined> => {
      try {
        const cache = options.cache();
        const result = await syncCopilotCatalog(options.credentials, {
          ...options.authOptions(), catalog: destination, baselineCatalog: options.baseline,
          oauth: options.oauth, recordKey: options.recordKey, signal: combined,
          ...(cache ? { cache } : {}),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), now,
          onAccount(scope: CatalogCacheScope) {
            active(); identified = true;
            const identity = JSON.stringify([scope.accountKey, scope.endpoint]);
            if (account !== identity) {
              account = identity;
              publish(options.baseline, scope.endpoint);
            }
          },
          onEndpoint(value) { active(); endpoint = value; options.changed(value); },
          onCatalog(selection, update) { active(); publish(selection.models, update.baseUrl); },
          onDiagnostic(code) { active(); options.diagnostic(code); },
        });
        active();
        if (result.status === 'no Copilot credential') { account = undefined; publish(options.baseline, undefined); }
        if (result.status === 'cached') options.diagnostic(`CACHE_FALLBACK:${result.reason}`);
        return result;
      } catch (error) {
        if (combined.aborted || generation !== revision) {
          if (!lifetime.signal.aborted && generation === revision) { dirty = true; lastAttempt = undefined; lastMissingAttempt = undefined; }
          throw error;
        }
        if (!identified) { account = undefined; publish(options.baseline, endpoint); }
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
    const auth = options.authOptions();
    // Settings endpoints/references are not credentials, and are safe to compare in memory.
    const currentRoute = JSON.stringify([auth.baseUrl, auth.resolveApiKey !== undefined]);
    if (route && route !== currentRoute) invalidate();
    route = currentRoute;
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
      replaceCatalog(options.catalog, options.baseline);
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
