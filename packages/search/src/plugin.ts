import z from '@deepseek-ai/schemastery';
import { createCopilotAuthResolver } from './auth.js';
import { CopilotSearchProvider } from './provider.js';
import type { SearchContext, SearchRuntime } from './types.js';

export const name = 'web-search-copilot';
export const inject = ['web'];
export const DEFAULT_SEARCH_MODEL = 'gpt-6.1-sol';

export const Config = z.object({
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

export type SearchPluginConfig = ReturnType<typeof Config>;
export interface SearchPluginDependencies {
  fetcher?: typeof globalThis.fetch;
}

/** Keep the provider registration testable without loading another adapter or reading credentials. */
export function createPlugin(runtime: SearchRuntime, dependencies: SearchPluginDependencies = {}) {
  return {
    name, Config, inject,
    apply(ctx: SearchContext, config: SearchPluginConfig): void {
      const resolveAuth = createCopilotAuthResolver(ctx, runtime);
      ctx.web.registerSearchProvider(new CopilotSearchProvider(() => {
        // Snapshot every setting once: a search cannot mix configuration revisions.
        const apiKeyEnv = config.apiKeyEnv.get();
        const baseURL = config.baseURL.get();
        const model = config.model.get();
        const maxTokens = config.maxTokens.get();
        const timeoutMs = config.timeoutMs.get();
        const maxResponseBytes = config.maxResponseBytes.get();
        const includeSources = config.includeSources.get();
        const searchMode = config.searchMode.get();
        const forceSearch = config.forceSearch.get();
        const authOptions = {
          ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
          ...(baseURL === undefined ? {} : { baseURL }),
        };
        return {
          model, maxTokens, timeoutMs, maxResponseBytes, includeSources, searchMode, forceSearch,
          resolveAuth: (signal) => resolveAuth(authOptions, signal),
          ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
        };
      }));
    },
  };
}
