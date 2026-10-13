import type { CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { CopilotCredentialService } from '../dist/auth.js';
import type { SearchContext } from '../dist/types.js';
import { createModels, type OAuthAuth, type OAuthCredential } from '@earendil-works/pi-ai';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai';
export interface FixtureGrantPayload extends OAuthCredential { availableModelIds?: string[]; enterpriseUrl?: string }
export interface FixtureGrant { kind: 'grant'; payload: FixtureGrantPayload }
export interface CredentialFixtureOptions { references?: Record<string, string>; beforeMutation?: () => Promise<void> }
export interface RuntimeFixtureOptions {
  refresh?: (current: FixtureGrantPayload, signal: AbortSignal) => Promise<FixtureGrantPayload>;
  toAuth?: OAuthAuth['toAuth'];
}


export const enterprise = 'https://api.enterprise.githubcopilot.com';
export const individual = 'https://api.individual.githubcopilot.com';
export const ghe = 'https://copilot-api.company.ghe.com';
export const gheToken = () => ['test-access-token', 'proxy-ep=copilot-api.company.ghe.com'].join(';');
export const token = (account = 'enterprise') => ['test-access-token', `proxy-ep=proxy.${account}.githubcopilot.com`].join(';');
export const grant = (fields: Partial<FixtureGrantPayload> = {}): FixtureGrant => ({ kind: 'grant', payload: {
  type: 'oauth', access: token(), refresh: 'test-refresh-token', expires: Date.now() + 3_600_000, ...fields,
} });
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Serialized test store with the same undefined-means-unchanged mutation contract. */
export function credentialFixture<T extends CredentialRecord | undefined>(initial: T, { references = {}, beforeMutation }: CredentialFixtureOptions = {}) {
  let record: CredentialRecord | undefined = initial;
  let queue = Promise.resolve();
  const stats = { reads: 0, modifications: 0, writes: 0, references: [] as string[] };
  const service: CopilotCredentialService = {
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
          const image: unknown = JSON.parse(JSON.stringify(next));
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
  // Tests preserve the owner's record shape except when explicitly simulating logout.
  return { service, stats, current: () => record as T,
    set: (next: CredentialRecord | undefined) => { record = next; }, drained: () => queue };
}
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqualJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function contextFixture(service: CopilotCredentialService, ambient: Record<string, string> = {}) {
  return { get: (name: string) => name === 'credentials' ? service
    : name === 'launchEnvironment' ? { get: (key: string) => Object.hasOwn(ambient, key) ? { value: ambient[key], source: 'process' } : undefined }
    : undefined };
}

/** Real public pi-ai collection/provider with synthetic OAuth callbacks only. */
export function runtimeFixture({ refresh, toAuth }: RuntimeFixtureOptions = {}) {
  const provider = githubCopilotProvider();
  const original = provider.auth.oauth;
  if (!original) throw new Error('Expected the public Copilot OAuth handler');
  const oauth: OAuthAuth = {
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

/** Cordis contexts are dynamic service containers. The mock exposes only the
 * services the auth seam reads, not Cordis lifecycle internals. */
export function authContext<T extends ReturnType<typeof contextFixture>>(context: T): SearchContext {
  return context as unknown as SearchContext;
}

/** A real resolver may report missing credentials; successful test paths require auth. */
export function requireAuth<T>(auth: T | undefined): T {
  if (auth === undefined) throw new Error('Expected resolved synthetic authentication');
  return auth;
}
