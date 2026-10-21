/** Durable USER profile admission proof, not a dynamically versioned bundle promise. */
import type { Context } from '@deepseek-ai/cordis';
import type { Loader, EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot';
import { readBoundedFile } from './claims.js';
import { CLOUD_IMPORT_READINESS, type ImportGuardV1 } from './guard.js';

const GUARD_MODULE = '@1yefuwang1/dsh-azure-sync/import-guard';
const PROVIDER_MODULE = '@1yefuwang1/dsh-azure-sync/import-persistence';
const required = ['sessionPersistence', CLOUD_IMPORT_READINESS];
function injected(value: unknown): boolean {
  return Array.isArray(value) ? required.every(name => value.includes(name))
    : value !== null && typeof value === 'object' && required.every(name => Object.hasOwn(value, name));
}
/** No writes, package installs, native Session resolution or inferred Host authority. */
export async function persistentImportProfileReady(ctx: Context, guard: ImportGuardV1 | undefined): Promise<boolean> {
  try {
    const profile = ctx.get('profileContext') as ProfileContext | undefined;
    const loader = ctx.get('loader') as Loader | undefined;
    const persistence = ctx.get('sessionPersistence') as Context['sessionPersistence'] | undefined;
    if (!profile || !loader || !persistence || !guard || !guard.isGuardedPersistence(persistence.identity)) return false;
    await readBoundedFile(profile.patchPath, 256 * 1024);
    const { loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot');
    const patches = loadOverlayPatches('cloud-import', profile.patchPath);
    // These three literal USER overrides survive removal/downgrade of any bundle.
    if (!patches.some(patch => patch.id === 'session-persistence-jsonl' && patch.disabled === true) ||
        !['session', 'agent-loop'].every(id => patches.some(patch => patch.id === id && injected(patch.inject)))) return false;
    const inserted = patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : []);
    if (![GUARD_MODULE, PROVIDER_MODULE].every(name => inserted.some(row => row.name === name && row.disabled !== true))) return false;
    const rows = [...loader.entries()];
    const base = rows.find(row => row.options.id === 'session-persistence-jsonl');
    if (!base?.disabled) return false;
    for (const id of ['session', 'agent-loop']) {
      const row = rows.find(row => row.options.id === id);
      if (!row || row.disabled || row.fiber?.state !== 2 || !injected((row.options as EntryOptions).inject)) return false;
    }
    return [GUARD_MODULE, PROVIDER_MODULE].every(name => rows.some(row => row.options.name === name && !row.disabled && row.fiber?.state === 2));
  } catch { return false; }
}
