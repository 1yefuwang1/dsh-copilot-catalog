import { createModels } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';

export const enterprise = 'https://api.enterprise.githubcopilot.com';
export const individual = 'https://api.individual.githubcopilot.com';
export const ghe = 'https://copilot-api.company.ghe.com';
export const gheToken = () => ['test-access-token', 'proxy-ep=copilot-api.company.ghe.com'].join(';');
export const token = (account = 'enterprise') => ['test-access-token', `proxy-ep=proxy.${account}.githubcopilot.com`].join(';');
export const grant = (fields = {}) => ({ kind: 'grant', payload: {
  type: 'oauth', access: token(), refresh: 'test-refresh-token', expires: Date.now() + 3_600_000, ...fields,
} });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Serialized test store with the same undefined-means-unchanged mutation contract. */
export function credentialFixture(initial, { references = {}, beforeMutation } = {}) {
  let record = initial;
  let queue = Promise.resolve();
  const stats = { reads: 0, modifications: 0, writes: 0, references: [] };
  const service = {
    async readRecord(key) {
      if (String(key) !== 'llm-pi-ai/github-copilot') throw new Error('Wrong scoped credential key');
      stats.reads++;
      return record;
    },
    async resolve(ref) {
      stats.references.push(String(ref));
      const value = references[String(ref)];
      return value === undefined ? undefined : { value, source: 'synthetic' };
    },
    async modifyRecord(key, mutate) {
      if (String(key) !== 'llm-pi-ai/github-copilot') throw new Error('Wrong scoped credential key');
      stats.modifications++;
      const operation = queue.then(async () => {
        await beforeMutation?.();
        const next = await mutate(record);
        if (next !== undefined) {
          // Enforce JSON-image normalization without retaining undefined members.
          const image = JSON.parse(JSON.stringify(next));
          if (!deepEqualJson(next, image)) throw new Error('Unrepresentable grant payload');
          record = structuredClone(next);
          stats.writes++;
        }
        return record;
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
  return { service, stats, current: () => record, set: (next) => { record = next; }, drained: () => queue };
}
function deepEqualJson(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]));
}

export function contextFixture(service, ambient = {}) {
  return { get: (name) => name === 'credentials' ? service
    : name === 'launchEnvironment' ? { get: (key) => Object.hasOwn(ambient, key) ? { value: ambient[key], source: 'process' } : undefined }
    : undefined };
}

/** Real public pi-ai collection/provider with synthetic OAuth callbacks only. */
export function runtimeFixture({ refresh, toAuth } = {}) {
  const provider = githubCopilotProvider();
  const original = provider.auth.oauth;
  const oauth = {
    name: 'Synthetic Copilot',
    async login() { throw new Error('Tests must not sign in'); },
    refresh: refresh ?? (async (current) => ({ ...current, access: token(), expires: Date.now() + 3_600_000 })),
    toAuth: toAuth ?? ((current) => original.toAuth(current)),
  };
  return {
    createModels, recordKeyFor,
    provider: { ...provider, auth: { ...provider.auth, oauth } },
    oauth,
    headers: { 'Copilot-Integration-Id': 'vscode-chat', 'User-Agent': 'synthetic-client' },
  };
}
