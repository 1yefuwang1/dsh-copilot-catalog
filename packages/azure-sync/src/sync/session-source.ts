/**
 * Read-only session source over the public persistence service. Uploads use a
 * fresh read handle after the durability barrier; no live Agent object is
 * queried for historical events.
 * @module @1yefuwang1/dsh-azure-sync/sync/session-source
 */
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { AzureSyncError } from '../azure/errors.js';

export interface SourceSnapshot {
  readonly header: SessionHeader;
  readonly inheritedEventCount: number;
  readonly events: readonly SessionEvent[];
}

export interface SourceStat {
  readonly header: SessionHeader;
  readonly eventCount?: number;
}

export interface SessionSource {
  flush(): Promise<void>;
  read(sessionId: string): Promise<SourceSnapshot | undefined>;
  stat(sessionId: string): Promise<SourceStat | undefined>;
}

export class PersistenceSessionSource implements SessionSource {
  private readonly persistence: SessionPersistence;

  constructor(persistence: SessionPersistence) {
    this.persistence = persistence;
  }

  async flush(): Promise<void> {
    try {
      await this.persistence.flush();
    } catch (error) {
      throw new AzureSyncError('TRANSIENT', 'The session persistence barrier failed.', { cause: { name: 'Error' } });
    }
  }

  async read(sessionId: string): Promise<SourceSnapshot | undefined> {
    let handle;
    try {
      handle = await this.persistence.open(sessionId as never, 'read');
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return undefined;
      throw new AzureSyncError('TRANSIENT', 'The stored session could not be opened.', { cause: { name: 'Error' } });
    }
    try {
      const result = await handle.read(0);
      return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: result.events };
    } catch {
      throw new AzureSyncError('TRANSIENT', 'The stored session could not be read.', { cause: { name: 'Error' } });
    } finally {
      await handle.close();
    }
  }

  async stat(sessionId: string): Promise<SourceStat | undefined> {
    try {
      const snapshot = await this.persistence.stat(sessionId as never);
      if (snapshot === undefined) return undefined;
      return { header: snapshot.header, ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }) };
    } catch {
      throw new AzureSyncError('TRANSIENT', 'The stored session metadata could not be read.', { cause: { name: 'Error' } });
    }
  }
}
