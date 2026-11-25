import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeOpencodeMetadata } from '../dist/catalog-cache.js';
import {
  DEFAULT_OPENCODE_GO_MODELS_URL,
  normalizeOpencodeCatalog,
  opencodeGoListingUrl,
  selectOpencodeModels,
  type OpencodeMetadata,
} from '../dist/opencode.js';
import { opencodeCatalogFixture, opencodeDocument, opencodeItem } from './opencode-helpers.js';

test('listing URL honors the public default, a versioned baseURL and a bare gateway root', () => {
  assert.equal(opencodeGoListingUrl().href, DEFAULT_OPENCODE_GO_MODELS_URL);
  assert.equal(opencodeGoListingUrl('https://opencode.ai/inference/go').href,
    'https://opencode.ai/inference/go/v1/models');
  assert.equal(opencodeGoListingUrl('https://opencode.ai/inference/go/v1').href,
    'https://opencode.ai/inference/go/v1/models');
  assert.equal(opencodeGoListingUrl('https://gateway.example.com/v1/').href, 'https://gateway.example.com/v1/models');
  assert.equal(opencodeGoListingUrl('https://gateway.example.com/').href, 'https://gateway.example.com/v1/models');
  for (const invalid of ['http://opencode.ai/inference/go', 'https://' + 'user:secret@opencode.ai/inference/go',
    'https://opencode.ai:8443/inference/go', 'https://opencode.ai/inference/go?v=1', 'not a url']) {
    assert.throws(() => opencodeGoListingUrl(invalid), /Invalid OpenCode Go endpoint/u);
  }
});

test('normalization maps the public listing to bounded chat metadata and skips non-chat entries', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('synthetic-chat'),
    opencodeItem('synthetic-chat', { type: 'embedding' }),
    opencodeItem('synthetic-embedding', { type: 'embedding' }),
    opencodeItem('synthetic-decision', { type: 'decision' }),
    opencodeItem('synthetic-chat'),
  ));
  assert.ok(normalized);
  assert.deepEqual(normalized.data.map((entry) => entry.id), ['synthetic-chat']);
  const [entry] = normalized.data;
  assert.ok(entry);
  assert.deepEqual(entry.apis, ['openai-completions']);
  assert.equal(entry.recommended, 'openai-completions');
  assert.equal(entry.reasoningField, 'reasoning_content');
  assert.equal(entry.context, 1_000_000);
  assert.equal(entry.maxOutput, 128_000);
  assert.equal(entry.images, true);
  assert.equal(entry.tools, true);
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.thinking, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
  });
  assert.equal(entry.temperature, true);
  assert.deepEqual(entry.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
});

test('normalization records reasons instead of inventing missing capacity or exposing unknown protocols', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('no-context', { limit: {} }),
    opencodeItem('no-output', { limit: { context: 100_000 } }),
    opencodeItem('clamped-output', { limit: { context: 50_000, output: 90_000 } }),
    opencodeItem('unknown-api', { api: { 'some-future-api': {} }, recommended_api: 'some-future-api' }),
    opencodeItem('no-tools', { capabilities: { tools: { supported: false }, reasonings: {} } }),
  ));
  assert.ok(normalized);
  assert.deepEqual(normalized.unsupported, ['no-context']);
  const byId = new Map(normalized.data.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('no-output')!.maxOutput, 100_000, 'capacity defaults stay inside the context window');
  assert.equal(byId.get('clamped-output')!.maxOutput, 50_000);
  assert.deepEqual(byId.get('unknown-api')!.apis, []);
  assert.equal(byId.get('no-tools')!.tools, false);
});

test('reasoning maps keep off and only advertised levels, and toggle-only models stay reasoning-capable', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('off-effort', { capabilities: {
      tools: { supported: true }, temperature: true,
      reasoning: { supported: true, effort: ['none', 'minimal', 'medium', 'xhigh'] },
    } }),
    opencodeItem('toggle-only', { capabilities: {
      tools: { supported: true }, temperature: true, reasoning: { supported: true, toggle: true },
    } }),
    opencodeItem('no-reasoning', { capabilities: {
      tools: { supported: true }, temperature: true, reasoning: { supported: false, effort: ['high'] },
    } }),
  ));
  assert.ok(normalized);
  const byId = new Map(normalized.data.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('off-effort')!.thinking, {
    off: 'none', minimal: 'minimal', low: null, medium: 'medium', high: null, xhigh: 'xhigh', max: null,
  });
  assert.equal(byId.get('toggle-only')!.reasoning, true);
  assert.equal(byId.get('toggle-only')!.thinking, undefined);
  assert.equal(byId.get('no-reasoning')!.reasoning, false);
  assert.equal(byId.get('no-reasoning')!.thinking, undefined);
});

