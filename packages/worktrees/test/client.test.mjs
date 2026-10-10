import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { webcrypto } from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
// Execute only the actual pure protocol/guard declarations. No React, DOM,
// browser, component renderer, or screenshot substitute is constructed.
const start = source.indexOf('    class WorktreeError extends Error');
const end = source.indexOf('    function Icon(', start);
assert.ok(start > 0 && end > start);
const helpers = vm.runInNewContext(`(() => { const NS = 'worktrees.ui', PANEL = 'dsh-worktrees'; ${source.slice(start, end)}; return {
  decodeReply, validateData, requestHost, currentActor, sourceEligible, inputEmpty,
  captureDraft, draftUnchanged, advertisedDefault, acquireBlock, releaseAfterMainOwnership,
  rootFolderValue, writeRootFolder, NATIVE_SUBMIT_ABI, leaseNativeSink, setupProgress, prepareWorktree, waitForDraftFiles, createWorktreeFlow, createRepositoryAvailability,
}; })()`, { AbortController, AbortSignal, crypto: webcrypto });
const success = data => ({ ok: true, value: { v: 1, ok: true, data } });
const input = { draft: 'review this @file', draftRev: 3, attachmentIds: ['draft-a', 'draft-b'], phase: 'plain', queue: [] };
const blank = { blank: true, subagent: null, openState: 'open', removed: false, running: false, promptAttempted: false, awaitingFirstTurn: false, pendingSubmissions: [] };
const record = { id: 'tree-1', operationId: 'op-1', effectiveCwd: '/repo/worktree', remote: 'upstream', remoteBranch: 'feature/example', baseOid: 'abc123', sessionIds: ['session-1'], branch: null, protected: false, archived: false, state: 'ready' };
const op = { id: 'op-1', phase: 'ready', error: null };
const status = { settingsHash: 'settings-1', repository: { root: '/repo', head: 'abc123', branch: 'develop' }, remotes: [{ name: 'upstream', identity: 'remote-1' }], defaults: { remote: 'upstream', branch: 'main' } };
const branches = { remote: 'upstream', remoteIdentity: 'remote-1', defaultBranch: 'develop', items: [{ name: 'main', oid: 'main-oid' }, { name: 'feature/example', oid: 'feature-oid' }], observedAt: 1234 };
const preview = { id: 'preview-1', worktreeId: 'tree-1', sourceSessionId: 'session-1', targetRoot: '/repo', baseOid: 'abc123', patchPath: '/repo/snapshot.patch', patchHash: 'patch-1', bytes: 15, files: [{ path: 'file.txt', status: 'M', binary: false }] };
const ownedContext = { project: { id: '12345678-1234-4234-8234-123456789abc', title: 'Two folders', folders: [{ id: 'folder-api', path: '/repo/services/api', title: 'API' }] }, folder: { id: 'folder-api', path: '/repo/services/api', title: 'API' }, binding: { sessionId: 'source', projectId: '12345678-1234-4234-8234-123456789abc', folderId: 'folder-api', mode: 'local', effectiveCwd: '/repo/services/api' } };

function fails(action, kind, code) {
  assert.throws(action, error => error.kind === kind && (code === undefined || error.code === code));
}

