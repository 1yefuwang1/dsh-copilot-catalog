import { credentialRef, isCredentialRefName, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { WebError } from '@deepseek-ai/dsh-web';
import type { Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';
import { CopilotEndpointError, trustedCopilotOrigin } from './endpoint.js';
import type { CopilotAuthOptions, ResolvedCopilotAuth, SearchContext, SearchRuntime } from './types.js';

const PROVIDER = 'github-copilot';
export type CopilotCredentialService = Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'resolve'>;

const AUTH_FAILURES = {
  aborted: ['Copilot search authentication aborted', 'WEB_ABORTED'],
  invalid: ['The stored Copilot credential is invalid; sign in again', 'WEB_PROVIDER_AUTH_INVALID'],
  writeRefused: ['Copilot search only persists refreshes of existing OAuth grants', 'WEB_PROVIDER_AUTH_WRITE_REFUSED'],
  badReference: ['Invalid Copilot credential reference', 'WEB_PROVIDER_AUTH_INVALID'],
  missingReference: ['The configured Copilot credential reference is unset', 'WEB_PROVIDER_CREDENTIAL_MISSING'],
  badToken: ['Copilot authentication returned an unusable token', 'WEB_PROVIDER_AUTH_INVALID'],
  missingEndpoint: ['An opaque Copilot API key requires an explicit trusted baseURL', 'WEB_PROVIDER_ENDPOINT_MISSING'],
  failed: ['Copilot search authentication failed; check credentials or sign in again', 'WEB_PROVIDER_AUTH_ERROR'],
} as const;

type AuthFailure = keyof typeof AUTH_FAILURES;
/** Closed messages, even if an injected dependency constructs or mutates an owned error. */
export class CopilotAuthError extends WebError {
  readonly kind: AuthFailure;
  constructor(kind: AuthFailure) {
    const safeKind = typeof kind === 'string' && Object.hasOwn(AUTH_FAILURES, kind) ? kind : 'failed';
    const [message, code] = AUTH_FAILURES[safeKind];
    super(message, code);
    this.kind = safeKind;
  }
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CopilotAuthError('aborted');
}
function invalidCredential(): never {
  throw new CopilotAuthError('invalid');
}

function oauthCredential(value: unknown): OAuthCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalidCredential();
  const grant = value as Record<string, unknown>;
  if (grant.type !== 'oauth' || typeof grant.access !== 'string' || !grant.access.trim() || grant.access.length > 16_384 ||
      typeof grant.refresh !== 'string' || !grant.refresh.trim() || grant.refresh.length > 16_384 ||
      /[\u0000-\u0020\u007f-\u009f]/u.test(grant.access) || /[\u0000-\u0020\u007f-\u009f]/u.test(grant.refresh) ||
      typeof grant.expires !== 'number' || !Number.isFinite(grant.expires) || grant.expires < 0) return invalidCredential();
  return structuredClone(grant) as OAuthCredential;
}

/** Read only the credential family owned by the original pi-ai adapter. */
function fromRecord(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined;
  if (record.kind === 'grant') return oauthCredential(record.payload);
  if (record.kind !== 'api-key') return invalidCredential();
  if (record.key !== undefined && (typeof record.key !== 'string' || !record.key.trim())) return invalidCredential();
  if (record.env !== undefined && (typeof record.env !== 'object' || record.env === null ||
      Array.isArray(record.env) || Object.entries(record.env).some(([key, value]) => !isCredentialRefName(key) || typeof value !== 'string'))) {
    return invalidCredential();
  }
  return {
    type: 'api_key',
    ...(record.key === undefined ? {} : { key: record.key }),
    ...(record.env === undefined ? {} : { env: { ...record.env } }),
  };
}

/** Match the adapter's JSON image without laundering nonfinite values or foreign prototypes. */
function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : jsonImage(entry));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined)
      .map(([key, member]) => [key, jsonImage(member)]));
  }
  return value;
}

/**
 * Share the adapter's serialized, cross-process record lock for refresh only.
 * Search has no login/logout capability and cannot create or replace API-key records.
 */