test('cost mapping converts retention write maps, context overrides and partial tiers', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(opencodeItem('priced', {
    cost: { text: {
      input: {
        price: 2,
        cache: { read: 0.2, write: { '30m': 0.75, '12h': 1.5 } },
        overrides: [
          { when: { context: { gt: 200_000 } }, price: 4, cache: { read: 0.4, write: 2 } },
          { when: { context: { gt: 100_000 } }, price: 3 },
        ],
      },
      output: {
        price: 6,
        overrides: [{ when: { context: { gt: 200_000 } }, price: 12 }],
      },
      multipliers: [{ when: { utc_days: {} }, factor: 2 }],
    } },
  })));
  assert.ok(normalized);
  const cost = normalized.data[0]!.cost;
  assert.equal(cost.input, 2);
  assert.equal(cost.output, 6);
  assert.equal(cost.cacheRead, 0.2);
  assert.equal(cost.cacheWrite, 0.75, 'the cheapest retention tier represents the write rate');
  assert.deepEqual(cost.tiers, [
    { inputTokensAbove: 100_000, input: 3, output: 6, cacheRead: 0.2, cacheWrite: 0.75 },
    { inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 2 },
  ]);
});

test('selection keeps installed descriptors, rebuilds only new ids and drops withdrawn models', () => {
  const baseline = opencodeCatalogFixture();
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('glm-5.3'),
    opencodeItem('kimi-k3.1-pro', {
      limit: { context: 1_048_576, output: 1_048_576 },
      cost: { text: { input: { price: 2, cache: { read: 0.2, write: 2 } }, output: { price: 10 } } },
    }),
  ));
  assert.ok(normalized);
  const selection = selectOpencodeModels(normalized.data, baseline);
  assert.deepEqual(Object.keys(selection.models), ['glm-5.3', 'kimi-k3.1-pro']);
  assert.equal(selection.models['glm-5.3'], baseline['glm-5.3'], 'installed compatibility metadata is preserved');
  const discovered = selection.models['kimi-k3.1-pro']!;
  assert.equal(discovered.api, 'openai-completions');
  assert.equal(discovered.provider, 'opencode-go');
  assert.equal(discovered.baseUrl, 'https://opencode.ai/inference/go/v1');
  assert.equal(discovered.contextWindow, 1_048_576);
  assert.equal(discovered.maxTokens, 1_048_576);
  assert.deepEqual(discovered.input, ['text', 'image']);
  assert.deepEqual(discovered.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
  });
  assert.deepEqual(discovered.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 });
  assert.deepEqual((discovered.compat as Record<string, unknown>).thinkingFormat, 'deepseek');
  assert.equal((discovered.inputLimits?.images?.resize)?.maxWidth, 2000);
});

test('new ids choose the recommended wire protocol and protocol-specific compatibility', () => {
  const baseline = opencodeCatalogFixture();
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('new-responses', {
      api: { responses: {}, 'chat-completions': {} }, recommended_api: 'responses',
    }),
    opencodeItem('new-gemini', {
      api: { 'generate-content': {}, interactions: {} }, recommended_api: 'interactions',
      capabilities: { tools: { supported: true }, temperature: false, reasoning: { supported: true, effort: ['low', 'high'] } },
    }),
    opencodeItem('new-messages', {
      api: { messages: {} }, recommended_api: 'messages',
      capabilities: { tools: { supported: true }, temperature: false, reasoning: { supported: true, effort: ['low', 'max'] } },
    }),
  ));
  assert.ok(normalized);
  const models = selectOpencodeModels(normalized.data, baseline).models;
  const responses = models['new-responses']!;
  assert.equal(responses.api, 'openai-responses');
  assert.deepEqual(responses.compat, { sessionAffinityFormat: 'openai-nosession' });
  assert.equal(responses.baseUrl, 'https://opencode.ai/inference/go/v1');
  const gemini = models['new-gemini']!;
  assert.equal(gemini.api, 'google-generative-ai', 'unsupported recommended APIs fall back to an installed protocol');
  assert.equal(gemini.compat, undefined);
  assert.equal(gemini.baseUrl, 'https://opencode.ai/inference/go/v1');
  const messages = models['new-messages']!;
  assert.equal(messages.api, 'anthropic-messages');
  assert.deepEqual(messages.compat, { supportsTemperature: false });
  assert.equal(messages.baseUrl, 'https://opencode.ai/inference/go');
});

