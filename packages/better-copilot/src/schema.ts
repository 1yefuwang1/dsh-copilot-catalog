import type { GuardSettings, SkippedTool, ToolSchema } from './guard-types.js';

/** Controlled reason code logged for a tool the guard refuses to reshape. */
export const TOOL_SCHEMA_SKIPPED = 'TOOL_SCHEMA_SKIPPED';

export interface NormalizeResult {
  /** New array; unchanged entries preserve their identity. */
  readonly tools: ToolSchema[];
  /** True only when at least one declaration gained a properties bucket. */
  readonly changed: boolean;
  /** Tool names whose declaration gained an empty properties bucket. */
  readonly fixed: string[];
  /** Tools left byte-identical, with a controlled reason. */
  readonly skipped: readonly SkippedTool[];
}

/** The verdict for one declaration's parameter schema. */
export type ParameterDecision =
  | { readonly fix: true }
  | { readonly fix: false; readonly reason?: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Decide whether one root parameter schema needs an empty properties bucket.
 *
 * The GitHub Copilot Gemini route rejects a request whose tool declaration carries
 * an object parameter schema with no properties bucket (measured: HTTP 400 with a
 * plain-text body). Adding the bucket is JSON-Schema neutral and does not change
 * unions, required fields, additionalProperties or descriptions. Nothing else is
 * rewritten: references, non-object schemas and every nested node stay untouched.
 *
 * @param parameters - the root schema exactly as the declaration carries it.
 * @returns whether to add the bucket, or the controlled reason it stays untouched.
 */
export function classifyParameters(parameters: unknown): ParameterDecision {
  if (parameters === undefined) return { fix: false, reason: 'SKIPPED_MISSING_PARAMETERS' };
  if (!isPlainObject(parameters)) return { fix: false, reason: 'SKIPPED_NOT_OBJECT' };
  if (Object.hasOwn(parameters, '$ref') || Object.hasOwn(parameters, '$dynamicRef')) return { fix: false, reason: 'SKIPPED_REFERENCE' };
  if (parameters.type !== 'object') return { fix: false, reason: 'SKIPPED_NOT_OBJECT_TYPE' };
  if (parameters.properties !== undefined) {
    return isPlainObject(parameters.properties) ? { fix: false } : { fix: false, reason: 'SKIPPED_INVALID_PROPERTIES' };
  }
  return { fix: true };
}

/**
 * Add an empty root properties bucket to object parameter schemas that lack one.
 *
 * @param tools - the declarations one assembly or request carries.
 * @returns the rewritten declarations plus every fixed and skipped tool name.
 */
export function normalizeToolSchemas(tools: readonly ToolSchema[]): NormalizeResult {
  const fixed: string[] = [];
  const skipped: SkippedTool[] = [];
  const output: ToolSchema[] = [];
  for (const tool of tools) {
    const decision = classifyParameters(tool.parameters);
    if (decision.fix) {
      fixed.push(tool.name);
      output.push({ ...tool, parameters: { ...(tool.parameters as Record<string, unknown>), properties: {} } });
      continue;
    }
    if (decision.reason !== undefined) skipped.push({ tool: tool.name, reason: decision.reason });
    output.push(tool);
  }
  return { tools: output, changed: fixed.length > 0, fixed, skipped };
}

/**
 * Whether one route is in scope: its provider is listed and its model id contains
 * one of the configured family markers (case-insensitive). Unknown routes are out.
 */
export function matchesRoute(provider: unknown, model: unknown, settings: GuardSettings): boolean {
  if (typeof provider !== 'string' || typeof model !== 'string' || provider.length === 0 || model.length === 0) return false;
  if (!settings.providers.includes(provider)) return false;
  const id = model.toLowerCase();
  return settings.families.some((family) => family.length > 0 && id.includes(family.toLowerCase()));
}
