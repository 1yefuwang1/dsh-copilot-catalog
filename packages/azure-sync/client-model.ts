/** Browser-only control model. No Host, provider, storage, or Agent imports. */
import { boundedJson, parseCloudAuditResult, parseCloudRequest, type CloudAuditWatermark, type CloudAuth, type CloudErrorCode, type CloudMapping, type CloudPlatform, type CloudRequest, type JsonValue } from './src/protocol.js';
import { createComposerBlockOwner, type CloudBlocks, type CloudStore } from './client-blocks.js';
import { parseGitFacts, type GitFacts } from './src/git/sanitize.js';
export type { CloudAuth, CloudMapping, CloudPlatform, CloudRequest } from './src/protocol.js';
export type { CloudBlocks, CloudStore } from './client-blocks.js';

export const CLOUD_STATUS_POLL_MS = 15_000;
export const CLOUD_CLIENT_MAX_FLIGHTS = 32;
export const CLOUD_STATUSES = ['setup-needed', 'auth-error', 'pending-materialization', 'syncing', 'synced', 'retrying', 'ownership-unverified', 'paused-other-device', 'lease-lost', 'needs-folder', 'unmappable-cwd', 'cwd-unmappable', 'mapping-unstable', 'ambiguous-mapping', 'conflict', 'removed-remotely', 'generation-changed', 'remote-missing', 'remote-ahead-live', 'committed-index-corrupt', 'corrupt-remote', 'incompatible-format', 'no-cwd', 'schedule-unsafe', 'preset-missing', 'model-unavailable', 'attachments-unavailable', 'attachment-unsupported', 'degraded', 'importing', 'import-incomplete', 'import-race', 'drain-failed', 'projection-warm-partial', 'projection-warm-failed', 'live-restart-required', 'block-conflict', 'detached'] as const;
export type CloudStatus = typeof CLOUD_STATUSES[number];
export type CloudImportState = 'planned' | 'creating' | 'appending' | 'attachments' | 'warming' | 'complete' | 'degraded' | 'failed';
export interface CloudSettingsView {
  readonly auth: CloudAuth; readonly accountName: string; readonly managedIdentityClientId: string;
  readonly connectionRef: string; readonly container: string; readonly table: string; readonly endpointSuffix: string;
  readonly defaultEnabled: false; readonly pullOnStartup: boolean; readonly pollSeconds: number; readonly updatedAt?: number;
  readonly authPending: boolean;
  readonly pendingAuth?: { readonly auth: CloudAuth; readonly accountName: string; readonly managedIdentityClientId: string };
  readonly connection: { readonly configured: boolean; readonly writable: boolean; readonly source?: 'env' | 'file' | 'project-env' | 'user-env' | 'provider'; readonly available?: false; readonly requiresUpdate?: true };
}
export interface CloudLocalView {
  readonly sessionId: string; readonly enabled: boolean; readonly state: 'active' | 'disabled' | 'deleted'; readonly status: CloudStatus;
  readonly generation: number; readonly detached: boolean; readonly admissionRequired: boolean; readonly admissionStopped: boolean;
  readonly restartRequired: boolean; readonly needsFolder: boolean; readonly mappingUnstable: boolean;
  readonly degradedAttachmentCount: number; readonly degradedAcknowledged: boolean; readonly hasConflictBackup: boolean;
  readonly importState?: CloudImportState; readonly eventCount?: number; readonly lastSyncedAt?: number;
}
export interface CloudMappingView extends CloudMapping { readonly id: string; readonly revision: string }
export interface CloudRemoteView {
  readonly sessionId: string; readonly generation: number; readonly state: 'active' | 'disabled' | 'deleted'; readonly enabled: boolean;
  readonly eventCount: number; readonly updatedAt: number; readonly sourcePlatform: CloudPlatform; readonly rootSessionId: string; readonly rootGeneration: number;
  readonly title?: string; readonly cwd?: string; readonly sourceDeviceId?: string; readonly lastWriterDevice?: string;
  /** Advisory display metadata, never ownership proof or a UI lease promise. */
  readonly leaseOwner?: string; readonly leaseUntil?: number;
  readonly git?: GitFacts;
}
export interface CloudStatusReply { readonly kind: 'status'; readonly revision: number; readonly projectionRevision: string; readonly settings: CloudSettingsView; readonly items: readonly CloudLocalView[]; readonly nextCursor?: string; readonly untracked?: { readonly sessionId: string; readonly enabled: false; readonly admissionRequired: false } }
export interface CloudActionReply { readonly kind: 'action'; readonly action: CloudRequest['action']; readonly sessionId: string; readonly state: CloudStatus; readonly detail?: { readonly owned?: boolean; readonly reason?: CloudStatus; readonly exportPath?: string; readonly cloudConfirmed?: boolean; readonly status?: string; readonly eventCount?: number; readonly uploadedBatches?: number; readonly current?: boolean; readonly auditedAt?: number; readonly watermark?: CloudAuditWatermark } }
export interface CloudRemoteReply { readonly kind: 'remote'; readonly items: readonly CloudRemoteView[]; readonly nextCursor?: string }
export type CloudReply<R extends CloudRequest = CloudRequest> = R extends { action: 'status' } ? CloudStatusReply
  : R extends { action: 'git-info' } ? { readonly kind: 'git'; readonly sessionId: string; readonly local: GitFacts | null }
  : R extends { action: 'mappings' } ? { readonly kind: 'mappings'; readonly items: readonly CloudMappingView[] }
  : R extends { action: 'map' } ? { readonly kind: 'mapping'; readonly mapping: CloudMappingView }
  : R extends { action: 'unmap' } ? { readonly kind: 'mapping-removed'; readonly mappingId: string }
  : R extends { action: 'set-auth' | 'set-defaults' } ? { readonly kind: 'settings'; readonly settings: CloudSettingsView }
  : R extends { action: 'test-auth' } ? { readonly kind: 'auth-test'; readonly configured: true }
  : R extends { action: 'pull' } ? R extends { sessionId: string } ? CloudActionReply : CloudRemoteReply | CloudActionReply
  : CloudActionReply;

