import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardCopilotRequestBody, MAX_GUARDED_BODY_BYTES } from '../dist/guard.js';
import type { GuardSettings } from '../dist/guard-types.js';
import * as fixtures from './guard-fixtures.js';

const settings: GuardSettings = { providers: ['github-copilot'], families: ['gemini'], logFixes: false };

test('a defective chat-completions declaration gains one empty properties bucket', () => {
  const result = guardCopilotRequestBody(fixtures.chatBody([fixtures.missingBucketTool]), settings);
  assert.equal(result.changed, true);
  assert.deepEqual(result.fixed, ['workspace_project']);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(fixtures.sentParameters(result.body!).properties, {});
  // Everything else on the wire stays byte-identical.
  const before = JSON.parse(fixtures.chatBody([fixtures.missingBucketTool])) as Record<string, unknown>;
  const after = JSON.parse(result.body!) as Record<string, unknown>;
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.model, before.model);
  assert.equal((after.tools as { type: string }[])[0]!.type, 'function');
});

test('the Responses surface carries parameters beside the function name', () => {
  const result = guardCopilotRequestBody(fixtures.responsesBody([fixtures.missingBucketTool]), settings);
  assert.equal(result.changed, true);
  assert.deepEqual(fixtures.sentParameters(result.body!).properties, {});
  assert.equal((JSON.parse(result.body!).tools as { name: string }[])[0]!.name, 'workspace_project');
});

test('conformant, referenced, scalar, nested and opaque declarations stay untouched', () => {
  const list = [fixtures.conformantTool, fixtures.workflowTool, fixtures.nestedDefectTool, fixtures.dataKeywordTool];
  const result = guardCopilotRequestBody(fixtures.chatBody(list), settings);
  assert.equal(result.body, undefined);
  assert.equal(result.changed, false);
  const skipped = guardCopilotRequestBody(fixtures.chatBody([fixtures.referenceTool, fixtures.dynamicReferenceTool, fixtures.scalarParametersTool, fixtures.nonObjectTypeTool, fixtures.invalidPropertiesTool, fixtures.noParametersTool]), settings);
  assert.equal(skipped.body, undefined);
  assert.deepEqual(skipped.skipped.map(item => item.reason), [
    'SKIPPED_REFERENCE', 'SKIPPED_REFERENCE', 'SKIPPED_NOT_OBJECT', 'SKIPPED_NOT_OBJECT_TYPE',
    'SKIPPED_INVALID_PROPERTIES', 'SKIPPED_MISSING_PARAMETERS',
  ]);
});

test('only function declarations in the configured route and family are in scope', () => {
  assert.equal(guardCopilotRequestBody(fixtures.chatBody([fixtures.missingBucketTool], 'gpt-6.1-sol'), settings).body, undefined);
  assert.equal(guardCopilotRequestBody(fixtures.chatBody([fixtures.missingBucketTool]), { ...settings, families: ['gpt'] }).body, undefined);
  assert.equal(guardCopilotRequestBody(fixtures.chatBody([fixtures.missingBucketTool]), { ...settings, providers: [] }).body, undefined);
  // A non-function tool entry is not a declaration this guard owns.
  const custom = JSON.stringify({ model: 'gemini-4-argon', tools: [{ type: 'custom', custom: { name: 'x' } }] });
  assert.equal(guardCopilotRequestBody(custom, settings).body, undefined);
});

test('bodies that are not a bounded JSON tool request are delegated byte-identical', () => {
  for (const body of ['', 'not json', '{"model":"gemini-4-argon"}', '{"model":"gemini-4-argon","tools":[]}', '[]', 'null']) {
    assert.equal(guardCopilotRequestBody(body, settings).body, undefined, body);
  }
  const oversized = JSON.stringify({ model: 'gemini-4-argon', tools: [{ type: 'function', name: 'x', parameters: { type: 'object' } }], pad: 'x'.repeat(MAX_GUARDED_BODY_BYTES) });
  assert.equal(guardCopilotRequestBody(oversized, settings).body, undefined);
});

test('the rewrite preserves every unrelated declaration exactly', () => {
  const result = guardCopilotRequestBody(fixtures.chatBody([fixtures.missingBucketTool, fixtures.conformantTool]), settings);
  const before = JSON.parse(fixtures.chatBody([fixtures.conformantTool])) as { tools: unknown[] };
  const after = JSON.parse(result.body!) as { tools: unknown[] };
  assert.deepEqual(after.tools[1], before.tools[0]);
  assert.deepEqual(result.fixed, ['workspace_project']);
});
