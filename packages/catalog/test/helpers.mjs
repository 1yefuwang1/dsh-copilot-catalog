export function catalogFixture() {
  const model = (id, api = 'openai-responses') => ({
    id, name: id, provider: 'github-copilot', api,
    baseUrl: 'https://api.individual.githubcopilot.com',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000, maxTokens: 32000,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
    headers: { 'Editor-Version': 'vscode/test', Authorization: 'must-not-win' },
    thinkingLevelMap: { off: 'none', minimal: 'minimal', xhigh: 'xhigh', max: 'max' },
    compat: { supportsStrictMode: true },
  });
  return {
    'gpt-6-sol': model('gpt-6-sol'),
    'gpt-5.6-sol': model('gpt-5.6-sol'),
    claude: model('claude', 'anthropic-messages'),
  };
}

export function accountItem(id, overrides = {}) {
  return {
    id, name: id, model_picker_enabled: true, policy: { state: 'enabled' },
    supported_endpoints: ['/responses'],
    capabilities: {
      limits: { max_context_window_tokens: 1000000, max_output_tokens: 128000 },
      supports: { vision: true, tool_calls: true, reasoning_effort: ['medium', 'high', 'xhigh', 'max'] },
    },
    ...overrides,
  };
}

export function grantFixture(overrides = {}) {
  return { kind: 'grant', payload: {
    type: 'oauth', access: 'test-access-token', refresh: 'test-refresh-token',
    expires: Date.now() + 60 * 60_000, ...overrides,
  } };
}

export function discoveryFixture(overrides = {}) {
  const catalog = catalogFixture();
  const record = grantFixture();
  const requests = [];
  const credentials = {
    async readRecord(key) { requests.push(['read', key]); return record; },
    writeRecord() { throw new Error('Discovery must never persist credentials'); },
    modifyRecord() { throw new Error('Discovery must never persist credentials'); },
    deleteRecord() { throw new Error('Discovery must never delete credentials'); },
  };
  const options = {
    catalog, recordKey: 'test-record-key',
    oauth: {
      async refresh(value) { return { ...value, access: 'refreshed-in-memory' }; },
      async toAuth(value) { return { apiKey: value.access, baseUrl: 'https://api.enterprise.githubcopilot.com' }; },
    },
    async fetcher(url, init) {
      requests.push(['fetch', url, init]);
      return { ok: true, async json() { return { data: [accountItem('gpt-6-sol')] }; } };
    },
    ...overrides,
  };
  return { catalog, record, requests, credentials, options };
}
