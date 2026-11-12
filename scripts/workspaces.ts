import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ReleaseCandidate {
  path: string;
  manifest: {
    name: string;
    version: string;
    repository?: { url: string; directory?: string };
  };
}

export type PackageManifest = ReleaseCandidate['manifest'] & {
  private?: boolean;
  packageManager?: string;
  main?: string;
  types?: string;
  license?: string;
  exports: Record<string, string | Record<string, string>>;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  publishConfig?: { access?: string; registry?: string };
  dsh?: {
    manifestVersion: number;
    bundle?: { patch?: string };
    client?: { platform?: string; external?: string[]; inject?: string[]; immediately?: boolean };
  };
}

export interface WorkspacePackage extends ReleaseCandidate {
  directory: string;
  manifest: PackageManifest;
}

export const root = fileURLToPath(new URL('../', import.meta.url));
export const workspacePaths = Object.freeze(['packages/better-copilot', 'packages/worktrees']);

type DshRuntime = Pick<typeof import('@deepseek-ai/dsh-app-boot'), 'getDshRuntimeVersion' | 'evaluatePluginCompatibility'>;

/** Resolve SDK packages from this manifest, not from the tooling's private root. */
export async function assertDshSdk(
  manifestFile: string,
  manifest: PackageManifest,
  version = manifest.engines?.dsh,
): Promise<DshRuntime> {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${manifest.name} must declare one exact engines.dsh version`);
  }
  const require = createRequire(manifestFile);
  const sdk = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    for (const [name, declared] of Object.entries(manifest[field] ?? {})) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
      if (declared !== version) throw new Error(`${manifest.name} ${field} SDK ${name} must be exactly ${version}`);
      sdk.add(name);
    }
  }
  const runtime: DshRuntime = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const installed = runtime.getDshRuntimeVersion();
  if (installed !== version) {
    throw new Error(`${manifest.name} resolved SDK runtime is ${installed}, expected exactly ${version}; reinstall from the frozen lockfile`);
  }
  for (const name of sdk) {
    const installedManifest: { version?: unknown } = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
    if (installedManifest.version !== version) {
      throw new Error(`${manifest.name} resolved SDK ${name} is ${String(installedManifest.version)}, expected exactly ${version}`);
    }
  }
  return runtime;
}

/** Git may check out YAML with CRLF on Windows; validate complete rows, not LF substrings. */
export function assertWorkspaceDefinition(definition: string): void {
  const lines = definition.split(/\r\n|\n|\r/u);
  for (const path of workspacePaths) {
    if (!lines.includes(`  - ${path}`)) throw new Error(`Missing pnpm workspace: ${path}`);
  }
}

/** pnpm 11 applies only the first matching package rule; keep one finite exact-version union per name. */
export function minimumReleaseAgeExclusions(definition: string): ReadonlyMap<string, readonly string[]> {
  const lines = definition.split(/\r\n|\n|\r/u);
  const start = lines.indexOf('minimumReleaseAgeExclude:');
  if (start === -1) throw new Error('Missing minimumReleaseAgeExclude policy');
  const rules = new Map<string, readonly string[]>();
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    if (!/^\s/u.test(line)) break;
    const selector = /^  - '([^']+)'$/u.exec(line)?.[1];
    const match = selector?.match(/^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/u);
    if (!match) throw new Error('Release-age exclusions must be quoted package names with finite exact version unions');
    const name = match[1]!;
    const versions = match[2]!.split(' || ');
    if (versions.some(version => !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version) ||
      version.split('+')[0]!.split('-').slice(1).join('-').split('.').some(identifier => /^0\d+$/u.test(identifier)))) {
      throw new Error(`${name} release-age exclusion must use finite exact semver version unions`);
    }
    if (rules.has(name)) throw new Error(`Duplicate release-age package rule shadows later versions: ${name}`);
    rules.set(name, versions);
  }
  return rules;
}

/** Resolve only the explicitly registered publishable leaves, never the private root or arbitrary paths. */
export async function packages(target?: string): Promise<WorkspacePackage[]> {
  const requested = target === undefined ? undefined : resolve(process.cwd(), target);
  const results: WorkspacePackage[] = [];
  for (const path of workspacePaths) {
    const directory = resolve(root, path);
    if (requested !== undefined && requested !== directory) continue;
    if (await realpath(directory) !== directory) throw new Error(`Workspace directory must not be a symlink: ${path}`);
    const manifest: PackageManifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    if (manifest.private) throw new Error(`Workspace must be publishable: ${path}`);
    results.push({ path, directory, manifest });
  }
  if (!results.length) throw new Error(`Select one of ${workspacePaths.join(', ')}, not the private monorepo root or an arbitrary path`);
  return results;
}

export function packageManager(args: string[]): { command: string; args: string[]; shell: boolean } {
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

export function containedPath(directory: string, path: string): string {
  const result = resolve(directory, path);
  const local = relative(directory, result);
  if (local === '..' || local.startsWith(`..${sep}`) || resolve(local) === local) {
    throw new Error('Package metadata contains an escaping file path');
  }
  return result;
}

/** Versioned releases select exactly one package; the private root cannot be published. */
export function releasePackage<T extends ReleaseCandidate>(tag: string | undefined, candidates: readonly T[]): T {
  const candidate = candidates.find(({ manifest }) => tag === `${manifest.name}-v${manifest.version}`);
  if (!candidate) throw new Error('Release tag must be <package-name>-v<package-version> for exactly one workspace');
  if (candidates.filter(({ manifest }) => tag === `${manifest.name}-v${manifest.version}`).length !== 1) {
    throw new Error('Release tag ambiguously selects more than one workspace');
  }
  return candidate;
}
