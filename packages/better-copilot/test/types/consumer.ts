import {
  apply,
  Config,
  DEFAULT_SEARCH_MODEL,
  inject,
  liveCost,
  name,
  normalizeToolSchemas,
  selectAccountModels,
  syncCopilotCatalog,
  TOOL_SCHEMA_SKIPPED,
  type AccountSelection,
  type BetterCopilotConfig,
  type CatalogAuthOptions,
  type SearchAuthOptions,
  type ModelCatalog,
  type NormalizeResult,
  type SyncResult,
  type ToolSchema,
} from 'dsh-better-copilot';
import { selectAccountModels as selectFromCatalogSubpath } from 'dsh-better-copilot/catalog';
import { syncCopilotCatalog as discoverySync } from 'dsh-better-copilot/discovery';
import { createCopilotWireIdentity, type CopilotWireIdentity } from 'dsh-better-copilot/identity';
import {
  COPILOT_SEARCH_PROVIDER_ID,
  CopilotSearchProvider,
  createCopilotCredentialStore,
  normalizeResponsesResponse,
  parseResponsesSSE,
  type CopilotSearchOptions,
  type NativeSearchResult,
  type ResolvedCopilotAuth,
  type SearchMode,
} from 'dsh-better-copilot/search';
import { matchesRoute } from 'dsh-better-copilot/guard';

declare const catalog: ModelCatalog;
declare const context: Parameters<typeof apply>[0];

// The one plugin surface: name, schema, inject list, apply and the preserved sync wrapper.
const pluginName: string = name;
const pluginInject: string[] = inject;
const defaults = Config({ providers: {}, search: {}, toolSchema: {} });
const configured: BetterCopilotConfig = Config({
  providers: { 'github-copilot': { apiKeyEnv: 'COPILOT_ACCESS_TOKEN' } },
  search: { model: DEFAULT_SEARCH_MODEL, maxTokens: 8192, searchMode: 'live' },
  toolSchema: { providers: ['github-copilot'], families: ['gemini'], logFixes: true },
});
const searchModel: string = configured.search.model.get();
const guardFamilies: string[] = configured.toolSchema.families.get();
const typedApply: (ctx: Parameters<typeof apply>[0], config: BetterCopilotConfig) => Promise<void> = apply;
const pending: Promise<SyncResult> = syncCopilotCatalog();
const configuredSync: Promise<SyncResult> = syncCopilotCatalog(undefined, { baseUrl: 'https://api.enterprise.githubcopilot.com' });
const lowLevel = (options: Parameters<typeof discoverySync>[1]): Promise<SyncResult> => discoverySync(undefined, options);

// The colliding predecessor auth types are importable under area-qualified names.
const catalogAuth: CatalogAuthOptions = { baseUrl: 'https://api.enterprise.githubcopilot.com' };
const searchAuth: SearchAuthOptions = { apiKeyEnv: 'COPILOT_ACCESS_TOKEN', baseURL: 'https://api.enterprise.githubcopilot.com' };

// Area subpaths keep their per-capability surfaces.
const selection: AccountSelection = selectAccountModels({ data: [] }, catalog);
const sameSelection: AccountSelection = selectFromCatalogSubpath({ data: [] }, catalog);
const cost = liveCost(undefined, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const tools: ToolSchema[] = [{ name: 'tool', description: 'd', parameters: { type: 'object' } }];
const normalized: NormalizeResult = normalizeToolSchemas(tools);
const skipped: string = TOOL_SCHEMA_SKIPPED;
const matched: boolean = matchesRoute('github-copilot', 'gemini-4-argon', {
  providers: ['github-copilot'], families: ['gemini'], logFixes: false,
});
const wireIdentity: CopilotWireIdentity = createCopilotWireIdentity('basic');
const providerId: string = COPILOT_SEARCH_PROVIDER_ID;
const providerType: typeof CopilotSearchProvider = CopilotSearchProvider;
const searchMode: SearchMode = defaults.search.searchMode.get();
const auth: ResolvedCopilotAuth = { apiKey: 'synthetic', baseUrl: 'https://api.enterprise.githubcopilot.com' };
const searchOptions: CopilotSearchOptions = {
  model: defaults.search.model.get(), maxTokens: 4096, timeoutMs: 60000, maxResponseBytes: 2097152,
  includeSources: true, searchMode, forceSearch: false, resolveAuth: async () => auth,
};
const provider = new CopilotSearchProvider(() => searchOptions);
const nativeResult: NativeSearchResult = normalizeResponsesResponse({ status: 'completed', output: [] });
const sse: NativeSearchResult = parseResponsesSSE('synthetic fixture');

// @ts-expect-error costs cannot be arbitrary strings
liveCost(undefined, 'invalid');
// @ts-expect-error a catalog must be provided explicitly
selectAccountModels({ data: [] });
// @ts-expect-error dependency injection is required for the low-level discovery helper
void discoverySync(undefined);
// @ts-expect-error native search modes are explicit, not arbitrary strings
const invalidMode: SearchMode = 'unknown';
// @ts-expect-error a provider requires an injected options resolver
new CopilotSearchProvider();
// @ts-expect-error authentication must return a typed credential or undefined
const invalidResolver: CopilotSearchOptions['resolveAuth'] = async () => 'invalid';
// @ts-expect-error credential storage requires a scoped key and service
createCopilotCredentialStore();

async function usePlugin(): Promise<void> {
  await typedApply(context, configured);
}

void [pluginName, pluginInject, searchModel, guardFamilies, pending, configuredSync, lowLevel, catalogAuth, searchAuth, selection,
  sameSelection, cost, normalized, skipped, matched, wireIdentity, providerId, providerType, provider, nativeResult, sse,
  invalidMode, invalidResolver, usePlugin];
