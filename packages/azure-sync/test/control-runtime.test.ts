import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { decodeGitJson } from '../src/git/sanitize.js';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { HostConnectionService, serverResponseSchema, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { CredentialProvider, credentialRef, type CredentialRef, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { BlobServiceClient } from '@azure/storage-blob';
import { TableClient, TableServiceClient } from '@azure/data-tables';
import * as AzurePlugin from '../src/index.js';
import { Config } from '../src/config.js';
import { localDomain } from '../src/local/store.js';
import { localSessionRecordSchema, localSettingsSchema } from '../src/schema.js';
import { CLOUD_ACTION_ENDPOINT as ACTION, CLOUD_STATUS_ENDPOINT as STATUS } from '../src/rpc.js';
import type { CloudEnvelope, CloudRequest } from '../src/protocol.js';
import { CloudRepository, leaseBlobName } from '../src/sync/cloud-repository.js';
import { BlobStore } from '../src/azure/blob.js';
import { TableStore } from '../src/azure/table.js';
import { RemoteSessionReader } from '../src/sync/remote-session.js';
import { ManifestPoller } from '../src/sync/poller.js';
import { AcceptanceCloud, acceptanceDevice } from './acceptance-helpers.js';
import { localSession } from './helpers.js';
import { emulatorKey, eventually, removeTemporaryRoot, startAzurite, temporaryRoot } from './azurite-helpers.js';

/** A real SDK credential service implementation: only the provider owns values.
 * It deliberately stores in memory, not the settings/domain/JSONL tree under test.
 * notifyUpdated is the SDK's actual contained public event dispatch, not ctx.emit.
 */
class RuntimeCredentials extends CredentialProvider {
  private readonly values = new Map<CredentialRef, string>();
  private readonly records = new Map<CredentialKey, CredentialRecord>();
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  async resolve(ref: CredentialRef) { this.reads.push(ref); const value = this.values.get(ref); return value === undefined ? undefined : { value, source: 'file' }; }
  async describe(ref: CredentialRef) { return { configured: this.values.has(ref), writable: true, ...(this.values.has(ref) ? { source: 'file' } : {}) }; }
  async set(ref: CredentialRef, value: string) { assert.ok(value.trim()); this.values.set(ref, value); this.writes.push(ref); this.notifyUpdated(ref); }
  async unset(ref: CredentialRef) { this.values.delete(ref); this.writes.push(ref); this.notifyUpdated(ref); }
  async readRecord(key: CredentialKey) { return this.records.get(key); }
  async describeRecord(key: CredentialKey) { const value = this.records.get(key); return { configured: value !== undefined, writable: true, ...(value ? { kind: value.kind } : {}) }; }
  async listRecords() { return [...this.records].map(([key, value]) => ({ key, kind: value.kind })); }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) { const next = await mutate(this.records.get(key)); if (next !== undefined) this.records.set(key, next); return this.records.get(key); }
  async deleteRecord(key: CredentialKey) { this.records.delete(key); }
}

const authority = '127.0.0.1:45291';
const origin = `http://${authority}`;
const cookie = 'control-runtime=owner';
const lifecycleEvents = ['session/event', 'session/flush', 'session/created', 'agent/status', 'agent/inbox/inserted'];

async function gitProject(cwd: string) {
  const binary = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/cmd/git.exe') : '/usr/bin/git';
  const run = (...args: string[]) => { const result = spawnSync(binary, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', shell: false }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  run('init', '--initial-branch=main'); await writeFile(join(cwd, 'source.txt'), 'Only this code remains local.\n'); run('add', '--', 'source.txt'); run('commit', '-m', 'fixture');
  run('config', 'remote.origin.url', ['https://', 'fixture:synthetic-pass@example.invalid/repo?sig=must-not-cross#private'].join(''));
  return run('rev-parse', 'HEAD');
}

async function runtime(t: TestContext, options: { persisted?: boolean; credentials?: boolean } = {}) {
  const prefix = 'azure-control-runtime-';
  const root = await temporaryRoot(prefix);
  const resources: Array<() => Promise<unknown>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const dispose of resources.reverse()) await dispose();
  };
  t.after(async () => { try { await close(); } finally { await removeTemporaryRoot(root, prefix); } });
  const host = await acceptanceDevice(join(root, 'host'), 'device-a', new AcceptanceCloud());
  resources.push(() => host.close());
  const enabledId = `control-enabled-${randomUUID()}`;
  const detachId = `control-detach-${randomUUID()}`;
  const freshId = `control-new-${randomUUID()}`;
  const enabled = await host.create(enabledId);
  const detach = await host.create(detachId);
  enabled.session.append('session/title', { title: 'Complete local history before explicit opt-in', messageSeqs: [], source: { kind: 'user' } });
  if (options.persisted) {
    await host.local.putSession(localSession({ sessionId: enabledId }));
    await host.local.putSession(localSession({ sessionId: detachId }));
  }
  await host.ctx.sessionPersistence.flush();
  await host.service.close(); await host.local.close();
  host.ctx.provide('storageDomain', host.facility);
  new CommandRuntime(host.ctx);
  const credentials = options.credentials === false ? undefined : new RuntimeCredentials(host.ctx);
  const connectionScope = host.ctx.plugin((ctx: Context) => {
    new HostConnectionService(ctx, [], {
      isAuthenticated(incoming: Request) { return incoming.headers.get('host') === authority && incoming.headers.get('cookie') === cookie; },
      authenticateApi() { return undefined; },
    } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  });
  resources.push(() => connectionScope.dispose());
  await connectionScope.await(); assert.equal(connectionScope.state, 2);
  const connection = host.ctx.get('connection') as HostConnectionHandle;
  const shared = connection.createSharedFetchHandler('/api');
  const reference = `AZURE_RUNTIME_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  assert.equal(process.env[reference], undefined);
  // Administrator-only insecure permission is scoped to the ephemeral emulator.
  // Deliberately hostile default: the plugin must still leave every new thread off.
  const config = Config({ auth: 'connection-string', connectionRef: reference, allowInsecure: true, defaultEnabled: true, pullOnStartup: false, pollSeconds: 30, maxRetries: 0, requestTimeoutMs: 1_000, maxBatchEvents: 4 });
  const output: string[] = []; const logs: unknown[] = [];
  const subscriptions = new Map<string, number>();
  const peaks = new Map<string, number>();
  const scope = host.ctx.plugin({ name: 'control-runtime-fixture', inject: AzurePlugin.inject, apply: async (ctx: Context) => {
    // Observe only the public registration/disposer seam supplied to ACTUAL apply;
    // no service/controller/scheduler private field is read or replaced.
    const on = ctx.on.bind(ctx);
    const observedOn = ((...args: unknown[]) => {
      const dispose = Reflect.apply(on, ctx, args) as () => boolean;
      const name = String(args[0]);
      const next = (subscriptions.get(name) ?? 0) + 1;
      subscriptions.set(name, next); peaks.set(name, Math.max(peaks.get(name) ?? 0, next));
      let stopped = false;
      return () => { if (stopped) return false; stopped = true; subscriptions.set(name, (subscriptions.get(name) ?? 1) - 1); return dispose(); };
    }) as typeof ctx.on;
    ctx.provide('logger', { debug: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) });
    // A facade preserves Cordis's original shared event service; assigning ctx.on
    // would replace that service method for unrelated scopes as well.
    const observed = new Proxy(ctx, { get(target, key) { return key === 'on' ? observedOn : Reflect.get(target, key, target); } });
    await AzurePlugin.apply(observed, config);
  } });
  resources.push(() => scope.dispose());
  await scope.await(); assert.equal(scope.state, 2, 'the real plugin remains mounted despite missing authentication');
  const domain = host.facility.get(localDomain.name); assert.ok(domain);
  const record = (id: string) => { const value = domain.table('sessions').get(id); return value === undefined ? undefined : localSessionRecordSchema.parse(value); };
  const rpc = async (request: CloudRequest, endpoint = request.action === 'status' || request.action === 'mappings' ? STATUS : ACTION): Promise<CloudEnvelope> => {
    const incoming = new Request(`${origin}/api/${endpoint}`, { method: 'POST', headers: { host: authority, origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'runtime-call', method: endpoint, payload: { v: 1, request } }) });
    const admission = connection.admit(incoming);
    assert.ok(!('rejection' in admission), 'actual host admission accepts only the test owner');
    const response = await shared.fetch(incoming, admission.peer);
    assert.equal(response.status, 200);
    const text = await response.text(); output.push(text);
    const wire = serverResponseSchema.parse(JSON.parse(text));
    assert.equal(wire.type, 'server-response'); assert.equal(wire.result.ok, true);
    if (!wire.result.ok) throw new Error('Unexpected transport failure.');
    return wire.result.value as CloudEnvelope;
  };
  const action = async (request: CloudRequest) => { const result = await rpc(request); if (!result.ok) assert.fail(JSON.stringify(result)); return result.data as Record<string, unknown>; };
  const command = async (agent: typeof enabled, input: string) => {
    const result = await host.ctx.commands.execute(agent, `/cloud ${input}`, [], new AbortController().signal);
    assert.ok(result, 'actual native command registry contains cloud'); output.push(JSON.stringify(result)); return result;
  };
  const commandOk = async (agent: typeof enabled, input: string) => { const result = await command(agent, input); assert.equal(result.result.kind, 'success', result.result.text); return result; };
  const assertSubscriptions = (booted: boolean) => {
    assert.equal(subscriptions.get('agent/pre-step'), 1, 'exactly one permanent conservative admission hook');
    assert.equal(subscriptions.get('credentials/reference-updated'), 1);
    for (const event of lifecycleEvents) {
      const expected = (event === 'session/created' ? 1 : 0) + (booted ? 1 : 0);
      assert.equal(subscriptions.get(event) ?? 0, expected, `live public subscription count: ${event}`);
      assert.ok((peaks.get(event) ?? 0) <= (event === 'session/created' ? 2 : 1), `no overlapping old/new lifecycle subscription: ${event}`);
    }
  };
  const assertNoSecrets = async () => {
    for (const value of [JSON.stringify(config), JSON.stringify(output), JSON.stringify(logs)]) {
      assert.ok(!value.includes(emulatorKey)); assert.doesNotMatch(value, /AccountKey=|SharedAccessSignature=/u);
    }
    const inspect = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const target = join(path, entry.name);
        if (entry.isDirectory()) await inspect(target);
        else if (entry.isFile()) { const text = await readFile(target, 'utf8'); assert.ok(!text.includes(emulatorKey), `credential must not enter host durable files: ${entry.name}`); assert.doesNotMatch(text, /AccountKey=|SharedAccessSignature=/u); }
      }
    };
    await inspect(join(root, 'host'));
  };
  return { root, host, enabled, enabledId, detach, detachId, freshId, credentials, config, reference, scope, subscriptions, rpc, action, command, commandOk, record, domain, assertSubscriptions, assertNoSecrets, close };
}

function remote(connection: string) {
  const blob = BlobServiceClient.fromConnectionString(connection);
  const container = blob.getContainerClient('dsh-state');
  const table = TableClient.fromConnectionString(connection, 'dshstatesync', { allowInsecureConnection: true });
  const repository = new CloudRepository(new BlobStore(container), new TableStore(table));
  const reader = new RemoteSessionReader(repository, { maxCompressedBytes: 1_048_576, maxExpandedBytes: 3_145_728 });
  return { blob, container, table, repository, reader };
}

test('actual missing-auth boot still registers settings/RPC/native controls; off and detach restore real local AgentLoop continuation', { timeout: 20_000 }, async t => {
  const f = await runtime(t, { persisted: true, credentials: false });
  f.assertSubscriptions(false);
  const commit = await gitProject(f.host.cwd), index = join(f.host.cwd, '.git/index');
  const indexBytes = await readFile(index), indexMtime = (await stat(index, { bigint: true })).mtimeNs;
  const recordBeforeGit = structuredClone(f.record(f.enabledId)), agentsBeforeGit = f.host.ctx.agents.list().length;
  const inspected = await f.action({ action: 'git-info', sessionId: f.enabledId });
  assert.deepEqual(inspected, { kind: 'git', sessionId: f.enabledId, local: { v: 1, root: f.host.cwd, branch: 'main', commit, detached: false, unborn: false, worktree: false, dirty: 'clean', remote: 'https://example.invalid/repo' } });
  assert.deepEqual(f.record(f.enabledId), recordBeforeGit); assert.equal(f.host.ctx.agents.list().length, agentsBeforeGit); assert.equal(f.host.llmCalls, 0);
  assert.deepEqual(await readFile(index), indexBytes); assert.equal((await stat(index, { bigint: true })).mtimeNs, indexMtime);
  assert.equal(f.host.ctx.commands.find(f.enabled, 'cloud')?.recordInput, false);
  const initial = await f.action({ action: 'status', sessionId: f.enabledId });
  assert.equal(initial.kind, 'status');
  assert.deepEqual((initial.settings as { connection: unknown }).connection, { configured: false, writable: false });
  assert.equal((initial.settings as { defaultEnabled: boolean }).defaultEnabled, false);
  assert.equal((await f.rpc({ action: 'test-auth' })).ok, false);
  assert.equal((await f.command(f.enabled, 'on')).result.kind, 'error');
  assert.equal(f.record(f.enabledId)?.enabled, true, 'failed auth must not clear existing durable opt-in');

  const blocked = f.host.prompt('This work is blocked until an explicit local choice.');
  f.enabled.send(blocked, 'next-turn', true); await f.enabled.whenIdle();
  assert.equal(f.host.llmCalls, 0);
  assert.deepEqual(f.enabled.inbox.nextTurn.map(value => value.id), [blocked.id]);
  await f.commandOk(f.enabled, 'off');
  const offlineStatus = await f.action({ action: 'status', sessionId: f.enabledId });
  assert.equal((offlineStatus.items as Array<{ status: string }>)[0]?.status, 'detached');
  assert.equal(f.record(f.enabledId)?.enabled, false);
  assert.equal(f.record(f.enabledId)?.detached, true);
  await f.commandOk(f.detach, 'detach');
  assert.equal(f.record(f.detachId)?.detached, true);
  const nativeStatus = await f.commandOk(f.enabled, 'status');
  assert.match(nativeStatus.result.text!, /detached/u);

  const prompt = f.host.prompt('Continue locally after explicit offline detach.');
  f.detach.send(prompt, 'next-turn', true); await f.detach.whenIdle();
  assert.equal(f.host.llmCalls, 1);
  assert.equal(f.detach.inbox.nextTurn.length, 0);
  // Retrigger the retained off agent; the previously rejected prompt is preserved.
  f.enabled.send(f.host.prompt('Continue the retained local thread.'), 'next-turn', true); await f.enabled.whenIdle();
  assert.ok(f.host.llmCalls > 1, 'the formerly blocked retained agent now executes local turns'); assert.equal(f.enabled.inbox.nextTurn.length, 0);
  await f.host.ctx.sessionPersistence.flush();
  assert.equal((await f.host.source.read(f.enabledId))!.events.filter(value => value.type === 'user/message' && value.data.id === blocked.id).length, 1);
  f.assertSubscriptions(false);
  await f.assertNoSecrets();
});

test('actual RPC credential setup rebuilds the mounted runtime; test-auth creates private Blob/Table only, then native on uploads complete JSONL history', { timeout: 60_000 }, async t => {
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const f = await runtime(t);
  const azure = remote(emulator.connection());
  const gitCommit = await gitProject(f.host.cwd);
  f.assertSubscriptions(false);
  const blank = await f.host.create(f.freshId);
  const before = await f.action({ action: 'status', sessionId: f.freshId });
  assert.deepEqual(before.untracked, { sessionId: f.freshId, enabled: false, admissionRequired: false });
  assert.equal(f.record(f.freshId), undefined);
  assert.equal((await f.action({ action: 'status', sessionId: f.enabledId })).untracked !== undefined, true, 'persisted ordinary JSONL is also untracked by default');
  const scopesBefore = f.scope;
  const settings = await f.action({ action: 'set-auth', auth: 'connection-string', connectionString: emulator.connection() });
  assert.equal(settings.kind, 'settings');
  assert.deepEqual((settings.settings as { connection: unknown }).connection, { configured: true, writable: true, source: 'file' });
  await setImmediate(); await setImmediate(); // drain SDK credential-notification maintenance
  f.assertSubscriptions(true);
  assert.equal(f.scope, scopesBefore); assert.equal(f.scope.state, 2, 'same public plugin scope: no reload');
  assert.deepEqual(f.credentials!.writes, [f.reference]);
  assert.ok(f.credentials!.reads.every(ref => ref === f.reference), 'fixed configured credential reference only');
  assert.equal(await azure.container.exists(), false, 'configure/rebuild is network-lazy');
  assert.equal(f.record(f.freshId), undefined); assert.equal(f.record(f.enabledId), undefined);

  assert.deepEqual(await f.action({ action: 'test-auth' }), { kind: 'auth-test', configured: true });
  const containers = []; for await (const item of azure.blob.listContainers()) containers.push(item.name);
  assert.deepEqual(containers, ['dsh-state']);
  const tables = []; for await (const item of TableServiceClient.fromConnectionString(emulator.connection(), { allowInsecureConnection: true }).listTables()) tables.push(item.name);
  assert.deepEqual(tables, ['dshstatesync']);
  assert.equal((await azure.container.getAccessPolicy()).blobPublicAccess, undefined, 'container remains private');
  const blobs = []; for await (const item of azure.container.listBlobsFlat()) blobs.push(item.name);
  assert.deepEqual(blobs, [], 'test-auth does not create leases, history, or attachment blobs');
  const rows = []; for await (const item of azure.table.listEntities()) rows.push(item);
  assert.deepEqual(rows, [], 'test-auth does not create a session manifest');
  assert.equal(f.record(f.freshId), undefined);

  const earlier = f.host.prompt('Existing history must be uploaded when I opt in later.');
  f.enabled.send(earlier, 'next-turn', true); await f.enabled.whenIdle();
  const calls = f.host.llmCalls;
  await f.host.ctx.sessionPersistence.flush();
  const historyBeforeOn = await f.host.source.read(f.enabledId); assert.ok(historyBeforeOn);
  await f.commandOk(f.enabled, 'on');
  assert.equal(f.host.llmCalls, calls, 'native control never dispatches the LLM');
  await f.host.ctx.sessionPersistence.flush();
  const uploaded = await azure.reader.read(f.enabledId); assert.ok(uploaded);
  assert.equal(uploaded.manifest.entity.enabled, true);
  const uploadedGit = decodeGitJson(uploaded.manifest.entity.gitJson); assert.ok(uploadedGit); assert.equal(uploadedGit.commit, gitCommit); assert.equal(uploadedGit.remote, 'https://example.invalid/repo');
  assert.ok(!uploaded.manifest.entity.gitJson?.includes('synthetic-pass')); assert.ok(!uploaded.manifest.entity.gitJson?.includes('must-not-cross'));
  const catalog = await f.action({ action: 'pull' }); assert.deepEqual((catalog.items as Array<{ git: unknown }>)[0]?.git, uploadedGit);
  assert.deepEqual(uploaded.events.slice(0, historyBeforeOn.events.length), historyBeforeOn.events, 'all pre-opt-in JSONL events are published, not only subsequent events');
  assert.ok(uploaded.events.some(value => value.type === 'session/title'));
  assert.equal(uploaded.events.filter(value => value.type === 'user/message' && value.data.id === earlier.id).length, 1);
  const actualStatus = await f.action({ action: 'status', sessionId: f.enabledId });
  const item = (actualStatus.items as Array<{ enabled: boolean; status: string; eventCount: number }>)[0]!;
  assert.equal(item.enabled, true); assert.equal(item.status, 'synced'); assert.equal(item.eventCount, uploaded.events.length);
  const nativeStatus = await f.commandOk(f.enabled, 'status'); assert.equal(nativeStatus.result.text, 'Cloud sync: on; status: synced.');
  assert.equal(await azure.repository.getManifest(f.freshId), undefined, 'new blank thread was not eagerly opted in');
  assert.equal(f.record(f.freshId), undefined);
  assert.equal(f.host.ctx.commands.find(blank, 'cloud')?.recordInput, false);
  await f.host.ctx.sessionPersistence.flush(); await f.assertNoSecrets();
});

test('credential notifications and default changes drain old cores, cancel old debounce work, and rebuild without duplicate lifecycle subscriptions or eager opt-in', { timeout: 60_000 }, async t => {
  // Observe real poller starts and its PUBLIC active getter; forward every call
  // unchanged, without reading timer handles or replacing the poller/runtime.
  const pollers = new Set<ManifestPoller>();
  const start = ManifestPoller.prototype.start;
  t.mock.method(ManifestPoller.prototype, 'start', function (this: ManifestPoller) { pollers.add(this); return start.call(this); });
  const assertOnePoller = async () => {
    await setImmediate(); await setImmediate();
    assert.equal([...pollers].filter(poller => poller.active).length, 1, 'only the newest runtime owns an active polling timer');
  };
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const f = await runtime(t);
  const old = remote(emulator.connection()); const next = remote(emulator.connection('controlalternate'));
  await f.action({ action: 'set-auth', auth: 'connection-string', connectionString: emulator.connection() });
  await setImmediate(); await setImmediate();
  await f.commandOk(f.enabled, 'on');
  const oldManifest = await old.repository.getManifest(f.enabledId); assert.ok(oldManifest);
  assert.equal((await old.container.getBlobClient(leaseBlobName(f.enabledId)).getProperties()).leaseStatus, 'locked');
  f.enabled.session.append('session/title', { title: 'Pending old debounce before credentials change', messageSeqs: [], source: { kind: 'user' } });
  // Exercise the provider's real notification path outside set-auth. Status is a
  // serialized observation barrier only after maintenance starts; test-auth also
  // waits for the controller mutation queue before touching the new transport.
  await f.credentials!.set(credentialRef(f.reference), emulator.connection('controlalternate'));
  await f.action({ action: 'test-auth' });
  f.assertSubscriptions(true); await assertOnePoller();
  assert.equal((await old.container.getBlobClient(leaseBlobName(f.enabledId)).getProperties()).leaseStatus, 'unlocked', 'old core released its real Azure lease');
  const stoppedOld = await old.repository.getManifest(f.enabledId); assert.ok(stoppedOld);
  assert.equal(await next.repository.getManifest(f.enabledId), undefined, 'credential rebuild does not eagerly copy existing threads');
  await f.commandOk(f.enabled, 'on');
  assert.ok(await next.repository.getManifest(f.enabledId));
  const beforeProjection = (await f.action({ action: 'status', sessionId: f.enabledId })).projectionRevision;

  for (const pollSeconds of [31, 32, 33]) {
    f.enabled.session.append('session/title', { title: `Pending work before defaults ${pollSeconds}`, messageSeqs: [], source: { kind: 'user' } });
    const changed = await f.action({ action: 'set-defaults', defaultEnabled: false, pullOnStartup: false, pollSeconds });
    assert.equal((changed.settings as { pollSeconds: number }).pollSeconds, pollSeconds);
    assert.equal(f.scope.state, 2); f.assertSubscriptions(true); await assertOnePoller();
    assert.equal((await next.container.getBlobClient(leaseBlobName(f.enabledId)).getProperties()).leaseStatus, 'unlocked');
    const ordinary = await f.host.create(`ordinary-${pollSeconds}-${randomUUID()}`);
    assert.equal(f.record(ordinary.session.id), undefined);
    assert.equal(await next.repository.getManifest(ordinary.session.id), undefined);
    await f.commandOk(f.enabled, 'sync');
  }
  assert.notEqual((await f.action({ action: 'status', sessionId: f.enabledId })).projectionRevision, beforeProjection, 'status follows actual new-runtime upload state');
  const marker = 'Exactly one final lifecycle upload on the new runtime';
  f.enabled.session.append('session/title', { title: marker, messageSeqs: [], source: { kind: 'user' } });
  await f.host.ctx.sessionPersistence.flush();
  await eventually(async () => (await next.reader.read(f.enabledId))?.events.some(value => value.type === 'session/title' && value.data.title === marker) === true, 'new lifecycle scheduler uploads after repeated rebuilds');
  // The 750ms debounce deadline has now passed on real time: no discarded timer
  // may publish to the prior account or append a duplicate immutable event.
  const events = (await next.reader.read(f.enabledId))!.events;
  assert.equal(events.filter(value => value.type === 'session/title' && value.data.title === marker).length, 1);
  assert.deepEqual(await old.repository.getManifest(f.enabledId), stoppedOld, 'the stopped old transport remains unchanged');
  f.assertSubscriptions(true);
  const stored = localSettingsSchema.parse(f.domain.table('settings').get('config'));
  assert.equal(stored.defaultEnabled, false); assert.equal(stored.pollSeconds, 33);
  assert.equal(f.record(f.freshId), undefined);
  assert.ok(pollers.size >= 5, 'credential notifications and each defaults mutation created genuinely new runtimes');
  await f.close();
  assert.equal([...pollers].filter(poller => poller.active).length, 0, 'plugin disposal stops every real poller');
  assert.equal(f.host.ctx.commands.find(f.enabled, 'cloud'), undefined, 'plugin disposal removes native controls');
  await f.assertNoSecrets();
});

test('a committed credential with failed final settings write stays pending across real runtime entry points and a fresh host until explicit secret retry', { timeout: 60_000 }, async t => {
  let reopened: Awaited<ReturnType<typeof acceptanceDevice>> | undefined;
  let reopenedScope: ReturnType<Context['plugin']> | undefined;
  let browserScope: ReturnType<Context['plugin']> | undefined;
  // Register before the fixture's temporary-root cleanup: a failure anywhere in
  // reopening still tears down the new real host before its files are removed.
  t.after(async () => { await reopenedScope?.dispose(); await browserScope?.dispose(); await reopened?.close(); });
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const f = await runtime(t);
  const old = remote(emulator.connection());
  const next = remote(emulator.connection('controlalternate'));
  await f.action({ action: 'set-auth', auth: 'connection-string', accountName: 'devstoreaccount1', connectionString: emulator.connection() });
  await f.commandOk(f.enabled, 'on');
  const table = f.domain.table('settings');
  const accepted = localSettingsSchema.parse(table.get('config'));
  assert.ok(accepted.authGeneration); assert.equal(accepted.authPending, undefined);
  const originalPut = table.put.bind(table);
  let failedFinalWrite = false;
  let sawDurableIntentBeforeCredential = false;
  const providerSet = f.credentials!.set.bind(f.credentials!);
  t.mock.method(f.credentials!, 'set', async (ref: CredentialRef, value: string) => {
    const beforeSecret = localSettingsSchema.parse(table.get('config'));
    sawDurableIntentBeforeCredential = beforeSecret.authPending?.accountName === 'controlalternate' && beforeSecret.authGeneration === accepted.authGeneration;
    await providerSet(ref, value); // actual SDK notifyUpdated fires after this commit
  });
  // Instrument the real public domain table, not SettingsService/LocalStore internals.
  t.mock.method(table, 'put', async (...args: Parameters<typeof table.put>) => {
    const proposed = localSettingsSchema.parse(args[1]);
    if (!failedFinalWrite && proposed.authPending === undefined && proposed.authGeneration !== accepted.authGeneration) {
      failedFinalWrite = true;
      throw new Error('Synthetic final auth metadata persistence failure.');
    }
    return originalPut(...args);
  });
  const failed = await f.rpc({ action: 'set-auth', auth: 'connection-string', accountName: 'controlalternate', connectionString: emulator.connection('controlalternate') });
  assert.equal(failed.ok, false, 'the public RPC must not acknowledge an incompletely finalized auth update');
  assert.equal(failedFinalWrite, true); assert.equal(sawDurableIntentBeforeCredential, true);
  assert.equal(f.credentials!.writes.length, 2);
  assert.ok((await f.credentials!.resolve(credentialRef(f.reference)))?.value === emulator.connection('controlalternate'), 'the new credential really committed before metadata failure');
  const pending = localSettingsSchema.parse(table.get('config'));
  assert.equal(pending.authGeneration, accepted.authGeneration, 'failed metadata must not adopt the new generation');
  assert.equal(pending.accountName, 'devstoreaccount1');
  assert.equal(pending.authPending?.accountName, 'controlalternate');
  assert.ok(pending.authPending?.id);
  const status = await f.action({ action: 'status', sessionId: f.enabledId });
  const view = status.settings as { authPending: boolean; accountName: string; pendingAuth: { accountName: string }; connection: { configured: boolean } };
  assert.equal(view.authPending, true); assert.equal(view.accountName, 'devstoreaccount1');
  assert.deepEqual(view.pendingAuth, { auth: 'connection-string', accountName: 'controlalternate', managedIdentityClientId: '' });
  assert.equal(view.connection.configured, true);
  f.assertSubscriptions(false);
  assert.equal((await old.container.getBlobClient(leaseBlobName(f.enabledId)).getProperties()).leaseStatus, 'unlocked');
  const stoppedOld = await old.repository.getManifest(f.enabledId); assert.ok(stoppedOld);
  const readsWhilePending = f.credentials!.reads.length;
  assert.equal((await f.rpc({ action: 'test-auth' })).ok, false, 'core getter cannot revive from the changed secret');
  assert.equal((await f.command(f.enabled, 'test-auth')).result.kind, 'error');
  assert.equal((await f.rpc({ action: 'toggle', enabled: true, sessionId: f.enabledId })).ok, false);
  // A new real provider notification and an unrelated defaults save are not
  // explicit confirmation of the failed authentication generation.
  await f.credentials!.set(credentialRef(f.reference), emulator.connection('controlalternate'));
  await setImmediate(); await setImmediate();
  const defaults = await f.action({ action: 'set-defaults', pollSeconds: 34, pullOnStartup: false });
  assert.equal((defaults.settings as { authPending: boolean }).authPending, true);
  assert.equal(localSettingsSchema.parse(table.get('config')).authPending?.id, pending.authPending.id);
  assert.equal((await f.rpc({ action: 'test-auth' })).ok, false);
  assert.equal(f.credentials!.reads.length, readsWhilePending, 'pending entry points never resolve the newly committed secret');
  f.assertSubscriptions(false);
  assert.equal(await next.container.exists(), false, 'no new-account infrastructure was created while auth is pending');
  assert.deepEqual(await old.repository.getManifest(f.enabledId), stoppedOld);
  const blocked = f.host.prompt('An incomplete auth update must not permit a local model step.');
  f.enabled.send(blocked, 'next-turn', true); await f.enabled.whenIdle();
  assert.equal(f.host.llmCalls, 0); assert.deepEqual(f.enabled.inbox.nextTurn.map(value => value.id), [blocked.id]);
  await f.host.ctx.sessionPersistence.flush(); await f.assertNoSecrets();
  await f.close();

  // Reopen the same actual JSONL/domain roots in a NEW host, not a plugin reload
  // or a reused LocalStore. The durable marker, not an in-memory latch, gates boot.
  reopened = await acceptanceDevice(join(f.root, 'host'), 'device-a', new AcceptanceCloud());
  await reopened.service.close(); await reopened.local.close();
  reopened.ctx.provide('storageDomain', reopened.facility);
  new CommandRuntime(reopened.ctx);
  const credentials = new RuntimeCredentials(reopened.ctx);
  await credentials.set(credentialRef(f.reference), emulator.connection('controlalternate'));
  browserScope = reopened.ctx.plugin((ctx: Context) => {
    new HostConnectionService(ctx, [], {
      isAuthenticated(incoming: Request) { return incoming.headers.get('host') === authority && incoming.headers.get('cookie') === cookie; },
      authenticateApi() { return undefined; },
    } as unknown as ConstructorParameters<typeof HostConnectionService>[2]);
  });
  await browserScope.await(); assert.equal(browserScope.state, 2);
  const logs: unknown[] = [];
  reopenedScope = reopened.ctx.plugin({ name: 'pending-auth-reopen-fixture', inject: AzurePlugin.inject, apply: async (ctx: Context) => {
    ctx.provide('logger', { debug: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) });
    await AzurePlugin.apply(ctx, f.config);
  } });
  await reopenedScope.await(); assert.equal(reopenedScope.state, 2, 'pending auth is contained: startup admission and controls still mount');
  const connection = reopened.ctx.get('connection') as HostConnectionHandle;
  const shared = connection.createSharedFetchHandler('/api');
  const rpc = async (request: CloudRequest): Promise<CloudEnvelope> => {
    const endpoint = request.action === 'status' ? STATUS : ACTION;
    const incoming = new Request(`${origin}/api/${endpoint}`, { method: 'POST', headers: { host: authority, origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'pending-reopen', method: endpoint, payload: { v: 1, request } }) });
    const admission = connection.admit(incoming); assert.ok(!('rejection' in admission));
    const response = await shared.fetch(incoming, admission.peer); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(!text.includes(emulatorKey)); assert.doesNotMatch(text, /AccountKey=|SharedAccessSignature=/u);
    const wire = serverResponseSchema.parse(JSON.parse(text)); assert.equal(wire.result.ok, true);
    if (!wire.result.ok) throw new Error('Unexpected transport failure.');
    return wire.result.value as CloudEnvelope;
  };
  const resumed = await reopened.resume(f.enabledId);
  const reopenedStatus = await rpc({ action: 'status', sessionId: f.enabledId });
  assert.equal(reopenedStatus.ok, true);
  if (!reopenedStatus.ok) assert.fail('Pending status must remain available.');
  assert.equal((reopenedStatus.data as { settings: { authPending: boolean } }).settings.authPending, true);
  assert.equal((await rpc({ action: 'test-auth' })).ok, false);
  const native = await reopened.ctx.commands.execute(resumed, '/cloud test-auth', [], new AbortController().signal);
  assert.equal(native?.result.kind, 'error'); assert.equal(credentials.reads.length, 0);
  const reopenedPrompt = reopened.prompt('A fresh host must honor the durable incomplete-auth guard.');
  resumed.send(reopenedPrompt, 'next-turn', true); await resumed.whenIdle();
  assert.equal(reopened.llmCalls, 0); assert.deepEqual(resumed.inbox.nextTurn.map(value => value.id), [reopenedPrompt.id]);
  assert.equal(await next.container.exists(), false);
  assert.deepEqual(await old.repository.getManifest(f.enabledId), stoppedOld);
  assert.equal((await rpc({ action: 'set-auth', auth: 'connection-string', accountName: 'controlalternate' })).ok, false, 'a secretless retry cannot implicitly adopt the ambiguous provider value');
  const retry = await rpc({ action: 'set-auth', auth: 'connection-string', accountName: 'controlalternate', connectionString: emulator.connection('controlalternate') });
  assert.equal(retry.ok, true, 'explicit secret retry resolves pending authentication');
  if (!retry.ok) assert.fail('Explicit auth retry must succeed.');
  assert.equal((retry.data as { settings: { authPending: boolean } }).settings.authPending, false);
  const reopenedDomain = reopened.facility.get(localDomain.name); assert.ok(reopenedDomain);
  const finalized = localSettingsSchema.parse(reopenedDomain.table('settings').get('config'));
  assert.equal(finalized.authPending, undefined); assert.notEqual(finalized.authGeneration, accepted.authGeneration);
  assert.equal(finalized.accountName, 'controlalternate'); assert.equal(finalized.pollSeconds, 34);
  assert.equal(await next.container.exists(), false, 'successful retry rebuild is still network-lazy');
  assert.equal((await rpc({ action: 'test-auth' })).ok, true);
  assert.equal(await next.container.exists(), true);
  const rows = []; for await (const row of next.table.listEntities()) rows.push(row);
  assert.deepEqual(rows, [], 'retry and test-auth never eagerly opt the retained thread into the new account');
  assert.deepEqual(await old.repository.getManifest(f.enabledId), stoppedOld);
  await reopenedScope.dispose(); await browserScope.dispose(); await reopened.close();
  await f.assertNoSecrets();
  assert.ok(!JSON.stringify(logs).includes(emulatorKey)); assert.doesNotMatch(JSON.stringify(logs), /AccountKey=|SharedAccessSignature=/u);
});

test('external credential notification immediately revokes old-account admission despite a stalled native auth probe and boots the new core before its late SDK result', { timeout: 60_000 }, async t => {
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const oldProbeGate = gate(); const nextCredentialGate = gate();
  let diagnostic: Promise<unknown> | undefined;
  // Gates are always released before plugin/emulator cleanup, including failure.
  t.after(async () => { oldProbeGate.resolve(); nextCredentialGate.resolve(); await diagnostic?.catch(() => undefined); });
  const emulator = await startAzurite(); t.after(() => emulator.close());
  const f = await runtime(t);
  const old = remote(emulator.connection()); const next = remote(emulator.connection('controlalternate'));
  await f.action({ action: 'set-auth', auth: 'connection-string', connectionString: emulator.connection() });
  await f.commandOk(f.enabled, 'on');
  const initial = await old.reader.read(f.enabledId); assert.ok(initial);
  f.assertSubscriptions(true);

  let oldProbeEntered = false; let oldProbeFinished = false; let holdOldProbe = true;
  const ensurePrivateContainer = BlobStore.prototype.ensurePrivateContainer;
  t.mock.method(BlobStore.prototype, 'ensurePrivateContainer', async function (this: BlobStore) {
    // The SDK client URL is public; no runtime/service private fields are used.
    if (holdOldProbe && new URL(this.container.url).pathname.startsWith('/devstoreaccount1/')) {
      holdOldProbe = false; oldProbeEntered = true;
      await oldProbeGate.promise;
      try { return await ensurePrivateContainer.call(this); }
      finally { oldProbeFinished = true; }
    }
    return ensurePrivateContainer.call(this);
  });
  let nextCredentialEntered = false;
  const resolveCredential = f.credentials!.resolve.bind(f.credentials!);
  t.mock.method(f.credentials!, 'resolve', async (ref: CredentialRef) => {
    const resolved = await resolveCredential(ref);
    if (resolved?.value === emulator.connection('controlalternate')) {
      nextCredentialEntered = true;
      await nextCredentialGate.promise;
    }
    return resolved;
  });
  const pendingDiagnostic = f.command(f.enabled, 'test-auth'); diagnostic = pendingDiagnostic;
  let diagnosticSettled = false;
  void pendingDiagnostic.then(() => { diagnosticSettled = true; }, () => { diagnosticSettled = true; });
  await eventually(() => oldProbeEntered, 'native test-auth reaches the gated real old-account Blob adapter');
  await f.credentials!.set(credentialRef(f.reference), emulator.connection('controlalternate'));
  // No observation/barrier is inserted between the committed provider notification
  // and fresh real AgentLoop input. B cannot become active until our public gate opens.
  const blocked = f.host.prompt('Fresh input after credential rotation must never execute or publish through the previous account.');
  f.enabled.send(blocked, 'next-turn', true); await f.enabled.whenIdle();
  assert.equal(f.host.llmCalls, 0, 'old cached core is revoked synchronously at the credential notification boundary');
  assert.deepEqual(f.enabled.inbox.nextTurn.map(value => value.id), [blocked.id]);
  assert.equal(f.record(f.enabledId)?.enabled, true, 'rotation preserves durable opt-in while ownership is unavailable');
  assert.equal(f.record(f.enabledId)?.status, 'ownership-unverified');
  await eventually(() => diagnosticSettled, 'old native diagnostic is cancelled without waiting for its stalled SDK call');
  const cancelled = await pendingDiagnostic;
  assert.equal(cancelled.result.kind, 'error');
  assert.equal(cancelled.result.text, 'The cloud request was cancelled.');
  await eventually(() => nextCredentialEntered, 'credential maintenance reaches new-account boot without waiting for the old diagnostic');
  assert.equal(oldProbeFinished, false, 'the late SDK probe remains deliberately unresolved');
  f.assertSubscriptions(false);
  assert.equal(await next.container.exists(), false, 'gated new credential resolution cannot create account B infrastructure');
  const revoked = await old.reader.read(f.enabledId); assert.ok(revoked);
  assert.deepEqual(revoked.events.slice(0, initial.events.length), initial.events);
  assert.equal(revoked.events.some(value => value.type === 'user/message' && value.data.id === blocked.id), false);
  const committed = ({ entity }: NonNullable<Awaited<ReturnType<typeof old.repository.getManifest>>>) => ({
    generation: entity.generation, headSeq: entity.headSeq, eventCount: entity.eventCount,
    batchCount: entity.batchCount, chainHash: entity.chainHash, headerHash: entity.headerHash,
    lastBatchRowKey: entity.lastBatchRowKey, lastBatchBlobName: entity.lastBatchBlobName,
  });
  const revokedTip = committed(revoked.manifest);

  nextCredentialGate.resolve();
  assert.deepEqual(await f.action({ action: 'test-auth' }), { kind: 'auth-test', configured: true });
  assert.equal(oldProbeFinished, false, 'new B control operations complete while old SDK work is still stalled');
  assert.equal(await next.container.exists(), true);
  assert.equal(await next.repository.getManifest(f.enabledId), undefined, 'credential change and diagnostic do not opt the thread into B');
  f.assertSubscriptions(true);
  // Explicitly adopt B, then exercise the very same retained AgentLoop. This
  // proves both the new core's transport and that the mutation queue is usable.
  await f.commandOk(f.enabled, 'on');
  f.enabled.send(f.host.prompt('Continue on the explicitly enabled new account.'), 'next-turn', true);
  await f.enabled.whenIdle();
  assert.ok(f.host.llmCalls > 0); assert.equal(f.enabled.inbox.nextTurn.length, 0);
  await f.host.ctx.sessionPersistence.flush(); await f.commandOk(f.enabled, 'sync');
  const publishedNext = await next.reader.read(f.enabledId); assert.ok(publishedNext);
  assert.equal(publishedNext.events.filter(value => value.type === 'user/message' && value.data.id === blocked.id).length, 1, 'the retained prompt publishes exactly once, only after correct-core opt-in');
  const beforeLate = await old.reader.read(f.enabledId); assert.ok(beforeLate);
  assert.deepEqual(committed(beforeLate.manifest), revokedTip, 'suspended old background/close paths cannot publish new committed history');
  assert.equal(beforeLate.events.some(value => value.type === 'user/message' && value.data.id === blocked.id), false);

  oldProbeGate.resolve();
  await eventually(() => oldProbeFinished, 'late old SDK completion is observed after the replacement core is active');
  await setImmediate(); await setImmediate();
  assert.equal(f.scope.state, 2); f.assertSubscriptions(true);
  const afterLate = await old.reader.read(f.enabledId); assert.ok(afterLate);
  assert.deepEqual(committed(afterLate.manifest), revokedTip, 'late old probe cannot revive old-account publication (mirror/lease ETags may change)');
  assert.deepEqual(afterLate.events, beforeLate.events);
  assert.deepEqual(await f.action({ action: 'test-auth' }), { kind: 'auth-test', configured: true });
  await f.host.ctx.sessionPersistence.flush(); await f.assertNoSecrets();
});
