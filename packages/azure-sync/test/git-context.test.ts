import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeGitContextJson, encodeGitContext, gitLocationHints, gitSelectionKey, isGitBranchRef,
  parseGitContext, GIT_CONTEXT_MAX_BYTES, type GitContext, type GitSelectionFacts,
} from '../src/git/context.js';
import { decodeGitJson, type GitFacts } from '../src/git/sanitize.js';
import { decodeCloudReply } from '../client-model.js';

const sha = 'a'.repeat(40), next = 'b'.repeat(40), hash = 'c'.repeat(64);
const remote = { name: 'origin', sanitizedUrl: 'https://example.invalid/team/project.git' };
function context(): GitContext {
  return {
    v: 2, observation: { deviceId: 'fixture-device', observedAt: 20, generation: 1, headerHash: hash, eventCount: 5, chainHash: hash },
    repository: { objectFormat: 'sha1', root: '/source/project', worktree: true, configuredRemote: remote },
    creationBase: { kind: 'local', ref: 'refs/heads/release', oid: sha, upstreamAtCreation: { ref: 'refs/heads/dev', remote } },
    current: { branchRef: 'refs/heads/worktree/task-x', headOid: next, detached: false, unborn: false, dirty: 'clean', upstream: { kind: 'remote', ref: 'refs/heads/feature/x', remote } },
  };
}
const selection = (patch: Partial<GitSelectionFacts> = {}): GitSelectionFacts => ({ schemaVersion: 2, repositoryIdentity: 'selected-local-repository-and-remote', objectFormat: 'sha1', headOid: next, selectedOid: next, ...patch });

test('Git v2 codec preserves distinct local base, captured remote upstream and current snapshot', () => {
  const input = context(), parsed = parseGitContext(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed?.creationBase));
  assert.equal(parsed?.current.upstream?.kind, 'remote');
  assert.ok(parsed?.current.upstream?.kind === 'remote' && Object.isFrozen(parsed.current.upstream.remote));
  assert.deepEqual(decodeGitContextJson(encodeGitContext(input)), parsed);
  assert.deepEqual(gitLocationHints(input), [
    { purpose: 'current', oid: next, ref: 'refs/heads/feature/x', remote },
    { purpose: 'creation', oid: sha, ref: 'refs/heads/dev', remote },
  ]);
  assert.equal(parsed?.creationBase?.kind, 'local'); assert.equal(parsed?.current.headOid, next);
});

test('remote creation base and current local-only upstream never imply publication of current HEAD', () => {
  const input = context();
  const changed: GitContext = { ...input, creationBase: { kind: 'remote', ref: 'refs/heads/dev', remote, oid: sha }, current: { ...input.current, upstream: { kind: 'local', ref: 'refs/heads/local-only' } } };
  assert.deepEqual(gitLocationHints(changed), [{ purpose: 'creation', oid: sha, ref: 'refs/heads/dev', remote }]);
  const detached: GitContext = { ...input, creationBase: { kind: 'detached', oid: sha }, current: { detached: true, unborn: false, dirty: 'unknown', headOid: next } };
  assert.ok(parseGitContext(detached)); assert.deepEqual(gitLocationHints(detached), []);
  const unknownBase: GitContext = { v: 2, observation: input.observation, repository: input.repository, current: detached.current };
  assert.ok(parseGitContext(unknownBase)); assert.deepEqual(gitLocationHints(unknownBase), []);
});

test('full branch refs admit nested names but reject internal pins, traversal and Git option/ref syntax', () => {
  for (const ref of ['refs/heads/dev', 'refs/heads/feature/a/b', 'refs/heads/topic-name', 'refs/heads/主题']) assert.equal(isGitBranchRef(ref), true, ref);
  for (const ref of ['origin/main', 'refs/remotes/origin/main', 'refs/dsh-worktrees/id/base', 'refs/heads/', 'refs/heads/-option', 'refs/heads/../dev', 'refs/heads/.hidden', 'refs/heads/name.lock', 'refs/heads/x.', 'refs/heads/a//b', 'refs/heads/a b', 'refs/heads/a\\b', 'refs/heads/a@{b', 'refs/heads/a~1', 'refs/heads/a^', 'refs/heads/a?b', 'refs/heads/a*b', 'refs/heads/a[b', 'refs/heads/a\nb']) assert.equal(isGitBranchRef(ref), false, ref);
});

test('Git context rejects extra nested keys, forged source-kind fields and unsanitized remote identities', () => {
  const input = context();
  for (const patch of [
    { ...input, rawConfig: 'not allowed' },
    { ...input, observation: { ...input.observation, receipt: true } },
    { ...input, repository: { ...input.repository, remoteIdentity: 'opaque-local-proof' } },
    { ...input, creationBase: { ...input.creationBase, baseRef: 'refs/dsh-worktrees/id/base' } },
    { ...input, creationBase: { kind: 'local', ref: 'refs/heads/main', oid: sha, remote } },
    { ...input, creationBase: { kind: 'detached', ref: 'refs/heads/main', oid: sha } },
    { ...input, current: { ...input.current, upstream: { kind: 'local', ref: 'refs/heads/main', remote } } },
    { ...input, current: { ...input.current, upstream: { kind: 'remote', ref: 'refs/heads/main', remote: { name: '.', sanitizedUrl: remote.sanitizedUrl } } } },
    { ...input, repository: { ...input.repository, configuredRemote: { ...remote, sanitizedUrl: 'https://example.invalid/team/project.git?private=1' } } },
    { ...input, repository: { ...input.repository, configuredRemote: { ...remote, sanitizedUrl: 'ext::unsafe' } } },
  ]) assert.equal(parseGitContext(patch), undefined);
});

