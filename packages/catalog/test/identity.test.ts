import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createCopilotWireIdentity,
  installCopilotIdentityHeaders,
  isCopilotRequestPath,
  isTrustedCopilotUrl,
  machineIdFromMac,
  readStoredUuid,
  rewriteCopilotRequestHeaders,
  wireIdentityMode,
  type CopilotWireIdentity,
} from '../dist/identity.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const AUTHORIZATION = 'test-access-token';
const USERINFO_URL = ['https://', 'user', ':', 'pass', '@api.individual.githubcopilot.com/responses'].join('');

const FULL: CopilotWireIdentity = Object.freeze({
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

const BASIC: CopilotWireIdentity = Object.freeze({
  mode: 'basic',
  userAgent: 'GitHubCopilotChat/0.68.0',
  editorVersion: 'vscode/1.140.0',
  editorPluginVersion: 'copilot-chat/0.68.0',
  copilotIntegrationId: 'vscode-chat',
  githubApiVersion: '2026-08-01',
  userAgentLibraryVersion: 'electron-fetch',
});

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

function assertIdentityHeaders(current: Headers): void {
  assert.equal(current.get('user-agent'), FULL.userAgent);
  assert.equal(current.get('editor-version'), FULL.editorVersion);
  assert.equal(current.get('editor-plugin-version'), FULL.editorPluginVersion);
  assert.equal(current.get('copilot-integration-id'), FULL.copilotIntegrationId);
  assert.equal(current.get('editor-device-id'), FULL.editorDeviceId);
  assert.equal(current.get('vscode-machineid'), FULL.machineId);
  assert.equal(current.get('vscode-sessionid'), FULL.sessionId);
  assert.equal(current.get('x-vscode-user-agent-library-version'), FULL.userAgentLibraryVersion);
}

test('full inference rewrites identity, removes SDK headers, and preserves protocol and caller fields', () => {
  const requestHeaders = headers({
    authorization: AUTHORIZATION,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-initiator': 'agent',
    'copilot-vision-request': 'true',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'synthetic-beta',
    'x-github-api-version': '2026-06-01',
    'openai-intent': 'conversation-edits',
    'x-interaction-id': 'caller-interaction',
    'x-request-id': 'caller-request',
    'x-agent-task-id': 'caller-task',
    'x-stainless-lang': 'js',
    'x-stainless-timeout': '600',
    'openai-organization': 'caller-org',
    'openai-project': 'caller-project',
    'anthropic-dangerous-direct-browser-access': 'true',
  });
  const url = new URL('https://api.individual.githubcopilot.com/v1/messages?beta=true');
  assert.equal(rewriteCopilotRequestHeaders(url, requestHeaders, FULL), true);
  assertIdentityHeaders(requestHeaders);
  assert.equal(requestHeaders.get('x-github-api-version'), '2026-08-01');
  assert.equal(requestHeaders.get('openai-intent'), 'conversation-agent');
  assert.equal(requestHeaders.get('x-interaction-type'), 'conversation-agent');
  assert.equal(requestHeaders.get('x-interaction-id'), 'caller-interaction');
  assert.equal(requestHeaders.get('x-request-id'), 'caller-request');
  assert.equal(requestHeaders.get('x-agent-task-id'), 'caller-task');
  for (const preserved of ['authorization', 'accept', 'content-type', 'x-initiator', 'copilot-vision-request',
    'anthropic-version', 'anthropic-beta']) {
    assert.ok(requestHeaders.get(preserved), `${preserved} must be preserved`);
  }
  for (const removed of ['x-stainless-lang', 'x-stainless-timeout', 'openai-organization', 'openai-project',
    'anthropic-dangerous-direct-browser-access']) {
    assert.equal(requestHeaders.get(removed), null, `${removed} must be removed`);
  }
});

test('full model discovery uses model-access, emits 2026-08-01, and clears request-only headers', () => {
  const requestHeaders = headers({
    authorization: AUTHORIZATION,
    'content-type': 'application/json',
    'x-github-api-version': '2026-06-01',
    'openai-intent': 'conversation-edits',
    'x-interaction-id': 'caller-interaction',
    'x-request-id': 'caller-request',
  });
  const url = new URL('https://api.enterprise.githubcopilot.com/models');
  assert.equal(rewriteCopilotRequestHeaders(url, requestHeaders, FULL), true);
  assertIdentityHeaders(requestHeaders);
  assert.equal(requestHeaders.get('x-github-api-version'), '2026-08-01');
  assert.equal(requestHeaders.get('openai-intent'), 'model-access');
  assert.equal(requestHeaders.get('x-interaction-type'), 'model-access');
  assert.equal(requestHeaders.get('x-request-id'), 'caller-request');
  assert.equal(requestHeaders.get('x-agent-task-id'), 'caller-request');
  assert.equal(requestHeaders.get('content-type'), null);
  assert.equal(requestHeaders.get('x-interaction-id'), null);
});

test('full inference fills absent behavior headers and generates request/task IDs', () => {
  const requestHeaders = headers({ authorization: AUTHORIZATION, accept: 'application/json' });
  const url = new URL('https://api.individual.githubcopilot.com/responses');
  assert.equal(rewriteCopilotRequestHeaders(url, requestHeaders, FULL), true);
  assertIdentityHeaders(requestHeaders);
  assert.equal(requestHeaders.get('x-github-api-version'), '2026-08-01');
  assert.equal(requestHeaders.get('openai-intent'), 'conversation-agent');
  assert.equal(requestHeaders.get('x-interaction-type'), 'conversation-agent');
  assert.match(requestHeaders.get('x-request-id') ?? '', UUID_PATTERN);
  assert.equal(requestHeaders.get('x-agent-task-id'), requestHeaders.get('x-request-id'));
  assert.equal(requestHeaders.get('authorization'), AUTHORIZATION);
  assert.equal(requestHeaders.get('accept'), 'application/json');
});

test('nonempty caller interaction metadata wins over defaults', () => {
  const requestHeaders = headers({
    'openai-intent': 'conversation-subagent',
    'x-interaction-type': 'conversation-compaction',
    'x-interaction-id': 'caller-interaction',
    'x-agent-task-id': 'caller-task',
  });
  assert.equal(rewriteCopilotRequestHeaders(new URL('https://api.individual.githubcopilot.com/responses'), requestHeaders, FULL), true);
  assert.equal(requestHeaders.get('openai-intent'), 'conversation-subagent');
  assert.equal(requestHeaders.get('x-interaction-type'), 'conversation-compaction');
  assert.equal(requestHeaders.get('x-interaction-id'), 'caller-interaction');
  assert.equal(requestHeaders.get('x-agent-task-id'), 'caller-task');
});

test('basic mode fixes UA and SDK fingerprints without adding device or behavior headers', () => {
  const requestHeaders = headers({
    authorization: AUTHORIZATION,
    'openai-intent': 'conversation-edits',
    'x-github-api-version': '2026-06-01',
    'x-stainless-lang': 'js',
  });
  assert.equal(rewriteCopilotRequestHeaders(new URL('https://api.individual.githubcopilot.com/responses'), requestHeaders, BASIC), true);
  assert.equal(requestHeaders.get('user-agent'), BASIC.userAgent);
  assert.equal(requestHeaders.get('editor-version'), BASIC.editorVersion);
  assert.equal(requestHeaders.get('editor-plugin-version'), BASIC.editorPluginVersion);
  assert.equal(requestHeaders.get('copilot-integration-id'), BASIC.copilotIntegrationId);
  assert.equal(requestHeaders.get('editor-device-id'), null);
  assert.equal(requestHeaders.get('vscode-machineid'), null);
  assert.equal(requestHeaders.get('vscode-sessionid'), null);
  assert.equal(requestHeaders.get('x-vscode-user-agent-library-version'), null);
  assert.equal(requestHeaders.get('x-github-api-version'), '2026-06-01');
  assert.equal(requestHeaders.get('openai-intent'), 'conversation-edits');
  assert.equal(requestHeaders.get('x-interaction-type'), null);
  assert.equal(requestHeaders.get('x-stainless-lang'), null);
  assert.equal(requestHeaders.get('authorization'), AUTHORIZATION);
});

test('unmatched origins and paths are left untouched', () => {
  for (const value of [
    'http://api.individual.githubcopilot.com/responses',
    USERINFO_URL,
    'https://api.individual.githubcopilot.com:8443/responses',
    'https://githubcopilot.com/responses',
    'https://evilgithubcopilot.com/responses',
    'https://api.githubcopilot.com.evil.example/responses',
    'https://api.github.com/responses',
    'https://copilot-api..ghe.com/responses',
    'https://api.msft.ghe.com/responses',
  ]) assert.equal(isTrustedCopilotUrl(new URL(value)), false, value);
  for (const value of [
    'https://api.individual.githubcopilot.com/responses',
    'https://api.enterprise.githubcopilot.com/chat/completions',
    'https://copilot-api.msft.ghe.com/v1/messages',
  ]) assert.equal(isTrustedCopilotUrl(new URL(value)), true, value);

  const requestHeaders = headers({ 'x-stainless-lang': 'js', 'user-agent': 'deepseek-harness/test' });
  assert.equal(rewriteCopilotRequestHeaders(new URL('https://api.github.com/responses'), requestHeaders, FULL), false);
  assert.equal(rewriteCopilotRequestHeaders(new URL('https://api.individual.githubcopilot.com/models-telemetry'), requestHeaders, FULL), false);
  assert.equal(requestHeaders.get('user-agent'), 'deepseek-harness/test');
  assert.equal(requestHeaders.get('x-stainless-lang'), 'js');
});

test('path matching uses exact or slash-delimited families', () => {
  for (const value of ['/models', '/models/', '/models/session', '/chat/completions', '/chat/completions/',
    '/responses', '/responses/stream', '/v1/messages', '/v1/messages/count_tokens', '/embeddings']) {
    assert.equal(isCopilotRequestPath(value), true, value);
  }
  for (const value of ['/models-telemetry', '/modelsx', '/responsesXYZ', '/v1/messagesXYZ',
    '/chat/completionsXYZ', '/embeddingsXYZ', '/other']) {
    assert.equal(isCopilotRequestPath(value), false, value);
  }
});

test('identity construction validates modes and values and uses UUID-shaped fallbacks', () => {
  const basic = createCopilotWireIdentity('basic');
  assert.equal(basic.mode, 'basic');
  assert.equal(basic.editorDeviceId, undefined);
  assert.equal(basic.machineId, undefined);
  assert.equal(basic.sessionId, undefined);

  const full = createCopilotWireIdentity('full');
  assert.equal(full.mode, 'full');
  assert.match(full.editorDeviceId ?? '', UUID_PATTERN);
  assert.match(full.machineId ?? '', UUID_PATTERN);
  assert.match(full.sessionId ?? '', UUID_PATTERN);

  assert.throws(() => createCopilotWireIdentity('full', { userAgent: 'bad\nvalue' }), /Invalid Copilot wire identity value/u);
  assert.throws(() => createCopilotWireIdentity('full', { userAgent: '' }), /Invalid Copilot wire identity value/u);
  assert.equal(machineIdFromMac('aa:bb:cc:dd:ee:ff'), machineIdFromMac('aa:bb:cc:dd:ee:ff'));
  assert.notEqual(machineIdFromMac('aa:bb:cc:dd:ee:ff'), machineIdFromMac('11:22:33:44:55:66'));
  assert.match(machineIdFromMac(undefined), UUID_PATTERN);
});

test('stored UUID files accept valid values and reject missing or malformed ones', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-identity-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const valid = join(directory, 'valid');
  const malformed = join(directory, 'malformed');
  await writeFile(valid, '  a9f9f63c-7bf9-4e60-98eb-5fd3ad96e3ae\n', 'utf8');
  await writeFile(malformed, 'not-a-uuid', 'utf8');
  assert.equal(readStoredUuid(valid), 'a9f9f63c-7bf9-4e60-98eb-5fd3ad96e3ae');
  assert.equal(readStoredUuid(malformed), undefined);
  assert.equal(readStoredUuid(join(directory, 'absent')), undefined);
  assert.equal(readStoredUuid(undefined), undefined);
});

test('wireIdentityMode defaults to full and supports basic/off switches', () => {
  assert.equal(wireIdentityMode({}), 'full');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: 'full' }), 'full');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: 'basic' }), 'basic');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: '0' }), 'off');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: 'off' }), 'off');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: 'false' }), 'off');
  assert.equal(wireIdentityMode({ DSH_COPILOT_WIRE_IDENTITY: '' }), 'full');
});

