import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAttacher } from '../src/sync/workspace.js';

test('workspace attachment reuses a realpath match and only creates when missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-azure-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'folder');
  await mkdir(path);
  const real = await realpath(path);
  const created: string[] = [];
  const attached: [string, string][] = [];
  const registry = {
    list: () => [{ id: 'existing', path: real }],
    create: async (value: string) => { created.push(value); return { id: 'new', path: value }; },
    attachSession: (workspaceId: string, sessionId: string) => { attached.push([workspaceId, sessionId]); },
  };
  const attacher = new WorkspaceAttacher(registry);
  assert.deepEqual(await attacher.attach(real, undefined, 'session-1'), { attached: true, workspaceId: 'existing' });
  assert.deepEqual(created, []);
  assert.deepEqual(attached, [['existing', 'session-1']]);
  assert.equal((await new WorkspaceAttacher(undefined).attach(real)).attached, false);
});
