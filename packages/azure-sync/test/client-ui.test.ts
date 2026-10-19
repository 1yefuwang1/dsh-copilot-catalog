import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import type { CloudClient, CloudLocalView, CloudRequest, CloudSettingsView } from '../client-model.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const dictionary = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8')).ui as Record<string, string>;
const text = (key: string) => dictionary[key]!;
const envelope = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
function store<T>(initial: T) { let value = initial; const listeners = new Set<() => void>(); return { getSnapshot: () => value, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }, publish(next: T) { value = next; for (const fn of [...listeners]) fn(); }, get listeners() { return listeners.size; } }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settingsBase: CloudSettingsView = { auth: 'auto', accountName: '', managedIdentityClientId: '', connectionRef: 'AZURE_SYNC_CONNECTION_STRING', container: 'sessions', table: 'sessions', endpointSuffix: 'core.windows.net', defaultEnabled: false, pullOnStartup: true, pollSeconds: 60, authPending: false, connection: { configured: false, writable: true } };
function local(sessionId: string, patch: Partial<CloudLocalView> = {}): CloudLocalView { return { sessionId, enabled: true, state: 'active', status: 'synced', generation: 1, detached: false, admissionRequired: true, admissionStopped: false, restartRequired: false, needsFolder: false, mappingUnstable: false, degradedAttachmentCount: 0, degradedAcknowledged: false, hasConflictBackup: false, ...patch }; }
interface Call { route: string; endpoint: string; request: CloudRequest; signal?: AbortSignal }
interface Slot { options: { name: string; key?: string; id?: string; locale?: string; inject?: () => object }; component: React.ComponentType<any> }
interface Definition { id: string; factory(require: (name: string) => unknown): { inject: string[]; apply(ctx: any): void } }

