import type { Api, Model, ModelAuth, OAuthCredential } from '@earendil-works/pi-ai';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { CredentialKey, DiscoveryOptions, ModelCatalog } from '../dist/types.js';

export type FixtureModel = Model<Api> & { headers: Record<string, string>; compat: { supportsStrictMode: boolean } };
export type FixtureCatalog = ModelCatalog & Record<'gpt-6-sol' | 'gpt-5.6-sol' | 'claude', FixtureModel>;
/** Wire metadata allows unknown values intentionally: the parser must reject malformed inputs. */
export interface AccountItem {
  id: string; name: string; model_picker_enabled: unknown; policy?: unknown;
  supported_endpoints: unknown;
  capabilities: {
    type?: unknown;
    limits: Record<string, unknown>;
    supports: { vision: unknown; tool_calls: unknown; reasoning_effort?: unknown; thinking?: unknown; streaming?: unknown };
  };
  [key: string]: unknown;
}
export interface GrantRecord { kind: 'grant'; payload: OAuthCredential & { enterpriseUrl?: string } }
export interface DiscoveryRequestInit extends RequestInit { headers: Headers; signal: AbortSignal }
export interface DiscoveryResponse { ok: boolean; status?: number; json?: () => Promise<unknown> }
export type DiscoveryFetcher = (url: URL, init: DiscoveryRequestInit) => Promise<DiscoveryResponse>;
export type FixtureOptions = Omit<DiscoveryOptions, 'fetcher'> & { fetcher: DiscoveryFetcher };
export type DiscoveryRequest = ['read', CredentialKey] | ['fetch', URL, DiscoveryRequestInit];
export interface FixtureCredentials {
  readRecord(key: CredentialKey): Promise<unknown>;
  writeRecord(): never; modifyRecord(): never; deleteRecord(): never;
  resolve?: (ref: CredentialRef) => Promise<{ value: string } | undefined>;
}
/** Partial HTTP doubles model only discovery's read seam, not a complete Response. */
export function discoveryOptions(options: FixtureOptions): DiscoveryOptions {
  return { ...options, fetcher: options.fetcher as unknown as typeof fetch };
}
export function fetchRequest(requests: DiscoveryRequest[], index: number): ['fetch', URL, DiscoveryRequestInit] {
  const request = requests[index];
  if (!request || request[0] !== 'fetch') throw new Error(`Expected fetch request at ${index}`);
  return request;
}
export type DiscoveryFixture = ReturnType<typeof discoveryFixture>;
export function modelCompat(model: Model<Api>, field: 'supportsStrictMode' | 'forceAdaptiveThinking'): unknown {
  return (model.compat as Record<string, unknown> | undefined)?.[field];
}

export function catalogFixture(): FixtureCatalog {
  const model = (id: string, api: Api = 'openai-responses'): FixtureModel => ({
    id, name: id, provider: 'github-copilot', api,
    baseUrl: 'https://api.individual.githubcopilot.com',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000, maxTokens: 32000,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
    headers: { 'Editor-Version': 'vscode/test', Authorization: 'must-not-win' },
    thinkingLevelMap: { off: 'none', minimal: 'minimal', xhigh: 'xhigh', max: 'max' },
    compat: { supportsStrictMode: true },
  });
  return {
    'gpt-6-sol': model('gpt-6-sol'),
    'gpt-5.6-sol': model('gpt-5.6-sol'),
    claude: model('claude', 'anthropic-messages'),
  };
}

export function accountItem(id: string, overrides: Record<string, unknown> = {}): AccountItem {
  return {
    id, name: id, model_picker_enabled: true, policy: { state: 'enabled' },
    supported_endpoints: ['/responses'],
    capabilities: {
      limits: { max_context_window_tokens: 1000000, max_output_tokens: 128000 },
      supports: { vision: true, tool_calls: true, reasoning_effort: ['medium', 'high', 'xhigh', 'max'] },
    },
    ...overrides,
  };
}

export function grantFixture(overrides: Partial<GrantRecord['payload']> = {}): GrantRecord {
  return { kind: 'grant', payload: {
    type: 'oauth', access: 'test-access-token', refresh: 'test-refresh-token',
    expires: Date.now() + 60 * 60_000, ...overrides,
  } };
}

export function discoveryFixture(overrides: Partial<FixtureOptions> = {}) {
  const catalog = catalogFixture();
  const record = grantFixture();
  const requests: DiscoveryRequest[] = [];
  const credentials: FixtureCredentials = {
    async readRecord(key) { requests.push(['read', key]); return record; },
    writeRecord() { throw new Error('Discovery must never persist credentials'); },
    modifyRecord() { throw new Error('Discovery must never persist credentials'); },
    deleteRecord() { throw new Error('Discovery must never delete credentials'); },
  };
  const options: FixtureOptions = {
    catalog, recordKey: 'test-record-key' as CredentialKey,
    oauth: {
      async refresh(value) { return { ...value, access: 'refreshed-in-memory' }; },
      async toAuth(value): Promise<ModelAuth> { return { apiKey: value.access, baseUrl: 'https://api.enterprise.githubcopilot.com' }; },
    },
    async fetcher(url, init) {
      requests.push(['fetch', url, init]);
      return { ok: true, async json() { return { data: [accountItem('gpt-6-sol')] }; } };
    },
    ...overrides,
  };
  return { catalog, record, requests, credentials, options };
}
