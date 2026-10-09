import test from 'node:test';
import assert from 'node:assert/strict';
import { WebError } from '@deepseek-ai/dsh-web';
import { CopilotSearchProvider, COPILOT_SEARCH_PROVIDER_ID } from '../dist/provider.js';
import { CopilotSearchError } from '../dist/errors.js';
import { options, syntheticAuth, jsonResponse, sseResponse, sseCompleted, completed, nativeCall, message, captureOptions, controlledBody, deferred, tick, encoded, errorCode } from './fixtures.mjs';

const query = { query: 'synthetic web search', maxResults: 1 };

test('stable provider identity and availability are synchronous and credential/network-free', () => {
  let auth = 0, fetches = 0;
  const provider = new CopilotSearchProvider(() => options({ resolveAuth: async () => { auth++; }, fetcher: async () => { fetches++; } }));
  assert.equal(provider.id, 'github-copilot-search');
  assert.equal(provider.id, COPILOT_SEARCH_PROVIDER_ID);
  assert.equal(provider.available(), true);
  assert.equal(provider.available(), true);
  assert.equal(auth, 0);
  assert.equal(fetches, 0);
});

test('empty or invalid configuration is unavailable, rejects safely, and does no paid work', async () => {
  const invalid = [undefined, null, {}, options({ model: '' }), options({ model: ' bad ' }), options({ model: 'bad\nmodel' }), options({ maxTokens: 0 }), options({ maxTokens: 65537 }), options({ maxTokens: 16.5 }), options({ timeoutMs: 0 }), options({ timeoutMs: Infinity }), options({ timeoutMs: 120001 }), options({ maxResponseBytes: 0 }), options({ maxResponseBytes: 1023 }), options({ maxResponseBytes: 16777217 }), options({ includeSources: 'yes' }), options({ forceSearch: null }), options({ searchMode: 'auto' }), options({ resolveAuth: undefined }), options({ fetcher: {} })];
  for (const value of invalid) {
    const provider = new CopilotSearchProvider(() => value);
    assert.equal(provider.available(), false);
    await assert.rejects(provider.search(query), errorCode('WEB_INVALID_CONFIG'));
  }
  const throws = new CopilotSearchProvider(() => { throw new Error('synthetic-private-config'); });
  assert.equal(throws.available(), false);
  await assert.rejects(throws.search(query), error => {
    assert.equal(error.code, 'WEB_INVALID_CONFIG');
    assert.doesNotMatch(error.message, /synthetic-private/);
    return true;
  });
});

test('native default request uses Responses POST, configured tokens, and exact public contract', async () => {
  const { config, requests } = captureOptions();
  const result = await new CopilotSearchProvider(() => config).search(query);
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, 'https://api.githubcopilot.com/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'gpt-6.1-sol', input: `Perform a web search for this query and return a concise grounded answer:\n\n${query.query}`, tools: [{ type: 'web_search' }],
    max_output_tokens: 4096, store: false, stream: true, include: ['web_search_call.action.sources'],
  });
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), 'Bearer synthetic-token');
  assert.equal(headers.get('x-initiator'), 'agent');
  assert.equal(headers.get('openai-intent'), 'conversation-edits');
  assert.equal(headers.get('x-github-api-version'), '2026-06-01');
  assert.match(headers.get('x-request-id'), /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
  assert.equal(headers.get('editor-version'), 'vscode/fixture');
  assert.deepEqual(result, { content: 'Synthetic answer', sources: [{ url: 'https://example.test/source' }], truncated: false });
});

