import type { AuthContext, CredentialStore, Models, OAuthAuth, Provider } from '@earendil-works/pi-ai';
import type { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
import type { Context } from '@deepseek-ai/cordis';

export type SearchMode = 'default' | 'live' | 'cached';

/** A per-operation credential and its validated account origin. Never persist on a provider. */
export interface ResolvedCopilotAuth {
  apiKey: string;
  baseUrl: string;
  headers?: Readonly<Record<string, string>>;
}

/** One immutable snapshot for a single auxiliary search. Dependencies are injected for tests. */
export interface CopilotSearchOptions {
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxResponseBytes: number;
  includeSources: boolean;
  searchMode: SearchMode;
  forceSearch: boolean;
  resolveAuth: (signal: AbortSignal) => Promise<ResolvedCopilotAuth | undefined>;
  fetcher?: typeof globalThis.fetch;
}

/** User settings; credentials remain references or existing provider-owned grants. */
export interface CopilotAuthOptions {
  apiKeyEnv?: string;
  baseURL?: string;
}

export interface SearchRuntime {
  recordKeyFor: typeof recordKeyFor;
  createModels: (options: { credentials: CredentialStore; authContext: AuthContext }) => Models & { setProvider(provider: Provider): void };
  provider: Provider;
  oauth: Pick<OAuthAuth, 'toAuth'>;
  headers: Readonly<Record<string, string>>;
}

export type SearchContext = Context;
