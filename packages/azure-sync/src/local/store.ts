/**
 * Local durable sidecar state for opt-in flags, import recovery, mappings, and
 * device/settings metadata. It is a `dsh_azure_sync` storage domain, not a
 * second session store.
 * @module @1yefuwang1/dsh-azure-sync/local/store
 */
import { defineDomain, domainTable, type Domain, type DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain';
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

export const localDomain = defineDomain({
  name: 'dsh_azure_sync',
  version: LOCAL_DOMAIN_VERSION,
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
    await this.requireSessions().put(parsed.sessionId, parsed);
  }

  listSessions(): IterableIterator<[string, LocalSessionRecord]> {
    return this.requireSessions().entries();
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.requireSessions().delete(sessionId);
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
    if (domain !== undefined) await domain.close();
  }
}
