import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { createCopilotAuthResolver } from './auth.js';
import { createConfig, type BetterCopilotConfig, type BetterCopilotConfigSchema, type ProviderProfile, type ProvidersValue } from './config.js';
import { DiscoveryError, syncCopilotCatalog } from './discovery.js';
import { createCopilotWireIdentity, installCopilotIdentityHeaders, installCopilotRequestTransform, wireIdentityMode, type CopilotRequestTransform } from './identity.js';
import { CopilotSearchProvider } from './provider.js';
import { TOOL_SCHEMA_SKIPPED } from './schema.js';
import { guardCopilotRequestBody } from './guard.js';
import type { BetterCopilotRuntime } from './runtime.js';
import type {
  CopilotAuthOptions,
  CredentialReader,
  DiscoveryOptions,
  OriginalAdapter,
  PluginConfig,
  PluginContext,
  SyncResult,
} from './catalog-types.js';
import type { CopilotSearchOptions, SearchContext, SearchRuntime } from './search-types.js';
import type { GuardSettings } from './guard-types.js';

export const name = 'better-copilot';

/** Search and guard are optional capabilities; the adapter requires these two. */
export const inject = ['llm', 'credentials'];

/**
 * Dependencies for the merged plugin. The merged runtime already contains the
 * adapter, its catalog and its raw OAuth hooks, so the default factory is just
 * `createPlugin(await loadRuntime())`; tests inject narrower doubles.
 */
export interface BetterCopilotDependencies extends BetterCopilotRuntime {
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Test seam for the process-wide wire-identity installer. */
  installIdentity?: () => () => void;
  /** Search-owned view; defaults to the merged runtime. */
  searchRuntime?: SearchRuntime;
}

export interface BetterCopilotPlugin {
  readonly name: string;
  readonly Config: BetterCopilotConfigSchema;
  readonly inject: string[];
  /** Root convenience wrapper preserved from the predecessor catalog package. */
  sync(credentials?: CredentialReader, authOptions?: CopilotAuthOptions): Promise<SyncResult>;
  apply(ctx: PluginContext, config: BetterCopilotConfig): Promise<void>;
}

/** The minimum web seam this plugin uses; the host supplies the real service. */
interface WebSeam {
  registerSearchProvider(provider: unknown): unknown;
}
interface InjectContext {
  web: WebSeam;
}

/** An explicit API-key reference wins over the stored grant, as in pi-ai. */
type CredentialRef = Parameters<Parameters<OriginalAdapter['apply']>[0]['credentials']['resolve']>[0];

/** One settings snapshot per assembly: the guard never mixes configuration revisions. */
function guardSettings(config: BetterCopilotConfig['toolSchema']): GuardSettings {
  return { providers: config.providers.get(), families: config.families.get(), logFixes: config.logFixes.get() };
}

/**
 * Keep the adapter's reactive protocol while adding the discovered endpoint.
 * Explicit user baseURL wins; other providers and settings are never overwritten.
 * Volatile references are frozen, so their protocol (including symbols) is copied
 * into a detached facade instead of violating frozen-property proxy rules.
 */
export function providersFacade(source: ProvidersValue, endpoint: string | undefined): ProvidersValue {
  if (!endpoint) return source;
  let previous: Record<string, ProviderProfile> | undefined;
  let resolved: Record<string, ProviderProfile> | undefined;
  const get = () => {
    const raw = source.get();
    if (raw === previous && resolved !== undefined) return resolved;
    const profile = raw['github-copilot'];
    previous = raw;
    resolved = !profile || profile.baseURL !== undefined && profile.baseURL !== null
      ? raw : Object.freeze({ ...raw, 'github-copilot': Object.freeze({ ...profile, baseURL: endpoint }) });
    return resolved;
  };
  return Object.freeze({ ...source, get }) as ProvidersValue;
}

