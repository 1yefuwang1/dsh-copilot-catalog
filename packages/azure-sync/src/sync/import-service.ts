/**
 * Import/recovery service surface used by startup repair and later commands.
 * @module @1yefuwang1/dsh-azure-sync/sync/import-service
 */
import type { Importer, EarlyImportClaims, ImportResult } from './importer.js';
import type { ImportRecovery } from './recovery.js';

export class ImportService {
  private readonly importer: Importer;
  private readonly claims?: EarlyImportClaims;
  private readonly recovery?: ImportRecovery;

  constructor(importer: Importer, claims?: EarlyImportClaims, recovery?: ImportRecovery) {
    this.importer = importer;
    this.claims = claims;
    this.recovery = recovery;
  }

  async importSession(sessionId: string): Promise<ImportResult> {
    const handle = this.claims?.take(sessionId);
    if (handle === undefined) return this.importer.import(sessionId);
    try { return await this.importer.resume(sessionId, handle); }
    catch (error) { this.claims?.restore(sessionId, handle); throw error; }
  }

  async resume(sessionId: string): Promise<ImportResult> {
    const handle = this.claims?.take(sessionId);
    try { return await this.importer.resume(sessionId, handle); }
    catch (error) { if (handle !== undefined) this.claims?.restore(sessionId, handle); throw error; }
  }

  async repairAll(): Promise<{ repaired: readonly string[]; failed: readonly string[] } | undefined> {
    return this.recovery?.repairAll();
  }
}
