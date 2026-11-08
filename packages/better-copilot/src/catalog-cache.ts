import { createHash } from 'node:crypto';
import { asRecord, type CatalogCacheEntry, type CatalogCacheScope, type CopilotGrant, type CredentialKey } from './catalog-types.js';

export const CATALOG_CACHE_VERSION = 1;
/** Offline availability is useful, but an old account allowlist is not authoritative forever. */
export const CATALOG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const CATALOG_CACHE_MAX_MODELS = 512;
export const CATALOG_CACHE_MAX_BYTES = 512 * 1024;
const MAX_STRING = 256;
const ENDPOINTS = new Set(['/responses', '/chat/completions', '/v1/messages']);
const EFFORTS = new Set(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function trustedOrigin(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return endpoint === url.origin && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname.endsWith('.githubcopilot.com') ||
        /^copilot-api\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/u.test(url.hostname));
  } catch { return false; }
}

function validScope(scope: CatalogCacheScope): boolean {
  return typeof scope.accountKey === 'string' && /^[a-f0-9]{64}$/u.test(scope.accountKey) &&
    typeof scope.endpoint === 'string' && trustedOrigin(scope.endpoint);
}

/** Never persist this input: only the digest leaves this function. OAuth access tokens are deliberately ignored. */
export function catalogCacheScope(recordKey: CredentialKey, endpoint: string,
  identity: { credential: CopilotGrant } | { apiKey: string }): CatalogCacheScope {
  if (!trustedOrigin(endpoint)) throw new TypeError('Invalid Copilot cache endpoint');
  const parts = 'credential' in identity
    ? ['oauth', recordKey, identity.credential.refresh, identity.credential.enterpriseUrl ?? '', endpoint]
    : ['api-key', recordKey, identity.apiKey, endpoint];
  return { accountKey: createHash('sha256').update(JSON.stringify(parts)).digest('hex'), endpoint };
}

function record(value: unknown): Record<string, unknown> | undefined {
  const result = asRecord(value);
  if (!result) return undefined;
  const prototype: unknown = Object.getPrototypeOf(result);
  return prototype === Object.prototype || prototype === null ? result : undefined;
}

function text(value: unknown, forbiddenValues: readonly string[] = []): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/(?:gh[opusr]_|github_pat_|bearer\s|(?:^|;)proxy-ep=)/iu.test(value) &&
    !forbiddenValues.some((secret) => secret.length > 0 && (value === secret || secret.length >= 8 && value.includes(secret)));
}

function numericFields(value: unknown, fields: readonly string[]): Record<string, number> | undefined {
  const source = record(value);
  if (!source) return undefined;
  const output: Record<string, number> = {};
  for (const field of fields) {
    const number = source[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) output[field] = number;
  }
  return output;
}

