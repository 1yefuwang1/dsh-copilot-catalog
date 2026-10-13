import type { CopilotSearchOptions, ResolvedCopilotAuth } from '../dist/types.js';

/** Responses wire payloads are not trusted; malformed fields remain representable. */
export interface WireSource { url: string; title?: string; snippet?: string; publishedAt?: string }
export interface WireCitation { type: string; url: string; title?: string; start_index: number; end_index: number }
export interface WireItem { type: string; [key: string]: unknown }
export interface WireEvent { type: string; [key: string]: unknown }
export interface HttpRequestInit extends RequestInit { headers: Headers; signal: AbortSignal }
export interface SearchRequestInit extends HttpRequestInit { body: string }
export interface CapturedRequest { url: string; init: SearchRequestInit }
export type SearchFetcher = (url: string, init: SearchRequestInit) => Promise<unknown>;
export type OptionOverrides = Partial<Omit<CopilotSearchOptions, 'fetcher' | 'resolveAuth' | 'searchMode' | 'includeSources' | 'forceSearch'>> & {
  fetcher?: SearchFetcher | object;
  resolveAuth?: (signal: AbortSignal) => Promise<unknown>;
  searchMode?: unknown; includeSources?: unknown; forceSearch?: unknown;
};
/** The constructor validates configuration at runtime. Negative tests deliberately
 * supply malformed flags and partial/hostile fetch or auth dependency doubles. */
export type FixtureOptions = CopilotSearchOptions;

// Synthetic-only fixtures: never consult a live API, environment secret, or credential store.
export const syntheticAuth = (): ResolvedCopilotAuth => ({
  apiKey: 'synthetic-token',
  baseUrl: 'https://api.githubcopilot.com',
  headers: {
    'User-Agent': 'GitHubCopilotChat/fixture',
    'Editor-Version': 'vscode/fixture',
    'Editor-Plugin-Version': 'copilot-chat/fixture',
    'Copilot-Integration-Id': 'vscode-chat',
  },
});
export const nativeCall = (sources: WireSource[] = []) => ({
  type: 'web_search_call', id: 'search-fixture', status: 'completed',
  action: { type: 'search', query: 'synthetic query', sources },
});
export const message = (text = 'Synthetic answer', annotations: WireCitation[] = []) => ({
  type: 'message', id: 'message-fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations }],
});
export const completed = (output: WireItem[] = [nativeCall([{ url: 'https://example.test/source' }]), message()]) => ({
  id: 'response-fixture', object: 'response', status: 'completed', output,
});
export const sseEvent = (event: WireEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
export const sseCompleted = (value?: unknown) => sseEvent({ type: 'response.completed', response: value ?? completed() }) + 'data: [DONE]\n\n';
export const jsonResponse = (value: unknown = completed()) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export const sseResponse = (value = sseCompleted()) => new Response(value, { headers: { 'content-type': 'text/event-stream' } });
export function options(overrides: OptionOverrides = {}): FixtureOptions {
  return {
    model: 'gpt-6.1-sol', maxTokens: 4096, timeoutMs: 1000, maxResponseBytes: 2 * 1024 * 1024,
    includeSources: true, searchMode: 'default', forceSearch: false,
    resolveAuth: async () => syntheticAuth(), fetcher: async () => jsonResponse(),
    ...overrides,
  } as FixtureOptions;
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
export const encoded = (value: string) => new TextEncoder().encode(value);
export function controlledBody(initial?: string) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; if (initial) value.enqueue(encoded(initial)); },
    cancel() { cancellations++; },
  });
  return { stream, controller, get cancellations() { return cancellations; } };
}
export function captureOptions(overrides: OptionOverrides = {}) {
  const requests: CapturedRequest[] = [];
  return {
    requests,
    config: options({ fetcher: async (url, init) => { requests.push({ url, init }); return jsonResponse(); }, ...overrides }),
  };
}
export function errorCode(code: string) {
  return (error: unknown) => {
    const actual = error instanceof Error && 'code' in error ? error.code : undefined;
    if (actual !== code) throw new Error(`Expected ${code}, received ${actual}`);
    return true;
  };
}

/** Adapt synthetic, sometimes hostile HTTP doubles at the injected fetch boundary.
 * Production calls provide a string URL, Headers, signal, and (for search) JSON body. */
export function mockFetch<I extends HttpRequestInit = SearchRequestInit>(fetcher: (url: string, init: I) => Promise<unknown>): typeof fetch {
  return fetcher as unknown as typeof fetch;
}
export interface SearchBody {
  model: string; input?: string; tools: { type: string; external_web_access?: boolean }[];
  max_output_tokens?: number; tool_choice?: string; include?: string[];
}
