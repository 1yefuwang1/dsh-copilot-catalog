import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { normalizeToolSchemas } from '../../dist/index.js';
import * as fixtures from '../fixtures.js';

type StreamArgs = Parameters<ReturnType<typeof openAICompletionsApi>['stream']>;

const MODEL = {
  id: 'gemini-4-argon', name: 'Gemini', api: 'openai-completions', provider: 'github-copilot',
  baseUrl: 'https://example.test', contextWindow: 128000, maxTokens: 1024, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
  headers: { 'User-Agent': 'GitHubCopilotChat/0.35.0', 'Editor-Version': 'vscode/1.107.0' },
} as unknown as StreamArgs[0];

const SSE = 'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
  + 'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
  + 'data: [DONE]\n\n';

interface SerializedTool { type: string; function: { name: string; parameters: Record<string, unknown> } }
interface Captured {
  url: string;
  body: { model?: string; stream?: boolean; messages?: unknown[]; tools?: SerializedTool[] };
  headers: Record<string, string>;
}

async function capture(list: readonly fixtures.FixtureTool[], guard: boolean): Promise<Captured> {
  let captured: Captured | undefined;
  const fetcher = async (url: unknown, init: { body?: string; headers?: HeadersInit }) => {
    captured = {
      url: String(url),
      body: JSON.parse(init.body ?? '{}') as Captured['body'],
      headers: Object.fromEntries(new Headers(init.headers ?? {}).entries()),
    };
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  // Synthetic transport: the key is a placeholder length that cannot be mistaken for a credential.
  const tools = guard ? normalizeToolSchemas(fixtures.tools(list)).tools : fixtures.tools(list);
  const stream = openAICompletionsApi().stream(MODEL, normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools }), { apiKey: 'unused', fetch: fetcher as unknown as typeof fetch });
  try { for await (const _chunk of stream) { /* drain the synthetic stream */ } } catch { /* the captured request is what matters */ }
  assert.ok(captured, 'the transport must reach the intercepted fetch');
  return captured;
}

const hasBucket = (parameters: unknown): boolean => parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)
  && (parameters as { type?: unknown }).type === 'object'
  && (parameters as { properties?: unknown }).properties !== null
  && typeof (parameters as { properties?: unknown }).properties === 'object'
  && !Array.isArray((parameters as { properties?: unknown }).properties);

test('the guard makes every emitted chat/completions tool declare a properties bucket', async () => {
  const normalized = normalizeToolSchemas(fixtures.tools([fixtures.missingBucketTool, fixtures.conformantTool])).tools;
  const captured = await capture([fixtures.missingBucketTool, fixtures.conformantTool], true);
  assert.equal(captured.url, 'https://example.test/chat/completions');
  assert.equal(captured.body.model, 'gemini-4-argon');
  assert.equal(captured.body.stream, true);
  assert.equal(JSON.stringify(captured.body.messages).includes('hi'), true);
  const tools = captured.body.tools ?? [];
  assert.equal(tools.length, normalized.length);
  for (const tool of tools) assert.equal(tool.type, 'function');
  assert.ok(tools.every(tool => hasBucket(tool.function.parameters)));
  assert.equal(tools[0]!.function.name, 'workspace_project');
  assert.deepEqual(tools[0]!.function.parameters.properties, {});
  assert.deepEqual(tools[1]!.function.parameters.properties, fixtures.conformantTool.parameters!.properties);
  assert.equal(captured.headers['user-agent'], 'GitHubCopilotChat/0.35.0');
  assert.equal(captured.headers['editor-version'], 'vscode/1.107.0');
});

test('negative control: the same declarations without the guard reach the wire without a bucket', async () => {
  const captured = await capture([fixtures.missingBucketTool, fixtures.conformantTool], false);
  const tools = captured.body.tools ?? [];
  assert.equal(tools.length, 2);
  assert.equal(hasBucket(tools[0]!.function.parameters), false);
  assert.equal(hasBucket(tools[1]!.function.parameters), true);
});
