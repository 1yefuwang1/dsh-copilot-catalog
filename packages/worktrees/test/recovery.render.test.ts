import type { WorktreeCleanupSummary, WorktreeReopenInfo } from '../dist/types.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { after, test } from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { exposeClient, staticClientSource } from './client-artifact.js';

type Selector = (snapshot: VmValue) => VmValue; // React stub hook inputs cross the VM contract.

type Listener = () => void;
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
interface SessionItem { retainedBy: Record<string, number>; title?: string; blank?: boolean; updatedAt?: number; }
interface SessionList { byId: Record<string, SessionItem>; }
// The client script is evaluated in a separate VM realm and deliberately exposes
// unexported implementations; dynamic values stop at this inspected VM contract.
type VmValue = any;
type VmModule = { id: string; factory: (require: (name: string) => unknown) => VmValue };









const client = new URL('../dist/client.js', import.meta.url);
// Static assertions ignore emitted line wrapping; VM execution keeps the original text.
function staticSource(text: string): string { return text.replace(/\s+/g, ' '); }
const artifact = await readFile(client, 'utf8');
const source = staticClientSource; // static-only assertions, not behavioral execution
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
after(() => { dom.window.close(); for (const [name, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
let module!: VmModule;
vm.runInNewContext(exposeClient(artifact, ['RecoveryNotice', 'Manager', 'RecordCard', 'NewWorktreeControls', 'Styles', 'en', 'zh']), { window: { __ModuleLoader__: { load(value: VmModule) { module = value; } } }, AbortController, AbortSignal, crypto: webcrypto }, { filename: client.pathname });
const plugin = module.factory((name: string) => { assert.equal(name, 'react'); return React; }), real = plugin.renderTest;
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const cleanup: WorktreeCleanupSummary = { phase: 'collected', inactivityDays: 10, lastActivityAt: 100, eligibleAfter: 200, reclaimedAt: 300, originalFolder: '/repo/project', recoveryRef: 'refs/dsh-worktrees/tree/gc-head', reason: null };
const base: WorktreeReopenInfo = { sourceSessionId: 'old', worktreeId: 'tree', cleanup, continuationSessionId: null, originalFolder: '/repo/project', repository: { root: '/repo', commonDir: '/repo/.git', head: A, branch: 'main' }, branches: [{ name: 'feature/retained', oid: B }], nextCursor: 'more-branches', observedAt: 10, revision: 1 };
const success = <T>(data: T) => ({ ok: true, value: { v: 1, ok: true, data } });
function observable<T>(initial: T) { let value = initial; const listeners = new Set<Listener>(); return { getSnapshot: () => value, subscribe(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next: T) { value = next; for (const fn of [...listeners]) fn(); } }; }
const translate = (language: 'en' | 'zh') => (key: string, params: Record<string, unknown> = {}) => (real[language][key] || key).replace(/\{(\w+)\}/g, (_: string, field: string) => String(params[field] ?? '{' + field + '}'));
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
const button = (container: ParentNode, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label);
async function click(target: Element | null | undefined) { assert.ok(target, 'real render click target'); await act(async () => (target as HTMLElement).click()); }
async function search(target: HTMLInputElement | null, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(target, value); target!.dispatchEvent!(new dom.window.Event('input', { bubbles: true })); }); }

async function fixture(t: import('node:test').TestContext, { language = 'en', initial = base, refusal = false, notice = true, blank = false }: { language?: 'en' | 'zh'; initial?: WorktreeReopenInfo; refusal?: boolean; notice?: boolean; blank?: boolean } = {}) {
  const calls: { request: MockRequest; after?: number; signal: AbortSignal }[] = [], opens: string[] = [], references: { sessionId: string; releases?: number; released?: boolean; release: () => void }[] = [], waits: { resolve: (value: unknown) => void; request: MockRequest; after: number; signal: AbortSignal }[] = [], blocks = new Map<string, ReturnType<typeof observable<ComposerBlock>>>(); let latest = initial, navigation: AbortController | undefined;
  const layout = { beginNavigation() { navigation?.abort(); navigation = new AbortController(); return navigation.signal; }, selectPanel(_id?: string | null) { navigation?.abort(); } };
  const sessions = observable<SessionList>({ byId: { old: { retainedBy: { mainView: 1 }, blank } } }), generation = observable<{ id: number } | undefined>({ id: 1 });
  const record = { id: 'tree', operationId: 'operation', repoRoot: '/repo', commonDir: '/repo/.git', checkoutRoot: '/managed/tree', effectiveCwd: '/managed/tree/project', remote: 'origin', remoteBranch: 'main', baseOid: A, branch: 'feature/retained', sessionIds: ['old'], protected: false, archived: false, state: 'missing', cleanup: initial.cleanup };
  const projects = { store: observable({ records: [record], bindings: [], projects: [] }), context: () => undefined };
  const block = (id: string) => { if (!blocks.has(id)) blocks.set(id, observable<ComposerBlock>(undefined)); return blocks.get(id)!; };
  const runtime = {
    workspaces: { list: observable({ phase: 'ready', items: [], archivedSessionIds: [], pinnedSessionIds: [] }) },
    sessions: { list: sessions, retain(id: string, options: { source: string }) { assert.equal(options.source, 'controllerOperation'); const reference = { sessionId: id, ready: Promise.resolve({ ctx: {} }), released: false, release() { this.released = true; } }; references.push(reference); return reference; } },
    conversation: { blocks: { storeFor: block, set: (id: string, value: ComposerBlock) => block(id).publish(value) }, input: { for() { assert.fail('recovery cannot replace the public editor or send draft content'); } } },
    layout,
    uiWorkspace: { openSession(id: string) { opens.push(id); sessions.publish({ byId: { old: { retainedBy: { mainView: id === 'old' ? 1 : 0 }, blank }, [id]: { retainedBy: { mainView: 1 }, blank: false } } }); layout.selectPanel(null); } },
    connection: { generation, rpc: { async call(...[channel, endpoint, payload, signal]: RpcArgs) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'dsh-worktrees/recovery', 'GC UI cannot resolve historical Agent via normal worktree requests'); calls.push({ request: payload.request, after: payload.after, signal });
      const request = payload.request; assert.equal(Object.hasOwn(request, 'after'), false);
      if (request.action === 'reopen') {
        if (refusal) { latest = { ...latest, pendingSessionId: 'real-local-permissions' }; return { ok: true, value: { v: 1, ok: false, error: { code: 'FULL_ACCESS_REQUIRED', message: 'Use standard Local permission controls.' } } }; }
        latest = { ...latest, continuationSessionId: 'exact-local', recoveredBranch: request.localBranch };
        return success({ sourceSessionId: request.sourceSessionId, sessionId: 'exact-local', workspaceId: 'local-folder', worktreeId: 'tree', cwd: '/repo/project', branch: request.localBranch, cleanup });
      }
      if (payload.after !== undefined) return new Promise((resolve, reject) => { waits.push({ resolve, request, after: payload.after!, signal }); signal.addEventListener('abort', () => reject(Object.assign(Error('fixture cancellation'), { name: 'AbortError' })), { once: true }); });
      if (request.cursor) return success({ ...latest, sourceSessionId: request.sourceSessionId, branches: [{ name: 'release', oid: A }], nextCursor: undefined });
      return success({ ...latest, sourceSessionId: request.sourceSessionId });
    } } },
  };
  const recovery = plugin.protocol.createRecoveryStore(runtime, translate(language), projects);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = (id: string) => root.render(React.createElement(real.RecoveryNotice, { sessionId: id, recovery, t: translate(language) }))!;
  await act(async () => { if (notice) render('old'); await flush(); });
  t.after(async () => { await act(async () => { root.unmount(); recovery.dispose(); await flush(); }); container.remove(); });
  return { container, root, runtime, recovery, projects, calls, opens, references, block, render, async event(info: WorktreeReopenInfo) { latest = info; const wait = waits.findLast(entry => !entry.signal.aborted); assert.ok(wait); await act(async () => { wait.resolve(success({ ...info, sourceSessionId: wait.request.sourceSessionId })); await flush(); }); } };
}

