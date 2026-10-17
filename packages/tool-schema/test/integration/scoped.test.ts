import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope';
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createPlugin } from '../../dist/plugin.js';
import * as fixtures from '../fixtures.js';

async function host() {
  const ctx = new Context();
  const service = ctx.plugin(SystemPrompt);
  await service;
  ctx.systemPrompt.tools(() => ({ schemas: fixtures.tools([fixtures.missingBucketTool]) }));
  return { ctx, service };
}

const selection = (provider: string, model: string): ModelSelectionRef => ({ current: { provider, model }, assembled: undefined });

/**
 * Real composition, not emulation: the actual installed installModelSelection listener
 * inside minted agent scopes, with the guard registered before and after it.
 */
test('real scoped selection listeners compose with the guard in either registration order', async () => {
  for (const guardFirst of [true, false]) {
    const { ctx, service } = await host();
    const installGuard = () => ctx.plugin(createPlugin(), {});
    const firstGuard = guardFirst ? await installGuard() : undefined;
    const geminiKey = 'session-gemini' as unknown as ScopeKey;
    const gptKey = 'session-gpt' as unknown as ScopeKey;
    const geminiScope = createScope(ctx, geminiKey);
    const gptScope = createScope(ctx, gptKey);
    const disposeGemini = installModelSelection(geminiScope.ctx, selection('github-copilot', 'gemini-4-argon'));
    const disposeGpt = installModelSelection(gptScope.ctx, selection('github-copilot', 'gpt-6.1-sol'));
    const guard = firstGuard ?? await installGuard();
    try {
      const gemini = await ctx.systemPrompt.assemble({ scope: geminiKey });
      const gpt = await ctx.systemPrompt.assemble({ scope: gptKey });
      const unscoped = await ctx.systemPrompt.assemble({});
      assert.deepEqual(fixtures.parameters(gemini.tools[0]!).properties, {}, 'the gemini scope is normalized');
      assert.equal(fixtures.parameters(gpt.tools[0]!).properties, undefined, 'the sibling gpt scope is untouched');
      assert.equal(fixtures.parameters(unscoped.tools[0]!).properties, undefined, 'unscoped assembly has no selected route');
    } finally {
      disposeGemini();
      disposeGpt();
      await geminiScope.dispose();
      await gptScope.dispose();
      await guard.dispose();
      await service.dispose();
    }
  }
});
