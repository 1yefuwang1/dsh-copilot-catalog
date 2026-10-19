import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as Cordis from '@deepseek-ai/cordis';
import * as Store from '@deepseek-ai/dsh-client-store';
import * as Slots from '@deepseek-ai/dsh-client-ui-slots';
import * as React from 'react';
import * as JSX from 'react/jsx-runtime';
import * as Zod from 'zod';
import { JSDOM } from 'jsdom';
import { createComposerBlockOwner } from '../client-blocks.js';
import type { CloudClient, CloudLocalView, CloudRequest } from '../client-model.js';
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ScopedStandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots';

/** The published test-runtime root imports unshipped /src/* modules and vitest.
 * Instead this bench mounts ONLY exported production browser factories through
 * their actual ModuleLoader carrier: Cordis + renderer + locale + conversation.
 * Domain session/transport ports are explicit fixtures; stock presentation atoms
 * are unused CSS-heavy dependencies, not substituted authority/store machinery.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
const ReactDOM = await import('react-dom');
const ReactClient = await import('react-dom/client');
const SID = 'selected' as SessionId; // Test fixture identity, not arbitrary user input.
const HEADER = 'conversation.session.header.actions';
const CORNER = 'conversation.session.header.corner';
const HERO = 'conversation.hero.options';
const sessionLifecycle: SessionSnapshot = { sessionId: SID, pendingSubmissions: [], running: false, subagent: null, removed: false, openState: 'open', openError: null, hasMore: false, loadingOlder: false, promptError: null, blank: true, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false };
const NS = 'azureSync.ui';
const ownBundle = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8')).ui as Record<string, string>;
const settings = { auth: 'auto', accountName: '', managedIdentityClientId: '', connectionRef: 'AZURE_SYNC_CONNECTION_STRING', container: 'dsh-state', table: 'dshstatesync', endpointSuffix: 'core.windows.net', defaultEnabled: false, pullOnStartup: true, pollSeconds: 60, authPending: false, connection: { configured: false, writable: true } };
const success = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
interface BrowserDefinition { id: string; factory(require: (id: string) => unknown): unknown }
const dependencies: Record<string, unknown> = { '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': Store, '@deepseek-ai/dsh-client-ui-slots': Slots, react: React, 'react/jsx-runtime': JSX, 'react-dom': ReactDOM, 'react-dom/client': ReactClient, zod: Zod,
  // No stock conversation/settings component is rendered in these tests. All
  // block, context, registry, locale, scope binding and renderer code is REAL.
  '@deepseek-ai/dsh-client-ui-primitives': Object.freeze({}),
};
function capture<M>(source: string): { id: string; module: M } {
  let definition!: BrowserDefinition;
  const run = vm.runInThisContext(`(function(window){${source}\n})`) as (window: unknown) => void;
  run({ __ModuleLoader__: { load(value: BrowserDefinition) { definition = value; } } });
  const module = definition.factory(id => { assert.ok(Object.hasOwn(dependencies, id), `explicit public SDK dependency: ${id}`); return dependencies[id]; }) as M;
  return { id: definition.id, module };
}
async function publicClient<M>(specifier: string): Promise<M> {
  const captured = capture<M>(await readFile(new URL(import.meta.resolve(specifier)), 'utf8'));
  assert.equal(captured.id, specifier.replace(/\/client$/u, ''));
  return captured.module;
}
const renderer = await publicClient<typeof import('@deepseek-ai/dsh-client-ui-renderer/client')>('@deepseek-ai/dsh-client-ui-renderer/client');
const localeModule = await publicClient<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale/client');
const conversationModule = await publicClient<typeof import('@deepseek-ai/dsh-client-ui-conversation/client')>('@deepseek-ai/dsh-client-ui-conversation/client');

interface Call { request: CloudRequest; signal?: AbortSignal }
async function bench({ blank = false, hangStatus = false, nativeVisibility = false, panel = false } = {}) {
  const ctx = new Cordis.Context(), calls: Call[] = [], opened: string[] = [];
  const rendererFiber = ctx.plugin(renderer); await rendererFiber.await();
  const slots: SlotRegistry = ctx.slots;
  const locale: LocaleRuntime = new localeModule.LocaleRuntime(ctx); ctx.provide('locale', locale); slots.installLocale(locale);
  const list = Store.createSnapshotStore({ byId: { [SID]: { id: SID, blank, origin: 'native', retainedBy: { mainView: 1 } } } });
  const generation = Store.createSnapshotStore<{ id: number } | undefined>({ id: 1 });
  const pending = deferred<unknown>();
  let status: CloudLocalView | undefined, statusWaiting = hangStatus;
  void pending.promise.then(() => { statusWaiting = false; });
  ctx.provide('sessions', { list, refresh: async () => undefined, binding: () => undefined });
  ctx.provide('uiWorkspace', { openSession: (id: string) => { opened.push(id); } });
  ctx.provide('layout', { selectPanel: () => undefined });
  ctx.provide('fileUpload', { upload: async () => { throw new Error('file upload is not exercised'); } });
  ctx.provide('configForms', { get: () => undefined, developerTools: { enabled: Store.createSnapshotStore(false) } });
  ctx.provide('uiSession', { provide: () => () => undefined });
  ctx.provide('connection', { generation, rpc: { call: async (route: string, endpoint: string, payload: { v: number; request: CloudRequest }, signal?: AbortSignal) => {
    assert.equal(route, '/api'); assert.equal(payload.v, 1); assert.equal(endpoint, payload.request.action === 'status' || payload.request.action === 'mappings' ? 'azure-sync/status' : 'azure-sync/action');
    calls.push({ request: payload.request, signal });
    if (payload.request.action === 'status') {
      if (statusWaiting) return pending.promise;
      return success({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings, items: status ? [status] : [], ...(payload.request.sessionId && !status ? { untracked: { sessionId: payload.request.sessionId, enabled: false, admissionRequired: false } } : {}) });
    }
    if (payload.request.action === 'toggle') {
      const { sessionId, enabled } = payload.request; assert.equal(sessionId, SID);
      status = { sessionId: SID, enabled, state: enabled ? 'active' : 'disabled', status: enabled ? 'synced' : 'detached', generation: 1, detached: !enabled, admissionRequired: enabled, admissionStopped: false, restartRequired: false, needsFolder: false, mappingUnstable: false, degradedAttachmentCount: 0, degradedAcknowledged: false, hasConflictBackup: false };
      return success({ kind: 'action', action: 'toggle', sessionId: SID, state: status.status, ...(enabled ? { detail: { status: 'synced', eventCount: 0, uploadedBatches: 0 } } : {}) });
    }
    if (payload.request.action === 'check-ownership') return success({ kind: 'action', action: 'check-ownership', sessionId: SID, state: status?.status ?? 'setup-needed', detail: { owned: status?.enabled === true } });
    if (payload.request.action === 'mappings') return success({ kind: 'mappings', items: [] });
    throw new Error('unexpected cloud action in SDK registration bench');
  } } });
  const stock = ctx.plugin(conversationModule); await stock.await();
  await new Promise<void>(resolve => { ctx.inject(['conversation'], () => { resolve(); }); });
  const blocks: ComposerBlocks = ctx.conversation.blocks;
  const binding: ScopedStandardSourceBinding = { key: SID, ctx: ctx.extend(), hooks: {}, keyedHooks: {}, props: { sessionId: SID } };
  const current = Store.createSnapshotStore(binding);
  slots.installScope('session', { current, bindingSource: () => current, renderArea: (_binding, props) => props.children });
  const count = Store.createSnapshotStore(1);
  let releaseRoot: (() => unknown) | undefined;
  function declareHeader() {
    if (panel) releaseRoot = slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, function PanelFrame({ renderSlot }) {
      return renderSlot('main', {}, { entryKey: 'dsh-azure-sync' });
    });
    else if (nativeVisibility) releaseRoot = slots.register({ name: 'root', children: { [HEADER]: { kind: 'list', scope: 'session' }, [CORNER]: { kind: 'single', scope: 'session' }, [HERO]: { kind: 'list', scope: 'session' } } }, function NativeVisibilityFrame({ renderSlot }) {
      const snapshot = React.useSyncExternalStore(list.subscribe, list.getSnapshot);
      const currentSession = snapshot.byId[SID]; assert.ok(currentSession);
      const session = { ...sessionLifecycle, blank: currentSession.blank };
      const phase = conversationModule.conversationPhase(session, conversationModule.EMPTY_CONVERSATION_SNAPSHOT);
      // This is the pinned native chrome VISIBILITY fixture, not a replacement
      // claim to render the full stock ConversationContent/composer tree. Stock
      // ConversationHeader passes hideChrome and SessionHeader omits actions;
      // the corner stays mounted and the blank content shows hero.options.
      const hideChrome = session.blank && phase === 'blank';
      return React.createElement(React.Fragment, null,
        !hideChrome && React.createElement('div', { 'data-native-actions': '' }, renderSlot(HEADER, {})),
        React.createElement('div', { 'data-native-corner': '' }, renderSlot(CORNER, {})),
        hideChrome && React.createElement('div', { 'data-native-hero': '' }, renderSlot(HERO, {})));
    });
    else releaseRoot = slots.register({ name: 'root', children: { [HEADER]: { kind: 'list', scope: 'session' } } }, function Frame({ renderSlot }) {
      const n = React.useSyncExternalStore(count.subscribe, count.getSnapshot);
      return React.createElement(React.Fragment, null, ...Array.from({ length: n }, (_, i) => React.createElement('div', { key: i }, renderSlot(HEADER, {}))));
    });
    if (mounted) root.render(slots.renderSlot('root', {}));
  }
  const captured = capture<{ inject: string[]; apply(context: Cordis.Context): void }>(ownBundle);
  assert.equal(captured.id, '@1yefuwang1/dsh-azure-sync');
  const azure = ctx.plugin({ ...captured.module, name: 'sdk-azure-sync' }); await azure.await();
  const container = document.createElement('div'); document.body.appendChild(container); const root = ReactClient.createRoot(container);
  let mounted = false;
  async function render() { await React.act(async () => { declareHeader(); root.render(slots.renderSlot('root', {})); mounted = true; }); }
  async function dispose() { await React.act(async () => { if (mounted) root.unmount(); await azure.dispose(); releaseRoot?.(); await ctx.fiber.dispose(); }); container.remove(); pending.resolve(success(null)); }
  function cloud(): CloudClient { const entry = slots.entries(HEADER).find(value => value.options.id === 'dsh-azure-sync'); assert.ok(entry?.inject); return entry.inject()!.cloud as CloudClient; }
  return { ctx, slots, locale, stock, azure, blocks, calls, opened, list, generation, count, container, current, render, dispose, cloud, pending, releaseDeclaration() { root.render(null); releaseRoot?.(); }, declareHeader };
}

test('public SDK runtime artifacts are exactly the approved pinned version', async () => {
  for (const name of ['dsh-client-store', 'dsh-client-ui-slots', 'dsh-client-ui-renderer', 'dsh-client-locale', 'dsh-client-ui-conversation']) {
    const manifest = JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/' + name + '/package.json')), 'utf8')) as { name: string; version: string };
    assert.equal(manifest.name, '@deepseek-ai/' + name); assert.equal(manifest.version, '0.2.1-rc.2');
  }
});

for (const blank of [false]) test('actual pinned registry, locale and renderer compose the nonblank actions contribution (not stock visibility)', async () => {
  const run = await bench({ blank }); try {
    assert.equal(run.slots.entries(HEADER).length, 0, 'declaration injection waits on real registry'); await run.render();
    assert.deepEqual(run.slots.spec(HEADER), { kind: 'list', scope: 'session' });
    const entry = run.slots.entries(HEADER).find(value => value.options.id === 'dsh-azure-sync')!; assert.ok(entry); assert.equal(entry.locale, NS); assert.equal(entry.registrant, run.azure.name);
    assert.equal(run.locale.bind(NS)('title'), en.title); assert.ok(run.container.querySelector(`input[aria-label="${en.enabled}"]`)); assert.ok(run.container.textContent!.includes(en.settings!));
    assert.ok(run.calls.some(call => call.request.action === 'status' && call.request.sessionId === SID)); assert.deepEqual(run.opened, []);
    await React.act(async () => { await run.azure.dispose(); }); assert.equal(run.slots.entries(HEADER).length, 0); assert.equal(run.locale.bind(NS)('title'), 'title');
    assert.equal(run.slots.spec(HEADER)?.scope, 'session', 'plugin unload leaves declaring owner intact'); assert.ok(run.ctx.get('conversation'), 'stock service not disposed by feature unload'); assert.ok(Cordis.Context.is(run.ctx)); assert.equal(run.ctx.root, run.ctx);
  } finally { await run.dispose(); }
});

test('visibility fixture is anchored to the actual pinned stock hideChrome, corner and hero call sites', async () => {
  const source = await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh-client-ui-conversation/client')), 'utf8');
  assert.match(source, /const blank = session === void 0 \|\| conversation === void 0 \|\| session\.blank && conversationPhase\(session, conversation\) === "blank"/u);
  assert.match(source, /renderSlot\("conversation\.session\.header", \{ hideChrome: blank \}\)/u);
  assert.match(source, /!hideChrome &&[\s\S]{0,4000}renderSlot\("conversation\.session\.header\.actions", \{\}\)/u);
  assert.match(source, /headerCorner,[\s\S]{0,250}renderSlot\("conversation\.session\.header\.corner", \{\}\)/u);
  assert.match(source, /sessionId === void 0 \? null :[\s\S]{0,250}renderSlot\("conversation\.hero\.options", \{\}\)/u);
});

for (const blank of [true, false]) test(`native visibility fixture exposes confirmed On for ${blank ? 'blank hero with hidden actions' : 'nonblank actions without blank corner'}`, async () => {
  const run = await bench({ blank, nativeVisibility: true, hangStatus: true }); const releases: (() => void)[] = [];
  try {
    await run.render();
    assert.equal(run.container.querySelector('[data-native-actions]') !== null, !blank);
    assert.equal(run.container.querySelector('[data-native-hero]') !== null, blank);
    assert.equal(run.slots.entries(CORNER).length, blank ? 1 : 0);
    const checkbox = run.container.querySelector<HTMLInputElement>(`input[aria-label="${en.enabled}"]`)!; assert.ok(checkbox); assert.equal(checkbox.disabled, true);
    assert.ok(run.blocks.storeFor(SID).getSnapshot(), 'visible blank/nonblank control conservatively watches and blocks the exact session');
    assert.ok(run.calls.some(call => call.request.action === 'status' && call.request.sessionId === SID));
    await React.act(async () => { run.pending.resolve(success({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings, items: [], untracked: { sessionId: SID, enabled: false, admissionRequired: false } })); });
    assert.equal(checkbox.disabled, false); assert.equal(run.blocks.storeFor(SID).getSnapshot(), undefined);
    releases.push(run.slots.register({ name: HERO, id: 'foreign-hero-control', order: 1 }, () => React.createElement('span', { 'data-foreign-hero': '' }, 'Native hero control')));
    releases.push(run.slots.register({ name: HEADER, id: 'foreign-header-control', order: 1 }, () => React.createElement('span', { 'data-foreign-header': '' }, 'Native header control')));
    await React.act(async () => { checkbox.click(); });
    assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
    const confirm = run.container.querySelector('[role=dialog]')!; assert.ok(confirm.textContent!.includes(en.onWarning!));
    const button = [...confirm.querySelectorAll('button')].find(value => value.textContent === en.confirm)!;
    await React.act(async () => { button.click(); });
    assert.deepEqual(run.calls.filter(call => call.request.action === 'toggle').map(call => call.request), [{ action: 'toggle', sessionId: SID, enabled: true }]);
    assert.ok(run.calls.some(call => call.request.action === 'check-ownership' && call.request.sessionId === SID));
    assert.ok(run.slots.entries(HERO).some(entry => entry.options.id === 'foreign-hero-control'));
    assert.ok(run.slots.entries(HEADER).some(entry => entry.options.id === 'foreign-header-control'));
    assert.ok(run.container.querySelector(blank ? '[data-foreign-hero]' : '[data-foreign-header]'));
  } finally { await React.act(async () => { for (const release of releases.reverse()) release(); }); await run.dispose(); }
});

for (const priority of [-10, 1000]) test(`blank corner yields to foreign SINGLE occupant at priority ${priority} and never reserves nonblank chrome`, async () => {
  const run = await bench({ blank: true, nativeVisibility: true }); let removeForeign: (() => void) | undefined;
  try {
    await run.render(); const compact = run.container.querySelector('[data-native-corner]')!;
    assert.equal(compact.querySelectorAll('button').length, 1); assert.equal(compact.querySelector('input'), null);
    await React.act(async () => { removeForeign = run.slots.register({ name: CORNER, priority }, () => React.createElement('span', { 'data-foreign-corner': '' }, 'Foreign corner')); });
    const foreign = run.slots.entries(CORNER)[0]!; assert.equal(run.slots.entries(CORNER).length, 1); assert.ok(compact.querySelector('[data-foreign-corner]'));
    assert.ok(run.container.querySelector(`[data-native-hero] input[aria-label="${en.enabled}"]`), 'hero remains available when another owner occupies corner');
    await React.act(async () => { run.list.set({ byId: { [SID]: { id: SID, blank: false, origin: 'native', retainedBy: { mainView: 1 } } } }); });
    assert.deepEqual(run.slots.entries(CORNER), [foreign]); assert.ok(compact.querySelector('[data-foreign-corner]'));
    assert.equal(run.container.querySelector('[data-native-hero]'), null); assert.ok(run.container.querySelector('[data-native-actions] input'));
    await React.act(async () => { removeForeign!(); removeForeign = undefined; }); assert.equal(run.slots.entries(CORNER).length, 0);
    await React.act(async () => { run.list.set({ byId: { [SID]: { id: SID, blank: true, origin: 'native', retainedBy: { mainView: 1 } } } }); });
    assert.equal(run.slots.entries(CORNER).length, 1); assert.equal(compact.querySelectorAll('button').length, 1);
  } finally { await React.act(async () => { removeForeign?.(); }); await run.dispose(); }
});

test('blank visible seats share conservative watches across real Cordis restart and clean only owned slots/blocks', async () => {
  const run = await bench({ blank: true, nativeVisibility: true, hangStatus: true }); try {
    await run.render(); const first = run.calls.find(call => call.request.action === 'status')!;
    assert.equal(run.calls.filter(call => call.request.action === 'status').length, 1, 'hero and corner share one exact-session lookup');
    assert.ok(run.blocks.storeFor(SID).getSnapshot());
    await React.act(async () => { await run.azure.restart(); });
    assert.equal(first.signal?.aborted, true); assert.equal(run.slots.entries(CORNER).length, 1);
    assert.equal(run.slots.entries(HERO).filter(entry => entry.options.id === 'dsh-azure-sync').length, 1);
    assert.ok(run.blocks.storeFor(SID).getSnapshot());
    const foreign = { reason: 'worktrees-during-blank-HMR' }; run.blocks.set(SID, foreign);
    await React.act(async () => { await run.azure.dispose(); });
    assert.equal(run.slots.entries(CORNER).length, 0); assert.equal(run.slots.entries(HERO).length, 0);
    assert.equal(run.blocks.storeFor(SID).getSnapshot(), foreign);
    assert.ok(run.calls.filter(call => call.request.action === 'status').every(call => call.signal?.aborted));
    run.blocks.set(SID, undefined);
  } finally { await run.dispose(); }
});

test('actual SDK main keyed seat has confirmed On when the conversation header is not mounted', async () => {
  const run = await bench({ blank: true, panel: true, hangStatus: true }); try {
    await run.render(); assert.ok(run.container.querySelector('main.dsh-az-panel'));
    assert.equal(run.container.querySelector('[data-conversation-header-corner]'), null);
    assert.ok(run.slots.entries('main').some(entry => entry.options.key === 'conversation'), 'stock native conversation registration stays intact');
    assert.ok(run.blocks.storeFor(SID).getSnapshot());
    await React.act(async () => { run.pending.resolve(success({ kind: 'status', revision: 1, projectionRevision: 'a'.repeat(64), settings, items: [], untracked: { sessionId: SID, enabled: false, admissionRequired: false } })); });
    const checkbox = run.container.querySelector<HTMLInputElement>(`input[aria-label="${en.enabled}"]`)!; assert.ok(checkbox); assert.equal(checkbox.disabled, false);
    await React.act(async () => { checkbox.click(); }); assert.equal(run.calls.some(call => call.request.action === 'toggle'), false);
    const confirm = run.container.querySelector('[role=dialog]')!; assert.ok(confirm.textContent!.includes(en.onWarning!));
    await React.act(async () => { [...confirm.querySelectorAll('button')].find(button => button.textContent === en.confirm)!.click(); });
    assert.deepEqual(run.calls.filter(call => call.request.action === 'toggle').map(call => call.request), [{ action: 'toggle', sessionId: SID, enabled: true }]);
    assert.ok(run.slots.entries('main').some(entry => entry.options.key === 'conversation'));
  } finally { await run.dispose(); }
});

test('actual registry registers all cloud seats alongside the stock conversation tree without replacing native entries', async () => {
  const run = await bench(); let releaseShell: (() => void) | undefined;
  try {
    await React.act(async () => {
      releaseShell = run.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'plugins.row.config': { kind: 'keyed', scope: 'root' } } }, function UnmountedShell({ renderSlot }) { void renderSlot; return null; });
    });
    assert.ok(run.slots.entries('main').some(entry => entry.options.key === 'conversation'), 'stock native conversation stays installed');
    assert.ok(run.slots.entries('main').some(entry => entry.options.key === 'dsh-azure-sync'));
    assert.ok(run.slots.entries('sidebar.panellist').some(entry => entry.options.id === 'dsh-azure-sync'));
    assert.ok(run.slots.entries('plugins.row.config').some(entry => entry.options.key === '@1yefuwang1/dsh-azure-sync#azure-sync'));
    assert.equal(run.slots.entries(HEADER).filter(entry => entry.options.id === 'dsh-azure-sync').length, 1);
    await React.act(async () => { await run.azure.dispose(); });
    assert.ok(run.slots.entries('main').some(entry => entry.options.key === 'conversation')); assert.equal(run.slots.entries('plugins.row.config').length, 0); assert.equal(run.slots.entries('sidebar.panellist').length, 0);
  } finally { await React.act(async () => { releaseShell?.(); }); await run.dispose(); }
});

test('actual stock Blocks registry preserves identity, freezes snapshots and deduplicates equal reasons', async () => {
  const run = await bench(); try {
    const store = run.blocks.storeFor(SID), marker = { reason: 'worktrees-owned-marker' }; let notices = 0; const stop = store.subscribe(() => { notices++; });
    run.blocks.set(SID, marker); assert.equal(store.getSnapshot(), marker); assert.equal(Object.isFrozen(marker), true); assert.equal(run.blocks.storeFor(SID), store);
    run.blocks.set(SID, { reason: marker.reason }); assert.equal(store.getSnapshot(), marker); assert.equal(notices, 1);
    const owner = createComposerBlockOwner(run.blocks), release = owner.acquire(SID, 'cloud-owned-reason'); assert.equal(store.getSnapshot(), marker);
    owner.dispose(); release(); assert.equal(store.getSnapshot(), marker, 'foreign singleton authority survives our disposal'); stop(); run.blocks.set(SID, undefined);
  } finally { await run.dispose(); }
});

test('actual SDK store supports shared refs, foreign replacement, reentrancy and last-owner cleanup', async () => {
  const run = await bench(); try {
    const store = run.blocks.storeFor(SID), a = createComposerBlockOwner(run.blocks), b = createComposerBlockOwner(run.blocks);
    const releaseA = a.acquire(SID, 'cloud-A'), releaseA2 = a.acquire(SID, 'cloud-A'), releaseB = b.acquire(SID, 'cloud-B');
    assert.equal(store.getSnapshot()?.reason, 'cloud-A'); releaseA(); assert.equal(store.getSnapshot()?.reason, 'cloud-A'); releaseA2(); assert.equal(store.getSnapshot()?.reason, 'cloud-B');
    const foreign = { reason: 'worktrees-foreign-owner' }; run.blocks.set(SID, foreign); assert.equal(store.getSnapshot(), foreign);
    b.dispose(); releaseB(); assert.equal(store.getSnapshot(), foreign); run.blocks.set(SID, undefined); assert.equal(store.getSnapshot(), undefined);
    const c = createComposerBlockOwner(run.blocks), releaseC = c.acquire(SID, 'cloud-C'); let reentered = false;
    const stop = store.subscribe(() => { if (!store.getSnapshot() && !reentered) { reentered = true; run.blocks.set(SID, foreign); } });
    releaseC(); assert.equal(store.getSnapshot(), foreign, 'teardown does not reacquire over a synchronous foreign replacement'); stop(); a.dispose(); c.dispose(); run.blocks.set(SID, undefined);
  } finally { await run.dispose(); }
});

test('actual Cordis feature restart and slot declaration collapse clean only owned blocks and flights', async () => {
  const run = await bench({ hangStatus: true }); try {
    await run.render(); const block = run.blocks.storeFor(SID); assert.ok(block.getSnapshot()); const first = run.calls.find(call => call.request.action === 'status')!;
    await React.act(async () => { run.count.set(2); }); assert.equal(run.container.querySelectorAll(`input[aria-label="${en.enabled}"]`).length, 2);
    await React.act(async () => { run.count.set(1); }); assert.ok(block.getSnapshot(), 'last UI ref remains owned');
    await React.act(async () => { await run.azure.restart(); }); assert.equal(first.signal!.aborted, true); assert.equal(run.slots.entries(HEADER).filter(entry => entry.options.id === 'dsh-azure-sync').length, 1); assert.ok(block.getSnapshot());
    const foreign = { reason: 'worktrees-during-HMR' }; run.blocks.set(SID, foreign);
    await React.act(async () => { run.releaseDeclaration(); }); assert.equal(run.slots.entries(HEADER).length, 0); assert.equal(block.getSnapshot(), foreign);
    await React.act(async () => { run.declareHeader(); }); assert.equal(run.slots.entries(HEADER).filter(entry => entry.options.id === 'dsh-azure-sync').length, 1); assert.equal(block.getSnapshot(), foreign);
    await React.act(async () => { await run.azure.dispose(); }); assert.equal(block.getSnapshot(), foreign); assert.equal(run.slots.entries(HEADER).length, 0); assert.equal(run.locale.bind(NS)('title'), 'title');
    assert.ok(run.calls.filter(call => call.request.action === 'status').every(call => call.signal?.aborted)); run.blocks.set(SID, undefined);
  } finally { await run.dispose(); }
});

test('actual SDK block identity is shared between bundled and ESM helper owners', async () => {
  const run = await bench({ hangStatus: true }); try {
    await run.render(); const cloud = run.cloud(), store = run.blocks.storeFor(SID); assert.equal(cloud.getThread(SID).blocked, true);
    const esmOwner = createComposerBlockOwner(run.blocks), release = esmOwner.acquire(SID, 'ESM-overlap-owner');
    await React.act(async () => { await run.azure.dispose(); }); assert.equal(store.getSnapshot()?.reason, 'ESM-overlap-owner', 'bundle reload does not release another helper instance');
    release(); esmOwner.dispose(); assert.equal(store.getSnapshot(), undefined);
  } finally { await run.dispose(); }
});
