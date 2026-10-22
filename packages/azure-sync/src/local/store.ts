/**
 * Local durable sidecar state for opt-in flags, import recovery, mappings, and
 * device/settings metadata. It is a `dsh_azure_sync` storage domain, not a
 * second session store.
 * @module @1yefuwang1/dsh-azure-sync/local/store
 */
import { defineDomain, domainTable, DomainError, type Domain, type DomainFacility, type DomainTableSpec, type KvTable } from '@deepseek-ai/dsh-storage-domain';
import {
  LOCAL_DOMAIN_VERSION,
  localDeviceSchema,
  localSessionRecordSchema,
  localSettingsSchema,
  parseRecord,
  pathMappingSchema,
  type LocalDeviceRecord,
  type LocalSessionRecord,
  type LocalSettingsRecord,
  type PathMappingRecord,
} from '../schema.js';

/** Preserve exact public table keys/value types without expanding the same record schema into declarations twice. */
interface LocalDomainSpec {
  name: string;
  version: number;
  compatibleVersions: number[];
  layout: 'per-record';
  tables: {
    sessions: DomainTableSpec<string, LocalSessionRecord>;
    mappings: DomainTableSpec<string, PathMappingRecord>;
    devices: DomainTableSpec<string, LocalDeviceRecord>;
    settings: DomainTableSpec<string, LocalSettingsRecord>;
  };
}
export const localDomain: LocalDomainSpec = defineDomain({
  name: 'dsh_azure_sync',
  version: LOCAL_DOMAIN_VERSION,
  compatibleVersions: [4],
  layout: 'per-record',
  tables: {
    sessions: domainTable(localSessionRecordSchema),
    mappings: domainTable(pathMappingSchema),
    devices: domainTable(localDeviceSchema),
    settings: domainTable(localSettingsSchema),
  },
});

export type LocalDomain = Domain<typeof localDomain>;
type SessionTable = KvTable<string, LocalSessionRecord>;
type MappingTable = KvTable<string, PathMappingRecord>;
type DeviceTable = KvTable<'self', LocalDeviceRecord>;
type SettingsTable = KvTable<'config', LocalSettingsRecord>;

export class LocalStore {
  private readonly domains: DomainFacility;
  private domain?: LocalDomain;
  private sessionTable?: SessionTable;
  private readonly sessionTransactions = new Map<string, Promise<void>>();
  private mappingTable?: MappingTable;
  private deviceTable?: DeviceTable;
  private settingsTable?: SettingsTable;

  constructor(domains: DomainFacility) {
    this.domains = domains;
  }

  async open(): Promise<void> {
    if (this.domain !== undefined) return;
    const domain = await this.domains.open(localDomain);
    this.domain = domain;
    this.sessionTable = domain.table('sessions') as SessionTable;
    this.mappingTable = domain.table('mappings') as MappingTable;
    this.deviceTable = domain.table('devices') as DeviceTable;
    this.settingsTable = domain.table('settings') as SettingsTable;
  }

  private requireSessions(): SessionTable {
    if (this.sessionTable === undefined) throw new Error('azure-sync: local store is not open.');
    return this.sessionTable;
  }

