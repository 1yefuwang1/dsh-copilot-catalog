import type { Api, Model, ModelCost, ModelInputLimits, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { asRecord, type ModelCatalog } from './catalog-types.js';

/** The pi-ai catalog route this module keeps in sync with OpenCode's public listing. */
export const OPENCODE_GO_PROVIDER = 'opencode-go';
/** OpenCode Go advertises its chat catalog unauthenticated at this listing. */
export const DEFAULT_OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models';
export const OPENCODE_GO_MAX_MODELS = 512;
/** The catalog is metadata only; a larger document is not a model list this plugin trusts. */
export const OPENCODE_GO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 256;
const MAX_EFFORTS = 16;
const MAX_TIERS = 8;
const MAX_RATE = 1_000_000;

/** pi-ai wire protocols an OpenCode Go model may be dispatched through. */
export type OpencodeProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

/** Preference order is also the canonical order used by the cache document. */
const PROTOCOLS: readonly OpencodeProtocol[] = [
  'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai',
];
const PROVIDER_APIS: Readonly<Record<string, OpencodeProtocol>> = Object.freeze({
  'chat-completions': 'openai-completions',
  'responses': 'openai-responses',
  'messages': 'anthropic-messages',
  'generate-content': 'google-generative-ai',
});
/** Catalog endpoints a discovered model inherits from its installed api siblings. */
const DEFAULT_BASE_URLS: Readonly<Record<OpencodeProtocol, string>> = Object.freeze({
  'openai-completions': 'https://opencode.ai/inference/go/v1',
  'openai-responses': 'https://opencode.ai/inference/go/v1',
  'anthropic-messages': 'https://opencode.ai/inference/go',
  'google-generative-ai': 'https://opencode.ai/inference/go/v1',
});
const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS = new Set(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const FALLBACK_IMAGE_LIMITS: ModelInputLimits = Object.freeze({
  images: Object.freeze({ resize: Object.freeze({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 }) }),
});

/**
 * Bounded, allowlisted OpenCode model metadata. This is both the live selection
 * input and the persisted cache document, so it carries exactly the facts the
 * descriptor builder needs and never a provider URL, credential or descriptor.
 */
export interface OpencodeMetadata {
  id: string;
  name: string;
  apis: OpencodeProtocol[];
  recommended?: OpencodeProtocol;
  reasoningField?: 'reasoning_content';
  context: number;
  maxOutput: number;
  images: boolean;
  tools: boolean;
  reasoning: boolean;
  thinking?: ThinkingLevelMap;
  temperature: boolean;
  cost: ModelCost;
}

export interface OpencodeNormalization {
  data: OpencodeMetadata[];
  /** Chat entries that were advertised but could not be described. */
  unsupported: string[];
}

export interface OpencodeSelection {
  models: ModelCatalog;
  unsupported: string[];
}

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/u.test(value) && !/\s/u.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/u.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function indexOfProtocol(value: string): number {
  const index = PROTOCOLS.indexOf(value as OpencodeProtocol);
  return index;
}

/**
 * Derive the unauthenticated listing URL. An explicit route baseURL wins, and a
 * non-versioned endpoint gains the `/v1` segment every installed sibling uses.
 * Only canonical HTTPS origins are accepted; redirects/credentials never apply.
 */
export function opencodeGoListingUrl(baseUrl?: string | null): URL {
  if (baseUrl === undefined || baseUrl === null) return new URL(DEFAULT_OPENCODE_GO_MODELS_URL);
  if (typeof baseUrl !== 'string') throw new TypeError('Invalid OpenCode Go endpoint');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError('Invalid OpenCode Go endpoint');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
    throw new TypeError('Invalid OpenCode Go endpoint');
  }
  const path = url.pathname.replace(/\/+$/u, '');
  return new URL(`${path.endsWith('/v1') ? path : `${path}/v1`}/models`, url.origin);
}

function effortList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_EFFORTS) return [];
  const seen = new Set<string>();
  for (const entry of value) if (typeof entry === 'string' && EFFORTS.has(entry)) seen.add(entry);
  return [...seen];
}

/** Copy only levels the provider advertises; a missing level stays unsupported. */
function thinkingLevels(efforts: readonly string[]): ThinkingLevelMap | undefined {
  const map: ThinkingLevelMap = {};
  let reasoning = false;
  for (const level of MODEL_THINKING_LEVELS) {
    const wire = level === 'off'
      ? (efforts.includes('none') ? 'none' : efforts.includes('off') ? 'off' : null)
      : efforts.includes(level) ? level : null;
    map[level] = wire;
    if (level !== 'off' && wire !== null) reasoning = true;
  }
  return reasoning ? map : undefined;
}

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RATE ? value : undefined;
}

