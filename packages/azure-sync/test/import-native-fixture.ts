import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionController } from '@deepseek-ai/dsh-api-session-controller';
import { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import { LlmAdapter, LlmRuntime, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionLogOffset, SessionSeq, SessionStore, buildForkSeed, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import { Storage } from '@deepseek-ai/dsh-storage';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { CompositePlugin, GuardPlugin } from './import-compatibility-fixture.js';
import * as ProductionGuard from '../src/import/guard.js';
import * as ProductionPersistence from '../src/import/persistence.js';
import { projectDomain } from '../../worktrees/src/project-store.js';
import { ProjectController } from '../../worktrees/src/projects.js';

export const route = { provider: 'fixture', model: 'no-network' };
export const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
export function header(id: string, cwd: string, seeded = false): SessionHeader {
  return { version: 4, id: SessionId(id), cwd, createdAt: 123, delegationDepth: 0, isSeeded: seeded,
    ...(seeded ? { parentSession: SessionId('original-cloud-parent') } : {}) };
}
export function history(_cwd: string, seeded = false, count = 2, textBytes = 32): { events: readonly SessionEvent[]; cut: number } {
  const events: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
    seq: SessionSeq(index), time: 1000 + index, type: 'user/message', surfaceOp: 'append',
    data: { ...prompt(`Original cloud message ${index}: ${'x'.repeat(textBytes)}`), id: `cloud-message-${index}` as never },
  }));
  // The fixture's source fork is constructed once, before import. Import always
  // reuses this exact original seed marker, IDs, times, lineage, and cut.
  return seeded ? { events: buildForkSeed(events, SessionSeq(events.length - 1)), cut: events.length } : { events, cut: 0 };
}
export async function persistenceHost(root: string, compression: 'none' | 'zstd' = 'none') {
  const ctx = new Context();
  const scope = ctx.plugin(JsonlPersistence, { root, compression }); await scope.await();
  assert.equal(scope.state, 2);
  return { ctx, persistence: ctx.sessionPersistence, close: () => scope.dispose() };
}

// Exact reads, observations, replay, and projection restore are the SDK's real
// SessionQueryEngine. Search is deliberately unavailable, not a fake index.
class ExactQuery extends SessionQueryEngine {
  async searchSessions(): Promise<never> { throw new Error('Full-text search is outside this feasibility bench.'); }
  async searchEvents(): Promise<never> { throw new Error('Full-text search is outside this feasibility bench.'); }
}
// The public attachment seam's production text-admission implementation is used
// by the actual prompt controller; this bench cannot accept binary attachments.
class TextOnlyAttachments extends AttachmentStore {
  readonly imageLimits = { maxImageBytes: 1, maxImageDimension: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, mediaTypes: [] };
  async validateImage(): Promise<never> { throw new Error('No binary intake in this bench.'); }
  async saveImage(): Promise<never> { throw new Error('No binary intake in this bench.'); }
  async readImage(): Promise<never> { throw new Error('No binary intake in this bench.'); }
}
/** Real public Host primitives, without cloud transport, source Agent, or Git. */
export async function nativeHost(root: string, cwd: string, options: { journal?: string; guardRoot?: string } = {}) {
  const ctx = new Context();
  const scopes: Array<ReturnType<Context['plugin']>> = [];
  async function mount(plugin: Parameters<Context['plugin']>[0], config?: unknown) {
    const scope = ctx.plugin(plugin, config); scopes.push(scope); await scope.await(); assert.equal(scope.state, 2); return scope;
  }
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx);
  new SystemPrompt(ctx, { includeHarnessIdentity: false }); new ToolRuntime(ctx);
  ctx.provide('fs', {
    async resolve(path: string, options?: { cwd?: string }) { return { path: await realpath(isAbsolute(path) ? path : resolve(options?.cwd ?? cwd, path)) }; },
    async stat(target: { path: string }) { const value = await stat(target.path); return { type: value.isDirectory() ? 'directory' : 'file' }; },
    processPath: (target: { path: string }) => target.path,
  });
  new LlmRuntime(ctx);
  let llmCalls = 0, preSteps = 0;
  class NoNetwork extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      llmCalls++;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Explicit continuation completed.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Explicit continuation completed.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new NoNetwork() as never);
  if (options.guardRoot !== undefined) {
    await mount(ProductionGuard, { root: options.guardRoot });
    await mount(ProductionPersistence, { root: join(root, 'logs'), compression: 'none' });
  } else if (options.journal === undefined) await mount(JsonlPersistence, { root: join(root, 'logs'), compression: 'none' });
  else {
    await mount(GuardPlugin, { journal: options.journal });
    await mount(CompositePlugin, { root: join(root, 'logs') });
  }
  await mount(WorkingDirectoryService, { defaultDirectory: cwd });
  const loopScope = await mount(AgentLoop, {});
  new Storage(ctx);
  const backend = new JsonStorageBackend(join(root, 'domain'));
  ctx.storage.backend.register('native-feasibility', backend);
  const facility = new DomainFacility(ctx, { backend: 'native-feasibility' });
  ctx.provide('storageDomain', facility);
  ctx.on('agent/pre-step', async (_input, next) => { preSteps++; return next(); }, { global: true });
  await mount(WorkspaceRegistry);
  const query = new ExactQuery(ctx);
  const projects = await facility.open(projectDomain);
  const projectStore = {
    projects: projects.table('projects'), bindings: projects.table('bindings'),
    starts: projects.table('starts'), removals: projects.table('removals'), close: () => projects.close(),
  };
  const projectController = new ProjectController(ctx, projectStore, { records: () => [] });
  // These peers are already installed for the pinned native controller. Resolve
  // their PUBLIC package entrypoints, not /src, private classes, or input sinks.
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-api-session-controller'));
  async function peer(name: string) { return import(pathToFileURL(require.resolve(name)).href); }
  await mount((await peer('@deepseek-ai/dsh-typert-registry')).default);
  await mount((await peer('@deepseek-ai/dsh-agent-default-model')).default, route);
  new TextOnlyAttachments(ctx);
  await mount((await peer('@deepseek-ai/dsh-commands')).default);
  // Only the unused upload-route carrier is a fixture; actual prompt admission,
  // staged receipt binding and queue mutation remain the native implementations.
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  await mount((await peer('@deepseek-ai/dsh-client-file-upload')).default);
  // remoteAccess is intentionally absent: direct owner-native methods only,
  // not a claim of Gateway authentication/HTTP coverage.
  const controller = new SessionController(ctx, { nativeOpen: false });
  let closed = false;
  return { ctx, controller, query, projectController, projectStore, facility,
    get llmCalls() { return llmCalls; }, get preSteps() { return preSteps; },
    async close() {
      if (closed) return; closed = true;
      await loopScope.dispose();
      await projectController.close();
      for (const scope of scopes.reverse()) await scope.dispose();
      await facility.closeAll(); await backend.close(); await ctx.fiber.dispose();
    },
  };
}
export type NativeHost = Awaited<ReturnType<typeof nativeHost>>;