interface Captured {
  input: RequestInfo | URL;
  init?: RequestInit;
}

function capture(response: Response = new Response('ok')): { fetcher: typeof fetch; captures: Captured[] } {
  const captures: Captured[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captures.push({ input, init });
    return response;
  }) as typeof fetch;
  return { fetcher, captures };
}

async function withInstalled(
  fetcher: typeof fetch,
  identity: CopilotWireIdentity,
  operation: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const release = installCopilotIdentityHeaders(identity);
  try {
    await operation();
  } finally {
    release();
    globalThis.fetch = original;
  }
}

test('installer rewrites string requests and preserves unrelated init fields', async () => {
  const { fetcher, captures } = capture();
  await withInstalled(fetcher, FULL, async () => {
    const response = await globalThis.fetch('https://api.individual.githubcopilot.com/responses', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'x-stainless-lang': 'js' },
      body: '{"input":"synthetic"}',
      redirect: 'error',
    });
    assert.equal(response.status, 200);
  });
  assert.equal(captures.length, 1);
  const captured = captures[0]!;
  assert.equal(captured.input, 'https://api.individual.githubcopilot.com/responses');
  assert.equal(captured.init?.method, 'POST');
  assert.equal(captured.init?.body, '{"input":"synthetic"}');
  assert.equal(captured.init?.redirect, 'error');
  const sent = new Headers(captured.init?.headers);
  assertIdentityHeaders(sent);
  assert.equal(sent.get('authorization'), AUTHORIZATION);
  assert.equal(sent.get('x-stainless-lang'), null);
});

