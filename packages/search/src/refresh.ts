import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { CopilotAuthError } from './auth.js';
import { trustedCopilotOrigin } from './endpoint.js';

const MAX_AUTH_BODY_BYTES = 1_048_576;
const IDENTITY_HEADERS = new Set(['user-agent', 'editor-version', 'editor-plugin-version', 'copilot-integration-id']);
type JsonObject = Record<string, unknown>;
function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new CopilotAuthError('aborted');
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[^\x21-\x7e]/u.test(value);
}
function cancel(body: ReadableStream<Uint8Array> | null | undefined): void {
  try { void body?.cancel().catch(() => {}); } catch { /* cleanup never exposes a dependency error */ }
}
function cancelResponse(response: Response): void {
  try { cancel(response.body); } catch { /* an injected response getter may throw */ }
}

/** A per-operation wait; cancellation cannot start a later request or leave a rejection unobserved. */
function wait<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  check(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new CopilotAuthError('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { check(signal); return operation(); }).then((value) => {
      signal.removeEventListener('abort', onAbort);
      if (settled || signal.aborted) {
        try { late?.(value); } catch { /* quiet cleanup */ }
        if (!settled) reject(new CopilotAuthError('aborted'));
        return;
      }
      settled = true;
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      if (!settled) { settled = true; reject(error); }
    });
    if (signal.aborted) onAbort();
  });
}

/** This authority comes only from the existing adapter-owned grant, never an HTTP response. */
function exchangeUrl(grant: OAuthCredential): string {
  const configured = grant.enterpriseUrl;
  const domain = configured === undefined || configured === null || configured === '' ? 'github.com' : configured;
  if (typeof domain !== 'string' || /[\u0000-\u0020\u007f-\u009f\\]/u.test(domain)) throw new CopilotAuthError('invalid');
  const value = domain.includes('://') ? domain : `https://${domain}`;
  const url = new URL(value);
  if (url.protocol !== 'https:' || /^https:\/\/[^/?#]*@/iu.test(value) || url.username || url.password ||
      url.port || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.') ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(url.hostname) || url.hostname.includes('..')) {
    throw new CopilotAuthError('invalid');
  }
  return `https://api.${url.hostname}/copilot_internal/v2/token`;
}
function headers(identity: Readonly<Record<string, string>>, token: string): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(identity)) {
    if (!IDENTITY_HEADERS.has(key.toLowerCase())) continue;
    if (!value || value.length > 1024 || /[^\x20-\x7e]/u.test(value)) throw new CopilotAuthError('invalid');
    result.set(key, value);
  }
  result.set('Accept', 'application/json');
  result.set('Authorization', `Bearer ${token}`);
  return result;
}
async function jsonRequest(url: string, requestHeaders: Headers, signal: AbortSignal, fetcher: typeof fetch): Promise<unknown> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await wait(() => fetcher(url, { method: 'GET', headers: requestHeaders, redirect: 'error', signal }), signal, cancelResponse);
    check(signal);
    if (!response.ok || response.redirected) throw new CopilotAuthError('failed');
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_AUTH_BODY_BYTES) throw new CopilotAuthError('failed');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json' && !contentType?.endsWith('+json') || !response.body) throw new CopilotAuthError('failed');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    while (true) {
      const chunk = await wait(() => reader!.read(), signal);
      check(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new CopilotAuthError('failed');
      count += chunk.value.byteLength;
      if (count > MAX_AUTH_BODY_BYTES) throw new CopilotAuthError('failed');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    check(signal);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    if (reader) {
      try {
        const held = reader;
        void held.cancel().catch(() => {}).finally(() => { try { held.releaseLock(); } catch { /* pending read */ } });
        held.releaseLock();
      } catch { /* cancellation/cleanup cannot replace a controlled failure */ }
    } else if (response) cancelResponse(response);
  }
}

/** Preserve pi-ai 0.87.1 refresh's picker/policy semantics without enabling any policy. */
function availableModelIds(value: unknown, origin: string): string[] {
  const data = record(value)?.data;
  if (!Array.isArray(data) || data.length > 4096) throw new CopilotAuthError('failed');
  const models = data.flatMap((item) => {
    const model = record(item);
    if (!model || typeof model.id !== 'string' || record(record(model.capabilities)?.supports)?.tool_calls === false) return [];
    return [{ id: model.id, picker: model.model_picker_enabled === true, policy: record(model.policy)?.state }];
  });
  const pickerIds = models.filter((model) => model.picker && model.policy !== 'disabled').map((model) => model.id);
  return pickerIds.length || origin !== 'https://api.individual.githubcopilot.com' ? pickerIds
    : models.filter((model) => model.policy === 'enabled').map((model) => model.id);
}

export interface CopilotRefreshDependencies {
  oauth: Pick<OAuthAuth, 'toAuth'>;
  headers: Readonly<Record<string, string>>;
  fetcher?: typeof globalThis.fetch;
}

/**
 * Search-owned refresh transport inside public Models.getAuth()'s unchanged lock.
 * The SDK's own refresh eagerly fetches /models at a response-derived origin before
 * returning; this implementation validates that origin BEFORE any bearer dispatch.
 * No login flow or private OAuth module is implemented/imported here.
 */
export function createSafeCopilotRefresh(dependencies: CopilotRefreshDependencies): OAuthAuth['refresh'] {
  return async (credential, signal) => {
    check(signal);
    try {
      const current = structuredClone(credential);
      if (current.type !== 'oauth' || !validToken(current.refresh) || !validToken(current.access)) throw new CopilotAuthError('invalid');
      const endpoint = exchangeUrl(current);
      const previousAuth = await wait(() => dependencies.oauth.toAuth(structuredClone(current)), signal);
      trustedCopilotOrigin(previousAuth.baseUrl);
      check(signal);
      const fetcher = dependencies.fetcher ?? globalThis.fetch;
      const body = record(await jsonRequest(endpoint, headers(dependencies.headers, current.refresh), signal, fetcher));
      check(signal);
      const token = body?.token;
      const expiresAt = body?.expires_at;
      if (!validToken(token) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) ||
          expiresAt <= 0 || expiresAt > Math.floor(Number.MAX_SAFE_INTEGER / 1000) || expiresAt * 1000 <= Date.now()) {
        throw new CopilotAuthError('invalid');
      }
      // Never adopt exchange response metadata as GitHub-domain or refresh-token authority.
      const refreshed: OAuthCredential = { ...current, type: 'oauth', access: token, expires: expiresAt * 1000 - 5 * 60_000 };
      const auth = await wait(() => dependencies.oauth.toAuth(structuredClone(refreshed)), signal);
      const origin = trustedCopilotOrigin(auth.baseUrl);
      if (auth.apiKey !== token) throw new CopilotAuthError('invalid');
      check(signal);
      const catalogHeaders = headers(dependencies.headers, token);
      catalogHeaders.set('X-GitHub-Api-Version', '2026-06-01');
      const catalog = await jsonRequest(`${origin}/models`, catalogHeaders, signal, fetcher);
      check(signal);
      const ids = availableModelIds(catalog, origin);
      check(signal);
      return { ...refreshed, availableModelIds: ids };
    } catch {
      check(signal);
      throw new CopilotAuthError('failed');
    }
  };
}