/** Wake confirmed pending input without minting/duplicating a user message. */
export async function wakeConfirmedPending(agent: Agent, flush: () => Promise<void>) {
  const target = agent.inbox.nextTurn.length > 0 ? 'next-turn' : 'next-step';
  const original = [...(target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep)];
  const message = original.at(-1);
  if (message === undefined) return;
  // Native resume leaves restored inbox idle and exposes no wake-only method.
  // Under its public maintenance claim, remove/reinsert the LAST original item
  // with the SAME ID, value and target. Waking send is latched until maintenance
  // ends, preserving both queue order and exactly-once model-visible delivery.
  await agent.runMaintenance(async () => {
    assert.equal(agent.inbox.remove(message.id), true);
    agent.send(message, target, true);
    assert.deepEqual(target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep, original);
    await flush();
  });
}

/** Subprocess entrypoint: only public handles, no JSONL byte surgery or hooks. */
export interface CrashSpec { root: string; cwd: string; id: string; seeded: boolean; count?: number; textBytes?: number; compression?: 'none' | 'zstd'; action?: 'read' | 'claim' }
async function checkpoint(phase: string, details: Record<string, unknown> = {}) {
  process.send?.({ phase, ...details });
  await once(process, 'message');
}
async function worker(spec: CrashSpec) {
  const host = await persistenceHost(spec.root, spec.compression);
  const id = SessionId(spec.id);
  if (spec.action === 'read' || spec.action === 'claim') {
    try {
      const handle = await host.persistence.open(id, spec.action === 'claim' ? 'write' : 'read');
      const read = await handle.read();
      process.send?.({ phase: 'result', header: handle.header, cut: handle.inheritedEventCount, events: read.events });
      await handle.close();
    } catch (error) { process.send?.({ phase: 'result', error: { name: (error as Error).name, message: (error as Error).message } }); }
    await host.close(); return;
  }
  const value = history(spec.cwd, spec.seeded, spec.count, spec.textBytes);
  const handle = await host.persistence.create(header(spec.id, spec.cwd, spec.seeded), { inheritedEventCount: SessionLogOffset(value.cut) });
  await checkpoint('created');
  // The parent can SIGKILL at a real filesystem temp-file event during this
  // single first append. The existing marker is never split into a later batch.
  await handle.append(value.events);
  await checkpoint('appended');
  await handle.flush();
  await checkpoint('flushed');
  await handle.close();
  await checkpoint('closed');
  await host.close();
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  await mkdir(JSON.parse(process.argv[3]!).root, { recursive: true });
  await worker(JSON.parse(process.argv[3]!));
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--cwd-writer') {
  const input = JSON.parse(process.argv[3]!) as { hostRoot: string; guardRoot: string; ordinary: string; id: string; cwd: string };
  const host = await nativeHost(input.hostRoot, input.ordinary, { guardRoot: input.guardRoot });
  const handle = await host.ctx.sessionPersistence.create(header(input.id, input.cwd));
  await checkpoint('cwd-held');
  await handle.close(); await host.close(); process.disconnect?.();
}
