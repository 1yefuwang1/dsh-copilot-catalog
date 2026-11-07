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
 * Omit an unsupported temperature after SDK serialization, for every request
 * purpose (including auxiliary review). IDs are opaque and reasoning capability
 * says nothing about temperature: only an exact catalog descriptor with explicit
 * false compatibility metadata is sufficient to remove the field.
 *
 * Install through the existing trusted Copilot request transform, not as a
 * separate interceptor. Undefined means the original body stays byte-identical.
 */
export function normalizeCopilotTemperature(body: string, catalog: ModelCatalog): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return undefined; }
  const request = asRecord(parsed);
  if (!request || typeof request.model !== 'string' || !Object.hasOwn(request, 'temperature') ||
      !Object.hasOwn(catalog, request.model)) return undefined;
  const model = catalog[request.model];
  if (model?.provider !== 'github-copilot' || asRecord(model.compat)?.supportsTemperature !== false) return undefined;
  delete request.temperature;
  return JSON.stringify(request);
}