const ERROR_CODES = ['INVALID_REQUEST', 'SETUP_NEEDED', 'FORBIDDEN', 'CONFIRM_REQUIRED', 'OPERATION_FAILED', 'CANCELLED', 'CAPACITY', 'LIMIT', 'TRANSPORT', 'MALFORMED_REPLY', 'DISPOSED', 'BUSY', 'DISCONNECTED'] as const;
export type CloudClientErrorCode = CloudErrorCode | 'TRANSPORT' | 'MALFORMED_REPLY' | 'DISPOSED' | 'BUSY' | 'DISCONNECTED';
const errorCodes = new WeakMap<object, CloudClientErrorCode>();
export class CloudClientError extends Error {
  readonly code: CloudClientErrorCode;
  constructor(code: CloudClientErrorCode) {
    const known = ERROR_CODES.includes(code) ? code : 'OPERATION_FAILED';
    super(`Cloud request failed (${known}).`); this.name = 'CloudClientError'; this.code = known; errorCodes.set(this, known);
  }
}
/** Only errors constructed here are inspected; arbitrary error getters are never read. */
export function cloudClientErrorCode(error: unknown): CloudClientErrorCode {
  return error !== null && (typeof error === 'object' || typeof error === 'function') ? errorCodes.get(error) ?? 'OPERATION_FAILED' : 'OPERATION_FAILED';
}
const malformed = (): never => { throw new CloudClientError('MALFORMED_REPLY'); };
type Obj = { [key: string]: JsonValue };
type Check = (value: JsonValue) => boolean;
const str = (max = 4096, empty = false): Check => value => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const bool: Check = value => typeof value === 'boolean';
const num: Check = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive: Check = value => num(value) && (value as number) > 0;
const one = (...values: readonly JsonValue[]): Check => value => values.includes(value);
const list = (check: Check, max = 100): Check => value => Array.isArray(value) && value.length <= max && value.every(check);
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(required).every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => (required[key] ?? optional[key])?.(value[key]!) === true);
};
const sid = str(256), status = one(...CLOUD_STATUSES), platform = one('linux', 'darwin', 'win32'), state = one('active', 'disabled', 'deleted');
const auth = one('auto', 'connection-string', 'azure-cli', 'managed-identity');
const hash: Check = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const settings = shape({ auth, accountName: str(24, true), managedIdentityClientId: str(256, true), connectionRef: str(256), container: str(256), table: str(256), endpointSuffix: str(256), defaultEnabled: one(false), pullOnStartup: bool, pollSeconds: value => num(value) && (value as number) >= 30 && (value as number) <= 86400, authPending: bool,
  connection: shape({ configured: bool, writable: bool }, { source: one('env', 'file', 'project-env', 'user-env', 'provider'), available: one(false), requiresUpdate: one(true) }) },
{ updatedAt: num, pendingAuth: shape({ auth, accountName: str(24, true), managedIdentityClientId: str(256, true) }) });
const local = shape({ sessionId: sid, enabled: bool, state, status, generation: positive, detached: bool, admissionRequired: bool, admissionStopped: bool, restartRequired: bool, needsFolder: bool, mappingUnstable: bool, degradedAttachmentCount: num, degradedAcknowledged: bool, hasConflictBackup: bool },
{ importState: one('planned', 'creating', 'appending', 'attachments', 'warming', 'complete', 'degraded', 'failed'), eventCount: num, lastSyncedAt: num });
const mapping = shape({ id: sid, remotePrefix: str(), localPrefix: str(), remotePlatform: platform, revision: hash });
const remote = shape({ sessionId: sid, generation: positive, state, enabled: bool, eventCount: num, updatedAt: num, sourcePlatform: platform, rootSessionId: sid, rootGeneration: positive },
{ title: str(256, true), cwd: str(), sourceDeviceId: sid, lastWriterDevice: str(256, true), leaseOwner: str(256, true), leaseUntil: num, git: value => parseGitFacts(value) !== undefined });
const ownershipDetail = shape({ owned: bool }, { reason: one('paused-other-device', 'ownership-unverified', 'remote-ahead-live', 'generation-changed', 'removed-remotely', 'remote-missing', 'conflict') });
const uploadDetail = shape({ status: one('synced', 'disabled', 'pending-materialization'), eventCount: num, uploadedBatches: num });
function actionShape(request: CloudRequest): Check {
  const base = { kind: one('action'), action: one(request.action), sessionId: one('sessionId' in request ? request.sessionId! : ''), state: status };
  if (request.action === 'verify') return shape({ ...base, detail: value => {
    try { parseCloudAuditResult(value, 'sessionId' in request ? request.sessionId! : ''); return true; } catch { return false; }
  } });
  if (request.action === 'check-ownership' || request.action === 'takeover') return shape({ ...base, detail: ownershipDetail });
  if (request.action === 'sync' || (request.action === 'toggle' && request.enabled)) return shape({ ...base, detail: uploadDetail });
  if (request.action === 'export') return shape({ ...base, detail: shape({ exportPath: str() }) });
  if (request.action === 'detach' || request.action === 'toggle') return shape(base, { detail: shape({ cloudConfirmed: one(false) }) });
  return shape(base);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Decode the SDK's RpcResult, not the outer server-response frame it already consumed. */
export function decodeCloudReply<R extends CloudRequest>(request: R, input: unknown): CloudReply<R> {
  let value: JsonValue;
  try { value = boundedJson(input); } catch { return malformed(); }
  if (!shape({ ok: bool }, { value: () => true, error: () => true })(value)) return malformed();
  const carrier = value as Obj;
  if (!carrier.ok) {
    if (!shape({ ok: one(false), error: shape({ code: str(256), message: str(4096, true), details: value => value !== null && typeof value === 'object' && !Array.isArray(value) }) })(value)) return malformed();
    throw new CloudClientError('TRANSPORT');
  }
  if (!shape({ ok: one(true), value: () => true })(value)) return malformed();
  const envelope = carrier.value as Obj;
  if (!shape({ v: one(1), ok: bool }, { data: () => true, error: () => true })(envelope)) return malformed();
  if (!envelope.ok) {
    if (!shape({ v: one(1), ok: one(false), error: shape({ code: one(...ERROR_CODES.slice(0, 8)), message: str(4096, true) }) })(envelope)) return malformed();
    throw new CloudClientError((envelope.error as Obj).code as CloudErrorCode);
  }
  if (!shape({ v: one(1), ok: one(true), data: () => true })(envelope)) return malformed();
  const data = envelope.data!;
  let valid = false;
  switch (request.action) {
    case 'status': valid = shape({ kind: one('status'), revision: num, projectionRevision: hash, settings, items: list(local) }, { nextCursor: str(4096), untracked: shape({ sessionId: sid, enabled: one(false), admissionRequired: one(false) }) })(data); break;
    case 'git-info': valid = shape({ kind: one('git'), sessionId: one(request.sessionId!), local: value => value === null || parseGitFacts(value) !== undefined })(data); break;
    case 'mappings': valid = shape({ kind: one('mappings'), items: list(mapping, 1000) })(data); break;
    case 'map': valid = shape({ kind: one('mapping'), mapping })(data); break;
    case 'unmap': valid = shape({ kind: one('mapping-removed'), mappingId: one(request.mappingId) })(data); break;
    case 'set-auth': case 'set-defaults': valid = shape({ kind: one('settings'), settings })(data); break;
    case 'test-auth': valid = shape({ kind: one('auth-test'), configured: one(true) })(data); break;
    default:
      if (request.action === 'pull' && request.sessionId === undefined) valid = shape({ kind: one('remote'), items: list(remote) }, { nextCursor: str(4096) })(data);
      else valid = actionShape(request)(data);
  }
  if (!valid) return malformed();
  if (request.action === 'status' && request.sessionId !== undefined) {
    const reply = data as Obj;
    const items = reply.items as Obj[];
    if (items.length > 1 || items.some(item => item.sessionId !== request.sessionId) || (reply.untracked !== undefined && ((reply.untracked as Obj).sessionId !== request.sessionId || items.length !== 0)) || (items.length === 0 && reply.untracked === undefined) || reply.nextCursor !== undefined) return malformed();
  }
  return freeze(data) as unknown as CloudReply<R>;
}

export interface CloudClientRuntime {
  readonly connection: { readonly rpc: { call(route: '/api', endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }; readonly generation: CloudStore<{ readonly id: number } | undefined> };
  readonly sessions: { refresh(): unknown };
  readonly conversation: { readonly blocks: CloudBlocks };
}
export interface CloudThreadSnapshot {
  readonly sessionId: string; readonly phase: 'loading' | 'local' | 'ready' | 'blocked'; readonly blocked: boolean;
  readonly loading: boolean; readonly pending: boolean; readonly provisional: true; readonly reason: string;
  readonly status?: CloudLocalView; readonly error?: CloudClientErrorCode;
  readonly flags: { readonly admissionRequired: boolean | undefined; readonly ownershipVerified: boolean; readonly importComplete: boolean; readonly degradedAcknowledged: boolean; readonly restartRequired: boolean; readonly destinationAdmitted?: boolean };
}
export interface CloudClientSnapshot {
  readonly settings?: CloudSettingsView; readonly threads: Readonly<Record<string, CloudThreadSnapshot>>;
  readonly pending: readonly string[]; readonly error?: CloudClientErrorCode;
}
export interface CloudClient {
  readonly store: CloudStore<CloudClientSnapshot>;
  watchSession(sessionId: string): () => void;
  getThread(sessionId: string): CloudThreadSnapshot;
  request<R extends CloudRequest>(request: R, signal?: AbortSignal): Promise<CloudReply<R>>;
  refresh(sessionId?: string): Promise<void>;
  dispose(): void;
}
interface Scope {
  id: string; refs: number; version: number; work: AbortController; action?: AbortController;
  valid: boolean; status?: CloudLocalView; untracked: boolean; proof: boolean; attempted?: string; fingerprint?: string;
  loading: boolean; error?: CloudClientErrorCode; block?: () => void; refresh?: Promise<void>;
  destinationAdmitted?: boolean;
}
const eligible = (view: CloudLocalView): boolean => view.admissionRequired && view.enabled && view.state === 'active' && !view.detached && !view.admissionStopped && !view.restartRequired && !view.needsFolder && !view.mappingUnstable &&
  (view.importState === undefined || view.importState === 'complete' || (view.importState === 'degraded' && view.degradedAcknowledged)) &&
  (view.degradedAttachmentCount === 0 || view.degradedAcknowledged) && ['synced', 'syncing', 'retrying', 'ownership-unverified', 'paused-other-device', 'lease-lost', 'degraded'].includes(view.status);
const unknownThread = (sessionId: string): CloudThreadSnapshot => freeze({ sessionId, phase: 'loading', blocked: true, loading: true, pending: false, provisional: true, reason: 'cloud-sync:loading', flags: { admissionRequired: undefined, ownershipVerified: false, importComplete: false, degradedAcknowledged: false, restartRequired: false } });

export interface CloudClientOptions {
  /** Separate v2 LOCAL admission lookup; no legacy wire DTO expansion and no Azure lease probe. */
  readonly importAdmission?: (sessionId: string, signal: AbortSignal) => Promise<boolean>;
}
export function createCloudClient(runtime: CloudClientRuntime, options: CloudClientOptions = {}): CloudClient {
  const listeners = new Set<() => void>(), scopes = new Map<string, Scope>();
  const blocks = createComposerBlockOwner(runtime.conversation.blocks);
  const controllers = new Set<AbortController>(), providers = new Set<Promise<unknown>>();
  const pending = new Map<string, number>(), actions = new Map<string, AbortController>(), globalMutations = new Set<AbortController>();
  let snapshot: CloudClientSnapshot = freeze({ threads: {}, pending: [] });
  let generation = runtime.connection.generation.getSnapshot()?.id, epoch = 0, disposed = false;
  let settingsView: CloudSettingsView | undefined, globalError: CloudClientErrorCode | undefined, settingsEpoch = 0;
  let timer: ReturnType<typeof setInterval> | undefined, projection: string | undefined, nativeQueued = false;
  const connected = () => generation !== undefined;
  function nativeRefresh(): void {
    if (nativeQueued || disposed) return;
    nativeQueued = true;
    const captured = epoch;
    queueMicrotask(() => { nativeQueued = false; if (!disposed && captured === epoch) { try { void Promise.resolve(runtime.sessions.refresh()).catch(() => undefined); } catch { /* native errors are never exposed */ } } });
  }
  function thread(scope: Scope): CloudThreadSnapshot {
    const view = scope.status;
    const complete = view !== undefined && (view.importState === undefined || view.importState === 'complete' || (view.importState === 'degraded' && view.degradedAcknowledged));
    const settling = actions.has(scope.id) || globalMutations.size > 0;
    // Local opt-out bypasses the cloud lease gate, never the Host's partial-import continuation guard.
    const destination = options.importAdmission === undefined || scope.destinationAdmitted === true;
    const local = destination && !settling && scope.valid && (scope.untracked || (view?.admissionRequired === false && complete));
    const ready = destination && !settling && scope.valid && scope.proof && view !== undefined && eligible(view) && !settingsView?.authPending && settingsView?.connection.available !== false && !settingsView?.connection.requiresUpdate;
    const phase = local ? 'local' : ready ? 'ready' : scope.loading && view === undefined ? 'loading' : 'blocked';
    return freeze({ sessionId: scope.id, phase, blocked: !local && !ready, loading: scope.loading, pending: pending.has(scope.id), provisional: true,
      reason: phase === 'loading' ? 'cloud-sync:loading' : phase === 'blocked' ? 'cloud-sync:blocked' : 'cloud-sync:ready',
      ...(view === undefined ? {} : { status: view }), ...(scope.error === undefined ? {} : { error: scope.error }),
      flags: { admissionRequired: scope.untracked ? false : view?.admissionRequired, ownershipVerified: scope.proof, importComplete: complete, degradedAcknowledged: view?.degradedAcknowledged ?? false, restartRequired: view?.restartRequired ?? false, ...(options.importAdmission === undefined ? {} : { destinationAdmitted: scope.destinationAdmitted === true }) } });
  }
  function publish(): void {
    if (disposed) return;
    const threads: Record<string, CloudThreadSnapshot> = Object.create(null) as Record<string, CloudThreadSnapshot>;
    for (const scope of scopes.values()) {
      const value = thread(scope); threads[scope.id] = value;
      if (value.blocked && !scope.block) scope.block = blocks.acquire(scope.id, 'Cloud sync requires a fresh safety check.');
      else if (!value.blocked && scope.block) { const release = scope.block; scope.block = undefined; release(); }
    }
    snapshot = freeze({ threads, pending: [...pending.keys()], ...(settingsView === undefined ? {} : { settings: settingsView }), ...(globalError === undefined ? {} : { error: globalError }) });
    for (const listener of [...listeners]) listener();
  }
  function invalidate(scope: Scope): void {
    ++scope.version; scope.work.abort(); scope.work = new AbortController(); scope.refresh = undefined;
    scope.valid = false; scope.proof = false; scope.destinationAdmitted = undefined; scope.attempted = undefined; scope.loading = true; scope.error = undefined;
  }
  function count(key: string, delta: number): void { const next = (pending.get(key) ?? 0) + delta; if (next > 0) pending.set(key, next); else pending.delete(key); }
  async function send<R extends CloudRequest>(meta: R, payload: unknown, external?: AbortSignal): Promise<CloudReply<R>> {
    if (disposed) throw new CloudClientError('DISPOSED');
    if (!connected()) throw new CloudClientError('DISCONNECTED');
    if (providers.size >= CLOUD_CLIENT_MAX_FLIGHTS) throw new CloudClientError('CAPACITY');
    const controller = new AbortController(), captured = epoch;
    controllers.add(controller);
    const abort = () => controller.abort(); external?.addEventListener('abort', abort, { once: true });
    if (external?.aborted) controller.abort();
    let stop: () => void = () => undefined;
    try {
      if (controller.signal.aborted) throw new CloudClientError('CANCELLED');
      const work = Promise.resolve(runtime.connection.rpc.call('/api', meta.action === 'status' || meta.action === 'mappings' ? 'azure-sync/status' : 'azure-sync/action', payload, controller.signal));
      // The SDK has consumed the request body; don't keep a credential-bearing body across awaits.
      payload = undefined;
      providers.add(work); void work.then(() => providers.delete(work), () => providers.delete(work));
      const cancellation = new Promise<never>((_resolve, reject) => { stop = () => reject(new CloudClientError('CANCELLED')); controller.signal.addEventListener('abort', stop, { once: true }); if (controller.signal.aborted) stop(); });
      let reply: unknown;
      try { reply = await Promise.race([work, cancellation]); } catch (error) { throw new CloudClientError(controller.signal.aborted ? 'CANCELLED' : errorCodes.has(error as object) ? cloudClientErrorCode(error) : 'TRANSPORT'); }
      if (disposed || captured !== epoch || controller.signal.aborted) throw new CloudClientError('CANCELLED');
      return decodeCloudReply(meta, reply);
    } catch (error) { throw new CloudClientError(controller.signal.aborted ? 'CANCELLED' : errorCodes.has(error as object) ? cloudClientErrorCode(error) : 'TRANSPORT'); }
    finally { controllers.delete(controller); controller.signal.removeEventListener('abort', stop); external?.removeEventListener('abort', abort); }
  }
  function updateSettings(value: CloudSettingsView): void {
    if (settingsView !== undefined && JSON.stringify(settingsView) !== JSON.stringify(value)) {
      ++settingsEpoch;
      for (const scope of scopes.values()) { scope.proof = false; scope.attempted = undefined; }
    }
    settingsView = value;
  }
  function applyStatus(reply: CloudStatusReply, scope?: Scope): void {
    updateSettings(reply.settings);
    if (projection !== undefined && projection !== reply.projectionRevision) nativeRefresh();
    projection = reply.projectionRevision;
    if (!scope) return;
    const view = reply.items.find(item => item.sessionId === scope.id);
    const untracked = reply.untracked?.sessionId === scope.id;
    if (!view && !untracked) throw new CloudClientError('MALFORMED_REPLY');
    // Activity counters/timestamps are not ownership evidence and must not create an idle lease-probe loop.
    const fingerprint = view === undefined ? JSON.stringify(reply.untracked) : JSON.stringify({ ...view, eventCount: undefined, lastSyncedAt: undefined, hasConflictBackup: undefined });
    if (scope.fingerprint !== fingerprint) { scope.proof = false; scope.attempted = undefined; }
    scope.fingerprint = fingerprint; scope.status = view; scope.untracked = untracked; scope.valid = true;
  }
  async function load(scope: Scope, explicit: boolean, inspected?: CloudActionReply): Promise<void> {
    if (disposed || scopes.get(scope.id) !== scope || !connected() || scope.action || actions.has(scope.id) || globalMutations.size > 0) return;
    if (scope.refresh) return scope.refresh;
    if (explicit) { scope.proof = false; scope.attempted = undefined; }
    const version = scope.version, signal = scope.work.signal;
    const current = () => !disposed && scopes.get(scope.id) === scope && version === scope.version && !signal.aborted;
    scope.loading = true; publish();
    const task = (async () => {
      try {
        const request = { action: 'status', sessionId: scope.id } as const;
        const reply = await send(request, { v: 1, request }, signal);
        if (!current()) return;
        applyStatus(reply, scope); scope.error = undefined;
        if (options.importAdmission) {
          scope.destinationAdmitted = undefined; publish();
          const admitted = await options.importAdmission(scope.id, signal);
          if (!current()) return;
          scope.destinationAdmitted = admitted;
        }
        publish();
        const view = scope.status;
        if ((options.importAdmission === undefined || scope.destinationAdmitted === true) && view && eligible(view) && !settingsView?.authPending && settingsView?.connection.available !== false && !settingsView?.connection.requiresUpdate && scope.attempted !== scope.fingerprint) {
          scope.attempted = scope.fingerprint;
          const capturedSettings = settingsEpoch;
          const check = { action: 'check-ownership', sessionId: scope.id } as const;
          const proof = inspected ?? await send(check, { v: 1, request: check }, signal);
          if (!current() || capturedSettings !== settingsEpoch) return;
          // Ownership inspection itself can advance local status (for example synced -> syncing).
          // Observe its resulting projection once, without another ownership/network probe.
          if (!inspected) {
            const after = await send(request, { v: 1, request }, signal);
            if (!current()) return;
            applyStatus(after, scope);
          }
          if (capturedSettings !== settingsEpoch) return;
          scope.attempted = scope.fingerprint;
          scope.proof = proof.detail?.owned === true && scope.status !== undefined && eligible(scope.status) && proof.state === scope.status.status;
        }
      } catch (error) { if (current()) { scope.error = cloudClientErrorCode(error); scope.proof = false; } }
      finally { if (current()) { scope.loading = false; scope.refresh = undefined; publish(); } }
    })();
    scope.refresh = task;
    return task;
  }
  function schedulePolling(): void {
    if (!scopes.size || !connected()) { if (timer !== undefined) clearInterval(timer); timer = undefined; return; }
    if (timer === undefined) timer = setInterval(() => { for (const scope of scopes.values()) if (!scope.action) void load(scope, false); }, CLOUD_STATUS_POLL_MS);
  }
  const stopConnection = runtime.connection.generation.subscribe(() => {
    const next = runtime.connection.generation.getSnapshot()?.id;
    if (next === generation || disposed) return;
    generation = next; ++epoch; projection = undefined;
    for (const controller of controllers) controller.abort();
    for (const scope of scopes.values()) { scope.action?.abort(); invalidate(scope); }
    settingsView = undefined; globalError = undefined; publish(); schedulePolling();
    if (connected()) for (const scope of scopes.values()) void load(scope, false);
  });
  const client: CloudClient = {
    store: { getSnapshot: () => snapshot, subscribe(listener) { if (disposed) return () => undefined; listeners.add(listener); return () => { listeners.delete(listener); }; } },
    watchSession(sessionId) {
      parseCloudRequest({ action: 'status', sessionId });
      if (disposed) return () => undefined;
      let scope = scopes.get(sessionId);
      if (!scope) {
        scope = { id: sessionId, refs: 0, version: 0, work: new AbortController(), valid: false, untracked: false, proof: false, loading: true, action: actions.get(sessionId) };
        scopes.set(sessionId, scope); publish();
      }
      scope.refs++; schedulePolling(); void load(scope, false);
      const captured = scope; let released = false;
      return () => {
        if (released) return; released = true;
        if (--captured.refs !== 0) return;
        captured.work.abort(); captured.action?.abort(); captured.block?.(); scopes.delete(sessionId); schedulePolling(); publish();
      };
    },
    getThread(sessionId) { return snapshot.threads[sessionId] ?? unknownThread(sessionId); },
    request(input, signal) {
      // Credential-bearing input lives only in this transient wire payload. Never retain it in state, logs, or action queues.
      let request: CloudRequest;
      try { request = parseCloudRequest(input); } catch { return Promise.reject(new CloudClientError('INVALID_REQUEST')); }
      const action = request.action;
      const sessionId = 'sessionId' in request ? request.sessionId : undefined;
      const threadAction = !['status', 'mappings', 'map', 'unmap', 'set-auth', 'set-defaults', 'test-auth'].includes(action) && !(action === 'pull' && sessionId === undefined);
      if (threadAction && sessionId === undefined) return Promise.reject(new CloudClientError('INVALID_REQUEST'));
      const scope = sessionId === undefined ? undefined : scopes.get(sessionId);
      const mutation = action !== 'status' && action !== 'mappings' && action !== 'test-auth' && action !== 'git-info' && action !== 'verify' && !(action === 'pull' && sessionId === undefined);
      const safety = action === 'detach' || (action === 'toggle' && !request.enabled);
      if (sessionId !== undefined && actions.has(sessionId) && !safety) return Promise.reject(new CloudClientError('BUSY'));
      if (disposed) return Promise.reject(new CloudClientError('DISPOSED'));
      const scopedStatus = action === 'status' && scope !== undefined;
      if (scopedStatus) { scope.action?.abort(); invalidate(scope); }
      if (mutation) {
        if (sessionId !== undefined) { actions.get(sessionId)?.abort(); if (scope) { scope.action?.abort(); invalidate(scope); } }
        else {
          for (const action of actions.values()) action.abort();
          for (const item of scopes.values()) { item.action?.abort(); invalidate(item); }
        }
      }
      const controller = new AbortController();
      if (mutation && sessionId !== undefined) actions.set(sessionId, controller);
      if (mutation && sessionId === undefined) globalMutations.add(controller);
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      if (scope && (mutation || scopedStatus)) scope.action = controller;
      const key = sessionId ?? 'global'; count(key, 1); globalError = undefined; publish();
      // Reply validation only needs non-secret routing fields, never set-auth credentials.
      const meta = (action === 'set-auth' ? { action, auth: request.auth } : request) as typeof input;
      const result = send(meta, { v: 1, request }, controller.signal);
      const capturedEpoch = epoch, version = scope?.version, capturedSettings = settingsEpoch;
      let inspection: CloudActionReply | undefined;
      const current = () => !disposed && epoch === capturedEpoch && !controller.signal.aborted && (!scope || (scopes.get(scope.id) === scope && version === scope.version));
      return result.then(reply => {
        if (!current()) throw new CloudClientError('CANCELLED');
        const data = reply as CloudReply;
        if (data.kind === 'settings') updateSettings(data.settings);
        if (data.kind === 'status') applyStatus(data, scope);
        if (action === 'pull' && sessionId !== undefined) nativeRefresh();
        if ((action === 'check-ownership' || action === 'takeover') && data.kind === 'action' && capturedSettings === settingsEpoch) inspection = data;
        return reply;
      }, error => {
        if (current()) {
          globalError = cloudClientErrorCode(error);
          if (scope) {
            scope.error = globalError;
            if (action === 'verify') {
              // Audit failure cannot grant/retain a provisional proof or implicitly launch a new lease probe.
              scope.proof = false; scope.attempted = scope.fingerprint;
            }
          }
        }
        throw error;
      }).finally(() => {
        signal?.removeEventListener('abort', abort); count(key, -1);
        const live = sessionId === undefined ? undefined : scopes.get(sessionId);
        if (live?.action === controller) live.action = undefined;
        if (scope?.action === controller) scope.action = undefined;
        if (sessionId !== undefined && actions.get(sessionId) === controller) actions.delete(sessionId);
        globalMutations.delete(controller);
        if (!disposed) publish();
        // A view may mount after this action started. Reload the CURRENT scope, not just the captured one.
        if (!disposed && epoch === capturedEpoch && (mutation || scopedStatus)) {
          if (live) void load(live, false, current() ? inspection : undefined);
          else if (sessionId === undefined) for (const item of scopes.values()) void load(item, false);
        }
      });
    },
    async refresh(sessionId) {
      if (disposed) return;
      if (sessionId !== undefined) { const scope = scopes.get(sessionId); if (scope) await load(scope, true); return; }
      if (scopes.size) { await Promise.all([...scopes.values()].map(scope => load(scope, true))); return; }
      try { const request = { action: 'status' } as const; const reply = await send(request, { v: 1, request }); if (!disposed) { applyStatus(reply); globalError = undefined; publish(); } }
      catch (error) { if (!disposed) { globalError = cloudClientErrorCode(error); publish(); } }
    },
    dispose() {
      if (disposed) return; disposed = true; ++epoch; stopConnection(); if (timer !== undefined) clearInterval(timer);
      for (const controller of controllers) controller.abort();
      for (const scope of scopes.values()) { scope.work.abort(); scope.action?.abort(); }
      blocks.dispose(); scopes.clear(); pending.clear(); listeners.clear(); settingsView = undefined;
      snapshot = freeze({ threads: {}, pending: [] });
    },
  };
  return client;
}
