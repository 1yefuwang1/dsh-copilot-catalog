import { Config, apply, CopilotSearchProvider, type CopilotSearchOptions, type CopilotAuthOptions, type ResolvedCopilotAuth, type SearchMode } from 'dsh-copilot-search';
import { COPILOT_SEARCH_PROVIDER_ID } from 'dsh-copilot-search/provider';
import { normalizeResponsesResponse, parseResponsesSSE, type NativeSearchResult } from 'dsh-copilot-search/responses';
import { createCopilotCredentialStore } from 'dsh-copilot-search/auth';
import type { WebSearchProvider, WebSearchResult } from '@deepseek-ai/dsh-web';

const modelSettings = Config({ model: 'arbitrary-responses-model' });
const searchMode: SearchMode = modelSettings.searchMode.get();
const authSettings: CopilotAuthOptions = { apiKeyEnv: 'COPILOT_ACCESS_TOKEN', baseURL: 'https://api.enterprise.githubcopilot.com' };
const auth: ResolvedCopilotAuth = { apiKey: 'synthetic', baseUrl: authSettings.baseURL! };
const options: CopilotSearchOptions = {
  model: modelSettings.model.get(), maxTokens: 4096, timeoutMs: 60000, maxResponseBytes: 2097152,
  includeSources: true, searchMode, forceSearch: false, resolveAuth: async () => auth,
};
const provider: WebSearchProvider = new CopilotSearchProvider(() => options);
const pending: Promise<WebSearchResult> = provider.search({ query: 'synthetic query', maxResults: 8 });
const normalized: NativeSearchResult = normalizeResponsesResponse({ status: 'completed', output: [] });
const sse: WebSearchResult = parseResponsesSSE('synthetic fixture');
const typedApply: (ctx: Parameters<typeof apply>[0], config: ReturnType<typeof Config>) => void = apply;

// @ts-expect-error authentication must return a typed credential or undefined
const invalidResolver: CopilotSearchOptions['resolveAuth'] = async () => 'invalid';
// @ts-expect-error native search modes are explicit, not arbitrary strings
const invalidMode: SearchMode = 'unknown';
// @ts-expect-error a provider requires an injected options resolver
new CopilotSearchProvider();
// @ts-expect-error credential storage requires a scoped key and service
createCopilotCredentialStore();
void [COPILOT_SEARCH_PROVIDER_ID, provider, pending, normalized, sse, typedApply, invalidResolver, invalidMode];
