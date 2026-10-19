/** Compile-only consumer: import the built public entrypoint, never source internals. */
import {
  CloudController,
  SettingsService, GitProbe, gitGuidance, sanitizeGitRemote, type GitFacts,
  type AuthUpdate,
  type DefaultsUpdate,
  type SettingsView,
  type CloudRequest,
} from '../../dist/index.js';

declare const local: ConstructorParameters<typeof SettingsService>[0]['local'];
declare const config: ConstructorParameters<typeof SettingsService>[0]['config'];
declare const credentials: ConstructorParameters<typeof SettingsService>[0]['credentials'];
declare const core: ConstructorParameters<typeof CloudController>[0]['core'];
declare const source: NonNullable<ConstructorParameters<typeof CloudController>[0]['source']>;

const auth: AuthUpdate = { auth: 'managed-identity', accountName: 'account123', managedIdentityClientId: '11111111-2222-4333-8444-555555555555' };
const defaults: DefaultsUpdate = { defaultEnabled: false, pullOnStartup: false, pollSeconds: 60 };
const settings = new SettingsService({ local, config, credentials, now: () => 1,
  onBeforeChange: async () => undefined, onChange: async () => undefined });
const controller = new CloudController({ local, settings, core, source, exportDirectory: '/safe/export' });
const view: Promise<SettingsView> = settings.get();
const authView: Promise<SettingsView> = settings.setAuth(auth, new AbortController().signal);
const defaultsView: Promise<SettingsView> = settings.setDefaults(defaults);
const configView: typeof config = settings.effectiveConfig();
const readCredential: Promise<string | undefined> = settings.readCredential(config.connectionRef);

declare const gitFacts: GitFacts;
const gitProbe: Promise<GitFacts | null> = new GitProbe({ executable: '/usr/bin/git', timeoutMs: 5_000 }).inspect('/local/project', '/local/project');
void [gitProbe, gitGuidance(gitFacts, null), sanitizeGitRemote('https://example.invalid/repo')];
const requests: CloudRequest[] = [
  { action: 'git-info', sessionId: 'thread' },
  { action: 'status', sessionId: 'thread', limit: 25 },
  { action: 'toggle', sessionId: 'thread', enabled: true },
  { action: 'toggle', sessionId: 'thread', enabled: false },
  { action: 'sync', sessionId: 'thread' },
  { action: 'pull' },
  { action: 'pull', sessionId: 'cold-thread' },
  { action: 'detach', sessionId: 'thread' },
  { action: 'export', sessionId: 'thread' },
  { action: 'repair', sessionId: 'thread', confirmMapping: true },
  { action: 'acknowledge-degraded', sessionId: 'thread' },
  { action: 'check-ownership', sessionId: 'thread' },
  { action: 'takeover', sessionId: 'thread', confirm: true },
  { action: 'resurrect', sessionId: 'thread', confirm: true },
  { action: 'remove', sessionId: 'thread', confirm: true, acknowledgeAttachmentsRetained: true },
  { action: 'map', mapping: { remotePrefix: '/remote', localPrefix: '/local', remotePlatform: 'linux' } },
  { action: 'unmap', mappingId: '11111111-2222-4333-8444-555555555555' },
  { action: 'mappings' },
  { action: 'set-auth', ...auth },
  { action: 'test-auth' },
  { action: 'set-defaults', ...defaults },
];
for (const request of requests) void controller.execute(request, { origin: 'rpc', signal: new AbortController().signal });
void controller.maintenance(async () => undefined);
controller.close();
void [view, authView, defaultsView, configView, readCredential];

// @ts-expect-error Public removal requires explicit confirmation and attachment-retention acknowledgement.
const unconfirmedRemove: CloudRequest = { action: 'remove', sessionId: 'thread' };
// @ts-expect-error Confirming removal does not waive the attachment-retention disclosure.
const undisclosedRemove: CloudRequest = { action: 'remove', sessionId: 'thread', confirm: true };
// @ts-expect-error Takeover cannot be requested without explicit confirmation.
const unconfirmedTakeover: CloudRequest = { action: 'takeover', sessionId: 'thread' };
// @ts-expect-error Resurrection cannot be requested without explicit confirmation.
const unconfirmedResurrection: CloudRequest = { action: 'resurrect', sessionId: 'thread' };
// @ts-expect-error Unsupported conflict merge/overwrite actions are not public control requests.
const unsupportedConflict: CloudRequest = { action: 'merge', sessionId: 'thread' };
// @ts-expect-error A settings response has no secret readback field.
declare const forbiddenSecret: SettingsView['connectionString'];
// @ts-expect-error Credential references remain administrator configuration, not auth updates.
const changedCredentialRef: AuthUpdate = { auth: 'auto', connectionRef: 'OTHER_REF' };
void [unconfirmedRemove, undisclosedRemove, unconfirmedTakeover, unconfirmedResurrection, unsupportedConflict, forbiddenSecret, changedCredentialRef];
