import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { root, workspacePaths, packages, containedPath, releasePackage, assertWorkspaceDefinition, packageManager } from '../workspaces.js';
import { releaseIdentity } from '../release.js';
import { findCredentialIssues } from '../check-secrets.js';
import { publicationPolicy, validatePublicationMetadata, validatePublicationSize } from '../check-pack.js';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';

const repository = '1yefuwang1/dsh-copilot-catalog';
const candidate = (path: string, name: string, version: string) => ({ path, manifest: {
  name, version, repository: { url: `git+https://github.com/${repository}.git`, directory: path },
} });
const candidates = [
  candidate('packages/catalog', 'dsh-copilot-catalog', '0.2.0'),
  candidate('packages/search', 'dsh-copilot-search', '0.1.0'),
  candidate('packages/tool-schema', 'dsh-copilot-tool-schema', '0.1.0'),
  candidate('packages/worktrees', '@1yefuwang1/dsh-worktrees', '0.1.0'),
  candidate('packages/azure-sync', '@1yefuwang1/dsh-azure-sync', '0.1.0'),
];

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
  assert.doesNotThrow(() => assertWorkspaceDefinition(`packages:\r\n  - ${workspacePaths[0]}\n  - ${workspacePaths[1]}\r  - ${workspacePaths[2]}\n  - ${workspacePaths[3]}\r\n  - ${workspacePaths[4]}`));
});

test('workspace validation rejects every missing, substring-only or commented package row', () => {
  for (const missing of workspacePaths) {
    const otherRows = workspacePaths.filter(path => path !== missing).map(path => `  - ${path}`);
    for (const row of ['', `  - ${missing}-extra`, `#  - ${missing}`]) {
      assert.throws(() => assertWorkspaceDefinition(['packages:', ...otherRows, row].join('\n')), /Missing pnpm workspace/u);
    }
  }
});

test('the private root is not a publication target and all five leaves resolve portably', async () => {
  assert.deepEqual(workspacePaths, ['packages/catalog', 'packages/search', 'packages/tool-schema', 'packages/worktrees', 'packages/azure-sync']);
  const leaves = await packages();
  assert.deepEqual(leaves.map(({ manifest }) => manifest.name), ['dsh-copilot-catalog', 'dsh-copilot-search', 'dsh-copilot-tool-schema', '@1yefuwang1/dsh-worktrees', '@1yefuwang1/dsh-azure-sync']);
  for (const path of workspacePaths) {
    const selected = await packages(resolve(root, path));
    assert.equal(selected.length, 1);
    assert.equal(selected[0]!.path, path);
  }
  await assert.rejects(packages(root), /private monorepo root/u);
  await assert.rejects(packages(resolve(root, 'unrelated')), /private monorepo root/u);
});

test('publication content paths cannot escape their selected package', () => {
  const directory = resolve(root, 'packages/catalog');
  assert.equal(containedPath(directory, 'dist/index.js'), resolve(directory, 'dist/index.js'));
  for (const path of ['../../outside', '/outside']) assert.throws(() => containedPath(directory, path), /escaping/u);
});

test('versioned package tags select exactly one package, never the legacy root tag', () => {
  assert.equal(releasePackage('dsh-copilot-catalog-v0.2.0', candidates), candidates[0]);
  assert.equal(releasePackage('dsh-copilot-search-v0.1.0', candidates), candidates[1]);
  assert.equal(releasePackage('dsh-copilot-tool-schema-v0.1.0', candidates), candidates[2]);
  assert.equal(releasePackage('@1yefuwang1/dsh-worktrees-v0.1.0', candidates), candidates[3]);
  assert.equal(releasePackage('@1yefuwang1/dsh-azure-sync-v0.1.0', candidates), candidates[4]);
  for (const tag of ['v0.2.0', 'dsh-worktrees-v0.1.0', '1yefuwang1-dsh-worktrees-v0.1.0', 'dsh-copilot-search-v0.2.0', 'dsh-copilot-search-v0.1.0\n', '@1yefuwang1/dsh-worktrees-v0.2.0', '@1yefuwang1/dsh-worktrees-v0.1.0\n', 'dsh-copilot-worktrees-v0.1.0', undefined]) {
    assert.throws(() => releasePackage(tag, candidates), /Release tag/u);
  }
  assert.throws(() => releasePackage('dsh-copilot-search-v0.1.0', [candidates[1]!, candidates[1]!]), /ambiguously/u);
});

