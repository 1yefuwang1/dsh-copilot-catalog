import z from '@deepseek-ai/schemastery';
import { createConfig } from '../dist/config.js';
import type { BetterCopilotDependencies } from '../dist/plugin.js';
import type { BetterCopilotRuntime } from '../dist/runtime.js';

/**
 * The merged plugin is one plugin with three capabilities. Tests that exercise a
 * single capability mount it with an inert adapter double and inert credentials,
 * so the other capabilities cannot perform network or credential work.
 */
export const FakeAdapterConfig = z.object({ providers: z.dict(z.any()).default({}).volatile() });
export const Config = createConfig(FakeAdapterConfig);

export function minimalDependencies(overrides: Partial<BetterCopilotDependencies> = {}): BetterCopilotDependencies {
  return {
    original: {
      name: 'llm-pi-ai', Config: FakeAdapterConfig, inject: ['llm'],
      recordKeyFor: (id: string) => `llm-pi-ai/${id}`, apply: () => Promise.resolve(),
    } as unknown as BetterCopilotDependencies['original'],
    catalog: {},
    oauth: {
      refresh: async (credential: unknown) => credential,
      toAuth: async () => ({ apiKey: 'synthetic', baseUrl: 'https://api.individual.githubcopilot.com' }),
    } as unknown as BetterCopilotDependencies['oauth'],
    recordKeyFor: ((id: string) => `llm-pi-ai/${id}`) as unknown as BetterCopilotDependencies['recordKeyFor'],
    createModels: (() => ({ setProvider() {}, getAuth: async () => undefined })) as unknown as BetterCopilotDependencies['createModels'],
    provider: { id: 'github-copilot', auth: { oauth: {} }, getModels: () => [] } as unknown as BetterCopilotDependencies['provider'],
    headers: {},
    installIdentity: () => () => {},
    ...overrides,
  };
}

/**
 * Real runtime seams (real pi-ai factories, OAuth hooks and headers) with an inert
 * adapter double, for tests that exercise one capability through a fake context.
 */
export function runtimeDependencies(runtime: BetterCopilotRuntime, overrides: Partial<BetterCopilotDependencies> = {}): BetterCopilotDependencies {
  const fake = minimalDependencies();
  return { ...fake, ...runtime, original: fake.original, installIdentity: fake.installIdentity, ...overrides };
}

/** Services the merged plugin injects; a real Context must provide them to activate. */
export function provideInjectedServices(ctx: { provide(name: string, value: unknown): unknown }): void {
  ctx.provide('llm', {});
  ctx.provide('credentials', { readRecord: async () => undefined, resolve: async () => undefined });
}
