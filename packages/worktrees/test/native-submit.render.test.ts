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
assert.equal(targetVersion, '0.2.2-rc.1', 'the native-shell harness is pinned to the guarded target');

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
  state: { subscribe(listener: () => void): () => void };
  notices: { getSnapshot(): { level?: string; text?: string; seq?: number } | null };
  setDraft(input: unknown): void;
  addAttachments(ids: string[]): boolean;
  submit(mode: 'queue' | 'steer'): void;
  dispose(): string[];
  beginCommand(claim: { name: string; token: string; submit(): Promise<SubmitOutcome> }, span: { start: number; end: number; draftRev: number }): boolean;
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
// Lexer spelling for a synthetic native permission command, not a credential.
const permissionCommand = '/permission ';
interface ShellDeps {
  actx: object;
  defaultSink(text: string, ids: readonly string[], mode: 'queue' | 'steer', signal: AbortSignal, accept: () => void): Promise<SubmitOutcome>;
  inputTriggers(): TriggerController | undefined;
  inbox: { getSnapshot(): { 'next-turn': unknown[] }; subscribe(listener: () => void): () => void };
  commandAttachments: { serialize(ids: string[]): Promise<unknown[]>; release(ids: string[]): void; unsupportedNotice(token: string): string };
  submissionState(): unknown;
  messageSubmitted?(submission: { state?: unknown }): void;
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
assert.equal(protocol.NATIVE_SUBMIT_ABI, '0.2.2-rc.1/default-sink-v3', 'the plugin adapter names the exact installed target ABI');

interface HarnessEvent {
  kind: string; text?: string; ids?: string[]; mode?: string; aborted?: boolean;
  draft?: string; attachments?: number; source?: string; ref?: string; ok?: boolean;
}
interface HarnessMid { draft: string; attachmentIds: string[] }
interface Harness {
  shell: NativeShell; deps: ShellDeps; events: HarnessEvent[]; mid: HarnessMid[]; lease: Lease; submissions: { state?: unknown }[];
  originalSink: ShellDeps['defaultSink']; originalTriggers: ShellDeps['inputTriggers']; originalSubmission: ShellDeps['submissionState'];
  close(): Promise<void>;
}

function harness(options: { submit?: SinkHooks['submit']; capture?: SinkHooks['capture']; facts?: unknown; factsError?: Error; adjudicate?: TriggerController['adjudicate']; onFacts?: () => void } = {}): Harness {
  const events: HarnessEvent[] = [];
  const mid: HarnessMid[] = [];
  const submissions: { state?: unknown }[] = [];
  const binding: Binding = { ctx: {}, session: { getSnapshot: () => ({}), subscribe: () => () => {} } };
  const controller: TriggerController = {
    async adjudicate(draft, signal, metadata) {
      events.push({ kind: 'adjudicate', draft, attachments: metadata.attachments, aborted: signal.aborted });
      return options.adjudicate?.(draft, signal, metadata);
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
  const originalSink: ShellDeps['defaultSink'] = async (text, ids, mode, signal, _accept) => {
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
    messageSubmitted(submission) { submissions.push(submission); },
    submissionState() { assert.equal(this, deps); options.onFacts?.(); if (options.factsError) throw options.factsError; return options.facts; },
  };
  const originalSubmission = deps.submissionState;
  const shell = new seam.SessionInputShell(deps);
  const hooks: SinkHooks = {
    capture(signal, controller) { events.push({ kind: 'capture', aborted: signal.aborted }); return options.capture?.(signal, controller) ?? { mode: 'new' }; },
    async submit(choice, text, ids, mode, signal) {
      if (options.submit) return options.submit(choice, text, ids, mode, signal);
      assert.equal(choice.mode, 'new');
      events.push({ kind: 'submit', text, ids: [...ids], mode, aborted: signal.aborted });
      // The commit-draft effect runs synchronously after the sink is started;
      // capture the cleared input on the next microtask, before returning the refusal.
      await Promise.resolve();
      mid.push({ draft: shell.snapshot.draft, attachmentIds: [...shell.snapshot.attachmentIds] });
      return { kind: 'error', text: 'worktree refused' };
    },
    settled(choice, error) { events.push({ kind: 'settled', ok: choice.mode === 'new' && error === undefined }); },
    error(error) {
      const value = error as { code?: unknown; message?: unknown } | null;
      return typeof value?.code === 'string' ? value.code : typeof value?.message === 'string' ? value.message : String(error);
    },
  };
  const lease = protocol.leaseNativeSink(shell, binding, hooks);
  assert.equal(lease.abi, protocol.NATIVE_SUBMIT_ABI);
  return { shell, deps, events, mid, lease, submissions, originalSink, originalTriggers, originalSubmission, close: () => lease.close() };
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
  // The native transaction owns the draft and its attachments until the sink
  // settles; a refusal never detaches them, so the plugin must not restore them.
  assert.equal(h.mid[0]?.draft, '@a.ts please review', 'the pending native draft stays owned by the shell');
  assert.deepEqual(h.mid[0]?.attachmentIds, ['attachment-1'], 'pending attachments stay owned by the shell');
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
  assert.equal(h.deps.submissionState, h.originalSubmission, 'close restores native submission facts');
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
  assert.equal(h.mid.length, 1); assert.equal(h.mid[0]?.draft, '/permission danger-full-access', 'the pending command draft stays owned by the shell');
  assert.equal(h.events.find(event => event.kind === 'settled')?.ok, true);
  assert.equal(h.shell.snapshot.draft, '/permission danger-full-access');
  assert.equal(h.shell.notices.getSnapshot()?.text, 'worktree refused');
});

test('a real native claimed command bypasses the model sink even when New route capture was refused', async t => {
  let commands = 0, refused = true;
  const h = harness({ capture() { if (refused) throw Error('route capture refused'); return { mode: 'local' }; },
    adjudicate: async () => ({ claim: { name: 'permission', token: permissionCommand, async submit() { commands++; return { kind: 'success' }; } } }),
  });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/permission danger-full-access'); h.shell.submit('queue'); await settle();
  assert.equal(commands, 1); assert.equal(h.shell.snapshot.draft, '');
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  refused = false; h.shell.setDraft('ordinary Local followup'); h.shell.submit('queue'); await settle();
  assert.equal(h.events.filter(event => event.kind === 'native-sink').length, 1, 'command capture did not leak into a later ordinary gesture');
});

test('an original facts observer can claim the command and its unconsumed capture does not leak', async t => {
  let converted = false, commands = 0, mode: Choice['mode'] = 'new';
  let h!: Harness;
  h = harness({ capture: () => ({ mode }), onFacts() {
    if (converted) return; converted = true;
    assert.equal(h.shell.beginCommand({ name: 'permission', token: permissionCommand, async submit() { commands++; return { kind: 'success' }; } }, { start: 0, end: '/permission'.length, draftRev: h.shell.snapshot.draftRev }), true);
  } });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/permission danger-full-access'); h.shell.submit('queue'); await settle();
  assert.equal(commands, 1); assert.equal(h.events.filter(event => event.kind === 'settled').length, 1);
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  mode = 'local'; h.shell.setDraft('next Local gesture'); h.shell.submit('queue'); await settle();
  assert.equal(h.events.filter(event => event.kind === 'native-sink').length, 1);
});

test('Cancel setup during native adjudication prevents a late ordinary sink and preserves the draft', async t => {
  let release!: (result: undefined) => void;
  const h = harness({ adjudicate: async () => await new Promise<undefined>(resolve => { release = resolve; }) });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/slow-unknown-command'); h.shell.submit('queue');
  h.lease.cancelNew(); await settle();
  assert.equal(h.shell.snapshot.draft, '/slow-unknown-command');
  release(undefined); await settle();
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  assert.equal(h.events.filter(event => event.kind === 'settled').length, 1);
});

test('a handled native command retires its capture without entering a model sink', async t => {
  const h = harness({ adjudicate: async () => 'handled' });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/handled'); h.shell.submit('queue'); await settle();
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  assert.equal(h.events.filter(event => event.kind === 'settled').length, 1);
});

test('a refused route still refuses a slash draft when native adjudication falls through', async t => {
  const h = harness({ capture: () => { throw Error('route capture refused'); } });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('/not-a-command'); h.shell.submit('queue'); await settle();
  assert.equal(h.events.filter(event => event.kind === 'adjudicate').length, 1);
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  assert.equal(h.shell.snapshot.draft, '/not-a-command'); assert.equal(h.shell.notices.getSnapshot()?.text, 'route capture refused');
});

test('attachment-only Send freezes New intent before native facts observers can choose Local', async t => {
  let mode: Choice['mode'] = 'new';
  const facts = { runMode: 'plan', running: false, newSession: true };
  const h = harness({ facts, capture: () => ({ mode }), onFacts: () => { mode = 'local'; } });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  assert.equal(h.shell.addAttachments(['send-time-file']), true);
  h.shell.submit('steer');
  await settle();
  assert.equal(mode, 'local', 'the real native facts observer ran after capture, before the sink');
  assert.equal(h.submissions.length, 1); assert.equal(h.submissions[0]?.state, facts, 'native facts and analytics retain the original snapshot');
  assert.equal(h.events.filter(event => event.kind === 'capture').length, 1);
  assert.equal(h.events.filter(event => event.kind === 'submit').length, 1);
  assert.equal(h.events.some(event => event.kind === 'native-sink'), false);
  assert.equal(h.events.find(event => event.kind === 'submit')?.mode, 'steer');
  assert.deepEqual([...h.shell.snapshot.attachmentIds], ['send-time-file']);
});

test('submission facts failure cannot swallow a capture refusal and silently send Local', async t => {
  const h = harness({ capture: () => { throw Error('capture refused'); }, factsError: Error('native facts unavailable') });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('keep this message');
  h.shell.submit('queue');
  await settle();
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  assert.equal(h.shell.snapshot.draft, 'keep this message');
  assert.equal(h.shell.notices.getSnapshot()?.text, 'capture refused');
});

test('reentrant attachment-only commits fail closed instead of exchanging New and Local targets', async t => {
  let mode: Choice['mode'] = 'new', nested = false;
  const h = harness({ capture: () => ({ mode }), onFacts() {
    if (nested) return; nested = true; mode = 'local';
    assert.equal(h.shell.addAttachments(['inner-file']), true);
    h.shell.submit('queue');
  } });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  assert.equal(h.shell.addAttachments(['outer-file']), true);
  h.shell.submit('steer');
  await settle();
  assert.equal(nested, true);
  assert.equal(h.events.some(event => ['submit', 'native-sink'].includes(event.kind)), false);
  assert.deepEqual(new Set(h.shell.snapshot.attachmentIds), new Set(['outer-file', 'inner-file']));
  assert.match(h.shell.notices.getSnapshot()?.text ?? '', /reentrant-native-submit/);
  assert.equal(h.events.filter(event => event.kind === 'settled').length, 1, 'the single acquired New capture releases exactly once');
});

test('a second gesture during a pending send is refused by the native transaction and captures once', async t => {
  const flights: { text: string; resolve(outcome: SubmitOutcome): void }[] = [];
  const h = harness({ submit: async (_choice, text) => await new Promise<SubmitOutcome>(resolve => { flights.push({ text, resolve }); }) });
  t.after(async () => { await h.close(); h.shell.dispose(); });
  h.shell.setDraft('first pending message'); h.shell.submit('queue');
  await settle();
  // The native transaction owns the sink until it settles, so a later gesture is
  // dropped before submission facts are published: no capture, no second sink.
  h.shell.setDraft('second message'); h.shell.submit('steer');
  await settle();
  assert.equal(flights.length, 1); assert.equal(h.events.filter(event => event.kind === 'capture').length, 1);
  assert.equal(h.submissions.length, 1, 'the dropped gesture never publishes submission facts');
  assert.equal(h.shell.snapshot.draft, 'second message');
  required(flights[0]).resolve({ kind: 'error', text: 'first refused' }); await settle();
  assert.equal(h.events.filter(event => event.kind === 'settled').length, 1);
  assert.equal(h.shell.snapshot.draft, 'second message');
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
  assert.equal(h.mid.length, 1); assert.deepEqual(h.mid[0]?.attachmentIds, ['attachment-only'], 'the pending attachment-only send stays owned by the shell');
  assert.equal(h.events.find(event => event.kind === 'settled')?.ok, true);
  assert.deepEqual([...h.shell.snapshot.attachmentIds], ['attachment-only']);
  assert.equal(h.shell.notices.getSnapshot()?.text, 'worktree refused');
});