test('unsupported listings and tool-less models are reported instead of widening the catalog', () => {
  const baseline = opencodeCatalogFixture();
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('glm-5.3'),
    opencodeItem('no-protocol', { api: { 'some-future-api': {} } }),
    opencodeItem('no-tools', { capabilities: { tools: { supported: false }, temperature: true } }),
  ));
  assert.ok(normalized);
  const selection = selectOpencodeModels(normalized.data, baseline);
  assert.deepEqual(Object.keys(selection.models), ['glm-5.3']);
  assert.deepEqual(selection.unsupported, ['no-protocol', 'no-tools']);
  assert.throws(() => selectOpencodeModels([], baseline), /No supported OpenCode Go chat models/u);
  assert.equal(normalizeOpencodeCatalog({ data: [] }), undefined);
  assert.throws(() => selectOpencodeModels(normalized.data, undefined as never), /installed OpenCode Go catalog/u);
});

test('normalized metadata is already canonical and survives the cache sanitizer byte for byte', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(
    opencodeItem('synthetic-chat'),
    opencodeItem('synthetic-reasoning', {
      api: { messages: {} }, recommended_api: 'messages',
      capabilities: { tools: { supported: true }, temperature: false, reasoning: { supported: true, toggle: true } },
    }),
  ));
  assert.ok(normalized);
  const document = { data: normalized.data as unknown as Record<string, unknown>[] };
  const sanitized = sanitizeOpencodeMetadata(document);
  assert.ok(sanitized);
  assert.deepEqual(sanitized, document);
  assert.deepEqual(sanitizeOpencodeMetadata(sanitized), sanitized);
});

test('cache sanitization rejects unknown fields, illegal shapes and duplicate capacity ambiguity', () => {
  const normalized = normalizeOpencodeCatalog(opencodeDocument(opencodeItem('synthetic-chat')));
  assert.ok(normalized);
  const [entry] = normalized.data;
  assert.ok(entry);
  const withField = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...entry, ...overrides });
  for (const value of [
    { data: [] },
    { data: [withField({ unknown: true })] },
    { data: [withField({ id: 'bad id' })] },
    { data: [withField({ context: 0 })] },
    { data: [withField({ maxOutput: 2_000_000 })] },
    { data: [withField({ apis: ['openai-completions', 'openai-completions'] })] },
    { data: [withField({ apis: ['future-protocol'] })] },
    { data: [withField({ recommended: 'anthropic-messages' })] },
    { data: [withField({ reasoningField: 'other_reasoning' })] },
    { data: [withField({ thinking: { off: 'none' } })] },
    { data: [withField({ cost: { input: 1, output: 2, cacheRead: 0.1 } })] },
    { data: [withField({ cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, tiers: [] } })] },
    { data: [withField({ cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0,
      tiers: [{ inputTokensAbove: 100, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        { inputTokensAbove: 50, input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }] } })] },
  ]) assert.equal(sanitizeOpencodeMetadata(value), undefined);
  assert.equal(sanitizeOpencodeMetadata({ data: Array.from({ length: 513 }, () => entry) }), undefined);
  assert.equal(sanitizeOpencodeMetadata(Object.create({ data: [entry] })), undefined);
});

test('canonical metadata is independent of provider field order and ignores provider-only fields', () => {
  const left = normalizeOpencodeCatalog(opencodeDocument({
    ...opencodeItem('synthetic-chat'),
  }))!;
  const right = normalizeOpencodeCatalog(opencodeDocument({
    ...opencodeItem('synthetic-chat'),
    description: 'ignored',
    family: 'ignored',
    cost: {
      text: { input: { price: 1, cache: { read: 0.1 } }, output: { price: 2 } },
      multipliers: [{ when: { utc_days: { in: ['mon'] } }, factor: 9 }],
    },
    go: { monthly_usage: { go: 100 } },
  }))!;
  const asDocument = (data: OpencodeMetadata[]): Record<string, unknown>[] => data as unknown as Record<string, unknown>[];
  assert.deepEqual(asDocument(left.data), asDocument(right.data));
});
