import { DiscoveryError, syncCopilotCatalog } from './discovery.js';
import type { CatalogPlugin, PluginDependencies } from './types.js';

/** Keep integration separate from peer loading so lifecycle behavior is testable. */
export function createPlugin({ original, catalog, oauth, fetcher, timeoutMs }: PluginDependencies): CatalogPlugin {
  if (typeof original?.apply !== 'function' || typeof original.recordKeyFor !== 'function' ||
      !original.Config || !Array.isArray(original.inject) || !catalog ||
      typeof oauth?.refresh !== 'function' || typeof oauth.toAuth !== 'function') {
    throw new Error('Incompatible DSH/pi-ai runtime; see the supported versions in README');
  }
  const plugin: CatalogPlugin = {
    name: original.name,
    Config: original.Config,
    inject: [...new Set([...original.inject, 'credentials'])],
    sync: (credentials) => syncCopilotCatalog(credentials, {
      catalog, oauth, recordKey: original.recordKeyFor('github-copilot'), fetcher, timeoutMs,
    }),
    async apply(ctx, config) {
      try {
        const result = await plugin.sync(ctx.get('credentials'));
        if (result.status === 'synced') {
          // JSON quoting prevents model IDs from injecting log lines.
          ctx.logger?.info?.('Copilot catalog synced: %d enabled models; unsupported new IDs: %s',
            result.count, JSON.stringify(result.unsupported));
        } else {
          ctx.logger?.info?.('Copilot catalog kept bundled defaults: %s', result.status);
        }
      } catch (error) {
        // Arbitrary OAuth/network/credential errors may include tokens or bodies.
        // Only our controlled code is safe to log; never log the raw exception.
        const reason = error instanceof DiscoveryError ? error.code : 'DISCOVERY_FAILED';
        ctx.logger?.warn?.('Copilot model discovery failed; keeping current catalog: %s', reason);
      }
      return original.apply(ctx, config);
    },
  };
  return plugin;
}