test('release metadata must match its actual GitHub repository and package directory', () => {
  assert.deepEqual(releaseIdentity('dsh-copilot-search-v0.1.0', repository, candidates), {
    package: 'dsh-copilot-search', version: '0.1.0', directory: 'packages/search',
  });
  assert.deepEqual(releaseIdentity('dsh-copilot-tool-schema-v0.1.0', repository, candidates), {
    package: 'dsh-copilot-tool-schema', version: '0.1.0', directory: 'packages/tool-schema',
  });
  assert.deepEqual(releaseIdentity('@1yefuwang1/dsh-worktrees-v0.1.0', repository, candidates), {
    package: '@1yefuwang1/dsh-worktrees', version: '0.1.0', directory: 'packages/worktrees',
  });
  assert.deepEqual(releaseIdentity('@1yefuwang1/dsh-azure-sync-v0.1.0', repository, candidates), {
    package: '@1yefuwang1/dsh-azure-sync', version: '0.1.0', directory: 'packages/azure-sync',
  });
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', 'someone/else', candidates), /repository/u);
  assert.throws(() => releaseIdentity('@1yefuwang1/dsh-worktrees-v0.1.0', 'someone/else', candidates), /repository/u);
  const unknown = structuredClone(candidates[3]!);
  unknown.manifest.name = '@1yefuwang1/dsh-worktrees-extra';
  assert.throws(() => releaseIdentity('@1yefuwang1/dsh-worktrees-extra-v0.1.0', repository, [unknown]), /Invalid release package identity/u);
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', `${repository}\n`, candidates), /repository/u);
  const incorrect = structuredClone(candidates);
  incorrect[1]!.manifest.repository.directory = 'packages/catalog';
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', repository, incorrect), /repository/u);
});

test('release workflow stages one pnpm package with provenance and no stored token', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /run: pnpm exec tsx scripts\/release\.ts/u);
  assert.match(workflow, /working-directory: \$\{\{ steps\.release\.outputs\.directory \}\}/u);
  assert.match(workflow, /run: pnpm stage publish --provenance --access public/u);
  assert.match(workflow, /id-token: write/u);
  assert.doesNotMatch(workflow, /run: npm |secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
});

test('publication allowlists and bounds cover every leaf and its exact extras', () => {
  const common = ['CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json'];
  const modules = {
    'dsh-copilot-catalog': ['index', 'catalog', 'discovery', 'identity', 'plugin', 'runtime', 'types'],
    'dsh-copilot-search': ['index', 'auth', 'endpoint', 'errors', 'plugin', 'provider', 'refresh', 'responses', 'runtime', 'types'],
    'dsh-copilot-tool-schema': ['index', 'plugin', 'schema', 'types'],
    '@1yefuwang1/dsh-worktrees': ['index', 'types', 'errors', 'runtime', 'schema', 'store', 'sessions', 'context', 'service', 'git', 'naming', 'rpc', 'projects', 'project-store', 'project-rpc', 'project-context', 'quiet-rpc', 'first-message', 'cleanup-store', 'cleanup', 'recovery-rpc'],
    '@1yefuwang1/dsh-azure-sync': [
      'index', 'config', 'auth', 'runtime', 'schema', 'protocol', 'controller', 'commands', 'rpc', 'settings', 'azure/errors', 'azure/blob', 'azure/table', 'azure/lease',
      'sync/canonical', 'sync/chain', 'sync/committed-index', 'sync/effective-cwd', 'sync/import-state', 'sync/guards',
      'sync/admission', 'sync/batcher', 'sync/blob-metadata', 'sync/cloud-repository', 'sync/drain-coordinator',
      'sync/lease-drain', 'sync/lease-manager', 'sync/lifecycle', 'sync/scheduler', 'sync/service', 'sync/session-source',
      'sync/uploader', 'sync/remote-session', 'sync/attachments', 'sync/projection-warmer', 'sync/importer', 'sync/import-service', 'sync/recovery', 'sync/live-guard', 'sync/conflict', 'sync/reconciler', 'sync/tombstone', 'sync/tombstone-manager', 'sync/poller', 'sync/cleanup', 'sync/workspace', 'local/store', 'git/probe', 'git/sanitize', 'git/guidance',
    ],
  };
  for (const [name, names] of Object.entries(modules)) {
    const policy = publicationPolicy(name);
    const extras = name === '@1yefuwang1/dsh-worktrees' ? ['dist/client.js', 'locale/en.json', 'icon.svg']
      : name === '@1yefuwang1/dsh-azure-sync' ? ['dist/client.js', 'locale/en.json', 'icon.svg'] : [];
    const maxBytes = name === '@1yefuwang1/dsh-worktrees' ? 825_000 : name === '@1yefuwang1/dsh-azure-sync' ? 720_000 : 150_000;
    assert.deepEqual(policy.files, [...common, ...names.flatMap(module => [`dist/${module}.js`, `dist/${module}.d.ts`]), ...extras].sort());
    assert.equal(policy.maxBytes, maxBytes);
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
  assert.equal(files.length, 50);
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

test('azure-sync browser tarball identity and exact asset are enforced without widening other leaves', async () => {
  const [selected] = await packages(resolve(root, 'packages/azure-sync'));
  assert.ok(selected);
  const { manifest } = selected;
  const files = publicationPolicy(manifest.name).files;
  const packed = { name: manifest.name, version: manifest.version, files: files.map(path => ({ path })) };
  assert.equal(manifest.exports['./client'], './dist/client.js');
  assert.deepEqual(validatePublicationMetadata(manifest, packed), files);
  for (const missing of ['dist/client.js', 'locale/en.json']) assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: packed.files.filter(file => file.path !== missing) }), /Unexpected published files/u);
  for (const extra of ['client.ts', 'dist/client.js.map', 'dist/client-model.js']) assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: [...packed.files, { path: extra }] }), /Unexpected published files/u);
  const source = await readFile(resolve(root, 'packages/azure-sync/client.ts'), 'utf8');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\s*id: '@1yefuwang1\/dsh-azure-sync'/u);
  assert.match(source, /name: 'plugins\.row\.config', key: '@1yefuwang1\/dsh-azure-sync#azure-sync'/u);
  assert.equal(publicationPolicy('@1yefuwang1/dsh-azure-sync').maxBytes, 720_000);
  assert.equal(publicationPolicy('@1yefuwang1/dsh-worktrees').maxBytes, 825_000);
});

