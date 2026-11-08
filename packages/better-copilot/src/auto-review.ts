import { isAgentLoopRequest, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { asRecord, type ModelCatalog, type PluginContext } from './catalog-types.js';
import type { AutoReviewSettings } from './config.js';

/** GitHub Copilot's default builtin authorization reviewer. */
export const DEFAULT_REVIEW_MODEL = 'gpt-6.1-terra';

/** One live configuration snapshot for a review request. */
export interface AutoReviewOverrides {
  enabled: boolean;
  model?: string;
  reasoningEffort?: string;
}

/**
 * Select only an auxiliary builtin review route. Never modify loop requests or
 * caller-owned inputs, including the frozen request the builtin reviewer sends.
 * Changing model drops a previous model's effort unless explicitly overridden.
 */
export function configureAutoReview(options: GenerateOptions<string>, settings: AutoReviewOverrides, catalog: ModelCatalog = {}): GenerateOptions<string> {
  if (!settings.enabled || options.purpose !== 'auto-review' || isAgentLoopRequest(options as GenerateOptions)) return options;
  const model = settings.model ?? (options.provider === 'github-copilot' && options.model !== 'deepseek-v4-flash'
    ? DEFAULT_REVIEW_MODEL : options.model);
  const reasoningEffort = settings.reasoningEffort ?? (model === options.model ? options.reasoningEffort : undefined);
  const descriptor = Object.hasOwn(catalog, model) ? catalog[model] : undefined;
  // The builtin's hard-coded zero is not a user inference setting. Require
  // positive support for reviewer sampling; old SDK GPT catalogs omit this flag.
  const omitTemperature = options.provider === 'github-copilot' && options.temperature !== undefined
    && !(descriptor?.provider === 'github-copilot' && asRecord(descriptor.compat)?.supportsTemperature === true);
  if (model === options.model && reasoningEffort === options.reasoningEffort && !omitTemperature) return options;
  const { reasoningEffort: _previous, temperature, ...rest } = options;
  return Object.freeze({
    ...rest, model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as NonNullable<GenerateOptions['reasoningEffort']> }),
    ...(omitTemperature || temperature === undefined ? {} : { temperature }),
  });
}

/**
 * The waterfall's next() accepts no replacement request. Redispatch a detached
 * auxiliary request through the public LLM service instead, marking that exact
 * object so the nested waterfall delegates once without rereading live settings.
 * Cordis owns listener disposal; no review policy, permission or Session changes.
 */
export function installAutoReviewRouting(ctx: PluginContext, config: AutoReviewSettings, catalog: ModelCatalog): void {
  const routed = new WeakSet<object>();
  ctx.on('llm/stream', function (options, next) {
    if (routed.has(options) || options.purpose !== 'auto-review' || isAgentLoopRequest(options)) return next();
    const enabled = config.enabled.get();
    if (!enabled) return next();
    const model = config.model.get();
    const reasoningEffort = config.reasoningEffort.get();
    const selected = configureAutoReview(options, {
      enabled,
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    }, catalog);
    if (selected === options) return next();
    routed.add(selected);
    // Purpose typing is owned by the optional builtin package, not a hard peer.
    // The catalog adapter refreshes before exact-model resolution. If still absent,
    // retain the failure instead of silently selecting another reviewer.
    const stream = this.stream(selected as GenerateOptions);
    return (async function* () {
      for await (const chunk of stream) {
        if (selected.provider === 'github-copilot' && chunk.type === 'finish' && chunk.reason.kind === 'error'
          && chunk.reason.failure.code === 'UNKNOWN_MODEL') {
          yield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure,
            message: `${chunk.reason.failure.message}. The configured Copilot reviewer remains unavailable after catalog refresh; select an available autoReview.model.`,
          } } };
        } else yield chunk;
      }
    })();
  });
}
