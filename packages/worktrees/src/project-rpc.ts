import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandlerResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import { abortIfRequested, failureOf, WorktreeError } from './errors.js';
import { required } from './runtime.js';
import { registerQuietRpcRoute } from './quiet-rpc.js';
import { parseProjectRequest, projectJsonSnapshot, type ProjectController, type ProjectRequest } from './projects.js';
import type { CommandEnvelope } from './types.js';

export const PROJECT_RPC_ENDPOINT = 'dsh-worktrees/projects';
type Resolver = Pick<SessionController, 'resolveAgent'>;
export function parseProjectPayload(payload: unknown): { request: ProjectRequest; actorId?: string } {
  const snapshot = projectJsonSnapshot(payload, 'INVALID_RPC_REQUEST');
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected a versioned project request.');
  const value = snapshot as Record<string, unknown>;
  if (value.v !== 1 || !Object.hasOwn(value, 'request') || Object.keys(value).some(key => !['v', 'request', 'actorId'].includes(key))) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected v:1, request and optional actorId only.');
  if (Object.hasOwn(value, 'actorId') && (typeof value.actorId !== 'string' || value.actorId.length < 1 || value.actorId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.actorId))) throw new WorktreeError('INVALID_RPC_REQUEST', 'Invalid invoking session identity.');
  const request = parseProjectRequest(value.request);
  if (request.action === 'bind' && value.actorId === undefined) throw new WorktreeError('INVALID_RPC_REQUEST', 'Binding requires a genuine invoking session.');
  return { request, ...(value.actorId === undefined ? {} : { actorId: value.actorId as string }) };
}
function failure(code: string, message: string): ConnectionRpcHandlerResult { return { ok: false, error: { code, message, details: {} } }; }
function operationFailure(error: unknown): CommandEnvelope {
  if (error instanceof Error && error.name === 'AbortError') return { v: 1, ok: false, error: { code: 'CANCELLED', message: 'The project request was cancelled; committed metadata may remain.' } };
  if (!(error instanceof WorktreeError) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)) return { v: 1, ok: false, error: { code: 'OPERATION_FAILED', message: 'The project operation failed.' } };
  return { v: 1, ok: false, error: failureOf(error) };
}
/** Quiet authenticated UI adapter: no command, prompt, tool event or ambient Agent activation. */
export function registerProjectRpc(owner: Context, controller: Pick<ProjectController, 'execute'>, registerRoute: typeof registerQuietRpcRoute = registerQuietRpcRoute): () => Promise<void> {
  const connection = required<HostConnectionHandle>(owner, 'connection');
  const shutdown = new AbortController(); const flights = new Set<Promise<ConnectionRpcHandlerResult>>();
  let closed = false; let disposal: Promise<void> | undefined;
  const stop = owner.effect(() => {
    const unregister = registerRoute(owner, PROJECT_RPC_ENDPOINT, async (endpoint, payload, requestSignal, peer) => {
      if (endpoint !== PROJECT_RPC_ENDPOINT || peer.id !== connection.operator.id || peer.ctx !== connection.operator.ctx) return failure('FORBIDDEN', 'This request does not belong to the authenticated operator.');
      if (closed) return failure('CLOSED', 'The project UI channel is closing.');
      const signal = AbortSignal.any([requestSignal, shutdown.signal]);
      const task = (async (): Promise<ConnectionRpcHandlerResult> => {
        let input: ReturnType<typeof parseProjectPayload>;
        try { abortIfRequested(signal); input = parseProjectPayload(payload); }
        catch { return signal.aborted ? failure('CANCELLED', 'The project request was cancelled.') : failure('INVALID_RPC_REQUEST', 'The project request is not valid bounded JSON.'); }
        // No omitted actor is inferred from a current tab, operator context, Host or prior thread.
        let resolved: Awaited<ReturnType<Resolver['resolveAgent']>> | undefined;
        if (input.actorId !== undefined) {
          try { resolved = await required<Resolver>(owner, 'sessionController').resolveAgent(SessionId(input.actorId)); }
          catch { return signal.aborted ? failure('CANCELLED', 'The project request was cancelled.') : failure('SESSION_RESOLUTION_FAILED', 'The invoking session could not be resolved.'); }
          if (signal.aborted) return failure('CANCELLED', 'The project request was cancelled.');
          if ('error' in resolved) {
            const messages: Record<string, string> = { 'session/not-found': 'The invoking session was not found.', 'session/agent-busy': 'The invoking session is busy.', 'session/writer-held': 'The invoking session is held by another writer.', 'gateway/internal': 'The invoking session could not be resolved.' };
            return failure(Object.hasOwn(messages, resolved.error.code) ? resolved.error.code : 'SESSION_RESOLUTION_FAILED', messages[resolved.error.code] ?? 'The invoking session could not be resolved.');
          }
          if (resolved.agent.id !== input.actorId) return failure('SESSION_CHANGED', 'The resolved invoking session identity changed.');
        }
        let envelope: CommandEnvelope;
        try {
          abortIfRequested(signal);
          const data = await controller.execute(input.request, { ...(resolved !== undefined && 'agent' in resolved ? { agent: resolved.agent } : {}), origin: 'ui', signal });
          abortIfRequested(signal); envelope = { v: 1, ok: true, data };
        } catch (error) { envelope = operationFailure(error); }
        try { return { ok: true, value: projectJsonSnapshot(envelope, 'RESPONSE_LIMIT') }; }
        catch { return { ok: true, value: operationFailure(new WorktreeError('RESPONSE_LIMIT', 'The project result exceeds its bounded plain JSON response.')) }; }
      })();
      flights.add(task); try { return await task; } finally { flights.delete(task); }
    });
    return () => disposal ??= (async () => { closed = true; shutdown.abort(); try { await unregister(); } finally { await Promise.allSettled([...flights]); } })();
  }, 'worktrees: authenticated quiet projects RPC');
  return () => { const released = stop(); return disposal ??= Promise.resolve(released); };
}