test('Request plus init.headers replaces Request headers, including clearing Authorization', async () => {
  const { fetcher, captures } = capture();
  const empty = new Headers();
  const request = new Request('https://api.individual.githubcopilot.com/responses', {
    method: 'POST',
    headers: { authorization: AUTHORIZATION, 'x-caller': 'kept-on-input' },
    body: '{"input":"synthetic"}',
  });
  await withInstalled(fetcher, FULL, async () => {
    await globalThis.fetch(request, { headers: empty });
  });
  const captured = captures[0]!;
  assert.equal(captured.input, request, 'the original Request object must be delegated');
  const sent = new Headers(captured.init?.headers);
  assertIdentityHeaders(sent);
  assert.equal(sent.get('authorization'), null);
  assert.equal(sent.get('x-caller'), null);
  assert.equal(empty.get('authorization'), null);
  assert.equal(empty.get('user-agent'), null);
  assert.equal(request.headers.get('authorization'), AUTHORIZATION);
  assert.equal(request.headers.get('x-caller'), 'kept-on-input');
});

test('Request without init keeps its own headers as the effective base', async () => {
  const { fetcher, captures } = capture();
  const request = new Request('https://api.individual.githubcopilot.com/responses', {
    method: 'POST',
    headers: { authorization: AUTHORIZATION, 'x-caller': 'kept' },
    body: '{"input":"synthetic"}',
  });
  await withInstalled(fetcher, FULL, async () => {
    await globalThis.fetch(request);
  });
  const captured = captures[0]!;
  assert.equal(captured.input, request);
  const sent = new Headers(captured.init?.headers);
  assertIdentityHeaders(sent);
  assert.equal(sent.get('authorization'), AUTHORIZATION);
  assert.equal(sent.get('x-caller'), 'kept');
});

