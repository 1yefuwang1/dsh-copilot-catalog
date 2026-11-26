import { isTrustedCopilotUrl } from './identity.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The Copilot Responses surface, the only one that carries top-level `strict`. */
export function isResponsesSurface(url: URL): boolean {
  return url.pathname === '/responses' || url.pathname.startsWith('/responses/');
}

/**
 * Default ordinary Copilot Responses function tools to non-strict sampling.
 *
 * Apply after serialization so bundled, discovered and fallback models agree,
 * without claiming strict-schema support for every backend in the catalog.
 * Explicit strict settings and custom/native tools are never overridden.
 *
 * The object-level half of {@link normalizeCopilotResponsesStrict}: it mutates
 * the already-parsed request and reports whether anything changed, so one parse
 * can serve every wire stage.
 *
 * @param request - the parsed request body.
 * @returns whether at least one declaration gained `strict: false`.
 */
export function applyResponsesStrictDefaults(request: Record<string, unknown>): boolean {
  if (!Array.isArray(request.tools)) return false;
  let changed = false;
  for (const tool of request.tools) {
    if (!isRecord(tool) || tool.type !== 'function' || typeof tool.name !== 'string' ||
        !isRecord(tool.parameters) || Object.hasOwn(tool, 'strict')) continue;
    tool.strict = false;
    changed = true;
  }
  return changed;
}

/**
 * String-level entry point for the Responses strictness default.
 *
 * Kept for the package surface and its unit tests; the mounted plugin now runs
 * {@link applyResponsesStrictDefaults} inside the single-parse wire pass.
 *
 * @param url - the request URL.
 * @param body - the serialized request body.
 * @returns the rewritten body, or `undefined` when it stays byte-identical.
 */
export function normalizeCopilotResponsesStrict(url: URL, body: string): string | undefined {
  if (!isTrustedCopilotUrl(url) || !isResponsesSurface(url)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  return applyResponsesStrictDefaults(parsed) ? JSON.stringify(parsed) : undefined;
}
