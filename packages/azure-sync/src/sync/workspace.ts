/**
 * Best-effort workspace attachment. Failure is a warning, never a reason to
 * lose a successfully imported session.
 * @module @1yefuwang1/dsh-azure-sync/sync/workspace
 */
import { realpath } from 'node:fs/promises';
import { AzureSyncError } from '../azure/errors.js';

export interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly title?: string;
  attachSession?(sessionId: string): void | Promise<void>;
}

export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecord[];
  create?(path: string, title?: string): Promise<WorkspaceRecord>;
  attachSession?(workspaceId: string, sessionId: string): void | Promise<void>;
}

export interface WorkspaceAttachResult {
  readonly attached: boolean;
  readonly workspaceId?: string;
  readonly warning?: string;
}

export class WorkspaceAttacher {
  private readonly registry: WorkspaceRegistryLike | undefined;

  constructor(registry: WorkspaceRegistryLike | undefined) {
    this.registry = registry;
  }

  async attach(localPath: string, title?: string, sessionId?: string): Promise<WorkspaceAttachResult> {
    if (this.registry === undefined) return { attached: false, warning: 'No workspace registry is available.' };
    let canonical: string;
    try { canonical = await realpath(localPath); }
    catch { return { attached: false, warning: 'The imported working directory does not exist.' }; }
    const existing = this.registry.list().find((workspace) => workspace.path === canonical);
    if (existing !== undefined) {
      if (sessionId !== undefined) {
        if (existing.attachSession !== undefined) await existing.attachSession(sessionId);
        else await this.registry.attachSession?.(existing.id, sessionId);
      }
      return { attached: true, workspaceId: existing.id };
    }
    if (this.registry.create === undefined) return { attached: false, warning: 'The workspace registry cannot create folders.' };
    try {
      const workspace = await this.registry.create(canonical, title);
      if (sessionId !== undefined) {
        if (workspace.attachSession !== undefined) await workspace.attachSession(sessionId);
        else await this.registry.attachSession?.(workspace.id, sessionId);
      }
      return { attached: true, workspaceId: workspace.id };
    } catch (error) {
      return { attached: false, warning: error instanceof AzureSyncError ? error.message : 'The workspace could not be attached.' };
    }
  }
}
