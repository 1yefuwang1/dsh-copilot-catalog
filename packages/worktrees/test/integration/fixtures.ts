import assert from 'node:assert/strict';
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection';

/** Fetch-only synthetic authentication: the SDK still enforces Host/Origin trust.
 * The private BrowserAuth credential machinery is deliberately not instantiated. */
export function syntheticAuth(authority: string, cookie: string, onCall = () => {}) {
  const auth = {
    isAuthenticated(request: Request) {
      onCall();
      assert.ok(request.headers instanceof Headers);
      return request.headers.get('host') === authority && request.headers.get('cookie') === cookie;
    },
  };
  return auth as unknown as ConstructorParameters<typeof HostConnectionService>[2];
}

/** Explicit boundary for JSON/VM replies and heterogeneous synthetic SDK ports.
 * Tests intentionally inspect malformed runtime shapes; fixture records and inputs
 * elsewhere remain typed. Never use this for production controller internals. */
export type DynamicMock = any;

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}

export function hasCode(expected: string) {
  return (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

/** Clone-on-write adapter matching domain table persistence semantics. */
export function memoryTable<T>() {
  const map = new Map<string, T>();
  return {
    map,
    get: (key: string) => map.get(key),
    entries: () => map.entries(),
    async put(key: string, value: T) { map.set(key, structuredClone(value)); },
    async delete(key: string) { return map.delete(key); },
  };
}

export interface FetchOptions {
  rpcId?: string;
  wireMethod?: string;
  httpMethod?: string;
  query?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
}

/** The decoded feature DTO varies by action; runtime validators are tested here. */
export interface RpcReply {
  ok: boolean;
  value: DynamicMock;
  error: { code: string; details: Record<string, unknown> };
}

export interface ClientProtocol {
  decodeReply(reply: RpcReply): DynamicMock;
  projectData(request: unknown, data: unknown): DynamicMock;
  validateData(request: unknown, data: unknown): DynamicMock;
}
