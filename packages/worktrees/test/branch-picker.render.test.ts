import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { after, test } from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { exposeClient } from './client-artifact.js';

interface RepositoryStatus { settingsHash: string; repository: { root: string; head: string; branch: string | null }; remotes: { name: string; identity: string }[]; defaults: { remote: string; branch: string }; }
interface BranchGeneration { branchSource?: string; currentBranch?: string | null; defaultBranch: string | null; remote?: string; remoteIdentity?: string; observedAt: number; items: { name: string; oid: string }[]; nextCursor?: string; }
interface Metadata { projects: Project[]; bindings: NonNullable<ProjectContext['binding']>[]; records: unknown[]; revision?: number; }
type Selector = (snapshot: VmValue) => VmValue; // React stub hook inputs cross the VM contract.

type Listener = () => void;
type Cleanup = () => void | Promise<void>;
type ComposerBlock = { reason: string } | undefined;
interface MockRequest {
  action: string; id?: string; operationId?: string; projectId?: string; folderId?: string;
  sessionId?: string; sourceSessionId?: string; branchSource?: string; remote?: string;
  remoteIdentity?: string; remoteBranch?: string; localBranch?: string; localOid?: string;
  repoPath?: string; cursor?: string; limit?: number; title?: string; folders?: string[];
  mainFolder?: string; firstPrompt?: string; sessionMode?: string; requireBlankSource?: boolean;
}
interface MockPayload { v: number; actorId?: string; request: MockRequest; after?: number; }
type RpcArgs = [channel: string, endpoint: string, payload: MockPayload, signal: AbortSignal];
interface SessionSnapshot {
  blank?: boolean; subagent?: unknown; openState?: string; removed?: boolean; running?: boolean;
  promptAttempted?: boolean; awaitingFirstTurn?: boolean; pendingSubmissions?: unknown[];
  promptError?: { op: string; error: { code: string } };
}
interface SessionItem { retainedBy: Record<string, number>; title?: string; blank?: boolean; updatedAt?: number; }
interface SessionList { byId: Record<string, SessionItem>; }
interface ComposerSnapshot { draft: string; draftRev: number; phase: string; attachmentIds: string[]; queue: unknown[]; occurrences?: unknown[]; }
interface Folder { id: string; path: string; title?: string; }
interface Project { id: string; title?: string; folders: Folder[]; mainFolderId?: string; createdAt?: number; updatedAt?: number; }
interface ProjectContext { project: Project; folder: Folder; binding?: { sessionId?: string; projectId?: string; folderId?: string; mode: string; effectiveCwd?: string; worktreeId?: string; }; }
// The client script is evaluated in a separate VM realm and deliberately exposes
// unexported implementations; dynamic values stop at this inspected VM contract.
type VmValue = any;
type VmModule = { id: string; factory: (require: (name: string) => unknown) => VmValue };









