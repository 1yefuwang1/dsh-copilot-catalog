import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_GUARDED_BODY_BYTES } from '../dist/guard.js';
import { guardCopilotRequestBody } from '../dist/guard.js';
import { MAX_TRIMMABLE_BODY_BYTES, normalizeCopilotMessages } from '../dist/messages.js';
import { normalizeCopilotResponsesStrict } from '../dist/strict.js';
import { normalizeCopilotTemperature, withCopilotTemperatureSupport } from '../dist/temperature.js';
import { normalizeCopilotRequest } from '../dist/wire.js';
import { catalogFixture } from './catalog-helpers.js';
import * as fixtures from './guard-fixtures.js';

const CHAT = new URL('https://api.enterprise.githubcopilot.com/chat/completions');
const RESPONSES = new URL('https://api.enterprise.githubcopilot.com/responses');
const FOREIGN = new URL('https://api.deepseek.com/chat/completions');

/**
 * A catalog in which a gemini model rejects `temperature`, so the temperature and
 * tool-schema stages both have something to do on the same request.
 */
function catalog() {
  const base = catalogFixture();
  base['gemini-4-argon'] = withCopilotTemperatureSupport({ ...base['gpt-6-sol'], id: 'gemini-4-argon', name: 'gemini-4-argon' }, false);
  return base;
}

const guard = { providers: ['github-copilot'], families: ['gemini'], logFixes: false };

/** Every stage enabled; individual tests narrow it. */
const stages = (over: Partial<Parameters<typeof normalizeCopilotRequest>[2]> = {}) =>
  ({ catalog: catalog(), toolSchema: guard, dropEmptyMessages: true, ...over });

/** Run `fn` with `JSON.parse` counted, so "one parse" is measured, not assumed. */
function countingParse<T>(run: () => T): { value: T; parses: number } {
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = function counted(...args: Parameters<typeof JSON.parse>) {
    parses += 1;
    return original.apply(JSON, args);
  } as typeof JSON.parse;
  try {
    return { value: run(), parses };
  }
  finally {
    JSON.parse = original;
  }
}

/** Chat body needing all three chat-capable stages at once. */
function everyChatDefect(): string {
  const body = JSON.parse(fixtures.chatBody([fixtures.missingBucketTool]));
  body.temperature = 0.3;
  body.messages.push({ role: 'user', content: '' });
  return JSON.stringify(body);
}

test('one parse serves every stage, and one re-serialization covers every change', () => {
  const body = everyChatDefect();
  const { value, parses } = countingParse(() => normalizeCopilotRequest(CHAT, body, stages()));
  assert.equal(parses, 1, 'the body is parsed exactly once');
  assert.ok(value.body);
  const sent = JSON.parse(value.body);
  assert.equal(Object.hasOwn(sent, 'temperature'), false, 'temperature stage ran');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'synthetic' }], 'message stage ran');
  assert.deepEqual(sent.tools[0].function.parameters.properties, {}, 'tool-schema stage ran');
  assert.equal(value.droppedMessages, 1);
  assert.deepEqual(value.fixedTools, [fixtures.missingBucketTool.name]);
});

test('the composed pass equals the independent normalizers applied in order', () => {
  for (const [url, body] of [
    [CHAT, everyChatDefect()],
    [RESPONSES, (() => { const b = JSON.parse(fixtures.responsesBody([fixtures.missingBucketTool])); b.temperature = 1; return JSON.stringify(b); })()],
  ] as const) {
    // Reference: the original chain, each stage parsing and re-serializing in turn.
    let expected: string | undefined;
    try {
      expected = normalizeCopilotResponsesStrict(url, body);
      expected = normalizeCopilotTemperature(expected ?? body, catalog()) ?? expected;
      const trimmed = normalizeCopilotMessages(url, expected ?? body);
      expected = trimmed.body ?? expected;
      expected = guardCopilotRequestBody(expected ?? body, guard).body ?? expected;
    }
    catch {
      expected = undefined;
    }
    const actual = normalizeCopilotRequest(url, body, stages());
    if (expected === undefined) assert.equal(actual.body, undefined, url.pathname);
    else assert.deepEqual(JSON.parse(actual.body!), JSON.parse(expected), url.pathname);
  }
});

test('a request with nothing to change stays byte-identical', () => {
  const body = fixtures.chatBody([fixtures.conformantTool], 'gemini-4-argon');
  const { value, parses } = countingParse(() => normalizeCopilotRequest(CHAT, body, stages()));
  assert.equal(parses, 1);
  assert.deepEqual(value, { body: undefined, droppedMessages: 0, fixedTools: [], skippedTools: [] });
});

