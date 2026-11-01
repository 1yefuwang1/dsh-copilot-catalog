import z from '@deepseek-ai/schemastery';

/** Default auxiliary search model; the profile may override `search.model`. */
export const DEFAULT_SEARCH_MODEL = 'gpt-6.1-sol';

/** A resolved volatile leaf: settings are read through `.get()` so live edits apply. */
export interface Volatile<T> { get(): T }

/** One adapter provider profile; only the fields this plugin reads are named here. */
export interface ProviderProfile { baseURL?: string; apiKeyEnv?: string }

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

/** The one configuration object every capability reads from. */
export interface BetterCopilotConfig {
  providers: ProvidersValue;
  search: SearchSettings;
  toolSchema: GuardConfigValue;
}

/** User-facing configuration: plain values, before volatile resolution. */
export interface BetterCopilotConfigInput {
  providers?: Record<string, { apiKeyEnv?: string; baseURL?: string } & Record<string, unknown>>;
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
    search: SearchConfig,
    toolSchema: GuardConfig,
  }) as unknown as BetterCopilotConfigSchema;
}
