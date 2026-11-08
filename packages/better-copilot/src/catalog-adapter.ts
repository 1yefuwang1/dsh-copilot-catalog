import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { PluginContext } from './catalog-types.js';

/** Refresh the owning account's catalog before the adapter captures connection/model facts. */
type EnsureCatalog = (model: string | undefined, signal?: AbortSignal) => Promise<void>;
const COPILOT = 'github-copilot';

/**
 * Decorate the public adapter seam, not its private registry/snapshot state.
 * In particular, AgentLoop prepares its call before the llm/stream waterfall,
 * so waiting only in that waterfall cannot refresh a prepared call's metadata.
 */
export function createCatalogAdapter(adapter: LlmAdapter, ensure: EnsureCatalog): LlmAdapter {
  return new class extends LlmAdapter {
    override providerInfo(...args: Parameters<LlmAdapter['providerInfo']>) {
      return adapter.providerInfo(...args);
    }
    override providerRetryPolicy(...args: Parameters<LlmAdapter['providerRetryPolicy']>) {
      return adapter.providerRetryPolicy(...args);
    }
    override imageRequestPricing(...args: Parameters<LlmAdapter['imageRequestPricing']>) {
      return adapter.imageRequestPricing(...args);
    }
    override imageRequestTarget(...args: Parameters<LlmAdapter['imageRequestTarget']>) {
      return adapter.imageRequestTarget(...args);
    }
    override async listModels(provider: string) {
      if (provider === COPILOT) await ensure(undefined);
      return adapter.listModels(provider);
    }
    override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
      if (provider === COPILOT) await ensure(model, signal);
      return adapter.resolveModel(provider, model, signal);
    }
    override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
      if (provider === COPILOT) await ensure(model, signal);
      // Preserve the adapter-owned generation and its stream receiver exactly.
      // Refreshing again at prepared dispatch would break capability/wire binding.
      return adapter.prepareCall(provider, model, signal);
    }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (options.provider === COPILOT) await ensure(options.model, options.signal);
      yield* adapter.stream(options);
    }
  }();
}

/**
 * A narrow facade for original.apply(ctx, config): only adapter registration is
 * decorated, while Cordis still owns registration/disposal on the original ctx.
 * It is not a new context/service and must not be installed into the profile.
 */
export function adapterContext(ctx: PluginContext, ensure: EnsureCatalog): PluginContext {
  const llm = ctx.llm;
  // Existing plugin doubles (and optional-service callers) have no LLM seam.
  if (!llm || typeof llm.registerAdapter !== 'function') return ctx;

  const register = llm.registerAdapter;
  const registerAdapter: typeof register = (providers, adapter) => Reflect.apply(register, llm, [
    providers,
    // A dormant/non-Copilot registration may gain the Copilot route through
    // its public handle.replace(). Decorate once now so that handle stays intact;
    // the adapter itself gates refresh strictly by the requested provider.
    createCatalogAdapter(adapter, ensure),
  ]);
  const methods = new Map<PropertyKey, { original: Function; bound: Function }>();
  const service = new Proxy(llm, {
    get(target, key) {
      if (key === 'registerAdapter') return registerAdapter;
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      // Cordis' service methods carry a use-site context. Calling with the
      // original service receiver preserves it (and supports private fields).
      const cached = methods.get(key);
      if (cached?.original === value) return cached.bound;
      const bound = value.bind(target);
      methods.set(key, { original: value, bound });
      return bound;
    },
  });
  return new Proxy(ctx, {
    get(target, key) {
      return key === 'llm' ? service : Reflect.get(target, key, target);
    },
  });
}
