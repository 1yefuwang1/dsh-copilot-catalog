import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { installCopilotIdentityHeaders, type CopilotWireIdentity } from '../../dist/identity.js';
import { transportResponse } from '../transport-fixtures.js';

const AUTHORIZATION = 'test-access-token';

const IDENTITY: CopilotWireIdentity = Object.freeze({
  mode: 'full',
  userAgent: 'GitHubCopilotChat/0.68.0',
  editorVersion: 'vscode/1.140.0',
  editorPluginVersion: 'copilot-chat/0.68.0',
  copilotIntegrationId: 'vscode-chat',
  githubApiVersion: '2026-08-01',
  userAgentLibraryVersion: 'electron-fetch',
  editorDeviceId: '11111111-1111-4111-8111-111111111111',
  machineId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
});

const MODEL_BASE = {
  id: 'synthetic-model',
  name: 'Synthetic',
  provider: 'github-copilot',
  baseUrl: 'https://api.individual.githubcopilot.com',
  contextWindow: 100_000,
  maxTokens: 1024,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  headers: {
    'User-Agent': 'GitHubCopilotChat/0.35.0',
    'Editor-Version': 'vscode/1.107.0',
    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'anthropic-beta': 'synthetic-beta',
  },
};

type StreamOptions = Parameters<ReturnType<typeof openAICompletionsApi>['stream']>[2];

interface CapturedRequest {
  readonly url: string;
  readonly pathname: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
}

let captured: CapturedRequest[] = [];

const apiForPath = (pathname: string): string => {
  if (pathname === '/responses') return 'openai-responses';
  if (pathname === '/chat/completions') return 'openai-completions';
  if (pathname === '/v1/messages') return 'anthropic-messages';
  return 'openai-responses';
};

const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? init.body : undefined;
  captured.push({ url: url.href, pathname: url.pathname, method: init?.method, headers, body });
  if (url.pathname === '/models') return Response.json({ data: [] });
  const parsed = body === undefined ? undefined : JSON.parse(body) as { model?: string };
  return transportResponse(apiForPath(url.pathname), parsed?.model ?? 'synthetic-model');
}) as typeof fetch;

async function withInterceptor(operation: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  captured = [];
  globalThis.fetch = stub;
  const release = installCopilotIdentityHeaders(IDENTITY);
  try {
    await operation();
  } finally {
    release();
    globalThis.fetch = original;
  }
}

const options = (): StreamOptions => ({
  apiKey: AUTHORIZATION,
  headers: { 'user-agent': 'deepseek-harness/test' },
});

const context = () => normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [] });

function assertIdentity(headers: Headers): void {
  assert.equal(headers.get('user-agent'), IDENTITY.userAgent);
  assert.equal(headers.get('editor-version'), IDENTITY.editorVersion);
  assert.equal(headers.get('editor-plugin-version'), IDENTITY.editorPluginVersion);
  assert.equal(headers.get('copilot-integration-id'), IDENTITY.copilotIntegrationId);
  assert.equal(headers.get('editor-device-id'), IDENTITY.editorDeviceId);
  assert.equal(headers.get('vscode-machineid'), IDENTITY.machineId);
  assert.equal(headers.get('vscode-sessionid'), IDENTITY.sessionId);
  assert.equal(headers.get('x-vscode-user-agent-library-version'), IDENTITY.userAgentLibraryVersion);
  assert.equal([...headers.keys()].some((name) => name.startsWith('x-stainless-')), false);
}

