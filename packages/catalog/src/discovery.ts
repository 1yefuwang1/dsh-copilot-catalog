import { copilotHeaders, replaceCatalog, selectAccountModels } from './catalog.js';
import { asRecord, type CopilotGrant, type CredentialReader, type DiscoveryOptions, type SyncResult } from './types.js';

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

/** One read-only, bounded startup discovery. All dependencies are explicit for tests. */
export async function syncCopilotCatalog(credentials: CredentialReader | undefined, {
  catalog,
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
  // Race the entire operation, including credential reads and OAuth hooks that
  // might not cooperate with abort. A late response may never commit changes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DiscoveryError('TIMEOUT', 'Copilot discovery timed out');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const work = async (): Promise<SyncResult> => {
    const record = resolveApiKey ? undefined : await credentials?.readRecord(recordKey);
    signal.throwIfAborted();
    let credential = resolveApiKey ? undefined : oauthGrant(record);
    let apiKey: string | undefined;
    let url: URL;
    const adoptEndpoint = (value: unknown): URL => {
      signal.throwIfAborted();
      const endpoint = discoveryUrl(value);
      onEndpoint?.(endpoint.origin);
      return endpoint;
    };
    if (credential) {
      // Capture routing before refresh/listing: fallback must not send an
      // Enterprise account to the bundled Individual endpoint.
      let auth = await oauth.toAuth(credential);
      url = adoptEndpoint(auth.baseUrl);
      if (now() + 5 * 60_000 >= credential.expires) {
        // No credential-store writes. The original adapter owns locked refresh.
        credential = await oauth.refresh(credential, signal);
        signal.throwIfAborted();
        auth = await oauth.toAuth(credential);
        url = adoptEndpoint(auth.baseUrl);
      }
      apiKey = auth.apiKey;
    } else {
      const entry = asRecord(record);
      const storedKey = entry?.kind === 'api-key' && typeof entry.key === 'string' ? entry.key : undefined;
      apiKey = resolveApiKey ? await resolveApiKey()
        : storedKey ?? (entry?.kind === 'grant' ? undefined : await resolveAmbientApiKey?.());
      signal.throwIfAborted();
      if (typeof apiKey !== 'string' || !apiKey.trim()) return { status: 'no Copilot credential' };
      if (baseUrl !== undefined) {
        url = adoptEndpoint(baseUrl);
      } else if (/(?:^|;)proxy-ep=[^;]+/.test(apiKey)) {
        // toAuth is read-only. It can decode an access token's proxy-ep without
        // requiring a refresh token or synthesizing a persisted OAuth grant.
        const auth = await oauth.toAuth({ type: 'oauth', access: apiKey, refresh: '', expires: 0 });
        url = adoptEndpoint(auth.baseUrl);
      } else {
        throw new DiscoveryError('MISSING_ENDPOINT', 'API-key auth requires a Copilot proxy endpoint or explicit baseURL');
      }
    }
    signal.throwIfAborted();
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new DiscoveryError('INVALID_AUTH', 'No usable Copilot API token');
    }
    const headers = new Headers(copilotHeaders(catalog));
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${apiKey}`);
    headers.set('X-GitHub-Api-Version', VERSION_HEADER);
    const response = await fetcher(url, { headers, signal, redirect: 'error' });
    signal.throwIfAborted();
    if (!response.ok) {
      throw new DiscoveryError('HTTP_ERROR', `Copilot model discovery returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    let selected;
    try { selected = selectAccountModels(body, catalog, { baseUrl: url.origin }); } catch {
      throw new DiscoveryError('INVALID_CATALOG', 'No valid supported account catalog');
    }
    signal.throwIfAborted();
    try { replaceCatalog(catalog, selected.models); } catch {
      throw new DiscoveryError('IMMUTABLE_CATALOG', 'The upstream Copilot catalog is not mutable');
    }
    return { status: 'synced', count: Object.keys(selected.models).length, unsupported: selected.unsupported };
  };
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
