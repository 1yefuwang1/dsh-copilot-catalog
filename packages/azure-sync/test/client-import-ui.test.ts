import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createImportWizard } from '../client-import.js';
import type { CloudImportRequest, CloudImportView } from '../src/import/protocol.js';
import type { GitContext } from '../src/git/context.js';
import { compareLocalCode } from '../src/import/local-code.js';
import locale from '../locale/en.json' with { type: 'json' };

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const h = React.createElement;
const dictionary = locale.ui as Record<string, string>, t = (key: string) => dictionary[key] ?? key;
const projectId = '9e1f87ae-fb7a-4cf8-8a4b-3c8bc9a94316', a = 'a'.repeat(40), b = 'b'.repeat(40), hash = 'c'.repeat(64);
const sourceGit: GitContext = { v: 2, observation: { deviceId: 'source-device', observedAt: 1, generation: 1, headerHash: hash, eventCount: 3, chainHash: hash }, repository: { objectFormat: 'sha1', root: '/remote/project', worktree: true }, creationBase: { kind: 'local', ref: 'refs/heads/release', oid: a, upstreamAtCreation: { ref: 'refs/heads/dev', remote: { name: 'origin', sanitizedUrl: 'https://example.invalid/repo' } } }, current: { detached: false, unborn: false, dirty: 'clean', branchRef: 'refs/heads/worktree/source', headOid: b } };
const envelope = (data: unknown) => ({ ok: true, value: { v: 1, ok: true, data } });
function store<T>(initial: T) { let value = initial; const listeners = new Set<() => void>(); return { getSnapshot: () => value, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, publish(next: T) { value = next; for (const listener of listeners) listener(); }, get size() { return listeners.size; } }; }
const Wizard = createImportWizard(React, {
  Button: props => h('button', { ...props, type: props.type ?? 'button' }),
  Field: ({ label, children }) => h('label', null, label, children),
  Check: ({ label, ...props }) => h('label', null, h('input', { ...props, type: 'checkbox' }), label),
  Dialog: ({ title, children, close }) => h('section', { role: 'dialog', 'aria-label': title }, h('button', { type: 'button', onClick: close }, 'Close fixture'), children),
  reason: (code, translate) => translate(Object.hasOwn(dictionary, 'import.reason.' + code) ? 'import.reason.' + code : 'import.genericReason'),
});
function fixture(options: { worktree?: boolean; unavailable?: boolean; pending?: boolean; codeMismatch?: boolean; observedLocal?: { branch?: string; oid?: string }; eligible?: boolean; strict?: boolean; reply?: (request: CloudImportRequest) => unknown | Promise<unknown> } = {}) {
  const generation = store<{ id: number } | undefined>({ id: 1 }), sessions = store({ byId: { 'existing-local-actor': { origin: 'native', retainedBy: { mainView: 1 }, blank: true } } });
  const calls: CloudImportRequest[] = [], opened: string[] = [], finished: string[] = [];
  let operationId = '', closed = 0, destination: 'local' | 'worktree' = 'local', destinationCwd = '/local/project';
  const view = (patch: Partial<CloudImportView> = {}): CloudImportView => ({ version: 2, kind: 'import-operation', operationId, sessionId: 'cloud-thread', generation: 1, revision: 5, phase: 'ready', destination, cwd: destinationCwd, continuable: false, pendingInput: options.pending ?? true, ...patch });
  const runtime = {
    connection: { generation, rpc: { async call(path: string, endpoint: string, payload: unknown) {
      assert.equal(path, '/api'); assert.equal(endpoint, 'azure-sync/import');
      const body = payload as { v: number; request: CloudImportRequest }; assert.equal(body.v, 1); const request = body.request; calls.push(request);
      const supplied = await options.reply?.(request); if (supplied !== undefined) return supplied;
      switch (request.action) {
        case 'import-admission': return envelope({ version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: false, ready: true, continued: true });
        case 'import-capabilities': return envelope({ version: 2, kind: 'import-capabilities', local: !options.unavailable, worktree: options.worktree ?? false, seeded: false, folders: [{ path: '/local/project', title: 'Project', projectId, folderId: 'source-folder' }], ...(options.unavailable ? { reason: 'profile-required' } : {}) });
        case 'inspect-import': return envelope({ version: 2, kind: 'import-source', sessionId: request.sessionId, generation: request.generation, cwd: '/remote/project', platform: 'linux', eventCount: 3, eligible: options.eligible ?? true, gitUsable: true, seeded: false, sourceGit, ...(options.eligible === false ? { reason: 'unsupported-thread' } : {}) });
        case 'import-bases': return envelope({ version: 2, kind: 'import-bases', projectId: request.projectId, folderId: request.folderId, repoRoot: '/local/project', objectFormat: 'sha1', head: a, branches: [{ name: 'refs/heads/dev', oid: a }] });
        case 'plan-import': operationId = request.operationId; destination = request.destination.kind; destinationCwd = request.destination.kind === 'local' ? request.destination.folderPath : '/new/managed/worktree'; return envelope({ version: 2, kind: 'import-plan', sessionId: request.sessionId, generation: request.generation, operationId, revision: 1, expiresAt: Date.now() + 60_000, eventCount: 3, cwd: request.destination.kind === 'local' ? request.destination.folderPath : '/new/managed/worktree', destination: request.destination.kind, warnings: options.codeMismatch ? [request.destination.kind === 'local' ? options.observedLocal?.oid ? 'local-code-snapshot-mismatch' : 'local-code-unverified' : 'code-snapshot-differs-or-source-unverified'] : [], codeMismatch: options.codeMismatch ?? false, ...(request.destination.kind === 'worktree' ? { branch: 'worktree/import-unique', baseOid: request.destination.base.oid } : { ...(options.observedLocal?.branch ? { branch: options.observedLocal.branch } : {}), ...(options.observedLocal?.oid ? { baseOid: options.observedLocal.oid } : {}) }) });
        case 'commit-import': case 'import-operation': case 'resume-import': return envelope(view());
        case 'cancel-import': return envelope(view({ phase: 'cancelled', revision: 6, reason: 'cancelled' }));
        case 'continue-import': return envelope(view({ continuable: true, pendingInput: false }));
      }
    } } },
    sessions: { list: sessions, async refresh() {} },
    uiWorkspace: { openSession(id: string) { opened.push(id); }, async pickDirectory() { return '/chosen/folder'; } },
    conversation: { blocks: { storeFor() { return store(undefined); }, set() {} } },
    layout: { selectPanel() {} }, locale: { register() { return () => undefined; }, bind() { return t; } },
    slots: { inject() { return () => undefined; }, register() { return () => undefined; }, entries() { return []; }, subscribe() { return () => undefined; } },
    effect() { return () => undefined; },
  };
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  async function render(sessionId = 'cloud-thread', selectedGeneration = 1) { await act(async () => {
    const element = h(Wizard, { runtime, t, sessionId, generation: selectedGeneration, close() { closed++; }, completed(id, value) { finished.push(id + ':' + value); } });
    root.render(options.strict ? h(React.StrictMode, null, element) : element);
  }); }
  async function dispose() { await act(async () => root.unmount()); container.remove(); }
  return { runtime, generation, calls, opened, finished, container, render, dispose, get closed() { return closed; } };
}
function button(root: ParentNode, key: string) { const node = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === t(key)); assert.ok(node, key); return node; }
function field(root: ParentNode, key: string) { const node = [...root.querySelectorAll('label')].find(item => item.textContent?.startsWith(t(key)))?.querySelector<HTMLInputElement | HTMLSelectElement>('input,select'); assert.ok(node, key); return node; }
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function change(node: HTMLInputElement | HTMLSelectElement, value: string) { await act(async () => {
  const prototype = node.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
  node.dispatchEvent(new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}); }

test('new destination wizard defaults Local, shows source facts separately and never creates a thread', async () => {
  const run = fixture(); try {
    await run.render();
    const radios = run.container.querySelectorAll<HTMLInputElement>('input[type=radio]'); assert.equal(radios[0]?.checked, true); assert.equal(radios[1]?.disabled, true);
    assert.equal(run.calls.some(item => item.action === 'commit-import'), false); assert.deepEqual(run.opened, []);
    assert.ok(run.container.textContent?.includes(b)); assert.ok(run.container.textContent?.includes(a));
    assert.ok(run.container.textContent?.includes('refs/heads/dev')); assert.ok(!run.container.textContent?.includes('origin/dev @'));
    assert.deepEqual(run.calls.map(item => item.action), ['import-capabilities', 'import-admission', 'inspect-import']);
  } finally { await run.dispose(); }
});

test('Local review and confirmation retain original SID, reject auto-execution and separately confirm pending input', async () => {
  const run = fixture(); try {
    await run.render(); await change(field(run.container, 'import.destinationFolder'), '/chosen/exact-folder');
    await click(button(run.container, 'import.review'));
    const review = run.calls.find(item => item.action === 'plan-import'); assert.ok(review?.action === 'plan-import');
    assert.equal(review.sessionId, 'cloud-thread'); assert.equal(review.destination.kind, 'local');
    assert.ok(!Object.hasOwn(review.destination, 'projectId'), 'custom path must not silently take the first project');
    assert.deepEqual(run.opened, []); assert.equal(run.calls.some(item => item.action === 'commit-import'), false);
    await click(button(run.container, 'import.confirmHere')); assert.deepEqual(run.finished, ['cloud-thread:1']);
    assert.deepEqual(run.opened, []); const proceed = button(run.container, 'import.continue'); assert.equal(proceed.disabled, true);
    await click(button(run.container, 'import.openHistory')); assert.deepEqual(run.opened, ['cloud-thread']);
    assert.equal(run.calls.some(item => item.action === 'continue-import'), false);
    await click(field(run.container, 'import.pendingAck')); assert.equal(button(run.container, 'import.continue').disabled, false);
    await click(button(run.container, 'import.continue'));
    const request = run.calls.find(item => item.action === 'continue-import'); assert.ok(request?.action === 'continue-import'); assert.equal(request.acknowledgePendingInput, true);
    assert.deepEqual(run.opened, ['cloud-thread', 'cloud-thread']);
  } finally { await run.dispose(); }
});

test('Local code comparison displays receiving A separately from source B and requires distinct mismatch consent', async () => {
  const run = fixture({ codeMismatch: true, observedLocal: { branch: 'refs/heads/receiving-local', oid: a } });
  try {
    await run.render(); await change(field(run.container, 'import.destinationFolder'), '/chosen/folder'); await click(button(run.container, 'import.review'));
    const observed = [...run.container.querySelectorAll<HTMLElement>('section')].find(node => node.getAttribute('aria-label') === t('import.localObservedCode'));
    assert.ok(observed); assert.ok(observed.textContent?.includes(a)); assert.ok(observed.textContent?.includes('refs/heads/receiving-local')); assert.ok(!observed.textContent?.includes(b));
    assert.ok(run.container.textContent?.includes(b), 'source B remains separately visible');
    assert.ok(run.container.textContent?.includes(t('import.reason.local-code-snapshot-mismatch')));
    assert.equal(button(run.container, 'import.confirmHere').disabled, true);
    assert.equal(run.calls.some(call => call.action === 'commit-import'), false);
    await click(field(run.container, 'import.codeAck')); await click(button(run.container, 'import.confirmHere'));
    const commit = run.calls.find(call => call.action === 'commit-import'); assert.ok(commit?.action === 'commit-import'); assert.equal(commit.acknowledgeCodeMismatch, true);
    assert.equal(button(run.container, 'import.continue').disabled, true, 'code consent is not restored pending-input consent');
  } finally { await run.dispose(); }
});

test('branch hint wording stays neutral for different commits and dirty code while consent remains required', () => {
  for (const current of [{ ...sourceGit.current, headOid: a, branchRef: 'refs/heads/receiving', dirty: 'clean' as const }, { ...sourceGit.current, branchRef: 'refs/heads/receiving', dirty: 'dirty' as const }]) {
    const comparison = compareLocalCode(sourceGit, { ...sourceGit, current });
    assert.equal(comparison.codeMismatch, true); assert.ok(comparison.warnings.includes('local-branch-hint-differs'));
    const message = t('import.reason.local-branch-hint-differs');
    assert.ok(message.includes('not proof of matching code')); assert.ok(message.includes('separate commit and working-file comparison'));
    assert.doesNotMatch(message, /clean verified commit matches|but .*commit matches/iu);
  }
  assert.ok(t('import.reason.code-review-required').includes('execution stays blocked'));
});

test('Local unavailable comparison is visibly unknown, not source B disguised as receiving HEAD', async () => {
  const run = fixture({ codeMismatch: true });
  try {
    await run.render(); await change(field(run.container, 'import.destinationFolder'), '/non-git/folder'); await click(button(run.container, 'import.review'));
    const observed = [...run.container.querySelectorAll<HTMLElement>('section')].find(node => node.getAttribute('aria-label') === t('import.localObservedCode'));
    assert.ok(observed); assert.ok(observed.textContent?.includes(t('unknown'))); assert.ok(!observed.textContent?.includes(b));
    assert.ok(run.container.textContent?.includes(t('import.reason.local-code-unverified'))); assert.equal(button(run.container, 'import.confirmHere').disabled, true);
  } finally { await run.dispose(); }
});

test('Worktree preview uses an existing permission actor and exact source commit without a message', async () => {
  const run = fixture({ worktree: true, codeMismatch: true }); try {
    await run.render(); await click(run.container.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!);
    await change(field(run.container, 'import.sourceFolder'), '0'); await change(field(run.container, 'import.permissionContext'), 'existing-local-actor');
    assert.ok(run.calls.some(item => item.action === 'import-bases'));
    await click(button(run.container, 'import.review'));
    const request = run.calls.find(item => item.action === 'plan-import'); assert.ok(request?.action === 'plan-import' && request.destination.kind === 'worktree');
    assert.equal(request.destination.permissionActorId, 'existing-local-actor'); assert.deepEqual(request.destination.base, { kind: 'commit', oid: b });
    assert.ok(!JSON.stringify(request).includes('firstPrompt')); assert.ok(!JSON.stringify(request).includes('sourceSessionId'));
    assert.equal(button(run.container, 'import.confirmHere').disabled, true);
    await click(field(run.container, 'import.codeAck')); assert.equal(button(run.container, 'import.confirmHere').disabled, false);
    await click(button(run.container, 'import.confirmHere')); const confirmed = run.calls.find(item => item.action === 'commit-import');
    assert.ok(confirmed?.action === 'commit-import'); assert.equal(confirmed.acknowledgeCodeMismatch, true);
  } finally { await run.dispose(); }
});

test('missing required profile and unsupported thread are explicit unavailable states, never legacy fallback', async () => {
  for (const options of [{ unavailable: true }, { eligible: false }]) {
    const run = fixture(options); try {
      await run.render(); assert.equal(button(run.container, 'import.review').disabled, true);
      assert.ok(run.container.querySelector('[role=alert]')); assert.equal(run.calls.some(item => item.action === 'plan-import'), false);
      assert.equal(run.calls.some(item => item.action === 'commit-import'), false);
    } finally { await run.dispose(); }
  }
});

test('StrictMode effect remount keeps a live scoped import client rather than a disposed memo', async () => {
  const run = fixture({ strict: true }); try {
    await run.render(); assert.equal(button(run.container, 'import.review').disabled, false);
    await change(field(run.container, 'import.destinationFolder'), '/chosen/folder'); await click(button(run.container, 'import.review'));
    assert.ok(run.calls.some(item => item.action === 'plan-import'));
  } finally { await run.dispose(); }
});

test('existing cancelled import is discovered locally before any Azure inspection or new plan', async () => {
  const operationId = 'd38a0e79-035b-42dd-a183-cb3aa030bc67';
  const run = fixture({ reply: request => {
    if (request.action === 'import-admission') return envelope({ version: 2, kind: 'import-admission', sessionId: request.sessionId, reserved: true, ready: false, continued: false, operationId, generation: 1 });
    if (request.action === 'import-operation') return envelope({ version: 2, kind: 'import-operation', operationId, sessionId: request.sessionId, generation: 1, revision: 6, phase: 'cancelled', destination: 'local', continuable: false, pendingInput: true, cwd: '/retained/folder', reason: 'cancelled' });
    if (request.action === 'inspect-import') throw new Error('offline source must not be consulted for local recovery inspection');
  } });
  try {
    await run.render(); assert.deepEqual(run.calls.map(item => item.action), ['import-capabilities', 'import-admission', 'import-operation']);
    assert.ok(run.container.textContent?.includes(operationId)); assert.ok(button(run.container, 'import.resume'));
    assert.equal(run.calls.some(item => item.action === 'plan-import'), false); assert.deepEqual(run.opened, []);
  } finally { await run.dispose(); }
});

test('Cancel remains available during a hung accepted import and ignores its late success', async () => {
  let resolve!: (value: unknown) => void; const gate = new Promise<unknown>(yes => { resolve = yes; });
  const run = fixture({ reply: request => request.action === 'commit-import' ? gate : undefined });
  try {
    await run.render(); await change(field(run.container, 'import.destinationFolder'), '/chosen/folder'); await click(button(run.container, 'import.review'));
    await click(button(run.container, 'import.confirmHere')); assert.equal(button(run.container, 'import.cancelOperation').disabled, false);
    const commit = run.calls.find(item => item.action === 'commit-import'); assert.ok(commit?.action === 'commit-import');
    await click(button(run.container, 'import.cancelOperation')); assert.ok(run.container.textContent?.includes(t('import.phase.cancelled')));
    await act(async () => { resolve(envelope({ version: 2, kind: 'import-operation', operationId: commit.operationId, sessionId: commit.sessionId, generation: 1, revision: 8, phase: 'ready', destination: 'local', continuable: true, pendingInput: false })); });
    assert.deepEqual(run.finished, []); assert.deepEqual(run.opened, []);
    assert.ok(run.container.textContent?.includes(t('import.phase.cancelled')));
  } finally { resolve({}); await run.dispose(); }
});
