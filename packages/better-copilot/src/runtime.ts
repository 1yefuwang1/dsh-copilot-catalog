import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OAuthAuth } from '@earendil-works/pi-ai';
import type { ModelCatalog, OriginalAdapter } from './catalog-types.js';
import { createSafeCopilotRefresh } from './refresh.js';
import type { SearchRuntime } from './search-types.js';

type CatalogModule = typeof import('@earendil-works/pi-ai/providers/github-copilot.models');
type PiModule = typeof import('@earendil-works/pi-ai');
type ProviderModule = typeof import('@earendil-works/pi-ai/providers/github-copilot');

/** Provider identity defaults match the supported pi-ai Copilot OAuth client. */
const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
});

/** Everything the merged plugin needs, resolved once from the adapter's own pi-ai tree. */
export interface BetterCopilotRuntime {
  original: OriginalAdapter;
  catalog: ModelCatalog;
  /** Raw pi-ai hooks: discovery keeps its existing unguarded refresh behaviour. */
  oauth: OAuthAuth;
  recordKeyFor: SearchRuntime['recordKeyFor'];
  createModels: SearchRuntime['createModels'];
  /** Search-owned provider clone; only its refresh hook is wrapped. */
  provider: SearchRuntime['provider'];
  headers: Readonly<Record<string, string>>;
}

export interface RuntimeOptions {
  adapterEntry?: string;
  fetcher?: typeof globalThis.fetch;
}

/**
 * Resolve pi-ai from the adapter, not the plugin: they must share one catalog,
 * one credential key and one public authentication surface, including nested
 * pnpm layouts where the plugin-visible copy differs from the adapter's.
 */
export async function loadRuntime(options: RuntimeOptions = {}): Promise<BetterCopilotRuntime> {
  const require = createRequire(import.meta.url);
  let adapterEntry: string;
  try {
    adapterEntry = options.adapterEntry ?? require.resolve('@deepseek-ai/dsh-llm-pi-ai');
  } catch {
    throw new Error('dsh-better-copilot requires @deepseek-ai/dsh-llm-pi-ai@0.2.2-rc.3; install it in the same profile');
  }
  const adapterUrl = pathToFileURL(adapterEntry);
  const piManifest = findPackageJSON('@earendil-works/pi-ai', adapterUrl);
  if (!piManifest) throw new Error('Cannot resolve the DSH adapter\'s pi-ai dependency');
  const piRoot = dirname(piManifest);
  // These are the public providers/* export targets in supported pi-ai >=1.3.0.
  // No private OAuth module or platform-specific application path is imported.
  const [original, pi, { githubCopilotProvider }, { GITHUB_COPILOT_MODELS: catalog }] = await Promise.all([
    import(adapterUrl.href) as Promise<OriginalAdapter>,
    import(pathToFileURL(join(piRoot, 'dist/index.js')).href) as Promise<PiModule>,
    import(pathToFileURL(join(piRoot, 'dist/providers/github-copilot.js')).href) as Promise<ProviderModule>,
    import(pathToFileURL(join(piRoot, 'dist/providers/github-copilot.models.js')).href) as Promise<CatalogModule>,
  ]);
  const provider = githubCopilotProvider();
  const oauth = provider.auth?.oauth;
  if (typeof original.apply !== 'function' || typeof original.recordKeyFor !== 'function' ||
      !original.Config || !Array.isArray(original.inject) || !catalog ||
      typeof pi.createModels !== 'function' ||
      typeof oauth?.refresh !== 'function' || typeof oauth.toAuth !== 'function') {
    throw new Error('Incompatible DSH/pi-ai runtime; see the supported versions in README');
  }
  const headers = { ...DEFAULT_HEADERS };
  for (const model of provider.getModels()) {
    if (!model.headers) continue;
    for (const key of Object.keys(DEFAULT_HEADERS)) {
      const value = Object.entries(model.headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)) headers[key] = value;
    }
    break;
  }
  const identity = Object.freeze(headers);
  // Clone only this search-owned provider. Never mutate the adapter's provider or host fetch.
  const guardedProvider = {
    ...provider,
    auth: { ...provider.auth, oauth: { ...oauth, refresh: createSafeCopilotRefresh({
      oauth, headers: identity, ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    }) } },
  };
  return {
    original,
    catalog: catalog as ModelCatalog,
    oauth,
    recordKeyFor: original.recordKeyFor as SearchRuntime['recordKeyFor'],
    createModels: pi.createModels as SearchRuntime['createModels'],
    provider: guardedProvider as SearchRuntime['provider'],
    headers: identity,
  };
}