test('real recovery warning is persistent/localized, has no automatic branch selection and searches loaded branches without requests', async (t: import('node:test').TestContext) => {
  const f = await fixture(t); assert.match(f.container.textContent, /Unsaved files were discarded/); assert.match(f.container.textContent, /Git branches and conversation history were retained/); assert.match(f.container.textContent, /cannot safely transfer the structured draft/);
  assert.equal(f.container.querySelectorAll('input[type=radio]:checked').length, 0); assert.equal(button(f.container, real.en.gcContinue)!.disabled, true); assert.ok(f.block('old').getSnapshot());
  assert.match(f.container.textContent, /Current Local branch/); assert.match(f.container.textContent, /Retained worktree branch/); assert.match(f.container.textContent, /No worktree changes are applied/);
  const count = f.calls.length; await search(f.container.querySelector<HTMLInputElement>('input[type=search]'), 'feature'); assert.equal(f.calls.length, count); assert.equal(f.container.querySelectorAll('input[type=radio]').length, 1);
  await click(f.container.querySelector('input[type=radio]')); assert.equal(button(f.container, real.en.gcContinue)!.disabled, false);
  await click(button(f.container, real.en.gcReadOnly)); assert.match(f.container.textContent, /History remains available/); assert.equal(f.container.querySelector('input[type=radio]'), null); assert.ok(f.block('old').getSnapshot());
  await click(button(f.container, real.en.gcRetry)); assert.equal(f.container.querySelectorAll('input[type=radio]:checked').length, 0);
});

