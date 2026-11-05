import type { BetterCopilotConfig } from './config.js';
import { createPlugin } from './plugin.js';
import { loadRuntime } from './runtime.js';
import type { CopilotAuthOptions, CredentialReader, PluginContext, SyncResult } from './catalog-types.js';

// Public-peer imports only. Credentials and network are untouched until apply()/sync().
const plugin = createPlugin(await loadRuntime());

export const name = plugin.name;
export const Config = plugin.Config;
export const inject = plugin.inject;
export const apply = (ctx: PluginContext, config: BetterCopilotConfig): Promise<void> => plugin.apply(ctx, config);
/** Preserved predecessor entry point: one read-only discovery with the merged runtime. */
export const syncCopilotCatalog = (credentials?: CredentialReader, authOptions?: CopilotAuthOptions): Promise<SyncResult> =>
  plugin.sync(credentials, authOptions);

export { DEFAULT_SEARCH_MODEL } from './config.js';
export { liveCost, selectAccountModels } from './catalog.js';
export { DiscoveryError } from './discovery.js';
export {
  createCopilotWireIdentity,
  installCopilotIdentityHeaders,
  installCopilotRequestTransform,
  isCopilotRequestPath,
  isTrustedCopilotUrl,
  rewriteCopilotRequestHeaders,
  wireIdentityMode,
} from './identity.js';
export { guardCopilotRequestBody, MAX_GUARDED_BODY_BYTES } from './guard.js';
export type { GuardedBody } from './guard.js';
export { COPILOT_SEARCH_PROVIDER_ID, CopilotSearchProvider } from './provider.js';
export { matchesRoute, normalizeToolSchemas, TOOL_SCHEMA_SKIPPED } from './schema.js';
export { loadRuntime } from './runtime.js';
export type { BetterCopilotRuntime, RuntimeOptions } from './runtime.js';
export type { BetterCopilotConfig, BetterCopilotConfigSchema } from './config.js';
export type { BetterCopilotDependencies, BetterCopilotPlugin } from './plugin.js';
export type { AccountModelOptions } from './catalog.js';
export type { NormalizeResult } from './schema.js';
export type {
  AccountSelection,
  CopilotAuthOptions as CatalogAuthOptions,
  CredentialReader,
  ModelCatalog,
  SyncResult,
} from './catalog-types.js';
export type {
  CopilotRequestTransform,
  CopilotWireIdentity,
  CopilotWireIdentityOverrides,
  WireIdentityMode,
  WireIdentitySetting,
} from './identity.js';
export type {
  CopilotAuthOptions as SearchAuthOptions,
  CopilotSearchOptions,
  ResolvedCopilotAuth,
  SearchMode,
} from './search-types.js';
export type { GuardSettings, PromptAssembly, SkippedTool, ToolSchema } from './guard-types.js';
