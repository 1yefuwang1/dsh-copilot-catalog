import type { Api, Model } from '@earendil-works/pi-ai';
import { asRecord, type ModelCatalog } from './catalog-types.js';

/**
 * Apply only an explicit boolean from capabilities.supports.temperature.
 * OpenAI compat schemas do not yet declare this field, but the wire boundary
 * reads the same metadata used natively by pi-ai's Anthropic serializer.
 * Preserve descriptor identity when discovery has nothing new to say.
 */
export function withCopilotTemperatureSupport<T extends Model<Api>>(model: T, support: unknown): T {
  if (typeof support !== 'boolean' || asRecord(model.compat)?.supportsTemperature === support) return model;
  return { ...model, compat: { ...model.compat, supportsTemperature: support } };
}

/**
 * Omit an unsupported temperature on an already-parsed request.
 *
 * The object-level half of {@link normalizeCopilotTemperature}: it mutates the
 * parsed request and reports whether the field was removed, so one parse can
 * serve every wire stage. IDs are opaque and reasoning capability says nothing
 * about temperature: only an exact catalog descriptor with explicit false
 * compatibility metadata is sufficient to remove the field.
 *
 * @param request - the parsed request body.
 * @param catalog - the discovered model catalog.
 * @returns whether `temperature` was removed.
 */
export function applyTemperatureOmission(request: Record<string, unknown>, catalog: ModelCatalog): boolean {
  if (typeof request.model !== 'string' || !Object.hasOwn(request, 'temperature') ||
      !Object.hasOwn(catalog, request.model)) return false;
  const model = catalog[request.model];
  if (model?.provider !== 'github-copilot' || asRecord(model.compat)?.supportsTemperature !== false) return false;
  delete request.temperature;
  return true;
}

/**
 * Omit an unsupported temperature after SDK serialization, for every request
 * purpose (including auxiliary review).
 *
 * Kept for the package surface and its unit tests; the mounted plugin now runs
 * {@link applyTemperatureOmission} inside the single-parse wire pass.
 * Install through the existing trusted Copilot request transform, not as a
 * separate interceptor. Undefined means the original body stays byte-identical.
 */
export function normalizeCopilotTemperature(body: string, catalog: ModelCatalog): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  const request = asRecord(parsed);
  if (!request) return undefined;
  return applyTemperatureOmission(request, catalog) ? JSON.stringify(request) : undefined;
}
