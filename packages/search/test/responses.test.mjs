import test from 'node:test';
import assert from 'node:assert/strict';
import { WebError } from '@deepseek-ai/dsh-web';
import { spawnSync } from 'node:child_process';
import { normalizeResponsesResponse, parseResponsesSSE, parseResponsesJSON, ResponsesSSEParser, safeSourceUrl } from '../dist/responses.js';
import { completed, nativeCall, message, sseEvent, sseCompleted, encoded, errorCode } from './fixtures.mjs';

const citation = (url, title) => ({ type: 'url_citation', url, ...(title ? { title } : {}), start_index: 0, end_index: 4 });

test('normalizer combines native sources and annotations, dedupes canonically, enriches titles', () => {
  const result = normalizeResponsesResponse(completed([
    nativeCall([{ url: 'https://example.test' }, { url: 'https://second.test/s', title: 'Second', snippet: 'Literal source extract', publishedAt: '2026-01-01T00:00:00Z' }]),
    message('Generated prose must not become a snippet', [citation('https://example.test/', 'Enriched title'), citation('https://third.test/s', 'Third')]),
  ]));
  assert.deepEqual(result, {
    content: 'Generated prose must not become a snippet',
    sources: [
      { url: 'https://example.test', title: 'Enriched title' },
      { url: 'https://second.test/s', title: 'Second', snippet: 'Literal source extract', publishedAt: '2026-01-01T00:00:00Z' },
      { url: 'https://third.test/s', title: 'Third' },
    ], truncated: false,
  });
  assert.deepEqual(Object.keys(result).sort(), ['content', 'sources', 'truncated']);
});

test('URL citations and native source lists reject unsafe URLs', () => {
  const bad = ['javascript:alert(1)', 'file:///tmp/source', 'data:text/html,x', 'https://' + 'user:pass@example.test', 'https://@example.test', 'https://example.test/\nsecret', 'https://example.test/\u0085', 'https:\\example.test', 'not a url', '//example.test'];
  for (const url of bad) assert.equal(safeSourceUrl(url), undefined, url);
  const result = normalizeResponsesResponse(completed([
    nativeCall(bad.map(url => ({ url }))),
    message('Answer', bad.map(url => citation(url))),
  ]));
  assert.deepEqual(result.sources, []);
  assert.equal(safeSourceUrl('http://example.test/path?q=1#heading'), 'http://example.test/path?q=1#heading');
});

test('completed native execution can return explicitly zero sources without invented links', () => {
  assert.deepEqual(normalizeResponsesResponse(completed([nativeCall([])])), { sources: [], truncated: false });
  const result = normalizeResponsesResponse(completed([nativeCall([]), message('See https://example.test and [a](https://another.test).')]));
  assert.deepEqual(result.sources, []);
  assert.match(result.content, /https:\/\/example.test/);
});

test('no native search, function-only output, or uncompleted native calls are errors', () => {
  for (const output of [[], [message()], [{ type: 'function_call', name: 'search', status: 'completed' }], [{ ...nativeCall(), action: { type: 'open_page' } }]]) {
    assert.throws(() => normalizeResponsesResponse(completed(output)), errorCode('WEB_NO_SEARCH'));
  }
  for (const status of ['in_progress', 'searching', undefined]) {
    assert.throws(() => normalizeResponsesResponse(completed([{ ...nativeCall(), status }])), errorCode('WEB_RESPONSE_INCOMPLETE'));
  }
});

test('malformed, failed, and incomplete responses have stable safe WebErrors', () => {
  for (const value of [null, [], {}, { status: 'completed' }, { status: 'completed', output: [null] }, completed([{ ...nativeCall(), action: null }]), completed([nativeCall(), { type: 'message', content: [{ type: 'output_text' }] }])]) {
    assert.throws(() => normalizeResponsesResponse(value), errorCode('WEB_INVALID_RESPONSE'));
  }
  for (const status of ['failed', 'incomplete']) {
    assert.throws(() => normalizeResponsesResponse({ ...completed(), status, error: status === 'failed' ? { message: 'synthetic-private-detail' } : null }), error => {
      assert.ok(error instanceof WebError);
      assert.equal(error.code, status === 'failed' ? 'WEB_RESPONSE_FAILED' : 'WEB_RESPONSE_INCOMPLETE');
      assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic-private-detail/);
      return true;
    });
  }
});

