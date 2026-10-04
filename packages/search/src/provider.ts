import { randomUUID } from 'node:crypto';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web';
import { trustedCopilotOrigin } from './endpoint.js';
import { authError, responseError, searchError } from './errors.js';
import { parseResponsesJSON, ResponsesSSEParser } from './responses.js';
import type { CopilotSearchOptions, ResolvedCopilotAuth } from './types.js';

export const COPILOT_SEARCH_PROVIDER_ID = 'github-copilot-search';
const IDENTITY_HEADERS = new Set(['user-agent', 'editor-version', 'editor-plugin-version', 'copilot-integration-id']);

function valid(options: CopilotSearchOptions): boolean {
  return typeof options.model === 'string' && options.model.trim() === options.model && !!options.model
    && options.model.length <= 256 && !/[\u0000-\u0020\u007f-\u009f]/u.test(options.model)
    && Number.isSafeInteger(options.maxTokens) && options.maxTokens >= 16 && options.maxTokens <= 65536
    && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= 120000
    && Number.isSafeInteger(options.maxResponseBytes) && options.maxResponseBytes >= 1024 && options.maxResponseBytes <= 16777216
    && typeof options.includeSources === 'boolean' && typeof options.forceSearch === 'boolean'
    && ['default', 'live', 'cached'].includes(options.searchMode)
    && typeof options.resolveAuth === 'function'
    && (options.fetcher === undefined || typeof options.fetcher === 'function');
}
function snapshot(getOptions: () => CopilotSearchOptions): CopilotSearchOptions | undefined {
  try {
    const options = { ...getOptions() };
    return valid(options) ? options : undefined;
  } catch { return; }
}

function headers(auth: ResolvedCopilotAuth): Headers {
  if (typeof auth.apiKey !== 'string' || !auth.apiKey.trim() || auth.apiKey.length > 16384
    || /[\u0000-\u0020\u007f-\u009f]/u.test(auth.apiKey)) throw searchError('WEB_PROVIDER_AUTH_INVALID');
  const result = new Headers();
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (!IDENTITY_HEADERS.has(key.toLowerCase())) continue;
    // Reject unsafe values in recognized identity fields. Unrecognized fields never dispatch.
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[^\x20-\x7e]/u.test(value)) {
      throw searchError('WEB_PROVIDER_AUTH_INVALID');
    }
    result.set(key, value);
  }
  result.set('Authorization', `Bearer ${auth.apiKey}`);
  result.set('Content-Type', 'application/json');
  result.set('Accept', 'text/event-stream, application/json');
  result.set('X-Initiator', 'agent');
  result.set('Openai-Intent', 'conversation-edits');
  result.set('X-GitHub-Api-Version', '2026-06-01');
  result.set('X-Request-Id', randomUUID());
  return result;
}
function quietlyCancel(body: ReadableStream<Uint8Array> | null | undefined): void {
  try { void body?.cancel().catch(() => {}); } catch { /* cleanup cannot replace the public error */ }
}

/** One bounded lifetime covers preflight, credentials, fetch, and all body reads. */
class Lifetime {
  readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private stopCode?: 'WEB_ABORTED' | 'WEB_TIMEOUT';
  private readonly onCallerAbort = () => this.stop('WEB_ABORTED');
  private readonly deadline: number;
  constructor(timeoutMs: number, private readonly caller?: AbortSignal, startedAt = Date.now()) {
    this.deadline = startedAt + timeoutMs;
    caller?.addEventListener('abort', this.onCallerAbort, { once: true });
    this.timer = setTimeout(() => this.stop('WEB_TIMEOUT'), Math.max(0, this.deadline - Date.now()));
    if (caller?.aborted) this.onCallerAbort();
  }
  private stop(code: 'WEB_ABORTED' | 'WEB_TIMEOUT'): void {
    if (this.stopCode) return;
    this.stopCode = code;
    this.controller.abort(searchError(code));
  }
  private failure(): ReturnType<typeof searchError> {
    return searchError(this.stopCode ?? 'WEB_ABORTED');
  }
  check(): void {
    if (!this.stopCode && Date.now() >= this.deadline) this.stop('WEB_TIMEOUT');
    if (this.controller.signal.aborted) throw this.failure();
  }
  wait<T>(operation: () => T | PromiseLike<T>, onLate?: (value: T) => void): Promise<T> {
    this.check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const signal = this.controller.signal;
      const onAbort = () => {
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(this.failure());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Deferred invocation prevents dispatch if cancellation wins before the operation starts.
      Promise.resolve().then(() => { this.check(); return operation(); }).then(value => {
        signal.removeEventListener('abort', onAbort);
        if (settled || signal.aborted) {
          try { onLate?.(value); } catch { /* best effort cleanup */ }
          if (!settled) reject(this.failure());
          return;
        }
        settled = true;
        resolve(value);
      }, error => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) { settled = true; reject(signal.aborted ? this.failure() : error); }
        // The rejection handler remains attached even after cancellation wins.
      });
      if (signal.aborted) onAbort();
    });
  }
  close(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.onCallerAbort);
  }
}

