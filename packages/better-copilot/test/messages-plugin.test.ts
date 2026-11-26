import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createConfig } from '../dist/config.js';
import { createPlugin } from '../dist/plugin.js';
import { minimalDependencies } from './merged-fixtures.js';

const Config = createConfig(minimalDependencies().original.Config);
const COPILOT_URL = 'https://api.enterprise.githubcopilot.com/chat/completions';
const OTHER_URL = 'https://api.deepseek.com/chat/completions';

/** The recorded failure: several tool rounds, then a content-less retry turn. */
const body = (messages: unknown[]): string => JSON.stringify({ model: 'gemini-4-neon', stream: true, messages });
const recorded = body([
  { role: 'user', content: 'Investigate' },
  { role: 'assistant', content: 'Reading the tree' },
  { role: 'user', content: '' },
]);

function harness() {
  const logs = { info: [] as string[], warn: [] as string[] };
  const sink = (target: string[]) => (...args: unknown[]) => {
    let index = 1;
    target.push(String(args[0]).replace(/%[sd]/gu, () => String(args[index++])));
  };
  const ctx = {
    logger: { info: sink(logs.info), warn: sink(logs.warn) },
    effect(execute: () => () => void) { return execute(); },
    inject() { return () => {}; },
    get() { return undefined; },
    on() { return () => {}; },
  };
  return { ctx, logs };
}

interface Capture { input: RequestInfo | URL; init?: RequestInit }

/** Install a fake downstream fetch, mount the plugin, then delegate one request. */
async function withPlugin(
  config: unknown,
  operate: (state: { logs: { info: string[]; warn: string[] }; captures: Capture[] }) => Promise<void>,
): Promise<void> {
  const state = harness();
  const captures: Capture[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { captures.push({ input, init }); return new Response('ok'); }) as typeof fetch;
  try {
    await createPlugin(minimalDependencies()).apply(state.ctx as unknown as Context, config as never);
    await operate({ logs: state.logs, captures });
  }
  finally {
    globalThis.fetch = original;
  }
}

test('the mounted wire transform drops the empty retry turn before Copilot measures it', async () => {
  await withPlugin(Config({ providers: {} }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: recorded });
    assert.deepEqual(JSON.parse(String(captures[0]!.init!.body)).messages, [
      { role: 'user', content: 'Investigate' },
      { role: 'assistant', content: 'Reading the tree' },
    ]);
  });
});

test('a valid request is still delegated byte-identically', async () => {
  await withPlugin(Config({ providers: {} }), async ({ captures }) => {
    const valid = body([{ role: 'user', content: 'Investigate' }]);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: valid });
    assert.equal(captures[0]!.init!.body, valid, 'nothing to repair means no re-serialization');
  });
});

test('a foreign provider body is never repaired', async () => {
  await withPlugin(Config({ providers: {} }), async ({ captures }) => {
    await globalThis.fetch(OTHER_URL, { method: 'POST', body: recorded });
    assert.equal(captures[0]!.init!.body, recorded);
  });
});

test('dropEmpty false restores the old wire behaviour for diagnosis', async () => {
  await withPlugin(Config({ providers: {}, messages: { dropEmpty: false } }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: recorded });
    assert.equal(captures[0]!.init!.body, recorded);
  });
});

test('logFixes reports one repaired request without leaking message content', async () => {
  await withPlugin(Config({ providers: {}, messages: { logFixes: true } }), async ({ logs, captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: recorded });
    assert.equal(captures.length, 1);
    const note = logs.info.find(line => line.includes('empty-text'));
    assert.ok(note, 'the repair is reported when asked for');
    assert.ok(note.includes('1'), 'the count is named');
    assert.ok(!note.includes('Investigate'), 'no message content is logged');
  });
});

test('a throwing settings read leaves the request byte-identical instead of failing it', async () => {
  const config = {
    providers: { get: () => ({}) },
    catalog: Config().catalog,
    search: {},
    toolSchema: Config().toolSchema,
    messages: { dropEmpty: { get: () => { throw new Error('settings unavailable'); } }, logFixes: { get: () => false } },
  };
  await withPlugin(config, async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: recorded });
    assert.equal(captures[0]!.init!.body, recorded);
  });
});