/** Exercise the actual bundled factory/model through public SDK service faces only. */
function fixture(options: { blank?: boolean; settings?: CloudSettingsView; status?: CloudLocalView; pickDirectory?: () => Promise<string | null>; reply?: (call: Call) => unknown | Promise<unknown> } = {}) {
  let definition!: Definition;
  const register = vm.runInThisContext(`(function(window) { ${source}\n})`, { filename: 'azure-sync-client.js' }) as (window: unknown) => void;
  register({ __ModuleLoader__: { load(value: Definition) { definition = value; } } });
  const required: string[] = [], plugin = definition.factory(name => { required.push(name); assert.equal(name, 'react'); return React; });
  const slots: Slot[] = [], disposers: (() => unknown)[] = [], calls: Call[] = [], opened: string[] = [], panels: (string | null)[] = [];
  const slotListeners = new Map<string, Set<() => void>>();
  const notifySlots = (name: string) => { for (const fn of [...(slotListeners.get(name) ?? [])]) fn(); };
  const sessions = store({ byId: { selected: { retainedBy: { mainView: 1 }, origin: 'native', blank: options.blank ?? false } } } as { byId: Record<string, { retainedBy: { mainView: number }; origin: string; blank?: boolean }> });
  const connection = store<{ id: number } | undefined>({ id: 1 }), blocks = new Map<string, ReturnType<typeof store<{ reason: string } | undefined>>>();
  let settings = structuredClone(options.settings ?? settingsBase), refreshes = 0, currentStatus = options.status;
  const blockFor = (id: string) => { let value = blocks.get(id); if (!value) { value = store<{ reason: string } | undefined>(undefined); blocks.set(id, value); } return value; };
  const ctx = {
    effect(factory: () => () => unknown) { const dispose = factory(); disposers.push(dispose); return dispose; },
    locale: { register(namespace: string, dictionaries: { en: Record<string, string> }) { assert.equal(namespace, 'azureSync.ui'); assert.deepEqual(dictionaries.en, dictionary); return () => undefined; }, bind: () => text },
    connection: { generation: connection, rpc: { async call(route: string, endpoint: string, payload: { v: number; request: CloudRequest }, signal?: AbortSignal) {
      assert.equal(route, '/api'); assert.equal(payload.v, 1); assert.deepEqual(Object.keys(payload).sort(), ['request', 'v']);
      assert.equal(endpoint, payload.request.action === 'status' || payload.request.action === 'mappings' ? 'azure-sync/status' : 'azure-sync/action');
      const call = { route, endpoint, request: structuredClone(payload.request), signal }; calls.push(call);
      if (options.reply) { const answer = await options.reply(call); if (answer !== undefined) return answer; }
      const request = payload.request;
      if (request.action === 'status') return envelope({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings, items: currentStatus && (!request.sessionId || currentStatus.sessionId === request.sessionId) ? [currentStatus] : [], ...(request.sessionId && (!currentStatus || currentStatus.sessionId !== request.sessionId) ? { untracked: { sessionId: request.sessionId, enabled: false, admissionRequired: false } } : {}) });
      if (request.action === 'git-info') return envelope({ kind: 'git', sessionId: request.sessionId, local: null });
      if (request.action === 'mappings') return envelope({ kind: 'mappings', items: [] });
      if (request.action === 'set-auth') { settings = { ...settings, auth: request.auth, accountName: request.accountName ?? '', managedIdentityClientId: request.managedIdentityClientId ?? '', connection: { configured: Boolean(request.connectionString) && !request.clearConnectionString, writable: true } }; return envelope({ kind: 'settings', settings }); }
      if (request.action === 'set-defaults') { settings = { ...settings, defaultEnabled: false, pullOnStartup: request.pullOnStartup ?? settings.pullOnStartup, pollSeconds: request.pollSeconds ?? settings.pollSeconds }; return envelope({ kind: 'settings', settings }); }
      if (request.action === 'test-auth') return envelope({ kind: 'auth-test', configured: true });
      if (request.action === 'pull' && !request.sessionId) return envelope({ kind: 'remote', items: [] });
      if (request.action === 'map') return envelope({ kind: 'mapping', mapping: { ...request.mapping, id: request.mapping.id ?? '12345678-1234-4234-8234-123456789abc', revision: 'b'.repeat(64) } });
      if (request.action === 'unmap') return envelope({ kind: 'mapping-removed', mappingId: request.mappingId });
      const id = 'sessionId' in request ? request.sessionId! : 'selected';
      if (request.action === 'toggle') currentStatus = local(id, { enabled: request.enabled, ...(request.enabled ? {} : { admissionRequired: false, detached: true, state: 'disabled', status: 'detached' }) });
      if (request.action === 'detach') currentStatus = local(id, { enabled: false, admissionRequired: false, detached: true, status: 'detached' });
      return envelope({ kind: 'action', action: request.action, sessionId: id, state: currentStatus?.status ?? 'synced', ...(request.action === 'check-ownership' ? { detail: { owned: true } } : request.action === 'toggle' && request.enabled ? { detail: { status: 'synced', eventCount: 0, uploadedBatches: 0 } } : request.action === 'export' ? { detail: { exportPath: '/safe/export.jsonl' } } : {}) });
    } } },
    sessions: { list: sessions, async refresh() { refreshes++; } },
    conversation: { blocks: { storeFor: blockFor, set(id: string, block: { reason: string } | undefined) { const target = blockFor(id); if (target.getSnapshot()?.reason === block?.reason) return; target.publish(block && Object.freeze(block)); } } },
    uiWorkspace: { openSession(id: string) { opened.push(id); }, ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}) }, layout: { selectPanel(id: string | null) { panels.push(id); } },
    slots: { inject(_name: string, factory: () => () => void) { const dispose = factory(); disposers.push(dispose); return dispose; },
      entries(name: string) { return slots.filter(slot => slot.options.name === name).map(slot => ({ inject: slot.options.inject })); },
      subscribe(name: string, fn: () => void) { let listeners = slotListeners.get(name); if (!listeners) { listeners = new Set(); slotListeners.set(name, listeners); } listeners.add(fn); return () => { listeners.delete(fn); }; },
      register(slotOptions: Slot['options'], component: Slot['component']) { const slot = { options: slotOptions, component }; slots.push(slot); notifySlots(slotOptions.name); return () => { const index = slots.indexOf(slot); if (index >= 0) { slots.splice(index, 1); notifySlots(slotOptions.name); } }; } },
  };
  plugin.apply(ctx);
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  let cloud!: CloudClient;
  async function render(name = options.blank ? 'conversation.hero.options' : 'conversation.session.header.actions', props: object = {}) {
    const slot = slots.find(value => value.options.name === name)!; assert.ok(slot, name);
    const injected = slot.options.inject?.() as { cloud: CloudClient }; cloud = injected.cloud;
    await act(async () => { root.render(React.createElement(slot.component, { ...injected, t: text, sessionId: 'selected', ...props })); });
  }
  async function dispose() { await act(async () => { root.unmount(); }); for (const dispose of [...disposers].reverse()) await dispose(); container.remove(); }
  return { definition, plugin, required, slots, calls, sessions, connection, blocks, blockFor, opened, panels, container, render, dispose, get cloud() { return cloud; }, get refreshes() { return refreshes; }, setStatus(value: CloudLocalView | undefined) { currentStatus = value; } };
}
function button(root: ParentNode, label: string) { const value = [...root.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label); assert.ok(value, `button ${label}`); return value as HTMLButtonElement; }
function input(root: ParentNode, label: string) { const value = [...root.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))?.querySelector('input,select'); assert.ok(value, `input ${label}`); return value as HTMLInputElement; }
async function click(node: HTMLElement) { await act(async () => { node.click(); }); }
async function change(node: HTMLInputElement, value: string) { await act(async () => { const prototype = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); }
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function dialog(run: ReturnType<typeof fixture>) { await click(button(run.container, text('details'))); return run.container.querySelector('[role=dialog]')!; }

for (const blank of [true, false]) test(`public header exposes cloud settings and toggle for ${blank ? 'blank' : 'nonblank'} native thread`, async () => {
  const run = fixture({ blank }); try {
    await run.render(); assert.equal(run.definition.id, '@1yefuwang1/dsh-azure-sync'); assert.deepEqual(run.required, ['react']);
    assert.equal(input(run.container, text('enabled')).checked, false);
    await click(button(run.container, text('settings'))); assert.deepEqual(run.panels, ['dsh-azure-sync']);
    await click(input(run.container, text('enabled'))); assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
    assert.match(run.container.querySelector('[role=dialog]')!.textContent!, /writers you trust/);
    await click(button(run.container, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'toggle')!.request, { action: 'toggle', sessionId: 'selected', enabled: true });
    assert.ok(run.slots.find(slot => slot.options.name === 'plugins.row.config' && slot.options.key === '@1yefuwang1/dsh-azure-sync#azure-sync'));
  } finally { await run.dispose(); }
});

test('main panel keeps exact-thread opt-in available after the conversation header unmounts', async () => {
  const run = fixture(); try {
    await run.render(); await run.render('main');
    assert.ok(run.container.querySelector('main')); assert.equal(input(run.container, text('enabled')).checked, false);
    await click(input(run.container, text('enabled')));
    assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
    const confirm = run.container.querySelector('[role=dialog]')!; assert.ok(confirm.textContent!.includes(text('onWarning')));
    await click(button(confirm, text('confirm')));
    assert.deepEqual(run.calls.filter(call => call.request.action === 'toggle').map(call => call.request), [{ action: 'toggle', sessionId: 'selected', enabled: true }]);
    assert.equal(run.cloud.getThread('selected').status?.enabled, true);
  } finally { await run.dispose(); }
});

test('blank corner is one compact action whose thread dialog has confirmed opt-in', async () => {
  const run = fixture({ blank: true }); try {
    await run.render('conversation.session.header.corner');
    assert.equal(run.container.querySelectorAll('button').length, 1); assert.equal(run.container.querySelectorAll('input').length, 0);
    const root = await dialog(run); await click(input(root, text('enabled')));
    assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
    const dialogs = run.container.querySelectorAll('[role=dialog]'); const confirm = dialogs[dialogs.length - 1]!;
    assert.ok(confirm.textContent!.includes(text('onWarning'))); await click(button(confirm, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'toggle')!.request, { action: 'toggle', sessionId: 'selected', enabled: true });
    await act(async () => { run.sessions.publish({ byId: { selected: { retainedBy: { mainView: 1 }, origin: 'native', blank: false } } }); });
    assert.equal(run.slots.some(slot => slot.options.name === 'conversation.session.header.corner'), false, 'nonblank does not reserve the singleton cell');
  } finally { await run.dispose(); }
});

test('non-native or ambiguous selection does not acquire or operate a header target', async () => {
  const run = fixture(); try {
    run.sessions.publish({ byId: { selected: { retainedBy: { mainView: 1 }, origin: 'subagent' } } }); await run.render(); assert.equal(run.container.textContent, ''); assert.equal(run.calls.length, 0);
    await act(async () => { run.sessions.publish({ byId: { selected: { retainedBy: { mainView: 1 }, origin: 'native' }, other: { retainedBy: { mainView: 1 }, origin: 'native' } } }); }); await run.render(); assert.equal(run.container.textContent, '');
  } finally { await run.dispose(); }
});

test('authentication is custom RPC-only, write-only, and clears secrets on submit, cancel and unmount', async () => {
  const gate = deferred<unknown>(); let secretWire: string | undefined;
  const run = fixture({ reply: call => { if (call.request.action === 'set-auth') { secretWire = call.request.connectionString; return gate.promise; } } });
  try {
    await run.render('plugins.row.config', { view: 'page', form: { mutate() { assert.fail('native form must not persist credentials'); } } });
    const password = input(run.container, text('credentialInput')); assert.equal(password.type, 'password'); assert.equal(password.value, ''); assert.equal(password.autocomplete, 'new-password');
    await change(input(run.container, text('auth')), 'connection-string'); await change(password, 'sensitive-credential-not-for-models');
    assert.equal(password.value, 'sensitive-credential-not-for-models'); assert.doesNotMatch(JSON.stringify(run.cloud.store.getSnapshot()), /sensitive-credential/);
    await click(button(run.container, text('saveAuth'))); assert.equal(secretWire, 'sensitive-credential-not-for-models'); assert.equal(password.value, '');
    const authSection = run.container.querySelector('section')!; await click(button(authSection, text('cancel')));
    assert.equal(run.calls.find(call => call.request.action === 'set-auth')!.signal!.aborted, true);
    gate.resolve(envelope({ kind: 'settings', settings: settingsBase })); await settle();
    await change(password, 'cancel-me'); await click(button(authSection, text('cancel'))); assert.equal(password.value, '');
    await change(password, 'unmount-me'); await run.render('conversation.session.header.actions'); assert.equal(password.value, '', 'layout cleanup clears the detached input too');
    assert.equal(dom.window.localStorage.length, 0); assert.doesNotMatch(JSON.stringify(run.cloud.store.getSnapshot()), /sensitive-credential|cancel-me|unmount-me/);
  } finally { gate.resolve(envelope({ kind: 'settings', settings: settingsBase })); await run.dispose(); }
});

test('credential source/presence, read-only admin fields and pending/uncertain recovery remain visible', async () => {
  const run = fixture({ settings: { ...settingsBase, authPending: true, pendingAuth: { auth: 'managed-identity', accountName: 'pendingaccount', managedIdentityClientId: 'pending-client' }, connection: { configured: true, writable: false, source: 'env', requiresUpdate: true } } });
  try {
    await run.render('plugins.row.config', { view: 'page' });
    assert.ok(input(run.container, text('credentialInput')).disabled); assert.ok(input(run.container, text('clearSecret')).disabled);
    assert.ok(!input(run.container, text('auth')).disabled); assert.match(run.container.textContent!, /pendingaccount|pending-client/);
    assert.ok(run.container.textContent!.includes(text('authPending'))); assert.ok(run.container.textContent!.includes(text('uncertain'))); assert.match(run.container.textContent!, /env/);
    for (const key of ['container', 'table', 'suffix', 'connectionRef']) assert.equal([...run.container.querySelectorAll('input')].some(node => node.getAttribute('aria-label') === text(key)), false);
    const defaultOff = input(run.container, text('defaultOff')); assert.equal(defaultOff.checked, false); assert.equal(defaultOff.disabled, true);
    await change(input(run.container, text('poll')), '30'); await click(button(run.container, text('savePrefs')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'set-defaults')!.request, { action: 'set-defaults', defaultEnabled: false, pullOnStartup: true, pollSeconds: 30 });
  } finally { await run.dispose(); }
});

test('remove requires attachment/root acknowledgement; takeover and resurrection each require explicit confirmation', async () => {
  const run = fixture({ status: local('selected') }); try {
    await run.render(); let root = await dialog(run);
    await click(button(root, text('remove'))); let dialogs = run.container.querySelectorAll('[role=dialog]'); let confirm = dialogs[dialogs.length - 1]!;
    assert.ok(confirm.textContent!.includes(text('removeWarning'))); assert.ok(button(confirm, text('confirm')).disabled);
    assert.equal(run.calls.some(call => call.request.action === 'remove'), false);
    await click(input(confirm, text('retainAck'))); await click(button(confirm, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'remove')!.request, { action: 'remove', sessionId: 'selected', confirm: true, acknowledgeAttachmentsRetained: true });
    root = run.container.querySelector('[role=dialog]')!;
    for (const action of ['takeover', 'resurrect'] as const) {
      await click(button(root, text(action))); dialogs = run.container.querySelectorAll('[role=dialog]'); confirm = dialogs[dialogs.length - 1]!;
      assert.ok(confirm.textContent!.includes(text(action + 'Warning'))); assert.equal(run.calls.some(call => call.request.action === action), false);
      await click(button(confirm, text('confirm'))); assert.deepEqual(run.calls.find(call => call.request.action === action)!.request, { action, sessionId: 'selected', confirm: true });
    }
  } finally { await run.dispose(); }
});

test('mapping edits require stop disclosure and reconfirmed repair never rewrites history', async () => {
  const run = fixture({ status: local('selected', { status: 'mapping-unstable', mappingUnstable: true }) }); try {
    await run.render('plugins.row.config', { view: 'page' });
    await change(input(run.container, text('remotePrefix')), '/remote/repo'); await change(input(run.container, text('localPrefix')), '/real/host/repo');
    await click(button(run.container, text('addMapping'))); assert.ok(run.container.querySelector('[role=dialog]')!.textContent!.includes(text('mappingWarning'))); assert.equal(run.calls.some(call => call.request.action === 'map'), false);
    await click(button(run.container.querySelector('[role=dialog]')!, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'map')!.request, { action: 'map', mapping: { remotePrefix: '/remote/repo', localPrefix: '/real/host/repo', remotePlatform: 'linux' } });
    await run.render(); const root = await dialog(run); await click(button(root, text('mappingRepair')));
    const dialogs = run.container.querySelectorAll('[role=dialog]'), confirm = dialogs[dialogs.length - 1]!; assert.ok(confirm.textContent!.includes(text('mappingRepairWarning')));
    await click(button(confirm, text('confirm'))); assert.deepEqual(run.calls.find(call => call.request.action === 'repair')!.request, { action: 'repair', sessionId: 'selected', confirmMapping: true });
  } finally { await run.dispose(); }
});

test('remote listing is paginated, opens no Agent, and imports only one explicitly confirmed verified thread', async () => {
  let imported = false;
  const item = (id: string) => ({ sessionId: id, generation: 1, state: 'active', enabled: true, eventCount: 2, updatedAt: 1, sourcePlatform: 'linux', rootSessionId: id, rootGeneration: 1, title: 'Remote ' + id, cwd: '/remote/repo', sourceDeviceId: 'other-device' });
  const run = fixture({ reply: call => {
    const request = call.request;
    if (request.action === 'pull' && !request.sessionId) return envelope({ kind: 'remote', items: [item(request.cursor ? 'remote-two' : 'remote-one')], ...(request.cursor ? {} : { nextCursor: 'next-page' }) });
    if (request.action === 'pull' && request.sessionId) { imported = true; return envelope({ kind: 'action', action: 'pull', sessionId: request.sessionId, state: 'synced' }); }
    if (request.action === 'status' && request.sessionId?.startsWith('remote-') && imported) return envelope({ kind: 'status', revision: 1, projectionRevision: 'b'.repeat(64), settings: settingsBase, items: [local(request.sessionId, { importState: 'complete' })] });
  } });
  try {
    await run.render('plugins.row.config', { view: 'page' }); await click(button(run.container, text('listRemote'))); assert.deepEqual(run.opened, []);
    assert.equal(run.calls.filter(call => call.request.action === 'pull' && call.request.sessionId).length, 0);
    await click(button(run.container, text('more'))); assert.ok(run.calls.some(call => call.request.action === 'pull' && call.request.cursor === 'next-page'));
    await click(button(run.container, text('import'))); assert.equal(imported, false); assert.match(run.container.querySelector('[role=dialog]')!.textContent!, /remote-two/);
    await click(button(run.container.querySelector('[role=dialog]')!, text('confirm')));
    assert.deepEqual(run.calls.filter(call => call.request.action === 'pull' && call.request.sessionId).map(call => call.request), [{ action: 'pull', sessionId: 'remote-two' }]);
    assert.deepEqual(run.opened, []); assert.ok(run.refreshes > 0); await click(button(run.container, text('open'))); assert.deepEqual(run.opened, ['remote-two']);
  } finally { await run.dispose(); }
});

test('unverified or incomplete cold import cannot offer opening a partial model runtime', async () => {
  const run = fixture({ reply: call => {
    const request = call.request;
    if (request.action === 'pull' && !request.sessionId) return envelope({ kind: 'remote', items: [{ sessionId: 'remote-one', generation: 1, state: 'active', enabled: true, eventCount: 2, updatedAt: 1, sourcePlatform: 'linux', rootSessionId: 'remote-one', rootGeneration: 1 }] });
    if (request.action === 'status' && request.sessionId === 'remote-one') return envelope({ kind: 'status', revision: 1, projectionRevision: 'c'.repeat(64), settings: settingsBase, items: [local('remote-one', { importState: 'failed', status: 'import-incomplete' })] });
  } });
  try {
    await run.render('plugins.row.config', { view: 'page' }); await click(button(run.container, text('listRemote'))); await click(button(run.container, text('import'))); await click(button(run.container.querySelector('[role=dialog]')!, text('confirm')));
    assert.equal([...run.container.querySelectorAll('button')].some(node => node.textContent === text('open')), false); assert.deepEqual(run.opened, []); assert.ok(run.container.textContent!.includes(text('incompleteWarning')));
  } finally { await run.dispose(); }
});

test('local off and detach preempt a hung action without clearing a foreign composer block', async () => {
  const gate = deferred<unknown>();
  const run = fixture({ status: local('selected'), reply: call => call.request.action === 'sync' ? gate.promise : undefined });
  try {
    const foreign = { reason: 'foreign-worktree-owner' }; run.blockFor('selected').publish(foreign);
    await run.render(); const root = await dialog(run); await click(button(root, text('sync')));
    const syncing = run.calls.find(call => call.request.action === 'sync')!; assert.equal(button(root, text('off')).disabled, false); assert.equal(button(root, text('detach')).disabled, false);
    await click(button(root, text('off'))); assert.equal(syncing.signal!.aborted, true); assert.ok(run.calls.some(call => call.request.action === 'toggle' && !call.request.enabled));
    assert.equal(run.blockFor('selected').getSnapshot(), foreign);
    await click(button(root, text('detach'))); const dialogs = run.container.querySelectorAll('[role=dialog]'); await click(button(dialogs[dialogs.length - 1]!, text('confirm')));
    assert.ok(run.calls.some(call => call.request.action === 'detach')); assert.equal(run.blockFor('selected').getSnapshot(), foreign);
    gate.resolve(envelope({ kind: 'action', action: 'sync', sessionId: 'selected', state: 'synced' })); await settle();
  } finally { gate.resolve(envelope({ kind: 'action', action: 'sync', sessionId: 'selected', state: 'synced' })); await run.dispose(); }
});

test('Host restart warning survives closing/reopening view; degraded acknowledgement is explicit and verified-only', async () => {
  const run = fixture({ status: local('selected', { status: 'remote-ahead-live', restartRequired: true }) }); try {
    await run.render(); let root = await dialog(run); assert.ok(root.textContent!.includes(text('liveWarning'))); await click(button(root, text('close')));
    root = await dialog(run); assert.ok(root.textContent!.includes(text('liveWarning'))); assert.equal(button(root, text('repair')).disabled, true);
    run.setStatus(local('selected', { status: 'degraded', importState: 'attachments', degradedAttachmentCount: 2 })); await act(async () => { await run.cloud.refresh('selected'); });
    assert.equal([...root.querySelectorAll('button')].some(node => node.textContent === text('ackDegraded')), false);
    run.setStatus(local('selected', { status: 'import-incomplete', importState: 'degraded', degradedAttachmentCount: 2 })); await act(async () => { await run.cloud.refresh('selected'); }); assert.equal([...root.querySelectorAll('button')].some(node => node.textContent === text('ackDegraded')), false);
    run.setStatus(local('selected', { status: 'degraded', importState: 'degraded', degradedAttachmentCount: 2 })); await act(async () => { await run.cloud.refresh('selected'); });
    assert.ok(root.textContent!.includes(text('degradedWarning'))); assert.equal(run.calls.some(call => call.request.action === 'acknowledge-degraded'), false);
    await click(button(root, text('ackDegraded'))); assert.ok(run.calls.some(call => call.request.action === 'acknowledge-degraded'));
  } finally { await run.dispose(); }
});

test('late RPC after selected-session change cannot open a target or render stale errors; cleanup aborts view flights', async () => {
  const gate = deferred<unknown>(); const run = fixture({ status: local('selected'), reply: call => call.request.action === 'export' ? gate.promise : undefined });
  try {
    await run.render(); const root = await dialog(run); await click(button(root, text('export'))); const exporting = run.calls.find(call => call.request.action === 'export')!;
    await act(async () => { run.sessions.publish({ byId: { other: { retainedBy: { mainView: 1 }, origin: 'native' } } }); }); await run.render('conversation.session.header.actions', { sessionId: 'other' });
    assert.equal(exporting.signal!.aborted, true); gate.resolve(envelope({ kind: 'action', action: 'export', sessionId: 'selected', state: 'synced', detail: { exportPath: '/late/secret-path' } })); await settle();
    assert.doesNotMatch(run.container.textContent!, /late\/secret-path/); assert.deepEqual(run.opened, []); assert.equal(run.container.querySelector('[role=alert]'), null);
  } finally { gate.resolve(envelope({ kind: 'action', action: 'export', sessionId: 'selected', state: 'synced' })); await run.dispose(); }
  assert.equal(run.connection.listeners, 0); assert.ok([...run.blocks.values()].every(block => block.getSnapshot() === undefined));
});

test('mapping list edit/remove and public directory picker suppress late paths after manual edits', async () => {
  const picker = deferred<string | null>(), id = '12345678-1234-4234-8234-123456789abc';
  let mappings = [{ id, remotePrefix: '/old/remote', localPrefix: '/old/local', remotePlatform: 'linux', revision: 'b'.repeat(64) }];
  const run = fixture({ pickDirectory: () => picker.promise, reply: call => {
    const request = call.request;
    if (request.action === 'mappings') return envelope({ kind: 'mappings', items: mappings });
    if (request.action === 'map') { mappings = [{ id, ...request.mapping, revision: 'c'.repeat(64) }]; return envelope({ kind: 'mapping', mapping: mappings[0] }); }
    if (request.action === 'unmap') { mappings = []; return envelope({ kind: 'mapping-removed', mappingId: id }); }
  } });
  try {
    await run.render('plugins.row.config', { view: 'page' }); await click(button(run.container, text('editMapping')));
    assert.equal(input(run.container, text('localPrefix')).value, '/old/local'); await click(button(run.container, text('chooseFolder')));
    await change(input(run.container, text('localPrefix')), '/manual/host'); picker.resolve('/late/picker'); await settle(); assert.equal(input(run.container, text('localPrefix')).value, '/manual/host');
    const mappingSection = [...run.container.querySelectorAll('section')].find(node => node.getAttribute('aria-label') === text('mappings'))!;
    const save = [...mappingSection.querySelectorAll('button')].find(node => node.type === 'submit')!; await click(save); await click(button(run.container.querySelector('[role=dialog]')!, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'map')!.request, { action: 'map', mapping: { id, remotePrefix: '/old/remote', localPrefix: '/manual/host', remotePlatform: 'linux' } });
    await click(button(mappingSection, text('removeMapping'))); assert.equal(run.calls.some(call => call.request.action === 'unmap'), false); await click(button(run.container.querySelector('[role=dialog]')!, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'unmap')!.request, { action: 'unmap', mappingId: id }); assert.ok(mappingSection.textContent!.includes(text('emptyMappings')));
  } finally { picker.resolve(null); await run.dispose(); }
});

test('unknown status blocks conservatively while settings, local off and detach stay reachable', async () => {
  const gate = deferred<unknown>(); const run = fixture({ reply: call => call.request.action === 'status' && call.request.sessionId === 'selected' ? gate.promise : undefined });
  try {
    await run.render(); assert.ok(run.blockFor('selected').getSnapshot()); assert.equal(button(run.container, text('settings')).disabled, false);
    const root = await dialog(run); assert.equal(button(root, text('off')).disabled, false); assert.equal(button(root, text('detach')).disabled, false);
    const status = run.calls.find(call => call.request.action === 'status')!; await run.render('plugins.row.config', { view: 'summary' }); assert.equal(status.signal!.aborted, true); assert.equal(run.blockFor('selected').getSnapshot(), undefined);
    gate.resolve(envelope({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings: settingsBase, items: [], untracked: { sessionId: 'selected', enabled: false, admissionRequired: false } })); await settle();
  } finally { gate.resolve(envelope({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings: settingsBase, items: [], untracked: { sessionId: 'selected', enabled: false, admissionRequired: false } })); await run.dispose(); }
});

test('credential clearing is explicit RPC and arbitrary provider failures never render credential text', async () => {
  const run = fixture({ settings: { ...settingsBase, connection: { configured: true, writable: true, source: 'provider' } }, reply: call => { if (call.request.action === 'set-auth') throw new Error('private-provider-credential-value'); } });
  try {
    await run.render('plugins.row.config', { view: 'page' }); await click(input(run.container, text('clearSecret'))); assert.equal(input(run.container, text('credentialInput')).disabled, true);
    await click(button(run.container, text('saveAuth'))); assert.deepEqual(run.calls.find(call => call.request.action === 'set-auth')!.request, { action: 'set-auth', auth: 'auto', accountName: '', managedIdentityClientId: '', clearConnectionString: true });
    assert.doesNotMatch(run.container.textContent!, /private-provider-credential-value/); assert.ok(run.container.querySelector('[role=alert]')); assert.doesNotMatch(JSON.stringify(run.cloud.store.getSnapshot()), /private-provider-credential-value/);
    await click(input(run.container, text('clearSecret'))); const password = input(run.container, text('credentialInput')); await change(password, 'unsent-during-disconnect'); await act(async () => { run.connection.publish(undefined); }); assert.equal(password.value, '', 'connection abort also clears an unsent credential');
  } finally { await run.dispose(); }
});

test('confirmation dialogs have accessible titles and keyboard focus stays within the innermost dialog', async () => {
  const run = fixture({ status: local('selected') }); try {
    await run.render(); const root = await dialog(run); await click(button(root, text('remove'))); const dialogs = run.container.querySelectorAll('[role=dialog]'), confirm = dialogs[dialogs.length - 1]!;
    const titleId = confirm.getAttribute('aria-labelledby')!; assert.ok(confirm.querySelector(`[id="${titleId}"]`)); assert.equal(confirm.getAttribute('aria-modal'), 'true');
    const first = button(confirm, text('close')), last = button(confirm, text('cancel')); last.focus();
    await act(async () => { last.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); }); assert.equal(document.activeElement, first);
    await act(async () => { first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); assert.equal(run.container.querySelectorAll('[role=dialog]').length, 1);
    assert.equal(run.calls.some(call => call.request.action === 'remove'), false);
  } finally { await run.dispose(); }
});

test('connection-generation change clears credentials, confirmations and ignores old Host RPC completion', async () => {
  const gate = deferred<unknown>(); const run = fixture({ reply: call => call.request.action === 'set-auth' ? gate.promise : undefined });
  try {
    await run.render('plugins.row.config', { view: 'page' }); const password = input(run.container, text('credentialInput')); await change(password, 'host-one-only-secret'); await click(button(run.container, text('saveAuth')));
    const request = run.calls.find(call => call.request.action === 'set-auth')!;
    await act(async () => { run.connection.publish({ id: 2 }); }); assert.equal(request.signal!.aborted, true); assert.equal(password.value, ''); assert.equal(input(run.container, text('credentialInput')).value, '');
    gate.resolve(envelope({ kind: 'settings', settings: { ...settingsBase, accountName: 'oldhostaccount' } })); await settle();
    assert.notEqual(run.cloud.store.getSnapshot().settings?.accountName, 'oldhostaccount'); assert.doesNotMatch(run.container.textContent!, /oldhostaccount|host-one-only-secret/); assert.equal(run.container.querySelector('[role=alert]'), null);
    await run.render(); await click(input(run.container, text('enabled'))); assert.ok(run.container.querySelector('[role=dialog]'));
    await act(async () => { run.connection.publish({ id: 3 }); }); assert.equal(run.container.querySelector('[role=dialog]'), null); assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
  } finally { gate.resolve(envelope({ kind: 'settings', settings: settingsBase })); await run.dispose(); }
});

test('explicit Open rechecks import completeness and cannot reuse an import receipt across cloud generations', async () => {
  let generation = 1, complete = true;
  const run = fixture({ reply: call => {
    const request = call.request;
    if (request.action === 'pull' && !request.sessionId) return envelope({ kind: 'remote', items: [{ sessionId: 'remote-one', generation, state: 'active', enabled: true, eventCount: 2, updatedAt: 1, sourcePlatform: 'linux', rootSessionId: 'remote-one', rootGeneration: generation }] });
    if (request.action === 'status' && request.sessionId === 'remote-one') return envelope({ kind: 'status', revision: 1, projectionRevision: 'd'.repeat(64), settings: settingsBase, items: [local('remote-one', { generation, importState: complete ? 'complete' : 'failed', status: complete ? 'synced' : 'import-incomplete' })] });
  } });
  try {
    await run.render('plugins.row.config', { view: 'page' }); await click(button(run.container, text('listRemote'))); await click(button(run.container, text('import'))); await click(button(run.container.querySelector('[role=dialog]')!, text('confirm'))); assert.ok(button(run.container, text('open')));
    complete = false; await click(button(run.container, text('open'))); assert.deepEqual(run.opened, []); assert.ok(run.container.textContent!.includes(text('incompleteWarning')));
    complete = true; generation = 2; await click(button(run.container, text('listRemote'))); assert.equal([...run.container.querySelectorAll('button')].some(node => node.textContent === text('open')), false);
    assert.equal(run.calls.filter(call => call.request.action === 'pull' && call.request.sessionId).length, 1, 'new generation is never automatically imported');
  } finally { await run.dispose(); }
});

for (const detached of [false, true]) test(`initial partial import keeps repair available while cloud is off${detached ? ' and detached' : ''}`, async () => {
  const run = fixture({ status: local('selected', { generation: 2, enabled: false, detached, state: 'disabled', admissionRequired: false, importState: 'planned', status: 'needs-folder', needsFolder: true }) });
  try {
    await run.render(); assert.equal(input(run.container, text('enabled')).checked, false); assert.equal(input(run.container, text('enabled')).disabled, true);
    const root = await dialog(run); assert.ok(root.textContent!.includes(text('folderWarning'))); assert.ok(root.textContent!.includes(text('incompleteWarning'))); assert.equal(button(root, text('mappingRepair')).disabled, false); assert.equal(button(root, text('off')).disabled, false);
    await click(button(root, text('detach'))); let dialogs = run.container.querySelectorAll('[role=dialog]'); let confirm = dialogs[dialogs.length - 1]!; assert.ok(confirm.textContent!.includes(text('detachIncompleteWarning'))); await click(button(confirm, text('cancel')));
    await click(button(root, text('mappingRepair'))); dialogs = run.container.querySelectorAll('[role=dialog]'); confirm = dialogs[dialogs.length - 1]!; await click(button(confirm, text('confirm')));
    assert.deepEqual(run.calls.find(call => call.request.action === 'repair')!.request, { action: 'repair', sessionId: 'selected', confirmMapping: true }); assert.equal(run.calls.some(call => call.request.action === 'toggle' && call.request.enabled), false);
    run.setStatus(local('selected', { generation: 2, enabled: false, detached, state: 'disabled', admissionRequired: false, importState: 'complete', status: 'detached' })); await act(async () => { await run.cloud.refresh('selected'); }); assert.equal(input(run.container, text('enabled')).checked, false); assert.equal(input(run.container, text('enabled')).disabled, false);
  } finally { await run.dispose(); }
});

test('projection-only degraded import can be explicitly acknowledged after Off without cloud activation', async () => {
  let view = local('selected', { importState: 'degraded', status: 'projection-warm-partial' });
  const run = fixture({ status: view, reply: call => {
    const request = call.request;
    if (request.action === 'toggle' && !request.enabled) {
      view = { ...view, enabled: false, detached: true, state: 'disabled', admissionRequired: false, status: 'detached' }; run.setStatus(view);
      return envelope({ kind: 'action', action: 'toggle', sessionId: 'selected', state: view.status });
    }
    if (request.action === 'acknowledge-degraded') {
      view = { ...view, degradedAcknowledged: true }; run.setStatus(view);
      return envelope({ kind: 'action', action: request.action, sessionId: 'selected', state: view.status });
    }
  } });
  try {
    await run.render(); const root = await dialog(run);
    assert.ok(root.textContent!.includes(text('projectionDegradedWarning'))); assert.equal(run.cloud.getThread('selected').blocked, true);
    await click(button(root, text('off')));
    assert.equal(input(run.container, text('enabled')).checked, false); assert.equal(input(run.container, text('enabled')).disabled, true);
    assert.ok(root.textContent!.includes(text('projectionDegradedWarning')));
    await click(button(root, text('ackProjection')));
    assert.deepEqual(run.calls.filter(call => call.request.action === 'acknowledge-degraded').map(call => call.request), [{ action: 'acknowledge-degraded', sessionId: 'selected' }]);
    assert.equal(run.cloud.getThread('selected').phase, 'local'); assert.equal(run.cloud.getThread('selected').flags.importComplete, true);
    assert.equal(input(run.container, text('enabled')).checked, false); assert.equal(input(run.container, text('enabled')).disabled, false);
    assert.equal(run.calls.some(call => call.request.action === 'check-ownership' || (call.request.action === 'toggle' && call.request.enabled)), false);
  } finally { await run.dispose(); }
});

test('Git advice is explicit local inspection, escaped text and ref-only shell guidance; never opt-in or model actions', async () => {
  const run = fixture({ reply: call => call.request.action === 'git-info' ? envelope({ kind: 'git', sessionId: 'selected', local: { v: 1, root: "/local/'quoted' <folder>", branch: 'main', commit: 'a'.repeat(40), detached: false, unborn: false, worktree: true, dirty: 'unknown', remote: 'https://example.invalid/repo' } }) : undefined });
  try {
    await run.render(); const root = await dialog(run);
    assert.equal(run.calls.some(call => call.request.action === 'git-info'), false);
    assert.ok(root.textContent!.includes(text('gitWarning')));
    await click(button(root, text('gitInspect')));
    assert.deepEqual(run.calls.filter(call => call.request.action === 'git-info').map(call => call.request), [{ action: 'git-info', sessionId: 'selected' }]);
    assert.ok(root.textContent!.includes(text('git.unknown'))); assert.ok(root.textContent!.includes(text('gitConservative'))); assert.ok(root.textContent!.includes("/local/'quoted' <folder>"));
    assert.equal(root.querySelector('folder'), null); const commands = [...root.querySelectorAll('pre')].map(node => node.textContent!); assert.equal(commands.length, 2);
    assert.ok(commands.every(command => command.includes('rev-parse') && command.includes('--no-optional-locks')));
    assert.equal(run.calls.some(call => ['toggle', 'takeover', 'sync'].includes(call.request.action)), false);
  } finally { await run.dispose(); }
});

test('bundle has no private Host, model prompt, direct transport or secret persistence bypass', () => {
  assert.doesNotMatch(source, /resolveAgent|session\.prompt|commands\.execute|localStorage|sessionStorage|console\.(?:log|debug|warn|error)|XMLHttpRequest|fetch\(/);
  assert.doesNotMatch(source, /node:|from ["']@azure|open\(["']write|dangerouslySetInnerHTML|MutationObserver|\.prototype\.(?:click|submit)\s*=/);
  assert.ok(source.includes('conversation.session.header.actions')); assert.ok(source.includes('plugins.row.config'));
});
