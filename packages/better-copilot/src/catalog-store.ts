import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import type { CatalogCache, CatalogCacheEntry, CatalogCacheScope } from './catalog-types.js';
import { readCatalogCacheEntry } from './catalog-cache.js';

export const CATALOG_DOMAIN_NAME = 'dsh_better_copilot_catalog';

/** The discovery layer validates the bounded, allowlisted metadata again on every read. */
export const catalogDomain = {
  name: CATALOG_DOMAIN_NAME, version: 1, layout: 'per-record' as const,
  invalidRecords: 'backup-and-skip' as const,
  tables: { catalogs: { valueSchema: z.unknown().transform((value, ctx) => {
    const entry = value as Partial<CatalogCacheEntry> | null;
    const scope = entry && typeof entry.accountKey === 'string' && typeof entry.endpoint === 'string'
      ? { accountKey: entry.accountKey, endpoint: entry.endpoint } : undefined;
    const parsed = scope ? readCatalogCacheEntry(value, scope, Date.now()) : undefined;
    if (!parsed) { ctx.addIssue({ code: 'custom', message: 'Invalid or expired Copilot catalog cache' }); return z.NEVER; }
    return parsed;
  }) } },
};

const keyFor = (scope: CatalogCacheScope): string => createHash('sha256')
  .update(JSON.stringify([scope.accountKey, scope.endpoint])).digest('hex');

/** No filesystem path or credential write capability: DSH owns storage placement. */
export async function openCatalogStore(storage: DomainFacility, signal: AbortSignal): Promise<CatalogCache & { close(): Promise<void> }> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1000)]);
  const opening = storage.open(catalogDomain);
  let accepted = false;
  // open() has no signal. A late handle is closed rather than leaked after timeout/unload.
  void opening.then(async domain => {
    if (!accepted && deadline.aborted) await domain.close();
  }).catch(() => {});
  const domain = await new Promise<Awaited<typeof opening>>((resolve, reject) => {
    const abort = () => { deadline.removeEventListener('abort', abort); reject(deadline.reason); };
    deadline.addEventListener('abort', abort, { once: true });
    if (deadline.aborted) abort();
    opening.then(domain => {
      deadline.removeEventListener('abort', abort);
      if (deadline.aborted) { reject(deadline.reason); return; }
      accepted = true; resolve(domain);
    }, error => { deadline.removeEventListener('abort', abort); reject(error); });
  });
  if (signal.aborted) { await domain.close(); signal.throwIfAborted(); }
  const table = domain.table('catalogs');
  let closed = false;
  return {
    async read(scope, caller) {
      signal.throwIfAborted(); caller.throwIfAborted();
      if (closed) throw new Error('Catalog cache is closed');
      return table.get(keyFor(scope));
    },
    async write(scope, entry, caller) {
      signal.throwIfAborted(); caller.throwIfAborted();
      if (closed) throw new Error('Catalog cache is closed');
      if (!readCatalogCacheEntry(entry, scope, Date.now())) throw new Error('Invalid Copilot catalog cache scope or metadata');
      const current = table.get(keyFor(scope));
      if (current && current.savedAt > entry.savedAt) return;
      // Domain writes are durable and serialized; an already-started put cannot be canceled.
      await table.put(keyFor(scope), entry);
    },
    async close() { closed = true; await domain.close(); },
  };
}