const clientUrl = new URL('../dist/client.js', import.meta.url);
const source = await readFile(clientUrl, 'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
after(() => {
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

let module!: VmModule;
// Expose actual emitted keepNames bindings in memory; no readable-source or
// component replacement is executed for these real React render tests.
vm.runInNewContext(exposeClient(source, ['ChoicePicker', 'BranchPicker', 'NewWorktreeControls', 'SetupProgress', 'createWorktreeFlow', 'createRepositoryAvailability', 'Styles', 'en']), {
  window: { __ModuleLoader__: { load(value: VmModule) { module = value; } } },
  AbortController, AbortSignal, crypto: webcrypto,
}, { filename: clientUrl.pathname });
const real = module.factory((name: string) => { assert.equal(name, 'react'); return React; }).renderTest;
const success = <T>(data: T) => ({ ok: true, value: { v: 1, ok: true, data } });
const blank = { blank: true, subagent: null, openState: 'open', removed: false, running: false, promptAttempted: false, awaitingFirstTurn: false, pendingSubmissions: [] };
const empty: ComposerSnapshot = { draft: '', draftRev: 1, phase: 'plain', attachmentIds: [], queue: [] };
const status: RepositoryStatus = { settingsHash: 'settings', repository: { root: '/repo', head: 'develop-oid', branch: 'develop' }, remotes: [{ name: 'upstream', identity: 'upstream-id' }, { name: 'origin', identity: 'origin-id' }], defaults: { remote: 'upstream', branch: 'main' } };
const local = { branchSource: 'local', currentBranch: 'develop', defaultBranch: 'develop', observedAt: 1, items: [{ name: 'develop', oid: 'develop-oid' }, { name: 'main', oid: 'main-oid' }], nextCursor: 'local-page-2' };
function observable<T>(initial: T) {
  let value = initial; const listeners = new Set<Listener>();
  return { getSnapshot: () => value, subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next: T) { value = next; for (const fn of [...listeners]) fn(); } };
}
async function click(element: Element | null | undefined) { assert.ok(element, 'click target exists in the real DOM'); await act(async () => (element as HTMLElement).click()); }
async function key(element: Element | null | undefined, value: string) {
  assert.ok(element); await act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
}
async function search(input: HTMLInputElement | null, value: string) {
  assert.ok(input);
  await act(async () => {
    // Bypass React's value tracker exactly as an actual user input does.
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
function button(container: ParentNode | null, label: string) { return [...container!.querySelectorAll!('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label); }
function branchItems(container: ParentNode) { return [...container.querySelectorAll<HTMLButtonElement>('.dsh-wt-branch-list [role=menuitemradio]')]; }
function branchNames(container: ParentNode) { return branchItems(container).map((item) => item.querySelector('.dsh-wt-branch-name')!.textContent); }
async function mount(t: import('node:test').TestContext, element: React.ReactNode) {
  const container = document.createElement('div'); document.body.append(container);
  const outside = document.createElement('button'); outside.textContent = 'Outside'; document.body.append(outside);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); outside.remove(); });
  await act(async () => root.render(element));
  return { container, outside, root };
}
async function controls(t: import('node:test').TestContext, { git = true, repository = status, localGeneration = local, branchReply, statusReply, draft = empty, context: initialContext }: { git?: boolean; repository?: RepositoryStatus; localGeneration?: BranchGeneration; branchReply?: (request: MockRequest) => unknown; statusReply?: (request: MockRequest, signal: AbortSignal) => unknown; draft?: ComposerSnapshot; context?: ProjectContext } = {}) {
  const calls: { request: MockRequest; signal: AbortSignal }[] = [], cleanups = new Set<Cleanup>();
  function effect(factory: () => Cleanup) { const cleanup = factory(); let live = true; const stop = () => { if (live) { live = false; cleanups.delete(stop); return cleanup(); } }; cleanups.add(stop); return stop; }
  const session = observable<SessionSnapshot>(blank), state = observable(draft), panel = observable<{ activePanelId: string | undefined }>({ activePanelId: undefined }), list = observable<SessionList>({ byId: { source: { retainedBy: { mainView: 1 } } } });
  const binding = { ctx: { effect }, session };
  const nativeSink = async (_text: string, _ids: string[], _mode: string, _signal: AbortSignal) => { assert.fail('rendering or choosing options must not submit a prompt'); };
  const input = { state, deps: { actx: binding.ctx, defaultSink: nativeSink, inputTriggers: () => undefined } };
  const block = observable<ComposerBlock>(undefined), metadata = observable<Metadata>({ projects: [], bindings: [], records: [] });
  let context = initialContext;
  const projects = { store: metadata, context: () => context };
  const workspaces = { items: [{ workspaceId: 'repo', path: '/repo', sessionIds: ['source'] }], archivedSessionIds: [], pinnedSessionIds: [] };
  const runtime = { effect, get: (name: string) => { assert.equal(name, 'conversation'); return { input: { for: () => input }, blocks: { storeFor: () => block, set: (_id: string, value: ComposerBlock) => block.publish(value) } }; },
    sessions: { list, binding: () => binding }, uiSession: { sessionStatus: observable(new Map()) }, workspaces: { list: observable(workspaces) },
    connection: { generation: observable<{ id: number } | undefined>({ id: 1 }), rpc: { async call(...[channel, endpoint, payload, signal]: RpcArgs) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/execute'); assert.equal(payload.actorId, 'source'); calls.push({ request: payload.request, signal });
      if (payload.request.action === 'status') return statusReply ? statusReply(payload.request, signal) : git ? success(repository) : { ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Not a Git repository' } } };
      assert.equal(payload.request.action, 'branches');
      if (branchReply) { const reply = branchReply(payload.request); if (reply) return reply; }
      if (payload.request.branchSource === 'local') return success(payload.request.cursor ? { ...localGeneration, nextCursor: undefined, items: [{ name: 'feature/local', oid: 'feature-oid' }, { name: 'release', oid: 'release-oid' }] } : localGeneration);
      return success({ branchSource: 'remote', remote: payload.request.remote, remoteIdentity: payload.request.remoteIdentity, defaultBranch: 'main', observedAt: 2, items: [{ name: 'main', oid: payload.request.remote + '-main' }, { name: 'feature/remote', oid: payload.request.remote + '-feature' }] });
    } } },
  };
  const repositories = real.createRepositoryAvailability(runtime, projects), flow = real.createWorktreeFlow(runtime, (tKey: string) => tKey, projects, repositories);
  const mounted = await mount(t, React.createElement(React.Fragment, null, React.createElement(real.NewWorktreeControls, {
    sessionId: 'source', runtime, projects, repositories, flow, t: (key: string) => real.en[key] || key,
    useSession: (selector: Selector) => selector(session.getSnapshot()), useInput: (selector: Selector) => selector(state.getSnapshot()),
    usePanelInfo: (selector: Selector) => selector(React.useSyncExternalStore(panel.subscribe, panel.getSnapshot)), useWorkspaces: (selector: Selector) => selector(workspaces),
  }), React.createElement(real.SetupProgress, { sessionId: 'source', flow, t: (key: string) => real.en[key] || key })));
  t.after(async () => { await act(async () => { await flow.dispose(); repositories.dispose(); await Promise.allSettled([...cleanups].map(stop => stop())); }); assert.equal(input.deps.defaultSink, nativeSink); });
  return { ...mounted, calls, flow, repositories, panel, runtime, input, block,
    contextChanged(next: ProjectContext | undefined) { context = next; metadata.publish({ ...metadata.getSnapshot(), revision: calls.length }); },
    mode: () => mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Thread mode"]'),
    branch: () => mounted.container.querySelector<HTMLButtonElement>('button[aria-haspopup=dialog]'),
    popup: () => mounted.container.querySelector<HTMLDivElement>('.dsh-wt-base-options'),
    search: () => mounted.container.querySelector<HTMLInputElement>('input[type=search]'),
  };
}

test('non-Git Local and Git modes render the same themed ChoicePicker, never a native mode select', async (t: import('node:test').TestContext) => {
  const plain = await controls(t, { git: false }), git = await controls(t);
  assert.equal(plain.mode()!.className, git.mode()!.className); assert.equal(git.mode()!.className, 'dsh-wt-control');
  for (const fixture of [plain, git]) {
    assert.equal(fixture.container.querySelector('select'), null);
    assert.match(fixture.container.querySelector('style')!.textContent, /\.dsh-wt-create-controls \.dsh-wt-control\{[^}]*var\(--dsw-alias-label-secondary\)/);
    assert.equal(fixture.mode()!.textContent, 'Local');
  }
  assert.equal(plain.branch(), null); assert.equal(plain.mode()!.hasAttribute!('aria-haspopup'), false); await click(plain.mode()); assert.equal(plain.calls.length, 1);
  await click(git.mode()); const options = [...git.container.querySelectorAll<HTMLButtonElement>('.dsh-wt-choice-menu [role=menuitemradio]')];
  assert.deepEqual(options.map((item) => item.textContent.replace('✓', '')), ['Local', 'New worktree']);
  const count = git.calls.length; await click(options[1]); assert.equal(git.flow.store.getSnapshot().mode, 'new', git.flow.store.getSnapshot().error); assert.equal(git.mode()!.textContent, 'New worktree'); assert.equal(git.calls.length, count);
  assert.equal(git.container.querySelector('.dsh-wt-choice-menu'), null); assert.equal(document.activeElement, git.mode());
});

test('returning to an unsent New draft rechecks neutrally, keeps intent and never renders fake setup progress', async (t: import('node:test').TestContext) => {
  for (const cause of ['panel', 'reconnect']) {
    let delayed = false, complete!: (value: unknown) => void;
    const draft = { ...empty, draft: 'keep native @reference draft', attachmentIds: ['file-one', 'image-two'] };
    const fixture = await controls(t, { draft, statusReply() { return delayed ? new Promise(resolve => { complete = resolve; }) : success(status); } });
    await click(fixture.mode()); await click(button(fixture.container, 'New worktree'));
    const initial = fixture.calls.length;
    assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
    delayed = true;
    await act(async () => {
      if (cause === 'panel') fixture.panel.publish({ activePanelId: 'settings' });
      else fixture.runtime.connection.generation.publish(undefined);
    });
    assert.equal(fixture.flow.store.getSnapshot().error, '');
    assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
    await act(async () => {
      if (cause === 'panel') fixture.panel.publish({ activePanelId: undefined });
      else fixture.runtime.connection.generation.publish({ id: 2 });
    });
    assert.equal(fixture.repositories.store.getSnapshot().phase, 'checking');
    assert.equal(fixture.mode()!.textContent, 'New worktree', 'an unavailable cached check must not pretend intent is Local');
    assert.equal(fixture.branch(), null);
    assert.equal(fixture.container.querySelector('[role=alert]'), null);
    assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
    await act(async () => complete(success(status)));
    assert.equal(fixture.repositories.enabled('source'), true); assert.equal(fixture.mode()!.textContent, 'New worktree');
    assert.ok(fixture.branch()); assert.equal(fixture.container.querySelector('[role=alert]'), null);
    assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
    assert.equal(fixture.calls.length, initial + 1); assert.ok(fixture.calls.every(call => call.request.action === 'status'));
    assert.equal(fixture.input.state.getSnapshot(), draft); assert.equal(fixture.block.getSnapshot(), undefined);
  }
});

test('explicit Local during a pending recheck stays Local after late success or failure and preserves the draft', async (t: import('node:test').TestContext) => {
  for (const accepted of [true, false]) {
    let delayed = false, complete!: (value: unknown) => void;
    const draft = { ...empty, draft: 'keep native draft', attachmentIds: ['file-one'] };
    const fixture = await controls(t, { draft, statusReply() { return delayed ? new Promise(resolve => { complete = resolve; }) : success(status); } });
    await click(fixture.mode()); await click(button(fixture.container, 'New worktree'));
    delayed = true;
    await act(async () => fixture.panel.publish({ activePanelId: 'settings' }));
    await act(async () => fixture.panel.publish({ activePanelId: undefined }));
    assert.equal(fixture.container.querySelector('[role=status]')!.textContent, 'Checking worktree availability…');
    await click(fixture.mode()); assert.equal(fixture.container.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')!.disabled, true);
    assert.equal(document.activeElement!.textContent, 'Local', 'focus skips the disabled selected New item');
    await click(button(fixture.container, 'Local'));
    assert.equal(fixture.mode()!.textContent, 'Local'); assert.equal(fixture.flow.store.getSnapshot().mode, 'local');
    await act(async () => complete(accepted ? success(status) : { ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Not available' } } }));
    assert.equal(fixture.flow.store.getSnapshot().mode, 'local'); assert.equal(fixture.mode()!.textContent, 'Local');
    assert.equal(fixture.container.querySelector('[role=alert]'), null); assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
    assert.equal(fixture.input.state.getSnapshot(), draft); assert.equal(fixture.block.getSnapshot(), undefined);
    assert.ok(fixture.calls.every(call => call.request.action === 'status'));
  }
});

test('changed-source New controls keep their warning and still offer explicit Local without progress', async (t: import('node:test').TestContext) => {
  const folder = { id: 'folder', path: '/repo', title: 'Source' }, project = { id: 'project', folders: [folder] };
  const fixture = await controls(t, { context: { project, folder, binding: { mode: 'local' } }, statusReply: () => success({ ...status, projectPath: '/repo' }) });
  await click(fixture.mode()); await click(button(fixture.container, 'New worktree'));
  await act(async () => fixture.contextChanged(undefined));
  assert.equal(fixture.flow.store.getSnapshot().sourceChanged, true);
  assert.equal(fixture.mode()!.textContent, 'New worktree'); assert.equal(fixture.branch(), null);
  assert.equal(fixture.container.querySelector('[role=alert]')!.textContent, 'projectChanged');
  assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
  await click(fixture.mode()); assert.equal(fixture.container.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')!.disabled, true);
  await click(button(fixture.container, 'Local'));
  assert.equal(fixture.mode()!.textContent, 'Local'); assert.equal(fixture.flow.store.getSnapshot().sourceChanged, false);
  assert.equal(fixture.container.querySelector('[role=alert]'), null);
  assert.ok(fixture.calls.every(call => call.request.action === 'status'));
});

test('a failed unsent recheck shows only the repository warning, keeps New intent and offers explicit Local', async (t: import('node:test').TestContext) => {
  let failed = false;
  const fixture = await controls(t, { statusReply() { return failed ? { ok: true, value: { v: 1, ok: false, error: { code: 'GIT_FAILED', message: 'Repository no longer available' } } } : success(status); } });
  await click(fixture.mode()); await click(button(fixture.container, 'New worktree'));
  failed = true;
  await act(async () => fixture.panel.publish({ activePanelId: 'settings' }));
  await act(async () => fixture.panel.publish({ activePanelId: undefined }));
  assert.equal(fixture.repositories.store.getSnapshot().phase, 'unavailable');
  assert.equal(fixture.mode()!.textContent, 'New worktree'); assert.equal(fixture.branch(), null);
  assert.match(fixture.container.querySelector('[role=alert]')!.textContent, /Worktree mode is unavailable/);
  assert.equal(fixture.container.querySelectorAll('[role=alert]').length, 1);
  assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null, 'no Send means no creating/naming steps');
  await click(fixture.mode()); assert.equal(fixture.container.querySelector<HTMLButtonElement>('[role=menuitemradio][aria-checked=true]')!.disabled, true);
  await click(button(fixture.container, 'Local'));
  assert.equal(fixture.mode()!.textContent, 'Local'); assert.equal(fixture.container.querySelector('[role=alert]'), null);
  assert.ok(fixture.calls.every(call => call.request.action === 'status'));
});

test('SetupProgress ignores configuration-only errors but retains actual submitted failures', async (t: import('node:test').TestContext) => {
  const state = observable<{ sessionId: string; busy: boolean; phase: string; steps: unknown[]; error: string; branchSource: string; op: null; failedAt?: string }>({ sessionId: 'source', busy: false, phase: '', steps: [], error: 'Configuration failed', branchSource: 'local', op: null });
  const fixture = await mount(t, React.createElement(real.SetupProgress, { sessionId: 'source', flow: { store: state }, t: (key: string) => real.en[key] || key }));
  assert.equal(fixture.container.querySelector('.dsh-wt-progress'), null);
  await act(async () => state.publish({ ...state.getSnapshot(), phase: 'failed', failedAt: 'creating' }));
  assert.match(fixture.container.querySelector('[role=status]')!.textContent, /Worktree preparation failed/);
  assert.equal(fixture.container.querySelector('[role=alert]')!.textContent, 'Configuration failed');
});

test('real BranchPicker loads local cursor pages, marks current branch and auto-closes a choice without a close button', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); const initial = fixture.calls.length;
  assert.equal(fixture.branch()!.textContent, 'develop'); await click(fixture.branch());
  assert.equal(fixture.calls.length, initial + 3, 'one status and two local branch cursor pages'); assert.equal(document.activeElement, fixture.search());
  assert.deepEqual(branchNames(fixture.container), ['develop', 'main', 'feature/local', 'release']);
  const items = branchItems(fixture.container); assert.equal(items[0]!.querySelector('.dsh-wt-branch-badge')!.textContent, 'Current branch');
  assert.equal(items[0]!.getAttribute('aria-checked')!, 'true'); assert.equal(items[1]!.querySelector('.dsh-wt-branch-badge')!, null);
  assert.equal(button(fixture.popup(), 'Close'), undefined); assert.equal(fixture.popup()!.querySelector('select')!, null);
  await click(items[2]); assert.equal(fixture.popup(), null); assert.equal(fixture.branch()!.textContent, 'feature/local'); assert.equal(document.activeElement, fixture.branch());
  assert.equal(fixture.flow.store.getSnapshot().branchOid, 'feature-oid'); await click(fixture.branch()); assert.equal(fixture.calls.length, initial + 3, 'reopen uses cached generation');
  assert.equal(branchItems(fixture.container)[2]!.getAttribute('aria-checked')!, 'true');
});

test('picker uses native menu fill/elevation and one non-wrapping borderless search input', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); await click(fixture.branch());
  const popup = fixture.popup(), input = fixture.search(), wrap = input!.closest('label')!;
  const css = fixture.container.querySelector('style')!.textContent;
  assert.match(css, /\.dsh-wt-choice-menu,\.dsh-wt-base-options\{[^}]*background:var\(--dsw-specific-menu,var\(--dsw-alias-bg-layer-2\)\)/);
  assert.match(css, /\.dsh-wt-choice-menu,\.dsh-wt-base-options\{[^}]*box-shadow:var\(--dsw-elevation-prominent\)/);
  assert.doesNotMatch(css.slice(css.indexOf('.dsh-wt-choice-menu,'), css.indexOf('.dsh-wt-projects{')), /--dsw-alias-bg-overlay|color-mix/);
  const inputStyle = dom.window.getComputedStyle(input!), wrapStyle = dom.window.getComputedStyle(wrap);
  assert.equal(wrapStyle.flexWrap, 'nowrap');
  assert.equal(inputStyle.borderTopWidth, '0px', 'specific search rule wins over generic input border');
  assert.equal(inputStyle.borderRadius, '0px');
  assert.equal(inputStyle.width, '0px'); assert.equal(inputStyle.flexGrow, '1');
  assert.equal(inputStyle.outline, 'none');
  assert.match(css, /input\[type=search\]:focus-visible[^}]*\{outline:none\}/);
  assert.equal(wrap.querySelector('svg')!.nextElementSibling!, input, 'icon and flexible input share one row');
  assert.ok(popup!.contains!(wrap));
  assert.equal(popup!.style!.background, '', 'surface remains theme-owned, not fixed inline');
  assert.doesNotMatch(css.slice(css.indexOf('.dsh-wt-choice-menu,'), css.indexOf('.dsh-wt-projects{')), /#[0-9a-f]{3,8}|rgba?\(/i, 'menu and search colors come from native theme tokens');
  assert.match(css, /:is\(\.dsh-wt-choice-item,\.dsh-wt-branch-item\):is\(:hover,:focus-visible\):not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover\);outline:none\}/);
});

test('search filters cached cursor branches without network and preserves the selected branch/OID', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); await click(fixture.branch()); await click(branchItems(fixture.container)[2]); await click(fixture.branch()); const count = fixture.calls.length;
  await search(fixture.search(), 'MAIN'); assert.deepEqual(branchNames(fixture.container), ['main']);
  assert.equal(fixture.flow.store.getSnapshot().query, 'MAIN'); assert.equal(fixture.branch()!.textContent, 'feature/local');
  assert.equal(fixture.flow.store.getSnapshot().branchOid, 'feature-oid');
  await search(fixture.search(), 'not visible'); assert.deepEqual(branchNames(fixture.container), []); assert.match(fixture.popup()!.textContent, /No matching branches/);
  await search(fixture.search(), ''); assert.deepEqual(branchNames(fixture.container), ['develop', 'main', 'feature/local', 'release']); assert.equal(fixture.calls.length, count);
  assert.ok(fixture.calls.every(call => !Object.hasOwn(call.request, 'query')));
});

test('remote source and nested remote ChoicePicker reuse source caches; remote search never contacts network', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); await click(fixture.branch()); const localCount = fixture.calls.length;
  await click(button(fixture.popup(), 'Remote branches')); assert.ok(fixture.popup()); assert.equal(fixture.calls.length, localCount + 1);
  assert.deepEqual(branchNames(fixture.container), ['main', 'feature/remote']); assert.equal(fixture.branch()!.textContent, 'upstream/main');
  assert.equal(fixture.popup()!.querySelector('.dsh-wt-branch-badge')!, null); assert.match(fixture.popup()!.textContent, /Fetches when the worktree is created/);
  await click(button(fixture.popup(), 'Remote')); const origin = button(fixture.popup(), 'origin'); await click(origin);
  assert.ok(fixture.popup(), 'choosing a remote keeps the outer branch picker open'); assert.equal(fixture.calls.length, localCount + 2); assert.equal(fixture.branch()!.textContent, 'origin/main');
  const remoteCount = fixture.calls.length; await search(fixture.search(), 'FEATURE'); assert.deepEqual(branchNames(fixture.container), ['feature/remote']); assert.equal(fixture.calls.length, remoteCount);
  await click(branchItems(fixture.container)[0]); assert.equal(fixture.popup(), null); assert.equal(fixture.branch()!.textContent, 'origin/feature/remote'); assert.equal(fixture.flow.store.getSnapshot().branchOid, 'origin-feature');
  await click(fixture.branch()); assert.equal(fixture.calls.length, remoteCount); await click(button(fixture.popup(), 'Local branches')); assert.equal(fixture.calls.length, remoteCount);
  assert.deepEqual(branchNames(fixture.container), ['develop', 'main', 'feature/local', 'release']);
  await click(button(fixture.popup(), 'Remote branches')); assert.equal(fixture.calls.length, remoteCount, 'return to cached origin');
});

