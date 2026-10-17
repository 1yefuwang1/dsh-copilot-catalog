import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { matchesRoute, normalizeToolSchemas, TOOL_SCHEMA_SKIPPED } from './schema.js';
import type { GuardSettings } from './types.js';

export const name = 'copilot-tool-schema';
export const inject: string[] = [];

export const Config = z.object({
  providers: z.array(z.string()).default(['github-copilot']).volatile(),
  families: z.array(z.string()).default(['gemini']).volatile(),
  logFixes: z.boolean().default(false).volatile(),
});

export type GuardConfig = ReturnType<typeof Config>;

export interface GuardPlugin {
  readonly name: string;
  readonly Config: typeof Config;
  readonly inject: string[];
  apply(ctx: Context, config: GuardConfig): void;
}

/** Settings snapshot for one assembly: a guard never mixes configuration revisions. */
function settingsOf(config: GuardConfig): GuardSettings {
  return { providers: config.providers.get(), families: config.families.get(), logFixes: config.logFixes.get() };
}

/**
 * Build the guard without side effects, so registration and ordering are testable.
 *
 * The listener is an outer global waterfall listener: it awaits the downstream chain
 * first (where the selected-route variables are written) and derives a detached
 * assembly only when a declaration changed.
 */
export function createPlugin(): GuardPlugin {
  return {
    name, Config, inject,
    apply(ctx: Context, config: GuardConfig): void {
      // Logging is best effort: an exporter failure must never change the assembly.
      const log = (level: 'info' | 'warn', message: string, ...args: unknown[]): void => {
        try { ctx.logger?.[level]?.(message, ...args); } catch { /* diagnostics only */ }
      };
      ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly> => {
        // An upstream failure belongs to the downstream chain and propagates unchanged.
        const downstream = await next();
        try {
          const settings = settingsOf(config);
          if (!matchesRoute(downstream.variables.provider, downstream.variables.model, settings)) return downstream;
          const result = normalizeToolSchemas(downstream.tools);
          if (settings.logFixes) {
            if (result.fixed.length > 0) {
              log('info', 'copilot-tool-schema: added a properties bucket to %d tool schema(s) for %s/%s', result.fixed.length, String(downstream.variables.provider), String(downstream.variables.model));
            }
            if (result.skipped.length > 0) {
              log('warn', 'copilot-tool-schema: %s left %d tool schema(s) unchanged: %s', TOOL_SCHEMA_SKIPPED, result.skipped.length, JSON.stringify(result.skipped));
            }
          }
          if (!result.changed) return downstream;
          return { ...downstream, tools: result.tools };
        } catch {
          log('warn', 'copilot-tool-schema: skipped one assembly after an internal error');
          return downstream;
        }
      }, { global: true, prepend: true });
    },
  };
}
