import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import {
  canonicalizeEvent, canonicalizeLocalEvents, isInside, localToRemote, localizeEvent, localizeImportedEvents, mappingRevision, nodeCwdFs, verifyImportedProvenance,
  normalizeMapping, normalizeRemotePath, remoteToLocal, selectMapping, validateImportedCwds,
} from '../src/sync/effective-cwd.js';
import { AzureSyncError } from '../src/azure/errors.js';
import { pathMapping } from './helpers.js';

const hasCode = (code: string) => (error: unknown) => error instanceof AzureSyncError && error.code === code;

test('containment rejects absolute cross-drive/UNC relatives as well as dot-dot', () => {
  assert.equal(isInside('C:\\mapped', 'C:\\mapped\\sub', win32), true);
  assert.equal(isInside('C:\\mapped', 'D:\\outside', win32), false);
  assert.equal(isInside('C:\\mapped', 'C:\\mapped\\..\\outside', win32), false);
  assert.equal(isInside('/mapped', '/mapped/sub'), true);
  assert.equal(isInside('/mapped', '/outside'), false);
});

test('remote spellings normalize without local filesystem calls', () => {
  assert.equal(normalizeRemotePath('/a//b/', 'linux'), '/a/b');
  assert.equal(normalizeRemotePath('/', 'linux'), '/');
  assert.equal(normalizeRemotePath('C:\\\\Work\\\\App\\\\', 'win32'), 'C:/Work/App');
  assert.equal(normalizeRemotePath('C:\\\\', 'win32'), 'C:/');
  assert.equal(normalizeRemotePath('\\\\\\\\server\\\\share\\\\foo', 'win32'), '//server/share/foo');
  assert.throws(() => normalizeRemotePath('relative/path', 'linux'), hasCode('UNMAPPABLE_CWD'));
  assert.throws(() => normalizeRemotePath('/a/../b', 'linux'), hasCode('UNMAPPABLE_CWD'));
  assert.throws(() => normalizeRemotePath('/a', 'win32'), hasCode('UNMAPPABLE_CWD'));
  assert.throws(() => normalizeRemotePath('C:relative', 'win32'), hasCode('UNMAPPABLE_CWD'));
});

test('remote-to-local is string-first and local-to-remote round-trips', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  await mkdir(join(local, 'sub'), { recursive: true });
  const real = await realpath(local);
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const binding = { mapping, fs: nodeCwdFs };

  assert.equal(await remoteToLocal(binding, '/remote/project/sub'), join(real, 'sub'));
  assert.equal(await localToRemote(binding, join(real, 'sub')), '/remote/project/sub');
  await assert.rejects(remoteToLocal(binding, '/remote/project/missing'), hasCode('NEEDS_FOLDER'));
  await assert.rejects(localToRemote(binding, 'relative/sub'), hasCode('UNMAPPABLE_CWD'));
  await assert.rejects(remoteToLocal(binding, '/other/project'), hasCode('UNMAPPABLE_CWD'));
  await assert.rejects(remoteToLocal(binding, '/remote/project2'), hasCode('UNMAPPABLE_CWD'));

  const windows = pathMapping({ remotePrefix: 'C:\\\\work\\\\app', localPrefix: real, remotePlatform: 'win32' });
  const winBinding = { mapping: windows, fs: nodeCwdFs };
  assert.equal(await remoteToLocal(winBinding, 'C:\\\\work\\\\app\\\\sub'), join(real, 'sub'));
  assert.equal(await remoteToLocal(winBinding, 'C:\\\\Work\\\\App\\\\sub'), join(real, 'sub'));
  assert.equal(await localToRemote(winBinding, join(real, 'sub')), 'C:/work/app/sub');
  await assert.rejects(remoteToLocal(winBinding, 'D:\\work\\app\\sub'), hasCode('UNMAPPABLE_CWD'));
  const unc = pathMapping({ remotePrefix: '\\\\server\\share', localPrefix: real, remotePlatform: 'win32' });
  const uncBinding = { mapping: unc, fs: nodeCwdFs };
  assert.equal(await remoteToLocal(uncBinding, '\\\\server\\share\\sub'), join(real, 'sub'));
  await assert.rejects(remoteToLocal(uncBinding, '\\\\server\\other\\sub'), hasCode('UNMAPPABLE_CWD'));
});

test('case differences inside the local root are accepted; symlink escapes are rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  const outside = join(root, 'outside');
  await mkdir(join(local, 'App'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(local, 'escape'));
  const real = await realpath(local);
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const binding = { mapping, fs: nodeCwdFs };
  assert.equal(await remoteToLocal(binding, '/remote/project/App'), join(real, 'App'));
  const differentCase = join(real, 'app');
  const caseExists = await stat(differentCase).then(() => true).catch(() => false);
  if (caseExists) {
    const mapped = await remoteToLocal(binding, '/remote/project/app');
    assert.equal(mapped.toLowerCase(), differentCase.toLowerCase());
  }
  await assert.rejects(remoteToLocal(binding, '/remote/project/escape'), hasCode('UNMAPPABLE_CWD'));
});