export function createCopilotCredentialStore(
  credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> | undefined,
  key: CredentialKey,
): CredentialStore {
  const read: CredentialStore['read'] = async (providerId, options) => {
    aborted(options?.signal);
    if (providerId !== PROVIDER) return undefined;
    const record = await credentials?.readRecord(key);
    aborted(options?.signal);
    return fromRecord(record);
  };
  return {
    read,
    async list(options) {
      const current = await read(PROVIDER, options);
      return current === undefined ? [] : [{ providerId: PROVIDER, type: current.type }];
    },
    async modify(providerId, mutate, options) {
      aborted(options?.signal);
      if (providerId !== PROVIDER || credentials === undefined) {
        throw new CopilotAuthError('writeRefused');
      }
      const record = await credentials.modifyRecord(key, async (current) => {
        // DSH's lock wait is not cancellable: check again once it actually acquired the lock.
        aborted(options?.signal);
        const previous = fromRecord(current);
        // Capture eligibility and account authority before passing a mutable clone to the SDK.
        const wasOAuth = current?.kind === 'grant' && previous?.type === 'oauth';
        const refreshOwner = previous?.type === 'oauth' ? previous.refresh : undefined;
        const enterpriseOwner = previous?.type === 'oauth' ? previous.enterpriseUrl : undefined;
        const next = await mutate(previous);
        aborted(options?.signal);
        if (next === undefined) return undefined;
        if (!wasOAuth || next.type !== 'oauth') throw new CopilotAuthError('writeRefused');
        const refreshed = oauthCredential(next);
        if (refreshed.refresh !== refreshOwner || refreshed.enterpriseUrl !== enterpriseOwner) {
          throw new CopilotAuthError('writeRefused');
        }
        const payload = jsonImage(refreshed);
        aborted(options?.signal);
        return { kind: 'grant', payload };
      });
      aborted(options?.signal);
      return fromRecord(record);
    },
    async delete() {
      throw new CopilotAuthError('writeRefused');
    },
  };
}

/** Observe late settlement while caller cancellation releases the request promptly. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CopilotAuthError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
  });
}

/** Public pi-ai auth resolution on the same DSH credential record used for inference. */
export function createCopilotAuthResolver(ctx: SearchContext, runtime: SearchRuntime) {
  return async (options: CopilotAuthOptions, signal: AbortSignal): Promise<ResolvedCopilotAuth | undefined> => {
    aborted(signal);
    const work = async (): Promise<ResolvedCopilotAuth | undefined> => {
      const explicitOrigin = options.baseURL === undefined ? undefined : trustedCopilotOrigin(options.baseURL);
      if (options.apiKeyEnv !== undefined && !isCredentialRefName(options.apiKeyEnv)) {
        throw new CopilotAuthError('badReference');
      }
      // Snapshot both storage and launch environment for this operation, not startup.
      const credentials = ctx.get('credentials');
      const environment = launchEnvironmentOf(ctx);
      const readReference = async (name: string) => {
        aborted(signal);
        if (!isCredentialRefName(name)) return undefined;
        const hit = await credentials?.resolve(credentialRef(name));
        aborted(signal);
        return hit?.value ?? environment.get(name)?.value;
      };
      const apiKey = options.apiKeyEnv === undefined ? undefined : await readReference(options.apiKeyEnv);
      aborted(signal);
      if (options.apiKeyEnv !== undefined && (typeof apiKey !== 'string' || !apiKey.trim())) {
        throw new CopilotAuthError('missingReference');
      }
      const models = runtime.createModels({
        credentials: createCopilotCredentialStore(credentials, runtime.recordKeyFor(PROVIDER)),
        authContext: { env: readReference, fileExists: async () => false },
      });
      models.setProvider(runtime.provider);
      const resolved = await models.getAuth(PROVIDER, { signal, ...(apiKey === undefined ? {} : { apiKey }) });
      aborted(signal);
      if (resolved === undefined) return undefined;
      const token = resolved.auth.apiKey;
      if (typeof token !== 'string' || !token.trim() || token.length > 16_384 || /[\u0000-\u0020\u007f-\u009f]/u.test(token)) {
        throw new CopilotAuthError('badToken');
      }
      // OAuth's account endpoint owns routing; an explicit origin is an API-key setting only.
      let baseUrl = resolved.auth.baseUrl ?? explicitOrigin;
      if (baseUrl === undefined && /(?:^|;)proxy-ep=[^;]+/u.test(token)) {
        const derived = await runtime.oauth.toAuth({ type: 'oauth', access: token, refresh: '', expires: 0 });
        aborted(signal);
        baseUrl = derived.baseUrl;
      }
      if (baseUrl === undefined) {
        throw new CopilotAuthError('missingEndpoint');
      }
      const origin = trustedCopilotOrigin(baseUrl);
      aborted(signal);
      return { apiKey: token, baseUrl: origin, headers: runtime.headers };
    };
    try {
      return await abortable(work(), signal);
    } catch (error) {
      aborted(signal);
      // Error classification and getters can themselves throw; never expose that exception.
      let controlled: WebError | undefined;
      try {
        if (error instanceof CopilotAuthError) controlled = new CopilotAuthError(error.kind);
        else if (error instanceof CopilotEndpointError) controlled = new CopilotEndpointError();
      } catch { /* malformed host dependency errors degrade to the fixed auth failure */ }
      throw controlled ?? new CopilotAuthError('failed');
    }
  };
}