test('schema distinguishes unborn, detached, named HEAD and exact SHA-1/SHA-256 objects', () => {
  const input = context();
  for (const current of [
    { ...input.current, detached: true }, { ...input.current, unborn: true },
    { detached: false, unborn: false, dirty: 'clean' },
    { detached: true, unborn: true, dirty: 'clean' },
    { ...input.current, headOid: hash }, { ...input.current, branchRef: 'refs/remotes/origin/main' },
  ]) assert.equal(parseGitContext({ ...input, current }), undefined);
  const unborn: GitContext = { v: 2, observation: input.observation, repository: input.repository, current: { branchRef: 'refs/heads/new', detached: false, unborn: true, dirty: 'unknown' } };
  assert.ok(parseGitContext(unborn));
  assert.ok(parseGitContext({ ...unborn, creationBase: input.creationBase }), 'an orphan/unborn current branch does not erase the historical creation base');
  const sha256: GitContext = { ...input, repository: { ...input.repository, objectFormat: 'sha256' }, creationBase: { kind: 'detached', oid: hash }, current: { detached: true, unborn: false, dirty: 'clean', headOid: hash } };
  assert.ok(parseGitContext(sha256));
  assert.equal(parseGitContext({ ...sha256, creationBase: { kind: 'detached', oid: sha } }), undefined);
});

test('untrusted objects cannot execute property getters, coercion or toJSON during context decoding', () => {
  let touched = 0;
  const hostile = Object.defineProperty({}, 'v', { enumerable: true, get() { touched++; return 2; } });
  assert.equal(parseGitContext(hostile), undefined);
  const input = context();
  const nested = Object.defineProperty({ ...remote }, 'sanitizedUrl', { enumerable: true, get() { touched++; return remote.sanitizedUrl; } });
  assert.equal(parseGitContext({ ...input, repository: { ...input.repository, configuredRemote: nested } }), undefined);
  assert.equal(parseGitContext({ ...input, toJSON() { touched++; return input; } }), undefined);
  assert.equal(touched, 0);
});

test('Git context rejects unsafe numbers, malformed bounded JSON and over-limit UTF-8 strings', () => {
  const input = context();
  for (const value of [-1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -0]) {
    assert.equal(parseGitContext({ ...input, observation: { ...input.observation, observedAt: value } }), undefined);
  }
  assert.equal(parseGitContext({ ...input, observation: { ...input.observation, generation: 0 } }), undefined);
  assert.equal(decodeGitContextJson('{broken'), undefined);
  assert.equal(decodeGitContextJson('x'.repeat(GIT_CONTEXT_MAX_BYTES + 1)), undefined);
  assert.equal(parseGitContext({ ...input, repository: { ...input.repository, root: '界'.repeat(4096), configuredRemote: { name: 'origin', sanitizedUrl: 'https://example.invalid/' + 'x'.repeat(4050) } } }), undefined);
  assert.throws(() => encodeGitContext({ ...input, v: 99 } as unknown as GitContext));
});

test('semantic selection identity never contains observation timestamps or history anchors', () => {
  const input = context(), advanced: GitContext = { ...input, observation: { ...input.observation, observedAt: 99, eventCount: 10, chainHash: 'd'.repeat(64) } };
  const semantic = (ctx: GitContext) => gitSelectionKey(selection({ headOid: ctx.current.headOid }));
  assert.equal(semantic(input), semantic(advanced));
  for (const patch of [{ repositoryIdentity: 'another-repository' }, { headOid: sha }, { resolvedRef: 'refs/heads/main' }, { selectedOid: sha }, { schemaVersion: 1 as const }]) assert.notEqual(gitSelectionKey(selection(patch)), semantic(input));
  assert.throws(() => gitSelectionKey({ ...selection(), observedAt: 1 } as GitSelectionFacts));
  assert.throws(() => gitSelectionKey(selection({ resolvedRef: 'origin/main' })));
});

test('old storage decoder and legacy catalog stay strict v1; v2 must use a separate import DTO', () => {
  const input = context(), encoded = encodeGitContext(input);
  assert.equal(decodeGitJson(encoded), undefined);
  const legacy: GitFacts = { v: 1, root: '/old/project', branch: 'worktree/task-x', commit: next, detached: false, unborn: false, worktree: true, dirty: 'clean', remote: remote.sanitizedUrl };
  assert.deepEqual(decodeGitContextJson(JSON.stringify(legacy)), legacy);
  assert.equal(decodeGitContextJson(JSON.stringify({ ...legacy, creationBase: input.creationBase })), undefined);
  assert.equal(decodeGitContextJson(JSON.stringify({ ...input, v: 3 })), undefined);
  const item = { sessionId: 'cloud-thread', generation: 1, state: 'active', enabled: true, eventCount: 5, updatedAt: 20, sourcePlatform: 'linux', rootSessionId: 'cloud-thread', rootGeneration: 1 };
  const envelope = (row: unknown) => ({ ok: true, value: { v: 1, ok: true, data: { kind: 'remote', items: [row] } } });
  assert.equal(decodeCloudReply({ action: 'pull' }, envelope(item)).kind, 'remote');
  assert.equal(decodeCloudReply({ action: 'pull' }, envelope({ ...item, git: legacy })).kind, 'remote');
  assert.throws(() => decodeCloudReply({ action: 'pull' }, envelope({ ...item, git: input })));
  assert.throws(() => decodeCloudReply({ action: 'pull' }, envelope({ ...item, gitContext: input })));
});
