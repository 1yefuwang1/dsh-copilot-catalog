import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

/** A complete Copilot-facing identity, or the minimal fingerprint fix. */
export type WireIdentityMode = 'basic' | 'full';
export type WireIdentitySetting = WireIdentityMode | 'off';

export interface CopilotWireIdentity {
  readonly mode: WireIdentityMode;
  readonly userAgent: string;
  readonly editorVersion: string;
  readonly editorPluginVersion: string;
  readonly copilotIntegrationId: string;
  readonly githubApiVersion: string;
  readonly userAgentLibraryVersion: string;
  readonly editorDeviceId?: string;
  readonly machineId?: string;
  readonly sessionId?: string;
}

export interface CopilotWireIdentityOverrides {
  readonly userAgent?: string;
  readonly editorVersion?: string;
  readonly editorPluginVersion?: string;
  readonly copilotIntegrationId?: string;
  readonly githubApiVersion?: string;
  readonly userAgentLibraryVersion?: string;
  readonly editorDeviceId?: string;
  readonly machineId?: string;
  readonly sessionId?: string;
}

const BASE_IDENTITY = Object.freeze({
  userAgent: 'GitHubCopilotChat/0.68.0',
  editorVersion: 'vscode/1.140.0',
  editorPluginVersion: 'copilot-chat/0.68.0',
  copilotIntegrationId: 'vscode-chat',
  githubApiVersion: '2026-08-01',
  userAgentLibraryVersion: 'electron-fetch',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEADER_VALUE_UNSAFE = /[\u0000-\u001f\u007f]/u;
const INVALID_MACS = new Set(['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', 'ac:de:48:00:11:22']);
const COPILOT_REQUEST_PATHS = ['/models', '/chat/completions', '/responses', '/v1/messages', '/embeddings'] as const;
const REMOVED_HEADERS = ['openai-organization', 'openai-project', 'anthropic-dangerous-direct-browser-access'] as const;
const GHE_COPILOT_HOST = /^copilot-api\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/u;

function assertIdentityValue(value: string, name: string): void {
  if (!value || value.length > 1024 || HEADER_VALUE_UNSAFE.test(value)) {
    throw new TypeError(`Invalid Copilot wire identity value: ${name}`);
  }
}

function xdgDirectory(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() ? value : join(homedir(), fallback);
}

function machineIdPath(): string | undefined {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'machineid');
  if (process.platform === 'linux') return join(xdgDirectory(process.env.XDG_CONFIG_HOME, '.config'), 'Code', 'machineid');
  const appData = process.env.APPDATA;
  if (process.platform === 'win32' && appData !== undefined && appData.trim()) return join(appData, 'Code', 'machineid');
  return undefined;
}

function editorDeviceIdPath(): string | undefined {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Microsoft', 'DeveloperTools', 'deviceid');
  }
  if (process.platform === 'linux') {
    return join(xdgDirectory(process.env.XDG_CACHE_HOME, '.cache'), 'Microsoft', 'DeveloperTools', 'deviceid');
  }
  return undefined;
}

/** Read and validate a local UUID identity file; every failure is a safe absence. */
export function readStoredUuid(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    const value = readFileSync(path, 'utf8').trim();
    return UUID.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function firstMac(): string | undefined {
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        const mac = entry.mac.replaceAll('-', ':').toLowerCase();
        if (mac && !INVALID_MACS.has(mac)) return mac;
      }
    }
  } catch {
    // Best-effort hardware identity only.
  }
  return undefined;
}

