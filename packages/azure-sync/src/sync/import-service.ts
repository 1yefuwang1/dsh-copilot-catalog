/**
 * Import/recovery service surface used by startup repair and later commands.
 * @module @1yefuwang1/dsh-azure-sync/sync/import-service
 */
import type { Importer, EarlyImportClaims, ImportResult, CatchUpOptions, ResumeImportOptions } from './importer.js';
import { AzureSyncError } from '../azure/errors.js';
import type { RemoteSession } from './remote-session.js';
import type { ImportRecovery } from './recovery.js';

export interface DestinationImportRouting {
  reserved(sessionId: string): Promise<boolean>;
  legacy(sessionId: string): Promise<never>;
  catchUp(sessionId: string, remote: RemoteSession, options: CatchUpOptions): Promise<ImportResult>;
}

export class ImportService {
  private readonly importer: Importer;
  private readonly claims?: EarlyImportClaims;
  private readonly recovery?: ImportRecovery;

  constructor(importer: Importer, claims?: EarlyImportClaims, recovery?: ImportRecovery, private readonly destinations?: DestinationImportRouting) {
    this.importer = importer;
    this.claims = claims;
    this.recovery = recovery;
  }

  async importSession(sessionId: string, signal?: AbortSignal): Promise<ImportResult> {
    signal?.throwIfAborted();
    if (await this.destinations?.reserved(sessionId)) return this.destinations!.legacy(sessionId);
    const handle = this.claims?.take(sessionId);
    if (handle === undefined) return this.importer.import(sessionId, undefined, signal);
    try { return await this.importer.resume(sessionId, handle, { signal }); }
    catch (error) {
      if (signal?.aborted || error instanceof AzureSyncError && error.code === 'CANCELLED') await handle.close().catch(() => undefined);
      else this.claims?.restore(sessionId, handle);
      throw error;
    }
  }

  async resume(sessionId: string, options: ResumeImportOptions = {}): Promise<ImportResult> {
    options.signal?.throwIfAborted();
    if (await this.destinations?.reserved(sessionId)) return this.destinations!.legacy(sessionId);
    const handle = this.claims?.take(sessionId);
    try { return await this.importer.resume(sessionId, handle, options); }
    catch (error) {
      if (handle !== undefined) {
        // close is idempotent: also cover an abort between importer rejection
        // and this catch, after the importer elected to retain a borrowed claim.
        if (options.signal?.aborted || error instanceof AzureSyncError && error.code === 'CANCELLED') await handle.close().catch(() => undefined);
        else this.claims?.restore(sessionId, handle);
      }
      throw error;
    }
  }

  async catchUp(sessionId: string, remote: RemoteSession, options: CatchUpOptions): Promise<ImportResult> {
    if (await this.destinations?.reserved(sessionId)) return this.destinations!.catchUp(sessionId, remote, options);
    return this.importer.catchUp(sessionId, remote, options);
  }

  async repairAll(): Promise<{ repaired: readonly string[]; failed: readonly string[] } | undefined> {
    return this.recovery?.repairAll();
  }
}