test('all three pi-ai Copilot transports carry the identity without Stainless fingerprints', async () => {
  await withInterceptor(async () => {
    const completionsModel = { ...MODEL_BASE, api: 'openai-completions' } as unknown as Parameters<ReturnType<typeof openAICompletionsApi>['stream']>[0];
    for await (const _ of openAICompletionsApi().stream(completionsModel, context(), options())) { /* drain */ }

    const responsesModel = { ...MODEL_BASE, api: 'openai-responses' } as unknown as Parameters<ReturnType<typeof openAIResponsesApi>['stream']>[0];
    for await (const _ of openAIResponsesApi().stream(responsesModel, context(), options())) { /* drain */ }

    const messagesModel = { ...MODEL_BASE, api: 'anthropic-messages' } as unknown as Parameters<ReturnType<typeof anthropicMessagesApi>['stream']>[0];
    for await (const _ of anthropicMessagesApi().stream(messagesModel, context(), options())) { /* drain */ }
  });

  assert.equal(captured.length, 3);
  for (const request of captured) {
    assertIdentity(request.headers);
    assert.equal(request.headers.get('authorization'), `Bearer ${AUTHORIZATION}`);
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.equal(request.headers.get('x-github-api-version'), '2026-08-01');
    assert.equal(request.headers.get('openai-intent'), 'conversation-edits');
    assert.equal(request.headers.get('x-interaction-type'), 'conversation-edits');
    assert.equal(request.headers.get('x-initiator'), 'user');
    assert.match(request.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/iu);
    assert.equal(request.headers.get('x-agent-task-id'), request.headers.get('x-request-id'));
  }
  const messages = captured.find((request) => request.pathname === '/v1/messages');
  assert.ok(messages);
  assert.equal(messages.headers.get('anthropic-version'), '2023-06-01');
  assert.match(messages.headers.get('anthropic-beta') ?? '', /synthetic-beta/u);
  assert.equal(messages.headers.get('anthropic-dangerous-direct-browser-access'), null);
});

test('search-style API version and intent pins survive', async () => {
  await withInterceptor(async () => {
    await globalThis.fetch('https://api.individual.githubcopilot.com/responses', {
      method: 'POST',
      headers: {
        Authorization: AUTHORIZATION,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        'X-Initiator': 'agent',
        'Openai-Intent': 'conversation-edits',
        'X-GitHub-Api-Version': '2026-06-01',
        'X-Request-Id': 'caller-request',
        'X-Stainless-Lang': 'js',
      },
      body: '{"input":"synthetic-search"}',
    });
  });
  const request = captured[0]!;
  assertIdentity(request.headers);
  assert.equal(request.headers.get('x-github-api-version'), '2026-06-01');
  assert.equal(request.headers.get('openai-intent'), 'conversation-edits');
  assert.equal(request.headers.get('x-interaction-type'), 'conversation-edits');
  assert.equal(request.headers.get('x-initiator'), 'agent');
  assert.equal(request.headers.get('x-request-id'), 'caller-request');
  assert.equal(request.headers.get('x-agent-task-id'), 'caller-request');
  assert.equal(request.headers.get('authorization'), AUTHORIZATION);
  assert.equal(request.headers.get('accept'), 'text/event-stream, application/json');
});

test('model discovery uses model-access and removes request-only headers', async () => {
  await withInterceptor(async () => {
    await globalThis.fetch('https://api.individual.githubcopilot.com/models', {
      headers: {
        Authorization: AUTHORIZATION,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-06-01',
        'X-Interaction-Id': 'caller-interaction',
        'X-Stainless-Lang': 'js',
      },
    });
  });
  const request = captured[0]!;
  assertIdentity(request.headers);
  assert.equal(request.headers.get('x-github-api-version'), '2026-06-01');
  assert.equal(request.headers.get('openai-intent'), 'model-access');
  assert.equal(request.headers.get('x-interaction-type'), 'model-access');
  assert.equal(request.headers.get('content-type'), null);
  assert.equal(request.headers.get('x-interaction-id'), null);
  assert.equal(request.headers.get('authorization'), AUTHORIZATION);
});

test('non-Copilot and boundary-negative paths pass through unchanged', async () => {
  await withInterceptor(async () => {
    for (const url of [
      'https://api.github.com/user',
      'https://api.individual.githubcopilot.com/models-telemetry',
      'https://api.individual.githubcopilot.com/responsesXYZ',
    ]) {
      await globalThis.fetch(url, { headers: { 'User-Agent': 'deepseek-harness/test', 'X-Stainless-Lang': 'js' } });
    }
  });
  assert.equal(captured.length, 3);
  for (const request of captured) {
    assert.equal(request.headers.get('user-agent'), 'deepseek-harness/test');
    assert.equal(request.headers.get('x-stainless-lang'), 'js');
  }
});
