/**
 * Sync control surface shared by lifecycle hooks and later commands/tools.
 * @module @1yefuwang1/dsh-azure-sync/sync/service
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { LocalSessionRecord, SyncStatus } from '../schema.js';
import type { LocalStore } from '../local/store.js';
import type { OwnershipProof, UploadSummary, Uploader } from './uploader.js';

export interface SyncServiceDependencies {
  readonly uploader: Uploader;
  readonly local: LocalStore;
  readonly ensureInfra?: () => Promise<void>;
  readonly agents?: { get(id: string): Agent | undefined };
  readonly ownershipProofMs?: number;
  readonly imports?: import('./import-service.js').ImportService;
  readonly tombstones?: import('./tombstone-manager.js').TombstoneManager;
}

export class SyncService {
  private readonly deps: SyncServiceDependencies;
  private infra?: Promise<void>;
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: SyncServiceDependencies) {
    this.deps = deps;
  }

  private async ensure(): Promise<void> {
    if (this.deps.ensureInfra === undefined) return;
    this.infra ??= this.deps.ensureInfra().catch((error: unknown) => {
      this.infra = undefined;
      throw error;
    });
    await this.infra;
  }

  async enable(sessionId: string): Promise<UploadSummary> {
    const intent = await this.deps.uploader.beginEnableIntent(sessionId);
    await this.ensure();
    return this.deps.uploader.syncWithIntent(sessionId, intent);
  }

  async disable(sessionId: string): Promise<void> {
    await this.deps.uploader.disable(sessionId);
  }

  async sync(sessionId: string): Promise<UploadSummary> {
    await this.ensure();
    return this.deps.uploader.sync(sessionId, { release: false });
  }

  async close(timeoutMs = 5_000): Promise<void> {
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    await this.deps.uploader.close(timeoutMs);
  }

  noteActivity(sessionId: string): void {
    this.deps.uploader.noteActivity(sessionId);
  }

  noteFlushed(sessionId: string): void {
    this.deps.uploader.noteFlushed(sessionId);
  }

  async ensureOwnership(sessionId: string): Promise<OwnershipProof> {
    const controller = new AbortController();
    const proof = this.deps.uploader.ensureOwnership(sessionId, controller.signal);
    const ms = this.deps.ownershipProofMs ?? 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<OwnershipProof>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ owned: false, reason: 'ownership-unverified' }); }, ms);
      timer.unref?.();
    });
    try { return await Promise.race([proof, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  /** Check the quiet drain gate; retry once after the two-second quiet window. */
  async drain(sessionId: string): Promise<void> {
    if (!this.deps.uploader.hasHeld(sessionId)) return;
    const agent = this.deps.agents?.get(sessionId);
    if (agent === undefined) return;
    const snapshot = { agentIdle: agent.status === 'idle', inboxSize: agent.inbox.nextTurn.length + agent.inbox.nextStep.length };
    const result = await this.deps.uploader.drain(sessionId, snapshot);
    if (result !== 'released' && this.deps.uploader.hasHeld(sessionId)) this.scheduleDrain(sessionId);
  }

  scheduleDrain(sessionId: string): void {
    const previous = this.drainTimers.get(sessionId);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.drainTimers.delete(sessionId);
      void this.drain(sessionId).catch(() => undefined);
    }, 2_100);
    timer.unref?.();
    this.drainTimers.set(sessionId, timer);
  }

  async removeFromCloud(sessionId: string) {
    if (this.deps.tombstones === undefined) throw new Error('azure-sync: tombstone manager is not ready.');
    const record = this.deps.local.getSession(sessionId);
    if (record === undefined) throw new Error('azure-sync: session is not tracked.');
    await this.deps.tombstones.remove(sessionId, record.generation);
  }

  async resurrectInCloud(sessionId: string) {
    if (this.deps.tombstones === undefined) throw new Error('azure-sync: tombstone manager is not ready.');
    return this.deps.tombstones.resurrect(sessionId);
  }

  async importSession(sessionId: string) {
    if (this.deps.imports === undefined) throw new Error('azure-sync: import service is not ready.');
    return this.deps.imports.importSession(sessionId);
  }

  async resumeImport(sessionId: string) {
    if (this.deps.imports === undefined) throw new Error('azure-sync: import service is not ready.');
    return this.deps.imports.resume(sessionId);
  }

  status(sessionId: string): { enabled: boolean; status: SyncStatus; record?: LocalSessionRecord } {
    const record = this.deps.local.getSession(sessionId);
    return { enabled: record?.enabled ?? false, status: record?.status ?? 'setup-needed', ...(record === undefined ? {} : { record }) };
  }
}