test('detached local HEAD renders its current-branch badge and retains the exact local OID', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t, { repository: { ...status, repository: { ...status.repository, branch: null, head: 'detached-oid' }, remotes: [] }, localGeneration: { branchSource: 'local', currentBranch: null, defaultBranch: 'HEAD', observedAt: 3, items: [{ name: 'HEAD', oid: 'detached-oid' }, { name: 'main', oid: 'main-oid' }] } });
  assert.equal(fixture.branch()!.textContent, 'HEAD'); await click(fixture.branch());
  assert.deepEqual(branchNames(fixture.container), ['Detached · HEAD', 'main']);
  assert.equal(branchItems(fixture.container)[0]!.querySelector('.dsh-wt-branch-badge')!.textContent, 'Current branch');
  await click(branchItems(fixture.container)[0]); assert.equal(fixture.popup(), null); assert.equal(fixture.flow.store.getSnapshot().branchOid, 'detached-oid');
});

test('a no-remote Git repository retains the local picker and disables only its remote source', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t, { repository: { ...status, remotes: [] } }); assert.ok(fixture.branch());
  await click(fixture.branch()); assert.equal(button(fixture.popup(), 'Remote branches')!.disabled, true); assert.equal(button(fixture.popup(), 'Local branches')!.disabled, false);
  assert.deepEqual(branchNames(fixture.container), ['develop', 'main', 'feature/local', 'release']);
  assert.ok(fixture.calls.filter(call => call.request.action === 'branches').every(call => call.request.branchSource === 'local' && !Object.hasOwn(call.request, 'remote')));
});