test('default omits external access/tool choice, explicit live/cached/force flags are honored', async () => {
  for (const searchMode of ['default', 'live', 'cached']) {
    const { config, requests } = captureOptions({ searchMode, forceSearch: true, includeSources: false, model: 'configured-model', maxTokens: 512 });
    await new CopilotSearchProvider(() => config).search(query);
    const request = JSON.parse(requests[0].init.body);
    assert.equal(request.model, 'configured-model');
    assert.equal(request.max_output_tokens, 512);
    assert.equal(request.tool_choice, 'required');
    assert.equal('include' in request, false);
    assert.deepEqual(request.tools, [{ type: 'web_search', ...(searchMode === 'default' ? {} : { external_web_access: searchMode === 'live' }) }]);
    assert.equal('maxResults' in request, false);
  }
});

test('maxResults remains the DSH seam responsibility and is not falsely marked truncated', async () => {
  const provider = new CopilotSearchProvider(() => options({ fetcher: async () => jsonResponse(completed([nativeCall([{ url: 'https://a.test' }, { url: 'https://b.test' }]), message()])) }));
  const result = await provider.search(query);
  assert.equal(result.sources.length, 2);
  assert.equal(result.truncated, false);
});

test('auth resolves once per operation, rotating credentials are never retained', async () => {
  const headers = [];
  let resolves = 0;
  const provider = new CopilotSearchProvider(() => options({
    resolveAuth: async () => ({ ...syntheticAuth(), apiKey: `synthetic-rotation-${++resolves}` }),
    fetcher: async (_url, init) => { headers.push(new Headers(init.headers)); return jsonResponse(); },
  }));
  await provider.search(query);
  await provider.search(query);
  assert.equal(resolves, 2);
  assert.deepEqual(headers.map(item => item.get('authorization')), ['Bearer synthetic-rotation-1', 'Bearer synthetic-rotation-2']);
  assert.notEqual(headers[0].get('x-request-id'), headers[1].get('x-request-id'));
});

test('origin trust rejects non-Copilot, insecure, credentialed, pathful, or unusual-port dispatch', async () => {
  for (const baseUrl of ['http://api.githubcopilot.com', 'https://githubcopilot.com', 'https://githubcopilot.com.evil.test', 'https://evilgithubcopilot.com', 'https://api.githubcopilot.com:8443', 'https://' + 'user:secret@api.githubcopilot.com', 'https://@api.githubcopilot.com', 'https://api.githubcopilot.com/responses', 'https://api.githubcopilot.com?token=private', ' https://api.githubcopilot.com', 'https://api.githubcopilot.com\n']) {
    let calls = 0;
    const provider = new CopilotSearchProvider(() => options({ resolveAuth: async () => ({ ...syntheticAuth(), baseUrl }), fetcher: async () => { calls++; return jsonResponse(); } }));
    await assert.rejects(provider.search(query), errorCode('WEB_PROVIDER_ENDPOINT_UNTRUSTED'));
    assert.equal(calls, 0);
  }
  const { requests, config } = captureOptions({ resolveAuth: async () => ({ ...syntheticAuth(), baseUrl: 'https://account.enterprise.githubcopilot.com:443/' }) });
  await new CopilotSearchProvider(() => config).search(query);
  assert.equal(requests[0].url, 'https://account.enterprise.githubcopilot.com/responses');
});

test('GHE search dispatches only to the tenant Copilot API and never global routing', async () => {
  const { requests, config } = captureOptions({ resolveAuth: async () => ({
    ...syntheticAuth(), baseUrl: 'https://copilot-api.company.ghe.com:443/',
  }) });
  const result = await new CopilotSearchProvider(() => config).search(query);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://copilot-api.company.ghe.com/responses');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer synthetic-token');
  assert.equal(result.content, 'Synthetic answer');
  for (const baseUrl of [
    'https://company.ghe.com', 'https://api.company.ghe.com', 'https://copilot-api.team.company.ghe.com',
    'https://copilot-api.company.ghe.com.evil.test', 'https://copilot-api.-company.ghe.com',
    'https://copilot-api.company.ghe.com:8443', 'http://copilot-api.company.ghe.com',
    'https://@copilot-api.company.ghe.com', 'https://copilot-api.company.ghe.com/responses',
    'https://copilot-api.company.ghe.com?token=private', 'https://copilot-api.company.ghe.com#fragment',
  ]) {
    const rejected = captureOptions({ resolveAuth: async () => ({ ...syntheticAuth(), baseUrl }) });
    await assert.rejects(new CopilotSearchProvider(() => rejected.config).search(query), errorCode('WEB_PROVIDER_ENDPOINT_UNTRUSTED'));
    assert.equal(rejected.requests.length, 0);
  }
});

