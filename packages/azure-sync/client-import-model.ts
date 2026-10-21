/** Browser-only destination import transport; never routes v2 data through legacy pull decoding. */
import { boundedJson, type JsonValue } from './src/protocol.js';
import { isGitBranchRef, parseGitContext, type GitContext } from './src/git/context.js';
import { parseGitFacts, type GitFacts } from './src/git/sanitize.js';
import {
  CLOUD_IMPORT_ENDPOINT, parseCloudImportRequest, type CloudImportRequest, type CloudImportResponse,
} from './src/import/protocol.js';
import { CloudClientError, type CloudClientRuntime } from './client-model.js';

export type ImportClientRuntime = Pick<CloudClientRuntime, 'connection' | 'sessions'>;
type Obj = { [key: string]: JsonValue };
type Check = (value: JsonValue) => boolean;
const text = (max = 4096, empty = false): Check => value => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const natural: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive: Check = value => natural(value) && (value as number) > 0;
const bool: Check = value => typeof value === 'boolean';
const one = (...values: readonly JsonValue[]): Check => value => values.includes(value);
const code: Check = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
const oid: Check = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
const list = (check: Check, max = 256): Check => value => Array.isArray(value) && value.length <= max && value.every(check);
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(required).every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => (required[key] ?? optional[key])?.(value[key]!) === true);
};
const git: Check = value => parseGitContext(value) !== undefined || parseGitFacts(value) !== undefined;
const folder = shape({ path: text(), title: text(256, true) }, { projectId: text(256), folderId: text(256) });
const admission = shape({ version: one(2), kind: one('import-admission'), sessionId: text(256), reserved: bool, ready: bool, continued: bool }, { operationId: text(256), generation: positive, reason: code });
const capabilities = shape({ version: one(2), kind: one('import-capabilities'), local: bool, worktree: bool, seeded: bool, folders: list(folder) }, { reason: code });
const source = shape({ version: one(2), kind: one('import-source'), sessionId: text(256), generation: positive, cwd: text(4096, true), platform: one('linux', 'darwin', 'win32'), eventCount: natural, eligible: bool, gitUsable: bool, seeded: bool }, { reason: code, sourceGit: git, operationId: text(256) });
const bases = shape({ version: one(2), kind: one('import-bases'), projectId: text(256), folderId: text(256), repoRoot: text(), objectFormat: one('sha1', 'sha256'), head: oid, branches: list(shape({ name: text(1024), oid }), 5000) });
const phase = one('reviewed', 'reserved', 'preparing', 'prepared', 'materializing', 'importing', 'attachments', 'warming', 'binding', 'ready', 'cancelled', 'recovery-required');
const operation = shape({ version: one(2), kind: one('import-operation'), operationId: text(256), sessionId: text(256), generation: positive, revision: natural, phase, destination: one('local', 'worktree'), continuable: bool, pendingInput: bool }, { cwd: text(), worktreeId: text(256), branch: text(1024), baseOid: oid, reason: code });
const plan = shape({ version: one(2), kind: one('import-plan'), operationId: text(256), sessionId: text(256), generation: positive, revision: positive, expiresAt: natural, eventCount: natural, cwd: text(), destination: one('local', 'worktree'), warnings: list(code, 64), codeMismatch: bool }, { branch: text(1024), baseOid: oid, sourceGit: git });
const malformed = (): never => { throw new CloudClientError('MALFORMED_REPLY'); };
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Consume only the matching new import DTO inside the existing authenticated v1 RPC carrier. */
export function decodeImportReply(request: CloudImportRequest, input: unknown): CloudImportResponse {
  let value: JsonValue;
  try { value = boundedJson(input); } catch { return malformed(); }
  if (!shape({ ok: bool }, { value: () => true, error: () => true })(value)) return malformed();
  const carrier = value as Obj;
  if (!carrier.ok) throw new CloudClientError('TRANSPORT');
  if (!shape({ ok: one(true), value: () => true })(value)) return malformed();
  const envelope = carrier.value;
  if (!shape({ v: one(1), ok: bool }, { data: () => true, error: () => true })(envelope!)) return malformed();
  const wrapped = envelope as Obj;
  if (!wrapped.ok) {
    if (!shape({ v: one(1), ok: one(false), error: shape({ code: one('INVALID_REQUEST', 'SETUP_NEEDED', 'FORBIDDEN', 'CONFIRM_REQUIRED', 'OPERATION_FAILED', 'CANCELLED', 'CAPACITY', 'LIMIT'), message: text(4096, true) }) })(envelope!)) return malformed();
    throw new CloudClientError((wrapped.error as Obj).code as 'INVALID_REQUEST');
  }
  if (!shape({ v: one(1), ok: one(true), data: () => true })(envelope!)) return malformed();
  const data = wrapped.data!;
  const check = request.action === 'import-capabilities' ? capabilities : request.action === 'import-admission' ? admission : request.action === 'inspect-import' ? source : request.action === 'import-bases' ? bases : request.action === 'plan-import' ? plan : operation;
  if (!check(data)) return malformed();
  const result = data as Obj;
  if ('sessionId' in request && result.sessionId !== request.sessionId) return malformed();
  if ('operationId' in request && result.operationId !== request.operationId) return malformed();
  if ('generation' in request && result.generation !== request.generation) return malformed();
  if (request.action === 'import-capabilities' && (result.folders as Obj[]).some(entry => (entry.projectId === undefined) !== (entry.folderId === undefined))) return malformed();
  if (request.action === 'import-bases') {
    if (result.projectId !== request.projectId || result.folderId !== request.folderId) return malformed();
    const length = result.objectFormat === 'sha1' ? 40 : 64;
    if ((result.head as string).length !== length || (result.branches as Obj[]).some(entry => !isGitBranchRef(entry.name) || (entry.oid as string).length !== length)) return malformed();
  }
  if (request.action === 'plan-import' && result.destination !== request.destination.kind) return malformed();
  if (result.kind === 'import-operation' && result.phase !== 'ready' && result.continuable === true) return malformed();
  if (result.kind === 'import-admission' && (result.continued === true && result.ready !== true || result.reserved === true && (result.operationId === undefined || result.generation === undefined) || result.reserved === false && (result.ready !== true || result.continued !== true))) return malformed();
  return freeze(data) as unknown as CloudImportResponse;
}

