import type { Api, Model, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';

export type OriginalAdapter = Pick<typeof import('@deepseek-ai/dsh-llm-pi-ai'),
  'name' | 'Config' | 'inject' | 'apply' | 'recordKeyFor'>;
export type PluginContext = Parameters<OriginalAdapter['apply']>[0];
export type PluginConfig = Parameters<OriginalAdapter['apply']>[1];
export type CredentialKey = ReturnType<OriginalAdapter['recordKeyFor']>;
export type ModelCatalog = Record<string, Model<Api>>;
export type CopilotOAuth = Pick<OAuthAuth, 'refresh' | 'toAuth'>;
export type CopilotGrant = OAuthCredential;

/** Only the read seam is accepted; discovery has no credential write capability. */
export interface CredentialReader {
  readRecord(key: CredentialKey): Promise<unknown>;
}

export interface AccountSelection {
  models: ModelCatalog;
  unsupported: string[];
}

export interface CatalogCacheScope {
  /** SHA-256 stable credential identity + record/Enterprise context + endpoint; never a raw credential. */
  accountKey: string;
  /** Canonical origin validated from the current authentication route, never trusted from storage. */
  endpoint: string;
}

export interface CatalogCacheEntry extends CatalogCacheScope {
  version: 1;
  savedAt: number;
  /** Bounded, allowlisted /models metadata. No descriptors, headers or authentication data. */
  raw: { data: Record<string, unknown>[] };
}

/** Optional parent-owned persistence seam. Implementations must honor abort before committing writes. */
export interface CatalogCache {
  read(scope: CatalogCacheScope, signal: AbortSignal): Promise<unknown>;
  write(scope: CatalogCacheScope, entry: CatalogCacheEntry, signal: AbortSignal): Promise<void>;
}

export interface CatalogUpdate {
  source: 'cache' | 'live';
  baseUrl: string;
  scope?: CatalogCacheScope;
}

export type SyncResult =
  | { status: 'no Copilot credential' }
  | { status: 'synced'; count: number; unsupported: string[] }
  | { status: 'cached'; count: number; unsupported: string[]; reason: string };

export interface CopilotAuthOptions {
  /** Explicit API-key route endpoint; OAuth grants still own their derived endpoint. */
  baseUrl?: string;
  /** An explicit apiKeyEnv reference wins over the stored account grant, as in pi-ai. */
  resolveApiKey?: () => Promise<string | undefined>;
  /** Read-only ambient lookup, consulted only when no OAuth grant owns the route. */
  resolveAmbientApiKey?: () => Promise<string | undefined>;
}

export interface DiscoveryOptions extends CopilotAuthOptions {
  /** Mutable destination must belong to this account/mount, never a process-shared catalog when cache is enabled. */
  catalog: ModelCatalog;
  /** Immutable bundled descriptors used for every selection; avoids learning metadata from another account. */
  baselineCatalog?: ModelCatalog;
  cache?: CatalogCache;
  signal?: AbortSignal;
  /** Called after validating the live account endpoint, before cache adoption or network listing. */
  onAccount?: (scope: CatalogCacheScope) => void;
  /** Synchronous parent registry notification; never called after cancellation/deadline. */
  onCatalog?: (selection: AccountSelection, update: CatalogUpdate) => void;
  /** Controlled cache/fallback reason codes only, never raw errors or credentials. */
  onDiagnostic?: (code: string) => void;
  oauth: CopilotOAuth;
  recordKey: CredentialKey;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Routing may adopt a validated account endpoint even if model listing later fails. */
  onEndpoint?: (baseUrl: string) => void;
}

export interface PluginDependencies extends Omit<DiscoveryOptions, 'recordKey'> {
  original: OriginalAdapter;
  /** Test seam for the process-wide wire-identity installer; defaults to the real interceptor. */
  installIdentity?: () => () => void;
}

export interface CatalogPlugin {
  name: OriginalAdapter['name'];
  Config: OriginalAdapter['Config'];
  inject: string[];
  sync(credentials?: CredentialReader, authOptions?: CopilotAuthOptions): Promise<SyncResult>;
  apply(ctx: PluginContext, config: PluginConfig): Promise<void>;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
