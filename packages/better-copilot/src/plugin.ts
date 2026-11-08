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
import { installAutoReviewRouting } from './auto-review.js';
import { normalizeCopilotTemperature } from './temperature.js';
import { createCatalogController } from './catalog-controller.js';
import { openCatalogStore } from './catalog-store.js';
import { adapterContext } from './catalog-adapter.js';
import type { CatalogCache } from './catalog-types.js';
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain';

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
  /** Optional test/embedding persistence seam; the Host normally provides storageDomain. */
  cache?: CatalogCache;
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
export function providersFacade(source: ProvidersValue, endpoint: string | undefined | (() => string | undefined), revision?: () => number): ProvidersValue {
  if (!endpoint && !revision) return source;
  let previous: Record<string, ProviderProfile> | undefined;
  let resolved: Record<string, ProviderProfile> | undefined;
  let lastRevision: number | undefined;
  let lastEndpoint: string | undefined;
  const get = () => {
    const raw = source.get();
    const currentRevision = revision?.();
    const currentEndpoint = typeof endpoint === 'function' ? endpoint() : endpoint;
    if (raw === previous && resolved !== undefined && currentRevision === lastRevision && currentEndpoint === lastEndpoint) return resolved;
    const profile = raw['github-copilot'];
    previous = raw; lastRevision = currentRevision; lastEndpoint = currentEndpoint;
    resolved = currentEndpoint && profile && (profile.baseURL === undefined || profile.baseURL === null)
      ? Object.freeze({ ...raw, 'github-copilot': Object.freeze({ ...profile, baseURL: currentEndpoint }) })
      : revision ? Object.freeze({ ...raw }) : raw;
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
  const baselineCatalog = structuredClone(dependencies.catalog);

  /** Explicit standalone discovery retains its predecessor semantics. */
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
          let normalized: string | undefined;
          try {
            normalized = normalizeCopilotTemperature(body, dependencies.catalog);
          } catch {
            log('warn', 'better-copilot: skipped temperature normalization after an internal error');
          }
          try {
            const settings = guardSettings(config.toolSchema);
            const result = guardCopilotRequestBody(normalized ?? body, settings);
            if (settings.logFixes) {
              if (result.fixed.length > 0) log('info', 'better-copilot: added a properties bucket to %d tool schema(s) on the Copilot wire', result.fixed.length);
              if (result.skipped.length > 0) log('warn', 'better-copilot: %s left %d tool schema(s) unchanged: %s', TOOL_SCHEMA_SKIPPED, result.skipped.length, JSON.stringify(result.skipped));
            }
            return result.body ?? normalized;
          } catch {
            // Guard failure never fails a call or discards a temperature fix.
            log('warn', 'better-copilot: skipped one request after an internal error');
            return normalized;
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

      // 4. Builtin authorization reviewer routing, independently contained.
      contain('auto-review routing', 'builtin review model overrides', () => {
        installAutoReviewRouting(ctx, config.autoReview, dependencies.catalog);
      });

      // 5. Persistent account catalog, demand-driven refresh, then the adapter.
      // Storage is optional: failure degrades to account discovery and bundled defaults.
      const lifetime = new AbortController();
      ctx.effect(() => () => lifetime.abort(), 'copilot: catalog storage lifetime');
      let cache = dependencies.cache;
      let opening: Promise<CatalogCache | undefined> | undefined;
      const getCache = async (): Promise<CatalogCache | undefined> => {
        lifetime.signal.throwIfAborted();
        if (cache) return cache;
        if (opening) return opening;
        const storage = ctx.get('storageDomain') as DomainFacility | undefined;
        if (!storage) return undefined;
        opening = (async () => {
          try {
            const store = await openCatalogStore(storage, lifetime.signal);
            ctx.effect(() => () => store.close(), 'copilot: persistent catalog cache');
            cache = store;
            return store;
          } catch {
            log('warn', 'better-copilot: persistent catalog cache unavailable: CACHE_OPEN_FAILED');
            return undefined;
          }
        })();
        return opening;
      };
      // Lazy access also supports enabling persistence on a later volatile update.
      const persistentCache: CatalogCache = {
        async read(scope, signal) { return (await getCache())?.read(scope, signal); },
        async write(scope, entry, signal) { await (await getCache())?.write(scope, entry, signal); },
      };
      if (config.catalog.cache.get()) await getCache();
      const credentials = ctx.get('credentials') as CredentialReader | undefined;
      const resolver = credentials as unknown as {
        resolve(reference: CredentialRef): Promise<{ value?: string } | undefined>;
      } | undefined;
      const readReference = async (value: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new DiscoveryError('INVALID_AUTH', 'Invalid credential reference');
        return (await resolver?.resolve(value as CredentialRef))?.value;
      };
      const authOptions = (): CopilotAuthOptions => {
        const profile = config.providers.get()['github-copilot'];
        const ref = profile?.apiKeyEnv;
        return {
          ...(typeof profile?.baseURL === 'string' ? { baseUrl: profile.baseURL } : {}),
          ...(typeof ref === 'string' ? { resolveApiKey: () => readReference(ref) } : {}),
          resolveAmbientApiKey: async () => (await readReference('COPILOT_GITHUB_TOKEN'))
            ?? launchEnvironmentOf(ctx as never).get('COPILOT_GITHUB_TOKEN')?.value,
        };
      };
      let revision = 0;
      const controller = createCatalogController({
        catalog: dependencies.catalog, baseline: baselineCatalog, credentials,
        oauth: dependencies.oauth, recordKey: dependencies.recordKeyFor('github-copilot'),
        authOptions, cache: () => config.catalog.cache.get() ? persistentCache : undefined,
        refreshIntervalMs: () => config.catalog.refreshIntervalMs.get(),
        ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
        ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        changed(endpoint) {
          accountEndpoint = endpoint; revision++;
          // Notify model pickers without mutating stored provider settings.
          try { ctx.emit('llm/models-updated', 'github-copilot'); } catch { /* diagnostics/UI only */ }
        },
        diagnostic(code) { log('warn', 'Copilot catalog refresh: %s', code); },
      });
      ctx.effect(() => () => controller.dispose(), 'copilot: catalog refresh lifecycle');
      ctx.on('credentials/record-updated', (key) => {
        if (key === dependencies.recordKeyFor('github-copilot') && !config.providers.get()['github-copilot']?.apiKeyEnv) controller.invalidate();
      });
      ctx.on('credentials/reference-updated', (ref) => {
        if (ref === config.providers.get()['github-copilot']?.apiKeyEnv || ref === 'COPILOT_GITHUB_TOKEN') controller.invalidate();
      });
      let previousProfile = config.providers.get()['github-copilot'];
      // The loader owns this event; it is not a runtime dependency of this Host-only wrapper.
      (ctx as unknown as { on(event: 'loader/volatile-update', listener: () => void): unknown }).on('loader/volatile-update', () => {
        const profile = config.providers.get()['github-copilot'];
        if (profile !== previousProfile) { previousProfile = profile; controller.invalidate(); }
      });
      const result = await controller.refresh();
      if (result?.status === 'synced') {
        log('info', 'Copilot catalog synced: %d enabled models; unsupported new IDs: %s', result.count, JSON.stringify(result.unsupported));
      }
      if (accountEndpoint) log('info', 'Copilot runtime endpoint: %s', accountEndpoint);
      return original.apply(adapterContext(ctx, controller.ensure), {
        providers: providersFacade(config.providers, () => accountEndpoint, () => revision),
      } as unknown as PluginConfig);
    },
  };
  return plugin;
}
