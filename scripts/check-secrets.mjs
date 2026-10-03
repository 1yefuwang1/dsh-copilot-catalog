import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['API secret key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['credential-bearing URL', /https?:\/\/[^\s/"'<>@]+:[^\s/"'<>@]+@/g],
];
const syntheticLiterals = new Set([
  'test-access-token', 'test-refresh-token', 'must-not-win', 'refreshed-in-memory',
  'fresh-token', 'synthetic-token', 'synthetic',
]);
const literalSecret = /(?<![\w@./-])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|authorization|access|refresh|token)["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;

/** Return only locations/rule names; never echo a suspected secret. */
export function findCredentialIssues(path, source) {
  const issues = [];
  const report = (offset, rule) => issues.push({ path, line: source.slice(0, offset).split('\n').length, rule });
  const name = basename(path);
  if (/^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.credentials.*|(?:credentials|auth)\.(?:json|ya?ml)|id_(?:rsa|ed25519).*)$/.test(name) && name !== '.env.example' || /\.(?:pem|key)$/i.test(name)) {
    report(0, 'credential/private-key filename');
  }
  if (/(?:^|\/)(?:node_modules|dist|\.review|artifacts)(?:\/|$)/.test(path) || /\.tgz$/i.test(path)) {
    report(0, 'generated/private artifact must not be committed');
  }
  for (const [label, regex] of rules) {
    for (const match of source.matchAll(regex)) {
      // This exact intentionally invalid endpoint is a rejection fixture, not a credential.
      if (label === 'credential-bearing URL' && path === 'test/discovery.test.mjs' &&
          match[0] === ['https://', 'user:secret@'].join('')) continue;
      report(match.index, label);
    }
  }
  for (const match of source.matchAll(literalSecret)) {
    const value = match[1];
    if (value.includes('${') || /^[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(value)) continue;
    if (path.startsWith('test/') && syntheticLiterals.has(value)) continue;
    report(match.index, 'hard-coded credential-like literal');
  }
  return issues;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git audit command failed (${result.status})`);
  return result.stdout;
}

async function main() {
  const staged = process.argv.includes('--staged');
  const paths = git(staged ? ['ls-files', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean);
  const issues = [];
  for (const path of new Set(paths)) {
    const source = staged ? git(['show', `:${path}`]) : await readFile(join(root, path), 'utf8');
    issues.push(...findCredentialIssues(path, source));
  }
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.path}:${issue.line}: ${issue.rule}`);
    throw new Error(`Credential audit refused ${issues.length} finding(s); suspected values were not printed`);
  }
  console.log(`Credential audit passed: ${paths.length} ${staged ? 'staged' : 'Git-candidate'} files; no credentials found (only reviewed synthetic test literals allowed).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
