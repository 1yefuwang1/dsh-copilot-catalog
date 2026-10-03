import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCredentialIssues } from '../scripts/check-secrets.mjs';

test('credential scanner detects common provider tokens without exposing their values', () => {
  for (const prefix of ['ghp_', 'github_pat_', 'sk-', 'npm_', 'xoxb-']) {
    const secret = prefix + 'A'.repeat(40);
    const issues = findCredentialIssues('src/example.ts', `const leaked = '${secret}';`);
    assert.ok(issues.length > 0);
    assert.ok(!JSON.stringify(issues).includes(secret));
  }
});

test('private keys, credential-bearing URLs and credential filenames are refused', () => {
  const marker = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  assert.ok(findCredentialIssues('src/example.ts', marker).length > 0);
  assert.ok(findCredentialIssues('README.md', 'https://' + 'example:password@host.invalid').length > 0);
  for (const path of ['.env', 'credentials.json', '.npmrc', 'private.pem', 'id_ed25519']) {
    assert.ok(findCredentialIssues(path, '').length > 0);
  }
});

test('synthetic credential literals are allowed only in tests', () => {
  const source = "const access = 'test-access-token';";
  assert.equal(findCredentialIssues('test/example.test.mjs', source).length, 0);
  assert.ok(findCredentialIssues('src/example.ts', source).length > 0);
  const unreviewed = ['const', 'apiKey', '=', "'not-a-reviewed-token';"].join(' ');
  assert.ok(findCredentialIssues('test/example.test.mjs', unreviewed).length > 0);
});

test('generated artifacts cannot enter Git even when forced past gitignore', () => {
  for (const path of ['.review/example.json', 'node_modules/example.js', 'dist/index.js', 'artifacts/package.tgz']) {
    assert.ok(findCredentialIssues(path, '').length > 0);
  }
});

test('normal code, environment references and lockfile hashes are not credentials', () => {
  const source = 'const key = process.env.API_KEY; const apiKey = "OPENAI_API_KEY";';
  assert.deepEqual(findCredentialIssues('src/example.ts', source), []);
  assert.deepEqual(findCredentialIssues('package-lock.json', '{"integrity":"sha512-abcdefghijklmnopqrstuvwxyz"}'), []);
});