test('only safe auth identity headers dispatch; critical headers cannot be overridden', async () => {
  const { config, requests } = captureOptions({ resolveAuth: async () => ({ ...syntheticAuth(), headers: {
    'uSeR-aGeNt': 'SyntheticIdentity/1', 'EDITOR-VERSION': 'vscode/synthetic',
    Authorization: 'must-not-win', 'X-Initiator': 'user', 'Openai-Intent': 'override',
    'X-GitHub-Api-Version': 'old', 'X-Request-Id': 'fixed', Host: 'evil.test', Cookie: 'private', 'X-Random-Secret': 'private',
  } }) });
  await new CopilotSearchProvider(() => config).search(query);
  const sent = new Headers(requests[0].init.headers);
  assert.equal(sent.get('user-agent'), 'SyntheticIdentity/1');
  assert.equal(sent.get('editor-version'), 'vscode/synthetic');
  assert.equal(sent.get('authorization'), 'Bearer synthetic-token');
  assert.equal(sent.get('x-initiator'), 'agent');
  assert.equal(sent.get('openai-intent'), 'conversation-edits');
  assert.equal(sent.get('x-github-api-version'), '2026-06-01');
  for (const key of ['host', 'cookie', 'x-random-secret']) assert.equal(sent.has(key), false);
  for (const value of ['bad\r\nSecret: x', '\u0085bad', '', 'x'.repeat(1025)]) {
    let calls = 0;
    const provider = new CopilotSearchProvider(() => options({ resolveAuth: async () => ({ ...syntheticAuth(), headers: { 'User-Agent': value } }), fetcher: async () => { calls++; return jsonResponse(); } }));
    await assert.rejects(provider.search(query), errorCode('WEB_PROVIDER_AUTH_INVALID'));
    assert.equal(calls, 0);
  }
});

