import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandlerResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { SessionId } from '@deepseek-ai/dsh-session';
import { abortIfRequested, failureOf, WorktreeError } from './errors.js';
import { required } from './runtime.js';
import { registerQuietRpcRoute } from './quiet-rpc.js';
import { hashValue, parseRequest } from './schema.js';
import type { WorktreeController } from './service.js';
import type { CommandEnvelope, WorktreeRequest, WorktreeSetupProgress } from './types.js';

export const WORKTREE_RPC_ENDPOINT = 'dsh-worktrees/execute';
export const WORKTREE_PREPARE_ENDPOINT = 'dsh-worktrees/prepare';
export const WORKTREE_PROGRESS_ENDPOINT = 'dsh-worktrees/progress';
const JSON_LIMIT = 1048576;
type SessionResolver = Pick<SessionController, 'resolveAgent'>;
const OPERATION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;

/** Validate before encoding: no accessors, custom prototypes, coercion, omissions, or cycles. */
function jsonSnapshot(value: unknown, code: string): unknown {
  let bytes = 0; let nodes = 0;
  const seen = new Set<object>();
  const invalid = () => { throw new WorktreeError(code, code === 'RESPONSE_LIMIT' ? 'The result exceeds its JSON response bound. Narrow the query or inspect the operation by ID.' : 'A bounded, lossless JSON request is required.'); };
  const charge = (amount: number) => { bytes += amount; if (bytes > JSON_LIMIT) invalid(); };
  const visit = (input: unknown, depth: number): void => {
    if (++nodes > 65536 || depth > 16) invalid();
    if (input === null || typeof input === 'boolean') { charge(input === false ? 5 : 4); return; }
    if (typeof input === 'string') {
      if (Buffer.byteLength(input) > JSON_LIMIT) invalid();
      charge(Buffer.byteLength(JSON.stringify(input))); return;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0) || (Number.isInteger(input) && !Number.isSafeInteger(input))) invalid();
      charge(String(input).length); return;
    }
    if (typeof input !== 'object' || input === null || seen.has(input)) invalid();
    const object = input as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object) as unknown;
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    seen.add(object); charge(2);
    const keys = Reflect.ownKeys(object);
    if (keys.length > 65536) invalid();
    let elements = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') invalid();
      const name = key as string;
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid();
      if (array && name !== String(elements)) invalid();
      if (elements++ > 0) charge(1);
      if (!array) charge(Buffer.byteLength(JSON.stringify(name)) + 1);
      visit(descriptor!.value, depth + 1);
    }
    if (array && elements !== (object as unknown[]).length) invalid();
    seen.delete(object);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > JSON_LIMIT) invalid();
  return JSON.parse(text) as unknown;
}
function parsePayload(payload: unknown): { actorId: string; request: WorktreeRequest } {
  const value = jsonSnapshot(payload, 'INVALID_RPC_REQUEST');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected a versioned worktree request.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 3 || !Object.hasOwn(input, 'v') || !Object.hasOwn(input, 'actorId') || !Object.hasOwn(input, 'request') || input.v !== 1 || typeof input.actorId !== 'string' || input.actorId.length < 1 || input.actorId.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.actorId)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected v:1, actorId, and request only.');
  try { return { actorId: input.actorId, request: parseRequest(input.request) }; }
  catch { throw new WorktreeError('INVALID_RPC_REQUEST', 'The worktree request is invalid.'); }
}
function transportFailure(code: string, message: string): ConnectionRpcHandlerResult {
  return { ok: false, error: { code, message, details: {} } };
}
function operationFailure(error: unknown): CommandEnvelope {
  // Only controller-owned failures are public. Never forward arbitrary provider/Git diagnostics.
  if (error instanceof Error && error.name === 'AbortError') return { v: 1, ok: false, error: failureOf(error) };
  if (!(error instanceof WorktreeError)) return { v: 1, ok: false, error: { code: 'OPERATION_FAILED', message: 'The worktree operation failed.' } };
  const failure = failureOf(error);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(failure.code)) return { v: 1, ok: false, error: { code: 'OPERATION_FAILED', message: 'The worktree operation failed.' } };
  if (failure.code === 'GIT_FAILED') failure.message = 'The Git operation failed; diagnostic output is not exposed by this channel.';
  return { v: 1, ok: false, error: failure };
}

