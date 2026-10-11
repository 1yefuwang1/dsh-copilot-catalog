import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { after, test } from 'node:test';
import vm from 'node:vm';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const clientUrl = new URL('../client.js', import.meta.url);
const source = await readFile(clientUrl, 'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const globals = new Map();
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
// jsdom has no native modal implementation. These shims model only dialog lifetime;
// the real React component, hooks, handlers, DOM changes and clicks are unchanged.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
// Load the actual DOM renderer after installing its browser environment.
const { createRoot } = await import('react-dom/client');
after(() => {
  dom.window.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function loadEditor(bridge) {
  let module;
  const marker = '      inject:';
  assert.equal(source.split(marker).length, 2, 'the real factory must have one export seam');
  // Expose existing declarations in memory only; never replace the component,
  // picker implementation, hooks, dispatch or handlers with a test double.
  const exposed = source.replace(marker,
    '      renderTest: { ProjectEditor, nativeFolderPicker },\n' + marker);
  vm.runInNewContext(exposed, {
    window: { __ModuleLoader__: { load(value) { module = value; } } },
    AbortController, crypto: webcrypto, __DSH_DIRECTORY_PICKER__: bridge,
  }, { filename: clientUrl.pathname });
  assert.equal(module.id, '@1yefuwang1/dsh-worktrees');
  return module.factory(name => {
    assert.equal(name, 'react', 'the client bundle has no other runtime import');
    return React;
  }).renderTest;
}

async function mountEditor(t, { host, bridge, project } = {}) {
  const calls = { host: 0, bridge: 0, mutation: 0 };
  const runtime = { uiWorkspace: {
    async listDirectory() { throw new Error('This fixture has no browse capability.'); },
    ...(host ? { pickDirectory() { calls.host += 1; return host(); } } : {}),
  } };
  const shell = bridge ? { pick() { calls.bridge += 1; return bridge(); } } : undefined;
  const { ProjectEditor, nativeFolderPicker } = loadEditor(shell);
  const picker = nativeFolderPicker(runtime);
  if (host || bridge) {
    assert.equal(typeof picker, 'function');
    assert.equal(picker.pick, undefined, 'the actual helper returns a callable, not { pick() }');
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => {
    root.render(React.createElement(ProjectEditor, {
      project, runtime, projects: { async mutate() { calls.mutation += 1; } },
      t: key => key, close() {},
    }));
  });
  const select = container.querySelector('.dsh-wt-source-select');
  assert.equal(select.disabled, false, 'the real capability effect completed');
  return {
    container, calls, select,
    async selectNative() {
      assert.ok([...select.options].some(option => option.value === 'native'));
      // Exercise actual controlled-select DOM change events, including returning
      // from path entry, rather than calling a captured prop or a hand-rolled hook.
      await act(async () => {
        select.value = 'path';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      assert.equal(select.value, 'path');
      await act(async () => {
        select.value = 'native';
        select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      assert.equal(select.value, 'native');
    },
    async add() {
      const button = container.querySelector('.dsh-wt-add-pill');
      assert.equal(button.disabled, false, 'Add is enabled before the native click');
      await act(async () => { button.click(); });
      assert.equal(button.disabled, false, 'the answered picker released the busy state');
      assert.equal(calls.mutation, 0, 'Add stages folders without submitting project metadata');
    },
    rows() { return [...container.querySelectorAll('.dsh-wt-source-path')].map(row => row.textContent); },
    alert() { return container.querySelector('[role=alert]')?.textContent || ''; },
  };
}

// node:test treats any unhandled rejection as a test failure. In particular, the
// original picker.pick mismatch cannot disappear behind the void click handler.
test('real ProjectEditor adds a bridge-only callable that has no .pick property', async t => {
  const editor = await mountEditor(t, { bridge: async () => '/bridge/folder' });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), ['/bridge/folder']);
  assert.deepEqual(editor.calls, { host: 0, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('real ProjectEditor adds a Host-service-only folder', async t => {
  const editor = await mountEditor(t, { host: async () => '/host/folder' });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), ['/host/folder']);
  assert.deepEqual(editor.calls, { host: 1, bridge: 0, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('the bridge answer wins without invoking a second available picker', async t => {
  const editor = await mountEditor(t, {
    bridge: async () => '/bridge/folder', host: async () => '/host/folder',
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), ['/bridge/folder']);
  assert.deepEqual(editor.calls, { host: 0, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('bridge cancellation adds nothing, releases Add and never invokes a hanging Host source', async t => {
  const editor = await mountEditor(t, {
    bridge: async () => null, host: () => new Promise(() => {}),
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), []);
  assert.deepEqual(editor.calls, { host: 0, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('an asynchronous bridge rejection falls back to the Host path', async t => {
  const editor = await mountEditor(t, {
    bridge: async () => { throw new Error('Bridge refused.'); }, host: async () => '/host/folder',
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), ['/host/folder']);
  assert.deepEqual(editor.calls, { host: 1, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('a synchronous bridge exception still permits the Host path', async t => {
  const editor = await mountEditor(t, {
    bridge: () => { throw new Error('Synchronous bridge refusal.'); }, host: async () => '/host/folder',
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), ['/host/folder']);
  assert.deepEqual(editor.calls, { host: 1, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), '');
});

test('two failed sources show the first failure inside the dialog', async t => {
  const editor = await mountEditor(t, {
    bridge: async () => { throw new Error('Bridge refused.'); },
    host: async () => { throw new Error('Host refused.'); },
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), []);
  assert.deepEqual(editor.calls, { host: 1, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), 'unknown: Bridge refused.');
});

test('a synchronous picker refusal is visible instead of escaping void choose()', async t => {
  const editor = await mountEditor(t, {
    bridge: () => { throw new Error('Synchronous picker refusal.'); },
  });
  await editor.selectNative(); await editor.add();
  assert.deepEqual(editor.rows(), []);
  assert.deepEqual(editor.calls, { host: 0, bridge: 1, mutation: 0 });
  assert.equal(editor.alert(), 'unknown: Synchronous picker refusal.');
});

test('the dispatch guard visibly refuses a stale native selection when no picker exists', async t => {
  const editor = await mountEditor(t);
  assert.equal(editor.select.value, 'path');
  assert.ok(![...editor.select.options].some(option => option.value === 'native'));
  // A native option is intentionally unavailable here. Inject one DOM option only
  // to exercise the real defensive dispatch guard; this is not a normal UI flow.
  const stale = document.createElement('option'); stale.value = 'native';
  editor.select.append(stale);
  await act(async () => {
    editor.select.value = 'native';
    editor.select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  assert.equal(editor.container.querySelector('.dsh-wt-project-path'), null,
    'the actual component state entered native dispatch, despite the absent capability');
  await editor.add();
  assert.deepEqual(editor.rows(), []);
  assert.deepEqual(editor.calls, { host: 0, bridge: 0, mutation: 0 });
  assert.equal(editor.alert(), 'folderPickerUnavailable [no-directory-picker]');
});