test('structured unsupported model/tool errors expose only a stable capability error', () => {
  for (const code of ['unsupported_tool', 'unsupported_model', 'model_not_found']) {
    const response = { ...completed(), status: 'failed', error: { code, message: 'synthetic-private-provider-diagnostic' } };
    assert.throws(() => normalizeResponsesResponse(response), errorCode('WEB_PROVIDER_UNSUPPORTED'));
    assert.throws(() => parseResponsesSSE(sseEvent({ type: 'response.failed', response })), errorCode('WEB_PROVIDER_UNSUPPORTED'));
    assert.throws(() => parseResponsesSSE(sseEvent({ type: 'error', code, message: 'synthetic-private-provider-diagnostic' })), error => {
      assert.equal(error.code, 'WEB_PROVIDER_UNSUPPORTED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /synthetic-private/);
      return true;
    });
  }
});

test('opaque markers are stripped without mapping invented from marker indices', () => {
  const result = normalizeResponsesResponse(completed([
    nativeCall([{ url: 'https://example.test/s', title: 'Real source' }]),
    message('Safe prose citeturn9search42 remains [1] and 中文 🔎.', [citation('https://example.test/s', 'Real source')]),
  ]));
  assert.equal(result.content, 'Safe prose  remains [1] and 中文 🔎.');
  assert.deepEqual(result.sources, [{ url: 'https://example.test/s', title: 'Real source' }]);
  assert.equal(result.sources[0].snippet, undefined);
});

test('SSE merges output_item.done, content_part.done, annotation.added, and completed.output structurally', () => {
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: nativeCall([{ url: 'https://first.test/source' }]) },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg', content: [] } },
    { type: 'response.output_text.annotation.added', item_id: 'msg', content_index: 0, annotation: citation('https://first.test/source', 'Added title') },
    { type: 'response.content_part.done', output_index: 1, content_index: 0, part: { type: 'output_text', text: '保留 🔎 answer', annotations: [citation('https://second.test/source', 'Second')] } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg', status: 'completed', content: [{ type: 'output_text', text: '保留 🔎 answer', annotations: [] }] } },
    { type: 'response.completed', response: { status: 'completed', output: [nativeCall([]), { type: 'message', id: 'msg', status: 'completed', content: [{ type: 'output_text', text: '保留 🔎 answer', annotations: [citation('https://third.test/source', 'Third')] }] }] } },
  ];
  const bytes = encoded(': comment\r\n\r\n' + events.map(sseEvent).join('').replaceAll('\n', '\r\n') + 'data: [DONE]\r\n\r\n');
  const parser = new ResponsesSSEParser();
  // Every byte separately exercises Unicode, field names, CRLF, and frame boundaries.
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  assert.deepEqual(parser.finish(), {
    content: '保留 🔎 answer', sources: [
      { url: 'https://first.test/source', title: 'Added title' },
      { url: 'https://second.test/source', title: 'Second' },
      { url: 'https://third.test/source', title: 'Third' },
    ], truncated: false,
  });
});

test('SSE parses comments, multiline data, lone CR, absent final newline, and event-name fallback', () => {
  const pretty = JSON.stringify({ response: completed() }, null, 2).split('\n').map(line => `data: ${line}`).join('\r');
  const text = ': hello\r\rid: 123\revent: response.completed\r' + pretty;
  assert.deepEqual(parseResponsesSSE(text), normalizeResponsesResponse(completed()));
});

test('SSE rejects premature [DONE], missing terminal, failed/incomplete terminals, malformed JSON', () => {
  for (const stream of ['', 'data: [DONE]\n\n', sseEvent({ type: 'response.output_item.done', output_index: 0, item: nativeCall() })]) {
    assert.throws(() => parseResponsesSSE(stream), errorCode('WEB_STREAM_INCOMPLETE'));
  }
  assert.throws(() => parseResponsesSSE('data: {invalid-private-detail}\n\n'), errorCode('WEB_INVALID_RESPONSE'));
  assert.throws(() => parseResponsesSSE(sseEvent({ type: 'response.failed', response: { error: { message: 'private' } } })), errorCode('WEB_RESPONSE_FAILED'));
  assert.throws(() => parseResponsesSSE(sseEvent({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })), errorCode('WEB_RESPONSE_INCOMPLETE'));
  assert.throws(() => parseResponsesSSE(sseCompleted().slice(0, 100)), errorCode('WEB_INVALID_RESPONSE'));
});

