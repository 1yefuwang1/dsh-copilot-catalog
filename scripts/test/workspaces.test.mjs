import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { root, workspacePaths, packages, containedPath, releasePackage, assertWorkspaceDefinition, packageManager } from '../workspaces.mjs';
import { releaseIdentity } from '../release.mjs';
import { findCredentialIssues } from '../check-secrets.mjs';
import { publicationPolicy, validatePublicationMetadata, validatePublicationSize } from '../check-pack.mjs';

const repository = '1yefuwang1/dsh-copilot-catalog';
const candidates = ['catalog', 'search', 'worktrees'].map((name) => ({ path: `packages/${name}`, manifest: {
  name: name === 'worktrees' ? 'dsh-worktrees' : `dsh-copilot-${name}`, version: name === 'catalog' ? '0.2.0' : '0.1.0',
  repository: { url: `git+https://github.com/${repository}.git`, directory: `packages/${name}` },
} }));

test('pnpm launcher distinguishes JavaScript and native executables without splitting arguments', () => {
  const previous = process.env.npm_execpath;
  const args = ['pack', '--pack-destination', 'directory with spaces'];
  const before = [...args];
  try {
    for (const executable of ['/tools/pnpm.cjs', '/tools with spaces/pnpm.mjs', String.raw`C:\tools\pnpm.js`]) {
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
  assert.doesNotThrow(() => assertWorkspaceDefinition('packages:\r\n  - packages/catalog\n  - packages/search\r  - packages/worktrees'));
});

test('workspace validation rejects every missing, substring-only or commented package row', () => {
  for (const missing of workspacePaths) {
    const otherRows = workspacePaths.filter(path => path !== missing).map(path => `  - ${path}`);
    for (const row of ['', `  - ${missing}-extra`, `#  - ${missing}`]) {
      assert.throws(() => assertWorkspaceDefinition(['packages:', ...otherRows, row].join('\n')), /Missing pnpm workspace/u);
    }
  }
});

test('the private root is not a publication target and all three leaves resolve portably', async () => {
  assert.deepEqual(workspacePaths, ['packages/catalog', 'packages/search', 'packages/worktrees']);
  const leaves = await packages();
  assert.deepEqual(leaves.map(({ manifest }) => manifest.name), ['dsh-copilot-catalog', 'dsh-copilot-search', 'dsh-worktrees']);
  for (const path of workspacePaths) {
    const selected = await packages(resolve(root, path));
    assert.equal(selected.length, 1);
    assert.equal(selected[0].path, path);
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
  assert.equal(releasePackage('dsh-worktrees-v0.1.0', candidates), candidates[2]);
  for (const tag of ['v0.2.0', 'dsh-copilot-search-v0.2.0', 'dsh-copilot-search-v0.1.0\n', 'dsh-worktrees-v0.2.0', 'dsh-worktrees-v0.1.0\n', 'dsh-copilot-worktrees-v0.1.0', undefined]) {
    assert.throws(() => releasePackage(tag, candidates), /Release tag/u);
  }
  assert.throws(() => releasePackage('dsh-copilot-search-v0.1.0', [candidates[1], candidates[1]]), /ambiguously/u);
});

test('release metadata must match its actual GitHub repository and package directory', () => {
  assert.deepEqual(releaseIdentity('dsh-copilot-search-v0.1.0', repository, candidates), {
    package: 'dsh-copilot-search', version: '0.1.0', directory: 'packages/search',
  });
  assert.deepEqual(releaseIdentity('dsh-worktrees-v0.1.0', repository, candidates), {
    package: 'dsh-worktrees', version: '0.1.0', directory: 'packages/worktrees',
  });
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', 'someone/else', candidates), /repository/u);
  assert.throws(() => releaseIdentity('dsh-worktrees-v0.1.0', 'someone/else', candidates), /repository/u);
  const unknown = structuredClone(candidates[2]);
  unknown.manifest.name = 'dsh-worktrees-extra';
  assert.throws(() => releaseIdentity('dsh-worktrees-extra-v0.1.0', repository, [unknown]), /Invalid release package identity/u);
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', `${repository}\n`, candidates), /repository/u);
  const incorrect = structuredClone(candidates);
  incorrect[1].manifest.repository.directory = 'packages/catalog';
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', repository, incorrect), /repository/u);
});

test('release workflow stages one pnpm package with provenance and no stored token', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /run: node scripts\/release\.mjs/u);
  assert.match(workflow, /working-directory: \$\{\{ steps\.release\.outputs\.directory \}\}/u);
  assert.match(workflow, /run: pnpm stage publish --provenance --access public/u);
  assert.match(workflow, /id-token: write/u);
  assert.doesNotMatch(workflow, /run: npm |secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN)/u);
});

