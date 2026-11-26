import type { ModelCatalog } from './catalog-types.js';
import type { GuardSettings, SkippedTool } from './guard-types.js';
import { applyToolSchemaDefaults, MAX_GUARDED_BODY_BYTES } from './guard.js';
import { isTrustedCopilotUrl } from './identity.js';
import { applyEmptyMessageDrop, isChatCompletionsSurface, MAX_TRIMMABLE_BODY_BYTES } from './messages.js';
import { applyResponsesStrictDefaults, isResponsesSurface } from './strict.js';
import { applyTemperatureOmission } from './temperature.js';

/**
 * One pass over a serialized Copilot request, applying every wire stage to a
 * single parse.
 *
 * The stages were independent string-in/string-out normalizers, so a request
 * that needed three of them parsed the same multi-megabyte body three times.
 * Nothing about the stages requires a fresh parse: each decides from the parsed
 * request alone. Composing them makes the wire cost one parse and at most one
 * re-serialization, and keeps the byte-identical contract at the top level.
 *
 * @module dsh-better-copilot/wire
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One request's wire settings, already resolved for this request. */
export interface CopilotWireStages {
  /** The discovered catalog; the temperature stage needs it. */
  readonly catalog: ModelCatalog;
  /**
   * One configuration snapshot for the guard, or `undefined` when its settings
   * could not be read. An unreadable group disables only its own stage.
   */
  readonly toolSchema: GuardSettings | undefined;
  /** Whether the empty-text stage runs; its own settings gate it. */
  readonly dropEmptyMessages: boolean;
}

/** What one wire pass changed, so the caller can report it without re-parsing. */
export interface CopilotWireResult {
  /** The re-serialized body, or `undefined` when the request stays byte-identical. */
  readonly body: string | undefined;
  /** Empty text turns removed by the message stage. */
  readonly droppedMessages: number;
  /** Tool names that gained an empty properties bucket. */
  readonly fixedTools: readonly string[];
  /** Tools the guard left byte-identical, with a controlled reason. */
  readonly skippedTools: readonly SkippedTool[];
}

const UNCHANGED: CopilotWireResult = { body: undefined, droppedMessages: 0, fixedTools: [], skippedTools: [] };

/**
 * Apply every Copilot wire stage to one serialized request in a single parse.
 *
 * Stage order is the order the independent normalizers ran in: Responses
 * strictness, then temperature omission, then empty-text removal, then tool
 * declarations. Each stage keeps its own scope and its own body-size bound, so
 * a request that qualified for only some of them is treated exactly as before.
 *
 * Nothing is invented: a body that is not JSON, is not a JSON object, or targets
 * another origin is returned byte-identical, and so is a body on which no stage
 * changed anything.
 *
 * @param url - the request URL the wire transform was handed.
 * @param body - the serialized request body as the adapter built it.
 * @param stages - the resolved settings for this request.
 * @returns the rewritten body plus every change that was made.
 */
export function normalizeCopilotRequest(url: URL, body: string, stages: CopilotWireStages): CopilotWireResult {
  if (!isTrustedCopilotUrl(url) || body.length === 0) return UNCHANGED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  }
  catch {
    return UNCHANGED;
  }
  if (!isRecord(parsed)) return UNCHANGED;
  const request = parsed;

  // Surface-scoped stages check the path, not the body shape: the Responses
  // surface carries `strict` and chat completions carries `messages`.
  const strict = isResponsesSurface(url) && applyResponsesStrictDefaults(request);
  const omitted = applyTemperatureOmission(request, stages.catalog);
  const droppedMessages = stages.dropEmptyMessages && isChatCompletionsSurface(url) && body.length <= MAX_TRIMMABLE_BODY_BYTES
    ? applyEmptyMessageDrop(request)
    : 0;
  const guard = stages.toolSchema !== undefined && body.length <= MAX_GUARDED_BODY_BYTES
    ? applyToolSchemaDefaults(request, stages.toolSchema)
    : { fixed: [], skipped: [] };
  const changed = strict || omitted || droppedMessages > 0 || guard.fixed.length > 0;
  return {
    body: changed ? JSON.stringify(request) : undefined,
    droppedMessages,
    fixedTools: guard.fixed,
    skippedTools: guard.skipped,
  };
}
