import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createPlugin } from '../../dist/plugin.js';
import { minimalDependencies, provideInjectedServices } from '../merged-fixtures.js';
import * as fixtures from '../guard-fixtures.js';

const COPILOT_URL = 'https://api.individual.githubcopilot.com/chat/completions';
const OTHER_URL = 'https://api.deepseek.com/chat/completions';

interface Captured { input: RequestInfo | URL; init?: RequestInit }

/** A real Cordis host, a fake transport, so the real plugin lifecycle is exercised. */
async function withHost(
  config: Record<string, unknown>,
  operate: (state: { ctx: Context; captures: Captured[] }) => Promise<void>,
  dependencies = minimalDependencies(),
): Promise<void> {
  const ctx = new Context();
  provideInjectedServices(ctx);
  const captures: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { captures.push({ input, init }); return new Response('ok'); }) as typeof fetch;
  const fiber = ctx.plugin(createPlugin(dependencies), config);
  await fiber;
  try {
    await operate({ ctx, captures });
  } finally {
    await fiber.dispose();
    globalThis.fetch = original;
  }
}

test('the real plugin normalizes a defective declaration for a gemini route', async () => {
  await withHost({ toolSchema: { providers: ['github-copilot'], families: ['gemini'] } }, async ({ captures }) => {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: fixtures.chatBody([fixtures.missingBucketTool, fixtures.conformantTool]) });
    const parameters = fixtures.sentParameters(captures[0]!.init!.body as string, 0);
    assert.deepEqual(parameters.properties, {});
    assert.deepEqual(fixtures.sentParameters(captures[0]!.init!.body as string, 1).properties, { action: { type: 'string', enum: ['list'] } });
  });
});

test('a foreign host, a conformant body and a released transform all stay byte-identical', async () => {
  const body = fixtures.chatBody([fixtures.missingBucketTool]);
  await withHost({ toolSchema: {} }, async ({ captures }) => {
    await globalThis.fetch(OTHER_URL, { method: 'POST', body });
    assert.equal(captures[0]!.init!.body, body);
    const conformant = fixtures.chatBody([fixtures.conformantTool]);
    await globalThis.fetch(COPILOT_URL, { method: 'POST', body: conformant });
    assert.equal(captures[1]!.init!.body, conformant);
  });
  // Both controls ran inside the mounted fiber; after it is gone the wrapper is released.
  assert.notEqual(globalThis.fetch, undefined);
});

test('disposal restores the previous fetch exactly', async () => {
  const original = globalThis.fetch;
  const ctx = new Context();
  provideInjectedServices(ctx);
  const fake = (async () => new Response('ok')) as typeof fetch;
  globalThis.fetch = fake;
  const fiber = ctx.plugin(createPlugin(minimalDependencies()), { toolSchema: {} });
  await fiber;
  assert.notEqual(globalThis.fetch, fake, 'the wire wrapper is installed for the guard');
  await fiber.dispose();
  assert.equal(globalThis.fetch, fake, 'disposal restores the exact previous fetch');
  globalThis.fetch = original;
});

test('the default wire identity and the tool-schema guard share one interceptor', async () => {
  const ctx = new Context();
  provideInjectedServices(ctx);
  const captures: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { captures.push({ input, init }); return new Response('ok'); }) as typeof fetch;
  // The real identity installer: this test does not stub it.
  const fiber = ctx.plugin(createPlugin(minimalDependencies({ installIdentity: undefined })), { toolSchema: {} });
  await fiber;
  try {
    await globalThis.fetch(COPILOT_URL, { method: 'POST', headers: { authorization: 'synthetic', 'x-stainless-lang': 'js' }, body: fixtures.chatBody([fixtures.missingBucketTool]) });
    const headers = new Headers(captures[0]!.init!.headers);
    assert.equal(headers.get('x-stainless-lang'), null, 'the identity interceptor removed the SDK fingerprint');
    assert.ok(headers.get('user-agent'));
    assert.deepEqual(fixtures.sentParameters(captures[0]!.init!.body as string).properties, {}, 'the same wrapper normalized the body');
  } finally {
    await fiber.dispose();
    globalThis.fetch = original;
  }
});
