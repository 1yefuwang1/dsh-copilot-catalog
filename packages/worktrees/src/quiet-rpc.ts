import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema, type ConnectionRpcHandler, type ConnectionRpcHandlerResult, type HostConnectionHandle, type PeerScope } from '@deepseek-ai/dsh-client-connection';
import { required } from './runtime.js';

/** Payloads retain their existing 1 MiB bound; allow only bounded wire-envelope headroom. */
const MAX_BODY_BYTES = 1048576 + 4096;
function failure(code: string, message: string): ConnectionRpcHandlerResult {
  return { ok: false, error: { code, message, details: {} } };
}
function response(rpcId: string, result: ConnectionRpcHandlerResult): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}
async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new Error('cancelled');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error('limit');
  if (request.body === null) throw new Error('json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // Observe even a late abort after a completed read, without extending teardown.
  void aborted.catch(() => undefined);
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => cancellation ??= reader.cancel().catch(() => undefined);
  const abort = () => { rejectAbort(new Error('cancelled')); void cancelReader(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) { void cancelReader(); throw new Error('limit'); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw new Error('cancelled');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    if (cancellation !== undefined) await cancellation;
    reader.releaseLock();
  }
}

/** The plugin UI is reachable only from the Host's shared browser peer.
 * API credentials may admit other owner principals, so identity alone is not
 * enough: the caller must be that one browser peer.
 */
export function isBrowserPeer(connection: HostConnectionHandle, peer: PeerScope): boolean {
  return peer.principal.kind === 'owner' && peer.id === connection.browserPeer.id && peer.ctx === connection.browserPeer.ctx;
}

/**
 * A feature owns exact POST routes, never the singleton /api interceptor owned
 * by the API gateway. Keep Connection's public envelope and the shared browser
 * peer, and keep the request body streaming so a rejected caller is refused
 * before its payload is read.
 */
export function registerQuietRpcRoute(owner: Context, endpoint: string, handler: ConnectionRpcHandler): () => Promise<void> {
  const connection = required<HostConnectionHandle>(owner, 'connection');
  const path = `/api/${endpoint}`;
  const shutdown = new AbortController();
  const flights = new Set<Promise<Response>>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const stop = owner.effect(() => {
    const unregister = connection.fetch.register({ path, methods: ['POST'], requestBody: 'streaming', fetch: request => {
      const task = (async (): Promise<Response> => {
        // Recheck the public admission fence for direct Fetch carriers as well.
        const admitted = connection.admit(request);
        if ('rejection' in admitted) return new Response(admitted.rejection === 401 ? 'unauthorized' : 'forbidden', { status: admitted.rejection });
        if (!isBrowserPeer(connection, admitted.peer)) return response('invalid-request', failure('FORBIDDEN', 'This request does not belong to the authenticated browser session.'));
        if (closed) return response('invalid-request', failure('CLOSED', 'The plugin UI route is closing.'));
        if (request.method !== 'POST' || new URL(request.url).pathname !== path) return new Response('not found', { status: 404 });
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 });
        const signal = AbortSignal.any([request.signal, shutdown.signal]);
        if (signal.aborted) return response('invalid-request', failure('CANCELLED', 'The plugin request was cancelled.'));
        let body: unknown;
        try { body = await readBody(request, signal); }
        catch (error) {
          if (signal.aborted) return response('invalid-request', failure('CANCELLED', 'The plugin request was cancelled.'));
          if (error instanceof Error && error.message === 'limit') return new Response('request body exceeds its bound', { status: 413 });
          return new Response('body is not JSON', { status: 400 });
        }
        const parsed = clientRequestSchema.safeParse(body);
        const rawId = body !== null && typeof body === 'object' && 'rpcId' in body ? body.rpcId : undefined;
        const rpcId = typeof rawId === 'string' && rawId.length <= 256 ? rawId : 'invalid-request';
        if (!parsed.success || parsed.data.rpcId.length < 1 || parsed.data.rpcId.length > 256) return response(rpcId, failure('gateway/bad-request', 'Invalid client-request envelope.'));
        if (parsed.data.method !== endpoint) return response(parsed.data.rpcId, failure('gateway/bad-request', 'The request method does not match this exact endpoint.'));
        try { return response(parsed.data.rpcId, await handler(endpoint, parsed.data.payload, signal, admitted.peer)); }
        catch { return response(parsed.data.rpcId, failure(signal.aborted ? 'CANCELLED' : 'OPERATION_FAILED', signal.aborted ? 'The plugin request was cancelled.' : 'The plugin request failed.')); }
      })();
      flights.add(task);
      void task.then(() => flights.delete(task), () => flights.delete(task));
      return task;
    } });
    return () => disposal ??= (async () => {
      closed = true; shutdown.abort();
      try { await unregister(); } finally { await Promise.allSettled([...flights]); }
    })();
  }, 'worktrees: exact authenticated RPC route');
  return () => { const released = stop(); return disposal ??= Promise.resolve(released); };
}
