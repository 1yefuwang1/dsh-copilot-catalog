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

export type SyncResult =
  | { status: 'no Copilot credential' }
  | { status: 'synced'; count: number; unsupported: string[] };

export interface CopilotAuthOptions {
  /** Explicit API-key route endpoint; OAuth grants still own their derived endpoint. */
  baseUrl?: string;
  /** An explicit apiKeyEnv reference wins over the stored account grant, as in pi-ai. */
  resolveApiKey?: () => Promise<string | undefined>;
  /** Read-only ambient lookup, consulted only when no OAuth grant owns the route. */
  resolveAmbientApiKey?: () => Promise<string | undefined>;
}

export interface DiscoveryOptions extends CopilotAuthOptions {
  catalog: ModelCatalog;
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
