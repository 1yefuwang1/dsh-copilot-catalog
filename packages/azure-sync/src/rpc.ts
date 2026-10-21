import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { CLOUD_IMPORT_ENDPOINT, parseCloudImportPayload, type CloudImportControllerPort, type CloudImportRequest } from './import/protocol.js';
import type { CloudRequest } from './protocol.js';
import {
  boundedJson, cloudFailure, cloudSuccess, CloudControlError, CLOUD_JSON_MAX_BYTES,
  parseCloudPayload, type CloudControllerPort, type CloudEnvelope,
} from './protocol.js';

export const CLOUD_STATUS_ENDPOINT = 'azure-sync/status';
export const CLOUD_ACTION_ENDPOINT = 'azure-sync/action';
export const CLOUD_RPC_MAX_FLIGHTS = 32;

function reply(rpcId: string, value: CloudEnvelope): Response {
  return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
}
function failure(rpcId: string, code: ConstructorParameters<typeof CloudControlError>[0]): Response {
  return reply(rpcId, cloudFailure(new CloudControlError(code)));
}

/** Race without waiting for a cancelled provider, and observe its late rejection. */
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new CloudControlError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new CloudControlError('CANCELLED');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > CLOUD_JSON_MAX_BYTES)) throw new CloudControlError('LIMIT');
  if (request.body === null) throw new CloudControlError('INVALID_REQUEST');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // A hostile stream may never settle cancel(). Teardown observes, but never awaits it.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const part = await untilAbort(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CLOUD_JSON_MAX_BYTES) { cancel(); throw new CloudControlError('LIMIT'); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw new CloudControlError('CANCELLED');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new CloudControlError('INVALID_REQUEST'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* Pending stream reads are already observed. */ }
  }
}

function carrier(value: unknown, endpoint: string): { rpcId: string; payload: unknown } {
  const input = boundedJson(value);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new CloudControlError('INVALID_REQUEST');
  if (Object.keys(input).length !== 4 || !['type', 'rpcId', 'method', 'payload'].every(key => Object.hasOwn(input, key)) || input.type !== 'client-request' || input.method !== endpoint || typeof input.rpcId !== 'string' || input.rpcId.length < 1 || input.rpcId.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.rpcId)) throw new CloudControlError('INVALID_REQUEST');
  return { rpcId: input.rpcId, payload: input.payload };
}

/**
 * Exact public Fetch routes coexist with the API gateway's singleton interceptor.
 * Only the admitted shared browser Peer may reach parsing or the controller.
 * No agent is resolved, including for cold/status requests; RPC has no sid fallback.
 */
export function registerCloudRpc(ctx: Context, controller: CloudControllerPort, imports?: CloudImportControllerPort): () => Promise<void> {
  const connection = ctx.get('connection') as HostConnectionHandle | undefined;
  if (connection === undefined) return async () => undefined;
  const shutdown = new AbortController();
  const flights = new Set<Promise<Response>>();
  // Cancelled providers retain a slot until they settle: repeated cancellation
  // cannot multiply never-settling provider work beyond the admission bound.
  const providers = new Set<Promise<unknown>>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const stop = ctx.effect(() => {
    const unregister: Array<() => Promise<void>> = [];
    const dispose = (): Promise<void> => disposal ??= (async () => {
      closed = true; shutdown.abort();
      await Promise.allSettled(unregister.map(remove => Promise.resolve().then(remove)));
      await Promise.allSettled([...flights]);
    })();
    try {
      for (const endpoint of [CLOUD_STATUS_ENDPOINT, CLOUD_ACTION_ENDPOINT, ...(imports ? [CLOUD_IMPORT_ENDPOINT] : [])]) {
        const path = `/api/${endpoint}`;
        unregister.push(connection.fetch.register({ path, methods: ['POST'], requestBody: 'streaming', fetch: incoming => {
          let signal: AbortSignal;
          // Refused calls are not flights and never acquire/read a body reader.
          try {
            const admission = connection.admit(incoming);
            if ('rejection' in admission) return Promise.resolve(new Response(admission.rejection === 401 ? 'unauthorized' : 'forbidden', { status: admission.rejection }));
            const peer = admission.peer; const browser = connection.browserPeer;
            if (peer.principal.kind !== 'owner' || peer.id !== browser.id || peer.ctx !== browser.ctx) return Promise.resolve(failure('invalid-request', 'FORBIDDEN'));
            if (closed) return Promise.resolve(failure('invalid-request', 'CANCELLED'));
            if (incoming.method !== 'POST' || new URL(incoming.url).pathname !== path) return Promise.resolve(new Response('not found', { status: 404 }));
            if (flights.size >= CLOUD_RPC_MAX_FLIGHTS || providers.size >= CLOUD_RPC_MAX_FLIGHTS) return Promise.resolve(failure('invalid-request', 'CAPACITY'));
            if (incoming.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return Promise.resolve(new Response('content type must be application/json', { status: 415 }));
            signal = AbortSignal.any([incoming.signal, peer.signal, shutdown.signal]);
            if (signal.aborted) return Promise.resolve(failure('invalid-request', 'CANCELLED'));
          } catch { return Promise.resolve(failure('invalid-request', 'FORBIDDEN')); }
          const task = (async (): Promise<Response> => {
            let rpcId = 'invalid-request';
            try {
              const input = carrier(await readBody(incoming, signal), endpoint);
              rpcId = input.rpcId;
              const request = endpoint === CLOUD_IMPORT_ENDPOINT ? parseCloudImportPayload(input.payload) : parseCloudPayload(input.payload);
              if (endpoint === CLOUD_STATUS_ENDPOINT && request.action !== 'status' && request.action !== 'mappings') return failure(rpcId, 'FORBIDDEN');
              if (signal.aborted) return failure(rpcId, 'CANCELLED');
              // Body readers can finish together: recheck provider capacity here.
              if (providers.size >= CLOUD_RPC_MAX_FLIGHTS) return failure(rpcId, 'CAPACITY');
              const work = Promise.resolve().then<unknown>(() => {
                if (signal.aborted) throw new CloudControlError('CANCELLED');
                return endpoint === CLOUD_IMPORT_ENDPOINT ? imports!.execute(request as CloudImportRequest, { origin: 'rpc', signal }) : controller.execute(request as CloudRequest, { origin: 'rpc', signal });
              });
              providers.add(work);
              void work.then(() => providers.delete(work), () => providers.delete(work));
              const data = await untilAbort(work, signal);
              if (signal.aborted) return failure(rpcId, 'CANCELLED');
              return reply(rpcId, cloudSuccess(data));
            } catch (error) { return reply(rpcId, cloudFailure(signal.aborted ? new CloudControlError('CANCELLED') : error)); }
          })();
          flights.add(task);
          void task.then(() => flights.delete(task), () => flights.delete(task));
          return task;
        } }));
      }
    } catch {
      void dispose();
      throw new CloudControlError('OPERATION_FAILED');
    }
    return dispose;
  }, 'azure-sync: authenticated browser control routes');
  return () => {
    const released = stop();
    return disposal ??= Promise.resolve(released);
  };
}
