import z from '@deepseek-ai/schemastery';

/** Default auxiliary search model; the profile may override `search.model`. */
export const DEFAULT_SEARCH_MODEL = 'gpt-6.1-sol';

/** A resolved volatile leaf: settings are read through `.get()` so live edits apply. */
export interface Volatile<T> { get(): T }

/** One adapter provider profile; only the fields this plugin reads are named here. */
export interface ProviderProfile { baseURL?: string; apiKeyEnv?: string; streamIdleTimeoutMs?: number }

/** The adapter's provider map as the host hands it to a mounted plugin. */
export interface ProvidersValue { get(): Record<string, ProviderProfile> }

export interface SearchSettings {
  apiKeyEnv: Volatile<string | undefined>;
  baseURL: Volatile<string | undefined>;
  model: Volatile<string>;
  maxTokens: Volatile<number>;
  timeoutMs: Volatile<number>;
  maxResponseBytes: Volatile<number>;
  includeSources: Volatile<boolean>;
  searchMode: Volatile<'default' | 'live' | 'cached'>;
  forceSearch: Volatile<boolean>;
}

export interface GuardConfigValue {
  providers: Volatile<string[]>;
  families: Volatile<string[]>;
  logFixes: Volatile<boolean>;
}

/** Builtin Auto review routing; omitted leaves retain the model's adapter defaults. */
export interface AutoReviewSettings {
  enabled: Volatile<boolean>;
  model: Volatile<string | undefined>;
  reasoningEffort: Volatile<string | undefined>;
}

/** Persistent catalog cache and demand-driven live refresh. */
export interface CatalogSettings {
  cache: Volatile<boolean>;
  refreshIntervalMs: Volatile<number>;
  /** Catalog routes (other than Copilot, which is always discovered) refreshed live. */
  providers: Volatile<string[]>;
}

/** Bound one model attempt by stream progress instead of chunk arrival. */
export interface StreamGuardSettings {
  enabled: Volatile<boolean>;
  providers: Volatile<string[]>;
  /** Omitted uses the provider route's streamIdleTimeoutMs, then five minutes. */
  noProgressTimeoutMs: Volatile<number | undefined>;
}

/** The one configuration object every capability reads from. */
export interface BetterCopilotConfig {
  providers: ProvidersValue;
  catalog: CatalogSettings;
  search: SearchSettings;
  toolSchema: GuardConfigValue;
  autoReview: AutoReviewSettings;
  streamGuard: StreamGuardSettings;
}

/** User-facing configuration: plain values, before volatile resolution. */
export interface BetterCopilotConfigInput {
  providers?: Record<string, { apiKeyEnv?: string; baseURL?: string } & Record<string, unknown>>;
  catalog?: { cache?: boolean; refreshIntervalMs?: number; providers?: string[] };
  search?: {
    apiKeyEnv?: string;
    baseURL?: string;
    model?: string;
    maxTokens?: number;
    timeoutMs?: number;
    maxResponseBytes?: number;
    includeSources?: boolean;
    searchMode?: 'default' | 'live' | 'cached';
    forceSearch?: boolean;
  };
  toolSchema?: {
    providers?: string[];
    families?: string[];
    logFixes?: boolean;
  };
  autoReview?: {
    enabled?: boolean;
    model?: string;
    reasoningEffort?: string;
  };
  streamGuard?: {
    enabled?: boolean;
    providers?: string[];
    noProgressTimeoutMs?: number;
  };
}

/**
 * The merged Config schema as the plugin and the Loader see it: callable, with a
 * standard-schema validator. The runtime object is the real schemastery schema
 * built in {@link createConfig}; this interface only names what consumers use.
 */
export interface BetterCopilotConfigSchema {
  (data?: BetterCopilotConfigInput | null, ...rest: unknown[]): BetterCopilotConfig;
  toString(): string;
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { readonly value: BetterCopilotConfig }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> };
  };
}

/**
 * Search settings. The container is plain and each leaf is volatile: schemastery
 * requires a fixed object path for volatile fields, so a volatile parent would
 * reject its own volatile leaves.
 */
export const SearchConfig = z.object({
  apiKeyEnv: z.string().role('credential-ref').volatile(),
  baseURL: z.string().volatile(),
  model: z.string().default(DEFAULT_SEARCH_MODEL).volatile(),
  maxTokens: z.number().step(1).min(16).max(65_536).default(4096).volatile(),
  timeoutMs: z.number().step(1).min(1).max(120_000).default(60_000).volatile(),
  maxResponseBytes: z.number().step(1).min(1024).max(16_777_216).default(2_097_152).volatile(),
  includeSources: z.boolean().default(true).volatile(),
  searchMode: z.union(['default', 'live', 'cached']).default('default').volatile(),
  forceSearch: z.boolean().default(false).volatile(),
});

/** Copilot Gemini tool-declaration guard settings. */
export const GuardConfig = z.object({
  providers: z.array(z.string()).default(['github-copilot']).volatile(),
  families: z.array(z.string()).default(['gemini']).volatile(),
  logFixes: z.boolean().default(false).volatile(),
});

/** Routes whose installed catalog is kept current from the provider's live listing. */
export const DEFAULT_CATALOG_DISCOVERY_PROVIDERS = ['opencode-go'];

/** Cache can be disabled without disabling account discovery or missing-model refresh. */
export const CatalogConfig = z.object({
  cache: z.boolean().default(true).volatile(),
  refreshIntervalMs: z.number().step(1).min(60_000).max(86_400_000).default(900_000).volatile(),
  providers: z.array(z.string()).default(DEFAULT_CATALOG_DISCOVERY_PROVIDERS).volatile(),
});

/** A progress timeout is a timeout, so zero is rejected rather than disabling the guard. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Bounded model-attempt progress guard; providers default to the Copilot route. */
export const StreamGuardConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  providers: z.array(z.string()).default(['github-copilot']).volatile(),
  noProgressTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).volatile(),
});

/** Only the builtin reviewer is affected; exact model/effort ids are validated by LLM dispatch. */
export const AutoReviewConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  model: z.string().min(1).volatile(),
  reasoningEffort: z.string().min(1).volatile(),
});

/** The adapter schema exposes its field schemas for reuse; only `dict` is needed here. */
interface ProviderSchemaCarrier {
  readonly dict?: { readonly providers?: unknown };
}

/**
 * Reuse the pi-ai adapter's own provider profile schema instead of restating it.
 * A restated schema would silently drift from the adapter's defaults, validation
 * and credential-reference semantics; a missing `providers` dict therefore fails
 * loudly rather than degrading to an open schema.
 */
function providerProfileSchema(originalConfig: unknown): ReturnType<typeof z.any> {
  const providers = (originalConfig as ProviderSchemaCarrier | undefined)?.dict?.providers;
  if (providers === undefined || (providers as { type?: unknown }).type !== 'dict') {
    throw new Error('Incompatible DSH/pi-ai adapter: its Config schema has no providers dict; see the supported versions in README');
  }
  // The adapter owns the concrete profile type; the merged schema reuses the very
  // same instance, so this cast only names the shape the plugin reads.
  return providers as ReturnType<typeof z.any>;
}

/**
 * The merged plugin's single configuration object: the adapter's provider map
 * plus one group per additional capability.
 */
export function createConfig(originalConfig: unknown): BetterCopilotConfigSchema {
  return z.object({
    providers: providerProfileSchema(originalConfig),
    catalog: CatalogConfig,
    search: SearchConfig,
    toolSchema: GuardConfig,
    autoReview: AutoReviewConfig,
    streamGuard: StreamGuardConfig,
  }) as unknown as BetterCopilotConfigSchema;
}
