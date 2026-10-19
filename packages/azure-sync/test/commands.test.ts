import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CommandRuntime, type CommandDefinition, type CommandInvocation } from '@deepseek-ai/dsh-commands';
import { parseCloudCommand, registerCloudCommands } from '../src/commands.js';
import { CloudControlError, CLOUD_JSON_MAX_BYTES, publicCloudError, type CloudControllerPort, type CloudResponse } from '../src/protocol.js';

const uuid = '12345678-1234-4234-9234-123456789abc';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function fixture(t: TestContext, controller: CloudControllerPort) {
  const host = new Context(); const owner = createScope(host, {}); let definition: CommandDefinition | undefined; let removed = 0;
  host.provide('commands', { register(value: CommandDefinition) { definition = value; return () => { removed++; }; } });
  const stop = registerCloudCommands(owner.ctx, controller);
  const run = (rawInput: string, signal = new AbortController().signal) => Promise.resolve(definition!.handler({ rawInput, signal, attachments: [], agent: { id: 'not-the-target', session: { id: 'native-target' } }, commandId: 'synthetic' } as unknown as CommandInvocation));
  t.after(async () => { stop(); await owner.dispose(); });
  return { owner, stop, run, get definition() { return definition!; }, get removed() { return removed; } };
}

test('cloud parser covers all native actions with a shared strict request contract', () => {
  assert.deepEqual(parseCloudCommand(''), { action: 'status' });
  assert.deepEqual(parseCloudCommand('on'), { action: 'toggle', enabled: true });
  assert.deepEqual(parseCloudCommand('off'), { action: 'toggle', enabled: false });
  for (const action of ['status', 'sync', 'pull', 'mappings', 'detach', 'export', 'repair', 'acknowledge-degraded', 'check-ownership', 'test-auth']) assert.deepEqual(parseCloudCommand(action), { action });
  assert.deepEqual(parseCloudCommand('pull session-target'), { action: 'pull', sessionId: 'session-target' });
  assert.deepEqual(parseCloudCommand('pull --cursor c2Vzc2lvbjp4 --limit 10'), { action: 'pull', cursor: 'c2Vzc2lvbjp4', limit: 10 });
  for (const bad of ['pull --limit 0', 'pull --limit 101', 'pull --limit 1 --limit 2', 'pull --unknown x', 'pull sid --limit 1']) assert.throws(() => parseCloudCommand(bad));
  assert.deepEqual(parseCloudCommand('repair --confirm-mapping'), { action: 'repair', confirmMapping: true });
  assert.deepEqual(parseCloudCommand('takeover --confirm'), { action: 'takeover', confirm: true });
  assert.deepEqual(parseCloudCommand('resurrect --confirm'), { action: 'resurrect', confirm: true });
  assert.deepEqual(parseCloudCommand('remove --retain-attachments --confirm'), { action: 'remove', confirm: true, acknowledgeAttachmentsRetained: true });
  assert.deepEqual(parseCloudCommand(`unmap ${uuid}`), { action: 'unmap', mappingId: uuid });
});

test('path token grammar preserves quoted paths, literal backslashes, and shell metacharacters without execution', () => {
  assert.deepEqual(parseCloudCommand(`map linux '/remote path' "C:\\Users\\local path" --id ${uuid}`), { action: 'map', mapping: { remotePrefix: '/remote path', localPrefix: 'C:\\Users\\local path', remotePlatform: 'linux', id: uuid } });
  assert.deepEqual(parseCloudCommand('map win32 "C:\\remote" "/literal/$HOME/$(command);*"'), { action: 'map', mapping: { remotePrefix: 'C:\\remote', localPrefix: '/literal/$HOME/$(command);*', remotePlatform: 'win32' } });
  assert.deepEqual(parseCloudCommand(`map darwin '/remote' '/local'" with spaces"`), { action: 'map', mapping: { remotePrefix: '/remote', localPrefix: '/local with spaces', remotePlatform: 'darwin' } });
  for (const input of ['map linux "/unterminated /local', 'map linux /remote /local extra', 'map linux /remote /local --unknown id', 'map linux "" /local', 'unmap not-a-uuid', 'map unsupported /remote /local']) assert.throws(() => parseCloudCommand(input));
});

test('confirmation flags cannot be inferred, duplicated, misspelled or omitted', () => {
  for (const input of ['takeover', 'resurrect', 'remove', 'remove --confirm', 'remove --retain-attachments']) assert.throws(() => parseCloudCommand(input), error => publicCloudError(error).code === 'CONFIRM_REQUIRED');
  for (const input of ['takeover true', 'takeover --confirm --confirm', 'remove --confirm --confirm', 'remove --confirm --retain-attachment', 'repair --confirm', 'repair --confirm-mapping false']) assert.throws(() => parseCloudCommand(input), error => publicCloudError(error).code === 'INVALID_REQUEST');
});

test('optional commands service is a no-op and registration always disables input recording', async t => {
  let calls = 0; const ctx = new Context(); const stop = registerCloudCommands(ctx, { async execute() { calls++; return null; } }); stop(); stop(); assert.equal(calls, 0);
  const f = await fixture(t, { async execute() { return null; } });
  assert.equal(f.definition.name, 'cloud'); assert.equal(f.definition.recordInput, false); assert.notEqual(f.definition.input?.attachments, true);
  assert.match(f.definition.description, /in-flight tools/u); assert.match(f.definition.description, /retains attachments/u);
  f.stop(); f.stop(); assert.equal(f.removed, 1);
});

