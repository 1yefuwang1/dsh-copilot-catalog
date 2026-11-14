import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { root, workspacePaths, packages, containedPath, releasePackage, assertDshSdk, assertWorkspaceDefinition, minimumReleaseAgeExclusions, packageManager, type PackageManifest } from '../workspaces.js';
import { releaseIdentity } from '../release.js';
import { findCredentialIssues } from '../check-secrets.js';
import { publicationPolicy, validatePublicationMetadata, validatePublicationSize } from '../check-pack.js';
import { adapterEntryForPackage, adapterPiRoot, adapterPiVersion } from '../check-pi.js';

async function installedFixture(directory: string, name: string, version: string): Promise<string> {
  const packageDirectory = resolve(directory, 'node_modules', name);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(resolve(packageDirectory, 'package.json'), JSON.stringify({
    name, version, type: 'module', exports: { '.': './index.js', './package.json': './package.json' },
  }));
  await writeFile(resolve(packageDirectory, 'index.js'), name === '@deepseek-ai/dsh-app-boot'
    ? `import { readFileSync } from 'node:fs';
export function getDshRuntimeVersion() { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version; }
`
    : 'export {};\n');
  return resolve(packageDirectory, 'index.js');
}

function sdkFixtureManifest(name: string, version: string): PackageManifest {
  return {
    name, version: '1.0.0', exports: {}, scripts: {}, engines: { dsh: version },
    devDependencies: { '@deepseek-ai/dsh-agent': version },
  };
}

const repository = '1yefuwang1/dsh-copilot-catalog';
const candidates = [
  { path: 'packages/better-copilot', name: 'dsh-better-copilot', version: '0.1.0' },
  { path: 'packages/worktrees', name: '@1yefuwang1/dsh-worktrees', version: '0.1.0' },
].map(({ path, name, version }) => ({ path, manifest: {
  name, version, repository: { url: `git+https://github.com/${repository}.git`, directory: path },
} }));

