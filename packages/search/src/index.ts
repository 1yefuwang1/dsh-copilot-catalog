import { createPlugin } from './plugin.js';
import { loadRuntime } from './runtime.js';
import type { SearchPluginConfig } from './plugin.js';
import type { SearchContext } from './types.js';

// Public-peer imports only. Credentials and network are untouched until search().
const plugin = createPlugin(await loadRuntime());
export const name = plugin.name;
export const Config = plugin.Config;
export const inject = plugin.inject;
export const apply = (ctx: SearchContext, config: SearchPluginConfig): void => plugin.apply(ctx, config);
export { CopilotSearchProvider, COPILOT_SEARCH_PROVIDER_ID } from './provider.js';
export { DEFAULT_SEARCH_MODEL } from './plugin.js';
export type { SearchPluginConfig } from './plugin.js';
export type { CopilotAuthOptions, CopilotSearchOptions, ResolvedCopilotAuth, SearchMode } from './types.js';