/** Authenticated UI entry point; it invokes the shared controller, never a command or tool. */
export function registerWorktreeRpc(owner: Context, controller: Pick<WorktreeController, 'execute'>, registerRoute: typeof registerQuietRpcRoute = registerQuietRpcRoute): () => Promise<void> {
  const connection = required<HostConnectionHandle>(owner, 'connection');
  const resolver = required<SessionResolver>(owner, 'sessionController');
  const shutdown = new AbortController();
  const flights = new Set<Promise<ConnectionRpcHandlerResult>>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const stop = owner.effect(() => {
    const unregister = registerRoute(owner, WORKTREE_RPC_ENDPOINT, async (endpoint, payload, requestSignal, peer) => {
      // Check the admitted operator before parsing input or resolving any Actor. Peer permissions are never used.
      if (endpoint !== WORKTREE_RPC_ENDPOINT || peer.id !== connection.operator.id || peer.ctx !== connection.operator.ctx) return transportFailure('FORBIDDEN', 'This request does not belong to the authenticated operator.');
      if (closed) return transportFailure('CLOSED', 'The worktree UI channel is closing.');
      const signal = AbortSignal.any([requestSignal, shutdown.signal]);
      const task = (async (): Promise<ConnectionRpcHandlerResult> => {
        let input: { actorId: string; request: WorktreeRequest };
        try { abortIfRequested(signal); input = parsePayload(payload); }
        catch { return signal.aborted ? transportFailure('CANCELLED', 'The worktree request was cancelled.') : transportFailure('INVALID_RPC_REQUEST', 'The worktree request is not valid bounded JSON.'); }
        let source: Awaited<ReturnType<SessionResolver['resolveAgent']>>;
        try { source = await resolver.resolveAgent(SessionId(input.actorId)); }
        catch { return signal.aborted ? transportFailure('CANCELLED', 'The worktree request was cancelled.') : transportFailure('SESSION_RESOLUTION_FAILED', 'The invoking session could not be resolved.'); }
        if (signal.aborted) return transportFailure('CANCELLED', 'The worktree request was cancelled.');
        if ('error' in source) {
          const codes: Record<string, string> = { 'session/not-found': 'The invoking session was not found.', 'session/agent-busy': 'The invoking session is busy.', 'session/writer-held': 'The invoking session is held by another writer.', 'gateway/internal': 'The invoking session could not be resolved.' };
          return transportFailure(Object.hasOwn(codes, source.error.code) ? source.error.code : 'SESSION_RESOLUTION_FAILED', codes[source.error.code] ?? 'The invoking session could not be resolved.');
        }
        if (source.agent.id !== input.actorId) return transportFailure('SESSION_CHANGED', 'The resolved session identity changed.');
        let envelope: CommandEnvelope;
        try {
          abortIfRequested(signal);
          const data = await controller.execute(input.request, { agent: source.agent, origin: 'ui', signal });
          abortIfRequested(signal);
          envelope = { v: 1, ok: true, data };
        } catch (error) { envelope = operationFailure(error); }
        try { return { ok: true, value: jsonSnapshot(envelope, 'RESPONSE_LIMIT') }; }
        catch { return { ok: true, value: operationFailure(new WorktreeError('RESPONSE_LIMIT', 'The result is not bounded lossless JSON. Narrow the query or inspect the operation by ID.')) }; }
      })();
      flights.add(task);
      try { return await task; } finally { flights.delete(task); }
    });
    return () => disposal ??= (async () => {
      closed = true; shutdown.abort();
      try { await unregister(); } finally { await Promise.allSettled([...flights]); }
    })();
  }, 'worktrees: authenticated UI RPC');
  return () => {
    const released = stop();
    return disposal ??= Promise.resolve(released);
  };
}

