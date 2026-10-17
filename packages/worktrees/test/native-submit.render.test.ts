import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import vm from 'node:vm';
import React from 'react';
import { JSDOM } from 'jsdom';

/** The installed native client is evaluated in a VM; only the inspected seam crosses that boundary. */
interface VmModule { id: string; factory(require: (name: string) => unknown): unknown }

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = new Map<string, PropertyDescriptor | undefined>();
const browserGlobals: Record<string, unknown> = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: () => void) => { setTimeout(callback, 0); return 0; },
  navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
after(() => {
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

// React DOM and the target's schema/runtime imports are loaded only after the
// JSDOM globals exist; the shell, editor and submit machine are the shipped code.
const [reactDom, jsxRuntime, zod, cordis] = await Promise.all([
  import('react-dom'), import('react/jsx-runtime'), import('zod'), import('@deepseek-ai/cordis'),
]);
const require = createRequire(import.meta.url);
const targetEntry = require.resolve('@deepseek-ai/dsh-client-ui-conversation/client');
const targetManifest = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json'), 'utf8')) as { version?: string };
const targetVersion = required(targetManifest.version);
assert.equal(targetVersion, '0.2.1-rc.2', 'the native-shell harness is pinned to the guarded target');

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function moduleOf(value: unknown): VmModule {
  assert.ok(typeof value === 'object' && value !== null);
  const candidate = value as { id?: unknown; factory?: unknown };
  assert.equal(typeof candidate.id, 'string');
  assert.equal(typeof candidate.factory, 'function');
  return value as VmModule;
}

interface ShellSnapshot {
  draft: string; draftRev: number; attachmentIds: string[]; phase: string;
  occurrences: { source: string; ref: string; offset: number; length: number; label: string; clipboardText: string }[];
  queue: unknown[];
}
interface NativeShell {
  snapshot: ShellSnapshot;
  notices: { getSnapshot(): { level?: string; text?: string; seq?: number } | null };
  setDraft(input: unknown): void;
  addAttachments(ids: string[]): boolean;
  submit(mode: 'queue' | 'steer'): void;
  dispose(): string[];
}
interface NativeSeam {
  SessionInputShell: new (deps: ShellDeps) => NativeShell;
  resolveDraftInput(input: unknown): unknown;
}
interface TriggerController {
  adjudicate(draft: string, signal: AbortSignal, metadata: { attachments: number }): Promise<unknown>;
  serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string>;
  track(...args: unknown[]): void;
  arbitrate(key: string, composing: boolean): string;
  onSpace(): boolean;
  lexicon: { getSnapshot(): Map<string, unknown>; subscribe(listener: () => void): () => void };
}
type SubmitOutcome = { kind: 'success' } | { kind: 'error'; text?: string };
interface ShellDeps {
  actx: object;
  defaultSink(text: string, ids: string[], mode: 'queue' | 'steer', signal: AbortSignal): Promise<SubmitOutcome>;
  inputTriggers(): TriggerController | undefined;
  inbox: { getSnapshot(): { 'next-turn': unknown[] }; subscribe(listener: () => void): () => void };
  commandAttachments: { serialize(ids: string[]): Promise<unknown[]>; release(ids: string[]): void; unsupportedNotice(token: string): string };
  submissionState(): undefined;
}
interface Binding { ctx: object; session: { getSnapshot(): unknown; subscribe(listener: () => void): () => void } }
type Choice = { mode: 'new' } | { mode: 'local' };
interface SinkHooks {
  capture(signal: AbortSignal, controller: AbortController): Choice;
  submit(choice: Choice, text: string, ids: string[], mode: 'queue' | 'steer', signal: AbortSignal): Promise<SubmitOutcome>;
  settled(choice: Choice, error?: unknown): void;
  error(error: unknown): string;
}
interface Lease { abi: string; close(): Promise<void>; cancelNew(): void }
interface PluginProtocol {
  NATIVE_SUBMIT_ABI: string;
  leaseNativeSink(input: unknown, binding: unknown, hooks: SinkHooks): Lease;
}

function seamOf(value: unknown): NativeSeam {
  assert.ok(typeof value === 'object' && value !== null);
  const seam = (value as { __nativeSubmitTest?: unknown }).__nativeSubmitTest;
  assert.ok(typeof seam === 'object' && seam !== null);
  const candidate = seam as { SessionInputShell?: unknown; resolveDraftInput?: unknown };
  assert.equal(typeof candidate.SessionInputShell, 'function');
  assert.equal(typeof candidate.resolveDraftInput, 'function');
  return seam as NativeSeam;
}

function protocolOf(value: unknown): PluginProtocol {
  assert.ok(typeof value === 'object' && value !== null);
  const protocol = (value as { protocol?: unknown }).protocol;
  assert.ok(typeof protocol === 'object' && protocol !== null);
  const candidate = protocol as { NATIVE_SUBMIT_ABI?: unknown; leaseNativeSink?: unknown };
  assert.equal(typeof candidate.NATIVE_SUBMIT_ABI, 'string');
  assert.equal(typeof candidate.leaseNativeSink, 'function');
  return protocol as PluginProtocol;
}

// Only module-boundary externals are stubbed. The installed SessionInputShell,
// DraftEditorRuntime, SubmitMachine, serialization and rollback stay native.
const inert = () => null;
const inertModule = new Proxy({}, { get: () => inert });
const storeStub = {
  createSnapshotStore<T>(initial: T) {
    let value = initial; const listeners = new Set<() => void>();
    return {
      getSnapshot: () => value,
      subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
      set(next: T) { value = next; for (const listener of [...listeners]) listener(); },
    };
  },
  notifySubscribers(listeners: Set<() => void>) { for (const listener of [...listeners]) listener(); },
  defineStore<T>(factory: (() => T) | T) { return typeof factory === 'function' ? (factory as () => T)() : factory; },
};

const targetSource = await readFile(targetEntry, 'utf8');
const seamAnchor = 'exports.apply = apply;';
assert.equal(targetSource.split(seamAnchor).length - 1, 1, 'the installed target has exactly one export seam');
let targetModule: unknown;
const targetWindow: { __ModuleLoader__: { load(value: unknown): void } } = Object.create(dom.window) as { __ModuleLoader__: { load(value: unknown): void } };
targetWindow.__ModuleLoader__ = { load(value) { targetModule = value; } };
vm.runInNewContext(targetSource.replace(seamAnchor, `exports.__nativeSubmitTest = { SessionInputShell, resolveDraftInput };\n\t\t${seamAnchor}`), {
  window: targetWindow, document: dom.window.document, AbortController, AbortSignal, crypto: webcrypto,
  setTimeout, clearTimeout, queueMicrotask, console, TextEncoder, TextDecoder,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
  navigator: dom.window.navigator, getComputedStyle: dom.window.getComputedStyle,
  requestAnimationFrame: (callback: () => void) => { setTimeout(callback, 0); return 0; },
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
}, { filename: targetEntry });
const target = moduleOf(targetModule);
assert.equal(target.id, '@deepseek-ai/dsh-client-ui-conversation');
const externals: Record<string, unknown> = {
  react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': reactDom, zod, '@deepseek-ai/cordis': cordis,
  '@deepseek-ai/dsh-client-store': storeStub,
  '@deepseek-ai/dsh-client-ui-primitives': inertModule,
  '@deepseek-ai/dsh-client-ui-slots': inertModule,
};
const seam = seamOf(target.factory(name => {
  const value = externals[name];
  if (value === undefined) throw new Error(`Unexpected target external ${name}`);
  return value;
}));

const pluginEntry = new URL('../dist/client.js', import.meta.url);
const pluginSource = await readFile(pluginEntry, 'utf8');
let pluginModule: unknown;
vm.runInNewContext(pluginSource, {
  window: { __ModuleLoader__: { load(value: unknown) { pluginModule = value; } } },
  AbortController, AbortSignal, crypto: webcrypto, console, setTimeout, clearTimeout, queueMicrotask,
}, { filename: pluginEntry.pathname });
const plugin = moduleOf(pluginModule);
assert.equal(plugin.id, '@1yefuwang1/dsh-worktrees');
const protocol = protocolOf(plugin.factory(name => {
  if (name === 'react') return React;
  throw new Error(`Unexpected plugin external ${name}`);
}));
assert.equal(protocol.NATIVE_SUBMIT_ABI, '0.2.1-rc.2/default-sink-v1', 'the plugin adapter names the exact installed target ABI');

interface HarnessEvent {
  kind: string; text?: string; ids?: string[]; mode?: string; aborted?: boolean;
  draft?: string; attachments?: number; source?: string; ref?: string; ok?: boolean;
}
interface HarnessMid { draft: string; attachmentIds: string[] }
interface Harness {
  shell: NativeShell; deps: ShellDeps; events: HarnessEvent[]; mid: HarnessMid[]; lease: Lease;
  originalSink: ShellDeps['defaultSink']; originalTriggers: ShellDeps['inputTriggers'];
  close(): Promise<void>;
}

function harness(): Harness {
  const events: HarnessEvent[] = [];
  const mid: HarnessMid[] = [];
  const binding: Binding = { ctx: {}, session: { getSnapshot: () => ({}), subscribe: () => () => {} } };
  const controller: TriggerController = {
    async adjudicate(draft, signal, metadata) {
      events.push({ kind: 'adjudicate', draft, attachments: metadata.attachments, aborted: signal.aborted });
      return undefined;
    },
    async serializeReference(source, ref, signal) {
      assert.equal(signal.aborted, false);
      events.push({ kind: 'serialize', source, ref });
      return `[${source}:${ref}]`;
    },
    track() {},
    arbitrate() { return 'pass'; },
    onSpace() { return false; },
    lexicon: { getSnapshot: () => new Map(), subscribe: () => () => {} },
  };
  const originalSink: ShellDeps['defaultSink'] = async (text, ids, mode, signal) => {
    events.push({ kind: 'native-sink', text, ids: [...ids], mode, aborted: signal.aborted });
    return { kind: 'success' };
  };
  const originalTriggers: ShellDeps['inputTriggers'] = () => controller;
  const deps: ShellDeps = {
    actx: binding.ctx,
    defaultSink: originalSink,
    inputTriggers: originalTriggers,
    inbox: { getSnapshot: () => ({ 'next-turn': [] }), subscribe: () => () => {} },
    commandAttachments: { async serialize() { return []; }, release() {}, unsupportedNotice() { return ''; } },
    submissionState: () => undefined,
  };
  const shell = new seam.SessionInputShell(deps);
  const hooks: SinkHooks = {
    capture(signal) { events.push({ kind: 'capture', aborted: signal.aborted }); return { mode: 'new' }; },
    async submit(choice, text, ids, mode, signal) {
      assert.equal(choice.mode, 'new');
      events.push({ kind: 'submit', text, ids: [...ids], mode, aborted: signal.aborted });
      // The commit-draft effect runs synchronously after the sink is started;
      // capture the cleared input on the next microtask, before returning the refusal.
      await Promise.resolve();
      mid.push({ draft: shell.snapshot.draft, attachmentIds: [...shell.snapshot.attachmentIds] });
      return { kind: 'error', text: 'worktree refused' };
    },
    settled(choice, error) { events.push({ kind: 'settled', ok: choice.mode === 'new' && error === undefined }); },
    error(error) { return error instanceof Error ? error.message : String(error); },
  };
  const lease = protocol.leaseNativeSink(shell, binding, hooks);
  assert.equal(lease.abi, protocol.NATIVE_SUBMIT_ABI);
  return { shell, deps, events, mid, lease, originalSink, originalTriggers, close: () => lease.close() };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

test('the real target shell serializes a reference chip and restores it after a refused worktree send', async t => {
  const h = harness();
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft(seam.resolveDraftInput({
    text: '@a.ts please review',
    references: [{ source: 'file', ref: '@a.ts', offset: 0, length: 5, label: 'a.ts', clipboardText: '@a.ts', appearance: 'file' }],
  }));
  assert.equal(h.shell.addAttachments(['attachment-1']), true);
  h.shell.submit('queue');
  await settle();

  assert.deepEqual(h.events.map(event => event.kind), ['capture', 'serialize', 'submit', 'settled']);
  const serialize = h.events.find(event => event.kind === 'serialize');
  assert.equal(serialize?.source, 'file'); assert.equal(serialize?.ref, '@a.ts');
  const submit = h.events.find(event => event.kind === 'submit');
  assert.equal(submit?.text, '[file:@a.ts] please review');
  assert.deepEqual(submit?.ids, ['attachment-1']);
  assert.equal(submit?.mode, 'queue'); assert.equal(submit?.aborted, false);
  assert.equal(h.mid.length, 1, 'the sink was entered exactly once');
  assert.equal(h.mid[0]?.draft, '', 'the committed draft is cleared before the refusal restores it');
  assert.deepEqual(h.mid[0]?.attachmentIds, [], 'committed attachments are cleared before the refusal restores them');
  assert.equal(h.events.find(event => event.kind === 'settled')?.ok, true);

  const snapshot = h.shell.snapshot;
  assert.equal(snapshot.draft, '@a.ts please review');
  assert.deepEqual([...snapshot.attachmentIds], ['attachment-1']);
  assert.equal(snapshot.occurrences.some(item => item.source === 'file' && item.ref === '@a.ts'), true);
  assert.equal(snapshot.phase, 'plain');
  assert.equal(h.shell.notices.getSnapshot()?.text, 'worktree refused');

  await h.close();
  assert.equal(h.deps.defaultSink, h.originalSink, 'close restores the native default sink');
  assert.equal(h.deps.inputTriggers, h.originalTriggers, 'close restores the native trigger controller');
});

test('the real target shell adjudicates a leading command draft through the lease and preserves it after refusal', async t => {
  const h = harness();
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/permission danger-full-access');
  h.shell.submit('queue');
  await settle();

  assert.deepEqual(h.events.map(event => event.kind), ['capture', 'adjudicate', 'submit', 'settled']);
  const adjudicate = h.events.find(event => event.kind === 'adjudicate');
  assert.equal(adjudicate?.draft, '/permission danger-full-access');
  assert.equal(adjudicate?.attachments, 0); assert.equal(adjudicate?.aborted, false);
  const submit = h.events.find(event => event.kind === 'submit');
  assert.equal(submit?.text, '/permission danger-full-access'); assert.equal(submit?.mode, 'queue');
  assert.equal(h.mid.length, 1); assert.equal(h.mid[0]?.draft, '', 'the committed command draft is cleared before restore');
  assert.equal(h.events.find(event => event.kind === 'settled')?.ok, true);
  assert.equal(h.shell.snapshot.draft, '/permission danger-full-access');
  assert.equal(h.shell.notices.getSnapshot()?.text, 'worktree refused');
});

test('the real target shell restores an attachment-only draft after a refused send', async t => {
  const h = harness();
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('');
  assert.equal(h.shell.addAttachments(['attachment-only']), true);
  h.shell.submit('queue');
  await settle();

  const submit = h.events.find(event => event.kind === 'submit');
  assert.equal(submit?.text, ''); assert.deepEqual(submit?.ids, ['attachment-only']); assert.equal(submit?.mode, 'queue');
  assert.equal(h.mid.length, 1); assert.deepEqual(h.mid[0]?.attachmentIds, [], 'the attachment-only send is cleared before restore');
  assert.equal(h.events.find(event => event.kind === 'settled')?.ok, true);
  assert.deepEqual([...h.shell.snapshot.attachmentIds], ['attachment-only']);
  assert.equal(h.shell.notices.getSnapshot()?.text, 'worktree refused');
});
