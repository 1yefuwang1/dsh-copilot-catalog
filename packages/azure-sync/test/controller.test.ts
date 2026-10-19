import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { CloudController, type CloudCore } from '../src/controller.js';
import { decodeCloudReply } from '../client-model.js';
import type { GitFacts } from '../src/git/sanitize.js';
import { CloudControlError, type CloudRequest, type JsonValue } from '../src/protocol.js';
import { Config } from '../src/config.js';
import { SettingsService } from '../src/settings.js';
import { AzureSyncError } from '../src/azure/errors.js';
import type { LocalStore } from '../src/local/store.js';
import { localSessionRecordSchema, localSettingsSchema, pathMappingSchema, type LocalSessionRecord, type LocalSettingsRecord, type PathMappingRecord } from '../src/schema.js';
import { SyncService } from '../src/sync/service.js';
import type { ImportService } from '../src/sync/import-service.js';
import type { Uploader } from '../src/sync/uploader.js';
import type { CloudRepository } from '../src/sync/cloud-repository.js';
import type { SessionSource, SourceSnapshot } from '../src/sync/session-source.js';
import type { CwdFs } from '../src/sync/effective-cwd.js';
import { mappingRevision } from '../src/sync/effective-cwd.js';
import { cloudSession, event, localSession, pathMapping, sessionHeader } from './helpers.js';

const HIDDEN = `private-${'provider'}-diagnostic-must-not-cross-control-plane`;
const MAPPING_ID = '11111111-2222-4333-8444-555555555555';
const signal = () => new AbortController().signal;

