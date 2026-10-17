import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import { Config, createPlugin } from '../dist/plugin.js';
import * as fixtures from './fixtures.js';

type Handler = (assembly: PromptAssembly, context: unknown, next: () => Promise<PromptAssembly>) => Promise<PromptAssembly>;
interface Registration { event: string; handler: Handler; options?: Record<string, unknown> }

function harness() {
  const listeners: Registration[] = [];
  const logs = { info: [] as string[], warn: [] as string[] };
  const sink = (target: string[]) => (...args: unknown[]) => {
    let index = 1;
    target.push(String(args[0]).replace(/%[sd]/gu, () => String(args[index++])));
  };
  const ctx = {
    logger: { info: sink(logs.info), warn: sink(logs.warn) },
    on(event: string, handler: Handler, options?: Record<string, unknown>) {
      const entry: Registration = { event, handler, options };
      listeners.push(entry);
      return { dispose() { listeners.splice(listeners.indexOf(entry), 1); } };
    },
  };
  return { ctx, listeners, logs };
}

function mount(overrides: Record<string, unknown> = {}) {
  const state = harness();
  createPlugin().apply(state.ctx as unknown as Context, Config(overrides) as never);
  return state;
}

const run = (state: ReturnType<typeof harness>, assembly: PromptAssembly, next?: () => Promise<PromptAssembly>) =>
  state.listeners[0]!.handler(assembly, {}, next ?? (async () => assembly));

test('registers one outer global waterfall listener and fixes only nonconformant tools', async () => {
  const state = mount();
  assert.equal(state.listeners.length, 1);
  assert.equal(state.listeners[0]!.event, 'system-prompt/assemble');
  assert.deepEqual(state.listeners[0]!.options, { global: true, prepend: true });
  const downstream = fixtures.assembly([fixtures.missingBucketTool, fixtures.conformantTool]);
  const result = await run(state, downstream);
  assert.notEqual(result, downstream);
  assert.deepEqual(fixtures.parameters(result.tools[0]!).properties, {});
  assert.equal(result.tools[1], downstream.tools[1]);
  assert.equal(result.sections, downstream.sections);
  assert.equal(result.contexts, downstream.contexts);
  assert.equal(result.variables, downstream.variables);
  assert.equal(state.logs.info.length, 0);
});

test('returns the downstream assembly identity when the route or declarations are out of scope', async () => {
  const state = mount();
  for (const route of [fixtures.assembly([fixtures.missingBucketTool], 'deepseek-account', 'deepseek-flash'), fixtures.assembly([fixtures.missingBucketTool], 'github-copilot', 'gpt-6.1-sol'), fixtures.assembly([fixtures.conformantTool])]) {
    assert.equal(await run(state, route), route);
  }
});

test('awaits the downstream chain first, so selected-route variables are visible', async () => {
  const state = mount();
  const downstream = fixtures.assembly([fixtures.missingBucketTool], '', '');
  const result = await run(state, downstream, async () => ({ ...downstream, variables: { provider: 'github-copilot', model: 'gemini-4-argon' } }));
  assert.deepEqual(fixtures.parameters(result.tools[0]!).properties, {});
});

test('propagates downstream failures unchanged and contains only its own failures', async () => {
  const state = mount();
  await assert.rejects(run(state, fixtures.assembly([]), async () => { throw new Error('downstream failed'); }), /downstream failed/u);
  const downstream = fixtures.assembly([]);
  Object.defineProperty(downstream, 'tools', { get() { throw new Error('boom'); } });
  const result = await run(state, downstream);
  assert.equal(result, downstream);
  assert.match(state.logs.warn.at(-1) ?? '', /internal error/u);
});

test('logs a summary only when logFixes is enabled, without tool arguments', async () => {
  const quiet = mount();
  await run(quiet, fixtures.assembly([fixtures.missingBucketTool]));
  assert.equal(quiet.logs.info.length, 0);
  const loud = mount({ logFixes: true });
  await run(loud, fixtures.assembly([fixtures.missingBucketTool]));
  assert.equal(loud.logs.info.length, 1);
  assert.match(loud.logs.info[0] ?? '', /added a properties bucket/u);
  assert.equal(JSON.stringify(loud.logs.info).includes('projectId'), false);
  await run(loud, fixtures.assembly([fixtures.referenceTool]));
  assert.match(loud.logs.warn.at(-1) ?? '', /left 1 tool schema/u);
  assert.match(loud.logs.warn.at(-1) ?? '', /TOOL_SCHEMA_SKIPPED/u);
  const mixed = await run(loud, fixtures.assembly([fixtures.missingBucketTool, fixtures.referenceTool, fixtures.noParametersTool]));
  assert.match(loud.logs.info.at(-1) ?? '', /added a properties bucket to 1 tool schema/u);
  assert.match(loud.logs.warn.at(-1) ?? '', /left 2 tool schema\(s\) unchanged/u);
  assert.match(loud.logs.warn.at(-1) ?? '', /SKIPPED_REFERENCE/u);
  assert.match(loud.logs.warn.at(-1) ?? '', /SKIPPED_MISSING_PARAMETERS/u);
  assert.deepEqual(mixed.tools.map(tool => tool.name), ['workspace_project', 'referenced', 'opaque']);
});

test('volatile settings are re-read for every assembly', async () => {
  const state = harness();
  const values = { providers: ['github-copilot'], families: ['gemini'], logFixes: false };
  createPlugin().apply(state.ctx as unknown as Context, {
    providers: { get: () => values.providers },
    families: { get: () => values.families },
    logFixes: { get: () => values.logFixes },
  } as never);
  const downstream = fixtures.assembly([fixtures.missingBucketTool]);
  assert.deepEqual(fixtures.parameters((await run(state, downstream)).tools[0]!).properties, {});
  values.families = ['gpt'];
  assert.equal(await run(state, downstream), downstream);
  values.families = ['gemini'];
  values.providers = [];
  assert.equal(await run(state, downstream), downstream);
});

test('a throwing logger cannot change the assembly', async () => {
  const state = harness();
  state.ctx.logger = { info() { throw new Error('exporter down'); }, warn() { throw new Error('exporter down'); } };
  createPlugin().apply(state.ctx as unknown as Context, Config({ logFixes: true }) as never);
  const result = await run(state, fixtures.assembly([fixtures.missingBucketTool]));
  assert.deepEqual(fixtures.parameters(result.tools[0]!).properties, {});
});

test('duplicate installation is idempotent', async () => {
  const state = mount();
  createPlugin().apply(state.ctx as unknown as Context, Config({}) as never);
  assert.equal(state.listeners.length, 2);
  const downstream = fixtures.assembly([fixtures.missingBucketTool]);
  const once = await state.listeners[0]!.handler(downstream, {}, async () => downstream);
  const twice = await state.listeners[1]!.handler(once, {}, async () => once);
  assert.equal(JSON.stringify(twice.tools), JSON.stringify(once.tools));
  assert.deepEqual(fixtures.parameters(twice.tools[0]!).properties, {});
});