test('pnpm launcher distinguishes JavaScript and native executables without splitting arguments', () => {
  const previous = process.env.npm_execpath;
  const args = ['pack', '--pack-destination', 'directory with spaces'];
  const before = [...args];
  try {
    for (const executable of ['/tools/pnpm.cjs', '/tools with spaces/pnpm.js', String.raw`C:\tools\pnpm.js`]) {
      process.env.npm_execpath = executable;
      assert.deepEqual(packageManager(args), { command: process.execPath, args: [executable, ...args], shell: false });
    }
    for (const executable of ['/tools/pnpm', '/tools with spaces/pnpm', '/tools/pnpm.exe', String.raw`C:\tools with spaces\pnpm.exe`]) {
      process.env.npm_execpath = executable;
      assert.deepEqual(packageManager(args), { command: executable, args, shell: false });
    }
    for (const executable of [undefined, '', '/tools/npm-cli.js', '/tools/yarn.js', '/tools/notpnpm', String.raw`C:\tools\pnpm.cmd`]) {
      if (executable === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = executable;
      assert.deepEqual(packageManager(args), {
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, shell: process.platform === 'win32',
      });
    }
    assert.deepEqual(args, before);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
});

test('workspace validation accepts LF, CRLF, CR, mixed endings and no final newline', () => {
  const rows = ['packages:', ...workspacePaths.map((path) => `  - ${path}`)];
  for (const ending of ['\n', '\r\n', '\r']) {
    assert.doesNotThrow(() => assertWorkspaceDefinition(rows.join(ending)));
    assert.doesNotThrow(() => assertWorkspaceDefinition(rows.join(ending) + ending));
  }
  const endings = ['\r\n', '\n', '\r'];
  const mixed = ['packages:', ...workspacePaths.map((path) => `  - ${path}`)]
    .map((line, index) => index === 0 ? line : endings[(index - 1) % endings.length]! + line).join('');
  assert.doesNotThrow(() => assertWorkspaceDefinition(mixed));
});

test('workspace validation rejects every missing, substring-only or commented package row', () => {
  for (const missing of workspacePaths) {
    const otherRows = workspacePaths.filter(path => path !== missing).map(path => `  - ${path}`);
    for (const row of ['', `  - ${missing}-extra`, `#  - ${missing}`]) {
      assert.throws(() => assertWorkspaceDefinition(['packages:', ...otherRows, row].join('\n')), /Missing pnpm workspace/u);
    }
  }
});

test('release-age exclusions accept finite exact unions and reject shadowing, globs and ranges', () => {
  const policy = (...rules: string[]): string => ['minimumReleaseAgeExclude:', ...rules.map(rule => `  - '${rule}'`), 'onlyBuiltDependencies: []'].join('\n');
  const name = '@deepseek-ai/dsh-agent';
  for (const ending of ['\n', '\r\n', '\r']) {
    const parsed = minimumReleaseAgeExclusions(policy(`${name}@0.2.2-rc.1 || 0.2.2-rc.3`, 'unscoped@1.2.3+build').replaceAll('\n', ending));
    assert.deepEqual([...parsed], [[name, ['0.2.2-rc.1', '0.2.2-rc.3']], ['unscoped', ['1.2.3+build']]]);
  }
  assert.throws(() => minimumReleaseAgeExclusions(policy(`${name}@0.2.2-rc.1`, `${name}@0.2.2-rc.3`)), /Duplicate release-age package rule shadows/u);
  for (const version of ['*', '^0.2.2-rc.3', '~0.2.2', '>=0.2.2', '0.2', 'latest', '0.2.x', 'workspace:*', '0.2.2-rc.1 || *', '0.2.2 ||', '01.2.3', '0.2.2-rc.01']) {
    assert.throws(() => minimumReleaseAgeExclusions(policy(`${name}@${version}`)), /finite exact/u, version);
  }
  for (const rule of ['@deepseek-ai/*@0.2.2-rc.3', name]) {
    assert.throws(() => minimumReleaseAgeExclusions(policy(rule)), /finite exact/u);
  }
});

test('first applicable release-age rules cover both unchanged root rc1 and leaf-specific SDK pins', async () => {
  const definition = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  const rules = [...minimumReleaseAgeExclusions(definition)];
  const rootManifest: PackageManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(rootManifest.devDependencies?.['@deepseek-ai/dsh-agent'], '0.2.2-rc.1');
  const leaves = await packages();
  assert.equal(leaves.find(leaf => leaf.path === 'packages/better-copilot')?.manifest.engines?.dsh, '0.2.2-rc.3');
  assert.equal(leaves.find(leaf => leaf.path === 'packages/worktrees')?.manifest.engines?.dsh, '0.2.2-rc.1');
  for (const manifest of [rootManifest, ...leaves.map(leaf => leaf.manifest)]) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
        const firstRule = rules.find(([packageName]) => packageName === name);
        assert.ok(firstRule?.[1].includes(version), `${manifest.name} ${name}@${version} must be covered by the first applicable exact release-age rule`);
      }
    }
  }
});

test('the private root is not a publication target and both leaves resolve portably', async () => {
  assert.deepEqual(workspacePaths, ['packages/better-copilot', 'packages/worktrees']);
  const leaves = await packages();
  assert.deepEqual(leaves.map(({ manifest }) => manifest.name), ['dsh-better-copilot', '@1yefuwang1/dsh-worktrees']);
  for (const path of workspacePaths) {
    const selected = await packages(resolve(root, path));
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.path, path);
  }
  await assert.rejects(packages(root), /private monorepo root/u);
  await assert.rejects(packages(resolve(root, 'unrelated')), /private monorepo root/u);
});

test('publication content paths cannot escape their selected package', () => {
  const directory = resolve(root, 'packages/better-copilot');
  assert.equal(containedPath(directory, 'dist/index.js'), resolve(directory, 'dist/index.js'));
  for (const path of ['../../outside', '/outside']) assert.throws(() => containedPath(directory, path), /escaping/u);
});

test('versioned package tags select exactly one package, never a bare version tag', () => {
  assert.equal(releasePackage('dsh-better-copilot-v0.1.0', candidates), candidates[0]);
  assert.equal(releasePackage('@1yefuwang1/dsh-worktrees-v0.1.0', candidates), candidates[1]);
  for (const tag of ['v0.2.0', 'dsh-worktrees-v0.1.0', '1yefuwang1-dsh-worktrees-v0.1.0', 'dsh-better-copilot-v0.2.0', 'dsh-better-copilot-v0.1.0\n', '@1yefuwang1/dsh-worktrees-v0.2.0', '@1yefuwang1/dsh-worktrees-v0.1.0\n', 'dsh-copilot-worktrees-v0.1.0', undefined]) {
    assert.throws(() => releasePackage(tag, candidates), /Release tag/u);
  }
  assert.throws(() => releasePackage('dsh-better-copilot-v0.1.0', [candidates[0]!, candidates[0]!]), /ambiguously/u);
});