test('missing/invalid credentials and injected auth failures are safe and never dispatch', async () => {
  for (const [resolver, expected] of [
    [async () => undefined, 'WEB_PROVIDER_CREDENTIAL_MISSING'],
    [async () => ({ ...syntheticAuth(), apiKey: '' }), 'WEB_PROVIDER_AUTH_INVALID'],
    [async () => ({ ...syntheticAuth(), apiKey: ['synthetic', 'secret'].join('\r\n') }), 'WEB_PROVIDER_AUTH_INVALID'],
    [async () => { throw new Error('synthetic-private-auth'); }, 'WEB_PROVIDER_AUTH_ERROR'],
    [async () => { throw new WebError('synthetic-private-web-error', 'WEB_PROVIDER_CREDENTIAL_MISSING'); }, 'WEB_PROVIDER_CREDENTIAL_MISSING'],
    [async () => { throw new WebError('synthetic-private-web-error', 'WEB_ABORTED'); }, 'WEB_PROVIDER_AUTH_ERROR'],
  ]) {
    let calls = 0;
    const provider = new CopilotSearchProvider(() => options({ resolveAuth: resolver, fetcher: async () => { calls++; return jsonResponse(); } }));
    await assert.rejects(provider.search(query), error => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, expected);
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private|synthetic-token|synthetic\r/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test('HTTP, unsupported tools/model, and network errors never retry or expose body/error text', async () => {
  for (const status of [400, 404, 422, 401, 403, 429, 500, 302]) {
    let calls = 0;
    const body = controlledBody('synthetic-private-response-body');
    const provider = new CopilotSearchProvider(() => options({ fetcher: async () => { calls++; return new Response(body.stream, { status }); } }));
    await assert.rejects(provider.search(query), error => {
      assert.equal(error.code, [400, 404, 422].includes(status) ? 'WEB_PROVIDER_UNSUPPORTED' : 'WEB_HTTP_ERROR');
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(body.cancellations, 1);
  }
  let calls = 0;
  const provider = new CopilotSearchProvider(() => options({ fetcher: async () => { calls++; throw new Error('private-network-url-and-bearer'); } }));
  await assert.rejects(provider.search(query), error => {
    assert.equal(error.code, 'WEB_NETWORK_ERROR');
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-network/);
    return true;
  });
  assert.equal(calls, 1);
});

test('mutated owned exceptions, unknown diagnostic codes, and hostile body getters are sanitized', async () => {
  for (const code of ['WEB_HTTP_ERROR', 'not-an-owned-code', 'toString', '__proto__']) {
    const injected = new CopilotSearchError('WEB_INVALID_RESPONSE');
    Object.assign(injected, { message: 'synthetic-private-mutation', code, cause: new Error('synthetic-private-cause') });
    const response = { ok: true, get body() { throw injected; } };
    const provider = new CopilotSearchProvider(() => options({ fetcher: async () => response }));
    await assert.rejects(provider.search(query), error => {
      assert.notEqual(error, injected);
      assert.equal(error.code, code === 'WEB_HTTP_ERROR' ? code : 'WEB_INVALID_RESPONSE');
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const unknown = new CopilotSearchError('toString');
  assert.equal(unknown.code, 'WEB_INVALID_RESPONSE');
  assert.equal(typeof unknown.message, 'string');
});

test('injected dependencies cannot mutate exposed abort reasons into visible diagnostics', async () => {
  for (const timeout of [false, true]) {
    const started = deferred(), controller = new AbortController();
    const provider = new CopilotSearchProvider(() => options({ timeoutMs: timeout ? 15 : 1000,
      resolveAuth: signal => {
        signal.addEventListener('abort', () => Object.assign(signal.reason, { message: 'synthetic-private-reason', code: 'WEB_HTTP_ERROR', cause: 'synthetic-private-cause' }));
        started.resolve();
        return new Promise(() => {});
      },
    }));
    const promise = provider.search(query, controller.signal);
    await started.promise;
    if (!timeout) controller.abort();
    await assert.rejects(promise, error => {
      assert.equal(error.code, timeout ? 'WEB_TIMEOUT' : 'WEB_ABORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('immutable configuration and query snapshots survive auth preflight mutations', async () => {
  const gate = deferred(), started = deferred();
  const { config, requests } = captureOptions({ resolveAuth: async () => { started.resolve(); return gate.promise; } });
  let snapshots = 0;
  const provider = new CopilotSearchProvider(() => { snapshots++; return config; });
  const mutableRequest = { ...query };
  const promise = provider.search(mutableRequest);
  await started.promise;
  Object.assign(config, { model: 'changed-model', maxTokens: 1024, forceSearch: true, includeSources: false, searchMode: 'cached', fetcher: async () => { throw new Error('not the snapshotted fetcher'); } });
  mutableRequest.query = 'changed query';
  gate.resolve(syntheticAuth());
  await promise;
  assert.equal(snapshots, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.equal(body.input, `Perform a web search for this query and return a concise grounded answer:\n\n${query.query}`);
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.tool_choice, undefined);
  assert.deepEqual(body.include, ['web_search_call.action.sources']);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]);
});

test('synchronous configuration preflight is included in the timeout deadline', async t => {
  let now = 1000, authCalls = 0, fetchCalls = 0;
  t.mock.method(Date, 'now', () => now);
  const provider = new CopilotSearchProvider(() => {
    now += 100;
    return options({ timeoutMs: 10, resolveAuth: async () => { authCalls++; return syntheticAuth(); }, fetcher: async () => { fetchCalls++; return jsonResponse(); } });
  });
  await assert.rejects(provider.search(query), errorCode('WEB_TIMEOUT'));
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('invalid queries do not invoke credentials or fetch', async () => {
  let authCalls = 0;
  const provider = new CopilotSearchProvider(() => options({ resolveAuth: async () => { authCalls++; return syntheticAuth(); } }));
  for (const request of [undefined, null, {}, { query: '' }, { query: '   ' }, { query: 123 }]) {
    await assert.rejects(provider.search(request), errorCode('WEB_INVALID_REQUEST'));
  }
  assert.equal(authCalls, 0);
});

test('pre-aborted calls never read options, resolve credentials, or dispatch', async () => {
  const controller = new AbortController();
  controller.abort(new Error('private-user-reason'));
  let calls = 0;
  const provider = new CopilotSearchProvider(() => { calls++; return options(); });
  await assert.rejects(provider.search(query, controller.signal), errorCode('WEB_ABORTED'));
  assert.equal(calls, 0);
});

test('cancellation during uncooperative auth is prompt and prevents late dispatch/rejections', async () => {
  for (const lateReject of [false, true]) {
    const controller = new AbortController(), gate = deferred(), started = deferred();
    let calls = 0, authSignal;
    const provider = new CopilotSearchProvider(() => options({ resolveAuth: signal => { authSignal = signal; started.resolve(); return gate.promise; }, fetcher: async () => { calls++; return jsonResponse(); } }));
    const promise = provider.search(query, controller.signal);
    await started.promise;
    controller.abort('private-caller-reason');
    await assert.rejects(promise, errorCode('WEB_ABORTED'));
    assert.equal(authSignal.aborted, true);
    if (lateReject) gate.reject(new Error('private-late-auth')); else gate.resolve(syntheticAuth());
    await tick();
    assert.equal(calls, 0);
  }
});

test('inflight fetch cancellation cancels late response bodies and observes late rejection', async () => {
  for (const lateReject of [false, true]) {
    const controller = new AbortController(), gate = deferred(), started = deferred();
    let calls = 0;
    const body = controlledBody(sseCompleted());
    const provider = new CopilotSearchProvider(() => options({ fetcher: async (_url, init) => { calls++; assert.equal(init.signal.aborted, false); started.resolve(); return gate.promise; } }));
    const promise = provider.search(query, controller.signal);
    await started.promise;
    controller.abort();
    await assert.rejects(promise, errorCode('WEB_ABORTED'));
    if (lateReject) gate.reject(new Error('private-late-fetch')); else gate.resolve(new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } }));
    await tick();
    assert.equal(calls, 1);
    if (!lateReject) assert.equal(body.cancellations, 1);
  }
});

test('caller abort during stream reads cancels the reader without returning buffered terminal success', async () => {
  const controller = new AbortController(), started = deferred();
  const body = controlledBody(sseCompleted()); // Terminal arrived, but EOF has not: abort must win.
  const provider = new CopilotSearchProvider(() => options({ fetcher: async () => { started.resolve(); return new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } }); } }));
  const promise = provider.search(query, controller.signal);
  await started.promise;
  await tick();
  controller.abort();
  await assert.rejects(promise, errorCode('WEB_ABORTED'));
  assert.equal(body.cancellations, 1);
});

test('timeouts cover uncooperative credential, fetch, and read work and reject late success', async () => {
  for (const phase of ['auth', 'fetch', 'read']) {
    const gate = deferred();
    const body = controlledBody(sseCompleted());
    let calls = 0, observedSignal;
    const provider = new CopilotSearchProvider(() => options({ timeoutMs: 15,
      resolveAuth: async signal => { observedSignal = signal; return phase === 'auth' ? gate.promise : syntheticAuth(); },
      fetcher: async () => { calls++; return phase === 'fetch' ? gate.promise : new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } }); },
    }));
    await assert.rejects(provider.search(query), errorCode('WEB_TIMEOUT'));
    assert.equal(observedSignal.aborted, true);
    if (phase === 'auth') gate.resolve(syntheticAuth());
    if (phase === 'fetch') gate.resolve(new Response(body.stream, { headers: { 'content-type': 'text/event-stream' } }));
    await tick();
    assert.equal(calls, phase === 'auth' ? 0 : 1);
    if (phase !== 'auth') assert.equal(body.cancellations, 1);
  }
});

test('uncooperative reader and cleanup cannot extend cancellation deadline; late read rejection is observed', async () => {
  const gate = deferred(), reading = deferred(), cancelGate = deferred();
  let cancellations = 0;
  const fake = {
    ok: true, headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: { getReader: () => ({
      read: () => { reading.resolve(); return gate.promise; },
      cancel: () => { cancellations++; return cancelGate.promise; },
      releaseLock: () => {},
    }) },
  };
  const provider = new CopilotSearchProvider(() => options({ timeoutMs: 15, fetcher: async () => fake }));
  const promise = provider.search(query);
  await reading.promise;
  await assert.rejects(promise, errorCode('WEB_TIMEOUT'));
  assert.equal(cancellations, 1);
  gate.reject(new Error('private-late-reader'));
  cancelGate.reject(new Error('private-cancel-error'));
  await tick();
});

test('JSON fallback and chunked SSE return the same normalized result', async () => {
  const value = completed([nativeCall([{ url: 'https://source.test' }]), message('中文 🔎')]);
  const json = await new CopilotSearchProvider(() => options({ fetcher: async () => jsonResponse(value) })).search(query);
  const bytes = encoded(sseCompleted(value));
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3)); controller.close(); } });
  const streamed = await new CopilotSearchProvider(() => options({ fetcher: async () => new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }) })).search(query);
  assert.deepEqual(streamed, json);
});