/** Cache-write prices are either a rate or a retention map; the cheapest wins. */
function writeRate(value: unknown): number | undefined {
  const direct = rate(value);
  if (direct !== undefined) return direct;
  const record = asRecord(value);
  if (!record) return undefined;
  const rates = Object.values(record).flatMap((entry) => rate(entry) ?? []);
  return rates.length > 0 ? Math.min(...rates) : undefined;
}

interface TierRates { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
function costTiers(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined,
  base: ModelCost): NonNullable<ModelCost['tiers']> {
  const parts = new Map<number, TierRates>();
  const collect = (source: Record<string, unknown> | undefined, kind: 'input' | 'output') => {
    const overrides = source?.overrides;
    if (!Array.isArray(overrides) || overrides.length > MAX_TIERS * 2) return;
    for (const raw of overrides) {
      const entry = asRecord(raw);
      const context = asRecord(asRecord(entry?.when)?.context);
      if (!positiveInteger(context?.gt)) continue;
      const rates = parts.get(context.gt) ?? {};
      if (kind === 'input') {
        rates.input = rate(entry?.price) ?? rates.input;
        const cache = asRecord(entry?.cache);
        rates.cacheRead = rate(cache?.read) ?? rates.cacheRead;
        rates.cacheWrite = writeRate(cache?.write) ?? rates.cacheWrite;
      } else {
        rates.output = rate(entry?.price) ?? rates.output;
      }
      parts.set(context.gt, rates);
    }
  };
  collect(input, 'input');
  collect(output, 'output');
  return [...parts.entries()].sort(([left], [right]) => left - right).slice(0, MAX_TIERS)
    .map(([inputTokensAbove, rates]) => ({
      inputTokensAbove,
      input: rates.input ?? base.input,
      output: rates.output ?? base.output,
      cacheRead: rates.cacheRead ?? base.cacheRead,
      cacheWrite: rates.cacheWrite ?? base.cacheWrite,
    }));
}

function modelCost(value: unknown): ModelCost {
  const text = asRecord(asRecord(value)?.text);
  const input = asRecord(text?.input);
  const cache = asRecord(input?.cache);
  const base: ModelCost = {
    input: rate(input?.price) ?? 0,
    output: rate(asRecord(text?.output)?.price) ?? 0,
    cacheRead: rate(cache?.read) ?? 0,
    cacheWrite: writeRate(cache?.write) ?? 0,
  };
  const tiers = costTiers(input, asRecord(text?.output), base);
  return tiers.length > 0 ? { ...base, tiers } : base;
}

function providerApis(value: unknown, recommendedApi: unknown): { apis: OpencodeProtocol[]; recommended?: OpencodeProtocol } {
  const advertised = asRecord(value);
  if (!advertised) return { apis: [] };
  const apis = Object.keys(advertised)
    .map((key) => PROVIDER_APIS[key])
    .filter((api): api is OpencodeProtocol => api !== undefined)
    .sort((left, right) => indexOfProtocol(left) - indexOfProtocol(right));
  const recommended = typeof recommendedApi === 'string' ? PROVIDER_APIS[recommendedApi] : undefined;
  return {
    apis: [...new Set(apis)],
    ...(recommended !== undefined && apis.includes(recommended) ? { recommended } : {}),
  };
}

function providerReasoningField(apis: Record<string, unknown> | undefined): 'reasoning_content' | undefined {
  const compatibility = asRecord(asRecord(apis?.['chat-completions'])?.compatibility);
  return compatibility?.reasoning_field === 'reasoning_content' ? 'reasoning_content' : undefined;
}

/**
 * Normalize the live `GET /models` document to bounded metadata. Non-chat
 * entries are outside the chat catalog and are skipped silently; a chat entry
 * without a usable context window is reported instead of inventing one.
 */
export function normalizeOpencodeCatalog(value: unknown): OpencodeNormalization | undefined {
  const data = asRecord(value)?.data;
  if (!Array.isArray(data) || data.length === 0 || data.length > OPENCODE_GO_MAX_MODELS) return undefined;
  const models: OpencodeMetadata[] = [];
  const unsupported = new Set<string>();
  const seen = new Set<string>();
  for (const raw of data) {
    const item = asRecord(raw);
    // A non-chat entry with a shared id must not hide the chat model that follows it.
    if (!item || !identifier(item.id) || item.type !== 'chat' || seen.has(item.id)) continue;
    seen.add(item.id);
    const capabilities = asRecord(item.capabilities);
    const limits = asRecord(item.limit) ?? asRecord(capabilities?.limits);
    if (!positiveInteger(limits?.context)) {
      unsupported.add(item.id);
      continue;
    }
    const output = positiveInteger(limits.output) ? limits.output : Math.min(limits.context, 128_000);
    const context = limits.context;
    const advertised = asRecord(item.api);
    const { apis, recommended } = providerApis(item.api, item.recommended_api);
    const modalities = asRecord(item.modalities);
    const images = Array.isArray(modalities?.input) &&
      modalities.input.some((entry) => typeof entry === 'string' && entry.startsWith('image/'));
    const reasoning = asRecord(capabilities?.reasoning);
    const supported = reasoning?.supported === true;
    const efforts = effortList(reasoning?.effort);
    const thinking = supported ? thinkingLevels(efforts) : undefined;
    models.push({
      id: item.id,
      name: label(item.name) ? item.name : item.id,
      apis,
      ...(recommended === undefined ? {} : { recommended }),
      ...(providerReasoningField(advertised) === undefined ? {} : { reasoningField: 'reasoning_content' as const }),
      context,
      maxOutput: Math.min(output, context),
      images,
      tools: asRecord(capabilities?.tools)?.supported !== false,
      reasoning: supported,
      ...(thinking === undefined ? {} : { thinking }),
      temperature: capabilities?.temperature === true,
      cost: modelCost(item.cost),
    });
  }
  return models.length > 0 ? { data: models, unsupported: [...unsupported] } : undefined;
}

function baseUrlFor(baseline: ModelCatalog, api: OpencodeProtocol): string {
  for (const model of Object.values(baseline)) {
    if (model?.provider === OPENCODE_GO_PROVIDER && model.api === api && typeof model.baseUrl === 'string' && model.baseUrl) {
      return model.baseUrl;
    }
  }
  return DEFAULT_BASE_URLS[api];
}

function imageLimits(baseline: ModelCatalog): ModelInputLimits {
  for (const model of Object.values(baseline)) {
    if (model?.inputLimits && typeof model.inputLimits === 'object') return structuredClone(model.inputLimits);
  }
  return structuredClone(FALLBACK_IMAGE_LIMITS);
}

function compatFor(api: OpencodeProtocol, metadata: OpencodeMetadata): Model<Api>['compat'] {
  switch (api) {
    case 'openai-completions': return {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsStrictMode: true,
      // A DeepSeek-style reasoning field must be replayed on assistant history too.
      ...(metadata.reasoning && metadata.reasoningField === 'reasoning_content'
        ? { thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true }
        : {}),
    };
    case 'openai-responses': return { sessionAffinityFormat: 'openai-nosession' };
    case 'anthropic-messages': return metadata.temperature ? undefined : { supportsTemperature: false };
    case 'google-generative-ai': return undefined;
  }
}

/**
 * Build the pi-ai catalog for one normalized listing. Known ids keep the
 * installed descriptor (its protocol compatibility is richer than liveness
 * metadata); only newly advertised ids are rebuilt. The result replaces the
 * route's list, so removed ids disappear until the next successful fetch.
 */
export function selectOpencodeModels(catalog: readonly OpencodeMetadata[], baseline: ModelCatalog): OpencodeSelection {
  if (!baseline || typeof baseline !== 'object') throw new TypeError('An installed OpenCode Go catalog is required');
  const models: ModelCatalog = Object.create(null) as ModelCatalog;
  const unsupported = new Set<string>();
  for (const metadata of catalog) {
    const known = Object.hasOwn(baseline, metadata.id) ? baseline[metadata.id] : undefined;
    if (known !== undefined) {
      if (!metadata.tools) { unsupported.add(metadata.id); continue; }
      models[metadata.id] = known;
      continue;
    }
    if (!metadata.tools || metadata.apis.length === 0) { unsupported.add(metadata.id); continue; }
    const api = metadata.recommended !== undefined && metadata.apis.includes(metadata.recommended)
      ? metadata.recommended : metadata.apis[0]!;
    const compat = compatFor(api, metadata);
    models[metadata.id] = {
      id: metadata.id,
      name: metadata.name,
      api,
      provider: OPENCODE_GO_PROVIDER,
      baseUrl: baseUrlFor(baseline, api),
      reasoning: metadata.reasoning,
      ...(metadata.thinking === undefined ? {} : { thinkingLevelMap: { ...metadata.thinking } }),
      input: metadata.images ? ['text', 'image'] : ['text'],
      cost: structuredClone(metadata.cost),
      contextWindow: metadata.context,
      maxTokens: metadata.maxOutput,
      ...(metadata.images ? { inputLimits: imageLimits(baseline) } : {}),
      ...(compat === undefined ? {} : { compat }),
    };
  }
  if (Object.keys(models).length === 0) throw new Error('No supported OpenCode Go chat models found');
  return { models, unsupported: [...unsupported] };
}

/** Allowlist one already-normalized entry; unknown fields and values fail closed. */
export function canonicalOpencodeMetadata(value: unknown): OpencodeMetadata | undefined {
  const item = asRecord(value);
  if (!item) return undefined;
  if (Object.keys(item).some((key) => ![
    'id', 'name', 'apis', 'recommended', 'reasoningField', 'context', 'maxOutput',
    'images', 'tools', 'reasoning', 'thinking', 'temperature', 'cost',
  ].includes(key))) return undefined;
  if (!identifier(item.id) || !label(item.name) || !positiveInteger(item.context) || !positiveInteger(item.maxOutput) ||
      item.maxOutput > item.context || typeof item.images !== 'boolean' || typeof item.tools !== 'boolean' ||
      typeof item.reasoning !== 'boolean' || typeof item.temperature !== 'boolean') return undefined;
  if (!Array.isArray(item.apis) || item.apis.length > PROTOCOLS.length) return undefined;
  const apis: OpencodeProtocol[] = [];
  for (const entry of item.apis) {
    if (typeof entry !== 'string' || indexOfProtocol(entry) < 0 || apis.includes(entry as OpencodeProtocol)) return undefined;
    apis.push(entry as OpencodeProtocol);
  }
  apis.sort((left, right) => indexOfProtocol(left) - indexOfProtocol(right));
  const recommended = item.recommended;
  if (recommended !== undefined && (typeof recommended !== 'string' ||
      !apis.includes(recommended as OpencodeProtocol))) return undefined;
  if (item.reasoningField !== undefined && item.reasoningField !== 'reasoning_content') return undefined;
  const thinking = item.thinking === undefined ? undefined : canonicalThinking(item.thinking);
  if (item.thinking !== undefined && thinking === undefined) return undefined;
  const cost = canonicalCost(item.cost);
  if (!cost) return undefined;
  return {
    id: item.id,
    name: item.name,
    apis,
    ...(recommended === undefined ? {} : { recommended: recommended as OpencodeProtocol }),
    ...(item.reasoningField === undefined ? {} : { reasoningField: 'reasoning_content' }),
    context: item.context,
    maxOutput: item.maxOutput,
    images: item.images,
    tools: item.tools,
    reasoning: item.reasoning,
    ...(thinking === undefined ? {} : { thinking }),
    temperature: item.temperature,
    cost,
  };
}

function canonicalThinking(value: unknown): ThinkingLevelMap | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (Object.keys(record).some((key) => !(MODEL_THINKING_LEVELS as readonly string[]).includes(key))) return undefined;
  const map: ThinkingLevelMap = {};
  for (const level of MODEL_THINKING_LEVELS) {
    const wire = record[level];
    if (wire !== null && (typeof wire !== 'string' || wire.length === 0 || wire.length > 32 || /[\u0000-\u001f\u007f]/u.test(wire))) {
      return undefined;
    }
    map[level] = wire as string | null;
  }
  return map;
}

