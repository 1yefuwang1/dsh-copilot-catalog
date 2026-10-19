import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { packages, packageManager, containedPath, type PackageManifest } from './workspaces.js';

interface Policy { modules: string[]; extras: string[]; maxBytes: number }
export interface PackedPackage { name: string; version: string; files: { path: string }[] }

const policies: Record<string, Policy> = {
  'dsh-copilot-catalog': {
    modules: ['index', 'catalog', 'discovery', 'identity', 'plugin', 'runtime', 'types'],
    extras: [], maxBytes: 150_000,
  },
  'dsh-copilot-search': {
    modules: ['index', 'auth', 'endpoint', 'errors', 'plugin', 'provider', 'refresh', 'responses', 'runtime', 'types'],
    extras: [], maxBytes: 150_000,
  },
  'dsh-copilot-tool-schema': {
    modules: ['index', 'plugin', 'schema', 'types'],
    extras: [], maxBytes: 150_000,
  },
  '@1yefuwang1/dsh-worktrees': {
    modules: ['index', 'types', 'errors', 'runtime', 'schema', 'store', 'sessions', 'context', 'service', 'git', 'naming', 'rpc', 'projects', 'project-store', 'project-rpc', 'project-context', 'quiet-rpc', 'first-message', 'cleanup-store', 'cleanup', 'recovery-rpc'],
    // Readable TypeScript-emitted Client formatting brings the unchanged 50-file
    // allowlist to ~779k; retain bounded headroom without widening other leaves.
    extras: ['dist/client.js', 'locale/en.json', 'icon.svg'], maxBytes: 825_000,
  },
  '@1yefuwang1/dsh-azure-sync': {
    modules: [
      'index', 'config', 'auth', 'runtime', 'schema', 'protocol', 'controller', 'commands', 'rpc', 'settings', 'azure/errors', 'azure/blob', 'azure/table', 'azure/lease',
      'sync/canonical', 'sync/chain', 'sync/committed-index', 'sync/effective-cwd', 'sync/import-state', 'sync/guards',
      'sync/admission', 'sync/batcher', 'sync/blob-metadata', 'sync/cloud-repository', 'sync/drain-coordinator',
      'sync/lease-drain', 'sync/lease-manager', 'sync/lifecycle', 'sync/scheduler', 'sync/service', 'sync/session-source',
      'sync/uploader', 'sync/remote-session', 'sync/attachments', 'sync/projection-warmer', 'sync/importer', 'sync/import-service', 'sync/recovery', 'sync/live-guard', 'sync/conflict', 'sync/reconciler', 'sync/tombstone', 'sync/tombstone-manager', 'sync/poller', 'sync/cleanup', 'sync/workspace', 'local/store', 'git/probe', 'git/sanitize', 'git/guidance',
    ],
    extras: ['dist/client.js', 'locale/en.json', 'icon.svg'], maxBytes: 720_000,
  },
};

/** Exact per-package limits: a new leaf must not widen either existing tarball. */
export function publicationPolicy(name: string) {
  assert.ok(Object.hasOwn(policies, name), 'Package must have an explicit publication allowlist');
  const policy = policies[name];
  assert.ok(policy, 'Package must have an explicit publication allowlist');
  const { modules, extras, maxBytes } = policy;
  return {
    files: [
      'CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
      ...modules.flatMap((module) => [`dist/${module}.js`, `dist/${module}.d.ts`]),
      ...extras,
    ].sort(),
    maxBytes,
  };
}

export function validatePublicationMetadata(pkg: Pick<PackageManifest, 'name' | 'version' | 'exports'>, pack: PackedPackage) {
  const { files } = publicationPolicy(pkg.name);
  const actual = pack.files.map((file) => file.path).sort();
  assert.deepEqual(actual, files, `Unexpected published files in ${pkg.name}; check the allowlist`);
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  for (const entry of Object.values(pkg.exports)) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(actual.includes(target.replace(/^\.\//u, '')), `Missing exported file: ${target}`);
    }
  }
  return actual;
}

export function validatePublicationSize(name: string, unpackedSize: number) {
  assert.ok(Number.isSafeInteger(unpackedSize) && unpackedSize >= 0 && unpackedSize < publicationPolicy(name).maxBytes, `Unexpectedly large package: ${name}`);
}

async function main() {
  for (const { directory, manifest: pkg } of await packages(process.argv[2])) {
    const invocation = packageManager(['pack', '--dry-run', '--json', '--config.ignore-scripts=true']);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: directory, encoding: 'utf8', shell: invocation.shell,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'pnpm pack failed');
    const pack: PackedPackage = JSON.parse(result.stdout);
    const actual = validatePublicationMetadata(pkg, pack);
    let unpackedSize = 0;
    for (const file of actual) unpackedSize += (await readFile(containedPath(directory, file))).byteLength;
    validatePublicationSize(pkg.name, unpackedSize);
    console.log(`pnpm package verified: ${pack.name}@${pack.version}, ${actual.length} allowlisted files, ${unpackedSize} source bytes.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
