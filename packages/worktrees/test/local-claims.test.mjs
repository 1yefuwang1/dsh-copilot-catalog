import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { WorktreeController } from '../dist/service.js';
import { createExecutor } from '../dist/runtime.js';
import { WorktreeError } from '../dist/errors.js';
import { tempDirectory, tmpBase } from './helpers.mjs';

const code = expected => error => error instanceof WorktreeError && error.code === expected;
const deferred = () => Promise.withResolvers();
function table() { const map = new Map(); return { get: key => map.get(key), entries: () => map.entries(), async put(key, value) { map.set(key, value); }, async delete(key) { return map.delete(key); } }; }
async function fixture(t) {
  const directory = await tempDirectory('worktrees-local-claims-'), local = resolve(directory, 'local'), other = resolve(directory, 'other');
  await mkdir(resolve(local, 'project'), { recursive: true }); await mkdir(other);
  const host = new Context(), live = new Map(), claims = [], jobs = new Map(), terminals = new Map(), shellOwners = new Set();
  host.provide('agents', { get: id => live.get(id), list: () => [...live.values()] });
  host.provide('jobs', { list: id => jobs.get(id) ?? [] });
  host.provide('terminalController', { list: id => terminals.get(id) ?? [] });
  host.provide('terminals', { hasOwnerActivity: agent => shellOwners.has(agent.id) });
  function agent(cwd = local) {
    const abort = new AbortController(), value = { id: randomUUID(), ctx: host, status: 'idle', session: { header: { cwd } }, inbox: { nextStep: [], nextTurn: [] }, held: false,
      runMaintenance(task) {
        if (this.held || this.status !== 'idle') throw new Error('already held');
        this.held = true; claims.push(['enter', this.id]);
        return Promise.resolve(task(abort.signal)).finally(() => { this.held = false; claims.push(['leave', this.id]); });
      },
      cancel() { abort.abort(); },
    };
    live.set(value.id, value); return value;
  }
  const bootstrap = { actor: id => live.get(id), isLive: value => live.get(value.id) === value, async close() {} };
  const config = { root: resolve(directory, 'managed'), gitExecutable: 'git', defaultRemote: 'origin', defaultBranch: 'main', commandTimeoutMs: 1000, fetchTimeoutMs: 1000, operationTimeoutMs: 60000, maxSnapshotBytes: 1024, maxFiles: 1000, maxRefBytes: 4096 };
  const controller = new WorktreeController(host, config, { worktrees: table(), operations: table(), async close() {} }, { bootstrap });
  const child = agent(resolve(local, 'project')); child.held = true;
  const invocation = { agent: child, origin: 'ui', signal: new AbortController().signal };
  t.after(async () => { await controller.close(); assert.equal(dirname(directory), tmpBase); assert.equal(await realpath(directory), directory); await rm(directory, { recursive: true, force: true }); });
  return { directory, local, other, host, live, claims, jobs, terminals, shellOwners, controller, child, invocation, agent, config };
}

test('production successful Local claims validate held child resources while exempting only its parked inbox and second driver claim', async t => {
  const f = await fixture(t), writer = f.agent();
  f.child.inbox.nextTurn.push({ parked: 'actual user input' });
  const result = await f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => {
    assert.equal(writer.held, true); guard(); return 'selected';
  }, [f.child]);
  assert.equal(result, 'selected'); assert.deepEqual(f.claims.map(([kind]) => kind), ['enter', 'leave']); assert.equal(f.child.inbox.nextTurn.length, 1); assert.equal(f.child.held, true); assert.equal(writer.held, false);
});

for (const [name, configure] of [
  ['native terminal', f => f.terminals.set(f.child.id, [{ state: 'running' }])],
  ['background job', f => f.jobs.set(f.child.id, [{ status: 'running' }])],
  ['stopping background job', f => f.jobs.set(f.child.id, [{ status: 'stopping' }])],
  ['model terminal', f => f.shellOwners.add(f.child.id)],
]) test(`held Local target still blocks switching with an active ${name}`, async t => {
  const f = await fixture(t); configure(f); let effect = false;
  await assert.rejects(f.controller.withLocalClaims([f.local], f.invocation, async () => { effect = true; }, [f.child]), code('BUSY'));
  assert.equal(effect, false); assert.equal(f.child.held, true);
});

