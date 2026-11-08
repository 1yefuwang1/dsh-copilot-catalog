import { copilotHeaders, replaceCatalog, selectAccountModels } from './catalog.js';
import { catalogCacheScope, createCatalogCacheEntry, readCatalogCacheEntry } from './catalog-cache.js';
import { asRecord, type AccountSelection, type CatalogCacheScope, type CopilotGrant, type CredentialReader, type DiscoveryOptions, type SyncResult } from './catalog-types.js';

export const VERSION_HEADER = '2026-06-01';
export const DEFAULT_TIMEOUT_MS = 10_000;

export class DiscoveryError extends Error {
  override readonly name = 'DiscoveryError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function oauthGrant(record: unknown): CopilotGrant | undefined {
  const entry = asRecord(record);
  const grant = entry?.kind === 'grant' ? asRecord(entry.payload) : undefined;
  return grant?.type === 'oauth' && typeof grant.refresh === 'string' && grant.refresh.trim() &&
    typeof grant.access === 'string' && grant.access.trim() && typeof grant.expires === 'number' && Number.isFinite(grant.expires)
    ? structuredClone(grant) as CopilotGrant : undefined;
}

/** Do not forward credentials to redirects, unrelated hosts, or unusual ports. */
export function discoveryUrl(baseUrl: unknown): URL {
  let base: URL;
  try {
    if (typeof baseUrl !== 'string') throw new TypeError();
    base = new URL(baseUrl);
  } catch {
    throw new DiscoveryError('UNTRUSTED_ENDPOINT', 'Unexpected Copilot API endpoint');
  }
  // GHE Cloud uses a tenant-specific Copilot API, not public subscription routing.
  // Trust only that API service; the tenant apex and api.<tenant> auth service
  // are not model-discovery destinations. Tenant slugs are single DNS labels.
  const trustedHost = base.hostname.endsWith('.githubcopilot.com') ||
    /^copilot-api\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/u.test(base.hostname);
  if (base.protocol !== 'https:' || !trustedHost ||
      base.username || base.password || (base.port && base.port !== '443')) {
    throw new DiscoveryError('UNTRUSTED_ENDPOINT', 'Unexpected Copilot API endpoint');
  }
  return new URL('/models', base);
}

