import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TRIMMABLE_BODY_BYTES, normalizeCopilotMessages } from '../dist/messages.js';

const URL_CHAT = new URL('https://api.enterprise.githubcopilot.com/chat/completions');
const URL_CHAT_DEEP = new URL('https://api.enterprise.githubcopilot.com/chat/completions/custom');
const URL_RESPONSES = new URL('https://api.enterprise.githubcopilot.com/responses');
const URL_MESSAGES = new URL('https://api.enterprise.githubcopilot.com/v1/messages');
const URL_FOREIGN = new URL('https://api.deepseek.com/chat/completions');

const body = (messages: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: 'gemini-4-neon', stream: true, messages, ...extra });

/** The recorded failure: a content-less retry turn persisted into the history. */
const retryTurn = { role: 'user', content: '' };

test('the persisted empty retry turn is removed and the rest of the request is preserved', () => {
  const input = body([
    { role: 'user', content: 'Investigate this' },
    { role: 'assistant', content: 'Working on it' },
    retryTurn,
  ], { max_tokens: 64000, reasoning_effort: 'xhigh' });
  for (const url of [URL_CHAT, URL_CHAT_DEEP]) {
    const result = normalizeCopilotMessages(url, input);
    assert.equal(result.dropped, 1);
    assert.deepEqual(JSON.parse(result.body!), {
      model: 'gemini-4-neon',
      stream: true,
      messages: [
        { role: 'user', content: 'Investigate this' },
        { role: 'assistant', content: 'Working on it' },
      ],
      max_tokens: 64000,
      reasoning_effort: 'xhigh',
    });
  }
});

test('every measured-fatal role is repaired', () => {
  for (const role of ['user', 'system', 'developer']) {
    const result = normalizeCopilotMessages(URL_CHAT, body([{ role, content: '' }, { role: 'user', content: 'hi' }]));
    assert.equal(result.dropped, 1, role);
    assert.deepEqual(JSON.parse(result.body!).messages, [{ role: 'user', content: 'hi' }]);
  }
});

test('content shapes Copilot tolerates are never rewritten', () => {
  // The same route decodes all of these, so a valid body stays byte-identical.
  const tolerated = [
    [{ role: 'user', content: ' ' }],
    [{ role: 'user', content: [] }],
    [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    [{ role: 'assistant', content: '' }],
    [{ role: 'tool', tool_call_id: 'c1', content: '' }],
    [{ role: 'user' }],
    [{ role: 'user', content: 0 }],
  ];
  for (const messages of tolerated) {
    const input = body(messages);
    assert.deepEqual(normalizeCopilotMessages(URL_CHAT, input), { body: undefined, dropped: 0 }, JSON.stringify(messages));
  }
});

test('an all-empty history is left byte-identical rather than traded for another rejection', () => {
  const input = body([retryTurn]);
  assert.deepEqual(normalizeCopilotMessages(URL_CHAT, input), { body: undefined, dropped: 0 });
});

test('a body with nothing to repair stays byte-identical, including its formatting', () => {
  const input = ' {"model": "gemini-4-neon", "messages": [ {"role": "user", "content": "hi"} ]} ';
  assert.deepEqual(normalizeCopilotMessages(URL_CHAT, input), { body: undefined, dropped: 0 });
  // Idempotent: a repaired body is not parsed a second time into a new string.
  const repaired = normalizeCopilotMessages(URL_CHAT, body([retryTurn, { role: 'user', content: 'hi' }]));
  assert.ok(repaired.body);
  assert.deepEqual(normalizeCopilotMessages(URL_CHAT, repaired.body), { body: undefined, dropped: 0 });
});

test('other surfaces and providers are never rewritten', () => {
  for (const url of [URL_RESPONSES, URL_MESSAGES, URL_FOREIGN]) {
    const input = body([retryTurn, { role: 'user', content: 'hi' }]);
    assert.equal(normalizeCopilotMessages(url, input).body, undefined, url.toString());
  }
});

test('malformed and unrelated bodies are untouched', () => {
  for (const input of ['', 'not json', 'null', '[]', '{}', '{"messages":null}', '{"messages":{}}', '{"input":"hi","messages":"not an array"}']) {
    assert.deepEqual(normalizeCopilotMessages(URL_CHAT, input), { body: undefined, dropped: 0 });
  }
});

test('null and primitive entries inside the message array are preserved', () => {
  const input = body([null, 7, retryTurn, { role: 'user', content: 'hi' }]);
  const result = normalizeCopilotMessages(URL_CHAT, input);
  assert.equal(result.dropped, 1);
  assert.deepEqual(JSON.parse(result.body!).messages, [null, 7, { role: 'user', content: 'hi' }]);
});

test('several empty turns are removed in one pass and the count is reported', () => {
  const result = normalizeCopilotMessages(URL_CHAT, body([
    retryTurn, { role: 'user', content: 'hi' }, { role: 'system', content: '' }, { role: 'user', content: 'again' },
  ]));
  assert.equal(result.dropped, 2);
  assert.deepEqual(JSON.parse(result.body!).messages, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'again' },
  ]);
});

// A long conversation is the case this repair exists for: the recorded failure
// carried a multi-megabyte history, far past the tool-schema guard's 8 MiB bound.
test('long histories still get their empty turn removed', () => {
  const turn = { role: 'user', content: 'x'.repeat(1024) };
  const messages = Array.from({ length: 9_000 }, () => turn);
  messages.push(retryTurn);
  const input = body(messages);
  assert.ok(input.length > 8 * 1024 * 1024, 'the case is past the tool-schema guard bound');
  assert.equal(normalizeCopilotMessages(URL_CHAT, input).dropped, 1);
});

test('bodies past the parser bound are skipped without a rewrite', () => {
  const input = body([retryTurn], { padding: 'x'.repeat(MAX_TRIMMABLE_BODY_BYTES) });
  assert.deepEqual(normalizeCopilotMessages(URL_CHAT, input), { body: undefined, dropped: 0 });
});