/** A stable UUID-shaped fallback so the header never carries a MAC verbatim. */
export function machineIdFromMac(mac: string | undefined): string {
  const digest = createHash('sha256').update(mac ?? randomUUID(), 'utf8').digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Build the identity once per mount.
 *
 * `basic` never touches the filesystem. `full` uses the same local VS Code
 * identity files as the official client when present, with UUID fallbacks.
 */
export function createCopilotWireIdentity(
  mode: WireIdentityMode = 'full',
  overrides: CopilotWireIdentityOverrides = {},
): CopilotWireIdentity {
  if (mode !== 'basic' && mode !== 'full') throw new TypeError('Invalid Copilot wire identity mode');
  const userAgent = overrides.userAgent ?? BASE_IDENTITY.userAgent;
  const editorVersion = overrides.editorVersion ?? BASE_IDENTITY.editorVersion;
  const editorPluginVersion = overrides.editorPluginVersion ?? BASE_IDENTITY.editorPluginVersion;
  const copilotIntegrationId = overrides.copilotIntegrationId ?? BASE_IDENTITY.copilotIntegrationId;
  const githubApiVersion = overrides.githubApiVersion ?? BASE_IDENTITY.githubApiVersion;
  const userAgentLibraryVersion = overrides.userAgentLibraryVersion ?? BASE_IDENTITY.userAgentLibraryVersion;
  for (const [name, value] of Object.entries({
    userAgent, editorVersion, editorPluginVersion, copilotIntegrationId, githubApiVersion, userAgentLibraryVersion,
  })) assertIdentityValue(value, name);

  if (mode === 'basic') {
    // Explicitly ignore device/machine/session overrides: basic stays file-free.
    return Object.freeze({
      mode, userAgent, editorVersion, editorPluginVersion, copilotIntegrationId,
      githubApiVersion, userAgentLibraryVersion,
    });
  }

  const editorDeviceId = overrides.editorDeviceId ?? readStoredUuid(editorDeviceIdPath()) ?? randomUUID();
  const machineId = overrides.machineId ?? readStoredUuid(machineIdPath()) ?? machineIdFromMac(firstMac());
  const sessionId = overrides.sessionId ?? randomUUID();
  for (const [name, value] of Object.entries({ editorDeviceId, machineId, sessionId })) assertIdentityValue(value, name);
  return Object.freeze({
    mode, userAgent, editorVersion, editorPluginVersion, copilotIntegrationId,
    githubApiVersion, userAgentLibraryVersion, editorDeviceId, machineId, sessionId,
  });
}

/** The complete discovery trust shape: HTTPS, no userinfo, default port, known host. */
export function isTrustedCopilotUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      (url.port !== '' && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return host.endsWith('.githubcopilot.com') || GHE_COPILOT_HOST.test(host);
}

/** Exact path or slash-delimited descendant, never a bare string prefix. */
export function isCopilotRequestPath(pathname: string): boolean {
  return COPILOT_REQUEST_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/**
 * Rewrite only Copilot identity and SDK-fingerprint headers.
 *
 * Behavior headers (`X-GitHub-Api-Version`, `Openai-Intent`, `X-Interaction-Type`,
 * `Content-Type`, `X-Interaction-Id`) are preserved exactly, including absence.
 * Only identity headers are overridden and SDK fingerprints removed.
 */
export function rewriteCopilotRequestHeaders(url: URL, headers: Headers, identity: CopilotWireIdentity): boolean {
  if (!isTrustedCopilotUrl(url) || !isCopilotRequestPath(url.pathname)) return false;

  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-stainless-')) headers.delete(name);
  }
  for (const name of REMOVED_HEADERS) headers.delete(name);

  headers.set('user-agent', identity.userAgent);
  headers.set('editor-version', identity.editorVersion);
  headers.set('editor-plugin-version', identity.editorPluginVersion);
  headers.set('copilot-integration-id', identity.copilotIntegrationId);

  if (identity.mode === 'basic') return true;

  const { editorDeviceId, machineId, sessionId } = identity;
  if (editorDeviceId === undefined || machineId === undefined || sessionId === undefined) {
    throw new TypeError('Full Copilot wire identity requires device, machine, and session IDs');
  }
  headers.set('editor-device-id', editorDeviceId);
  headers.set('vscode-machineid', machineId);
  headers.set('vscode-sessionid', sessionId);
  headers.set('x-vscode-user-agent-library-version', identity.userAgentLibraryVersion);

  const requestId = headers.get('x-request-id')?.trim() || randomUUID();
  headers.set('x-request-id', requestId);
  if (!headers.get('x-agent-task-id')?.trim()) headers.set('x-agent-task-id', requestId);

  return true;
}

/** `full` is the default; `basic` is the minimal fingerprint fix; `0` disables. */
export function wireIdentityMode(env: NodeJS.ProcessEnv = process.env): WireIdentitySetting {
  const value = env.DSH_COPILOT_WIRE_IDENTITY?.trim().toLowerCase();
  if (value === '0' || value === 'off' || value === 'false') return 'off';
  if (value === 'basic') return 'basic';
  return 'full';
}

type Fetch = typeof globalThis.fetch;

interface ControllerState {
  active: boolean;
  readonly identity: CopilotWireIdentity;
  installs: number;
  readonly wrappers: WeakSet<Fetch>;
  readonly downstreams: WeakMap<Fetch, Fetch>;
  current?: { wrapper: Fetch; downstream: Fetch };
}

let controller: ControllerState | undefined;

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return new URL(input.href);
  return new URL(input);
}