test('JSON and SSE byte budgets count UTF-8 bytes, including comments and framing', () => {
  const bytes = encoded(sseCompleted(completed([nativeCall(), message('多字节🔎')])));
  assert.deepEqual(parseResponsesSSE(bytes, { maxResponseBytes: bytes.length }), normalizeResponsesResponse(completed([nativeCall(), message('多字节🔎')])));
  assert.throws(() => parseResponsesSSE(bytes, { maxResponseBytes: bytes.length - 1 }), errorCode('WEB_RESPONSE_TOO_LARGE'));
  const json = encoded(JSON.stringify(completed()));
  assert.deepEqual(parseResponsesJSON(json, json.length), normalizeResponsesResponse(completed()));
  assert.throws(() => parseResponsesJSON(json, json.length - 1), errorCode('WEB_RESPONSE_TOO_LARGE'));
  assert.throws(() => parseResponsesJSON(encoded('{private malformed'), 100), errorCode('WEB_INVALID_RESPONSE'));
  assert.throws(() => parseResponsesJSON(new Uint8Array([0xff]), 100), errorCode('WEB_INVALID_RESPONSE'));
  assert.throws(() => parseResponsesSSE(new Uint8Array([0xff])), errorCode('WEB_INVALID_RESPONSE'));
});

test('structural budgets reject sparse SSE indices and oversized terminal/JSON arrays', () => {
  for (const event of [
    { type: 'response.output_item.done', output_index: 9999, item: nativeCall() },
    { type: 'response.content_part.done', output_index: 0, content_index: 9999, part: { type: 'output_text', text: 'sparse' } },
    { type: 'response.output_text.annotation.added', output_index: 0, content_index: 9999, annotation: citation('https://example.test') },
  ]) assert.throws(() => parseResponsesSSE(sseEvent(event)), errorCode('WEB_RESPONSE_TOO_LARGE'));
  const oversized = [
    completed(Array.from({ length: 257 }, () => nativeCall())),
    completed([nativeCall(), { ...message(), content: Array.from({ length: 65 }, () => ({ type: 'output_text', text: 'part' })) }]),
    completed([nativeCall(), message('text', Array.from({ length: 257 }, (_, i) => citation(`https://example.test/${i}`)))]),
    completed([nativeCall(Array.from({ length: 2049 }, (_, i) => ({ url: `https://example.test/${i}` })))]),
  ];
  for (const response of oversized) {
    assert.throws(() => normalizeResponsesResponse(response), errorCode('WEB_RESPONSE_TOO_LARGE'));
    assert.throws(() => parseResponsesSSE(sseCompleted(response)), errorCode('WEB_RESPONSE_TOO_LARGE'));
  }
  const replay = Array.from({ length: 257 }, (_, i) => sseEvent({ type: 'response.output_text.annotation.added', output_index: 0, content_index: 0, annotation: citation(`https://example.test/${i}`) })).join('');
  assert.throws(() => parseResponsesSSE(replay), errorCode('WEB_RESPONSE_TOO_LARGE'));
});

