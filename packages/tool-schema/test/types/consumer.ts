import type { Context } from '@deepseek-ai/cordis';
import { apply, Config, matchesRoute, normalizeToolSchemas, TOOL_SCHEMA_SKIPPED } from '../../dist/index.js';
import type { GuardConfig, NormalizeResult, ToolSchema } from '../../dist/index.js';

const config: GuardConfig = Config({ providers: ['github-copilot'], families: ['gemini'] });
const tools: ToolSchema[] = [{ name: 'tool', description: 'd', parameters: { type: 'object' } }];
const result: NormalizeResult = normalizeToolSchemas(tools);
const matched: boolean = matchesRoute('github-copilot', 'gemini-4-argon', { providers: ['github-copilot'], families: ['gemini'], logFixes: false });
const skipped: string = TOOL_SCHEMA_SKIPPED;

export function usePlugin(context: Context): void {
  apply(context, config);
  void result;
  void matched;
  void skipped;
}
