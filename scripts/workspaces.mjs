import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const workspacePaths = Object.freeze(['packages/catalog', 'packages/search']);

/** Git may check out YAML with CRLF on Windows; validate complete rows, not LF substrings. */
export function assertWorkspaceDefinition(definition) {
  const lines = definition.split(/\r\n|\n|\r/u);
  for (const path of workspacePaths) {
    if (!lines.includes(`  - ${path}`)) throw new Error(`Missing pnpm workspace: ${path}`);
  }
}

/** Resolve only the two known publishable leaves, never the private root or arbitrary paths. */
export async function packages(target) {
  const requested = target === undefined ? undefined : resolve(process.cwd(), target);
  const results = [];
  for (const path of workspacePaths) {
    const directory = resolve(root, path);
    if (requested !== undefined && requested !== directory) continue;
    if (await realpath(directory) !== directory) throw new Error(`Workspace directory must not be a symlink: ${path}`);
    const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    if (manifest.private) throw new Error(`Workspace must be publishable: ${path}`);
    results.push({ path, directory, manifest });
  }
  if (!results.length) throw new Error('Select packages/catalog or packages/search, not the private monorepo root');
  return results;
}

export function packageManager(args) {
  const executable = process.env.npm_execpath;
  if (executable && /(?:^|[/\\])pnpm\.(?:cjs|mjs|js)$/u.test(executable)) {
    return { command: process.execPath, args: [executable, ...args], shell: false };
  }
  // Standalone pnpm is a native executable, not a Node.js entry point.
  if (executable && /(?:^|[/\\])pnpm(?:\.exe)?$/u.test(executable)) {
    return { command: executable, args, shell: false };
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, shell: process.platform === 'win32' };
}

export function containedPath(directory, path) {
  const result = resolve(directory, path);
  const local = relative(directory, result);
  if (local === '..' || local.startsWith(`..${sep}`) || resolve(local) === local) {
    throw new Error('Package metadata contains an escaping file path');
  }
  return result;
}

/** Versioned releases select exactly one package; the private root cannot be published. */
export function releasePackage(tag, candidates) {
  const candidate = candidates.find(({ manifest }) => tag === `${manifest.name}-v${manifest.version}`);
  if (!candidate) throw new Error('Release tag must be <package-name>-v<package-version> for exactly one workspace');
  if (candidates.filter(({ manifest }) => tag === `${manifest.name}-v${manifest.version}`).length !== 1) {
    throw new Error('Release tag ambiguously selects more than one workspace');
  }
  return candidate;
}