function canonicalCost(value: unknown): ModelCost | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (Object.keys(record).some((key) => !['input', 'output', 'cacheRead', 'cacheWrite', 'tiers'].includes(key))) return undefined;
  const input = rate(record.input);
  const output = rate(record.output);
  const cacheRead = rate(record.cacheRead);
  const cacheWrite = rate(record.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  if (record.tiers === undefined) return { input, output, cacheRead, cacheWrite };
  if (!Array.isArray(record.tiers) || record.tiers.length === 0 || record.tiers.length > MAX_TIERS) return undefined;
  const tiers: NonNullable<ModelCost['tiers']> = [];
  let previous = -1;
  for (const raw of record.tiers) {
    const tier = asRecord(raw);
    if (!tier || Object.keys(tier).some((key) => !['inputTokensAbove', 'input', 'output', 'cacheRead', 'cacheWrite'].includes(key))) {
      return undefined;
    }
    if (!positiveInteger(tier.inputTokensAbove) || tier.inputTokensAbove <= previous) return undefined;
    const tierInput = rate(tier.input);
    const tierOutput = rate(tier.output);
    const tierRead = rate(tier.cacheRead);
    const tierWrite = rate(tier.cacheWrite);
    if (tierInput === undefined || tierOutput === undefined || tierRead === undefined || tierWrite === undefined) return undefined;
    previous = tier.inputTokensAbove;
    tiers.push({ inputTokensAbove: tier.inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierRead, cacheWrite: tierWrite });
  }
  return { input, output, cacheRead, cacheWrite, tiers };
}
