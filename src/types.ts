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
  | { status: 'no OAuth grant' }
  | { status: 'synced'; count: number; unsupported: string[] };

export interface DiscoveryOptions {
  catalog: ModelCatalog;
  oauth: CopilotOAuth;
  recordKey: CredentialKey;
  fetcher?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface PluginDependencies extends Omit<DiscoveryOptions, 'recordKey'> {
  original: OriginalAdapter;
}

export interface CatalogPlugin {
  name: OriginalAdapter['name'];
  Config: OriginalAdapter['Config'];
  inject: string[];
  sync(credentials?: CredentialReader): Promise<SyncResult>;
  apply(ctx: PluginContext, config: PluginConfig): Promise<void>;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