test('stream bodies, duplex, abort signals, and the exact downstream Response are preserved', async () => {
  const response = new Response('stream-ok');
  const { fetcher, captures } = capture(response);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('synthetic')); controller.close(); },
  });
  const abort = new AbortController();
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
    signal: abort.signal,
  };
  await withInstalled(fetcher, FULL, async () => {
    const returned = await globalThis.fetch('https://api.individual.githubcopilot.com/responses', init);
    assert.equal(returned, response);
  });
  const captured = captures[0]!;
  assert.equal(captured.init?.body, stream);
  assert.equal(captured.init?.signal, abort.signal);
  assert.equal((captured.init as RequestInit & { duplex?: string }).duplex, 'half');
  const sent = new Headers(captured.init?.headers);
  assertIdentityHeaders(sent);
  assert.equal(sent.get('content-type'), 'application/octet-stream');
});

test('a downstream rejection is propagated once and is never retried with original headers', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    throw new Error('synthetic downstream rejection');
  }) as typeof fetch;
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  const release = installCopilotIdentityHeaders(FULL);
  try {
    await assert.rejects(globalThis.fetch('https://api.individual.githubcopilot.com/responses', {
      headers: { 'x-stainless-lang': 'js' },
    }), /synthetic downstream rejection/u);
    assert.equal(calls, 1);
  } finally {
    release();
    globalThis.fetch = original;
  }
});