export class CopilotSearchProvider implements WebSearchProvider {
  readonly id = COPILOT_SEARCH_PROVIDER_ID;
  constructor(private readonly getOptions: () => CopilotSearchOptions) {}
  available(): boolean { return snapshot(this.getOptions) !== undefined; }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const startedAt = Date.now();
    if (signal?.aborted) throw searchError('WEB_ABORTED');
    const options = snapshot(this.getOptions);
    if (!options) throw searchError('WEB_INVALID_CONFIG');
    if (!request || typeof request.query !== 'string' || !request.query.trim()) throw searchError('WEB_INVALID_REQUEST');
    const query = request.query;
    const life = new Lifetime(options.timeoutMs, signal, startedAt);
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      let auth: ResolvedCopilotAuth | undefined;
      try { auth = await life.wait(() => options.resolveAuth(life.controller.signal)); }
      catch (error) { life.check(); throw authError(error); }
      life.check();
      if (!auth) throw searchError('WEB_PROVIDER_CREDENTIAL_MISSING');
      // Validate immediately before dispatch, even when an injected resolver claims validation.
      let origin: string;
      try { origin = trustedCopilotOrigin(auth.baseUrl); }
      catch { throw searchError('WEB_PROVIDER_ENDPOINT_UNTRUSTED'); }
      const requestHeaders = headers(auth);
      const tool = { type: 'web_search', ...(options.searchMode === 'default' ? {} : { external_web_access: options.searchMode === 'live' }) };
      const body = JSON.stringify({
        model: options.model,
        input: `Perform a web search for this query and return a concise grounded answer:\n\n${query}`,
        tools: [tool],
        max_output_tokens: options.maxTokens,
        store: false,
        stream: true,
        ...(options.includeSources ? { include: ['web_search_call.action.sources'] } : {}),
        ...(options.forceSearch ? { tool_choice: 'required' } : {}),
      });
      life.check();
      try {
        response = await life.wait(() => (options.fetcher ?? globalThis.fetch)(`${origin}/responses`, {
          method: 'POST', headers: requestHeaders, body, signal: life.controller.signal, redirect: 'error',
        }), late => quietlyCancel(late.body));
      } catch { life.check(); throw searchError('WEB_NETWORK_ERROR'); }
      life.check();
      if (!response.ok) {
        throw searchError([400, 404, 422].includes(response.status) ? 'WEB_PROVIDER_UNSUPPORTED' : 'WEB_HTTP_ERROR');
      }
      if (!response.body) throw searchError('WEB_INVALID_RESPONSE');
      const length = response.headers.get('content-length');
      if (length && /^\d+$/u.test(length) && Number(length) > options.maxResponseBytes) throw searchError('WEB_RESPONSE_TOO_LARGE');
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'text/event-stream' && contentType !== 'application/json' && !contentType?.endsWith('+json')) {
        throw searchError('WEB_INVALID_RESPONSE');
      }
      const parser = contentType === 'text/event-stream' ? new ResponsesSSEParser({ maxResponseBytes: options.maxResponseBytes }) : undefined;
      const chunks: Uint8Array[] = [];
      let byteCount = 0;
      reader = response.body.getReader();
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await life.wait(() => reader!.read()); }
        catch { life.check(); throw searchError('WEB_NETWORK_ERROR'); }
        life.check();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw searchError('WEB_INVALID_RESPONSE');
        byteCount += chunk.value.byteLength;
        if (byteCount > options.maxResponseBytes) throw searchError('WEB_RESPONSE_TOO_LARGE');
        if (parser) parser.push(chunk.value);
        else chunks.push(chunk.value);
      }
      life.check();
      let result: WebSearchResult;
      if (parser) result = parser.finish();
      else {
        const bytes = new Uint8Array(byteCount);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        result = parseResponsesJSON(bytes, options.maxResponseBytes);
      }
      life.check();
      // maxResults is intentionally owned and enforced by the DSH web seam.
      return result;
    } catch (error) {
      life.check();
      throw responseError(error);
    } finally {
      life.close();
      if (reader) {
        try {
          const held = reader;
          void held.cancel().catch(() => {}).finally(() => { try { held.releaseLock(); } catch { /* pending read */ } });
        } catch { /* cleanup must be prompt, even with an uncooperative stream */ }
        try { reader.releaseLock(); } catch { /* cancel settlement releases the lock */ }
      } else {
        try { quietlyCancel(response?.body); } catch { /* hostile body getters cannot escape cleanup */ }
      }
    }
  }
}
