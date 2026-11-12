import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const PI = '@earendil-works/pi-ai';
const BETTER_MANIFEST = new URL('../packages/better-copilot/package.json', import.meta.url);

/** The pi-ai package the adapter itself resolves, including a nested pnpm layout. */
export function adapterPiRoot(adapterEntry: string): string {
  let directory = dirname(adapterEntry);
  for (;;) {
    const candidate = join(directory, 'node_modules', ...PI.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot resolve ' + PI + ' from ' + adapterEntry);
    directory = parent;
  }
}

/** Anchor adapter selection to the package under test, never the tooling's root. */
export function adapterEntryForPackage(manifestFile: string | URL = BETTER_MANIFEST): string {
  return createRequire(manifestFile).resolve(ADAPTER);
}

export function adapterPiVersion(adapterEntry = adapterEntryForPackage()): string {
  const manifest: { version?: unknown } = JSON.parse(readFileSync(join(adapterPiRoot(adapterEntry), 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('The adapter-resolved ' + PI + ' has no version');
  return manifest.version;
}

function main(): void {
  const expected = process.argv[2];
  const manifestFile = process.argv[3] === undefined ? BETTER_MANIFEST : resolve(process.argv[3], 'package.json');
  const actual = adapterPiVersion(adapterEntryForPackage(manifestFile));
  if (expected !== undefined && actual !== expected) {
    console.error('adapter-resolved ' + PI + ' is ' + actual + ', expected ' + expected);
    process.exitCode = 1;
    return;
  }
  console.log('adapter-resolved ' + PI + ': ' + actual);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