test('each stage keeps its own surface, so neither reaches over into the other', () => {
  // `strict` is a Responses-only default; chat completions never gains it.
  // The temperature stage still fires here, so the body is re-serialized.
  const chat = JSON.parse(fixtures.chatBody([fixtures.missingBucketTool]));
  chat.temperature = 1;
  const chatResult = normalizeCopilotRequest(CHAT, JSON.stringify(chat), stages({ dropEmptyMessages: false }));
  assert.equal(Object.hasOwn(JSON.parse(chatResult.body!).tools[0].function, 'strict'), false);

  // `messages` is a chat-completions-only shape; the Responses surface has none,
  // so an empty user turn there is left exactly where it is. The declaration
  // already states `strict`, which keeps the Responses-only stage quiet and makes
  // the untouched body the proof that nothing else fired.
  const responses = JSON.parse(fixtures.responsesBody([fixtures.conformantTool]));
  responses.tools[0].strict = true;
  responses.messages = [{ role: 'user', content: '' }];
  const responsesResult = normalizeCopilotRequest(RESPONSES, JSON.stringify(responses), stages({ toolSchema: undefined }));
  assert.equal(responsesResult.droppedMessages, 0);
  assert.equal(responsesResult.body, undefined, 'the message stage does not reach the Responses surface');
});

test('an unreadable settings group disables only its own stage', () => {
  const body = everyChatDefect();
  const result = normalizeCopilotRequest(CHAT, body, stages({ toolSchema: undefined }));
  const sent = JSON.parse(result.body!);
  assert.equal(Object.hasOwn(sent, 'temperature'), false, 'temperature still ran');
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'synthetic' }], 'messages still ran');
  assert.deepEqual(sent.tools[0].function.parameters.properties, undefined, 'only the guard was skipped');
  assert.deepEqual(result.fixedTools, []);
});

test('each stage keeps its own body-size bound', () => {
  // Past the guard bound but inside the message bound: messages still apply.
  const filler = { role: 'user', content: 'x'.repeat(1024) };
  const messages = Array.from({ length: 9_000 }, () => filler);
  messages.push({ role: 'user', content: '' });
  const big = JSON.stringify({ model: 'gemini-4-argon', messages, temperature: 0.2 });
  assert.ok(big.length > MAX_GUARDED_BODY_BYTES && big.length <= MAX_TRIMMABLE_BODY_BYTES);
  const bigResult = normalizeCopilotRequest(CHAT, big, stages());
  assert.equal(bigResult.droppedMessages, 1, 'the message stage still applies past the guard bound');
  assert.equal(Object.hasOwn(JSON.parse(bigResult.body!), 'temperature'), false);

  // Past the message bound: that stage steps aside, temperature still applies.
  const huge = JSON.stringify({ model: 'gemini-4-argon', messages: [{ role: 'user', content: '' }], temperature: 1, padding: 'y'.repeat(MAX_TRIMMABLE_BODY_BYTES + 1) });
  const hugeResult = normalizeCopilotRequest(CHAT, huge, stages());
  assert.equal(hugeResult.droppedMessages, 0, 'the message stage respects its bound');
  assert.equal(Object.hasOwn(JSON.parse(hugeResult.body!), 'temperature'), false, 'temperature has no bound of its own');
});

test('foreign origins and malformed bodies are never parsed into a rewrite', () => {
  const body = everyChatDefect();
  const { value, parses } = countingParse(() => normalizeCopilotRequest(FOREIGN, body, stages()));
  assert.deepEqual(value, { body: undefined, droppedMessages: 0, fixedTools: [], skippedTools: [] });
  assert.equal(parses, 0, 'a foreign origin is rejected before parsing');
  for (const malformed of ['', 'not json', 'null', '[]', '"text"', '7']) {
    assert.deepEqual(normalizeCopilotRequest(CHAT, malformed, stages()), { body: undefined, droppedMessages: 0, fixedTools: [], skippedTools: [] });
  }
});

test('the composed pass is idempotent and reports nothing on the second run', () => {
  const first = normalizeCopilotRequest(CHAT, everyChatDefect(), stages());
  assert.ok(first.body);
  const second = normalizeCopilotRequest(CHAT, first.body, stages());
  assert.deepEqual(second, { body: undefined, droppedMessages: 0, fixedTools: [], skippedTools: [] });
});

test('a guarded request with no tool array skips the guard without inventing one', () => {
  const body = JSON.stringify({ model: 'gemini-4-argon', temperature: 1, messages: [{ role: 'user', content: 'hi' }] });
  const result = normalizeCopilotRequest(CHAT, body, stages());
  const sent = JSON.parse(result.body!);
  assert.equal(Object.hasOwn(sent, 'tools'), false);
  assert.deepEqual(result.fixedTools, []);
});