export function createPlugin(dependencies: BetterCopilotDependencies): BetterCopilotPlugin {
  const { original } = dependencies;
  if (typeof original?.apply !== 'function' || typeof original.recordKeyFor !== 'function' ||
      !original.Config || !Array.isArray(original.inject)) {
    throw new Error('Incompatible DSH/pi-ai runtime; see the supported versions in README');
  }
  const searchRuntime: SearchRuntime = dependencies.searchRuntime ?? dependencies;
  let accountEndpoint: string | undefined;

  /** One read-only discovery per mount; never writes credentials. */
  const sync = (credentials?: CredentialReader, authOptions?: CopilotAuthOptions): Promise<SyncResult> => {
    accountEndpoint = undefined;
    const options: DiscoveryOptions = {
      catalog: dependencies.catalog,
      oauth: dependencies.oauth,
      recordKey: dependencies.recordKeyFor('github-copilot'),
      ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...authOptions,
      onEndpoint: (endpoint: string) => { accountEndpoint = endpoint; },
    };
    return syncCopilotCatalog(credentials, options);
  };

  const plugin: BetterCopilotPlugin = {
    name,
    Config: createConfig(original.Config),
    inject,
    sync,
    async apply(ctx, config) {
      // Logging is diagnostics only: a throwing exporter must never change behaviour.
      const log = (level: 'info' | 'warn', message: string, ...args: unknown[]): void => {
        try { ctx.logger?.[level]?.(message, ...args); } catch { /* diagnostics only */ }
      };
      const contain = (capability: string, description: string, execute: () => void): void => {
        try {
          execute();
        } catch {
          log('warn', 'better-copilot: %s registration failed; %s stays unavailable', capability, description);
        }
      };

      // 1. Wire identity: best effort, effect-scoped, never blocks the adapter.
      const mode = wireIdentityMode();
      if (mode !== 'off') {
        contain('wire identity', 'Copilot request identity', () => {
          const install = dependencies.installIdentity ?? (() => installCopilotIdentityHeaders(createCopilotWireIdentity(mode)));
          // Install inside the effect factory: an inactive context throws before
          // this runs, leaving no process-global wrapper behind.
          ctx.effect(() => install(), 'copilot: wire identity headers');
        });
      }

      // 2. Gemini tool-declaration guard: one contained wire transform. The
      //    assembly waterfall no longer sees provider-owned declarations, so the
      //    guard rewrites the serialized request at the boundary that measures
      //    the defect. It is installed even when wire identity is opted out.
      contain('tool-schema guard', 'Gemini tool-schema normalization', () => {
        const transform: CopilotRequestTransform = ({ body }) => {
          try {
            const settings = guardSettings(config.toolSchema);
            const result = guardCopilotRequestBody(body, settings);
            if (settings.logFixes) {
              if (result.fixed.length > 0) log('info', 'better-copilot: added a properties bucket to %d tool schema(s) on the Copilot wire', result.fixed.length);
              if (result.skipped.length > 0) log('warn', 'better-copilot: %s left %d tool schema(s) unchanged: %s', TOOL_SCHEMA_SKIPPED, result.skipped.length, JSON.stringify(result.skipped));
            }
            return result.body;
          } catch {
            // The request is delegated byte-identical; a guard failure never fails a call.
            log('warn', 'better-copilot: skipped one request after an internal error');
            return undefined;
          }
        };
        ctx.effect(() => installCopilotRequestTransform(transform), 'copilot: tool-schema wire normalization');
      });

      // 3. Search provider: mounts only when the web service exists.
      contain('search provider', 'Copilot web search', () => {
        (ctx as unknown as { inject(deps: string[], callback: (child: InjectContext) => void): unknown }).inject(['web'], (child) => {
          contain('search provider', 'Copilot web search', () => {
            const resolveAuth = createCopilotAuthResolver(ctx as unknown as SearchContext, searchRuntime);
            const fetcher = dependencies.fetcher;
            child.web.registerSearchProvider(new CopilotSearchProvider((): CopilotSearchOptions => {
              // Snapshot every setting once: a search cannot mix configuration revisions.
              const apiKeyEnv = config.search.apiKeyEnv.get();
              const baseURL = config.search.baseURL.get();
              const authOptions = {
                ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
                ...(baseURL === undefined ? {} : { baseURL }),
              };
              return {
                model: config.search.model.get(),
                maxTokens: config.search.maxTokens.get(),
                timeoutMs: config.search.timeoutMs.get(),
                maxResponseBytes: config.search.maxResponseBytes.get(),
                includeSources: config.search.includeSources.get(),
                searchMode: config.search.searchMode.get(),
                forceSearch: config.search.forceSearch.get(),
                resolveAuth: (signal: AbortSignal) => resolveAuth(authOptions, signal),
                ...(fetcher === undefined ? {} : { fetcher }),
              };
            }));
          });
        });
      });

      // 4. Catalog discovery, then the adapter itself. Only this step is fatal:
      // without the adapter there is no Copilot inference route at all.
      try {
        const credentials = (ctx as unknown as { get(name: string): CredentialReader | undefined }).get('credentials');
        const profile = config.providers.get()['github-copilot'];
        const ref = profile?.apiKeyEnv;
        const resolver = credentials as unknown as {
          resolve(reference: CredentialRef): Promise<{ value?: string } | undefined>;
        } | undefined;
        const readReference = async (value: string) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
            throw new DiscoveryError('INVALID_AUTH', 'Invalid credential reference');
          }
          return (await resolver?.resolve(value as CredentialRef))?.value;
        };
        const authOptions: CopilotAuthOptions = {
          ...(typeof profile?.baseURL === 'string' ? { baseUrl: profile.baseURL } : {}),
          ...(typeof ref === 'string' ? { resolveApiKey: () => readReference(ref) } : {}),
          resolveAmbientApiKey: async () => (await readReference('COPILOT_GITHUB_TOKEN'))
            ?? launchEnvironmentOf(ctx as never).get('COPILOT_GITHUB_TOKEN')?.value,
        };
        const result = await sync(credentials, authOptions);
        if (result.status === 'synced') {
          // JSON quoting prevents model IDs from injecting log lines.
          log('info', 'Copilot catalog synced: %d enabled models; unsupported new IDs: %s',
            result.count, JSON.stringify(result.unsupported));
        } else {
          log('info', 'Copilot catalog kept bundled defaults: %s', result.status);
        }
      } catch (error) {
        // Arbitrary OAuth/network/credential errors may include tokens or bodies.
        // Only our controlled code is safe to log; never log the raw exception.
        const reason = error instanceof DiscoveryError ? error.code : 'DISCOVERY_FAILED';
        log('warn', 'Copilot model discovery failed; keeping current catalog: %s', reason);
      }
      if (accountEndpoint) log('info', 'Copilot runtime endpoint: %s', accountEndpoint);
      return original.apply(ctx, {
        providers: providersFacade(config.providers, accountEndpoint),
      } as unknown as PluginConfig);
    },
  };
  return plugin;
}
