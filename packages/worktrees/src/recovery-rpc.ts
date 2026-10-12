import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandlerResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { required } from './runtime.js';
import { registerQuietRpcRoute } from './quiet-rpc.js';
import { parseRequest } from './schema.js';
import { projectJsonSnapshot } from './projects.js';
import { abortIfRequested, failureOf, WorktreeError } from './errors.js';
import type { WorktreeCleanup } from './cleanup.js';
import type { WorktreeRequest } from './types.js';

export const RECOVERY_RPC_ENDPOINT = 'dsh-worktrees/recovery';
export function parseRecoveryPayload(payload: unknown): { request: WorktreeRequest; after?: number } {
  const value = projectJsonSnapshot(payload, 'INVALID_RPC_REQUEST');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected a versioned recovery request.');
  const input = value as Record<string, unknown>;
  if (input.v !== 1 || !Object.hasOwn(input, 'request') || Object.keys(input).some(key => !['v', 'request', 'after'].includes(key))) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected v:1, request, and optional lifecycle cursor only.');
  const request = parseRequest(input.request);
  if (!['reopen-info', 'reopen'].includes(request.action)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Only reclaimed-thread inspection and explicit Local recovery are supported.');
  if (Object.hasOwn(input, 'after') && (request.action !== 'reopen-info' || request.cursor !== undefined || request.limit !== undefined || typeof input.after !== 'number' || !Number.isSafeInteger(input.after) || input.after < 0)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Lifecycle observation requires a nonnegative safe revision and no branch-page cursor.');
  return { request, ...(input.after === undefined ? {} : { after: input.after as number }) };
}
/** Operator-owned recovery reads the historical source cold, never resolveAgent(oldId).
 * Actual Git switches still use the REAL replacement Agent's current policy.
 */
export function registerRecoveryRpc(owner: Context, controller: Pick<WorktreeCleanup, 'info' | 'wait' | 'reopen'>, registerRoute: typeof registerQuietRpcRoute = registerQuietRpcRoute): () => Promise<void> {
  const connection = required<HostConnectionHandle>(owner, 'connection');
  const shutdown = new AbortController(), flights = new Set<Promise<ConnectionRpcHandlerResult>>();
  let closed = false, disposal: Promise<void> | undefined;
  const failure = (code: string, message: string): ConnectionRpcHandlerResult => ({ ok: false, error: { code, message, details: {} } });
  const stop = owner.effect(() => {
    const unregister = registerRoute(owner, RECOVERY_RPC_ENDPOINT, async (endpoint, payload, requestSignal, peer) => {
      if (endpoint !== RECOVERY_RPC_ENDPOINT || peer.id !== connection.operator.id || peer.ctx !== connection.operator.ctx) return failure('FORBIDDEN', 'This request does not belong to the authenticated operator.');
      if (closed) return failure('CLOSED', 'The recovery UI channel is closing.');
      if (flights.size >= 128) return failure('WAITER_LIMIT', 'The recovery request capacity is exhausted.');
      const signal = AbortSignal.any([requestSignal, shutdown.signal]);
      const task = (async (): Promise<ConnectionRpcHandlerResult> => {
        try {
          abortIfRequested(signal); const input = parseRecoveryPayload(payload);
          const data = input.request.action === 'reopen'
            ? await controller.reopen(input.request, { origin: 'ui', signal })
            : input.after === undefined
              ? await controller.info(input.request.sourceSessionId!, signal, input.request)
              : await controller.wait(input.request.sourceSessionId!, input.after, signal);
          abortIfRequested(signal);
          return { ok: true, value: projectJsonSnapshot({ v: 1, ok: true, data }, 'RESPONSE_LIMIT') };
        } catch (error) {
          const result = error instanceof WorktreeError || (error instanceof Error && error.name === 'AbortError') ? failureOf(error) : { code: 'OPERATION_FAILED', message: 'The recovery operation failed.' };
          return { ok: true, value: { v: 1, ok: false, error: result } };
        }
      })();
      flights.add(task); try { return await task; } finally { flights.delete(task); }
    });
    return () => disposal ??= (async () => { closed = true; shutdown.abort(); try { await unregister(); } finally { await Promise.allSettled([...flights]); } })();
  }, 'worktrees: authenticated cold recovery RPC');
  return () => { const released = stop(); return disposal ??= Promise.resolve(released); };
}