test('Refresh survives focus loss while loading, preserves search/selection, and only a branch choice closes it', async (t: import('node:test').TestContext) => {
  for (const branchSource of ['local', 'remote']) {
    let delayed = false, complete!: (value: unknown) => void;
    const fixture = await controls(t, { branchReply(_request: MockRequest) {
      if (!delayed) return;
      delayed = false;
      return new Promise(resolve => { complete = (data: unknown) => resolve(success(data)); });
    } });
    await click(fixture.branch());
    if (branchSource === 'remote') await click(button(fixture.popup(), 'Remote branches'));
    await click(branchItems(fixture.container)[1]); await click(fixture.branch());
    await search(fixture.search(), branchSource === 'local' ? 'main' : 'feature');
    const before = fixture.flow.store.getSnapshot(), popup = fixture.popup(), refresh = button(popup, 'Refresh');
    await act(async () => refresh!.focus()!);
    assert.equal(document.activeElement, refresh);
    delayed = true; await click(refresh);
    assert.ok(fixture.flow.store.getSnapshot().loading); assert.equal(fixture.popup(), popup);
    assert.equal(document.activeElement, fixture.search(), 'Refresh transfers focus before disabling its button');
    assert.equal(refresh!.disabled, true);
    // Chromium can drop focus with relatedTarget=null when a focused control
    // becomes disabled during the click; exercise that exact dismissal edge.
    await act(async () => refresh!.dispatchEvent!(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null })));
    assert.equal(fixture.popup(), popup, 'loading Refresh must not be interpreted as outside dismissal');
    await act(async () => complete(branchSource === 'local' ? { ...local, nextCursor: undefined, observedAt: 9, items: [...local.items, { name: 'feature/new', oid: 'new-oid' }] } : { remote: 'upstream', remoteIdentity: 'upstream-id', defaultBranch: 'main', observedAt: 9, items: [{ name: 'main', oid: 'updated-main' }, { name: 'feature/remote', oid: 'updated-feature' }] }));
    assert.equal(fixture.popup(), popup); assert.equal(fixture.flow.store.getSnapshot().loading, false);
    assert.equal(fixture.flow.store.getSnapshot().query, before.query); assert.equal(fixture.flow.store.getSnapshot().branch, before.branch);
    assert.equal(branchItems(fixture.container).length, 1); await click(branchItems(fixture.container)[0]); assert.equal(fixture.popup(), null);
  }
});