test('release metadata must match its actual GitHub repository and package directory', () => {
  assert.deepEqual(releaseIdentity('dsh-better-copilot-v0.1.0', repository, candidates), {
    package: 'dsh-better-copilot', version: '0.1.0', directory: 'packages/better-copilot',
  });
  assert.deepEqual(releaseIdentity('@1yefuwang1/dsh-worktrees-v0.1.0', repository, candidates), {
    package: '@1yefuwang1/dsh-worktrees', version: '0.1.0', directory: 'packages/worktrees',
  });
  assert.throws(() => releaseIdentity('dsh-better-copilot-v0.1.0', 'someone/else', candidates), /repository/u);
  assert.throws(() => releaseIdentity('@1yefuwang1/dsh-worktrees-v0.1.0', 'someone/else', candidates), /repository/u);
  const unknown = structuredClone(candidates[0]!);
  unknown.manifest.name = '@1yefuwang1/dsh-worktrees-extra';
  assert.throws(() => releaseIdentity('@1yefuwang1/dsh-worktrees-extra-v0.1.0', repository, [unknown]), /Invalid release package identity/u);
  const unrecognized = structuredClone(candidates[0]!);
  unrecognized.manifest.name = 'dsh-some-other-plugin';
  assert.throws(() => releaseIdentity('dsh-some-other-plugin-v0.1.0', repository, [unrecognized]), /Invalid release package identity/u);
  assert.throws(() => releaseIdentity('dsh-better-copilot-v0.1.0', `${repository}\n`, candidates), /repository/u);
  const incorrect = structuredClone(candidates);
  incorrect[0]!.manifest.repository.directory = 'packages/worktrees';
  assert.throws(() => releaseIdentity('dsh-better-copilot-v0.1.0', repository, incorrect), /repository/u);
});

test('release workflow stages one pnpm package with provenance and no stored token', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /run: pnpm exec tsx scripts\/release\.ts/u);
  assert.match(workflow, /working-directory: \$\{\{ steps\.release\.outputs\.directory \}\}/u);
  assert.match(workflow, /run: pnpm stage publish --provenance --access public/u);
  assert.match(workflow, /id-token: write/u);
  assert.doesNotMatch(workflow, /run: npm |secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
});

test('publication allowlists and bounds preserve every existing leaf and explicitly add Client assets', () => {
  const common = ['CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json'];
  const modules = {
    'dsh-better-copilot': ['index', 'plugin', 'config', 'runtime', 'catalog', 'catalog-adapter', 'catalog-cache', 'catalog-controller', 'catalog-store', 'discovery', 'identity', 'catalog-types', 'auth', 'endpoint', 'errors', 'provider', 'refresh', 'responses', 'search', 'search-types', 'schema', 'guard', 'guard-types', 'auto-review', 'temperature'],
    '@1yefuwang1/dsh-worktrees': ['index', 'types', 'errors', 'runtime', 'schema', 'store', 'sessions', 'context', 'service', 'branch-release', 'git', 'naming', 'rpc', 'projects', 'project-store', 'project-rpc', 'project-context', 'quiet-rpc', 'first-message', 'cleanup-store', 'cleanup', 'recovery-rpc'],
  };
  const extras: Record<string, string[]> = {
    'dsh-better-copilot': ['dist/client.js'],
    '@1yefuwang1/dsh-worktrees': ['dist/client.js', 'locale/en.json', 'icon.svg'],
  };
  const bounds: Record<string, number> = {
    'dsh-better-copilot': 230_000,
    '@1yefuwang1/dsh-worktrees': 875_000,
  };
  for (const [name, names] of Object.entries(modules)) {
    const policy = publicationPolicy(name);
    assert.deepEqual(policy.files, [...common, ...names.flatMap(module => [`dist/${module}.js`, `dist/${module}.d.ts`]), ...(extras[name] ?? [])].sort());
    assert.equal(policy.maxBytes, bounds[name] ?? 150_000);
    assert.doesNotThrow(() => validatePublicationSize(name, policy.maxBytes - 1));
    assert.throws(() => validatePublicationSize(name, policy.maxBytes), /Unexpectedly large/u);
    assert.throws(() => validatePublicationSize(name, -1), /Unexpectedly large/u);
    assert.throws(() => validatePublicationSize(name, NaN), /Unexpectedly large/u);
  }
  for (const name of ['private-root', 'dsh-worktrees', 'unknown', 'toString']) assert.throws(() => publicationPolicy(name), /explicit publication allowlist/u);
});