  /** All session writes share this local lane; callbacks use the captured SDK table directly. */
  private enqueueSessionWrite<T>(sessionId: string, write: (sessions: SessionTable) => Promise<T>): Promise<T> {
    const sessions = this.requireSessions();
    const previous = this.sessionTransactions.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(() => write(sessions));
    // Failures release the lane, and an older completion cannot remove a newer tail.
    const tail = operation.then(() => undefined, () => undefined);
    this.sessionTransactions.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTransactions.get(sessionId) === tail) this.sessionTransactions.delete(sessionId);
    });
    return operation;
  }

  private requireMappings(): MappingTable {
    if (this.mappingTable === undefined) throw new Error('azure-sync: local store is not open.');
    return this.mappingTable;
  }

  private requireDevices(): DeviceTable {
    if (this.deviceTable === undefined) throw new Error('azure-sync: local store is not open.');
    return this.deviceTable;
  }

  private requireSettings(): SettingsTable {
    if (this.settingsTable === undefined) throw new Error('azure-sync: local store is not open.');
    return this.settingsTable;
  }

  getSession(sessionId: string): LocalSessionRecord | undefined {
    return this.requireSessions().get(sessionId);
  }

  async putSession(record: LocalSessionRecord): Promise<void> {
    const parsed = parseRecord(localSessionRecordSchema, record, 'local session record');
    await this.enqueueSessionWrite(parsed.sessionId, (sessions) => sessions.put(parsed.sessionId, parsed));
  }

  /** Transform the latest durable record in the domain write chain; never create a missing record. */
  async mutateSession(sessionId: string, fn: (current: LocalSessionRecord) => LocalSessionRecord): Promise<void> {
    const schema = localSessionRecordSchema.refine((record) => record.sessionId === sessionId);
    await this.enqueueSessionWrite(sessionId, async (sessions) => {
      let found = false;
      try {
        await sessions.update(sessionId, (current) => {
          found = true;
          return parseRecord(schema, fn(current), 'local session record');
        });
      } catch (error) {
        if (!found && error instanceof DomainError && error.code === 'missing-key') return;
        throw error;
      }
    });
  }

  /**
   * Serialize local permission changes, including first creation, across every
   * caller sharing this store. The synchronous transform must not do network I/O.
   * Returning undefined leaves the record untouched and returns undefined.
   */
  async transactSession(sessionId: string, fn: (current: LocalSessionRecord | undefined) => LocalSessionRecord | undefined): Promise<LocalSessionRecord | undefined> {
    const schema = localSessionRecordSchema.refine((record) => record.sessionId === sessionId);
    return this.enqueueSessionWrite(sessionId, async (sessions) => {
      const unchanged = Symbol('unchanged session');
      let found = false;
      try {
        return await sessions.update(sessionId, (current) => {
          found = true;
          const next = fn(current);
          if (next === undefined) throw unchanged;
          return parseRecord(schema, next, 'local session record');
        });
      } catch (error) {
        if (error === unchanged) return undefined;
        if (found || !(error instanceof DomainError) || error.code !== 'missing-key') throw error;
      }
      // The SDK evaluated absence in its write chain. Reevaluate the transform
      // for creation, never reuse a stale full record from an update attempt.
      // All permission creators share this lane through the durable initial put.
      const next = fn(undefined);
      if (next === undefined) return undefined;
      const parsed = parseRecord(schema, next, 'local session record');
      await sessions.put(sessionId, parsed);
      return parsed;
    });
  }

  listSessions(): IterableIterator<[string, LocalSessionRecord]> {
    return this.requireSessions().entries();
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.enqueueSessionWrite(sessionId, (sessions) => sessions.delete(sessionId));
  }

  /** Conditionally delete SDK-current state while excluding every other local session writer. */
  async deleteSessionIf(sessionId: string, predicate: (latest: LocalSessionRecord) => boolean): Promise<boolean> {
    const schema = localSessionRecordSchema.refine((record) => record.sessionId === sessionId);
    return this.enqueueSessionWrite(sessionId, async (sessions) => {
      const checked = Symbol('checked session');
      let found = false;
      let shouldDelete = false;
      try {
        await sessions.update(sessionId, (current) => {
          found = true;
          shouldDelete = predicate(parseRecord(schema, current, 'local session record'));
          // The public SDK has no conditional delete; abort this check's update
          // without writing or emitting, and keep the local lane through delete.
          throw checked;
        });
      } catch (error) {
        if (error !== checked) {
          if (!found && error instanceof DomainError && error.code === 'missing-key') return false;
          throw error;
        }
      }
      return shouldDelete ? sessions.delete(sessionId) : false;
    });
  }

  getMapping(id: string): PathMappingRecord | undefined {
    return this.requireMappings().get(id);
  }

  async putMapping(record: PathMappingRecord): Promise<void> {
    const parsed = parseRecord(pathMappingSchema, record, 'path mapping record');
    await this.requireMappings().put(parsed.id, parsed);
  }

  async deleteMapping(id: string): Promise<boolean> {
    return this.requireMappings().delete(id);
  }

  listMappings(): IterableIterator<[string, PathMappingRecord]> {
    return this.requireMappings().entries();
  }

  getDevice(): LocalDeviceRecord | undefined {
    return this.requireDevices().get('self');
  }

  async putDevice(record: LocalDeviceRecord): Promise<void> {
    await this.requireDevices().put('self', parseRecord(localDeviceSchema, record, 'local device record'));
  }

  getSettings(): LocalSettingsRecord | undefined {
    return this.requireSettings().get('config');
  }

  async putSettings(record: LocalSettingsRecord): Promise<void> {
    await this.requireSettings().put('config', parseRecord(localSettingsSchema, record, 'local settings record'));
  }

  async close(): Promise<void> {
    const domain = this.domain;
    this.domain = undefined;
    this.sessionTable = undefined;
    this.mappingTable = undefined;
    this.deviceTable = undefined;
    this.settingsTable = undefined;
    // Accepted session operations may still be waiting for their local lane
    // rather than the SDK chain. Drain them before closing the captured table.
    await Promise.all(this.sessionTransactions.values());
    if (domain !== undefined) await domain.close();
  }
}
