import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { packageManager } from '../../../scripts/workspaces.js';
import { publicationPolicy } from '../../../scripts/check-pack.js';

/** Extracted public tarball smoke with the EXISTING pinned public dependency
 * installation linked in. Not a claim of a clean registry install or live GUI.
 */
test('actual tarball imports root/protocol/browser factory and exposes public consumer declarations without source internals', { timeout: 120_000 }, async t => {
  const pkg = resolve(fileURLToPath(new URL('..', import.meta.url))), workspace = resolve(pkg, '../..');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'azure-pack-smoke-')));
  t.after(async () => { assert.equal(await realpath(root), root); assert.equal(dirname(root), await realpath(tmpdir())); assert.ok(basename(root).startsWith('azure-pack-smoke-')); await rm(root, { recursive: true }); });
  function run(command: string, args: string[], cwd: string, shell = false) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell, timeout: 90_000, env: { ...process.env, npm_config_ignore_scripts: 'true' } });
    assert.equal(result.error, undefined, 'smoke command must terminate normally'); assert.equal(result.status, 0, result.stderr || result.stdout); return result.stdout;
  }
  const invocation = packageManager(['pack', '--pack-destination', root, '--config.ignore-scripts=true', '--json']);
  const packed = JSON.parse(run(invocation.command, invocation.args, pkg, invocation.shell)) as { filename: string };
  const archive = resolve(root, packed.filename); assert.equal(dirname(archive), root); assert.ok(basename(archive).endsWith('.tgz'));
  const paths = run('tar', ['-tzf', archive], root).trim().split('\n');
  assert.ok(paths.every(path => path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\')));
  const actual = paths.filter(path => !path.endsWith('/')).map(path => path.slice('package/'.length)).sort();
  assert.deepEqual(actual, publicationPolicy('@1yefuwang1/dsh-azure-sync').files);
  const extracted = join(root, 'extracted'), consumer = join(root, 'consumer'); await mkdir(extracted); await mkdir(consumer);
  run('tar', ['-xzf', archive, '-C', extracted], root);
  const installed = join(extracted, 'package');
  await symlink(join(pkg, 'node_modules'), join(installed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(consumer, 'node_modules/@1yefuwang1'), { recursive: true });
  await symlink(installed, join(consumer, 'node_modules/@1yefuwang1/dsh-azure-sync'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(consumer, 'node_modules/@types'), { recursive: true });
  await symlink(await realpath(join(workspace, 'node_modules/@types/node')), join(consumer, 'node_modules/@types/node'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await writeFile(join(consumer, 'consumer.ts'), `import { Config, GitProbe, parseGitFacts, type GitFacts, type CloudRequest } from '@1yefuwang1/dsh-azure-sync';
import { parseCloudRequest } from '@1yefuwang1/dsh-azure-sync/protocol';
import { parseCloudImportRequest, type CloudImportRequest } from '@1yefuwang1/dsh-azure-sync/import-protocol';
import { parseGitContext, type GitContext } from '@1yefuwang1/dsh-azure-sync/git-context';
import { ImportGuardV1, type VerifiedDestinationImport } from '@1yefuwang1/dsh-azure-sync/import-guard';
import { GuardedSessionPersistence } from '@1yefuwang1/dsh-azure-sync/import-persistence';
const destination: CloudImportRequest = { action: 'import-admission', sessionId: 'original-thread' };
const captured: GitContext | undefined = parseGitContext(null);
const opaque: VerifiedDestinationImport | undefined = undefined;
void [parseCloudImportRequest(destination), captured, opaque, ImportGuardV1, GuardedSessionPersistence];
const request: CloudRequest = { action: 'git-info', sessionId: 'thread' };
const config = Config({}); const probe: Promise<GitFacts | null> = new GitProbe().inspect('/local', '/local');
void [config, probe, parseGitFacts(null), parseCloudRequest(request)];
// @ts-expect-error Removal requires confirmation and attachment-retention acknowledgement.
const unsafe: CloudRequest = { action: 'remove', sessionId: 'thread' };
void unsafe;
// @ts-expect-error New destination confirmation cannot be omitted.
const unconfirmed: CloudImportRequest = { action: 'commit-import', sessionId: 'thread', operationId: 'id', revision: 1 };
void unconfirmed;
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: ['node'] }, files: ['consumer.ts'] }));
  const ts = packageManager(['--config.ignore-scripts=true', 'exec', 'tsc', '-p', join(consumer, 'tsconfig.json')]); run(ts.command, ts.args, workspace, ts.shell);
  const script = `import assert from 'node:assert/strict';
let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('import must not fetch'); };
const root = await import('@1yefuwang1/dsh-azure-sync'); const protocol = await import('@1yefuwang1/dsh-azure-sync/protocol');
assert.equal(typeof root.apply, 'function'); assert.equal(typeof root.GitProbe, 'function'); assert.equal(typeof protocol.parseCloudRequest, 'function');
const imports = await import('@1yefuwang1/dsh-azure-sync/import-protocol');
const git = await import('@1yefuwang1/dsh-azure-sync/git-context');
const guard = await import('@1yefuwang1/dsh-azure-sync/import-guard');
const persistence = await import('@1yefuwang1/dsh-azure-sync/import-persistence');
assert.equal(imports.CLOUD_IMPORT_PROTOCOL_VERSION, 2); assert.deepEqual(imports.parseCloudImportRequest({action:'import-admission',sessionId:'thread'}), {action:'import-admission',sessionId:'thread'});
assert.equal(git.parseGitContext({v:99}), undefined); assert.equal(typeof guard.ImportGuardV1.open, 'function'); assert.equal(typeof persistence.GuardedSessionPersistence, 'function');
assert.equal(calls, 0); let loaded;
globalThis.window = { __ModuleLoader__: { load(value) { loaded = value; } } };
await import('@1yefuwang1/dsh-azure-sync/client'); assert.equal(loaded.id, '@1yefuwang1/dsh-azure-sync'); assert.equal(typeof loaded.factory, 'function');
assert.equal(calls, 0); console.log('Extracted tarball import-only and public type consumer passed.');`;
  run(process.execPath, ['--input-type=module', '-e', script], consumer);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  for (const hook of ['prepare', 'prepublishOnly', 'install', 'postinstall']) assert.equal(manifest.scripts[hook], undefined);
});
