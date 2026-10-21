/**
 * Startup import recovery: parents are always repaired before subagent
 * descendants; a child whose parent is not present is never resumed alone.
 * @module @1yefuwang1/dsh-azure-sync/sync/recovery
 */
import type { LocalStore } from '../local/store.js';
import type { LocalSessionRecord } from '../schema.js';
import { AzureSyncError } from '../azure/errors.js';
import type { Importer } from './importer.js';
import type { EarlyImportClaims } from './importer.js';

export interface ImportCandidate {
  readonly sessionId: string;
  readonly parentSession?: string;
  readonly delegationDepth?: number;
  readonly subagent?: boolean;
}

/** Order root-first by delegation depth/parent ancestry; missing parents are refused. */
export function orderImportCandidates(candidates: readonly ImportCandidate[], satisfiedParents: ReadonlySet<string> = new Set()): ImportCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ImportCandidate[] = [];
  const visit = (candidate: ImportCandidate): void => {
    if (visited.has(candidate.sessionId)) return;
    if (visiting.has(candidate.sessionId)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'The import ancestry contains a cycle.');
    visiting.add(candidate.sessionId);
    if (candidate.subagent === true && candidate.parentSession !== undefined) {
      const parent = byId.get(candidate.parentSession);
      if (parent === undefined && !satisfiedParents.has(candidate.parentSession)) throw new AzureSyncError('IMPORT_INCOMPLETE', 'A subagent child has no pending or completed parent import.');
      if (parent !== undefined) visit(parent);
    }
    visiting.delete(candidate.sessionId);
    visited.add(candidate.sessionId);
    ordered.push(candidate);
  };
  [...candidates].sort((left, right) => (left.delegationDepth ?? 0) - (right.delegationDepth ?? 0)).forEach(visit);
  return ordered;
}

export class ImportRecovery {
  private readonly importer: Importer;
  private readonly local: LocalStore;
  private readonly claims?: EarlyImportClaims;

  constructor(importer: Importer, local: LocalStore, claims?: EarlyImportClaims, private readonly destinationReserved?: (sessionId: string) => Promise<boolean>) {
    this.importer = importer;
    this.local = local;
    this.claims = claims;
  }

  async repairAll(): Promise<{ readonly repaired: readonly string[]; readonly failed: readonly string[] }> {
    const candidates: ImportCandidate[] = [];
    for (const [sessionId, record] of this.local.listSessions()) {
      if (record.destination || await this.destinationReserved?.(sessionId)) continue;
      // Cold catch-ups own a separate retry lifecycle and always re-prove a fresh
      // committed prefix; first-import recovery must not pin or resume their writer.
      if (record.catchUpPending || record.importState === undefined || record.importState === 'complete') continue;
      const header = await this.localHeader(sessionId);
      candidates.push({ sessionId, ...(header?.parentSession === undefined ? {} : { parentSession: header.parentSession }), ...(header?.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }), ...(record.subagent === true ? { subagent: true } : {}) });
    }
    const completed = new Set([...this.local.listSessions()].filter(([, record]) => record.importState === 'complete').map(([id]) => id));
    const ordered = orderImportCandidates(candidates, completed);
    const repaired: string[] = [];
    const failed: string[] = [];
    const blocked = new Set<string>();
    for (const candidate of ordered) {
      if (candidate.subagent === true && candidate.parentSession !== undefined &&
          (!completed.has(candidate.parentSession) || blocked.has(candidate.parentSession))) {
        blocked.add(candidate.sessionId);
        failed.push(candidate.sessionId);
        continue;
      }
      const handle = this.claims?.take(candidate.sessionId);
      try {
        const result = await this.importer.resume(candidate.sessionId, handle);
        if (result.status === 'complete') completed.add(candidate.sessionId);
        else blocked.add(candidate.sessionId);
        repaired.push(candidate.sessionId);
      } catch {
        blocked.add(candidate.sessionId);
        if (handle !== undefined) this.claims?.restore(candidate.sessionId, handle);
        failed.push(candidate.sessionId);
      }
    }
    return { repaired, failed };
  }

  private async localHeader(sessionId: string): Promise<{ parentSession?: string; delegationDepth?: number } | undefined> {
    const record: LocalSessionRecord | undefined = this.local.getSession(sessionId);
    if (record === undefined) return undefined;
    return {
      ...(record.parentSession === undefined ? {} : { parentSession: record.parentSession }),
      ...(record.delegationDepth === undefined ? {} : { delegationDepth: record.delegationDepth }),
      ...(record.subagent === true ? { subagent: true } : {}),
    };
  }
}