interface SetupOperation {
  actorId: string;
  requestHash: string;
  operationId: string;
  revision: number;
  stages: WorktreeSetupProgress[];
  terminal: boolean;
  task: Promise<ConnectionRpcHandlerResult>;
  receipt?: ConnectionRpcHandlerResult;
  receiptWaiters: Set<(result: ConnectionRpcHandlerResult) => void>;
}
interface ProgressWaiter {
  actorId: string;
  operationId: string;
  after: number;
  finish: (result: ConnectionRpcHandlerResult) => void;
}
const SETUP_STAGES = ['fetching', 'creating', 'naming', 'opening', 'ready'] as const;
const ACTIVE_LIMIT = 64;
const WAITER_LIMIT = 128;
const TERMINAL_LIMIT = 128;
function parseProgressPayload(payload: unknown): { actorId: string; operationId: string; after: number } {
  const value = jsonSnapshot(payload, 'INVALID_RPC_REQUEST');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected a versioned progress request.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== 4 || !['v', 'actorId', 'operationId', 'after'].every(key => Object.hasOwn(input, key)) || input.v !== 1 || typeof input.actorId !== 'string' || input.actorId.length < 1 || input.actorId.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.actorId) || typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId) || typeof input.after !== 'number' || !Number.isSafeInteger(input.after) || input.after < 0) throw new WorktreeError('INVALID_RPC_REQUEST', 'Expected v:1, actorId, operationId UUID, and a nonnegative safe after cursor only.');
  return { actorId: input.actorId, operationId: input.operationId, after: input.after };
}
function detachReply(result: ConnectionRpcHandlerResult): ConnectionRpcHandlerResult {
  return result.ok ? { ok: true, value: jsonSnapshot(result.value, 'RESPONSE_LIMIT') } : { ok: false, error: { ...result.error, details: {} } };
}
function snapshotReply(envelope: CommandEnvelope): ConnectionRpcHandlerResult {
  try { return { ok: true, value: jsonSnapshot(envelope, 'RESPONSE_LIMIT') }; }
  catch { return { ok: true, value: operationFailure(new WorktreeError('RESPONSE_LIMIT', 'The result is not bounded lossless JSON. Narrow the query or inspect the operation by ID.')) }; }
}

