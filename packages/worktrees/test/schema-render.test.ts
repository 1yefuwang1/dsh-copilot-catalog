import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonSchemaToPy, jsonSchemaToTs, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools';
import { parameterSchema as worktreeParameters } from '../dist/schema.js';
import { projectParameterSchema } from '../dist/projects.js';

const declared: [string, Record<string, unknown>][] = [['git_worktree', worktreeParameters], ['workspace_project', projectParameterSchema]];

test('declared parameter schemas stay inside the registry SDK subset and render typed', () => {
  for (const [name, schema] of declared) {
    const typescript = jsonSchemaToTs(schema);
    assert.notEqual(typescript.trim(), 'unknown', name + ' must render typed declarations');
    assert.match(typescript, /action/u);
    assert.equal(jsonSchemaToPy(schema), 'dict[str, Any]');
  }
});

test('rendered model SDK declares typed arguments for both tools', () => {
  const schemas = declared.map(([name, parameters]) => ({ name, description: name, parameters, output: { type: 'object' as const } }));
  const typescript = renderToolsSdk(schemas);
  const python = renderToolsSdkPy(schemas);
  assert.match(typescript, /git_worktree: \{/u);
  assert.match(typescript, /workspace_project: \{/u);
  assert.doesNotMatch(typescript, /git_worktree: unknown/u);
  assert.doesNotMatch(typescript, /workspace_project: unknown/u);
  assert.match(python, /class GitWorktreeArgs\(TypedDict\):/u);
  assert.match(python, /class WorkspaceProjectArgs\(TypedDict\):/u);
});
