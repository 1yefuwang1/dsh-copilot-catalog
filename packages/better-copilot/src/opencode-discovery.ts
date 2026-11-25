import { replaceCatalog } from './catalog.js';
import { createCatalogCacheEntry, opencodeCacheScope, readCatalogCacheEntry } from './catalog-cache.js';
import type { CatalogCache, CatalogCacheScope, ModelCatalog } from './catalog-types.js';
import { DiscoveryError } from './discovery.js';
import {
  normalizeOpencodeCatalog,
  opencodeGoListingUrl,
  OPENCODE_GO_MAX_RESPONSE_BYTES,
  OPENCODE_GO_PROVIDER,
  selectOpencodeModels,
  type OpencodeMetadata,
} from './opencode.js';

export const OPENCODE_TIMEOUT_MS = 10_000;

export type OpencodeCatalogUpdate = {
  source: 'cache' | 'live';
  /** Canonical listing URL the selection was fetched from. */
  listingUrl: string;
  scope: CatalogCacheScope;
};

export type OpencodeSyncResult =
  | { status: 'synced'; count: number; unsupported: string[] }
  | { status: 'cached'; count: number; unsupported: string[]; reason: string };

export interface OpencodeDiscoveryOptions {
  /** Mutable destination owned by one refresh flight, never the adapter's shared catalog. */
  catalog: ModelCatalog;
  /** Immutable installed descriptors, also the fallback when nothing can be fetched. */
  baselineCatalog: ModelCatalog;
  cache?: CatalogCache;
  signal?: AbortSignal;
  /** Effective route baseURL; omission uses OpenCode's public listing. */
  baseUrl?: string;
  /** Synchronous publication callback; never called after cancellation or the deadline. */
  onCatalog?: (selection: ReturnType<typeof selectOpencodeModels>, update: OpencodeCatalogUpdate) => void;
  /** Controlled cache/fallback reason codes only, never raw errors or response bodies. */
  onDiagnostic?: (code: string) => void;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

function cacheMetadata(value: unknown): OpencodeMetadata[] | undefined {
  // readCatalogCacheEntry already validated each entry with canonicalOpencodeMetadata.
  const data = (value as { data?: unknown } | undefined)?.data;
  return Array.isArray(data) ? data as OpencodeMetadata[] : undefined;
}

/**
 * Read the bounded response without trusting a declared length. A provider that
 * streams an oversized or non-JSON document fails rather than being buffered.
 */
async function readResponse(response: Response, signal: AbortSignal, check: () => void): Promise<unknown> {
  const declared = response.headers?.get?.('content-length');
  if (typeof declared === 'string' && /^\d+$/u.test(declared) && Number(declared) > OPENCODE_GO_MAX_RESPONSE_BYTES) {
    throw new DiscoveryError('RESPONSE_TOO_LARGE', 'OpenCode Go model list is too large');
  }
  const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) {
    throw new DiscoveryError('INVALID_JSON', 'OpenCode Go model list is not JSON');
  }
  if (response.body === null || response.body === undefined) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      check();
      const chunk = await reader.read();
      check();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new DiscoveryError('INVALID_JSON', 'OpenCode Go model list is not JSON');
      bytes += chunk.value.byteLength;
      if (bytes > OPENCODE_GO_MAX_RESPONSE_BYTES) {
        throw new DiscoveryError('RESPONSE_TOO_LARGE', 'OpenCode Go model list is too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* settlement may already release the stream */ }
    try { reader.releaseLock(); } catch { /* a pending read is being cancelled */ }
  }
  signal.throwIfAborted();
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } catch {
    throw new DiscoveryError('INVALID_JSON', 'OpenCode Go model list is not valid JSON');
  }
}

/**
 * One bounded OpenCode Go discovery: optional persisted selection first, then a
 * live listing. The public catalog is not account-scoped, so no credential is
 * read or sent; a custom baseURL only redirects the listing request.
 */