test('explicit Continue opens exact target once, retains original structured draft reference and exposes honest history action', async (t: import('node:test').TestContext) => {
  const f = await fixture(t); await click([...f.container.querySelectorAll('label')].find((item) => item.textContent.includes('feature/retained'))!.querySelector('input'));
  await click(button(f.container, real.en.gcContinue)); assert.deepEqual(f.opens, ['exact-local']); assert.equal(f.references[0]!.released, false);
  const mutation = f.calls.find(call => call.request.action === 'reopen')!.request; assert.equal(mutation.localBranch, 'feature/retained'); assert.equal(mutation.localOid, B);
  await act(async () => { f.render('exact-local'); await flush(); }); assert.ok(button(f.container, real.en.gcHistoryDraft)); assert.match(f.container.textContent, /Local branch chosen: feature\/retained/);
  await click(button(f.container, real.en.gcHistoryDraft)); await act(async () => { f.render('old'); await flush(); }); assert.deepEqual(f.opens, ['exact-local', 'old'], 'explicit history cannot auto-redirect back to Local'); assert.ok(f.block('old').getSnapshot());
});

test('late ready lifecycle keeps the explicit Open action without overriding newer native navigation', async (t: import('node:test').TestContext) => {
  const f = await fixture(t), native = f.runtime.layout.beginNavigation();
  await f.event({ ...base, continuationSessionId: 'exact-local', recoveredBranch: 'feature/retained', revision: 2 });
  assert.deepEqual(f.opens, []); assert.equal(native.aborted, false);
  assert.ok(button(f.container, real.en.open)); assert.equal(f.container.querySelectorAll('input[type=radio]').length, 0);
  assert.equal(f.calls.some(call => call.request.action === 'reopen'), false);
  await click(button(f.container, real.en.open));
  assert.equal(native.aborted, true, 'only a newer explicit recovery click supersedes native intent');
  assert.deepEqual(f.opens, ['exact-local']); assert.equal(f.references[0]!.released, false);
});

test('pending permission recovery opens only the real staged Local ID with normal controls, retaining the old history reference', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { refusal: true }); await click(f.container.querySelector('input[type=radio]')); await click(button(f.container, real.en.gcContinue));
  assert.match(f.container.textContent, /FULL_ACCESS_REQUIRED/); assert.match(f.container.textContent, /real Local continuation is staged/); assert.equal(f.opens.length, 0);
  await click(button(f.container, real.en.gcPermissions)); assert.deepEqual(f.opens, ['real-local-permissions']); assert.equal(f.references[0]!.released, false);
  for (const call of f.calls) assert.deepEqual(Object.keys(call.request).filter((key: string) => /actor|permission|sandbox/i.test(key)), []);
});

test('collecting and uncertain cleanup truthfully block sending without claiming files already discarded', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { initial: { ...base, cleanup: { ...cleanup, phase: 'planned', reclaimedAt: null }, branches: undefined, repository: undefined, nextCursor: undefined } });
  assert.match(f.container.textContent, /cleanup is in progress/); assert.doesNotMatch(f.container.textContent, /files were discarded/); assert.equal(button(f.container, real.en.gcContinue), undefined); assert.ok(f.block('old').getSnapshot());
  await f.event({ ...base, cleanup: { ...cleanup, phase: 'recovery-required', reclaimedAt: null }, revision: 2 }); assert.match(f.container.textContent, /may be partly removed/); assert.doesNotMatch(f.container.textContent, /files were discarded/); assert.ok(f.block('old').getSnapshot());
});