/** Location display never claims a remote ref contains an OID; association is a Host Git check. */
export function importSourceFacts(value: GitContext | GitFacts | undefined) {
  if (!value) return { head: '', localBranch: '', currentRemote: '', currentRef: '', baseOid: '', baseRemote: '', baseRef: '' };
  if (value.v === 1) return { head: value.commit ?? '', localBranch: value.branch ?? '', currentRemote: '', currentRef: '', baseOid: '', baseRemote: '', baseRef: '' };
  const current = value.current.upstream?.kind === 'remote' ? value.current.upstream : undefined;
  const base = value.creationBase;
  const baseHint = base?.kind === 'remote' ? { remote: base.remote, ref: base.ref } : base?.kind === 'local' ? base.upstreamAtCreation : undefined;
  return { head: value.current.headOid ?? '', localBranch: value.current.branchRef ?? '', currentRemote: current?.remote.name ?? '', currentRef: current?.ref ?? '', baseOid: base?.oid ?? '', baseRemote: baseHint?.remote.name ?? '', baseRef: baseHint?.ref ?? '' };
}

export function createImportClient(runtime: ImportClientRuntime) {
  const flights = new Set<AbortController>();
  const providers = new Set<Promise<unknown>>();
  let disposed = false;
  let generation = runtime.connection.generation.getSnapshot()?.id;
  const stop = runtime.connection.generation.subscribe(() => {
    const next = runtime.connection.generation.getSnapshot()?.id;
    if (next === generation) return;
    generation = next;
    for (const flight of flights) flight.abort();
  });
  async function request(value: CloudImportRequest, signal?: AbortSignal): Promise<CloudImportResponse> {
    if (disposed) throw new CloudClientError('DISPOSED');
    if (generation === undefined) throw new CloudClientError('DISCONNECTED');
    if (flights.size >= 32 || providers.size >= 32) throw new CloudClientError('CAPACITY');
    const parsed = parseCloudImportRequest(value), controller = new AbortController(), entered = generation;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (combined.aborted) throw new CloudClientError('CANCELLED');
    flights.add(controller);
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new CloudClientError('CANCELLED'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try {
      const work = Promise.resolve().then(() => {
        if (disposed || combined.aborted || generation !== entered) throw new CloudClientError('CANCELLED');
        return runtime.connection.rpc.call('/api', CLOUD_IMPORT_ENDPOINT, { v: 1, request: parsed }, combined);
      });
      providers.add(work);
      void work.then(() => providers.delete(work), () => providers.delete(work));
      const reply = await Promise.race([work, cancelled]);
      if (disposed || combined.aborted || generation !== entered) throw new CloudClientError('CANCELLED');
      const decoded = decodeImportReply(parsed, reply);
      if (['commit-import', 'resume-import', 'cancel-import', 'continue-import'].includes(parsed.action)) {
        try { void Promise.resolve(runtime.sessions.refresh()).catch(() => undefined); } catch { /* Native list refresh is not operation authority and cannot hold the import receipt hostage. */ }
        if (disposed || combined.aborted || generation !== entered) throw new CloudClientError('CANCELLED');
      }
      return decoded;
    } catch (error) {
      if (disposed || combined.aborted || generation !== entered) throw new CloudClientError('CANCELLED');
      if (error instanceof CloudClientError) throw error;
      throw new CloudClientError('TRANSPORT');
    } finally { combined.removeEventListener('abort', abort); flights.delete(controller); }
  }
  return { request, dispose() { if (disposed) return; disposed = true; stop(); for (const controller of flights) controller.abort(); } };
}
export type ImportClient = ReturnType<typeof createImportClient>;
