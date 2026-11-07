import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCopilotTemperature, withCopilotTemperatureSupport } from '../dist/temperature.js';
import { catalogFixture } from './catalog-helpers.js';

function fixture(support: unknown = false) {
  const catalog = catalogFixture();
  catalog['gpt-6-sol'] = withCopilotTemperatureSupport(catalog['gpt-6-sol'], support);
  return catalog;
}

test('only top-level temperature is removed, preserving all other request controls and content', () => {
  for (const temperature of [0, 0.1, 1, 2, null, 'malformed']) {
    const input = { model: 'gpt-6-sol', temperature, stream: true, reasoning: { effort: 'medium' },
      messages: [{ role: 'user', content: 'temperature stays in text', temperature: 7 }],
      tools: [{ type: 'function', parameters: { temperature: { type: 'number' } } }],
      max_output_tokens: 1234, top_p: 0.5, metadata: { purpose: 'review' } };
    const result = normalizeCopilotTemperature(JSON.stringify(input), fixture());
    assert.ok(result);
    const { temperature: _removed, ...expected } = input;
    assert.deepEqual(JSON.parse(result), expected);
    assert.equal(normalizeCopilotTemperature(result, fixture()), undefined);
  }
});

test('supported and unknown metadata preserve the serialized request byte-identically, including zero', () => {
  for (const support of [true, undefined, null, 'false', 0, {}, []]) {
    const body = ' { "model": "gpt-6-sol", "temperature": 0, "stream": true } ';
    const catalog = catalogFixture();
    catalog['gpt-6-sol'] = withCopilotTemperatureSupport(catalog['gpt-6-sol'], support);
    assert.equal(normalizeCopilotTemperature(body, catalog), undefined);
  }
});

test('unknown IDs, foreign providers, absent controls, and malformed bodies are untouched', () => {
  const catalog = fixture();
  catalog.claude = { ...withCopilotTemperatureSupport(catalog.claude, false), provider: 'other-provider' };
  for (const body of ['', 'not json', 'null', '[]', '{}', '{"model":42,"temperature":0}',
    '{"model":"gpt-6-sol"}', '{"model":"claude","temperature":0}',
    '{"model":"unknown-reasoner","temperature":0}', '{"model":"constructor","temperature":0}']) {
    assert.equal(normalizeCopilotTemperature(body, catalog), undefined);
  }
});

test('opaque own model IDs are respected without prototype lookup or family heuristics', () => {
  const catalog = fixture();
  for (const id of ['__proto__', 'constructor', 'unrelated/custom-id']) {
    Object.defineProperty(catalog, id, { value: { ...catalog['gpt-6-sol'], id }, enumerable: true });
    assert.deepEqual(JSON.parse(normalizeCopilotTemperature(JSON.stringify({ model: id, temperature: 0 }), catalog)!), { model: id });
  }
});

test('capability overlay is immutable, boolean-only, and preserves identity when unchanged', () => {
  const model = catalogFixture()['gpt-6-sol'];
  for (const support of [undefined, null, 'false', 0, [], {}]) assert.equal(withCopilotTemperatureSupport(model, support), model);
  const changed = withCopilotTemperatureSupport(model, false);
  assert.notEqual(changed, model);
  assert.notEqual(changed.compat, model.compat);
  assert.equal((model.compat as unknown as Record<string, unknown>).supportsTemperature, undefined);
  assert.deepEqual(changed.compat, { ...model.compat, supportsTemperature: false });
  assert.equal(withCopilotTemperatureSupport(changed, false), changed);
  assert.deepEqual(withCopilotTemperatureSupport(changed, true).compat, { ...model.compat, supportsTemperature: true });
});

// Message histories can exceed the unrelated tool-schema guard's 8 MiB bound.
// Unsupported controls must still be removed rather than silently reintroduced.
test('large SDK requests still omit unsupported temperature', () => {
  const content = 'x'.repeat(8 * 1024 * 1024 + 1);
  const body = JSON.stringify({ model: 'gpt-6-sol', temperature: 0, input: content });
  const result = normalizeCopilotTemperature(body, fixture());
  assert.ok(result);
  assert.deepEqual(JSON.parse(result), { model: 'gpt-6-sol', input: content });
});