test('publication allowlists and bounds preserve both old leaves and explicitly add worktree Client assets', () => {
  const common = ['CHANGELOG.md', 'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json'];
  const modules = {
    'dsh-copilot-catalog': ['index', 'catalog', 'discovery', 'plugin', 'runtime', 'types'],
    'dsh-copilot-search': ['index', 'auth', 'endpoint', 'errors', 'plugin', 'provider', 'refresh', 'responses', 'runtime', 'types'],
    'dsh-worktrees': ['index', 'types', 'errors', 'runtime', 'schema', 'store', 'sessions', 'context', 'service', 'git', 'naming', 'rpc', 'projects', 'project-store', 'project-rpc', 'project-context', 'quiet-rpc', 'first-message'],
  };
  for (const [name, names] of Object.entries(modules)) {
    const policy = publicationPolicy(name);
    const extras = name === 'dsh-worktrees' ? ['client.js', 'locale/en.json', 'icon.svg'] : [];
    assert.deepEqual(policy.files, [...common, ...names.flatMap(module => [`dist/${module}.js`, `dist/${module}.d.ts`]), ...extras].sort());
    assert.equal(policy.maxBytes, name === 'dsh-worktrees' ? 450_000 : 150_000);
    assert.doesNotThrow(() => validatePublicationSize(name, policy.maxBytes - 1));
    assert.throws(() => validatePublicationSize(name, policy.maxBytes), /Unexpectedly large/u);
    assert.throws(() => validatePublicationSize(name, -1), /Unexpectedly large/u);
    assert.throws(() => validatePublicationSize(name, NaN), /Unexpectedly large/u);
  }
  for (const name of ['private-root', 'unknown', 'toString']) assert.throws(() => publicationPolicy(name), /explicit publication allowlist/u);
});

test('worktree tarball metadata rejects extra/missing files, wrong identity and absent exported targets', async () => {
  const [{ manifest }] = await packages(resolve(root, 'packages/worktrees'));
  const files = publicationPolicy(manifest.name).files;
  const packed = { name: manifest.name, version: manifest.version, files: files.map(path => ({ path })) };
  assert.deepEqual(validatePublicationMetadata(manifest, packed), files);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: [...packed.files, { path: 'src/service.ts' }] }), /Unexpected published files/u);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, files: packed.files.filter(file => file.path !== 'client.js') }), /Unexpected published files/u);
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, name: 'private-root' }));
  assert.throws(() => validatePublicationMetadata(manifest, { ...packed, version: '9.9.9' }));
  assert.throws(() => validatePublicationMetadata({ ...manifest, exports: { ...manifest.exports, './absent': './dist/absent.js' } }, packed), /Missing exported file/u);
  assert.equal(manifest.scripts.prepare, undefined);
  assert.equal(manifest.scripts.install, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
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
    assert.deepEqual(findCredentialIssues(`packages/${name}/test/example.test.mjs`, fixture), []);
    assert.ok(findCredentialIssues(`packages/${name}/src/example.ts`, fixture).length > 0);
  }
  assert.ok(findCredentialIssues('packages/unrelated/test/example.test.mjs', fixture).length > 0);
  assert.ok(findCredentialIssues('packages/search/dist/index.js', '').length > 0);
  assert.ok(findCredentialIssues('.pnpm-store/example.json', '').length > 0);
  assert.ok(findCredentialIssues('packages/search/.pnpm-store/example.json', '').length > 0);
});
