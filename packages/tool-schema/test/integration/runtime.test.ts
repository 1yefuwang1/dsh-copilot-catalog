import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createPlugin } from '../../dist/plugin.js';
import * as fixtures from '../fixtures.js';

async function host(list: readonly fixtures.FixtureTool[], provider?: string, model?: string) {
  const ctx = new Context();
  const service = ctx.plugin(SystemPrompt);
  await service;
  const schemas = fixtures.tools(list);
  ctx.systemPrompt.tools(() => ({ schemas: schemas.map(tool => structuredClone(tool)) }));
  if (provider !== undefined) ctx.systemPrompt.variable('provider', () => provider);
  if (model !== undefined) ctx.systemPrompt.variable('model', () => model);
  return { ctx, service };
}

test('the real assembly waterfall normalizes a defective declaration for a gemini route', async () => {
  const { ctx, service } = await host([fixtures.missingBucketTool, fixtures.conformantTool], 'github-copilot', 'gemini-4-argon');
  const plugin = ctx.plugin(createPlugin(), { providers: ['github-copilot'], families: ['gemini'] });
  await plugin;
  try {
    const assembly = await ctx.systemPrompt.assemble({});
    const byName = (name: string) => fixtures.parameters(assembly.tools.find(tool => tool.name === name)!);
    assert.deepEqual((byName('workspace_project').properties as object), {});
    const conformant = byName('conformant').properties as Record<string, { enum: string[] }>;
    assert.equal(conformant.action!.enum[0], 'list');
    const nonGemini = await host([fixtures.missingBucketTool], 'github-copilot', 'gpt-6.1-sol');
    const other = nonGemini.ctx.plugin(createPlugin(), {});
    await other;
    const untouched = await nonGemini.ctx.systemPrompt.assemble({});
    assert.equal(fixtures.parameters(untouched.tools.find(tool => tool.name === 'workspace_project')!).properties, undefined);
    await other.dispose();
    await nonGemini.service.dispose();
  } finally {
    await service.dispose();
  }
});

test('an inner route-selection listener runs before the guard; disposal stops normalization', async () => {
  const { ctx, service } = await host([fixtures.missingBucketTool]);
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, variables: { ...assembled.variables, provider: 'github-copilot', model: 'gemini-4-argon' } };
  });
  const plugin = ctx.plugin(createPlugin(), {});
  await plugin;
  try {
    const normalized = await ctx.systemPrompt.assemble({});
    assert.deepEqual(fixtures.parameters(normalized.tools[0]!).properties, {});
    await plugin.dispose();
    const raw = await ctx.systemPrompt.assemble({});
    assert.equal(fixtures.parameters(raw.tools[0]!).properties, undefined);
  } finally {
    await service.dispose();
  }
});

test('a later outer prepend listener owns the result; the guard never throws or corrupts it', async () => {
  const { ctx, service } = await host([fixtures.missingBucketTool], 'github-copilot', 'gemini-4-argon');
  const plugin = ctx.plugin(createPlugin(), {});
  await plugin;
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, tools: assembled.tools.map(tool => ({ ...tool, description: 'outer override' })) };
  }, { global: true, prepend: true });
  try {
    const assembly = await ctx.systemPrompt.assemble({});
    assert.equal(assembly.tools[0]!.description, 'outer override');
    assert.deepEqual(fixtures.parameters(assembly.tools[0]!).properties, {});
  } finally {
    await service.dispose();
  }
});