test('azure-sync keeps implicit lifecycle hooks unset', async () => {
  const [selected] = await packages(resolve(root, 'packages/azure-sync'));
  assert.ok(selected);
  for (const name of ['prepare', 'prepublishOnly', 'preinstall', 'install', 'postinstall']) {
    assert.equal(selected.manifest.scripts[name], undefined, `azure-sync must not define ${name}`);
  }
});

test('every plugin accepts the pinned runtime and rejects other DSH versions without exemptions', async () => {
  const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const pinned = rootManifest.devDependencies['@deepseek-ai/dsh-agent'];
  assert.match(pinned, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  for (const { manifest } of await packages()) {
    assert.equal(manifest.engines?.dsh, pinned, manifest.name + ' must pin the shared runtime');
    assert.equal(evaluatePluginCompatibility(manifest, {}, pinned), undefined,
      manifest.name + ' must install on the pinned runtime without an exemption');
    for (const other of ['0.2.0-rc.2', '0.2.1-rc.3', '0.2.1', '0.1.9']) {
      const issue = evaluatePluginCompatibility(manifest, {}, other);
      assert.ok(issue, manifest.name + ' must report ' + other + ' as unmet');
      assert.deepEqual(Object.keys(issue.requirements), ['engines.dsh']);
      // An exact-version exemption is the only bypass and must name this exact pair.
      assert.equal(issue.exempted, false);
      const key = manifest.name + '@' + manifest.version;
      const irrelevant = evaluatePluginCompatibility(manifest, { [key]: ['9.9.9'] }, other);
      assert.ok(irrelevant, 'a mismatch is still reported');
      assert.equal(irrelevant.exempted, false, 'an exemption for another runtime must not apply');
      const exact = evaluatePluginCompatibility(manifest, { [key]: [other] }, other);
      assert.ok(exact, 'the exact pair is still reported');
      assert.equal(exact.exempted, true, 'only the exact plugin/runtime pair is exempted');
    }
  }
});

test('credential audit catches Copilot tokens, JWTs and static backtick credentials without echoing values', () => {
  const copilot = ['tid=', 'A'.repeat(24), ';exp=', '1791000000', ';proxy-ep=', 'proxy.enterprise.githubcopilot.com'].join('');
  const jwt = ['eyJ' + 'A'.repeat(24), 'B'.repeat(24), 'C'.repeat(24)].join('.');
  const backtick = ['const', 'access', '=', String.fromCharCode(96) + 'not-a-reviewed-credential' + String.fromCharCode(96), ';'].join(' ');
  for (const source of [copilot, jwt, backtick]) {
    const issues = findCredentialIssues('packages/search/src/example.ts', source);
    assert.ok(issues.length > 0);
    assert.ok(!JSON.stringify(issues).includes(source));
  }
  assert.deepEqual(findCredentialIssues('packages/search/src/example.ts', 'const authorization = `Bearer ${resolved}`;'), []);
});

test('synthetic-secret exemptions remain confined to each package test tree', () => {
  const fixture = ['const', 'access', '=', "'test-access-token';"].join(' ');
  for (const name of ['catalog', 'search']) {
    assert.deepEqual(findCredentialIssues(`packages/${name}/test/example.test.ts`, fixture), []);
    assert.ok(findCredentialIssues(`packages/${name}/src/example.ts`, fixture).length > 0);
  }
  assert.ok(findCredentialIssues('packages/unrelated/test/example.test.js', fixture).length > 0);
  assert.ok(findCredentialIssues('packages/search/dist/index.js', '').length > 0);
  assert.ok(findCredentialIssues('.pnpm-store/example.json', '').length > 0);
  assert.ok(findCredentialIssues('packages/search/.pnpm-store/example.json', '').length > 0);
});