/** Allowlist only /models selection metadata. No arbitrary nested objects, headers, URLs, credentials or token strings. */
export function sanitizeCatalogMetadata(value: unknown, forbiddenValues: readonly string[] = []): CatalogCacheEntry['raw'] | undefined {
  const data = record(value)?.data;
  if (!Array.isArray(data) || data.length === 0 || data.length > CATALOG_CACHE_MAX_MODELS) return undefined;
  const output: Record<string, unknown>[] = [];
  for (const raw of data) {
    const item = record(raw);
    if (!item || !text(item.id, forbiddenValues) || /\s/u.test(item.id)) continue;
    const copy: Record<string, unknown> = { id: item.id };
    if (text(item.name, forbiddenValues)) copy.name = item.name;
    if (typeof item.model_picker_enabled === 'boolean') copy.model_picker_enabled = item.model_picker_enabled;
    const policy = record(item.policy);
    if (policy?.state !== undefined) {
      // Unknown states remain disabled, without storing arbitrary provider text.
      copy.policy = { state: policy.state === 'enabled' ? 'enabled' : 'disabled' };
    }
    if (Array.isArray(item.supported_endpoints)) {
      if (item.supported_endpoints.length > 32) return undefined;
      copy.supported_endpoints = [...new Set(item.supported_endpoints.filter((entry): entry is string =>
        typeof entry === 'string' && ENDPOINTS.has(entry)))];
    }
    const capabilities = record(item.capabilities);
    if (capabilities) {
      const cap: Record<string, unknown> = {};
      if (capabilities.type !== undefined) cap.type = capabilities.type === 'chat' ? 'chat' : 'unsupported';
      const limits = numericFields(capabilities.limits, ['max_context_window_tokens', 'max_output_tokens']);
      if (limits) cap.limits = limits;
      const supports = record(capabilities.supports);
      if (supports) {
        const flags: Record<string, unknown> = {};
        for (const flag of ['vision', 'tool_calls', 'streaming', 'thinking', 'temperature']) {
          if (typeof supports[flag] === 'boolean') flags[flag] = supports[flag];
        }
        if (Array.isArray(supports.reasoning_effort)) {
          if (supports.reasoning_effort.length > 32) return undefined;
          flags.reasoning_effort = [...new Set(supports.reasoning_effort.filter((entry): entry is string =>
            typeof entry === 'string' && EFFORTS.has(entry)))];
        }
        cap.supports = flags;
      }
      copy.capabilities = cap;
    }
    const prices = record(record(item.billing)?.token_prices);
    if (prices) {
      const billing: Record<string, unknown> = {};
      if (typeof prices.batch_size === 'number' && Number.isSafeInteger(prices.batch_size) && prices.batch_size > 0) billing.batch_size = prices.batch_size;
      for (const tier of ['default', 'long_context']) {
        const rates = numericFields(prices[tier], ['input_price', 'output_price', 'cache_price', 'cache_write_price', 'context_max']);
        if (rates) billing[tier] = rates;
      }
      copy.billing = { token_prices: billing };
    }
    output.push(copy);
  }
  const raw = { data: output };
  return output.length > 0 && Buffer.byteLength(JSON.stringify(raw), 'utf8') <= CATALOG_CACHE_MAX_BYTES ? raw : undefined;
}

export function createCatalogCacheEntry(scope: CatalogCacheScope, value: unknown, savedAt: number,
  forbiddenValues: readonly string[] = []): CatalogCacheEntry | undefined {
  const raw = sanitizeCatalogMetadata(value, forbiddenValues);
  if (!raw || !validScope(scope) || !Number.isSafeInteger(savedAt) || savedAt < 0) return undefined;
  return { version: CATALOG_CACHE_VERSION, accountKey: scope.accountKey, endpoint: scope.endpoint, savedAt, raw };
}

/** Reject foreign, future, stale, malformed or unsanitized records; return a detached copy. */
export function readCatalogCacheEntry(value: unknown, scope: CatalogCacheScope, now: number): CatalogCacheEntry | undefined {
  try {
    const entry = record(value);
    if (!entry || entry.version !== CATALOG_CACHE_VERSION || !validScope(scope) ||
        entry.accountKey !== scope.accountKey || entry.endpoint !== scope.endpoint ||
        !Number.isSafeInteger(entry.savedAt) || (entry.savedAt as number) < 0 || !Number.isSafeInteger(now) ||
        (entry.savedAt as number) > now || now - (entry.savedAt as number) > CATALOG_CACHE_MAX_AGE_MS ||
        Object.keys(entry).some((key) => !['version', 'accountKey', 'endpoint', 'savedAt', 'raw'].includes(key))) return undefined;
    const encoded = JSON.stringify(entry.raw);
    if (Buffer.byteLength(encoded, 'utf8') > CATALOG_CACHE_MAX_BYTES) return undefined;
    const raw = sanitizeCatalogMetadata(entry.raw);
    // The cache must already be an allowlisted document, not a bag of secrets we quietly strip on read.
    if (!raw || JSON.stringify(raw) !== encoded) return undefined;
    return { version: CATALOG_CACHE_VERSION, accountKey: scope.accountKey, endpoint: scope.endpoint,
      savedAt: entry.savedAt as number, raw };
  } catch { return undefined; }
}
