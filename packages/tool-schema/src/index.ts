import type { Context } from '@deepseek-ai/cordis';
import { createPlugin } from './plugin.js';
import type { GuardConfig } from './plugin.js';

const plugin = createPlugin();

export const name = plugin.name;
export const Config = plugin.Config;
export const inject = plugin.inject;
export const apply = (ctx: Context, config: GuardConfig): void => plugin.apply(ctx, config);

export { matchesRoute, normalizeToolSchemas, TOOL_SCHEMA_SKIPPED } from './schema.js';
export type { NormalizeResult } from './schema.js';
export type { GuardConfig } from './plugin.js';
export type { GuardSettings, PromptAssembly, SkippedTool, ToolSchema } from './types.js';
