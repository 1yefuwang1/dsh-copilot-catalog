import type { Api, Model, ModelCost, ModelCostRates, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { asRecord, type AccountSelection, type ModelCatalog } from './types.js';

export const MODEL_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  'gpt-6.1-sol': 'gpt-6-sol',
  'gpt-5.6-sol-fast': 'gpt-5.6-sol',
});

const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PRICE_PARTS = ['input_price', 'output_price', 'cache_price', 'cache_write_price'] as const;
type Prices = Record<string, unknown> & Record<typeof PRICE_PARTS[number], number>;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const own = <T>(object: Record<string, T>, key: string): T | undefined => Object.hasOwn(object, key) ? object[key] : undefined;

function validPrices(value: unknown): value is Prices {
  const record = asRecord(value);
  return record !== undefined && PRICE_PARTS.every((key) => typeof record[key] === 'number' &&
    Number.isFinite(record[key]) && record[key] >= 0);
}

/** Convert cents per million tokens only when every required price is valid. */
export function liveCost(billing: unknown, fallback: ModelCost): ModelCost {
  const prices = asRecord(asRecord(billing)?.token_prices);
  const regular = asRecord(prices?.default);
  if (prices?.batch_size !== 1_000_000 || !validPrices(regular)) return fallback;
  const convert = (value: Prices): ModelCostRates => ({
    input: value.input_price / 100,
    output: value.output_price / 100,
    cacheRead: value.cache_price / 100,
    cacheWrite: value.cache_write_price / 100,
  });
  const cost: ModelCost = convert(regular);
  if (positiveInteger(regular.context_max) && validPrices(prices.long_context)) {
    cost.tiers = [{ inputTokensAbove: regular.context_max, ...convert(prices.long_context) }];
  }
  return cost;
}

function createNewModel(item: Record<string, unknown> & { id: string }, catalog: ModelCatalog): Model<Api> | undefined {
  const templateId = own(MODEL_TEMPLATES, item.id);
  const base = templateId ? own(catalog, templateId) : undefined;
  if (!base || base.api !== 'openai-responses' || !Array.isArray(item.supported_endpoints) ||
      !item.supported_endpoints.includes('/responses')) return undefined;
  const capabilities = asRecord(item.capabilities);
  const limits = asRecord(capabilities?.limits);
  if (!positiveInteger(limits?.max_context_window_tokens) || !positiveInteger(limits.max_output_tokens) ||
      limits.max_output_tokens > limits.max_context_window_tokens) return undefined;
  const supports = asRecord(capabilities?.supports);
  const reasoning = supports?.reasoning_effort;
  const thinkingLevelMap = { ...base.thinkingLevelMap };
  if (Array.isArray(reasoning)) {
    for (const level of THINKING_LEVELS) {
      // An explicit wire mapping wins over the selector's spelling.
      const wireLevel = thinkingLevelMap[level] ?? level;
      if (!reasoning.includes(wireLevel)) thinkingLevelMap[level] = null;
    }
  }
  // This known sibling's protocol does not support disabled/minimal reasoning.
  if (item.id === 'gpt-6.1-sol') {
    thinkingLevelMap.off = null;
    thinkingLevelMap.minimal = null;
  }
  return {
    ...base,
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id,
    contextWindow: limits.max_context_window_tokens,
    maxTokens: limits.max_output_tokens,
    input: supports?.vision === true ? ['text', 'image'] : ['text'],
    cost: liveCost(item.billing, base.cost),
    thinkingLevelMap,
  };
}

/** Pure selection: known IDs retain their exact upstream descriptors. */
export function selectAccountModels(response: unknown, catalog: ModelCatalog): AccountSelection {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) throw new Error('Invalid Copilot /models response');
  if (!catalog || typeof catalog !== 'object') throw new TypeError('A bundled model catalog is required');
  const models: ModelCatalog = Object.create(null) as ModelCatalog;
  const unsupported = new Set<string>();
  for (const raw of data) {
    const item = asRecord(raw);
    const policy = asRecord(item?.policy);
    const supports = asRecord(asRecord(item?.capabilities)?.supports);
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.model_picker_enabled !== true ||
        (policy?.state !== undefined && policy.state !== 'enabled') || supports?.tool_calls === false) continue;
    // Never accept Object.prototype members as model descriptors.
    const model = own(catalog, item.id) ?? createNewModel({ ...item, id: item.id }, catalog);
    if (model) models[item.id] = model;
    else unsupported.add(item.id);
  }
  if (Object.keys(models).length === 0) throw new Error('No supported enabled Copilot models found');
  return { models, unsupported: [...unsupported] };
}

/** Validate mutability before touching a shared upstream catalog. */
export function replaceCatalog(catalog: ModelCatalog, models: ModelCatalog): void {
  const descriptors = Object.getOwnPropertyDescriptors(catalog);
  if (!Object.isExtensible(catalog) || Object.values(descriptors).some((value) => !value.configurable)) {
    throw new Error('The upstream Copilot catalog is not mutable');
  }
  // Plain data properties prevent setters and prototype-sensitive assignment.
  for (const key of Object.keys(descriptors)) delete catalog[key];
  for (const [key, value] of Object.entries(models)) {
    Object.defineProperty(catalog, key, { value, enumerable: true, configurable: true, writable: true });
  }
}
