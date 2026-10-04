import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { root, workspacePaths, packages, containedPath, releasePackage } from '../workspaces.mjs';
import { releaseIdentity } from '../release.mjs';
import { findCredentialIssues } from '../check-secrets.mjs';

const repository = '1yefuwang1/dsh-copilot-catalog';
const candidates = ['catalog', 'search'].map((name) => ({ path: `packages/${name}`, manifest: {
  name: `dsh-copilot-${name}`, version: name === 'catalog' ? '0.2.0' : '0.1.0',
  repository: { url: `git+https://github.com/${repository}.git`, directory: `packages/${name}` },
} }));

test('the private root is not a publication target and the two leaves resolve portably', async () => {
  assert.deepEqual(workspacePaths, ['packages/catalog', 'packages/search']);
  const leaves = await packages();
  assert.deepEqual(leaves.map(({ manifest }) => manifest.name), ['dsh-copilot-catalog', 'dsh-copilot-search']);
  assert.equal((await packages(resolve(root, 'packages/search'))).length, 1);
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
  for (const tag of ['v0.2.0', 'dsh-copilot-search-v0.2.0', 'dsh-copilot-search-v0.1.0\n', undefined]) {
    assert.throws(() => releasePackage(tag, candidates), /Release tag/u);
  }
  assert.throws(() => releasePackage('dsh-copilot-search-v0.1.0', [candidates[1], candidates[1]]), /ambiguously/u);
});

test('release metadata must match its actual GitHub repository and package directory', () => {
  assert.deepEqual(releaseIdentity('dsh-copilot-search-v0.1.0', repository, candidates), {
    package: 'dsh-copilot-search', version: '0.1.0', directory: 'packages/search',
  });
  assert.throws(() => releaseIdentity('dsh-copilot-search-v0.1.0', 'someone/else', candidates), /repository/u);
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
