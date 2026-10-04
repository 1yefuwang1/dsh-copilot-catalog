import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SearchRuntime } from './types.js';
import { createSafeCopilotRefresh } from './refresh.js';

type AdapterModule = typeof import('@deepseek-ai/dsh-llm-pi-ai');
type PiModule = typeof import('@earendil-works/pi-ai');
type ProviderModule = typeof import('@earendil-works/pi-ai/providers/github-copilot');

const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
});

/** Load public peers from the adapter's location, including nested pnpm layouts. */
export async function loadRuntime(options: { fetcher?: typeof globalThis.fetch } = {}): Promise<SearchRuntime> {
  const require = createRequire(import.meta.url);
  let adapterEntry: string;
  try { adapterEntry = require.resolve('@deepseek-ai/dsh-llm-pi-ai'); } catch {
    throw new Error('dsh-copilot-search requires @deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2 in the same profile');
  }
  const adapterUrl = pathToFileURL(adapterEntry);
  const manifest = findPackageJSON('@earendil-works/pi-ai', adapterUrl);
  if (!manifest) throw new Error('Cannot resolve the DSH adapter\'s pi-ai dependency');
  const root = dirname(manifest);
  const [adapter, pi, copilot] = await Promise.all([
    import(adapterUrl.href) as Promise<AdapterModule>,
    import(pathToFileURL(join(root, 'dist/index.js')).href) as Promise<PiModule>,
    import(pathToFileURL(join(root, 'dist/providers/github-copilot.js')).href) as Promise<ProviderModule>,
  ]);
  const provider = copilot.githubCopilotProvider();
  const oauth = provider.auth.oauth;
  if (typeof adapter.recordKeyFor !== 'function' || typeof pi.createModels !== 'function' || !oauth) {
    throw new Error('Incompatible DSH/pi-ai public authentication API');
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
  return { recordKeyFor: adapter.recordKeyFor, createModels: pi.createModels, provider: guardedProvider, oauth, headers: identity };
}
