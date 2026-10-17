import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const PI = '@earendil-works/pi-ai';

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

export function adapterPiVersion(adapterEntry = createRequire(import.meta.url).resolve(ADAPTER)): string {
  const manifest: { version?: unknown } = JSON.parse(readFileSync(join(adapterPiRoot(adapterEntry), 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('The adapter-resolved ' + PI + ' has no version');
  return manifest.version;
}

function main(): void {
  const expected = process.argv[2];
  const actual = adapterPiVersion();
  if (expected !== undefined && actual !== expected) {
    console.error('adapter-resolved ' + PI + ' is ' + actual + ', expected ' + expected);
    process.exitCode = 1;
    return;
  }
  console.log('adapter-resolved ' + PI + ': ' + actual);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
