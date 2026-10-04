import { createPlugin } from './plugin.js';
import { loadRuntime } from './runtime.js';
import type { CopilotAuthOptions, CredentialReader, OriginalAdapter, PluginConfig, PluginContext } from './types.js';

const plugin = createPlugin(await loadRuntime());

export const name = plugin.name;
export const Config: OriginalAdapter['Config'] = plugin.Config;
export const inject = plugin.inject;
export const apply = (ctx: PluginContext, config: PluginConfig): Promise<void> => plugin.apply(ctx, config);
export const syncCopilotCatalog = (credentials?: CredentialReader, authOptions?: CopilotAuthOptions) => plugin.sync(credentials, authOptions);
export { selectAccountModels } from './catalog.js';
export type { AccountModelOptions } from './catalog.js';
export type { AccountSelection, CopilotAuthOptions, CredentialReader, ModelCatalog, SyncResult } from './types.js';