test('strict byte budget applies to JSON, SSE, framing/comments, and declared content length', async () => {
  const value = completed([nativeCall(), message('文'.repeat(600))]);
  for (const response of [() => jsonResponse(value), () => sseResponse(sseCompleted(value)), () => sseResponse(': ' + 'a'.repeat(1025) + '\n\n')]) {
    await assert.rejects(new CopilotSearchProvider(() => options({ maxResponseBytes: 1024, fetcher: async () => response() })).search(query), errorCode('WEB_RESPONSE_TOO_LARGE'));
  }
  const body = controlledBody();
  const provider = new CopilotSearchProvider(() => options({ maxResponseBytes: 1024, fetcher: async () => new Response(body.stream, { headers: { 'content-type': 'application/json', 'content-length': '1025' } }) }));
  await assert.rejects(provider.search(query), errorCode('WEB_RESPONSE_TOO_LARGE'));
  assert.equal(body.cancellations, 1);
  const exact = encoded(JSON.stringify(completed([nativeCall(), message('x'.repeat(1100))])));
  await new CopilotSearchProvider(() => options({ maxResponseBytes: exact.byteLength, fetcher: async () => new Response(exact, { headers: { 'content-type': 'application/json' } }) })).search(query);
});

test('no terminal/native search, malformed JSON, unexpected content types never become success', async () => {
  for (const [response, code] of [
    [() => sseResponse('data: [DONE]\n\n'), 'WEB_STREAM_INCOMPLETE'],
    [() => jsonResponse(completed([message()])), 'WEB_NO_SEARCH'],
    [() => new Response('private-invalid-json', { headers: { 'content-type': 'application/json' } }), 'WEB_INVALID_RESPONSE'],
    [() => new Response('private-html-body', { headers: { 'content-type': 'text/html' } }), 'WEB_INVALID_RESPONSE'],
    [() => new Response(null, { headers: { 'content-type': 'application/json' } }), 'WEB_INVALID_RESPONSE'],
  ]) {
    await assert.rejects(new CopilotSearchProvider(() => options({ fetcher: async () => response() })).search(query), errorCode(code));
  }
});
