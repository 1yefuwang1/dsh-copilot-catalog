import type { GuardSettings, SkippedTool } from './guard-types.js';
import { classifyParameters, matchesRoute } from './schema.js';

// The guard subpath keeps publishing its classification primitives: they are the
// same rules the wire rewrite applies, and consumers may classify a declaration
// without installing the transform.
export { classifyParameters, matchesRoute, normalizeToolSchemas, TOOL_SCHEMA_SKIPPED } from './schema.js';
export type { NormalizeResult, ParameterDecision } from './schema.js';
export type { GuardSettings, PromptAssembly, SkippedTool, ToolSchema } from './guard-types.js';

/**
 * The largest serialized Copilot request this guard will parse. A request that
 * carries tool declarations is far smaller; anything past this bound is left
 * byte-identical rather than copied and re-parsed.
 */
export const MAX_GUARDED_BODY_BYTES = 8 * 1024 * 1024;

/** One rewritten request body plus what the guard changed and refused to change. */
export interface GuardedBody {
  /** The re-serialized body, or `undefined` when the request stays byte-identical. */
  readonly body: string | undefined;
  /** True only when at least one declaration gained a properties bucket. */
  readonly changed: boolean;
  /** Tool names whose declaration gained an empty properties bucket. */
  readonly fixed: string[];
  /** Tools left byte-identical, with a controlled reason. */
  readonly skipped: readonly SkippedTool[];
}

/** The route this plugin owns; the wire guard runs only on its endpoints. */
const COPILOT_ROUTE = 'github-copilot';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Locate one tool declaration's parameter schema on either Copilot inference surface.
 *
 * Chat completions carries `{ type: 'function', function: { name, parameters } }`
 * while Responses carries `{ type: 'function', name, parameters }`. Both are the
 * OpenAI-compatible shape the adapter serializes; anything else is not ours.
 */
function declarationOf(tool: unknown): { holder: Record<string, unknown>; name: string } | undefined {
  if (!isRecord(tool) || tool.type !== 'function') return undefined;
  const holder = isRecord(tool.function) ? tool.function : tool;
  return typeof holder.name === 'string' && holder.name.length > 0 ? { holder, name: holder.name } : undefined;
}

/**
 * Normalize tool declarations on one serialized Copilot inference request.
 *
 * The Gemini route measures this at the HTTP boundary: it rejects a request whose
 * tool declaration carries an object parameter schema with no properties bucket.
 * The presentation assembly no longer exposes declarations to listeners, so the
 * guard rewrites the exact serialized body instead — lexically the last point
 * before dispatch, and the same place the failure is measured.
 *
 * Nothing is invented: a body that is not JSON, carries no tool array, exceeds
 * the bound, or targets another route or model family is returned untouched.
 *
 * @param body - the serialized request body as the adapter built it.
 * @param settings - one configuration snapshot for this request.
 * @returns the rewrite result; `body` stays `undefined` unless something changed.
 */
export function guardCopilotRequestBody(body: string, settings: GuardSettings): GuardedBody {
  const unchanged: GuardedBody = { body: undefined, changed: false, fixed: [], skipped: [] };
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_GUARDED_BODY_BYTES) return unchanged;
  // A cheap pre-check keeps message-heavy bodies out of the JSON parser entirely.
  if (!body.includes('"tools"')) return unchanged;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return unchanged; }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools) || parsed.tools.length === 0) return unchanged;
  if (!matchesRoute(COPILOT_ROUTE, parsed.model, settings)) return unchanged;
  const declarations = parsed.tools.map(declarationOf);
  if (declarations.every(declaration => declaration === undefined)) return unchanged;
  const fixed: string[] = [];
  const skipped: SkippedTool[] = [];
  for (const declaration of declarations) {
    if (declaration === undefined) continue;
    const decision = classifyParameters(declaration.holder.parameters);
    if (decision.fix) {
      fixed.push(declaration.name);
      declaration.holder.parameters = { ...(declaration.holder.parameters as Record<string, unknown>), properties: {} };
      continue;
    }
    if (decision.reason !== undefined) skipped.push({ tool: declaration.name, reason: decision.reason });
  }
  if (fixed.length === 0) return { body: undefined, changed: false, fixed, skipped };
  return { body: JSON.stringify(parsed), changed: true, fixed, skipped };
}
