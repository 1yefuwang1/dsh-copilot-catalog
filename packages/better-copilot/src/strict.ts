import { isTrustedCopilotUrl } from './identity.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Default ordinary Copilot Responses function tools to non-strict sampling.
 * Apply after serialization so bundled, discovered and fallback models agree,
 * without claiming strict-schema support for every backend in the catalog.
 * Explicit strict settings and custom/native tools are never overridden.
 */
export function normalizeCopilotResponsesStrict(url: URL, body: string): string | undefined {
  if (!isTrustedCopilotUrl(url) || !(url.pathname === '/responses' || url.pathname.startsWith('/responses/'))) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return undefined;
  let changed = false;
  for (const tool of parsed.tools) {
    if (!isRecord(tool) || tool.type !== 'function' || typeof tool.name !== 'string' ||
        !isRecord(tool.parameters) || Object.hasOwn(tool, 'strict')) continue;
    tool.strict = false;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : undefined;
}
