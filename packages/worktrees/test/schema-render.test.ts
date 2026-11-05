import assert from 'node:assert/strict';
import test from 'node:test';
import { assertObjectJsonSchema, assertSupportedJsonSchema, projectToolSchema } from '@deepseek-ai/dsh-tools';
import { parameterSchema as worktreeParameters } from '../dist/schema.js';
import { projectParameterSchema } from '../dist/projects.js';

const declared: [string, Record<string, unknown>][] = [['git_worktree', worktreeParameters], ['workspace_project', projectParameterSchema]];

test('declared parameter schemas stay inside the registry supported subset', () => {
  for (const [name, schema] of declared) {
    assertSupportedJsonSchema(schema);
    // The registry rejects any non-object root before a model step assembles.
    assertObjectJsonSchema(schema);
    assert.equal(schema.type, 'object', name + ' declares an object root');
  }
});

test('the registry schema projection keeps both declared tool surfaces', () => {
  for (const [name, parameters] of declared) {
    const projection = projectToolSchema({ name, description: name, parameters } as never, true);
    assert.equal(projection.name, name);
    assert.deepEqual(projection.parameters, parameters, name + ' keeps its declared parameters');
    assert.notEqual(projection.parameters, parameters, name + ' projects a detached copy');
  }
});
