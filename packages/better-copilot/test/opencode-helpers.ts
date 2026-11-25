import type { ModelCatalog } from '../dist/catalog-types.js';

/** Names and prices here are synthetic; no real provider response is embedded. */
export function opencodeItem(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: 'model',
    type: 'chat',
    name: `${id} display`,
    api: {
      'chat-completions': {
        base_url: 'https://opencode.ai/inference/go/openai/v1',
        sdk: { aisdk: '@ai-sdk/openai-compatible' },
        compatibility: { reasoning_field: 'reasoning_content' },
        capabilities: { tools: { choice: ['auto', 'none', 'required', 'tool'], updates: [] } },
      },
    },
    recommended_api: 'chat-completions',
    modalities: { input: ['text', 'image/png'], output: ['text'] },
    capabilities: {
      tools: { supported: true },
      reasoning: { supported: true, effort: ['low', 'high', 'max'] },
      temperature: true,
    },
    limit: { context: 1_000_000, output: 128_000 },
    cost: {
      text: {
        input: { price: 1, cache: { read: 0.1 } },
        output: { price: 2 },
      },
    },
    description: 'synthetic description',
    ...overrides,
  };
}

export function opencodeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Installed pi-ai-shaped descriptors; select keeps these for known ids. */
export function opencodeCatalogFixture(): ModelCatalog {
  const model = (id: string, api: 'openai-completions' | 'anthropic-messages' | 'openai-responses' | 'google-generative-ai', baseUrl: string) => ({
    id,
    name: id,
    api,
    provider: 'opencode-go',
    baseUrl,
    contextWindow: 900_000,
    maxTokens: 64_000,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.1 },
    reasoning: true,
    compat: api === 'openai-completions' ? { thinkingFormat: 'deepseek' as const, supportsStore: false } : undefined,
    headers: { 'X-Installed-Only': 'installed-descriptor-must-not-be-copied' },
  });
  return {
    'glm-5.3': model('glm-5.3', 'openai-completions', 'https://opencode.ai/inference/go/v1'),
    'claude-haiku-5-5': model('claude-haiku-5-5', 'anthropic-messages', 'https://opencode.ai/inference/go'),
    'gpt-6-luna': model('gpt-6-luna', 'openai-responses', 'https://opencode.ai/inference/go/v1'),
    'gemini-4-argon-contributor': model('gemini-4-argon-contributor', 'google-generative-ai', 'https://opencode.ai/inference/go/v1'),
  } as unknown as ModelCatalog;
}

/** The provider-shaped document a live listing would return. */
export function opencodeDocument(...items: Record<string, unknown>[]): { object: 'list'; data: Record<string, unknown>[] } {
  return { object: 'list', data: items };
}