function object(value: JsonValue | undefined): { [key: string]: JsonValue } {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function array(value: JsonValue | undefined): JsonValue[] { assert.ok(Array.isArray(value)); return value; }
function code(expected: string) {
  return (error: unknown) => error instanceof CloudControlError && error.code === expected;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface Call { name: string; id?: string; args: unknown[] }

function fixture(initial: LocalSessionRecord[] = []) {
  const sessions = new Map(initial.map(record => [record.sessionId, record]));
  const mappings = new Map<string, PathMappingRecord>();
  const calls: Call[] = [];
  const events: string[] = [];
  const state = { settings: undefined as LocalSettingsRecord | undefined, coreCalls: 0, unavailable: false,
    active: true, onCall: undefined as ((name: string, args: unknown[]) => Promise<void>) | undefined,
    onMappingWrite: undefined as (() => void) | undefined };
  let permissionLane: Promise<unknown> = Promise.resolve();
  const local = {
    getSession: (id: string) => sessions.get(id),
    listSessions: () => sessions.entries(),
    async putSession(record: LocalSessionRecord) { events.push(`session:${record.sessionId}`); sessions.set(record.sessionId, localSessionRecordSchema.parse(record)); },
    async mutateSession(id: string, fn: (value: LocalSessionRecord) => LocalSessionRecord): Promise<void> {
      const task = permissionLane.then(() => { const current = sessions.get(id); if (current !== undefined) { const next = localSessionRecordSchema.parse(fn(current)); assert.equal(next.sessionId, id); sessions.set(id, next); } });
      permissionLane = task.then(() => undefined, () => undefined); await task;
    },
    transactSession(id: string, fn: (value: LocalSessionRecord | undefined) => LocalSessionRecord | undefined) {
      const task = permissionLane.then(() => {
        const next = fn(sessions.get(id));
        if (next !== undefined) { assert.equal(next.sessionId, id); events.push(`session:${id}`); sessions.set(id, localSessionRecordSchema.parse(next)); }
        return next;
      }); permissionLane = task.then(() => undefined, () => undefined); return task;
    },
    getMapping: (id: string) => mappings.get(id),
    listMappings: () => mappings.entries(),
    async putMapping(record: PathMappingRecord) { state.onMappingWrite?.(); events.push('mapping:put'); mappings.set(record.id, pathMappingSchema.parse(record)); },
    async deleteMapping(id: string) { events.push('mapping:delete'); return mappings.delete(id); },
    getSettings: () => state.settings,
    async putSettings(record: LocalSettingsRecord) { state.settings = localSettingsSchema.parse(record); },
  } as unknown as LocalStore;
  const settings = new SettingsService({ local, config: Config({ accountName: 'account123', defaultEnabled: true, connectionRef: 'CONTROLLER_TEST_UNUSED_REF' }), now: () => 5 });
  async function invoke(name: string, args: unknown[]) {
    const id = typeof args[0] === 'string' ? args[0] : undefined;
    calls.push({ name, ...(id === undefined ? {} : { id }), args });
    events.push(name);
    await state.onCall?.(name, args);
    return id;
  }
  const service = {
    async enable(...args: unknown[]) { await invoke('enable', args); return { status: 'synced', eventCount: 2, uploadedBatches: 1 }; },
    async disable(...args: unknown[]) { const id = await invoke('disable', args); const record = sessions.get(id!); if (record) sessions.set(id!, { ...record, enabled: false }); },
    async sync(...args: unknown[]) { await invoke('sync', args); return { status: 'synced', eventCount: 2, uploadedBatches: 0 }; },
    async detach(...args: unknown[]) { const id = await invoke('detach', args); const record = sessions.get(id!); if (record) sessions.set(id!, { ...record, enabled: false, detached: true, admissionStopped: false, status: 'detached' }); },
    async exportLocal(...args: unknown[]) { await invoke('exportLocal', args); return '/safe/export.jsonl'; },
    async repairSession(...args: unknown[]) { await invoke('repairSession', args); },
    async acknowledgeDegraded(...args: unknown[]) { await invoke('acknowledgeDegraded', args); },
    async ensureOwnership(...args: unknown[]) { await invoke('ensureOwnership', args); return { owned: true }; },
    async takeover(...args: unknown[]) { await invoke('takeover', args); return { status: 'synced', eventCount: 2, uploadedBatches: 0 }; },
    async removeFromCloud(...args: unknown[]) { await invoke('removeFromCloud', args); },
    async resurrectInCloud(...args: unknown[]) { await invoke('resurrectInCloud', args); },
    async importSession(...args: unknown[]) { const id = await invoke('importSession', args); sessions.set(id!, localSession({ sessionId: id!, enabled: true })); },
    async reconcile(...args: unknown[]) { await invoke('reconcile', args); },
    async stopForMapping(...args: unknown[]) {
      const id = await invoke('stopForMapping', args);
      const record = sessions.get(id!);
      if (record) sessions.set(id!, { ...record, mappingUnstable: true, admissionStopped: true, status: 'mapping-unstable' });
    },
    status(id: string) {
      const record = sessions.get(id);
      // Deliberately return the full internal record to prove the controller projects it.
      return { enabled: record?.enabled ?? false, status: record?.status ?? 'setup-needed', ...(record === undefined ? {} : { record }) };
    },
  } as unknown as SyncService;
  const remote = cloudSession({ sessionId: 'remote-1', title: 'T'.repeat(300), headerJson: HIDDEN });
  const repository = {
    async listManifestsPage(...args: unknown[]) {
      await invoke('listManifestsPage', args);
      return { items: [{ entity: remote, etag: HIDDEN }], nextCursor: 'next-page' };
    },
  } as unknown as CloudRepository;
  const core: CloudCore = { service, repository, testAuth: async (...args) => { await invoke('testAuth', args); } };
  const fs: CwdFs = {
    async realpath(path) { if (path === '/missing') throw new Error(HIDDEN); return path.replace(/^\/alias(?=\/|$)/u, '/local'); },
    async stat(path) { return { isDirectory: () => path !== '/file' }; },
  };
  const dependencies = {
    local, settings, gitMetadata: undefined as ((id: string, signal?: AbortSignal) => Promise<GitFacts | null>) | undefined,
    core: async (_signal: AbortSignal) => { state.coreCalls++; if (state.unavailable) throw new CloudControlError('SETUP_NEEDED'); return core; },
    current: () => state.active ? core : undefined,
    now: () => 10,
    fs,
  };
  const controller = new CloudController(dependencies);
  const run = (request: unknown, context: { origin?: 'command' | 'rpc'; sessionId?: string; signal?: AbortSignal } = {}) => controller.execute(request as CloudRequest, {
    origin: context.origin ?? 'rpc', signal: context.signal ?? signal(), ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  });
  return { controller, run, sessions, mappings, calls, events, state, settings, dependencies, core, remote };
}

test('ignored cancelled setup remains capacity-bounded while local opt-out stays available', async () => {
  const f = fixture([localSession({ sessionId: 'one' })]);
  f.state.active = false;
  const pending: ReturnType<typeof gate>[] = [];
  let started = gate();
  f.dependencies.core = async () => {
    f.state.coreCalls++;
    const wait = gate(); pending.push(wait); started.release();
    await wait.promise; return f.core;
  };
  try {
    for (let index = 0; index < 32; index++) {
      started = gate(); const abort = new AbortController();
      const work = f.run({ action: 'sync', sessionId: 'one' }, { signal: abort.signal });
      await started.promise; abort.abort();
      await assert.rejects(work, code('CANCELLED'));
    }
    await assert.rejects(f.run({ action: 'sync', sessionId: 'one' }), code('CAPACITY'));
    assert.equal(f.state.coreCalls, 32);
    await f.run({ action: 'toggle', sessionId: 'one', enabled: false });
    assert.equal(f.sessions.get('one')?.enabled, false);
    assert.equal(f.sessions.get('one')?.detached, true);
    assert.equal(f.calls.length, 0);
  } finally { for (const wait of pending) wait.release(); await setImmediate(); }
  f.dependencies.core = async () => f.core;
  await f.run({ action: 'test-auth' });
  assert.deepEqual(f.calls.map(call => call.name), ['testAuth']);
});

test('controller status is local, default-off, paginated and strictly excludes private diagnostics and raw receipts', async () => {
  const first = localSession({ sessionId: 'one', lastError: HIDDEN, conflictBackupPath: HIDDEN, localCwd: HIDDEN,
    status: 'remote-ahead-live', lastSyncedEventCount: 4, lastSyncedAt: 7,
    admissionReceipt: { reason: 'ownership-unverified', messageIds: [HIDDEN], at: 1 },
  });
  const f = fixture([first, localSession({ sessionId: 'two' }), localSession({ sessionId: 'three' })]);
  f.state.unavailable = true;
  const page = object(await f.run({ action: 'status', limit: 2 }));
  assert.equal(page.kind, 'status');
  assert.equal(object(page.settings).defaultEnabled, false);
  assert.equal(page.nextCursor, 'local:2');
  assert.equal(array(page.items).length, 2);
  const projected = object(array(page.items)[0]);
  assert.equal(projected.restartRequired, true);
  assert.equal(projected.hasConflictBackup, true);
  assert.equal(projected.eventCount, 4);
  for (const key of ['lastError', 'header', 'headerJson', 'admissionReceipt', 'localCwd', 'conflictBackupPath', 'connectionString']) assert.equal(Object.hasOwn(projected, key), false);
  assert.ok(!JSON.stringify(page).includes(HIDDEN));
  assert.match(page.projectionRevision as string, /^[0-9a-f]{64}$/u);
  const next = object(await f.run({ action: 'status', cursor: page.nextCursor, limit: 2 }));
  assert.deepEqual(array(next.items).map(item => object(item).sessionId), ['three']);
  assert.equal(next.nextCursor, undefined);
  const unknown = object(await f.run({ action: 'status', sessionId: 'new-thread' }));
  assert.deepEqual(unknown.untracked, { sessionId: 'new-thread', enabled: false, admissionRequired: false });
  assert.equal(f.state.coreCalls, 0);
  assert.deepEqual(f.calls, []);
});

test('Git inspection is exact-target local-only and advisory; safe source Git projects without raw URL data', async () => {
  const f = fixture([localSession({ sessionId: 'one' })]); f.state.unavailable = true; f.state.active = false;
  const facts: GitFacts = { v: 1, root: '/local/project', branch: 'main', commit: 'a'.repeat(40), detached: false, unborn: false, worktree: false, dirty: 'clean', remote: 'https://example.invalid/repo' };
  let reads = 0; f.dependencies.gitMetadata = async id => { assert.equal(id, 'one'); reads++; return facts; };
  const before = structuredClone([...f.sessions]), statusBefore = object(await f.run({ action: 'status' }));
  const data = await f.run({ action: 'git-info', sessionId: 'one' });
  const decoded = decodeCloudReply({ action: 'git-info', sessionId: 'one' }, { ok: true, value: { v: 1, ok: true, data } }); assert.deepEqual(decoded, { kind: 'git', sessionId: 'one', local: facts });
  assert.equal(reads, 1); assert.equal(f.state.coreCalls, 0); assert.deepEqual(f.calls, []); assert.deepEqual([...f.sessions], before);
  assert.equal(object(await f.run({ action: 'status' })).revision, statusBefore.revision);
  await assert.rejects(f.run({ action: 'git-info', cwd: '/remote/never-probe' }), code('INVALID_REQUEST'));
  f.dependencies.gitMetadata = async () => ({ ...facts, remote: 'https://example.invalid/repo?sig=must-not-cross' });
  assert.equal(object(await f.run({ action: 'git-info', sessionId: 'one' })).local, null);
  f.remote.gitJson = JSON.stringify(facts); f.state.unavailable = false; f.state.active = true;
  const row = object(array(object(await f.run({ action: 'pull' })).items)[0]); assert.deepEqual(row.git, facts); assert.equal(Object.hasOwn(row, 'gitJson'), false);
  f.remote.gitJson = JSON.stringify({ ...facts, remote: 'https://example.invalid/repo?sig=must-not-cross' });
  const rejected = object(array(object(await f.run({ action: 'pull' })).items)[0]); assert.equal(Object.hasOwn(rejected, 'git'), false); assert.ok(!JSON.stringify(rejected).includes('must-not-cross'));
  for (const scheme of ['http', 'https']) for (const userinfo of ['CANARYTOKEN', 'CANARYUSER:12345']) {
    const unsafe = `${scheme}://${userinfo}${String.fromCharCode(92)}@example.invalid/repo.git`;
    f.dependencies.gitMetadata = async () => ({ ...facts, remote: unsafe });
    const local = await f.run({ action: 'git-info', sessionId: 'one' }); assert.equal(object(local).local, null); assert.ok(!JSON.stringify(local).includes('CANARY'));
    f.remote.gitJson = JSON.stringify({ ...facts, remote: unsafe });
    const catalog = await f.run({ action: 'pull' }); const row = object(array(object(catalog).items)[0]);
    assert.equal(Object.hasOwn(row, 'git'), false); assert.ok(!JSON.stringify(catalog).includes('CANARY'));
    assert.equal(decodeCloudReply({ action: 'pull' }, { ok: true, value: { v: 1, ok: true, data: catalog } }).kind, 'remote');
  }
  for (const unsafe of ['CANARYUSER:12345@example.invalid:team/repo.git', 'org:glpat-CANARY@example.invalid:team/repo.git']) {
    f.dependencies.gitMetadata = async () => ({ ...facts, remote: unsafe });
    const local = await f.run({ action: 'git-info', sessionId: 'one' }); assert.equal(object(local).local, null); assert.doesNotMatch(JSON.stringify(local), /CANARY/iu);
    f.remote.gitJson = JSON.stringify({ ...facts, remote: unsafe });
    const catalog = await f.run({ action: 'pull' }); const row = object(array(object(catalog).items)[0]); assert.equal(Object.hasOwn(row, 'git'), false); assert.doesNotMatch(JSON.stringify(catalog), /CANARY/iu);
    assert.equal(decodeCloudReply({ action: 'pull' }, { ok: true, value: { v: 1, ok: true, data: catalog } }).kind, 'remote');
  }
});

test('cancelled advisory Git providers retain bounded slots and do not block local safety actions', async () => {
  const f = fixture([localSession({ sessionId: 'one' })]); f.state.active = false;
  const waits: ReturnType<typeof gate>[] = []; let started = gate();
  f.dependencies.gitMetadata = async () => { const wait = gate(); waits.push(wait); started.release(); await wait.promise; return null; };
  try {
    for (let index = 0; index < 16; index++) { started = gate(); const stop = new AbortController(); const pending = f.run({ action: 'git-info', sessionId: 'one' }, { signal: stop.signal }); await started.promise; stop.abort(); await assert.rejects(pending, code('CANCELLED')); }
    await assert.rejects(f.run({ action: 'git-info', sessionId: 'one' }), code('CAPACITY'));
    await f.run({ action: 'toggle', sessionId: 'one', enabled: false }); assert.equal(f.sessions.get('one')?.enabled, false); assert.equal(f.state.coreCalls, 0);
  } finally { for (const wait of waits) wait.release(); await setImmediate(); }
});

test('status cursor and public-controller request validation reject before network or mutations', async () => {
  const f = fixture();
  for (const request of [
    { action: 'status', cursor: 'local:-1' }, { action: 'status', cursor: 'local:01' },
    { action: 'status', cursor: 'local:10000000' }, { action: 'status', limit: 101 },
    { action: 'sync', sessionId: '' }, { action: 'sync', sessionId: 'x\n' },
    { action: 'sync', overwrite: true }, { action: 'merge', sessionId: 'one' },
  ]) await assert.rejects(f.run(request), code('INVALID_REQUEST'));
  assert.equal(f.state.coreCalls, 0);
  assert.deepEqual(f.calls, []);
});

test('confirmation gates run before core acquisition for remove, takeover, and resurrection', async () => {
  const f = fixture();
  for (const action of ['takeover', 'resurrect', 'remove']) {
    for (const confirm of [undefined, false, 'yes']) {
      const request = { action, sessionId: 'one', ...(confirm === undefined ? {} : { confirm }) };
      await assert.rejects(f.run(request), code('CONFIRM_REQUIRED'));
    }
  }
  await assert.rejects(f.run({ action: 'remove', sessionId: 'one', confirm: true }), code('CONFIRM_REQUIRED'));
  await assert.rejects(f.run({ action: 'remove', sessionId: 'one', confirm: true, acknowledgeAttachmentsRetained: false }), code('CONFIRM_REQUIRED'));
  assert.equal(f.state.coreCalls, 0);
  assert.deepEqual(f.calls, []);
});

test('all thread actions dispatch once with the explicit target and do not substitute RPC context', async () => {
  const f = fixture([localSession({ sessionId: 'target' })]);
  const cases: Array<[CloudRequest, string]> = [
    [{ action: 'toggle', enabled: true, sessionId: 'target' }, 'enable'],
    [{ action: 'toggle', enabled: false, sessionId: 'target' }, 'disable'],
    [{ action: 'sync', sessionId: 'target' }, 'sync'],
    [{ action: 'detach', sessionId: 'target' }, 'detach'],
    [{ action: 'export', sessionId: 'target' }, 'exportLocal'],
    [{ action: 'repair', sessionId: 'target' }, 'repairSession'],
    [{ action: 'acknowledge-degraded', sessionId: 'target' }, 'acknowledgeDegraded'],
    [{ action: 'check-ownership', sessionId: 'target' }, 'ensureOwnership'],
    [{ action: 'takeover', sessionId: 'target', confirm: true }, 'takeover'],
    [{ action: 'remove', sessionId: 'target', confirm: true, acknowledgeAttachmentsRetained: true }, 'removeFromCloud'],
    [{ action: 'resurrect', sessionId: 'target', confirm: true }, 'resurrectInCloud'],
  ];
  for (const [request, method] of cases) {
    const before = f.calls.length;
    const result = object(await f.run(request, { sessionId: 'context-must-not-win' }));
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.calls.at(-1)?.name, method);
    assert.equal(f.calls.at(-1)?.id, 'target');
    assert.equal(result.kind, 'action');
    assert.equal(result.sessionId, 'target');
    assert.equal(result.action, request.action);
  }
});

test('only native commands may infer a missing thread target; RPC cannot act on ambient conversation context', async () => {
  const f = fixture([localSession({ sessionId: 'native-thread' })]);
  await assert.rejects(f.run({ action: 'sync' }, { sessionId: 'native-thread' }), code('INVALID_REQUEST'));
  await assert.rejects(f.run({ action: 'sync' }, { origin: 'command' }), code('INVALID_REQUEST'));
  const result = object(await f.run({ action: 'sync' }, { origin: 'command', sessionId: 'native-thread' }));
  assert.equal(result.sessionId, 'native-thread');
  assert.equal(f.calls[0]?.id, 'native-thread');
  assert.equal(f.state.coreCalls, 1);
});

test('auth changes are browser-only; defaults remain explicit opt-in and never boot auth', async () => {
  const f = fixture();
  await assert.rejects(f.run({ action: 'set-auth', auth: 'azure-cli' }, { origin: 'command' }), code('FORBIDDEN'));
  assert.equal(f.state.settings, undefined);
  assert.equal(object(object(await f.run({ action: 'set-auth', auth: 'azure-cli' })).settings).auth, 'azure-cli');
  const response = object(await f.run({ action: 'set-defaults', pullOnStartup: false, pollSeconds: 60 }));
  assert.equal(object(response.settings).defaultEnabled, false);
  assert.equal(object(response.settings).pollSeconds, 60);
  await assert.rejects(f.run({ action: 'set-defaults', defaultEnabled: true }), (error: unknown) => error instanceof AzureSyncError && error.code === 'INVALID_CONFIG');
  assert.equal(f.state.coreCalls, 0);
});

test('test-auth is an explicit network action while remote listing projects only bounded manifest fields', async () => {
  const f = fixture();
  assert.deepEqual(await f.run({ action: 'test-auth' }), { kind: 'auth-test', configured: true });
  const listing = object(await f.run({ action: 'pull' }, { origin: 'command', sessionId: 'must-not-import' }));
  assert.equal(listing.kind, 'remote');
  assert.equal(listing.nextCursor, 'next-page');
  const item = object(array(listing.items)[0]);
  assert.equal((item.title as string).length, 256);
  assert.equal(item.sessionId, 'remote-1');
  for (const key of ['headerJson', 'headerHash', 'chainHash', 'etag', 'gitJson']) assert.equal(Object.hasOwn(item, key), false);
  assert.ok(!JSON.stringify(listing).includes(HIDDEN));
  assert.deepEqual(f.calls.map(call => call.name), ['testAuth', 'listManifestsPage']);
});

test('remote catalog exposes bounded folder and device hints without private payloads or lease authority', async () => {
  const f = fixture();
  f.remote.cwd = 'C:\\remote project'; f.remote.sourcePlatform = 'win32';
  f.remote.sourceDeviceId = 'source-device'; f.remote.lastWriterDevice = 'writer-device';
  f.remote.leaseOwner = 'reported-owner'; f.remote.leaseUntil = 123;
  const reply = object(await f.run({ action: 'pull', limit: 1 }));
  const row = object(array(reply.items)[0]);
  assert.equal(row.cwd, 'C:\\remote project'); assert.equal(row.sourceDeviceId, 'source-device');
  assert.equal(row.lastWriterDevice, 'writer-device'); assert.equal(row.leaseOwner, 'reported-owner'); assert.equal(row.leaseUntil, 123);
  for (const key of ['headerJson', 'gitJson', 'etag', 'lastError', 'owned']) assert.equal(Object.hasOwn(row, key), false);
  assert.ok(!JSON.stringify(reply).includes(HIDDEN));
  delete f.remote.cwd; delete f.remote.leaseOwner; delete f.remote.leaseUntil;
  const absent = object(array(object(await f.run({ action: 'pull', limit: 1 })).items)[0]);
  assert.equal(Object.hasOwn(absent, 'cwd'), false); assert.equal(Object.hasOwn(absent, 'leaseOwner'), false);
  assert.equal(Object.hasOwn(absent, 'leaseUntil'), false);
});

test('actual remote catalog DTO decodes in the browser with safe multiline display titles', async () => {
  const f = fixture();
  f.remote.title = 'First line\nSecond line\tend\u0000';
  const data = await f.run({ action: 'pull' });
  const reply = decodeCloudReply({ action: 'pull' }, { ok: true, value: { v: 1, ok: true, data } });
  assert.equal(reply.kind, 'remote');
  if (reply.kind !== 'remote') assert.fail('catalog reply required');
  assert.equal(reply.items[0]?.title, 'First line Second line end ');
  assert.ok(!JSON.stringify(reply).includes(HIDDEN));
  assert.deepEqual(f.calls.map(call => call.name), ['listManifestsPage']);
});

test('cold pull imports exactly one requested thread without enable, sync, or implicit live-Agent creation', async () => {
  const f = fixture([localSession({ sessionId: 'known' })]);
  await f.run({ action: 'pull', sessionId: 'cold' });
  await f.run({ action: 'pull', sessionId: 'known' });
  assert.deepEqual(f.calls.map(call => [call.name, call.id]), [['importSession', 'cold'], ['reconcile', 'known']]);
  assert.equal(f.sessions.get('cold')?.enabled, true);
  assert.equal(f.sessions.size, 2);
});

test('mapping creation canonicalizes roots and rejects same-prefix collisions before writes or session freezes', async () => {
  const f = fixture();
  const response = object(await f.run({ action: 'map', mapping: { remotePrefix: '/remote//repo/./', localPrefix: '/alias', remotePlatform: 'linux' } }));
  const mapping = object(response.mapping);
  assert.equal(mapping.remotePrefix, '/remote/repo');
  assert.equal(mapping.localPrefix, '/local');
  assert.equal(mapping.revision, mappingRevision('/remote/repo', '/local'));
  const stored = f.mappings.get(mapping.id as string);
  assert.equal(stored?.createdAt, 10);
  assert.equal(stored?.updatedAt, 10);
  await assert.rejects(f.run({ action: 'map', mapping: { remotePrefix: '/remote/repo/', localPrefix: '/other', remotePlatform: 'linux' } }), (error: unknown) => error instanceof AzureSyncError && error.code === 'AMBIGUOUS_MAPPING');
  assert.equal(f.mappings.size, 1);
  assert.deepEqual(f.events, ['mapping:put']);
  assert.equal(f.state.coreCalls, 0);
  assert.deepEqual(array(object(await f.run({ action: 'mappings' })).items), [mapping]);
});

test('Windows mapping collisions compare case-insensitively and invalid roots never persist', async () => {
  const f = fixture();
  await f.run({ action: 'map', mapping: { remotePrefix: 'C:\\Repo', localPrefix: '/local', remotePlatform: 'win32' } });
  await assert.rejects(f.run({ action: 'map', mapping: { remotePrefix: 'c:/repo/', localPrefix: '/other', remotePlatform: 'win32' } }), (error: unknown) => error instanceof AzureSyncError && error.code === 'AMBIGUOUS_MAPPING');
  for (const mapping of [
    { remotePrefix: '/remote/../escape', localPrefix: '/local', remotePlatform: 'linux' },
    { remotePrefix: '/remote', localPrefix: 'relative', remotePlatform: 'linux' },
    { remotePrefix: '/remote', localPrefix: '/missing', remotePlatform: 'linux' },
    { remotePrefix: '/remote', localPrefix: '/file', remotePlatform: 'linux' },
  ]) await assert.rejects(f.run({ action: 'map', mapping }));
  assert.equal(f.mappings.size, 1);
  assert.equal(f.state.coreCalls, 0);
});

test('editing and removing mappings freezes only affected attached threads before durable mutation', async () => {
  const f = fixture([
    localSession({ sessionId: 'canonical', canonicalCwd: '/remote/repo/sub' }),
    localSession({ sessionId: 'local', localCwd: '/local/sub' }),
    localSession({ sessionId: 'binding', importMappingId: MAPPING_ID }),
    localSession({ sessionId: 'boundary', canonicalCwd: '/remote/repository' }),
    localSession({ sessionId: 'detached', canonicalCwd: '/remote/repo', detached: true }),
  ]);
  f.mappings.set(MAPPING_ID, pathMapping({ id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/local', createdAt: 2 }));
  f.state.onMappingWrite = () => {
    for (const id of ['canonical', 'local', 'binding']) assert.equal(f.sessions.get(id)?.admissionStopped, true);
  };
  await f.run({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/changed', remotePlatform: 'linux' } });
  assert.deepEqual(f.calls.map(call => [call.name, call.id]), [['stopForMapping', 'canonical'], ['stopForMapping', 'local'], ['stopForMapping', 'binding']]);
  assert.equal(f.events.at(-1), 'mapping:put');
  assert.equal(f.mappings.get(MAPPING_ID)?.createdAt, 2);
  assert.equal(f.sessions.get('boundary')?.admissionStopped, undefined);
  assert.equal(f.sessions.get('detached')?.admissionStopped, undefined);
  // Merely editing the mapping never repairs the admission stop.
  assert.equal(f.sessions.get('canonical')?.mappingUnstable, true);
  f.calls.length = 0;
  await f.run({ action: 'unmap', mappingId: MAPPING_ID });
  assert.deepEqual(f.calls.map(call => call.id), ['canonical', 'binding']);
  assert.equal(f.events.at(-1), 'mapping:delete');
  assert.equal(f.mappings.size, 0);
});

test('mapping cancellation after a stop cannot publish the edit or clear the admission block', async () => {
  const f = fixture([localSession({ sessionId: 'affected', canonicalCwd: '/remote/repo/sub' })]);
  const mapping = pathMapping({ id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/local' });
  f.mappings.set(MAPPING_ID, mapping);
  const abort = new AbortController();
  f.state.onCall = async name => { if (name === 'stopForMapping') abort.abort(HIDDEN); };
  await assert.rejects(f.run({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/changed', remotePlatform: 'linux' } }, { signal: abort.signal }), code('CANCELLED'));
  assert.deepEqual(f.mappings.get(MAPPING_ID), mapping);
  assert.equal(f.events.includes('mapping:put'), false);
  assert.equal(f.sessions.get('affected')?.admissionStopped, true);
});

test('unknown mapping edits and removals fail before filesystem/network mutation', async () => {
  const f = fixture();
  await assert.rejects(f.run({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote', localPrefix: '/local', remotePlatform: 'linux' } }), code('INVALID_REQUEST'));
  await assert.rejects(f.run({ action: 'unmap', mappingId: MAPPING_ID }), code('INVALID_REQUEST'));
  assert.deepEqual(f.events, []);
  assert.equal(f.state.coreCalls, 0);
});

test('mapping repair confirmation is passed explicitly and never inferred by a normal repair request', async () => {
  const f = fixture([localSession({ sessionId: 'mapped', status: 'mapping-unstable', mappingUnstable: true, admissionStopped: true })]);
  await f.run({ action: 'repair', sessionId: 'mapped' });
  await f.run({ action: 'repair', sessionId: 'mapped', confirmMapping: true });
  assert.equal((f.calls[0]?.args[1] as { confirmMapping: boolean }).confirmMapping, false);
  assert.equal((f.calls[1]?.args[1] as { confirmMapping: boolean }).confirmMapping, true);
  await assert.rejects(f.run({ action: 'repair', sessionId: 'mapped', confirmMapping: false }), code('INVALID_REQUEST'));
});

test('actual controller and SyncService keep mapping admission stopped until confirmed complete cold repair', async () => {
  const f = fixture([localSession({ sessionId: 'imported', imported: true, importState: 'complete',
    importMappingId: MAPPING_ID, importMappingRevision: 'a'.repeat(64), canonicalCwd: '/remote/repo/sub' })]);
  f.mappings.set(MAPPING_ID, pathMapping({ id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/local' }));
  let completion: 'partial' | 'complete' = 'partial';
  let generation = 1;
  let resumes = 0;
  const paused: string[] = [];
  const imports = {
    async resume(id: string, options: { signal?: AbortSignal; confirmMapping?: boolean }) {
      resumes++;
      assert.equal(options.confirmMapping, true);
      assert.equal(options.signal?.aborted, false);
      assert.equal(f.sessions.get(id)?.admissionStopped, true);
      if (completion === 'complete') {
        // Stand in only for the importer's already-tested forward-provenance
        // validation/finalization; the REAL service owns releasing admission.
        await f.dependencies.local.putSession({ ...f.sessions.get(id)!, status: 'synced', importState: 'complete',
          importMappingRevision: f.mappings.get(MAPPING_ID)!.revision });
      }
      return { status: completion };
    },
  } as unknown as ImportService;
  const uploader = {
    async pause(id: string) {
      assert.equal(f.sessions.get(id)?.admissionStopped, true);
      assert.equal(f.sessions.get(id)?.mappingUnstable, true);
      paused.push(id);
    },
  } as unknown as Uploader;
  const repository = { async getManifest() { return { entity: cloudSession({ sessionId: 'imported', generation }), etag: 'safe-etag' }; } } as unknown as CloudRepository;
  const service = new SyncService({ local: f.dependencies.local, uploader, imports, repository });
  const core = { ...f.core, service };
  const controller = new CloudController({ ...f.dependencies, core: async () => core, current: () => core });
  const execute = (request: CloudRequest) => controller.execute(request, { origin: 'rpc', signal: signal() });
  await execute({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/changed', remotePlatform: 'linux' } });
  assert.deepEqual(paused, ['imported']);
  assert.equal(f.sessions.get('imported')?.admissionStopped, true);
  await assert.rejects(execute({ action: 'repair', sessionId: 'imported' }), (error: unknown) => error instanceof AzureSyncError && error.code === 'MAPPING_UNSTABLE');
  assert.equal(resumes, 0);
  await execute({ action: 'repair', sessionId: 'imported', confirmMapping: true });
  assert.equal(resumes, 1);
  assert.equal(f.sessions.get('imported')?.admissionStopped, true);
  assert.equal(f.sessions.get('imported')?.mappingUnstable, true);
  completion = 'complete';
  await execute({ action: 'repair', sessionId: 'imported', confirmMapping: true });
  assert.equal(resumes, 2);
  assert.equal(f.sessions.get('imported')?.admissionStopped, false);
  assert.equal(f.sessions.get('imported')?.mappingUnstable, false);
  assert.equal(f.sessions.get('imported')?.importMappingRevision, f.mappings.get(MAPPING_ID)?.revision);
  // Mapping confirmation is never permission to adopt a later cloud generation.
  await execute({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/another', remotePlatform: 'linux' } });
  generation = 2;
  await assert.rejects(execute({ action: 'repair', sessionId: 'imported', confirmMapping: true }), (error: unknown) => error instanceof AzureSyncError && error.code === 'GENERATION_CHANGED');
  assert.equal(resumes, 2);
  assert.equal(f.sessions.get('imported')?.admissionStopped, true);
});

test('actual service rejects confirmed mapping repair for a retained live Agent before importing', async () => {
  const f = fixture([localSession({ sessionId: 'live', imported: true, mappingUnstable: true, admissionStopped: true, status: 'mapping-unstable' })]);
  let imported = false;
  const service = new SyncService({
    local: f.dependencies.local,
    uploader: {} as Uploader,
    agents: { get: () => ({ id: 'live' }) as never },
    imports: { async resume() { imported = true; throw new Error('must not reach importer'); } } as unknown as ImportService,
  });
  const core = { ...f.core, service };
  const controller = new CloudController({ ...f.dependencies, core: async () => core });
  await assert.rejects(controller.execute({ action: 'repair', sessionId: 'live', confirmMapping: true }, { origin: 'rpc', signal: signal() }), (error: unknown) => error instanceof AzureSyncError && error.code === 'IMPORT_RACE');
  assert.equal(imported, false);
  assert.equal(f.sessions.get('live')?.admissionStopped, true);
});

test('failed mapping freeze cannot publish edited mapping or process unrelated control actions', async () => {
  const f = fixture([localSession({ sessionId: 'affected', canonicalCwd: '/remote/repo/sub' })]);
  const mapping = pathMapping({ id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/local' });
  f.mappings.set(MAPPING_ID, mapping);
  f.state.onCall = async name => { if (name === 'stopForMapping') throw new Error(HIDDEN); };
  await assert.rejects(f.run({ action: 'map', mapping: { id: MAPPING_ID, remotePrefix: '/remote/repo', localPrefix: '/changed', remotePlatform: 'linux' } }));
  assert.deepEqual(f.mappings.get(MAPPING_ID), mapping);
  assert.equal(f.events.includes('mapping:put'), false);
});

test('local detach and off work while auth/core is unavailable, without bootstrapping network services', async () => {
  for (const action of ['detach', 'off']) {
    const f = fixture([localSession({ sessionId: 'offline', status: 'auth-error', admissionStopped: true })]);
    f.state.unavailable = true;
    f.state.active = false;
    const response = object(await f.run(action === 'detach' ? { action: 'detach', sessionId: 'offline' } : { action: 'toggle', sessionId: 'offline', enabled: false }));
    assert.equal(response.kind, 'action');
    assert.equal(f.sessions.get('offline')?.enabled, false);
    if (action === 'detach') assert.equal(f.sessions.get('offline')?.detached, true);
    assert.equal(f.state.coreCalls, 0);
    assert.deepEqual(f.calls, []);
  }
});

test('offline export uses persistence source only and returns a path rather than local payloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'azure-controller-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture([localSession({ sessionId: 'offline' })]);
  f.state.unavailable = true;
  f.state.active = false;
  const sourceCalls: string[] = [];
  const snapshot = { header: sessionHeader({ id: 'offline' }), inheritedEventCount: 0, events: [event(0, 'user/message', { content: [{ type: 'text', text: HIDDEN }] })] } as unknown as SourceSnapshot;
  const source: SessionSource = {
    async flush() { sourceCalls.push('flush'); },
    async read(id) { sourceCalls.push(`read:${id}`); return snapshot; },
    async stat() { throw new Error('export must use fresh durable read, not a live Agent'); },
  };
  const controller = new CloudController({ ...f.dependencies, source, exportDirectory: root });
  const result = object(await controller.execute({ action: 'export', sessionId: 'offline' }, { origin: 'rpc', signal: signal() }));
  const path = object(result.detail).exportPath;
  assert.equal(typeof path, 'string');
  assert.ok((path as string).startsWith(root));
  assert.ok(!JSON.stringify(result).includes(HIDDEN));
  assert.ok((await readFile(path as string, 'utf8')).includes(HIDDEN));
  assert.equal((await stat(path as string)).mode & 0o777, 0o600);
  assert.deepEqual(sourceCalls, ['flush', 'read:offline']);
  assert.equal(f.state.coreCalls, 0);
  assert.deepEqual(f.calls, []);
});

test('network actions remain setup-gated when optional auth/core is unavailable', async () => {
  const f = fixture([localSession({ sessionId: 'offline' })]);
  f.state.unavailable = true;
  f.state.active = false;
  for (const request of [
    { action: 'toggle', sessionId: 'offline', enabled: true }, { action: 'sync', sessionId: 'offline' },
    { action: 'pull', sessionId: 'cold' }, { action: 'test-auth' },
    { action: 'takeover', sessionId: 'offline', confirm: true },
    { action: 'remove', sessionId: 'offline', confirm: true, acknowledgeAttachmentsRetained: true },
    { action: 'resurrect', sessionId: 'offline', confirm: true },
  ]) await assert.rejects(f.run(request), code('SETUP_NEEDED'));
  assert.deepEqual(f.calls, []);
});

test('an expired runtime core cannot authenticate network actions or prevent offline local detach', async () => {
  const f = fixture([localSession({ sessionId: 'expired' })]);
  const lifetime = new AbortController();
  lifetime.abort(HIDDEN);
  const expired: CloudCore = { ...f.core, signal: lifetime.signal };
  const controller = new CloudController({ ...f.dependencies, core: async () => expired, current: () => expired });
  await assert.rejects(controller.execute({ action: 'test-auth' }, { origin: 'rpc', signal: signal() }), code('SETUP_NEEDED'));
  await controller.execute({ action: 'detach', sessionId: 'expired' }, { origin: 'rpc', signal: signal() });
  assert.equal(f.sessions.get('expired')?.enabled, false);
  assert.equal(f.sessions.get('expired')?.detached, true);
  assert.deepEqual(f.calls, []);
});

for (const localAction of ['off', 'detach'] as const) {
  test(`offline local ${localAction} bypasses aborted pending network setup`, async () => {
    const f = fixture([localSession({ sessionId: 'blocked-setup', status: 'auth-error', admissionStopped: true })]);
    f.state.active = false;
    const entered = gate();
    const released = gate();
    let coreCalls = 0;
    const controller = new CloudController({ ...f.dependencies, core: async () => {
      coreCalls++;
      entered.release();
      // Deliberately ignore cancellation like a late ambient credential discovery.
      await released.promise;
      return f.core;
    } });
    const cancelled = new AbortController();
    const first = controller.execute({ action: 'sync', sessionId: 'blocked-setup' }, { origin: 'rpc', signal: cancelled.signal });
    const rejectedFirst = assert.rejects(first, code('CANCELLED'));
    await entered.promise;
    cancelled.abort(HIDDEN);
    const request: CloudRequest = localAction === 'off'
      ? { action: 'toggle', sessionId: 'blocked-setup', enabled: false }
      : { action: 'detach', sessionId: 'blocked-setup' };
    const optOut = controller.execute(request, { origin: 'rpc', signal: signal() });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        optOut.then(response => ({ completed: true as const, response })),
        new Promise<{ completed: false }>(resolve => { timeout = setTimeout(() => resolve({ completed: false }), 100); }),
      ]);
      if (!result.completed) assert.fail('Explicit local opt-out waited behind an aborted, unresolved network setup.');
      assert.equal(object(result.response).kind, 'action');
      assert.equal(f.sessions.get('blocked-setup')?.enabled, false);
      assert.equal(f.sessions.get('blocked-setup')?.detached, true);
      assert.equal(f.sessions.get('blocked-setup')?.admissionStopped, false);
      assert.equal(coreCalls, 1, 'Local opt-out must not acquire another network core.');
      assert.deepEqual(f.calls, []);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      // Release even on a RED assertion so the test leaves no dangling operation.
      released.release();
      await rejectedFirst;
      await optOut;
      controller.close();
    }
    assert.equal(coreCalls, 1);
    assert.deepEqual(f.calls, [], 'A late setup result must not start the cancelled network action.');
  });
}

test('aborted and closed controller operations cannot reach services, including after an awaited core acquisition', async () => {
  const f = fixture();
  const aborted = new AbortController();
  aborted.abort(HIDDEN);
  await assert.rejects(f.run({ action: 'test-auth' }, { signal: aborted.signal }), code('CANCELLED'));
  assert.equal(f.state.coreCalls, 0);
  const entered = gate();
  const released = gate();
  const pending = new AbortController();
  const controller = new CloudController({ ...f.dependencies, core: async () => { entered.release(); await released.promise; return f.core; } });
  const execution = controller.execute({ action: 'test-auth' }, { origin: 'rpc', signal: pending.signal });
  await entered.promise;
  pending.abort(HIDDEN);
  released.release();
  await assert.rejects(execution, code('CANCELLED'));
  assert.deepEqual(f.calls, []);
  f.controller.close();
  await assert.rejects(f.run({ action: 'status' }), code('CANCELLED'));
  await assert.rejects(f.run({ action: 'mappings' }), code('CANCELLED'));
});

test('controller mutation and credential-maintenance work share one queue; failure does not poison later actions', async () => {
  const f = fixture([localSession({ sessionId: 'one' })]);
  const entered = gate();
  const released = gate();
  f.state.onCall = async name => { if (name === 'sync') { entered.release(); await released.promise; throw new Error(HIDDEN); } };
  const syncing = f.run({ action: 'sync', sessionId: 'one' });
  const rejected = assert.rejects(syncing);
  await entered.promise;
  const maintaining = f.controller.maintenance(async () => { f.events.push('maintenance'); });
  const defaults = f.run({ action: 'set-defaults', pollSeconds: 45 });
  assert.deepEqual(f.events, ['sync']);
  released.release();
  await rejected;
  await maintaining;
  assert.equal(object(object(await defaults).settings).pollSeconds, 45);
  assert.deepEqual(f.events, ['sync', 'maintenance']);
  const status = object(await f.run({ action: 'status' }));
  assert.equal(status.revision, 2);
});