test('two installs hold the interceptor until the last release, in either order', async () => {
  for (const order of ['first-first', 'second-first'] as const) {
    const original = globalThis.fetch;
    const { fetcher, captures } = capture();
    globalThis.fetch = fetcher;
    const first = installCopilotIdentityHeaders(FULL);
    const second = installCopilotIdentityHeaders(FULL);
    try {
      if (order === 'first-first') {
        first();
        assert.equal(globalThis.fetch === fetcher, false);
        await globalThis.fetch('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
        assertIdentityHeaders(new Headers(captures.at(-1)?.init?.headers));
        first();
        second();
      } else {
        second();
        assert.equal(globalThis.fetch === fetcher, false);
        await globalThis.fetch('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
        assertIdentityHeaders(new Headers(captures.at(-1)?.init?.headers));
        second();
        first();
      }
      assert.equal(globalThis.fetch, fetcher);
    } finally {
      first();
      second();
      globalThis.fetch = original;
    }
  }
});

test('a cached wrapper passes through untouched after the final release', async () => {
  const original = globalThis.fetch;
  const { fetcher, captures } = capture();
  globalThis.fetch = fetcher;
  const release = installCopilotIdentityHeaders(FULL);
  const cached = globalThis.fetch;
  release();
  try {
    await cached('https://api.individual.githubcopilot.com/responses', {
      headers: { 'x-stainless-lang': 'js', authorization: AUTHORIZATION },
    });
  } finally {
    globalThis.fetch = original;
  }
  const sent = new Headers(captures[0]?.init?.headers);
  assert.equal(sent.get('user-agent'), null);
  assert.equal(sent.get('x-stainless-lang'), 'js');
  assert.equal(sent.get('authorization'), AUTHORIZATION);
});

test('unrelated wrappers installed before or after are preserved', async () => {
  const original = globalThis.fetch;
  const { fetcher, captures } = capture();
  const external = (async (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, init)) as typeof fetch;

  globalThis.fetch = external;
  const beforeRelease = installCopilotIdentityHeaders(FULL);
  try {
    await globalThis.fetch('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
    assertIdentityHeaders(new Headers(captures.at(-1)?.init?.headers));
  } finally {
    beforeRelease();
  }
  assert.equal(globalThis.fetch, external);

  const afterRelease = installCopilotIdentityHeaders(FULL);
  const interceptor = globalThis.fetch;
  const later = (async (input: RequestInfo | URL, init?: RequestInit) => interceptor(input, init)) as typeof fetch;
  globalThis.fetch = later;
  try {
    afterRelease();
    assert.equal(globalThis.fetch, later);
    await later('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
  } finally {
    globalThis.fetch = original;
  }
  const sent = new Headers(captures.at(-1)?.init?.headers);
  assert.equal(sent.get('user-agent'), null);
  assert.equal(sent.get('x-stainless-lang'), 'js');
});

test('reinstall after an external fetch replacement wraps the new fetch and restores it on release', async () => {
  const original = globalThis.fetch;
  const { fetcher, captures } = capture();
  const external = (async (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, init)) as typeof fetch;
  globalThis.fetch = fetcher;
  const first = installCopilotIdentityHeaders(FULL);
  const cached = globalThis.fetch;
  try {
    globalThis.fetch = external;
    const second = installCopilotIdentityHeaders(FULL);
    try {
      await globalThis.fetch('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
      assertIdentityHeaders(new Headers(captures.at(-1)?.init?.headers));
    } finally {
      second();
    }
    first();
    assert.equal(globalThis.fetch, external);
  } finally {
    first();
    globalThis.fetch = original;
  }
  await cached('https://api.individual.githubcopilot.com/responses', { headers: { 'x-stainless-lang': 'js' } });
  const sent = new Headers(captures.at(-1)?.init?.headers);
  assert.equal(sent.get('user-agent'), null);
});

test('the first live install owns the identity for concurrent mounts', async () => {
  const original = globalThis.fetch;
  const { fetcher, captures } = capture();
  globalThis.fetch = fetcher;
  const other: CopilotWireIdentity = { ...FULL, userAgent: 'OtherClient/1.0.0' };
  const first = installCopilotIdentityHeaders(FULL);
  const second = installCopilotIdentityHeaders(other);
  try {
    await globalThis.fetch('https://api.individual.githubcopilot.com/responses', {});
    assert.equal(new Headers(captures[0]?.init?.headers).get('user-agent'), FULL.userAgent);
  } finally {
    first();
    second();
    globalThis.fetch = original;
  }
});

test('non-Copilot, lookalike, and boundary-negative requests pass through', async () => {
  const { fetcher, captures } = capture();
  await withInstalled(fetcher, FULL, async () => {
    for (const value of [
      'https://api.github.com/user',
      'https://evilgithubcopilot.com/responses',
      'https://api.individual.githubcopilot.com/models-telemetry',
      'https://api.individual.githubcopilot.com/responsesXYZ',
      'https://api.individual.githubcopilot.com/v1/messagesXYZ',
    ]) {
      await globalThis.fetch(value, { headers: { 'x-stainless-lang': 'js', 'user-agent': 'deepseek-harness/test' } });
    }
  });
  assert.equal(captures.length, 5);
  for (const captured of captures) {
    const sent = new Headers(captured.init?.headers);
    assert.equal(sent.get('user-agent'), 'deepseek-harness/test');
    assert.equal(sent.get('x-stainless-lang'), 'js');
  }
});