/** Scope-owned lazy setup with bounded, event-driven observation; never admits a prompt. */
export function registerWorktreeProgressRpc(owner: Context, controller: Pick<WorktreeController, 'execute'>, registerRoute: typeof registerQuietRpcRoute = registerQuietRpcRoute): () => Promise<void> {
  const connection = required<HostConnectionHandle>(owner, 'connection');
  const resolver = required<SessionResolver>(owner, 'sessionController');
  const shutdown = new AbortController();
  const operations = new Map<string, SetupOperation>();
  const terminals: string[] = [];
  const waiters = new Set<ProgressWaiter>();
  const flights = new Set<Promise<ConnectionRpcHandlerResult>>();
  let active = 0;
  let receiptWaiters = 0;
  let closed = false;
  let disposal: Promise<void> | undefined;
  const cancelled = () => transportFailure('CANCELLED', 'The worktree request was cancelled.');
  const forbidden = () => transportFailure('FORBIDDEN', 'This operation does not belong to the invoking session.');
  const progressReply = (operation: SetupOperation): ConnectionRpcHandlerResult => snapshotReply({ v: 1, ok: true, data: { operationId: operation.operationId, revision: operation.revision, stages: operation.stages, terminal: operation.terminal } });
  const notify = (operation: SetupOperation) => {
    for (const waiter of [...waiters]) {
      if (waiter.operationId !== operation.operationId) continue;
      if (waiter.actorId !== operation.actorId) waiter.finish(forbidden());
      else if (operation.revision > waiter.after || operation.terminal) waiter.finish(progressReply(operation));
    }
  };
  const publish = (operation: SetupOperation, progress: WorktreeSetupProgress) => {
    // An observer cannot authorize, mutate effects, or expose arbitrary provider/task fields.
    try {
      const value = jsonSnapshot(progress, 'INVALID_RPC_REQUEST') as WorktreeSetupProgress;
      if (operation.terminal || shutdown.signal.aborted || value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['stage', 'operationId', 'worktreeId'].includes(key)) || value.operationId !== operation.operationId) return;
      const index = SETUP_STAGES.indexOf(value.stage);
      const last = operation.stages.at(-1);
      if (index < 0 || (last !== undefined && index <= SETUP_STAGES.indexOf(last.stage))) return;
      if (value.worktreeId !== undefined && (typeof value.worktreeId !== 'string' || !OPERATION_ID.test(value.worktreeId))) return;
      const boundWorktree = operation.stages.find(stage => stage.worktreeId !== undefined)?.worktreeId;
      if (value.worktreeId !== undefined && boundWorktree !== undefined && value.worktreeId !== boundWorktree) return;
      operation.stages.push(Object.freeze({ stage: value.stage, operationId: operation.operationId, ...(value.worktreeId === undefined ? {} : { worktreeId: value.worktreeId }) }));
      operation.revision++; notify(operation);
    } catch { /* Observation failure cannot change the shared operation's effects. */ }
  };
  const execute = async (input: { actorId: string; request: WorktreeRequest }, signal: AbortSignal, operation: SetupOperation): Promise<ConnectionRpcHandlerResult> => {
    try {
      abortIfRequested(signal);
      let source: Awaited<ReturnType<SessionResolver['resolveAgent']>>;
      try { source = await resolver.resolveAgent(SessionId(input.actorId)); }
      catch { return signal.aborted ? cancelled() : transportFailure('SESSION_RESOLUTION_FAILED', 'The invoking session could not be resolved.'); }
      if (signal.aborted) return cancelled();
      if ('error' in source) {
        const codes: Record<string, string> = { 'session/not-found': 'The invoking session was not found.', 'session/agent-busy': 'The invoking session is busy.', 'session/writer-held': 'The invoking session is held by another writer.', 'gateway/internal': 'The invoking session could not be resolved.' };
        return transportFailure(Object.hasOwn(codes, source.error.code) ? source.error.code : 'SESSION_RESOLUTION_FAILED', codes[source.error.code] ?? 'The invoking session could not be resolved.');
      }
      if (source.agent.id !== input.actorId) return transportFailure('SESSION_CHANGED', 'The resolved session identity changed.');
      let envelope: CommandEnvelope;
      try {
        abortIfRequested(signal);
        const data = await controller.execute(input.request, { agent: source.agent, origin: 'ui', signal, onProgress: progress => publish(operation, progress) });
        abortIfRequested(signal);
        envelope = { v: 1, ok: true, data };
      } catch (error) { envelope = operationFailure(error); }
      return snapshotReply(envelope);
    } catch (error) { return snapshotReply(operationFailure(error)); }
    finally {
      // Terminal is a separate revision, including failures before the first phase.
      operation.terminal = true; operation.revision++; active--; notify(operation);
      terminals.push(operation.operationId);
      if (terminals.length > TERMINAL_LIMIT) operations.delete(terminals.shift()!);
    }
  };
  const awaitReceipt = (operation: SetupOperation, signal: AbortSignal): Promise<ConnectionRpcHandlerResult> => {
    if (operation.receipt !== undefined) return Promise.resolve(signal.aborted ? cancelled() : detachReply(operation.receipt));
    if (waiters.size + receiptWaiters >= WAITER_LIMIT) return Promise.resolve(transportFailure('WAITER_LIMIT', 'The worktree wait capacity is exhausted.'));
    receiptWaiters++;
    return new Promise(resolve => {
      const finish = (result: ConnectionRpcHandlerResult) => {
        if (!operation.receiptWaiters.delete(finish)) return;
        receiptWaiters--; signal.removeEventListener('abort', abort); resolve(detachReply(result));
      };
      const abort = () => finish(cancelled());
      // Removable subscriptions avoid retaining cancelled duplicates on the execution Promise.
      operation.receiptWaiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const handle = (endpoint: string, payload: unknown, requestSignal: AbortSignal, peer: Parameters<Parameters<typeof registerQuietRpcRoute>[2]>[3]): Promise<ConnectionRpcHandlerResult> => {
    if (![WORKTREE_PREPARE_ENDPOINT, WORKTREE_PROGRESS_ENDPOINT].includes(endpoint) || peer.id !== connection.operator.id || peer.ctx !== connection.operator.ctx) return Promise.resolve(transportFailure('FORBIDDEN', 'This request does not belong to the authenticated operator.'));
    if (closed) return Promise.resolve(transportFailure('CLOSED', 'The worktree UI channel is closing.'));
    const signal = AbortSignal.any([requestSignal, shutdown.signal]);
    const task = (async (): Promise<ConnectionRpcHandlerResult> => {
      if (endpoint === WORKTREE_PREPARE_ENDPOINT) {
        let input: { actorId: string; request: WorktreeRequest };
        try {
          abortIfRequested(signal); input = parsePayload(payload);
          const request = input.request;
          if (request.action !== 'create' || typeof request.firstPrompt !== 'string' || request.sessionMode !== 'new' || request.requireBlankSource !== true || request.sourceSessionId !== input.actorId) throw new WorktreeError('INVALID_RPC_REQUEST', 'Prepare accepts only lazy first-Send create requests.');
        } catch { return signal.aborted ? cancelled() : transportFailure('INVALID_RPC_REQUEST', 'The worktree prepare request is not valid bounded JSON.'); }
        const operationId = input.request.operationId!;
        const requestHash = hashValue(input.request);
        const existing = operations.get(operationId);
        if (existing !== undefined) {
          if (existing.actorId !== input.actorId) return forbidden();
          if (existing.requestHash !== requestHash) return transportFailure('OPERATION_CONFLICT', 'The operation ID is already bound to a different request.');
          return awaitReceipt(existing, signal);
        }
        if (active >= ACTIVE_LIMIT) return transportFailure('OPERATION_LIMIT', 'The worktree setup capacity is exhausted.');
        // Bind actor and detached immutable request before any lookup or controller effect.
        Object.freeze(input.request);
        const operation: SetupOperation = { actorId: input.actorId, requestHash, operationId, revision: 0, stages: [], terminal: false, receiptWaiters: new Set(), task: Promise.resolve(transportFailure('OPERATION_FAILED', 'The worktree operation failed.')) };
        active++; operations.set(operationId, operation); notify(operation);
        operation.task = Promise.resolve().then(() => execute(input, signal, operation)).then(result => {
          operation.receipt = result;
          for (const finish of [...operation.receiptWaiters]) finish(result);
          return result;
        });
        return operation.task.then(detachReply);
      }
      let input: ReturnType<typeof parseProgressPayload>;
      try { abortIfRequested(signal); input = parseProgressPayload(payload); }
      catch { return signal.aborted ? cancelled() : transportFailure('INVALID_RPC_REQUEST', 'The worktree progress request is not valid bounded JSON.'); }
      const operation = operations.get(input.operationId);
      if (operation !== undefined) {
        if (operation.actorId !== input.actorId) return forbidden();
        if (operation.revision > input.after || operation.terminal) return progressReply(operation);
      }
      if (waiters.size + receiptWaiters >= WAITER_LIMIT) return transportFailure('WAITER_LIMIT', 'The worktree wait capacity is exhausted.');
      return new Promise(resolve => {
        const waiter: ProgressWaiter = { ...input, finish: result => { if (!waiters.delete(waiter)) return; signal.removeEventListener('abort', abort); resolve(result); } };
        const abort = () => waiter.finish(cancelled());
        waiters.add(waiter); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    })();
    flights.add(task);
    void task.then(() => flights.delete(task), () => flights.delete(task));
    return task;
  };
  const stop = owner.effect(() => {
    const unregister = [registerRoute(owner, WORKTREE_PREPARE_ENDPOINT, handle), registerRoute(owner, WORKTREE_PROGRESS_ENDPOINT, handle)];
    return () => disposal ??= (async () => {
      closed = true; shutdown.abort();
      try { await Promise.allSettled(unregister.map(release => release())); }
      finally { await Promise.allSettled([...flights]); operations.clear(); terminals.length = 0; }
    })();
  }, 'worktrees: bounded authenticated setup progress RPC');
  return () => { const released = stop(); return disposal ??= Promise.resolve(released); };
}