test('worktree tarball metadata rejects extra/missing files, wrong identity and absent exported targets', async () => {
  const [selected] = await packages(resolve(root, 'packages/worktrees'));
  assert.ok(selected);
  const { manifest } = selected;
  assert.equal(manifest.name, '@1yefuwang1/dsh-worktrees');
  assert.deepEqual(manifest.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' });
  const files = publicationPolicy(manifest.name).files;
  assert.equal(files.length, 52);
  const packed = { name: manifest.name, version: manifest.version, files: files.map(path => ({ path })) };
  assert.deepEqual(validatePublicationMetadata(manifest, packed), files);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: [...packed.files, { path: 'src/service.ts' }] }), /Unexpected published files/u);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: packed.files.filter(file => file.path !== 'dist/client.js') }), /Unexpected published files/u);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, name: 'private-root' }));
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, version: '9.9.9' }));
  assert.throws(() => validatePublicationMetadata({ ...manifest, exports: { ...manifest.exports, './absent': './dist/absent.js' } }, packed), /Missing exported file/u);
  assert.equal(manifest.scripts.prepare, undefined);
  assert.equal(manifest.scripts.install, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
});

test('root and every plugin use their own exact installed runtime and preserve exact-pair exemptions', async () => {
  const rootFile = resolve(root, 'package.json');
  const rootManifest: PackageManifest = JSON.parse(await readFile(rootFile, 'utf8'));
  const pinned = rootManifest.devDependencies?.['@deepseek-ai/dsh-agent'];
  assert.equal(pinned, '0.2.2-rc.1');
  const rootRuntime = await assertDshSdk(rootFile, rootManifest, pinned);
  assert.equal(rootRuntime.getDshRuntimeVersion(), pinned, 'the private tooling must remain on rc1');
  const baselines: Record<string, string> = {
    'packages/better-copilot': '0.2.2-rc.3',
    'packages/worktrees': '0.2.2-rc.1',
  };
  for (const { path, directory, manifest } of await packages()) {
    const expected = baselines[path];
    assert.equal(manifest.engines?.dsh, expected, manifest.name + ' must pin its own runtime');
    const runtime = await assertDshSdk(resolve(directory, 'package.json'), manifest);
    assert.equal(runtime.getDshRuntimeVersion(), expected, 'manifest labels must match the leaf-resolved runtime');
    const { evaluatePluginCompatibility } = runtime;
    assert.equal(evaluatePluginCompatibility(manifest), undefined,
      manifest.name + ' must install on its own runtime without an exemption');
    if (path === 'packages/better-copilot') {
      assert.equal(manifest.version, '0.5.1');
      assert.equal(manifest.devDependencies?.['@deepseek-ai/dsh-app-boot'], expected);
      assert.equal(manifest.devDependencies?.['@deepseek-ai/dsh-storage-json'], expected);
      assert.equal(manifest.peerDependencies?.['@earendil-works/pi-ai'], '^1.3.0');
      assert.equal(manifest.devDependencies?.['@earendil-works/pi-ai'], '1.3.0');
    }
    for (const other of ['0.2.0-rc.2', '0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2', '0.2.1', '0.1.9'].filter(version => version !== expected)) {
      const issue = evaluatePluginCompatibility(manifest, {}, other);
      assert.ok(issue, manifest.name + ' must report ' + other + ' as unmet');
      assert.deepEqual(Object.keys(issue.requirements), ['engines.dsh']);
      // An exact-version exemption is the only bypass and must name this exact pair.
      assert.equal(issue.exempted, false);
      const key = manifest.name + '@' + manifest.version;
      const irrelevant = evaluatePluginCompatibility(manifest, { [key]: ['9.9.9'] }, other);
      assert.ok(irrelevant, 'a mismatch is still reported');
      assert.equal(irrelevant.exempted, false, 'an exemption for another runtime must not apply');
      const wrongPlugin = evaluatePluginCompatibility(manifest, { [manifest.name + '@0.0.0']: [other] }, other);
      assert.ok(wrongPlugin);
      assert.equal(wrongPlugin.exempted, false, 'an exemption for another plugin version must not apply');
      const exact = evaluatePluginCompatibility(manifest, { [key]: [other] }, other);
      assert.ok(exact, 'the exact pair is still reported');
      assert.equal(exact.exempted, true, 'only the exact plugin/runtime pair is exempted');
    }
  }
});