/** One bounded account discovery: optional startup cache, always followed by live refresh. */
export async function syncCopilotCatalog(credentials: CredentialReader | undefined, {
  catalog,
  baselineCatalog,
  cache,
  signal: externalSignal,
  onAccount,
  onCatalog,
  onDiagnostic,
  oauth,
  recordKey,
  fetcher = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
  baseUrl,
  resolveApiKey,
  resolveAmbientApiKey,
  onEndpoint,
}: DiscoveryOptions): Promise<SyncResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 60000');
  }
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + timeoutMs;
  const assertActive = (): void => {
    // Timers cannot fire while synchronous metadata selection is running. Check
    // the monotonic deadline as well, before any write or registry publication.
    if (!signal.aborted && performance.now() >= deadline) {
      controller.abort(new DiscoveryError('TIMEOUT', 'Copilot discovery timed out'));
    }
    if (signal.aborted) throw signal.reason;
  };
  // Cache startup must not become the baseline for live selection. Clone the
  // descriptors as well as the map, so one account never mutates another's models.
  const isolated = cache !== undefined || baselineCatalog !== undefined;
  const baseline = isolated ? structuredClone(baselineCatalog ?? catalog) : catalog;
  let scope: CatalogCacheScope | undefined;
  let cached: AccountSelection | undefined;
  let failureReason = 'DISCOVERY_FAILED';
  const diagnose = (code: string): void => {
    if (externalSignal?.aborted) return;
    try { onDiagnostic?.(code); } catch { /* diagnostics never change behaviour */ }
  };
  const select = (body: unknown, endpoint: string): AccountSelection => {
    let selected: AccountSelection;
    try { selected = selectAccountModels(body, baseline, { baseUrl: endpoint }); } catch {
      throw new DiscoveryError('INVALID_CATALOG', 'No valid supported account catalog');
    }
    if (isolated) {
      selected = structuredClone(selected);
      const headers = copilotHeaders(baseline);
      for (const model of Object.values(selected.models)) {
        model.baseUrl = endpoint;
        model.headers = { ...headers };
      }
    }
    return selected;
  };
  const publish = (selected: AccountSelection, source: 'cache' | 'live', endpoint: string): void => {
    assertActive();
    try { replaceCatalog(catalog, selected.models); } catch {
      throw new DiscoveryError('IMMUTABLE_CATALOG', 'The upstream Copilot catalog is not mutable');
    }
    assertActive();
    try {
      onCatalog?.(selected, { source, baseUrl: endpoint, ...(scope ? { scope: { ...scope } } : {}) });
    } catch {
      throw new DiscoveryError('CATALOG_CALLBACK_FAILED', 'Copilot catalog notification failed');
    }
  };
  // Race the entire operation, including hooks/storage that might ignore abort.
  // Every write/registry notification is guarded before it can start.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const cancel = (): void => controller.abort(new DiscoveryError('CANCELLED', 'Copilot discovery cancelled'));
  externalSignal?.addEventListener('abort', cancel, { once: true });
  if (externalSignal?.aborted) cancel();
  timer = setTimeout(() => controller.abort(new DiscoveryError('TIMEOUT', 'Copilot discovery timed out')), timeoutMs);
  const work = async (): Promise<SyncResult> => {
    assertActive();
    failureReason = 'CREDENTIAL_READ_FAILED';
    const record = resolveApiKey ? undefined : await credentials?.readRecord(recordKey);
    assertActive();
    failureReason = 'AUTH_FAILED';
    let credential = resolveApiKey ? undefined : oauthGrant(record);
    // Keep the persisted refresh identity, never a rotating OAuth access token.
    const identity = credential ? { credential: structuredClone(credential) } : undefined;
    let apiKey: string | undefined;
    let url: URL;
    const adoptEndpoint = async (value: unknown): Promise<URL> => {
      assertActive();
      const endpoint = discoveryUrl(value);
      assertActive();
      onEndpoint?.(endpoint.origin);
      assertActive();
      if (cache || onAccount) {
        const nextScope = catalogCacheScope(recordKey, endpoint.origin, identity ?? { apiKey: apiKey! });
        if (scope?.accountKey !== nextScope.accountKey || scope.endpoint !== nextScope.endpoint) {
          // A refreshed route must not use a cache from the earlier endpoint.
          if (cached) {
            cached = undefined;
            assertActive();
            replaceCatalog(catalog, structuredClone(baseline));
          }
          scope = nextScope;
          assertActive();
          onAccount?.({ ...scope });
          assertActive();
          if (cache) {
            let value: unknown;
            try { value = await cache.read({ ...scope }, signal); } catch {
              assertActive();
              diagnose('CACHE_READ_FAILED');
            }
            assertActive();
            const entry = readCatalogCacheEntry(value, scope, now());
            if (entry) {
              try { cached = select(entry.raw, endpoint.origin); } catch { diagnose('CACHE_INVALID_CATALOG'); }
              if (cached) publish(cached, 'cache', endpoint.origin);
            } else if (value !== undefined) {
              diagnose('CACHE_REJECTED');
            }
          }
        }
      }
      return endpoint;
    };
    if (credential) {
      // Load cache before refresh: expired credentials must still permit offline reuse.
      let auth = await oauth.toAuth(credential);
      url = await adoptEndpoint(auth.baseUrl);
      if (now() + 5 * 60_000 >= credential.expires) {
        // No credential-store writes. The original adapter owns locked refresh.
        failureReason = 'OAUTH_REFRESH_FAILED';
        credential = await oauth.refresh(credential, signal);
        assertActive();
        failureReason = 'AUTH_FAILED';
        auth = await oauth.toAuth(credential);
        url = await adoptEndpoint(auth.baseUrl);
      }
      apiKey = auth.apiKey;
    } else {
      const entry = asRecord(record);
      const storedKey = entry?.kind === 'api-key' && typeof entry.key === 'string' ? entry.key : undefined;
      apiKey = resolveApiKey ? await resolveApiKey()
        : storedKey ?? (entry?.kind === 'grant' ? undefined : await resolveAmbientApiKey?.());
      assertActive();
      if (typeof apiKey !== 'string' || !apiKey.trim()) return { status: 'no Copilot credential' };
      if (baseUrl !== undefined) {
        url = await adoptEndpoint(baseUrl);
      } else if (/(?:^|;)proxy-ep=[^;]+/.test(apiKey)) {
        const auth = await oauth.toAuth({ type: 'oauth', access: apiKey, refresh: '', expires: 0 });
        url = await adoptEndpoint(auth.baseUrl);
      } else {
        throw new DiscoveryError('MISSING_ENDPOINT', 'API-key auth requires a Copilot proxy endpoint or explicit baseURL');
      }
    }
    assertActive();
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new DiscoveryError('INVALID_AUTH', 'No usable Copilot API token');
    }
    const headers = new Headers(copilotHeaders(baseline));
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${apiKey}`);
    headers.set('X-GitHub-Api-Version', VERSION_HEADER);
    failureReason = 'FETCH_FAILED';
    assertActive();
    const response = await fetcher(url, { headers, signal, redirect: 'error' });
    assertActive();
    if (!response.ok) {
      throw new DiscoveryError('HTTP_ERROR', `Copilot model discovery returned HTTP ${response.status}`);
    }
    failureReason = 'INVALID_JSON';
    const body: unknown = await response.json();
    assertActive();
    failureReason = 'DISCOVERY_FAILED';
    const selected = select(body, url.origin);
    assertActive();
    if (cache && scope) {
      const entry = createCatalogCacheEntry(scope, body, now(), [apiKey,
        ...(identity ? [identity.credential.access, identity.credential.refresh] : []),
        ...(credential ? [credential.access, credential.refresh] : [])]);
      if (entry) {
        // Verify the allowlisted raw document still selects valid models before persistence.
        try {
          select(entry.raw, url.origin);
          assertActive();
          await cache.write({ ...scope }, entry, signal);
        } catch (error) {
          assertActive();
          diagnose(error instanceof DiscoveryError && error.code === 'INVALID_CATALOG' ? 'CACHE_INVALID_CATALOG' : 'CACHE_WRITE_FAILED');
        }
      } else {
        diagnose('CACHE_NOT_PERSISTABLE');
      }
    }
    assertActive();
    publish(selected, 'live', url.origin);
    return { status: 'synced', count: Object.keys(selected.models).length, unsupported: selected.unsupported };
  };
  try {
    return await Promise.race([work(), stopped]);
  } catch (error) {
    if (externalSignal?.aborted) throw new DiscoveryError('CANCELLED', 'Copilot discovery cancelled');
    const reason = error instanceof DiscoveryError ? error.code : failureReason;
    if (cached && !['UNTRUSTED_ENDPOINT', 'IMMUTABLE_CATALOG', 'CATALOG_CALLBACK_FAILED'].includes(reason)) {
      diagnose(reason);
      return { status: 'cached', count: Object.keys(cached.models).length, unsupported: cached.unsupported, reason };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancel);
  }
}