test('BranchPicker Escape returns focus and focus dismissal leaves focus outside without another request', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); await click(fixture.branch()); const count = fixture.calls.length;
  await key(fixture.search(), 'Escape'); assert.equal(fixture.popup(), null); assert.equal(document.activeElement, fixture.branch());
  await click(fixture.branch()); await act(async () => fixture.outside.focus()); assert.equal(fixture.popup(), null); assert.equal(document.activeElement, fixture.outside); assert.equal(fixture.calls.length, count);
});

test('BranchPicker keyboard navigation reaches cached choices and supports Home/End/wraparound', async (t: import('node:test').TestContext) => {
  const fixture = await controls(t); await click(fixture.branch()); const items = branchItems(fixture.container), count = fixture.calls.length;
  await key(fixture.search(), 'ArrowDown'); assert.equal(document.activeElement, items[0]);
  await key(items[0], 'ArrowDown'); assert.equal(document.activeElement, items[1]);
  await key(items[1], 'End'); assert.equal(document.activeElement, items[3]);
  await key(items[3], 'ArrowDown'); assert.equal(document.activeElement, items[0]);
  await key(items[0], 'ArrowUp'); assert.equal(document.activeElement, items[3]);
  await key(items[3], 'Home'); assert.equal(document.activeElement, items[0]);
  await key(items[0], 'ArrowDown'); await click(document.activeElement); assert.equal(fixture.popup(), null); assert.equal(fixture.branch()!.textContent, 'main'); assert.equal(fixture.calls.length, count);
});