export async function syncOpencodeCatalog(options: OpencodeDiscoveryOptions): Promise<OpencodeSyncResult> {
  const timeoutMs = options.timeoutMs ?? OPENCODE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 60000');
  }
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + timeoutMs;
  const assertActive = (): void => {
    if (!signal.aborted && performance.now() >= deadline) {
      controller.abort(new DiscoveryError('TIMEOUT', 'OpenCode Go discovery timed out'));
    }
    if (signal.aborted) throw signal.reason;
  };
  const diagnose = (code: string): void => {
    if (options.signal?.aborted) return;
    try { options.onDiagnostic?.(code); } catch { /* diagnostics never change behaviour */ }
  };
  const cancel = (): void => controller.abort(new DiscoveryError('CANCELLED', 'OpenCode Go discovery cancelled'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DiscoveryError('TIMEOUT', 'OpenCode Go discovery timed out')), timeoutMs);
  const stopped = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  let scope: CatalogCacheScope | undefined;
  let cached: ReturnType<typeof selectOpencodeModels> | undefined;
  let failureReason = 'DISCOVERY_FAILED';
  const select = (metadata: readonly OpencodeMetadata[]) => {
    try {
      return selectOpencodeModels(metadata, options.baselineCatalog);
    } catch {
      throw new DiscoveryError('INVALID_CATALOG', 'No supported OpenCode Go chat models found');
    }
  };
  const publish = (selection: ReturnType<typeof selectOpencodeModels>, source: 'cache' | 'live', listingUrl: string,
    cacheScope: CatalogCacheScope): void => {
    assertActive();
    try {
      replaceCatalog(options.catalog, selection.models);
    } catch {
      throw new DiscoveryError('IMMUTABLE_CATALOG', 'The upstream OpenCode Go catalog is not mutable');
    }
    assertActive();
    try {
      options.onCatalog?.(selection, { source, listingUrl, scope: { ...cacheScope } });
    } catch {
      throw new DiscoveryError('CATALOG_CALLBACK_FAILED', 'OpenCode Go catalog notification failed');
    }
  };

  const work = async (): Promise<OpencodeSyncResult> => {
    assertActive();
    let listing: URL;
    try {
      listing = opencodeGoListingUrl(options.baseUrl);
    } catch {
      throw new DiscoveryError('UNTRUSTED_ENDPOINT', 'Unexpected OpenCode Go API endpoint');
    }
    try {
      scope = opencodeCacheScope(listing.href);
    } catch {
      throw new DiscoveryError('UNTRUSTED_ENDPOINT', 'Unexpected OpenCode Go API endpoint');
    }
    if (options.cache) {
      let value: unknown;
      try {
        value = await options.cache.read({ ...scope }, signal);
      } catch {
        assertActive();
        diagnose('CACHE_READ_FAILED');
      }
      assertActive();
      if (value !== undefined) {
        const entry = readCatalogCacheEntry(value, scope, now());
        if (!entry) {
          diagnose('CACHE_REJECTED');
        } else {
          const metadata = cacheMetadata(entry.raw);
          try {
            if (!metadata) throw new Error('invalid cache');
            cached = select(metadata);
          } catch {
            diagnose('CACHE_INVALID_CATALOG');
          }
          if (cached) publish(cached, 'cache', listing.href, scope);
        }
      }
    }
    failureReason = 'FETCH_FAILED';
    const headers = new Headers({ Accept: 'application/json' });
    assertActive();
    const response = await fetcher(listing, { method: 'GET', headers, signal, redirect: 'error' });
    assertActive();
    if (!response.ok) throw new DiscoveryError('HTTP_ERROR', `OpenCode Go model discovery returned HTTP ${response.status}`);
    failureReason = 'INVALID_JSON';
    const body = await readResponse(response, signal, assertActive);
    assertActive();
    failureReason = 'INVALID_CATALOG';
    const normalized = normalizeOpencodeCatalog(body);
    if (!normalized) throw new DiscoveryError('INVALID_CATALOG', 'Invalid OpenCode Go model list');
    const selection = select(normalized.data);
    assertActive();
    if (options.cache) {
      const entry = createCatalogCacheEntry(scope, normalized, now(), [], OPENCODE_GO_PROVIDER);
      if (!entry) {
        diagnose('CACHE_NOT_PERSISTABLE');
      } else {
        // Verify the canonical document still selects valid models before persisting it.
        try {
          const metadata = cacheMetadata(entry.raw);
          if (!metadata) throw new Error('invalid cache');
          select(metadata);
          assertActive();
          await options.cache.write({ ...scope }, entry, signal);
        } catch {
          assertActive();
          diagnose('CACHE_WRITE_FAILED');
        }
      }
    }
    assertActive();
    publish(selection, 'live', listing.href, scope);
    return { status: 'synced', count: Object.keys(selection.models).length, unsupported: selection.unsupported };
  };

  try {
    return await Promise.race([work(), stopped]);
  } catch (error) {
    if (options.signal?.aborted) throw new DiscoveryError('CANCELLED', 'OpenCode Go discovery cancelled');
    const reason = error instanceof DiscoveryError ? error.code : failureReason;
    if (cached && !['UNTRUSTED_ENDPOINT', 'IMMUTABLE_CATALOG', 'CATALOG_CALLBACK_FAILED'].includes(reason)) {
      diagnose(reason);
      return { status: 'cached', count: Object.keys(cached.models).length, unsupported: cached.unsupported, reason };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
