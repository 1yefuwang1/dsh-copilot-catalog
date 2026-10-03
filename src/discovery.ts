import { replaceCatalog, selectAccountModels } from './catalog.js';
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
  if (base.protocol !== 'https:' || !base.hostname.endsWith('.githubcopilot.com') ||
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
    let credential = oauthGrant(await credentials?.readRecord(recordKey));
    signal.throwIfAborted();
    if (!credential) return { status: 'no OAuth grant' };
    if (now() + 5 * 60_000 >= credential.expires) {
      // Deliberately no credential-store writes. The original adapter owns
      // persisted refresh and its cross-process locking on model requests.
      credential = await oauth.refresh(credential, signal);
      signal.throwIfAborted();
    }
    const auth = await oauth.toAuth(credential);
    signal.throwIfAborted();
    const url = discoveryUrl(auth.baseUrl);
    if (typeof auth.apiKey !== 'string' || !auth.apiKey.trim()) {
      throw new DiscoveryError('INVALID_AUTH', 'No usable Copilot API token');
    }
    const headers = new Headers(catalog['gpt-6-sol']?.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${auth.apiKey}`);
    headers.set('X-GitHub-Api-Version', VERSION_HEADER);
    const response = await fetcher(url, { headers, signal, redirect: 'error' });
    signal.throwIfAborted();
    if (!response.ok) {
      throw new DiscoveryError('HTTP_ERROR', `Copilot model discovery returned HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    signal.throwIfAborted();
    let selected;
    try { selected = selectAccountModels(body, catalog); } catch {
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
