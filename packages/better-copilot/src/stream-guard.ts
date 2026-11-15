import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

/** Mirror of the pi-ai adapter's default stream idle interval. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** Bound for closing an iterator whose provider ignored the abort signal. */
export const DEFAULT_STREAM_GUARD_CLEANUP_MS = 250;

/**
 * Whether one chunk is evidence that the model made progress. Block framing
 * alone is not: pi-ai can emit an empty reasoning block every few seconds
 * forever, and the core idle watchdog counts every chunk as activity. Visible
 * text, tool-call data, a completed content block and usage are progress;
 * block starts and empty block ends are not.
 * @param chunk - one translated provider chunk.
 * @returns whether the chunk carries model output or accounting.
 */
export function isProgressChunk(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.trim().length > 0;
    case 'tool-call-delta':
      return (chunk.name?.trim().length ?? 0) > 0 || chunk.argumentsDelta.trim().length > 0;
    case 'block-end':
      if (chunk.block.type === 'text' || chunk.block.type === 'reasoning') {
        return chunk.block.text.trim().length > 0;
      }
      return true;
    case 'usage':
    case 'finish':
      return true;
    default:
      return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Close an iterator without letting a synchronous or asynchronous failure escape. */
function closeQuietly(iterator: AsyncIterator<StreamChunk>): Promise<void> {
  try {
    const close = iterator.return?.();
    return close === undefined ? Promise.resolve() : Promise.resolve(close).then(() => {}, () => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Bound one model attempt by progress rather than elapsed time. The timer runs
 * only while a read is outstanding, so consumer rendering time does not count.
 * Empty control chunks do not reset it, unlike the core idle watchdog.
 *
 * A timeout aborts the attempt, closes the inner iterator with a time limit
 * and throws a retryable `TIMEOUT`. A caller abort stays `ABORTED`. A terminal
 * finish chunk is delivered immediately; a later stall must not turn a
 * completed tool call into another attempt.
 *
 * @param open - opens the inner stream under the supplied cancellation signal.
 * @param options - the assembled request whose signal owns the attempt.
 * @param timeoutMs - provider wait allowed without a progress chunk.
 * @param cleanupMs - bound for closing an iterator that ignores cancellation.
 * @returns the guarded chunk stream.
 */
export async function* guardStream(
  open: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
  options: GenerateOptions,
  timeoutMs: number,
  cleanupMs = DEFAULT_STREAM_GUARD_CLEANUP_MS,
): AsyncIterable<StreamChunk> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LlmError('better-copilot stream guard requires a positive timeout', 'INVALID_CONFIG');
  }
  const outer = options.signal;
  if (outer?.aborted) {
    // Preserve the adapter's own cancellation classification.
    yield* open(options);
    return;
  }

  const controller = new AbortController();
  const signal = outer === undefined ? controller.signal : AbortSignal.any([outer, controller.signal]);
  const iterator = open({ ...options, signal })[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleWait = 0;
  let timedOut = false;
  let closed = false;

  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return closeQuietly(iterator);
  };
  const timeoutFailure = (cause?: unknown): LlmError => new LlmError(
    `model stream for ${options.provider}/${options.model} produced no progress for ${timeoutMs}ms`,
    'TIMEOUT',
    cause === undefined ? undefined : { cause },
  );
  const abortFailure = (cause?: unknown): LlmError => new LlmError(
    `model stream for ${options.provider}/${options.model} was aborted by the caller`,
    'ABORTED',
    cause === undefined ? undefined : { cause },
  );
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => { reject(new Error('model stream signal aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  // The race observer owns this rejection; keep an unobserved abort from
  // becoming an unhandled rejection after a normal finish.
  aborted.catch(() => {});

  try {
    while (true) {
      if (timedOut || idleWait >= timeoutMs) {
        timedOut = true;
        controller.abort();
        await Promise.race([close(), delay(cleanupMs)]);
        throw timeoutFailure();
      }

      const started = performance.now();
      const pending = iterator.next();
      // A timeout or caller abort can win the race while the provider read is
      // still pending; the inner generator may never settle it.
      pending.catch(() => {});
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('model stream progress deadline expired'));
        }, timeoutMs - idleWait);
      });

      let result: IteratorResult<StreamChunk>;
      try {
        result = await Promise.race([pending, deadline, aborted]);
      } catch (error) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (outer?.aborted) throw abortFailure(error);
        if (timedOut) {
          await Promise.race([close(), delay(cleanupMs)]);
          throw timeoutFailure(error);
        }
        throw error;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }

      idleWait += performance.now() - started;
      if (result.done) return;
      const chunk = result.value;
      if (isProgressChunk(chunk)) idleWait = 0;
      yield chunk;
      if (chunk.type === 'finish') {
        controller.abort();
        void close();
        return;
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    void close();
  }
}