test('Copilot changing item IDs route by stable output_index and preserve native sources/citations', () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws-added', status: 'in_progress' } },
    { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws-progress' },
    { type: 'response.output_item.done', output_index: 0, item: { ...nativeCall([{ url: 'https://example.test/native' }]), id: 'ws-done' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-added', status: 'in_progress', content: [] } },
    { type: 'response.output_text.annotation.added', output_index: 1, item_id: 'msg-annotation', content_index: 0, annotation: citation('https://example.test/cited', 'Cited source') },
    { type: 'response.content_part.done', output_index: 1, item_id: 'msg-part', content_index: 0, part: { type: 'output_text', text: 'Grounded answer', annotations: [] } },
    { type: 'response.output_item.done', output_index: 1, item: { ...message('Grounded answer'), id: 'msg-done' } },
    { type: 'response.completed', response: completed([
      { ...nativeCall([]), id: 'ws-terminal' }, { ...message('Grounded answer'), id: 'msg-terminal' },
    ]) },
  ];
  const stream = events.map(sseEvent).join('') + 'data: [DONE]\n\n';
  const result = parseResponsesSSE(stream);
  assert.deepEqual(result, { content: 'Grounded answer', sources: [
    { url: 'https://example.test/native' }, { url: 'https://example.test/cited', title: 'Cited source' },
  ], truncated: false });
  const parser = new ResponsesSSEParser();
  const bytes = encoded(stream);
  for (let i = 0; i < bytes.length; i += 11) parser.push(bytes.subarray(i, i + 11));
  assert.deepEqual(parser.finish(), result);
});

test('ID-only fallback accepts known aliases but never guesses unknown or ambiguous slots', () => {
  const added = { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg-first', content: [] } };
  const part = { type: 'response.content_part.done', output_index: 1, item_id: 'msg-part-alias', content_index: 0,
    part: { type: 'output_text', text: 'Answer', annotations: [] } };
  const annotation = { type: 'response.output_text.annotation.added', item_id: 'msg-part-alias', content_index: 0,
    annotation: citation('https://example.test/alias', 'Alias source') };
  const terminal = sseCompleted(completed([nativeCall([]), { ...message('Answer'), id: 'msg-final' }]));
  const stream = sseEvent({ type: 'response.output_item.done', output_index: 0, item: nativeCall([]) }) + [added, part, annotation].map(sseEvent).join('') + terminal;
  assert.deepEqual(parseResponsesSSE(stream).sources, [{ url: 'https://example.test/alias', title: 'Alias source' }]);
  assert.throws(() => parseResponsesSSE([added, { ...annotation, item_id: 'never-seen' }].map(sseEvent).join('')), errorCode('WEB_INVALID_RESPONSE'));
  const ambiguous = [
    { type: 'response.output_item.added', output_index: 0, item: { ...nativeCall([]), id: 'shared' } },
    { type: 'response.output_item.added', output_index: 1, item: { ...message('Answer'), id: 'shared' } },
  ];
  // Explicit indices remain valid even if a provider reuses an ID across different slots.
  assert.equal(parseResponsesSSE(ambiguous.map(sseEvent).join('') + terminal).content, 'Answer');
  assert.throws(() => parseResponsesSSE([...ambiguous, { ...annotation, item_id: 'shared' }].map(sseEvent).join('')), errorCode('WEB_INVALID_RESPONSE'));
});

test('rewritten IDs do not weaken explicit-index, slot-type or alias-memory bounds', () => {
  const initial = { type: 'response.output_item.added', output_index: 0, item: { ...message(), id: 'known' } };
  for (const output_index of [-1, 0.5, '0', null]) {
    const part = { type: 'response.content_part.done', output_index, item_id: 'known', content_index: 0,
      part: { type: 'output_text', text: 'Answer' } };
    assert.throws(() => parseResponsesSSE([initial, part].map(sseEvent).join('')), errorCode('WEB_INVALID_RESPONSE'));
  }
  assert.throws(() => parseResponsesSSE([initial,
    { type: 'response.output_item.done', output_index: 0, item: { ...nativeCall(), id: 'rewritten' } },
  ].map(sseEvent).join('')), errorCode('WEB_INVALID_RESPONSE'));
  const manyAliases = Array.from({ length: 4097 }, (_, index) => sseEvent({
    type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `alias-${index}`, content: [] },
  })).join('');
  assert.throws(() => parseResponsesSSE(manyAliases), errorCode('WEB_RESPONSE_TOO_LARGE'));
});

test('SSE final response alone is sufficient, duplicates do not duplicate answer text', () => {
  const value = completed();
  assert.deepEqual(parseResponsesSSE(sseCompleted(value)), normalizeResponsesResponse(value));
  const stream = value.output.map((item, output_index) => sseEvent({ type: 'response.output_item.done', output_index, item })).join('') + sseCompleted(value);
  assert.equal(parseResponsesSSE(stream).content, 'Synthetic answer');
});

test('malformed nested/unmatched citation markers preserve ordinary text across JSON and SSE', () => {
  const text = 'before outer inner after unmatched text';
  const value = completed([nativeCall([{ url: 'https://example.test', title: text, snippet: text }]), message(text)]);
  const expected = 'before  after unmatched text';
  const json = normalizeResponsesResponse(value);
  assert.equal(json.content, expected);
  assert.equal(json.sources[0].title, expected);
  assert.equal(json.sources[0].snippet, expected);
  assert.deepEqual(parseResponsesSSE(sseCompleted(value)), json);
});

test('adversarial marker text and tiny SSE fragments finish within a bounded subprocess', () => {
  const responses = new URL('../dist/responses.js', import.meta.url).href;
  const fixtures = new URL('./fixtures.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { normalizeResponsesResponse, parseResponsesJSON, ResponsesSSEParser } from ${JSON.stringify(responses)};
    import { completed, nativeCall, message, sseCompleted, encoded } from ${JSON.stringify(fixtures)};
    const text = '\\uE200'.repeat(131072) + 'ordinary text';
    const value = completed([nativeCall([{url:'https://example.test',title:text,snippet:text}]),message(text)]);
    const json = encoded(JSON.stringify(value));
    assert.ok(json.length < 2097152);
    assert.equal(normalizeResponsesResponse(value).content, 'ordinary text');
    assert.equal(parseResponsesJSON(json, 2097152).sources[0].title, 'ordinary text');
    const parser = new ResponsesSSEParser({maxResponseBytes:2097152});
    const stream = encoded(sseCompleted(completed([nativeCall(),message('x'.repeat(131072))])));
    for (let i=0;i<stream.length;i++) parser.push(stream.subarray(i,i+1));
    assert.equal(parser.finish().content.length,131072);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
