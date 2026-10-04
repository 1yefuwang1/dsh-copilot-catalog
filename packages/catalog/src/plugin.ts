import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DiscoveryError, syncCopilotCatalog } from './discovery.js';
import type { CatalogPlugin, CopilotAuthOptions, PluginConfig, PluginDependencies } from './types.js';

type CredentialRef = Parameters<Parameters<PluginDependencies['original']['apply']>[0]['credentials']['resolve']>[0];

/** Add an account endpoint as a runtime default, never as a persisted setting. */
export function withCopilotEndpoint(config: PluginConfig, endpoint: string | undefined): PluginConfig {
  if (!endpoint) return config;
  const source = config.providers;
  let previous: ReturnType<typeof source.get> | undefined;
  let resolved: ReturnType<typeof source.get> | undefined;
  const get = () => {
    const raw = source.get();
    if (raw === previous && resolved !== undefined) return resolved;
    const profile = raw['github-copilot'];
    previous = raw;
    // Explicit user baseURL wins. Do not overwrite other providers or settings.
    resolved = !profile || profile.baseURL !== undefined && profile.baseURL !== null
      ? raw : Object.freeze({ ...raw, 'github-copilot': Object.freeze({ ...profile, baseURL: endpoint }) });
    return resolved;
  };
  return {
    ...config,
    // Volatile references are frozen. Copy their protocol (including symbols)
    // into a detached facade instead of violating frozen-property Proxy rules.
    providers: Object.freeze({ ...source, get }),
  };
}

/** Keep integration separate from peer loading so lifecycle behavior is testable. */
export function createPlugin({ original, catalog, oauth, fetcher, timeoutMs }: PluginDependencies): CatalogPlugin {
  if (typeof original?.apply !== 'function' || typeof original.recordKeyFor !== 'function' ||
      !original.Config || !Array.isArray(original.inject) || !catalog ||
      typeof oauth?.refresh !== 'function' || typeof oauth.toAuth !== 'function') {
    throw new Error('Incompatible DSH/pi-ai runtime; see the supported versions in README');
  }
  let accountEndpoint: string | undefined;
  const plugin: CatalogPlugin = {
    name: original.name,
    Config: original.Config,
    inject: [...new Set([...original.inject, 'credentials'])],
    sync: (credentials, authOptions) => {
      accountEndpoint = undefined;
      return syncCopilotCatalog(credentials, {
        catalog, oauth, recordKey: original.recordKeyFor('github-copilot'), fetcher, timeoutMs,
        ...authOptions,
        onEndpoint: (endpoint) => { accountEndpoint = endpoint; },
      });
    },
    async apply(ctx, config) {
      try {
        const credentials = ctx.get('credentials');
        const profile = config.providers.get()['github-copilot'];
        const ref = profile?.apiKeyEnv;
        const readReference = async (value: string) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
            throw new DiscoveryError('INVALID_AUTH', 'Invalid credential reference');
          }
          return (await credentials?.resolve(value as CredentialRef))?.value;
        };
        const authOptions: CopilotAuthOptions = {
          ...(typeof profile?.baseURL === 'string' ? { baseUrl: profile.baseURL } : {}),
          ...(typeof ref === 'string' ? { resolveApiKey: () => readReference(ref) } : {}),
          resolveAmbientApiKey: async () => (await readReference('COPILOT_GITHUB_TOKEN'))
            ?? launchEnvironmentOf(ctx).get('COPILOT_GITHUB_TOKEN')?.value,
        };
        const result = await plugin.sync(credentials, authOptions);
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
      if (accountEndpoint) ctx.logger?.info?.('Copilot runtime endpoint: %s', accountEndpoint);
      return original.apply(ctx, withCopilotEndpoint(config, accountEndpoint));
    },
  };
  return plugin;
}