test('leaf SDK checks reject root fallback and mixed installed versions while allowing a matching root', async (t) => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'dsh-sdk-tooling-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const leaf = resolve(directory, 'packages/better-copilot');
  const worktrees = resolve(directory, 'packages/worktrees');
  await mkdir(leaf, { recursive: true });
  await mkdir(worktrees, { recursive: true });
  const rootManifest = sdkFixtureManifest('private-root', '0.2.2-rc.1');
  const manifest = sdkFixtureManifest('new-leaf', '0.2.2-rc.3');
  const worktreesManifest = sdkFixtureManifest('old-leaf', '0.2.2-rc.1');
  const manifestFile = resolve(leaf, 'package.json');
  await writeFile(resolve(directory, 'package.json'), JSON.stringify(rootManifest));
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(resolve(worktrees, 'package.json'), JSON.stringify(worktreesManifest));
  await installedFixture(directory, '@deepseek-ai/dsh-app-boot', '0.2.2-rc.1');
  await installedFixture(directory, '@deepseek-ai/dsh-agent', '0.2.2-rc.1');
  const oldRuntime = await assertDshSdk(resolve(worktrees, 'package.json'), worktreesManifest);
  assert.equal(oldRuntime.getDshRuntimeVersion(), '0.2.2-rc.1', 'matching root fallback is valid for Worktrees');
  await assert.rejects(assertDshSdk(manifestFile, manifest), /resolved SDK runtime is 0\.2\.2-rc\.1, expected exactly 0\.2\.2-rc\.3/u);
  await installedFixture(leaf, '@deepseek-ai/dsh-app-boot', '0.2.2-rc.3');
  await assert.rejects(assertDshSdk(manifestFile, manifest), /resolved SDK @deepseek-ai\/dsh-agent is 0\.2\.2-rc\.1, expected exactly 0\.2\.2-rc\.3/u);
  await installedFixture(leaf, '@deepseek-ai/dsh-agent', '0.2.2-rc.3');
  const runtime = await assertDshSdk(manifestFile, manifest);
  assert.equal(runtime.getDshRuntimeVersion(), '0.2.2-rc.3');
  const rootRuntime = await assertDshSdk(resolve(directory, 'package.json'), rootManifest);
  assert.equal(rootRuntime.getDshRuntimeVersion(), '0.2.2-rc.1', 'newer leaf resolution must not retarget the root');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const mixed = { ...manifest, [field]: { '@deepseek-ai/dsh-agent': '0.2.2-rc.1' } };
    await assert.rejects(assertDshSdk(manifestFile, mixed), /SDK @deepseek-ai\/dsh-agent must be exactly 0\.2\.2-rc\.3/u);
  }
  for (const version of [undefined, '', '^0.2.2-rc.3', '>=0.2.2-rc.3', 'workspace:*']) {
    const invalid: PackageManifest = { ...manifest, engines: version === undefined ? {} : { dsh: version } };
    await assert.rejects(assertDshSdk(manifestFile, invalid), /one exact engines\.dsh version/u);
  }
});

test('pi probes select Better Copilot by default, not the private root adapter', () => {
  const expected = createRequire(resolve(root, 'packages/better-copilot/package.json')).resolve('@deepseek-ai/dsh-llm-pi-ai');
  assert.equal(adapterEntryForPackage(), expected);
  assert.equal(adapterPiVersion(), '1.3.0');
});