test('mapping selection is longest-prefix, ambiguity-safe, and never falls back to a local decoy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-select-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  const other = join(root, 'other');
  await mkdir(local);
  await mkdir(other);
  const real = await realpath(local);
  const first = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const deeper = pathMapping({ remotePrefix: '/remote/project/sub', localPrefix: real, remotePlatform: 'linux' });
  const otherReal = await realpath(other);
  assert.equal(selectMapping([first, deeper], '/remote/project/sub/x', 'linux')?.id, deeper.id);
  assert.equal(selectMapping([first], '/decoy/path', 'linux'), undefined);
  assert.throws(() => selectMapping([first, { ...first, id: randomUUID(), localPrefix: otherReal }], '/remote/project', 'linux'), hasCode('AMBIGUOUS_MAPPING'));
  const winOne = pathMapping({ remotePrefix: 'C:\\\\Work', localPrefix: real, remotePlatform: 'win32' });
  const winTwo = pathMapping({ remotePrefix: 'C:\\\\work', localPrefix: otherReal, remotePlatform: 'win32' });
  assert.throws(() => selectMapping([winOne, winTwo], 'C:\\\\work\\\\x', 'win32'), hasCode('AMBIGUOUS_MAPPING'));
});

test('historical cwd validation reports missing/unmappable paths; event transforms use the binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  await mkdir(join(local, 'sub'), { recursive: true });
  const real = await realpath(local);
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const binding = { mapping, fs: nodeCwdFs };
  const valid = await validateImportedCwds(binding, ['/remote/project/sub']);
  assert.equal(valid.ok, true);
  const invalid = await validateImportedCwds(binding, ['/remote/project/missing', '/other/project']);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.issues.map((item) => item.code), ['NEEDS_FOLDER', 'UNMAPPABLE_CWD']);

  const localized = await localizeEvent({ type: 'working-directory/change', data: { cwd: '/remote/project/sub' } }, binding);
  assert.deepEqual(localized.data, { cwd: join(real, 'sub') });
  const canonical = await canonicalizeEvent({ type: 'working-directory/change', data: { cwd: join(real, 'sub') } }, binding);
  assert.deepEqual(canonical.data, { cwd: '/remote/project/sub' });
  const stream = await localizeImportedEvents([
    { type: 'working-directory/change', data: { cwd: '/remote/project' } },
    { type: 'working-directory/change', data: { cwd: '/remote/project/sub' } },
  ], binding);
  assert.equal(stream.currentCwd, join(real, 'sub'));
  assert.deepEqual(stream.localPaths, [real, join(real, 'sub')]);
  const roundTrip = await canonicalizeLocalEvents(stream.events, binding);
  assert.deepEqual(roundTrip.map((item) => item.data?.['cwd']), ['/remote/project', '/remote/project/sub']);

});

test('mapping normalization requires an absolute root and the pinned root rejects symlink retargets', async (t) => {
  await assert.rejects(normalizeMapping(pathMapping({ localPrefix: 'relative/path' }), nodeCwdFs), hasCode('NEEDS_FOLDER'));
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-normalize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  await mkdir(local);
  const real = await realpath(local);
  const normalized = await normalizeMapping(pathMapping({ remotePrefix: 'C:\\\\work\\\\app', localPrefix: local, remotePlatform: 'win32' }), nodeCwdFs);
  assert.equal(normalized.localPrefix, real);
  assert.equal(normalized.remotePrefix, 'C:/work/app');
  assert.equal(normalized.revision, mappingRevision('C:/work/app', real));

  const pinned = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const binding = { mapping: pinned, fs: nodeCwdFs };
  const outside = join(root, 'outside-root');
  await mkdir(join(outside, 'sub'), { recursive: true });
  await rm(real, { recursive: true, force: true });
  await symlink(outside, real);
  await assert.rejects(remoteToLocal(binding, '/remote/project/sub'), hasCode('UNMAPPABLE_CWD'));
});

test('provenance comparison rejects interior tampering, count/seq drift, and header-range mismatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local');
  await mkdir(join(local, 'sub'), { recursive: true });
  await mkdir(join(local, 'App'), { recursive: true });
  const real = await realpath(local);
  const mapping = pathMapping({ remotePrefix: '/remote/project', localPrefix: real, remotePlatform: 'linux' });
  const binding = { mapping, fs: nodeCwdFs };
  const canonical = [
    { type: 'working-directory/change', seq: 0, data: { cwd: '/remote/project/./sub/' } },
    { type: 'user/message', seq: 1, data: { text: 'hello' } },
  ];
  const localized = await localizeImportedEvents(canonical, binding);
  const checked = await verifyImportedProvenance(binding, canonical, localized.events);
  assert.equal(checked.eventCount, 2);
  assert.equal(checked.currentLocalCwd, join(real, 'sub'));

  const tampered = localized.events.map((event, index) => index === 1 ? { ...event, data: { text: 'tampered' } } : event);
  await assert.rejects(verifyImportedProvenance(binding, canonical, tampered), hasCode('PROVENANCE_MISMATCH'));
  const seqChanged = localized.events.map((event, index) => index === 1 ? { ...event, seq: 99 } : event);
  await assert.rejects(verifyImportedProvenance(binding, canonical, seqChanged), hasCode('PROVENANCE_MISMATCH'));
  await assert.rejects(verifyImportedProvenance(binding, canonical, localized.events.slice(0, 1)), hasCode('PROVENANCE_MISMATCH'));

  const headerOnly = await verifyImportedProvenance(binding, [], [], { headerCwd: '/remote/project', localCurrentCwd: real });
  assert.equal(headerOnly.currentLocalCwd, real);
  await assert.rejects(verifyImportedProvenance(binding, [], [], { headerCwd: '/remote/project', localCurrentCwd: join(real, 'sub') }), hasCode('PROVENANCE_MISMATCH'));

  const caseAlias = await stat(join(real, 'app')).then(() => true).catch(() => false);
  if (caseAlias) {
    const caseCanonical = [{ type: 'working-directory/change', seq: 0, data: { cwd: '/remote/project/app' } }];
    const caseLocalized = await localizeImportedEvents(caseCanonical, binding);
    assert.equal((await verifyImportedProvenance(binding, caseCanonical, caseLocalized.events)).eventCount, 1);
  }
});