test('effect-boundary guard catches held target terminal allocation during asynchronous preflight', async t => {
  const f = await fixture(t); let effect = false;
  await assert.rejects(f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => {
    await Promise.resolve(); f.terminals.set(f.child.id, [{ state: 'running' }]); guard(); effect = true;
  }, [f.child]), code('BUSY'));
  assert.equal(effect, false);
});

for (const kind of ['new', 'resumed', 'alias']) test(`Local admission fence rejects ${kind} managed runtime during a delayed preflight`, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let effect = false;
  const flight = f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => { entered.resolve(); await release.promise; guard(); effect = true; }, [f.child]);
  await entered.promise;
  let cwd = f.local;
  if (kind === 'alias') { cwd = resolve(f.directory, 'local-alias'); await symlink(f.local, cwd, 'dir'); }
  const newcomer = f.agent(cwd);
  await assert.rejects(f.host.serial('agent/created', { agent: newcomer, source: kind === 'resumed' ? 'resume' : 'startup' }), code('LOCAL_MAINTENANCE'));
  // Registry entry can exist during awaited publication; the final guard must
  // independently reject it even before factory rollback detaches the entry.
  release.resolve(); await assert.rejects(flight, code('BUSY')); assert.equal(effect, false);
  f.live.delete(newcomer.id);
  const after = f.agent(f.local); await f.host.serial('agent/created', { agent: after, source: 'startup' });
});

test('unrelated runtime admission remains available and does not invalidate a Local claim', async t => {
  const f = await fixture(t); let effect = false;
  await f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => {
    const unrelated = f.agent(f.other); await f.host.serial('agent/created', { agent: unrelated, source: 'startup' }); guard(); effect = true;
  }, [f.child]);
  assert.equal(effect, true);
});

test('complete effect-time set checks reject replaced/disposed Local owners and ordinary newly queued input', async t => {
  for (const change of ['replacement', 'disposed', 'queued']) {
    const f = await fixture(t), writer = f.agent(); let effect = false;
    await assert.rejects(f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => {
      if (change === 'replacement') f.live.set(writer.id, { ...writer });
      else if (change === 'disposed') f.live.delete(writer.id);
      else writer.inbox.nextStep.push({ pending: true });
      guard(); effect = true;
    }, [f.child]), code('BUSY'));
    assert.equal(effect, false); assert.equal(writer.held, false);
  }
});

test('claim cancellation and exception release driver holds and root admission fencing', async t => {
  for (const how of ['cancel', 'throw']) {
    const f = await fixture(t), writer = f.agent();
    await assert.rejects(f.controller.withLocalClaims([f.local], f.invocation, async (_signal, guard) => {
      if (how === 'cancel') { writer.cancel(); guard(); }
      else throw new WorktreeError('FIXTURE_ABORT', 'No branch effect.');
    }, [f.child]), code(how === 'cancel' ? 'CANCELLED' : 'FIXTURE_ABORT'));
    assert.equal(writer.held, false);
    const after = f.agent(f.local); await f.host.serial('agent/created', { agent: after, source: 'startup' });
  }
});

test('managed actor executor revalidates claims after asynchronous executable lookup, immediately before spawn', async t => {
  const f = await fixture(t); let spawned = false;
  f.host.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: f.local }) });
  f.host.provide('subprocess', {
    async resolveExecutable() { await Promise.resolve(); f.terminals.set(f.child.id, [{ state: 'running' }]); return 'git'; },
    spawn() { spawned = true; return { stdout: new PassThrough(), stderr: new PassThrough(), done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, async waitForExit() { return true; } }; },
  });
  await assert.rejects(f.controller.withLocalClaims([f.local], f.invocation, async (signal, guard) => {
    const execute = createExecutor(f.child, f.config, undefined, guard);
    await execute({ cwd: f.local, args: ['switch', '--no-guess', 'chosen'], signal });
  }, [f.child]), code('BUSY'));
  assert.equal(spawned, false);
});