test('package-targeted pi probes follow the nested adapter dependency rather than a wrong root', async (t) => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'dsh-pi-tooling-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const leaf = resolve(directory, 'packages/better-copilot');
  await mkdir(leaf, { recursive: true });
  const rootFile = resolve(directory, 'package.json');
  const leafFile = resolve(leaf, 'package.json');
  await writeFile(rootFile, JSON.stringify({ private: true }));
  await writeFile(leafFile, JSON.stringify({ name: 'leaf' }));
  const rootEntry = await installedFixture(directory, '@deepseek-ai/dsh-llm-pi-ai', '0.2.2-rc.1');
  const leafEntry = await installedFixture(leaf, '@deepseek-ai/dsh-llm-pi-ai', '0.2.2-rc.3');
  await installedFixture(directory, '@earendil-works/pi-ai', '1.1.0');
  await installedFixture(leaf, '@earendil-works/pi-ai', '9.9.9');
  const nested = await installedFixture(dirname(leafEntry), '@earendil-works/pi-ai', '1.3.0');
  assert.equal(adapterEntryForPackage(rootFile), rootEntry);
  assert.equal(adapterEntryForPackage(leafFile), leafEntry);
  assert.equal(adapterPiVersion(adapterEntryForPackage(rootFile)), '1.1.0', 'the wrong root would pass the old minimum');
  assert.equal(adapterPiRoot(leafEntry), dirname(nested));
  assert.equal(adapterPiVersion(adapterEntryForPackage(leafFile)), '1.3.0', 'only the nested Better adapter is certified');
});

test('CI pins and probes the Better rc3 minimum without weakening recursive verification', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /'@deepseek-ai\/dsh-llm-pi-ai@0\.2\.2-rc\.3>@earendil-works\/pi-ai': 1\.3\.0/u);
  assert.match(workflow, /run: pnpm exec tsx scripts\/check-pi\.ts 1\.3\.0 packages\/better-copilot/u);
  assert.doesNotMatch(workflow, /pi-ai.*1\.1\.0/u);
  assert.equal(workflow.match(/run: pnpm run verify/gu)?.length, 2);
});

test('credential audit catches Copilot tokens, JWTs and static backtick credentials without echoing values', () => {
  const copilot = ['tid=', 'A'.repeat(24), ';exp=', '1791000000', ';proxy-ep=', 'proxy.enterprise.githubcopilot.com'].join('');
  const jwt = ['eyJ' + 'A'.repeat(24), 'B'.repeat(24), 'C'.repeat(24)].join('.');
  const backtick = ['const', 'access', '=', String.fromCharCode(96) + 'not-a-reviewed-credential' + String.fromCharCode(96), ';'].join(' ');
  for (const source of [copilot, jwt, backtick]) {
    const issues = findCredentialIssues('packages/better-copilot/src/example.ts', source);
    assert.ok(issues.length > 0);
    assert.ok(!JSON.stringify(issues).includes(source));
  }
  assert.deepEqual(findCredentialIssues('packages/better-copilot/src/example.ts', 'const authorization = `Bearer ${resolved}`;'), []);
});

test('synthetic-secret exemptions remain confined to each package test tree', () => {
  const fixture = ['const', 'access', '=', "'test-access-token';"].join(' ');
  for (const name of ['better-copilot']) {
    assert.deepEqual(findCredentialIssues(`packages/${name}/test/example.test.ts`, fixture), []);
    assert.ok(findCredentialIssues(`packages/${name}/src/example.ts`, fixture).length > 0);
  }
  // The deleted predecessor test trees no longer have an exemption.
  for (const legacy of ['catalog', 'search', 'tool-schema']) {
    assert.ok(findCredentialIssues(`packages/${legacy}/test/example.test.ts`, fixture).length > 0,
      `packages/${legacy}/test must not exempt synthetic credential literals`);
  }
  assert.ok(findCredentialIssues('packages/unrelated/test/example.test.js', fixture).length > 0);
  assert.ok(findCredentialIssues('packages/better-copilot/dist/index.js', '').length > 0);
  assert.ok(findCredentialIssues('.pnpm-store/example.json', '').length > 0);
  assert.ok(findCredentialIssues('packages/better-copilot/.pnpm-store/example.json', '').length > 0);
});
