import { createRequire, findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelCatalog, OriginalAdapter, PluginDependencies } from './types.js';

type CatalogModule = typeof import('@earendil-works/pi-ai/providers/github-copilot.models');
type ProviderModule = typeof import('@earendil-works/pi-ai/providers/github-copilot');

/** Resolve pi-ai from the adapter, not the plugin: they must share one catalog. */
export async function loadRuntime(): Promise<PluginDependencies> {
  const require = createRequire(import.meta.url);
  let adapterEntry: string;
  try {
    adapterEntry = require.resolve('@deepseek-ai/dsh-llm-pi-ai');
  } catch {
    throw new Error('dsh-copilot-catalog requires @deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2; install it in the same profile');
  }
  const adapterUrl = pathToFileURL(adapterEntry);
  const piManifest = findPackageJSON('@earendil-works/pi-ai', adapterUrl);
  if (!piManifest) throw new Error('Cannot resolve the DSH adapter\'s pi-ai dependency');
  const piRoot = dirname(piManifest);
  // These are the public providers/* export targets in supported pi-ai 0.87.1.
  // No private OAuth module or platform-specific application path is imported.
  const [original, { GITHUB_COPILOT_MODELS: catalog }, { githubCopilotProvider }] = await Promise.all([
    import(adapterUrl.href) as Promise<OriginalAdapter>,
    import(pathToFileURL(join(piRoot, 'dist/providers/github-copilot.models.js')).href) as Promise<CatalogModule>,
    import(pathToFileURL(join(piRoot, 'dist/providers/github-copilot.js')).href) as Promise<ProviderModule>,
  ]);
  const oauth = githubCopilotProvider().auth?.oauth;
  if (!oauth) throw new Error('The installed pi-ai Copilot provider has no OAuth hooks');
  return { original, catalog: catalog as ModelCatalog, oauth };
}
