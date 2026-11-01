import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';

/** One model-facing tool declaration from the assembled prompt. */
export type ToolSchema = PromptAssembly['tools'][number];
export type { PromptAssembly };

/** Guard settings, read through volatile accessors once per assembly. */
export interface GuardSettings {
  readonly providers: readonly string[];
  readonly families: readonly string[];
  readonly logFixes: boolean;
}

/** One skipped tool and the controlled reason code. */
export interface SkippedTool {
  readonly tool: string;
  readonly reason: string;
}
