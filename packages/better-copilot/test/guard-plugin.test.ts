import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createConfig } from '../dist/config.js';
import { createPlugin } from '../dist/plugin.js';
import * as fixtures from './guard-fixtures.js';
import { minimalDependencies } from './merged-fixtures.js';

const Config = createConfig(minimalDependencies().original.Config);
const COPILOT_URL = 'https://api.individual.githubcopilot.com/chat/completions';
const OTHER_URL = 'https://api.deepseek.com/chat/completions';

/** The guard is one capability of the merged plugin; the rest is inert here. */
function dependencies() {
  return minimalDependencies({ installIdentity: () => () => {} });
}

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
    on(event: string) {
      assert.notEqual(event, 'system-prompt/assemble', 'the guard must not register assembly listeners');
      return () => {};
    },
  };
  return { ctx, logs };
}

interface Capture { input: RequestInfo | URL; init?: RequestInit }

/** Install a fake downstream fetch, mount the plugin, then delegate one request. */
async function withPlugin(
  config: unknown,
  operate: (state: { logs: { info: string[]; warn: string[] }; captures: Capture[] }) => Promise<void>,
  apply?: (ctx: Context, config: unknown) => Promise<void>,
): Promise<void> {
  const state = harness();
  const captures: Capture[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { captures.push({ input, init }); return new Response('ok'); }) as typeof fetch;
  try {
    await (apply ? apply(state.ctx as unknown as Context, config) : createPlugin(dependencies()).apply(state.ctx as unknown as Context, config as never));
    await operate({ logs: state.logs, captures });
  } finally {
    globalThis.fetch = original;
  }
}

/** A plain config whose leaves are read through volatile accessors, as the schema exposes them. */
function volatileConfig(values: { providers: string[]; families: string[]; logFixes: boolean }): unknown {
  return {
    providers: { get: () => ({}) },
    catalog: Config().catalog,
    search: {},
    toolSchema: {
      providers: { get: () => values.providers },
      families: { get: () => values.families },
      logFixes: { get: () => values.logFixes },
    },
  };
}

test('mounting registers one wire transform and fixes only the configured route', async () => {
  await withPlugin(Config({ toolSchema: { providers: ['github-copilot'], families: ['gemini'] } }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    assert.deepEqual(fixtures.sentParameters(captures[0]!.init!.body as string).properties, {});
    await globalThis.fetch(OTHER_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    assert.equal(captures[1]!.init!.body, fixtures.chatBody([fixtures.missingBucketTool]), 'a foreign provider body is delegated byte-identical');
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool], 'gpt-6.1-sol') });
    assert.equal(captures[2]!.init!.body, fixtures.chatBody([fixtures.missingBucketTool], 'gpt-6.1-sol'), 'another model family is untouched');
  });
});

test('a rewritten body drops stale framing headers and keeps the rest of init', async () => {
  await withPlugin(Config({ toolSchema: {} }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '999', 'x-custom': 'kept' },
      body: fixtures.chatBody([fixtures.missingBucketTool]),
      redirect: 'error',
    });
    const sent = new Headers(captures[0]!.init!.headers);
    assert.equal(sent.get('content-length'), null, 'the stale length cannot describe the rewritten body');
    assert.equal(sent.get('x-custom'), 'kept');
    assert.equal(captures[0]!.init!.method, 'POST');
    assert.equal(captures[0]!.init!.redirect, 'error');
  });
});

test('a non-gemini default route leaves every body byte-identical', async () => {
  await withPlugin(Config({ toolSchema: { families: ['gemma'] } }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    assert.equal(captures[0]!.init!.body, fixtures.chatBody([fixtures.missingBucketTool]));
  });
});

test('volatile settings are re-read for every request', async () => {
  const values = { providers: ['github-copilot'], families: ['gemini'], logFixes: false };
  await withPlugin(volatileConfig(values), async ({ captures }) => {
    const body = fixtures.chatBody([fixtures.missingBucketTool]);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body });
    assert.deepEqual(fixtures.sentParameters(captures[0]!.init!.body as string).properties, {});
    values.families = ['gpt'];
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body });
    assert.equal(captures[1]!.init!.body, body);
    values.families = ['gemini']; values.providers = [];
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body });
    assert.equal(captures[2]!.init!.body, body);
  });
});

test('logFixes summarizes fixes and controlled skips without tool arguments', async () => {
  await withPlugin(Config({ toolSchema: { logFixes: true } }), async ({ logs, captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    const fixed = logs.info.filter(line => line.includes('added a properties bucket'));
    assert.equal(fixed.length, 1);
    assert.equal(JSON.stringify(logs.info).includes('projectId'), false);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.referenceTool]) });
    assert.match(logs.warn.at(-1) ?? '', /TOOL_SCHEMA_SKIPPED/u);
    assert.match(logs.warn.at(-1) ?? '', /SKIPPED_REFERENCE/u);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool, fixtures.referenceTool, fixtures.noParametersTool]) });
    assert.match(logs.info.at(-1) ?? '', /added a properties bucket to 1 tool schema/u);
    assert.match(logs.warn.at(-1) ?? '', /left 2 tool schema\(s\) unchanged/u);
    assert.equal(captures.length, 3);
  });
  await withPlugin(Config({ toolSchema: {} }), async ({ logs }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    assert.equal(logs.info.filter(line => line.includes('added a properties bucket')).length, 0);
  });
});

test('a throwing logger or settings accessor never fails or corrupts the request', async () => {
  await withPlugin(Config({ toolSchema: { logFixes: true } }), async ({ captures }) => {
    const body = fixtures.chatBody([fixtures.missingBucketTool]);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body });
    assert.deepEqual(fixtures.sentParameters(captures[0]!.init!.body as string).properties, {});
  }, async (ctx, config) => {
    (ctx as unknown as { logger: unknown }).logger = { info() { throw new Error('exporter down'); }, warn() { throw new Error('exporter down'); } };
    await createPlugin(dependencies()).apply(ctx, config as never);
  });
  await withPlugin({
    providers: { get: () => ({}) },
    catalog: Config().catalog,
    search: {},
    toolSchema: { providers: { get: () => ['github-copilot'] }, families: { get: () => { throw new Error('settings unavailable'); } }, logFixes: { get: () => false } },
  }, async ({ captures }) => {
    const body = fixtures.chatBody([fixtures.missingBucketTool]);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body });
    assert.equal(captures[0]!.init!.body, body, 'a throwing settings read is fail-open');
  });
});

test('duplicate installation still normalizes one body exactly once', async () => {
  await withPlugin(Config({ toolSchema: {} }), async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool]) });
    const parameters = fixtures.sentParameters(captures[0]!.init!.body as string);
    assert.deepEqual(parameters, { type: 'object', oneOf: parameters.oneOf, properties: {} });
  }, async (ctx, config) => {
    await createPlugin(dependencies()).apply(ctx, config as never);
    await createPlugin(dependencies()).apply(ctx, config as never);
  });
});