test('native commands invoke the shared controller exactly once with agent.session.id and no model dispatch', async t => {
  const calls: Array<{ request: unknown; context: Parameters<CloudControllerPort['execute']>[1] }> = [];
  const f = await fixture(t, { async execute(request, context) { calls.push({ request, context }); return { kind: 'action', secretAccidentallyReturned: 'synthetic-secret' }; } });
  for (const input of ['status', 'on', 'off', 'sync', 'pull', 'repair --confirm-mapping']) {
    const output = await f.run(input); assert.equal(output.kind, 'success'); assert.doesNotMatch(output.text!, /synthetic-secret/u);
  }
  assert.equal(calls.length, 6);
  for (const call of calls) { assert.equal(call.context.sessionId, 'native-target'); assert.equal(call.context.origin, 'command'); assert.ok(call.context.signal instanceof AbortSignal); }
  assert.deepEqual(calls[1]!.request, { action: 'toggle', enabled: true });
  assert.deepEqual(calls[4]!.request, { action: 'pull' });
});

test('native status is actionable while dynamic fields and non-native remote ids stay out of durable text', async t => {
  let mode = 0;
  const f = await fixture(t, { async execute() {
    if (mode === 0) return { kind: 'status', items: [{ status: 'synced', enabled: true, lastError: 'synthetic-output-secret' }] };
    if (mode === 1) return { kind: 'status', items: [{ status: 'synthetic-output-secret', enabled: true }] };
    return { kind: 'remote', items: [{ sessionId: 'session-' + uuid }, { sessionId: 'synthetic-output-secret' }] };
  } });
  assert.match((await f.run('status')).text!, /on; status: synced/u);
  mode = 1; assert.doesNotMatch((await f.run('status')).text!, /synthetic-output-secret/u);
  mode = 2; const remote = (await f.run('pull')).text!;
  assert.match(remote, /session-12345678/u); assert.doesNotMatch(remote, /synthetic-output-secret/u);
});

test('malformed accidental credential input and arbitrary provider failures produce fixed redacted results', async t => {
  let calls = 0; let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { reads++; return 'synthetic-secret'; } });
  const f = await fixture(t, { async execute() { calls++; throw error; } });
  for (const input of ['set-auth connection-string synthetic-secret', 'status synthetic-secret', 'on synthetic-secret', 'map linux /remote /local synthetic-secret', '\nsynthetic-secret']) {
    const result = await f.run(input); assert.deepEqual(result, { kind: 'error', text: 'The cloud request is invalid.' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await f.run('sync'), { kind: 'error', text: 'The cloud operation failed.' }); assert.equal(reads, 0);
});

test('command result bounding rejects accessors/toJSON and never serializes raw controller data', async t => {
  let reads = 0; let mode = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 'synthetic-secret'; } });
  const values: unknown[] = [getter, { toJSON() { reads++; return 'synthetic-secret'; } }, 'x'.repeat(CLOUD_JSON_MAX_BYTES), new CloudControlError('SETUP_NEEDED')];
  const f = await fixture(t, { async execute() { if (mode === 3) throw values[mode]; return values[mode] as CloudResponse; } });
  for (mode = 0; mode < values.length; mode++) {
    const result = await f.run('status'); assert.equal(result.kind, 'error'); assert.doesNotMatch(result.text!, /synthetic-secret/u);
    assert.equal(result.text, mode === 3 ? 'Cloud sync setup is required.' : 'The cloud request or result exceeds its safe JSON bounds.');
  }
  assert.equal(reads, 0);
});

test('native handler cancellation/disposal is bounded and late provider rejection is observed', { timeout: 2000 }, async t => {
  const started = deferred(); const provider = deferred<CloudResponse>(); let signal: AbortSignal | undefined;
  const f = await fixture(t, { async execute(_request, context) { signal = context.signal; started.resolve(); return provider.promise; } });
  const pending = f.run('sync'); await started.promise; f.stop();
  assert.deepEqual(await pending, { kind: 'error', text: 'The cloud request was cancelled.' }); assert.equal(signal!.aborted, true);
  provider.reject(new Error('synthetic-secret-late')); await setImmediate();
  assert.deepEqual(await f.run('sync'), { kind: 'error', text: 'The cloud request was cancelled.' });
});

test('real public command registry never durably records raw secret args or raw controller results', async t => {
  const host = new Context(); new CommandRuntime(host); const owner = createScope(host, {});
  const records: Array<{ type: string; data: unknown }> = [];
  const agent = { ctx: new Context(), session: { id: 'target', append(type: string, data: unknown) { records.push({ type, data }); return records.length - 1; } } } as unknown as Agent;
  const stop = registerCloudCommands(host, { async execute() { return { accidentalSecret: 'synthetic-output-secret' }; } });
  t.after(async () => { stop(); await owner.dispose(); });
  const commands = host.get('commands')!;
  assert.equal(commands.find(agent, 'cloud')?.recordInput, false);
  const bad = await commands.execute(agent, '/cloud status synthetic-input-secret', [], new AbortController().signal);
  assert.equal(bad?.result.kind, 'error');
  const good = await commands.execute(agent, '/cloud status', [], new AbortController().signal);
  assert.equal(good?.result.kind, 'success'); assert.equal(records.length, 4);
  assert.doesNotMatch(JSON.stringify(records), /synthetic-(?:input|output)-secret/u);
  const runs = records.filter(record => record.type === 'command/run');
  assert.equal(runs.length, 2); assert.ok(runs.every(record => !Object.hasOwn(record.data as object, 'args')));
  stop(); assert.equal(commands.find(agent, 'cloud'), undefined);
});