/**
 * Derive the effective header set without touching the body.
 *
 * A supplied `init.headers` replaces the Request's headers per Fetch; an
 * explicit empty set must therefore keep Authorization cleared.
 */
function effectiveHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

function createWrapper(state: ControllerState, downstream: Fetch): Fetch {
  const wrapper: Fetch = (input, init) => {
    // Cached SDK clients may still call this wrapper after the last release.
    if (!state.active) return downstream(input, init);
    let url: URL;
    let headers: Headers;
    try {
      url = requestUrl(input);
      if (!isTrustedCopilotUrl(url) || !isCopilotRequestPath(url.pathname)) return downstream(input, init);
      headers = effectiveHeaders(input, init);
      rewriteCopilotRequestHeaders(url, headers, state.identity);
    } catch {
      // Only pre-dispatch normalization failures are fail-open; the request is
      // delegated once and its eventual rejection is never caught or retried.
      return downstream(input, init);
    }
    return downstream(input, { ...init, headers });
  };
  state.wrappers.add(wrapper);
  state.downstreams.set(wrapper, downstream);
  return wrapper;
}

function attach(state: ControllerState): void {
  const currentFetch = globalThis.fetch;
  if (state.wrappers.has(currentFetch)) {
    const downstream = state.downstreams.get(currentFetch);
    if (downstream === undefined) throw new Error('Copilot wire identity wrapper state is inconsistent');
    state.current = { wrapper: currentFetch, downstream };
    return;
  }
  const wrapper = createWrapper(state, currentFetch);
  state.current = { wrapper, downstream: currentFetch };
  globalThis.fetch = wrapper;
}

/**
 * Install a process-wide Copilot header interceptor.
 *
 * Each install owns an idempotent release handle. The first live install owns
 * the identity; later installs share it. The last release deactivates every
 * wrapper this controller created, so SDK clients that cached one pass through
 * untouched. A later install after an external fetch replacement re-wraps the
 * current fetch rather than reusing stale installation state.
 */
export function installCopilotIdentityHeaders(identity: CopilotWireIdentity = createCopilotWireIdentity()): () => void {
  if (typeof globalThis.fetch !== 'function') return () => {};
  if (controller === undefined) {
    controller = {
      active: true,
      identity,
      installs: 0,
      wrappers: new WeakSet(),
      downstreams: new WeakMap(),
    };
  }
  const state = controller;
  try {
    attach(state);
  } catch (error) {
    if (state.installs === 0 && controller === state) controller = undefined;
    throw error;
  }
  state.installs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.installs -= 1;
    if (state.installs > 0) return;
    state.active = false;
    if (state.current !== undefined && globalThis.fetch === state.current.wrapper) {
      globalThis.fetch = state.current.downstream;
    }
    if (controller === state) controller = undefined;
  };
}