test('detached Local uses an explicit HEAD radio and Chinese recovery text stays localized', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { language: 'zh', initial: { ...base, repository: { ...base.repository!, branch: null }, branches: [{ name: 'HEAD', oid: A }], nextCursor: undefined } });
  assert.match(f.container.textContent, /未保存的文件已删除/); assert.match(f.container.textContent, /分离检出 · HEAD/); assert.equal(f.container.querySelectorAll('input[type=radio]:checked').length, 0); assert.equal(button(f.container, real.zh.gcContinue)!.disabled, true);
  await click(f.container.querySelector('input[type=radio]')); assert.equal(f.recovery.store.getSnapshot().selected.name, 'HEAD'); assert.equal(f.recovery.store.getSnapshot().selected.oid, A);
});

test('recovery styling uses theme aliases only and slot registration is root-owned', () => {
  const css = source.slice(source.indexOf('.dsh-wt-recovery{'), source.indexOf('@media(prefers-reduced-motion:reduce)'));
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i); assert.ok([...css.matchAll(/var\((--[^),]+)/g)].every(match => match[1]!.startsWith!('--dsw-alias-')));
  assert.match(staticSource(source), /const recovery = createRecoveryStore\(ctx/); assert.match(staticSource(source), /recovery\.dispose\(\)/); assert.match(staticSource(source), /PANEL \+ '-recovery', order: 10 \}, RecoveryNotice/);
});

test('blank historical New-worktree controls never probe or adapt its old Agent', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { notice: false, blank: true });
  const state = observable({ sessionId: 'old', mode: 'local' }), repository = observable({ status: null });
  const flow = { store: state, observe() { assert.fail('historical Agent adapter must not be installed'); } }, repositories = { store: repository, ensure() { assert.fail('historical Agent cannot be probed through normal worktree status'); }, withdraw() {} };
  await act(async () => { f.root.render(React.createElement(real.NewWorktreeControls, { sessionId: 'old', runtime: f.runtime, projects: f.projects, recovery: f.recovery, flow, repositories, t: translate('en'), useSession: (select: Selector) => select({ blank: true, subagent: null, openState: 'open', removed: false, running: false, promptAttempted: false, awaitingFirstTurn: false, pendingSubmissions: [] }), useInput: (select: Selector) => select({ phase: 'plain', draft: '', attachmentIds: [], queue: [] }), usePanelInfo: (select: Selector) => select({ activePanelId: undefined }), useWorkspaces: (select: Selector) => select({ items: [] }) })); await flush(); });
  assert.equal(f.container.querySelector('button'), null); assert.ok(f.calls.every(call => call.request.action === 'reopen-info'));
});

test('Manager waits for selected recovery facts before any normal actor-backed request', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { notice: false }); const count = f.calls.length;
  const unknown = { store: observable({ sessionId: undefined, info: null, loading: false }) };
  await act(async () => { f.root.render(React.createElement(real.Manager, { runtime: f.runtime, projects: f.projects, recovery: unknown, t: translate('en'), useSessions: (select: Selector) => select(f.runtime.sessions.list.getSnapshot()), usePanelInfo: (select: Selector) => select({ activePanelId: 'dsh-worktrees' }), useSessionStatus: (select: Selector) => select(new Map()) })); await flush(); });
  assert.equal(f.calls.length, count); assert.match(f.container.textContent, /Worktree reclaimed/);
});

test('Manager cannot resolve a reclaimed selected Agent through normal execute RPC', async (t: import('node:test').TestContext) => {
  const f = await fixture(t, { notice: false });
  await act(async () => { f.root.render(React.createElement(real.Manager, { runtime: f.runtime, projects: f.projects, recovery: f.recovery, t: translate('en'), useSessions: (select: Selector) => select(f.runtime.sessions.list.getSnapshot()), usePanelInfo: (select: Selector) => select({ activePanelId: 'dsh-worktrees' }), useSessionStatus: (select: Selector) => select(new Map()) })); await flush(); });
  assert.match(f.container.textContent, /Worktree reclaimed/); assert.match(f.container.textContent, /Unsaved files were discarded/);
  assert.ok([...f.container.querySelectorAll('button')].filter((item) => ['Create branch here', 'Open conversation', 'Check operation status'].includes(item.textContent)).every((item) => item.disabled));
  assert.ok(f.calls.every(call => ['reopen-info', 'reopen'].includes(call.request.action)));
});