test('persistent factory uses exact id and only the React module', () => {
  new vm.Script(source);
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: 'dsh-worktrees'/);
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(requires, ['react']);
  assert.doesNotMatch(source, /(?:document|window)\.(?:body|querySelector|getElementById)|innerHTML|appendChild|createPortal|openWorkspace\(/);
  assert.doesNotMatch(source, /sessions\.create\(|danger-full-access|acceptRisk|permissionMode|grantPermission/);
});

test('entire Client UI has one quiet RPC transport and no chat-command compatibility fallback', () => {
  assert.doesNotMatch(source, /remote\.commands|\/worktree |async function command\(|CommandExecution|CommandResult|JSON\.parse/);
  assert.equal([...source.matchAll(/ctx\.connection\.rpc\.call\(/g)].length, 1);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|document\.cookie/);
  const calls = [...source.matchAll(/(?<!function )requestHost\(ctx, [^\n]+/g)];
  assert.ok(calls.length >= 10, 'all creation, manager, card and handoff requests use the bridge');
  for (const action of ['status', 'branches', 'list', 'preview', 'export', 'handoff']) assert.ok(calls.some(call => call[0].includes("action: '" + action + "'")), action);
  assert.match(source, /prepareWorktree\(ctx, op\.sessionId, op\.request, signal/);
  assert.match(source, /requestHost\(ctx, actorId, \{ \.\.\.request, id: record\.id \}, signal\)/);
});

test('project reads/mutations share only the quiet projects endpoint without weakening no-command coverage', () => {
  const calls = [...source.matchAll(/(?<!function )requestProjects\(ctx, [^\n]+/g)];
  assert.equal(calls.length, 2, 'only root metadata reads and explicit project metadata mutations use the projects bridge');
  assert.match(source, /quietRPC\(ctx, 'dsh-worktrees\/projects', \{ v: 1, request,/);
  assert.match(source, /quietRPC\(ctx, 'dsh-worktrees\/execute', \{ v: 1, actorId, request \}/);
  assert.doesNotMatch(source, /commands\.execute|remote\.commands|fetch\(|XMLHttpRequest|\.session\.prompt\(/);
});

test('versioned RPC decoder distinguishes transport, Host/domain and decode failures', () => {
  assert.equal(helpers.decodeReply(success('decoded-data')), 'decoded-data');
  for (const reply of [undefined, null, [], true, {}, { ok: 'true' }]) fails(() => helpers.decodeReply(reply), 'decode', 'invalid-transport');
  fails(() => helpers.decodeReply({ ok: false, error: { code: 'gateway/cancelled', message: 'aborted', details: {} } }), 'transport', 'gateway/cancelled');
  for (const error of [undefined, null, {}, { code: 1, message: 'no' }, { code: 'bad', message: false }]) fails(() => helpers.decodeReply({ ok: false, error }), 'decode', 'invalid-transport-error');
  for (const envelope of [undefined, null, [], {}, 'serialized-data', { v: 2, ok: true, data: {} }, { v: 1, ok: 'true', data: {} }]) {
    fails(() => helpers.decodeReply({ ok: true, value: envelope }), 'decode', 'unsupported-envelope');
  }
  fails(() => helpers.decodeReply({ ok: true, value: { v: 1, ok: true } }), 'decode', 'missing-data');
  assert.equal(helpers.decodeReply(success(null)), null, 'data presence is distinct from truthiness');
  fails(() => helpers.decodeReply({ ok: true, value: { v: 1, ok: false, error: { code: 'policy-denied', message: 'Full access required' } } }), 'host', 'policy-denied');
  for (const error of [undefined, null, {}, { code: 1, message: 'no' }, { code: 'bad', message: false }]) fails(() => helpers.decodeReply({ ok: true, value: { v: 1, ok: false, error } }), 'decode', 'invalid-error');
});

test('RPC domain refusals preserve code/message without parsing outer errors or accepting old command wrappers', () => {
  const domain = { v: 1, ok: false, error: { code: 'BUSY', message: 'Finish pending work first.' } };
  assert.throws(() => helpers.decodeReply({ ok: true, value: domain }), error => error.kind === 'host' && error.code === 'BUSY' && error.message === domain.error.message);
  fails(() => helpers.decodeReply({ ok: false, error: { code: 'invalid-peer', message: JSON.stringify(domain), details: {} } }), 'transport', 'invalid-peer');
  for (const kind of ['success', 'error']) {
    const old = { commandId: 'old-command', result: { kind, text: JSON.stringify(domain) } };
    fails(() => helpers.decodeReply({ ok: true, value: old }), 'decode', 'unsupported-envelope');
  }
});

test('action response validators reject malformed protocol data before rendering', () => {
  assert.equal(helpers.validateData({ action: 'status' }, status), status);
  assert.equal(helpers.validateData({ action: 'status', id: record.id }, { settingsHash: 'hash', worktree: record, status: null }).worktree, record);
  assert.equal(helpers.validateData({ action: 'status', operationId: op.id }, { settingsHash: 'hash', operation: op }).operation, op);
  assert.equal(helpers.validateData({ action: 'list' }, { items: [record] }).items[0], record);
  assert.equal(helpers.validateData({ action: 'branches', remote: 'upstream', remoteIdentity: 'remote-1' }, branches), branches);
  const session = { worktree: record, sessionId: 'session-1', workspaceId: 'workspace-1', settingsHash: 'hash', operation: op };
  for (const action of ['create', 'start', 'handoff']) assert.equal(helpers.validateData({ action }, session), session);
  assert.equal(helpers.validateData({ action: 'preview', id: 'tree-1' }, preview), preview);
  assert.equal(helpers.validateData({ action: 'export' }, { path: preview.patchPath, bytes: 15, patchHash: 'hash' }).path, preview.patchPath);
  for (const action of ['status', 'list', 'branches', 'create', 'start', 'handoff', 'preview', 'export']) fails(() => helpers.validateData({ action }, {}), 'decode', 'invalid-' + action + '-data');
  fails(() => helpers.validateData({ action: 'branches', remote: 'origin', remoteIdentity: 'remote-1' }, branches), 'decode');
  fails(() => helpers.validateData({ action: 'branches', remote: 'upstream', remoteIdentity: 'changed' }, branches), 'decode');
  fails(() => helpers.validateData({ action: 'preview', id: 'other-tree' }, preview), 'decode');
});

test('quiet RPC bridge sends exact channel, endpoint, original actor/request and cancellation signal', async () => {
  const calls = [];
  const controller = new AbortController();
  const request = { action: 'branches', remote: 'upstream', remoteIdentity: 'remote-1', query: 'feature', limit: 100 };
  const ctx = { connection: { rpc: { call: async (...args) => { calls.push(args); return success(branches); } } } };
  const data = await helpers.requestHost(ctx, 'actual-selected-session', request, controller.signal);
  assert.equal(data.remote, 'upstream');
  assert.equal(calls.length, 1);
  const [channel, endpoint, payload, signal] = calls[0];
  assert.equal(channel, '/api');
  assert.equal(endpoint, 'dsh-worktrees/execute');
  assert.deepEqual(Object.keys(payload).sort(), ['actorId', 'request', 'v']);
  assert.equal(payload.v, 1);
  assert.equal(payload.actorId, 'actual-selected-session');
  assert.equal(payload.request, request);
  assert.equal(signal, controller.signal);
  controller.abort();
  assert.equal(signal.aborted, true, 'Connection receives the original live cancellation signal');
  for (const actorId of [undefined, null, '', '   ']) await assert.rejects(helpers.requestHost(ctx, actorId, request), error => error.kind === 'actor');
  assert.equal(calls.length, 1, 'no invented fallback actor is dispatched');
  await assert.rejects(helpers.requestHost({ connection: { rpc: { call: async () => { throw new Error('offline'); } } } }, 'actual-selected-session', request), error => error.kind === 'transport' && error.code === 'rpc-rejected');
  await assert.rejects(helpers.requestHost({ connection: { rpc: { call: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; } } } }, 'actual-selected-session', request), error => error.kind === 'cancelled');
  await assert.rejects(helpers.requestHost({}, 'actual-selected-session', request), error => error.kind === 'transport', 'missing Connection cannot fall back to commands');
});

test('quiet RPC bridge declares and resolves the actual traced Connection root dependency', async () => {
  const declaration = /inject: (\[[^\n]+\]),\n\s*\/\/ Export pure/u.exec(source);
  assert.ok(declaration, 'the actual returned Client plugin injection declaration is inspected');
  const declared = vm.runInNewContext(declaration[1]);
  assert.ok(declared.includes('connection'));
  assert.ok(!declared.includes('remote') && !declared.includes('remote.commands'));
  const host = new Context();
  const calls = [];
  class ConnectionRoot extends Service {
    constructor(ctx) {
      super(ctx, 'connection');
      this.rpc = { call: async (...args) => { calls.push(args); return success(branches); } };
    }
  }
  const connectionService = host.plugin(ConnectionRoot);
  let broken;
  let corrected;
  const bad = host.plugin({ apply(ctx) { broken = ctx; } });
  const good = host.plugin({ inject: [...declared], apply(ctx) { corrected = ctx; } });
  // Only the real Cordis service root is traced; rpc is its public object property,
  // not an invented Namespace service. No React/DOM renderer is constructed.
  for (const name of declared.filter(name => name !== 'connection')) host.provide(name, {});
  await Promise.all([connectionService, bad, good]);
  try {
    assert.ok(broken && corrected);
    const request = { action: 'branches', remote: 'upstream', remoteIdentity: 'remote-1' };
    await assert.rejects(helpers.requestHost(broken, 'actual-selected-session', request), error => error.kind === 'transport' && /connection.*without inject/u.test(error.message));
    const signal = new AbortController().signal;
    const value = await helpers.requestHost(corrected, 'actual-selected-session', request, signal);
    assert.equal(value.remote, 'upstream');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api');
    assert.equal(calls[0][1], 'dsh-worktrees/execute');
    assert.equal(calls[0][2].v, 1);
    assert.equal(calls[0][2].actorId, 'actual-selected-session');
    assert.equal(calls[0][2].request, request);
    assert.equal(calls[0][3], signal);
  } finally { await bad.dispose(); await good.dispose(); await connectionService.dispose(); }
});

test('current actor is unique ordinary mainView ownership, never a privileged fallback', () => {
  assert.equal(helpers.currentActor({ byId: {} }), undefined);
  assert.equal(helpers.currentActor({ byId: { ordinary: { retainedBy: { mainView: 1 } }, blankFull: { retainedBy: {}, blank: true, permission: 'full' } } }), 'ordinary');
  assert.equal(helpers.currentActor({ byId: { fork: { retainedBy: { mainView: 1 }, parentId: 'parent' } } }), 'fork', 'ordinary forks are not subagents');
  assert.equal(helpers.currentActor({ byId: { child: { retainedBy: { mainView: 1 }, origin: 'subagent' } } }), undefined);
  assert.equal(helpers.currentActor({ byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: { mainView: 1 } } } }), undefined);
  assert.equal(helpers.currentActor({ byId: { a: { retainedBy: { controllerOperation: 1 } } } }), undefined);
});

test('source guard refuses nonblank, busy, subagent, pending and cold generations', () => {
  assert.equal(helpers.sourceEligible(blank), true);
  for (const changed of [{ blank: false }, { subagent: { address: 'child' } }, { running: true }, { removed: true }, { promptAttempted: true }, { awaitingFirstTurn: true }, { pendingSubmissions: [{}] }, { openState: 'loading' }]) {
    assert.equal(helpers.sourceEligible({ ...blank, ...changed }), false, JSON.stringify(changed));
  }
});

test('captured draft CAS includes text, revision, phase, ordered attachments and queue', () => {
  const captured = helpers.captureDraft(input);
  assert.notEqual(captured.attachmentIds, input.attachmentIds);
  assert.equal(helpers.draftUnchanged(captured, input), true);
  for (const changed of [{ draft: 'changed' }, { draftRev: 4 }, { phase: 'claimed' }, { phase: 'submitting' }, { attachmentIds: ['draft-b', 'draft-a'] }, { attachmentIds: ['draft-a'] }, { queue: [{}] }]) {
    assert.equal(helpers.draftUnchanged(captured, { ...input, ...changed }), false, JSON.stringify(changed));
  }
  assert.equal(helpers.inputEmpty({ draft: '', phase: 'plain', attachmentIds: [], queue: [] }), true);
  for (const changed of [{ draft: 'existing' }, { phase: 'adjudicating' }, { attachmentIds: ['existing'] }, { queue: [{}] }]) {
    assert.equal(helpers.inputEmpty({ draft: '', phase: 'plain', attachmentIds: [], queue: [], ...changed }), false);
  }
});

function blocks(initial) {
  let actual = initial;
  const writes = [];
  const store = { getSnapshot: () => actual };
  return { writes, force: value => { actual = value; }, storeFor: () => store, set: (id, block) => {
    writes.push([id, block]);
    // Match the installed reason-deduplicating setter, not an imaginary CAS setter.
    if (actual?.reason === block?.reason) return;
    actual = block;
  } };
}

test('block acquisition retains exact object and never overwrites/clears/restores foreign ownership', () => {
  const registry = blocks(undefined);
  const lease = helpers.acquireBlock(registry, 'source', 'Preparing');
  assert.equal(registry.storeFor('source').getSnapshot(), lease.owned);
  assert.ok(Object.isFrozen(lease.owned));
  lease.release();
  assert.equal(registry.storeFor('source').getSnapshot(), undefined);
  assert.equal(registry.writes.length, 2);
  lease.release();
  assert.equal(registry.writes.length, 2, 'clear is identity-guarded and idempotent');
  const foreign = { reason: 'Preparing' };
  const occupied = blocks(foreign);
  fails(() => helpers.acquireBlock(occupied, 'source', 'Preparing'), 'blocked');
  assert.equal(occupied.writes.length, 0, 'reason equality cannot confer ownership');
  const taken = blocks(undefined);
  const takenLease = helpers.acquireBlock(taken, 'source', 'Preparing');
  taken.force(foreign);
  takenLease.release();
  assert.equal(taken.storeFor('source').getSnapshot(), foreign);
  assert.equal(taken.writes.length, 1, 'a foreign block is neither cleared nor restored');
});

test('destination reference releases only after main ownership or uncommitted failure; parked commit survives until open/unload', () => {
  function ownershipProtocol(initial) {
    let counts = initial;
    let releases = 0;
    const listeners = new Set();
    const cleanups = new Set();
    const ownership = { getSnapshot: () => ({ retainedBy: counts }), subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } };
    const ctx = { sessions: { retainInfo: id => { assert.equal(id, 'exact-target'); return ownership; } }, effect: factory => {
      const cleanup = factory();
      let active = true;
      const dispose = () => { if (active) { active = false; cleanups.delete(dispose); cleanup(); } };
      cleanups.add(dispose);
      return dispose;
    } };
    const reference = { sessionId: 'exact-target', release: () => { ++releases; } };
    return { ctx, reference, listeners, cleanups, releases: () => releases, publish(value) { counts = value; for (const callback of [...listeners]) callback(); } };
  }
  const beforeCommit = ownershipProtocol({});
  helpers.releaseAfterMainOwnership(beforeCommit.ctx, beforeCommit.reference, false);
  assert.equal(beforeCommit.releases(), 1);
  const main = ownershipProtocol({ mainView: 1 });
  helpers.releaseAfterMainOwnership(main.ctx, main.reference, true);
  assert.equal(main.releases(), 1);
  const parked = ownershipProtocol({ controllerOperation: 1 });
  helpers.releaseAfterMainOwnership(parked.ctx, parked.reference, true);
  assert.equal(parked.releases(), 0);
  assert.equal(parked.cleanups.size, 1);
  parked.publish({ controllerOperation: 2 });
  assert.equal(parked.releases(), 0);
  parked.publish({ mainView: 1, controllerOperation: 1 });
  assert.equal(parked.releases(), 1);
  assert.equal(parked.listeners.size, 0);
  assert.equal(parked.cleanups.size, 0);
  const unload = ownershipProtocol({ controllerOperation: 1 });
  helpers.releaseAfterMainOwnership(unload.ctx, unload.reference, true);
  for (const dispose of [...unload.cleanups]) dispose();
  assert.equal(unload.releases(), 1);
  assert.equal(unload.listeners.size, 0);
});

test('remote defaults are main if visible, then advertised HEAD, otherwise explicit selection', () => {
  assert.equal(helpers.advertisedDefault(branches), 'main');
  assert.equal(helpers.advertisedDefault({ ...branches, items: [{ name: 'develop', oid: 'abc' }, { name: 'release', oid: 'def' }] }), 'develop');
  assert.equal(helpers.advertisedDefault({ ...branches, defaultBranch: 'not-advertised', items: [{ name: 'release', oid: 'def' }] }), '');
  assert.equal(helpers.advertisedDefault({ ...branches, items: [] }), '');
});



test('lazy native mode preserves composer, commands and editor; no custom message renderer', () => {
  assert.match(source, /name: 'conversation.input.left', id: PANEL, order: 15.*NewWorktreeControls/);
  assert.match(source, /name: 'conversation.input.dock'.*SetupProgress/);
  assert.doesNotMatch(source, /FirstPrompt|NewThreadDialog|ProjectHero|composerSelection|name: 'conversation.composer'|name: 'conversation.composer.bar'|name: 'conversation.hero.workspace'/);
  assert.doesNotMatch(source, /setDraft\(|addAttachments\(|removeAttachment\(|createDrafts\(|\.deps\s*=/);
  assert.match(source, /flow.select\(sessionId, event.target.value\)/);
  assert.match(source, /conversation.sendSession\(target.session, text, ids, mode, signal\)/);
  assert.match(source, /const flow = createWorktreeFlow/);
  assert.doesNotMatch(source, /setInterval\(|setTimeout\(|document.addEventListener|conversation.send =/);
});

test('private adapter is explicitly pinned, fail-closed and paired with native SDK ABI checks', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.engines.dsh, '0.2.0-rc.2'); assert.match(helpers.NATIVE_SUBMIT_ABI, /^0\.2\.0-rc\.2\//);
  const native = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8');
  assert.match(native, /this.deps = deps/);
  assert.match(native, /this.deps.defaultSink\(draft.trim\(\), attachmentIds, mode, attempt.signal\)/);
  assert.match(native, /this.deps.defaultSink\(out.trim\(\), attachmentIds, mode, attempt.signal\)/);
  assert.match(native, /this.deps.defaultSink\("", attachmentIds, mode, controller.signal\)/);
  assert.match(native, /this.deps.inputTriggers\?\.\(\)/);
  assert.match(native, /inputTriggers.serializeReference\(o.source, o.ref, attempt.signal\)/);
  assert.match(native, /inputTriggers.adjudicate\(draft.trim\(\), attempt.signal/);
  assert.match(native, /this.draftEditor.restoreDraft\(draft, occurrences\)/);
});

function observable(initial) {
  let value = initial; const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    publish(next) { value = next; for (const fn of [...listeners]) fn(); }, listeners };
}
async function settle() { for (let i = 0; i < 30; ++i) await Promise.resolve(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function leaseFixture({ mode = 'new', codec, adjudicate } = {}) {
  const calls = [], finished = [], scope = {}, binding = { ctx: scope };
  const controller = { serializeReference: codec || (async (owner, ref) => `model:${owner}/${ref}`), adjudicate: adjudicate || (async () => undefined), other() { return this === controller; } };
  const original = async (text, ids, mode, signal) => { calls.push(['local', text, [...ids], mode, signal]); return { kind: 'success' }; };
  const input = { deps: { actx: scope, defaultSink: original, inputTriggers: () => controller } };
  let choice = mode;
  const lease = helpers.leaseNativeSink(input, binding, { capture: () => ({ mode: choice }), async submit(_, text, ids, mode, signal) { calls.push(['target', text, [...ids], mode, signal]); return { kind: 'success' }; }, settled(captured, error) { finished.push({ captured, error }); }, error: error => error.message });
  return { input, binding, lease, original, calls, finished, setMode(value) { choice = value; } };
}

test('sink lease redirects canonical messages and resolved mode only; Local remains native', async () => {
  const run = leaseFixture(); const signal = new AbortController().signal;
  assert.equal((await run.input.deps.defaultSink('canonical refs', ['file', 'image'], 'steer', signal)).kind, 'success');
  assert.equal(run.calls[0][0], 'target'); assert.equal(run.calls[0][1], 'canonical refs'); assert.deepEqual(run.calls[0][2], ['file', 'image']); assert.equal(run.calls[0][3], 'steer');
  await settle(); run.setMode('local'); await run.input.deps.defaultSink('local', [], 'queue', new AbortController().signal);
  assert.equal(run.calls[1][0], 'local'); await run.lease.close(); assert.equal(run.input.deps.defaultSink, run.original);
});

test('native codec and adjudication are delegated exactly once with original this/context', async () => {
  let serialized = 0, adjudicated = 0;
  const run = leaseFixture({ codec: async (owner, ref) => { ++serialized; return `expanded:${owner}/${ref}`; }, adjudicate: async () => { ++adjudicated; return { claim: { name: 'command' } }; } });
  const codec = run.input.deps.inputTriggers(); assert.equal(codec.other(), true);
  const probe = new AbortController();
  assert.equal(await codec.serializeReference('reference', 'id', probe.signal), 'expanded:reference/id');
  const outcome = await codec.adjudicate('/command', new AbortController().signal, { attachments: 0 }); assert.equal(outcome.claim.name, 'command'); assert.equal(adjudicated, 1); assert.equal(serialized, 1); assert.equal(run.calls.length, 0);
  // Complete the ordinary serialization occurrence just as the native machine does.
  const signal = new AbortController().signal; await codec.serializeReference('reference', 'second', signal); await run.input.deps.defaultSink('expanded second', [], 'queue', signal);
  // Abort the standalone codec probe, which intentionally had no native sink.
  probe.abort();
  await settle(); await run.lease.close();
});

test('slow native reference serialization plus Local choice cannot accidentally fall through to Local', async () => {
  const pending = deferred(), run = leaseFixture({ codec: () => pending.promise }), native = new AbortController();
  const send = run.input.deps.inputTriggers().serializeReference('reference', 'slow', native.signal).then(text => run.input.deps.defaultSink(text, [], 'queue', native.signal));
  run.setMode('local'); run.lease.cancelNew(); await assert.rejects(send, error => error.kind === 'cancelled');
  pending.resolve('late text'); await settle(); assert.equal(run.calls.length, 0); await run.lease.close(); assert.equal(run.input.deps.defaultSink, run.original);
});

test('slow native slash warmup plus plugin unload settles failure before descriptor restoration', async () => {
  const pending = deferred(), run = leaseFixture({ adjudicate: () => pending.promise }), native = new AbortController();
  const send = run.input.deps.inputTriggers().adjudicate('/unknown', native.signal, { attachments: 0 }).then(() => run.input.deps.defaultSink('/unknown', [], 'queue', native.signal));
  const closed = run.lease.close(); await assert.rejects(send, error => error.kind === 'cancelled'); await closed;
  pending.resolve(undefined); await settle(); assert.equal(run.calls.length, 0); assert.equal(run.input.deps.defaultSink, run.original);
});

test('Local choice before slow serialization is frozen even if New worktree is selected meanwhile', async () => {
  const pending = deferred(), run = leaseFixture({ mode: 'local', codec: () => pending.promise }), native = new AbortController();
  const send = run.input.deps.inputTriggers().serializeReference('reference', 'slow', native.signal).then(text => run.input.deps.defaultSink(text, [], 'queue', native.signal));
  run.setMode('new'); pending.resolve('native expanded'); await send; assert.equal(run.calls[0][0], 'local'); await run.lease.close();
});

test('unsupported private shape and accessor trap fail without invoking getters or mutating native callbacks', () => {
  let reads = 0; const binding = { ctx: {} }, input = {};
  Object.defineProperty(input, 'deps', { get() { ++reads; throw Error('trap'); } });
  assert.throws(() => helpers.leaseNativeSink(input, binding, {}), error => error.kind === 'unsupported'); assert.equal(reads, 0);
  const wrong = { deps: { actx: binding.ctx, defaultSink: async () => ({ kind: 'success' }) } };
  assert.throws(() => helpers.leaseNativeSink(wrong, binding, {}), error => error.kind === 'unsupported');
});

test('lease restoration is identity-safe and never overwrites a competing writer', async () => {
  const run = leaseFixture(), replacement = async () => ({ kind: 'success' }); run.input.deps.defaultSink = replacement;
  await run.lease.close(); assert.equal(run.input.deps.defaultSink, replacement);
});

function transaction({ deferredSetup = false, setupFailure, deferredUpload = false, admission = 'success', deferredSourceUpload = false, draft = '', attachments = [], withoutRepositoryGate = false, context: initialContext, records = [], sourceCwd = '/repo/services/api' } = {}) {
  const calls = [], events = [], admissions = [], sourceAdmissions = [], opened = [], references = [], cleanups = new Set();
  const empty = { draft: '', draftRev: 7, attachmentIds: [], phase: 'plain', queue: [], occurrences: [] };
  const src = observable({ ...empty, draft, attachmentIds: attachments }), dst = observable({ ...empty });
  const srcSession = observable({ ...blank }), dstSession = observable({ ...blank });
  const list = observable({ byId: { source: { retainedBy: { mainView: 1 } } } }), ownership = observable({ retainedBy: {} });
  const statuses = observable(new Map()), generation = observable({ id: 1 }), metadata = observable({ projects: initialContext ? [initialContext.project] : [], bindings: initialContext?.binding ? [initialContext.binding] : [], records });
  function effect(factory) { const cleanup = factory(); let live = true; const stop = () => { if (live) { live = false; cleanups.delete(stop); return cleanup(); } }; cleanups.add(stop); return stop; }
  const srcBinding = { ctx: { id: 'source', effect }, session: srcSession }, dstBinding = { ctx: { id: 'target', effect }, session: dstSession };
  const nativeSink = async (text, ids, mode, signal) => { sourceAdmissions.push({ text, ids, mode, signal }); return { kind: 'success' }; };
  const codec = { async serializeReference(owner, ref) { events.push('native-serialize'); return `native-model:${owner}/${ref}`; }, async adjudicate() { return undefined; } };
  const srcInput = { state: src, deps: { actx: srcBinding.ctx, defaultSink: nativeSink, inputTriggers: () => codec }, setDraft() { assert.fail('native machine owns editor mutation'); } }, dstInput = { state: dst };
  const blocks = new Map([['source', observable(undefined)], ['target', observable(undefined)]]);
  const fileUploads = observable(Object.fromEntries(attachments.filter(id => id.startsWith('file')).map(id => [id, { status: 'ready', owner: 'source' }])));
  const descriptors = new Map(attachments.map(id => [id, { id, kind: id.startsWith('file') ? 'file' : 'image', file: { name: id } }]));
  const result = { sessionId: 'target', workspaceId: 'workspace', settingsHash: status.settingsHash, worktree: { ...record, id: 'abcdefab-1234-4234-8234-123456789abc', branch: 'worktree/task-random', sessionIds: ['target'] }, operation: op };
  let navigation, setupPending, progressState, progressWaiters = [];
  function publish(stage, operationId, terminal = false) {
    progressState ||= { operationId, revision: 0, stages: [], terminal: false }; progressState.revision++;
    if (stage) { progressState.stages.push({ stage, operationId, worktreeId: result.worktree.id }); events.push(stage); }
    progressState.terminal = terminal;
    for (const waiter of [...progressWaiters]) if (progressState.revision > waiter.after || terminal) { waiter.cleanup(); waiter.resolve(success(structuredClone(progressState))); progressWaiters = progressWaiters.filter(item => item !== waiter); }
  }
  function completeSetup(request) { for (const stage of ['fetching', 'creating', 'naming', 'opening', 'ready']) publish(stage, request.operationId); publish(null, request.operationId, true); return setupFailure || success(result); }
  const conversation = { blocks: { storeFor: id => blocks.get(id), set(id, value) { const store = blocks.get(id); if (store.getSnapshot()?.reason !== value?.reason) store.publish(value); } }, input: { for: scope => scope === srcBinding.ctx ? srcInput : dstInput }, fileUploads,
    resolveDraftAttachments: ids => ids.map(id => descriptors.get(id)).filter(Boolean),
    rebindDraftFiles(id, ids) { events.push('rebind:' + id); const next = { ...fileUploads.getSnapshot() }; for (const file of ids.filter(id => id.startsWith('file'))) next[file] = { status: (deferredUpload && id === 'target') || (deferredSourceUpload && id === 'source') ? 'uploading' : 'ready', owner: id }; fileUploads.publish(next); },
    async sendSession(session, text, ids, mode, signal) { assert.equal(session, dstSession); assert.ok(progressState.terminal); assert.equal(progressState.stages.at(-1).stage, 'ready'); for (const id of ids.filter(id => id.startsWith('file'))) { assert.equal(fileUploads.getSnapshot()[id].owner, 'target'); assert.equal(fileUploads.getSnapshot()[id].status, 'ready'); } events.push('normal-llm'); admissions.push({ text, ids: [...ids], mode, signal });
      if (admission === 'unknown') throw Error('lost ack');
      if (admission === 'refused') { dstSession.publish({ ...blank, promptError: { op: 'send', error: { code: 'session/refused' } } }); return { kind: 'error', text: 'refused' }; }
      return { kind: 'success' };
    },
  };
  const ctx = { get: key => { assert.equal(key, 'conversation'); return conversation; }, uiSession: { sessionStatus: statuses }, workspaces: { list: observable({ items: [{ workspaceId: 'source-folder', path: sourceCwd, sessionIds: ['source'] }, { workspaceId: 'target-folder', path: result.worktree.effectiveCwd, sessionIds: ['target'] }] }) }, sessions: { list, binding: id => id === 'source' ? srcBinding : dstBinding,
    retain(id, options) { assert.equal(options.source, 'controllerOperation'); const ref = { sessionId: id, ready: Promise.resolve(id === 'source' ? srcBinding : dstBinding), releases: 0, release() { ++ref.releases; } }; references.push(ref); return ref; }, retainInfo: id => id === 'source' ? { getSnapshot: () => ({ retainedBy: list.getSnapshot().byId.source?.retainedBy || {} }), subscribe: list.subscribe } : ownership },
    layout: { beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; } },
    uiWorkspace: { openSession(id) { opened.push(id); navigation.abort(); ownership.publish({ retainedBy: { mainView: 1 } }); list.publish({ byId: { [id]: { retainedBy: { mainView: 1 } } } }); }, startSession() { assert.fail('not used'); } }, effect,
    connection: { generation, rpc: { async call(channel, endpoint, payload, signal) {
      assert.equal(channel, '/api'); assert.equal(payload.actorId, 'source'); calls.push({ endpoint, payload, signal });
      if (endpoint === 'dsh-worktrees/progress') {
        if (progressState && (progressState.revision > payload.after || progressState.terminal)) return success(structuredClone(progressState));
        return new Promise((resolve, reject) => { const waiter = { after: payload.after, resolve, cleanup: () => signal.removeEventListener('abort', abort) }; const abort = () => { progressWaiters = progressWaiters.filter(item => item !== waiter); waiter.cleanup(); const error = Error('abort'); error.name = 'AbortError'; reject(error); }; progressWaiters.push(waiter); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
      }
      if (endpoint === 'dsh-worktrees/prepare') {
        const request = payload.request; events.push('prepare-request');
        if (deferredSetup) { const pending = deferred(); setupPending = { pending, request }; return pending.promise; }
        return completeSetup(request);
      }
      assert.equal(endpoint, 'dsh-worktrees/execute');
      if (payload.request.action === 'status') return success(payload.request.operationId ? { settingsHash: status.settingsHash, operation: op, sessionId: 'target', worktree: result.worktree } : { ...status, projectPath: '/repo/services/api' });
      if (payload.request.action === 'branches') return success(branches);
      assert.fail('unexpected request');
    } } },
  };
  let projectContext = initialContext;
  const projects = { store: metadata, context: () => projectContext, rememberWorktree() {}, rememberRecords() {} };
  const availability = observable({ available: true });
  const repositories = { store: availability, enabled: id => id === 'source' && availability.getSnapshot().available, unavailable() { availability.publish({ available: false }); } };
  const flow = helpers.createWorktreeFlow(ctx, key => key, projects, withoutRepositoryGate ? undefined : repositories); flow.observe('source');
  return { flow, ctx, srcInput, src, dst, calls, events, admissions, sourceAdmissions, opened, references, generation, metadata, fileUploads, blocks, nativeSink, repositories,
    contextChanged(next) { projectContext = next; const before = metadata.getSnapshot(); metadata.publish({ ...before, projects: next ? [next.project] : [], bindings: next?.binding ? [next.binding] : [], revision: (before.revision || 0) + 1 }); },
    revoke() { availability.publish({ available: false }); },
    select(mode) { flow.select('source', mode); }, send(text = 'first task', ids = attachments, mode = 'queue') { return srcInput.deps.defaultSink(text, ids, mode, new AbortController().signal); },
    complete() { setupPending.pending.resolve(completeSetup(setupPending.request)); }, navigate() { navigation.abort(); },
    uploaded() { const next = { ...fileUploads.getSnapshot() }; for (const [id, item] of Object.entries(next)) next[id] = { ...item, status: 'ready' }; fileUploads.publish(next); },
    async dispose() { await flow.dispose(); await Promise.allSettled([...cleanups].map(cleanup => cleanup())); } };
}

function repositoryFixture({ delayed = false, reply } = {}) {
  const calls = [], pending = [], list = observable({ byId: { source: { retainedBy: { mainView: 1 } } } }), generation = observable({ id: 1 }), metadata = observable({});
  const bindings = new Map([['source', { ctx: {}, session: observable({ ...blank }) }], ['other', { ctx: {}, session: observable({ ...blank }) }]]);
  let context = { project: { id: 'project', mainFolderId: 'main', folders: [{ id: 'main', path: '/repo/main', title: 'Main' }, { id: 'chosen', path: '/repo/chosen', title: 'Chosen' }] }, folder: { id: 'chosen', path: '/repo/chosen', title: 'Chosen' } };
  const projects = { store: metadata, context: () => context };
  const ctx = { sessions: { list, binding: id => bindings.get(id) }, connection: { generation, rpc: { call(channel, endpoint, payload, signal) {
    assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/execute'); assert.equal(payload.request.action, 'status');
    calls.push({ payload, signal });
    if (delayed) { const wait = deferred(); pending.push(wait); return wait.promise; }
    return Promise.resolve(reply || success({ ...status, projectPath: payload.request.repoPath }));
  } } } };
  const repository = helpers.createRepositoryAvailability(ctx, projects);
  return { repository, ctx, calls, pending, bindings, list, generation, metadata, projects,
    get context() { return context; },
    contextChanged(next) { context = next; metadata.publish({ revision: calls.length + 1 }); },
    finish(index, response) { pending[index].resolve(response || success({ ...status, projectPath: calls[index].payload.request.repoPath })); },
    dispose() { repository.dispose(); } };
}

test('repository availability checks only the actual selected blank folder and caches/coalesces semantic identities', async () => {
  const f = repositoryFixture({ delayed: true });
  assert.equal(f.calls.length, 0); assert.equal(f.repository.enabled('source'), false);
  const first = f.repository.ensure('source'), second = f.repository.ensure('source'); assert.equal(first, second);
  await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].payload.actorId, 'source'); assert.equal(f.calls[0].payload.request.repoPath, '/repo/chosen');
  assert.equal(f.repository.enabled('source'), false); f.finish(0); await first; assert.equal(f.repository.enabled('source'), true);
  f.contextChanged({ ...f.context, project: { ...f.context.project, title: 'Renamed', mainFolderId: 'chosen' } });
  f.list.publish({ byId: { source: { retainedBy: { mainView: 2 }, title: 'Token/title update' } } });
  await f.repository.ensure('source'); await settle(); assert.equal(f.calls.length, 1);
  assert.equal(f.repository.enabled('other'), false); f.dispose(); assert.equal(f.repository.enabled('source'), false);
});

test('non-Git, sandbox/transport/decode failures and repositories without remotes never enable worktree mode', async () => {
  for (const reply of [
    { ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Not a supported source' } } },
    { ok: true, value: { v: 1, ok: false, error: { code: 'INCOMPLETE_SANDBOX', message: 'Unavailable' } } },
    { ok: false, error: { code: 'gateway/disconnected', message: 'Offline' } },
    success({ invalid: true }), success({ ...status, remotes: [], projectPath: '/repo/chosen' }), success({ ...status, projectPath: '/different-target' }),
  ]) {
    const f = repositoryFixture({ reply }); await f.repository.ensure('source'); assert.equal(f.repository.enabled('source'), false); assert.equal(f.repository.store.getSnapshot().phase, 'unavailable');
    await f.repository.ensure('source'); assert.equal(f.calls.length, 1, 'negative observations are cached, not polled'); f.dispose();
  }
});

test('availability invalidation aborts folder/binding changes and stale failures cannot overwrite a new positive', async () => {
  const f = repositoryFixture({ delayed: true }); const first = f.repository.ensure('source'); await settle();
  f.contextChanged({ ...f.context, folder: { id: 'another', path: '/repo/another', title: 'Another' } }); await settle();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.calls[1].payload.request.repoPath, '/repo/another');
  f.finish(1); await settle(); assert.equal(f.repository.enabled('source'), true);
  f.finish(0, { ok: false, error: { code: 'late-error', message: 'Old failure' } }); await first; assert.equal(f.repository.enabled('source'), true);
  f.bindings.set('source', { ctx: {}, session: observable({ ...blank }) }); f.list.publish({ ...f.list.getSnapshot() }); await settle();
  assert.equal(f.repository.enabled('source'), false); assert.equal(f.calls.length, 3); f.finish(2); await settle(); assert.equal(f.repository.enabled('source'), true); f.dispose();
});

test('actor ambiguity, disconnect/reconnect, loss of readiness and disposal invalidate availability without new actor authority', async () => {
  const f = repositoryFixture({ delayed: true }); const first = f.repository.ensure('source'); await settle();
  f.list.publish({ byId: { source: { retainedBy: { mainView: 1 } }, other: { retainedBy: { mainView: 1 } } } });
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.repository.enabled('source'), false); f.finish(0); await first;
  await f.repository.ensure('source'); assert.equal(f.calls.length, 1);
  f.list.publish({ byId: { other: { retainedBy: { mainView: 1 } } } }); await settle(); assert.equal(f.calls[1].payload.actorId, 'other');
  f.generation.publish(undefined); assert.equal(f.calls[1].signal.aborted, true); f.finish(1); await settle(); assert.equal(f.repository.enabled('other'), false);
  f.generation.publish({ id: 2 }); await settle(); assert.equal(f.calls.length, 3); f.finish(2); await settle(); assert.equal(f.repository.enabled('other'), true);
  f.bindings.get('other').session.publish({ ...blank, blank: false }); assert.equal(f.repository.enabled('other'), false);
  f.bindings.get('other').session.publish({ ...blank }); const last = f.repository.ensure('other'); await settle(); assert.equal(f.calls.length, 4);
  f.dispose(); assert.equal(f.calls[3].signal.aborted, true); f.finish(3); await last; assert.equal(f.repository.enabled('other'), false);
  assert.equal(f.list.listeners.size, 0); assert.equal(f.generation.listeners.size, 0); assert.equal(f.metadata.listeners.size, 0);
});

test('repository checks do not dispatch after immediate navigation or for cold/nonblank/subagent targets', async () => {
  const f = repositoryFixture(); const early = f.repository.ensure('source'); f.list.publish({ byId: {} }); await early; await settle(); assert.equal(f.calls.length, 0);
  f.list.publish({ byId: { source: { retainedBy: { mainView: 1 } } } });
  for (const snapshot of [{ ...blank, openState: 'loading' }, { ...blank, blank: false }, { ...blank, subagent: {} }]) { f.bindings.get('source').session.publish(snapshot); await f.repository.ensure('source'); }
  assert.equal(f.calls.length, 0); f.dispose();
});

test('withdrawing a composer/panel observation cancels its probe and same-id connection publications do not refetch', async () => {
  const f = repositoryFixture({ delayed: true }); const first = f.repository.ensure('source'); await settle();
  f.generation.publish({ id: 1 }); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].signal.aborted, false);
  f.repository.withdraw('source'); assert.equal(f.calls[0].signal.aborted, true); f.finish(0); await first; assert.equal(f.repository.enabled('source'), false);
  f.metadata.publish({ hiddenPanel: true }); f.generation.publish({ id: 2 }); await settle(); assert.equal(f.calls.length, 1, 'hidden/unmounted composer does no background query');
  const resumed = f.repository.ensure('source'); await settle(); assert.equal(f.calls.length, 2); f.finish(1); await resumed; assert.equal(f.repository.enabled('source'), true);
  f.repository.unavailable('source', {}, undefined); assert.equal(f.repository.enabled('source'), true, 'unrelated binding feedback cannot revoke this target');
  f.repository.unavailable('source', f.bindings.get('source'), { projectId: 'project', folderId: 'chosen', path: '/repo/chosen' }); assert.equal(f.repository.enabled('source'), false);
  await f.repository.ensure('source'); assert.equal(f.calls.length, 2, 'fresh status rejection is cached without a re-probe loop'); f.dispose();
});

test('missing availability dependency denies New/configure but Local remains the native sink', async () => {
  const run = transaction({ withoutRepositoryGate: true }); run.select('new'); assert.equal(run.flow.store.getSnapshot().mode, 'local');
  await run.flow.configure('source'); assert.equal(run.calls.length, 0); const result = await run.send('local-only message'); assert.equal(result.kind, 'success'); assert.equal(run.sourceAdmissions.length, 1); assert.equal(run.admissions.length, 0); await run.dispose();
});

test('revoked Git availability preserves latched New intent and requires explicit Local before native admission', async () => {
  const run = transaction(); run.select('new'); run.revoke(); assert.equal(run.flow.store.getSnapshot().mode, 'new');
  const result = await run.send('preserve this message'); assert.equal(result.kind, 'error'); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 0); assert.equal(run.calls.length, 0);
  run.select('new'); assert.equal(run.flow.store.getSnapshot().mode, 'new'); await run.flow.configure('source'); assert.equal(run.calls.length, 0);
  run.select('local'); assert.equal((await run.send('explicit Local')).kind, 'success'); assert.equal(run.sourceAdmissions.length, 1); await run.dispose();
});

test('revocation cancels already captured slow native codecs and discards delayed branch configuration', async () => {
  const run = transaction(); run.select('new'); const codec = deferred(), native = new AbortController();
  // InputTriggers is read on each native occurrence; preserve the same guarded thunk ownership.
  const original = run.srcInput.deps.inputTriggers;
  const returned = original(); returned.serializeReference = () => codec.promise;
  const send = run.srcInput.deps.inputTriggers().serializeReference('ref', 'slow', native.signal).then(text => run.srcInput.deps.defaultSink(text, [], 'queue', native.signal));
  run.revoke(); await assert.rejects(send, error => error.kind === 'cancelled'); codec.resolve('late canonical text'); await settle(); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 0); await run.dispose();
  const config = transaction(), pending = deferred(); config.select('new');
  config.ctx.connection.rpc.call = async (_channel, _endpoint, payload, signal) => { config.calls.push({ payload, signal }); return pending.promise; };
  const waiting = config.flow.configure('source'); await settle(); config.revoke(); assert.equal(config.calls[0].signal.aborted, true);
  pending.resolve(success({ ...status, projectPath: '/repo/services/api' })); await waiting; assert.equal(config.flow.store.getSnapshot().status, null); assert.equal(config.flow.store.getSnapshot().branches, null); await config.dispose();
});

test('project removal invalidates selected New even after cwd availability is positive, until explicit user selection', async () => {
  const run = transaction({ context: ownedContext, draft: 'keep draft', attachments: ['file-one'] }); run.select('new');
  const before = structuredClone(run.src.getSnapshot()); run.contextChanged(undefined);
  assert.equal(run.repositories.enabled('source'), true); assert.equal(run.flow.store.getSnapshot().mode, 'new'); assert.equal(run.flow.store.getSnapshot().sourceChanged, true);
  assert.equal((await run.send('do not reroute')).kind, 'error'); assert.equal(run.calls.length, 0); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 0); assert.deepEqual(run.src.getSnapshot(), before);
  await run.flow.configure('source'); assert.equal(run.calls.length, 0);
  run.select('local'); assert.equal((await run.send('explicit current Local')).kind, 'success'); assert.equal(run.sourceAdmissions.length, 1); await run.dispose(); assert.equal(run.metadata.listeners.size, 0);
  const fresh = transaction({ context: ownedContext }); fresh.select('new'); fresh.contextChanged(undefined); fresh.select('new');
  assert.equal(fresh.flow.store.getSnapshot().sourceChanged, false); assert.equal((await fresh.send('fresh independent New')).kind, 'success'); await settle();
  const request = fresh.calls.find(call => call.endpoint === 'dsh-worktrees/prepare').payload.request; assert.equal(Object.hasOwn(request, 'projectId'), false); assert.equal(Object.hasOwn(request, 'folderId'), false); assert.equal(fresh.admissions.length, 1); await fresh.dispose();
});

test('project main/title edits do not invalidate New, but explicit re-add under a different project UUID does', async () => {
  const run = transaction({ context: ownedContext }); run.select('new');
  run.contextChanged({ ...ownedContext, project: { ...ownedContext.project, title: 'Renamed', mainFolderId: 'folder-api' } }); assert.equal(run.flow.store.getSnapshot().sourceChanged, false); assert.equal(run.calls.length, 0);
  run.contextChanged({ ...ownedContext, project: { ...ownedContext.project, id: 'abcdefab-1234-4234-8234-123456789abc' } });
  assert.equal(run.flow.store.getSnapshot().sourceChanged, true); assert.equal((await run.send('do not retarget owner')).kind, 'error'); assert.equal(run.calls.length, 0); await run.dispose();
});

test('project removal cancels slow native serialization without admitting locally or changing draft/chips', async () => {
  const run = transaction({ context: ownedContext, draft: 'native chip draft', attachments: ['image-one'] }), codec = deferred(), native = new AbortController(); run.select('new');
  const before = structuredClone(run.src.getSnapshot()); run.srcInput.deps.inputTriggers().serializeReference = () => codec.promise;
  const sending = run.srcInput.deps.inputTriggers().serializeReference('ref', 'slow', native.signal).then(text => run.srcInput.deps.defaultSink(text, ['image-one'], 'queue', native.signal));
  run.contextChanged(undefined); await assert.rejects(sending, error => error.kind === 'cancelled'); codec.resolve('late canonical reference'); await settle();
  assert.equal(run.calls.length, 0); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 0); assert.deepEqual(run.src.getSnapshot(), before); await run.dispose();
});

test('removed ownership aborts delayed configure and branches and cannot publish stale preferences', async () => {
  for (const stage of ['status', 'branches']) {
    const run = transaction({ context: ownedContext }), delayed = deferred(); run.select('new'); const original = run.ctx.connection.rpc.call; let request;
    run.ctx.connection.rpc.call = (...args) => {
      if (args[2].request?.action === stage) { request = { payload: args[2], signal: args[3] }; return delayed.promise; }
      return original(...args);
    };
    const configuring = run.flow.configure('source'); await settle(); assert.ok(request); run.contextChanged(undefined); assert.equal(request.signal.aborted, true);
    delayed.resolve(success(stage === 'status' ? { ...status, projectPath: ownedContext.folder.path } : branches)); await configuring;
    const state = run.flow.store.getSnapshot(); assert.equal(state.status, null); assert.equal(state.branches, null); assert.equal(state.remote, ''); assert.equal(state.branch, ''); assert.equal(state.sourceChanged, true);
    assert.equal((await run.send('not stale preferences')).kind, 'error'); assert.equal(run.admissions.length, 0); assert.equal(run.sourceAdmissions.length, 0); await run.dispose();
  }
});

test('project removal during preparation or target upload cancels before admission and restages source files', async () => {
  for (const upload of [false, true]) {
    const run = transaction({ context: ownedContext, deferredSetup: !upload, deferredUpload: upload, draft: 'preserved', attachments: upload ? ['file-one'] : [] }); run.select('new');
    const sending = run.send('first task'); await settle(); run.contextChanged(undefined); if (!upload) run.complete(); const result = await sending; await settle();
    assert.equal(result.kind, 'error'); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 0); assert.deepEqual(run.opened, []); assert.equal(run.src.getSnapshot().draft, 'preserved');
    if (upload) assert.equal(run.fileUploads.getSnapshot()['file-one'].owner, 'source'); assert.equal(run.blocks.get('source').getSnapshot(), undefined); await run.dispose();
  }
});

test('project removal after accepted worktree Send preserves exactly one admission and deferred navigation', async () => {
  const run = transaction({ context: ownedContext }); let removed = false;
  const stop = run.flow.store.subscribe(() => { if (!removed && run.flow.store.getSnapshot().phase === 'complete') { removed = true; run.contextChanged(undefined); } });
  run.select('new'); assert.equal((await run.send('accepted')).kind, 'success'); await settle(); assert.equal(removed, true); assert.equal(run.admissions.length, 1); assert.equal(run.sourceAdmissions.length, 0); assert.deepEqual(run.opened, ['target']); stop(); await run.dispose();
});

test('explicit current-worktree selection cancels New and uses native Send without source-folder navigation or Git availability', async () => {
  for (const assigned of [false, true]) for (const unavailable of [false, true]) {
    const retained = { ...record, effectiveCwd: '/repo/worktree' }, context = assigned ? { ...ownedContext, binding: { ...ownedContext.binding, mode: 'worktree', effectiveCwd: retained.effectiveCwd, worktreeId: retained.id } } : undefined;
    const run = transaction({ context, records: [retained], sourceCwd: retained.effectiveCwd, draft: 'keep text', attachments: ['image-one'] }); run.select('new'); if (unavailable) run.revoke();
    const before = structuredClone(run.src.getSnapshot()); run.select('worktree'); assert.equal(run.flow.store.getSnapshot().mode, 'local'); assert.equal(run.flow.store.getSnapshot().sourceChanged, false); assert.deepEqual(run.src.getSnapshot(), before);
    assert.equal((await run.send('native current checkout')).kind, 'success'); assert.equal(run.sourceAdmissions.length, 1); assert.equal(run.admissions.length, 0); assert.equal(run.calls.length, 0); assert.deepEqual(run.opened, []); await run.dispose();
  }
});

test('fresh configure/Send status rejection replaces an older positive observation without Local fallback', async () => {
  const config = transaction(); config.select('new');
  config.ctx.connection.rpc.call = async () => ({ ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Source no longer valid' } } });
  await config.flow.configure('source'); assert.equal(config.repositories.enabled('source'), false); assert.equal(config.flow.store.getSnapshot().mode, 'new'); assert.equal(config.flow.store.getSnapshot().branches, null); await config.dispose();
  const run = transaction(); run.select('new');
  run.ctx.connection.rpc.call = async (_channel, _endpoint, payload) => { run.calls.push({ payload }); return success({ ...status, remotes: [] }); };
  const outcome = await run.send('no remote source'); assert.equal(outcome.kind, 'error'); assert.equal(run.repositories.enabled('source'), false); assert.equal(run.flow.store.getSnapshot().mode, 'new');
  assert.equal(run.calls.length, 1); assert.equal(run.admissions.length, 0); assert.equal(run.sourceAdmissions.length, 0); run.select('local'); assert.equal((await run.send('explicit Local')).kind, 'success'); await run.dispose();
});

test('accepted worktree Send survives eligibility revocation during deferred destination navigation', async () => {
  const run = transaction(); let revoked = false;
  const stop = run.flow.store.subscribe(() => { if (!revoked && run.flow.store.getSnapshot().phase === 'complete') { revoked = true; run.revoke(); } });
  run.select('new'); assert.equal((await run.send('accepted before navigation')).kind, 'success'); await settle();
  assert.equal(revoked, true); assert.equal(run.admissions.length, 1); assert.equal(run.sourceAdmissions.length, 0); assert.deepEqual(run.opened, ['target']); stop(); await run.dispose();
});

test('worktree options and the entire branch fieldset require positive target availability; recovery is explicit Local', () => {
  const controls = source.slice(source.indexOf('    function NewWorktreeControls('), source.indexOf('    function SetupProgress('));
  assert.match(controls, /canWorktree = repositories.enabled\(sessionId\), blockedNew = selected && state.mode === 'new' && \(!canWorktree \|\| state.sourceChanged\)/);
  assert.match(controls, /!blockedNew && \(canWorktree \|\| worktree\) \? h\('select'/);
  assert.match(controls, /canWorktree && h\('option', \{ value: 'new' \}/);
  assert.match(controls, /canWorktree && !worktree && options && h\('fieldset'/);
  assert.match(controls, /onClick: \(\) => flow.select\(sessionId, 'local'\)/);
  assert.match(controls, /usePanelInfo\(value => value.activePanelId\)/); assert.match(controls, /return \(\) => repositories.withdraw\(sessionId\)/);
  assert.match(source, /const repositories = createRepositoryAvailability\(ctx, projects\)/);
  assert.match(source, /createWorktreeFlow\(ctx, ctx.locale.bind\(NS\), projects, repositories\)/);
  assert.doesNotMatch(controls, /fetch\(|\.git[/'"]|commands.execute/);
});

test('selecting New worktree is side-effect-free even with text, chips or attachments', async () => {
  const run = transaction({ draft: 'keep native rich draft', attachments: ['file-one', 'image-two'] }); run.select('new');
  assert.equal(run.calls.length, 0); assert.equal(run.events.length, 0); assert.equal(run.admissions.length, 0); assert.equal(run.blocks.get('source').getSnapshot(), undefined);
  assert.equal(run.src.getSnapshot().draft, 'keep native rich draft'); await run.dispose(); assert.equal(run.srcInput.deps.defaultSink, run.nativeSink);
});

test('first native Send strictly fetches, creates and names before exactly one target LLM admission', async () => {
  const run = transaction(); run.select('new'); const outcome = await run.send('canonical first prompt'); await settle();
  assert.equal(outcome.kind, 'success'); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.admissions.length, 1);
  assert.deepEqual(run.events.filter(event => ['fetching', 'creating', 'naming', 'opening', 'ready', 'normal-llm'].includes(event)), ['fetching', 'creating', 'naming', 'opening', 'ready', 'normal-llm']);
  const request = run.calls.find(call => call.endpoint === 'dsh-worktrees/prepare').payload.request;
  assert.equal(request.firstPrompt, 'canonical first prompt'); assert.equal(request.repoPath, '/repo/services/api'); assert.equal(request.sessionMode, 'new'); assert.equal(request.requireBlankSource, true);
  assert.deepEqual(run.opened, ['target']); assert.equal(run.references.find(ref => ref.sessionId === 'source').releases, 1); await run.dispose();
});

test('native-serialized reference output is reused verbatim and resolved gesture mode is preserved', async () => {
  const run = transaction(); run.select('new'); const signal = new AbortController().signal;
  const text = await run.srcInput.deps.inputTriggers().serializeReference('session', 'reference-id', signal);
  await run.srcInput.deps.defaultSink('before ' + text + ' after', [], 'steer', signal); await settle();
  assert.equal(run.admissions[0].text, 'before native-model:session/reference-id after'); assert.equal(run.admissions[0].mode, 'steer'); assert.equal(run.events.filter(value => value === 'native-serialize').length, 1); await run.dispose();
});

test('claimed command outcome leaves native command path untouched and does no provisioning', async () => {
  const run = transaction(); run.select('new');
  // Native adjudication delegates the single outcome; it does not enter defaultSink.
  const binding = run.ctx.sessions.binding('source');
  const originalFactory = run.srcInput.deps.inputTriggers;
  assert.ok(originalFactory); await run.dispose(); assert.equal(run.calls.length, 0); assert.equal(run.admissions.length, 0); assert.equal(binding.session.getSnapshot().blank, true);
});

test('attachment-only first Send waits for target-bound file upload, preserves file/image order, then admits', async () => {
  const run = transaction({ attachments: ['image-one', 'file-two'], deferredUpload: true }); run.select('new'); const sending = run.send(''); await settle();
  assert.equal(run.admissions.length, 0); assert.ok(run.events.includes('rebind:target')); run.uploaded(); await sending; await settle();
  assert.deepEqual(run.admissions[0].ids, ['image-one', 'file-two']); assert.equal(run.admissions[0].text, ''); await run.dispose();
});

test('failed setup returns an ordinary native error for original chip/draft rollback; no normal LLM called', async () => {
  const failure = { ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Fetch failed' } } };
  const run = transaction({ setupFailure: failure, draft: 'native source snapshot' }); run.select('new'); const outcome = await run.send('canonical'); await settle();
  assert.equal(outcome.kind, 'error'); assert.equal(run.admissions.length, 0); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.src.getSnapshot().draft, 'native source snapshot'); assert.equal(run.blocks.get('source').getSnapshot(), undefined); await run.dispose();
});

test('double first Send does not allocate another worktree or send locally', async () => {
  const run = transaction({ deferredSetup: true }); run.select('new'); const first = run.send(); await settle(); const second = await run.send();
  assert.equal(second.kind, 'error'); assert.equal(run.calls.filter(call => call.endpoint === 'dsh-worktrees/prepare').length, 1); assert.equal(run.sourceAdmissions.length, 0);
  run.complete(); await first; await settle(); assert.equal(run.admissions.length, 1); await run.dispose();
});

test('navigation during setup suppresses late LLM admission, preserves native rollback and retains created checkout', async () => {
  const run = transaction({ deferredSetup: true }); run.select('new'); const sending = run.send(); await settle(); run.navigate(); run.complete(); const outcome = await sending; await settle();
  assert.equal(outcome.kind, 'error'); assert.equal(run.admissions.length, 0); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.opened.length, 0); assert.equal(run.blocks.get('source').getSnapshot(), undefined); await run.dispose();
});

test('explicit target refusal restores source-session file receipts; Local retry uses native sink', async () => {
  const run = transaction({ attachments: ['file-one'], admission: 'refused' }); run.select('new'); const outcome = await run.send(); await settle();
  assert.equal(outcome.kind, 'error'); assert.equal(run.fileUploads.getSnapshot()['file-one'].owner, 'source'); run.select('local'); await run.send('local retry');
  assert.equal(run.sourceAdmissions.length, 1); assert.equal(run.calls.filter(call => call.endpoint === 'dsh-worktrees/prepare').length, 1); await run.dispose();
});

test('unknown target admission cannot automatically create or send again', async () => {
  const run = transaction({ admission: 'unknown' }); run.select('new'); await run.send(); await settle(); await run.send(); await settle();
  assert.equal(run.admissions.length, 1); assert.equal(run.sourceAdmissions.length, 0); assert.equal(run.calls.filter(call => call.endpoint === 'dsh-worktrees/prepare').length, 1); await run.dispose();
});

test('pipeline progress validates operation identity, revision and bounded stage vocabulary', () => {
  const id = '12345678-1234-4234-8234-123456789abc', data = { operationId: id, revision: 1, stages: [{ stage: 'fetching', operationId: id }], terminal: false };
  assert.equal(helpers.setupProgress(data, id), data);
  for (const changed of [{ operationId: 'wrong' }, { revision: 0 }, { revision: Infinity }, { stages: [{ stage: 'llm', operationId: id }] }, { stages: Array(9).fill(data.stages[0]) }, { terminal: 'yes' }]) fails(() => helpers.setupProgress({ ...data, ...changed }, id), 'decode');
});


test('exact native ABI requires both callback descriptors and rejects missing trigger capture', () => {
  const binding = { ctx: {} };
  const defaultSink = async (_text, _ids, _mode, _signal) => ({ kind: 'success' });
  const input = { deps: { actx: binding.ctx, defaultSink } };
  assert.throws(() => helpers.leaseNativeSink(input, binding, {}), error => error.kind === 'unsupported');
  assert.equal(input.deps.defaultSink, defaultSink);
});

test('adapter native settlement callback runs after native promise reaction restores the source snapshot', async () => {
  const binding = { ctx: {} }, input = { deps: { actx: binding.ctx, defaultSink: async (_text, _ids, _mode, _signal) => ({ kind: 'success' }), inputTriggers: () => undefined } };
  let restored = false, retained = true;
  const lease = helpers.leaseNativeSink(input, binding, { capture: () => ({ mode: 'new' }), async submit() { return { kind: 'error', text: 'refused' }; }, settled() { assert.equal(restored, true); retained = false; }, error: error => error.message });
  const pending = input.deps.defaultSink('native snapshot', [], 'queue', new AbortController().signal);
  await pending.then(outcome => { assert.equal(outcome.kind, 'error'); assert.equal(retained, true); restored = true; });
  await settle(); assert.equal(retained, false); await lease.close();
});

test('configuration already pending at native Send cannot change the frozen remote/base intent', async () => {
  const run = transaction({ deferredSetup: true }); run.select('new');
  const original = run.ctx.connection.rpc.call, delayed = deferred(); let reads = 0;
  run.ctx.connection.rpc.call = async (...args) => {
    if (args[2].request?.action === 'status' && !args[2].request.operationId && ++reads === 1) return delayed.promise;
    return original(...args);
  };
  const configuring = run.flow.configure('source'); await settle();
  const sending = run.send(); await settle();
  const prepare = run.calls.find(call => call.endpoint === 'dsh-worktrees/prepare'); assert.ok(prepare);
  delayed.resolve(success({ ...status, remotes: [{ name: 'late-remote', identity: 'late' }], defaults: { remote: 'late-remote', branch: 'late-branch' } })); await configuring;
  assert.equal(prepare.payload.request.remote, 'upstream'); assert.equal(prepare.payload.request.remoteBranch, 'main');
  run.complete(); await sending; await settle(); await run.dispose();
});

test('Local retry after target refusal waits for source reupload before its native sink', async () => {
  const run = transaction({ attachments: ['file-one'], admission: 'refused', deferredSourceUpload: true }); run.select('new'); await run.send(); await settle();
  assert.equal(run.fileUploads.getSnapshot()['file-one'].status, 'uploading'); run.select('local'); const retry = run.send('local retry'); await settle();
  assert.equal(run.sourceAdmissions.length, 0); run.uploaded(); await retry; assert.equal(run.sourceAdmissions.length, 1); await run.dispose();
});


test('worktree root page uses native owner form and exact plugin-row key without custom storage or RPC', () => {
  assert.match(source, /name: 'plugins.row.config', key: 'dsh-worktrees#git-worktrees'.*RootFolderSettings/);
  const page = source.slice(source.indexOf('    function RootFolderSettings('), source.indexOf('    function Header('));
  assert.match(page, /view === 'summary'/);
  assert.match(page, /state\.writable && state\.mode === 'host'/);
  assert.match(page, /writeRootFolder\(form, draft, revision, reset\)/);
  assert.doesNotMatch(page, /requestHost|quietRPC|localStorage|JSON\.parse|fetch\(|textarea/);
});

test('root-folder edits persist only root through native revision-fenced mutation', async () => {
  const calls = [], state = { status: 'ready', writable: true, mode: 'host', revision: 17, value: { root: '/old/root', defaultRemote: 'upstream' } };
  const form = { state, async mutate(...args) { calls.push(args); return true; } };
  assert.equal(helpers.rootFolderValue(state), '/old/root');
  assert.equal(await helpers.writeRootFolder(form, '  /new/root with spaces  ', 17), '/new/root with spaces');
  assert.equal(calls.length, 1); assert.equal(calls[0][1], 17);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])), [{ op: 'set', path: ['root'], value: '/new/root with spaces' }]);
  assert.equal(state.value.defaultRemote, 'upstream'); assert.equal(state.value.root, '/old/root', 'native accepted snapshot owns its update; no optimistic mutation');
  await helpers.writeRootFolder(form, '', 17, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][0])), [{ op: 'unset', path: ['root'] }]);
});

test('invalid or unavailable root settings never dispatch a write', async () => {
  let writes = 0; const valid = { status: 'ready', writable: true, mode: 'host', revision: 1, value: { root: '/old' } };
  const mutate = async () => { ++writes; return true; };
  for (const draft of ['', ' ', 'relative/root', '/root\0bad', '/root\nbad', '/' + 'a'.repeat(4097)]) await assert.rejects(helpers.writeRootFolder({ state: valid, mutate }, draft, 1), error => error.kind === 'rootInvalid');
  for (const patch of [{ status: 'loading' }, { status: 'unavailable' }, { writable: false }, { mode: 'memory' }]) await assert.rejects(helpers.writeRootFolder({ state: { ...valid, ...patch }, mutate }, '/new', 1), error => error.kind === 'rootUnavailable');
  for (const revision of [undefined, -1, 1.5, Infinity]) await assert.rejects(helpers.writeRootFolder({ state: valid, mutate }, '/new', revision), error => error.kind === 'rootUnavailable');
  assert.equal(writes, 0);
});

test('native root-write conflicts and transport failures preserve the original draft and accepted values', async () => {
  const state = { status: 'ready', writable: true, mode: 'host', revision: 2, value: { root: '/accepted' } };
  const draft = '/typed/root'; let expected;
  await assert.rejects(helpers.writeRootFolder({ state, async mutate(_ops, revision) { expected = revision; return false; } }, draft, 1), error => error.kind === 'rootConflict');
  assert.equal(expected, 1, 'editing revision is retained even after another editor updates the page owner');
  assert.equal(draft, '/typed/root'); assert.equal(state.value.root, '/accepted');
  await assert.rejects(helpers.writeRootFolder({ state, async mutate() { throw Error('offline'); } }, draft, 2), /offline/);
  assert.equal(state.value.root, '/accepted');
});
