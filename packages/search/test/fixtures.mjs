// Synthetic-only fixtures: never consult a live API, environment secret, or credential store.
export const syntheticAuth = () => ({
  apiKey: 'synthetic-token',
  baseUrl: 'https://api.githubcopilot.com',
  headers: {
    'User-Agent': 'GitHubCopilotChat/fixture',
    'Editor-Version': 'vscode/fixture',
    'Editor-Plugin-Version': 'copilot-chat/fixture',
    'Copilot-Integration-Id': 'vscode-chat',
  },
});
export const nativeCall = (sources = []) => ({
  type: 'web_search_call', id: 'search-fixture', status: 'completed',
  action: { type: 'search', query: 'synthetic query', sources },
});
export const message = (text = 'Synthetic answer', annotations = []) => ({
  type: 'message', id: 'message-fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations }],
});
export const completed = (output = [nativeCall([{ url: 'https://example.test/source' }]), message()]) => ({
  id: 'response-fixture', object: 'response', status: 'completed', output,
});
export const sseEvent = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
export const sseCompleted = value => sseEvent({ type: 'response.completed', response: value ?? completed() }) + 'data: [DONE]\n\n';
export const jsonResponse = (value = completed()) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export const sseResponse = (value = sseCompleted()) => new Response(value, { headers: { 'content-type': 'text/event-stream' } });
export function options(overrides = {}) {
  return {
    model: 'gpt-6.1-sol', maxTokens: 4096, timeoutMs: 1000, maxResponseBytes: 2 * 1024 * 1024,
    includeSources: true, searchMode: 'default', forceSearch: false,
    resolveAuth: async () => syntheticAuth(), fetcher: async () => jsonResponse(),
    ...overrides,
  };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const encoded = value => new TextEncoder().encode(value);
export function controlledBody(initial) {
  let controller;
  let cancellations = 0;
  const stream = new ReadableStream({
    start(value) { controller = value; if (initial) value.enqueue(encoded(initial)); },
    cancel() { cancellations++; },
  });
  return { stream, controller, get cancellations() { return cancellations; } };
}
export function captureOptions(overrides = {}) {
  const requests = [];
  return {
    requests,
    config: options({ fetcher: async (url, init) => { requests.push({ url, init }); return jsonResponse(); }, ...overrides }),
  };
}
export function errorCode(code) {
  return error => {
    if (error?.code !== code) throw new Error(`Expected ${code}, received ${error?.code}`);
    return true;
  };
}
