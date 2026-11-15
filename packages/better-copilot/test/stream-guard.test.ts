import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { guardStream, isProgressChunk } from '../dist/stream-guard.js';

const request: GenerateOptions = { provider: 'github-copilot', model: 'synthetic-model', messages: [] };

const drain = async (stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

/** A provider that emits only empty reasoning blocks forever. */
const emptyChatter = (): AsyncIterable<StreamChunk> => (async function* () {
  for (let index = 0; ; index++) {
    yield { type: 'block-start', index, blockType: 'reasoning' };
    await delay(5);
    yield { type: 'block-end', index, block: { type: 'reasoning', text: '' } };
    await delay(5);
  }
})();

const timeoutFailure = (error: unknown): boolean => error instanceof LlmError && error.failure.code === 'TIMEOUT';

test('control-only events cannot keep an attempt alive', async () => {
  const started = Date.now();
  await assert.rejects(
    drain(guardStream(() => emptyChatter(), request, 30, 10)),
    timeoutFailure,
  );
  assert.ok(Date.now() - started < 1_000, 'the timeout must not wait for the idle watchdog');
});

test('text progress resets the deadline and completes normally', async () => {
  const stream = async function* (): AsyncIterable<StreamChunk> {
    for (let index = 0; index < 10; index++) {
      yield { type: 'text-delta', index: 0, text: 'x' };
      await delay(20);
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const chunks = await drain(guardStream(() => stream(), request, 100, 10));
  assert.equal(chunks.at(-1)?.type, 'finish');
});

test('a terminal finish is delivered before a post-finish hang', async () => {
  const stream = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } };
    await new Promise(() => {});
  };
  const chunks = await Promise.race([
    drain(guardStream(() => stream(), request, 30, 10)),
    delay(300).then(() => { throw new Error('guard waited after the terminal finish'); }),
  ]);
  assert.equal(chunks.at(-1)?.type, 'finish');
});

test('caller cancellation stays ABORTED', async () => {
  const controller = new AbortController();
  const stream = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    await new Promise(() => {});
  };
  setTimeout(() => controller.abort(new Error('user cancel')), 10);
  await assert.rejects(
    drain(guardStream(() => stream(), { ...request, signal: controller.signal }, 1_000, 10)),
    (error) => error instanceof LlmError && error.failure.code === 'ABORTED',
  );
});

test('a provider that ignores cancellation is closed within the cleanup limit', async () => {
  const started = Date.now();
  const stream = async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    await new Promise(() => {});
  };
  await assert.rejects(
    drain(guardStream(() => stream(), request, 20, 20)),
    timeoutFailure,
  );
  assert.ok(Date.now() - started < 500);
});

test('progress classification ignores framing and empty content', () => {
  assert.equal(isProgressChunk({ type: 'block-start', index: 0, blockType: 'reasoning' }), false);
  assert.equal(isProgressChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '   ' } }), false);
  assert.equal(isProgressChunk({ type: 'block-end', index: 0, block: { type: 'text', text: '' } }), false);
  assert.equal(isProgressChunk({ type: 'text-delta', index: 0, text: 'x' }), true);
  assert.equal(isProgressChunk({ type: 'reasoning-delta', index: 0, text: 'x' }), true);
  assert.equal(isProgressChunk({ type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }), true);
  assert.equal(isProgressChunk({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }), true);
  assert.equal(isProgressChunk({ type: 'finish', reason: { kind: 'stop' } }), true);
});

test('an invalid timeout fails as configuration rather than hanging', async () => {
  await assert.rejects(
    drain(guardStream(() => emptyChatter(), request, 0)),
    (error) => error instanceof LlmError && error.failure.code === 'INVALID_CONFIG',
  );
});