test('real ChoicePicker keyboard navigation skips disabled choices and dismisses on Escape or lost focus', async (t: import('node:test').TestContext) => {
  const selections: string[] = [];
  function Demo() {
    const [value, setValue] = React.useState('local');
    return React.createElement('div', { className: 'dsh-wt dsh-wt-create-controls' }, React.createElement(real.Styles), React.createElement(real.ChoicePicker, {
      label: 'Thread mode', value, items: [{ value: 'local', label: 'Local' }, { value: 'blocked', label: 'Unavailable', disabled: true }, { value: 'new', label: 'New worktree' }], onChange(next: string) { selections.push(next); setValue(next); },
    }));
  }
  const fixture = await mount(t, React.createElement(Demo)), trigger = button(fixture.container, 'Thread mode'); await click(trigger);
  let items = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')]; assert.equal(document.activeElement, items[0]);
  await key(items[0], 'ArrowDown'); assert.equal(document.activeElement, items[2]); await key(items[2], 'ArrowDown'); assert.equal(document.activeElement, items[0]);
  await key(items[0], 'End'); assert.equal(document.activeElement, items[2]); await key(items[2], 'Home'); assert.equal(document.activeElement, items[0]);
  await key(items[0], 'Escape'); assert.equal(fixture.container.querySelector('[role=menu]'), null); assert.equal(document.activeElement, trigger); assert.deepEqual(selections, []);
  await click(trigger); items = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')]; await click(items[2]); assert.equal(trigger!.textContent, 'New worktree'); assert.deepEqual(selections, ['new']);
  await click(trigger); assert.equal(document.activeElement.textContent, '✓New worktree'); await act(async () => fixture.outside.focus()); assert.equal(fixture.container.querySelector('[role=menu]'), null); assert.equal(document.activeElement, fixture.outside);
});
