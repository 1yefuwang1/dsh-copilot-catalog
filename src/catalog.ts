import type { Api, Model, ModelCost, ModelCostRates, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { asRecord, type AccountSelection, type ModelCatalog } from './types.js';

export const DEFAULT_COPILOT_BASE_URL = 'https://api.individual.githubcopilot.com';

// Provider identity defaults match the supported pi-ai Copilot OAuth client.
// These are protocol defaults, not metadata borrowed from a particular model.
const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
});

type CopilotApi = 'openai-responses' | 'openai-completions' | 'anthropic-messages';
const ENDPOINTS: ReadonlyArray<readonly [string, CopilotApi]> = [
  ['/responses', 'openai-responses'],
  ['/v1/messages', 'anthropic-messages'],
  ['/chat/completions', 'openai-completions'],
];
const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PRICE_PARTS = ['input_price', 'output_price', 'cache_price', 'cache_write_price'] as const;
type Prices = Record<string, unknown> & Record<typeof PRICE_PARTS[number], number>;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const own = <T>(object: Record<string, T>, key: string): T | undefined => Object.hasOwn(object, key) ? object[key] : undefined;

export interface AccountModelOptions {
  /** Trusted account API root. Startup discovery supplies the validated OAuth origin. */
  baseUrl?: string;
}

/** Copy only provider identity headers; never inherit Authorization or API keys. */
export function copilotHeaders(catalog: ModelCatalog): Record<string, string> {
  const headers = { ...DEFAULT_HEADERS };
  for (const model of Object.values(catalog)) {
    if (model.provider !== 'github-copilot' || !model.headers) continue;
    let found = false;
    for (const [name, fallback] of Object.entries(DEFAULT_HEADERS)) {
      const entry = Object.entries(model.headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
      if (entry && entry[1].trim() && !/[\r\n]/.test(entry[1])) {
        headers[name] = entry[1];
        found = true;
      } else {
        headers[name] = fallback;
      }
    }
    if (found) break;
  }
  return headers;
}

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

function reasoningMetadata(api: CopilotApi, supports: Record<string, unknown> | undefined):
  Pick<Model<Api>, 'reasoning' | 'thinkingLevelMap'> & { adaptiveThinking: boolean } {
  const efforts = supports?.reasoning_effort;
  if (Array.isArray(efforts)) {
    const map: ThinkingLevelMap = {};
    for (const level of THINKING_LEVELS) {
      const wire = level === 'off' && efforts.includes('none') ? 'none' : level;
      map[level] = efforts.includes(wire) ? wire : null;
    }
    const reasoning = THINKING_LEVELS.some((level) => level !== 'off' && typeof map[level] === 'string');
    // A native Messages effort list describes adaptive output_config.effort.
    return { reasoning, thinkingLevelMap: map, adaptiveThinking: api === 'anthropic-messages' && reasoning };
  }
  if (api === 'anthropic-messages' && supports?.thinking === true) {
    // Legacy native thinking advertises a budget rather than effort spellings.
    // Use pi-ai's standard budget levels, without inventing xhigh/max support.
    return { reasoning: true, thinkingLevelMap: { xhigh: null, max: null }, adaptiveThinking: false };
  }
  // Missing/unknown effort metadata must not invent user-selectable reasoning.
  return { reasoning: false, adaptiveThinking: false };
}

function protocolCompat(api: CopilotApi, reasoning: boolean, adaptiveThinking: boolean): Model<Api>['compat'] {
  switch (api) {
    case 'openai-responses': return {
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    };
    case 'openai-completions': return {
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      supportsStore: false,
      supportsUsageInStreaming: false,
      supportsLongCacheRetention: false,
      supportsReasoningEffort: reasoning,
      thinkingFormat: 'openai',
    };
    case 'anthropic-messages': return {
      forceAdaptiveThinking: adaptiveThinking,
      supportsStrictTools: false,
      supportsTemperature: false,
      supportsLongCacheRetention: false,
      supportsCacheControlOnTools: false,
      supportsEagerToolInputStreaming: false,
    };
  }
}

function createNewModel(item: Record<string, unknown> & { id: string }, headers: Record<string, string>, baseUrl: string): Model<Api> | undefined {
  // IDs are opaque; reject malformed request IDs, never infer a vendor/family.
  const endpoints = item.supported_endpoints;
  if (/[\s\u0000-\u001f\u007f]/u.test(item.id) || !Array.isArray(endpoints)) return undefined;
  const api = ENDPOINTS.find(([endpoint]) => endpoints.includes(endpoint))?.[1];
  if (!api) return undefined;
  const capabilities = asRecord(item.capabilities);
  if (capabilities?.type !== undefined && capabilities.type !== 'chat') return undefined;
  const limits = asRecord(capabilities?.limits);
  if (!positiveInteger(limits?.max_context_window_tokens) || !positiveInteger(limits.max_output_tokens) ||
      limits.max_output_tokens > limits.max_context_window_tokens) return undefined;
  const supports = asRecord(capabilities?.supports);
  if (supports?.streaming === false) return undefined;
  const { reasoning, thinkingLevelMap, adaptiveThinking } = reasoningMetadata(api, supports);
  return {
    id: item.id,
    name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id,
    api,
    provider: 'github-copilot',
    baseUrl,
    contextWindow: limits.max_context_window_tokens,
    maxTokens: limits.max_output_tokens,
    input: supports?.vision === true ? ['text', 'image'] : ['text'],
    // Unknown pricing is represented by zero, never a guessed sibling's rates.
    cost: liveCost(item.billing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: protocolCompat(api, reasoning, adaptiveThinking),
    headers: { ...headers },
  };
}

/** Pure selection: preserve known descriptors; build any new ID from endpoint/capability metadata. */
export function selectAccountModels(response: unknown, catalog: ModelCatalog, {
  baseUrl = DEFAULT_COPILOT_BASE_URL,
}: AccountModelOptions = {}): AccountSelection {
  const data = asRecord(response)?.data;
  if (!Array.isArray(data)) throw new Error('Invalid Copilot /models response');
  if (!catalog || typeof catalog !== 'object') throw new TypeError('A bundled model catalog is required');
  const headers = copilotHeaders(catalog);
  const models: ModelCatalog = Object.create(null) as ModelCatalog;
  const unsupported = new Set<string>();
  for (const raw of data) {
    const item = asRecord(raw);
    const policy = asRecord(item?.policy);
    const supports = asRecord(asRecord(item?.capabilities)?.supports);
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.model_picker_enabled !== true ||
        (policy?.state !== undefined && policy.state !== 'enabled') || supports?.tool_calls === false ||
        Object.hasOwn(models, item.id)) continue;
    // Own-property lookup prevents Object.prototype members becoming descriptors.
    const model = own(catalog, item.id) ?? createNewModel({ ...item, id: item.id }, headers, baseUrl);
    if (model) {
      models[item.id] = model;
      unsupported.delete(item.id);
    } else {
      unsupported.add(item.id);
    }
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
