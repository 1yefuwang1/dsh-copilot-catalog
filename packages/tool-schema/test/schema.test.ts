import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesRoute, normalizeToolSchemas } from '../dist/schema.js';
import type { GuardSettings } from '../dist/types.js';
import * as fixtures from './fixtures.js';

const settings: GuardSettings = { providers: ['github-copilot'], families: ['gemini'], logFixes: false };

test('adds only a root properties bucket and preserves everything else', () => {
  const before = structuredClone(fixtures.missingBucketTool);
  const result = normalizeToolSchemas(fixtures.tools([fixtures.missingBucketTool, fixtures.conformantTool, fixtures.workflowTool]));
  assert.equal(result.changed, true);
  assert.deepEqual(result.fixed, ['workspace_project']);
  assert.deepEqual(result.skipped, []);
  const fixed = fixtures.parameters(result.tools[0]!);
  assert.deepEqual(fixed.properties, {});
  assert.deepEqual(fixed.oneOf, fixtures.missingBucketTool.parameters!.oneOf);
  assert.equal(fixed.type, 'object');
  assert.equal(result.tools[1], fixtures.tools([fixtures.conformantTool])[0]);
  assert.equal(result.tools[2], fixtures.tools([fixtures.workflowTool])[0]);
  assert.deepEqual(fixtures.missingBucketTool, before);
});

test('is idempotent, byte stable and appends the bucket after existing keywords', () => {
  const first = normalizeToolSchemas(fixtures.tools([fixtures.missingBucketTool]));
  const second = normalizeToolSchemas(first.tools);
  const third = normalizeToolSchemas(fixtures.tools([fixtures.missingBucketTool]));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.tools[0], first.tools[0]);
  assert.equal(JSON.stringify(second.tools), JSON.stringify(first.tools));
  assert.equal(JSON.stringify(third.tools), JSON.stringify(first.tools));
  assert.deepEqual(Object.keys(fixtures.parameters(first.tools[0]!)), [...Object.keys(fixtures.missingBucketTool.parameters!), 'properties']);
});

test('leaves references, non-object, invalid and missing declarations untouched with reasons', () => {
  const input = fixtures.tools([fixtures.referenceTool, fixtures.dynamicReferenceTool, fixtures.scalarParametersTool, fixtures.nonObjectTypeTool, fixtures.invalidPropertiesTool, fixtures.noParametersTool]);
  const result = normalizeToolSchemas(input);
  assert.equal(result.changed, false);
  assert.deepEqual(result.skipped, [
    { tool: 'referenced', reason: 'SKIPPED_REFERENCE' },
    { tool: 'dynamic', reason: 'SKIPPED_REFERENCE' },
    { tool: 'scalar', reason: 'SKIPPED_NOT_OBJECT' },
    { tool: 'array', reason: 'SKIPPED_NOT_OBJECT_TYPE' },
    { tool: 'invalid', reason: 'SKIPPED_INVALID_PROPERTIES' },
    { tool: 'opaque', reason: 'SKIPPED_MISSING_PARAMETERS' },
  ]);
  for (let index = 0; index < input.length; index++) assert.equal(result.tools[index], input[index]);
});

test('never rewrites nested objects or keyword-shaped data', () => {
  const result = normalizeToolSchemas(fixtures.tools([fixtures.nestedDefectTool, fixtures.dataKeywordTool]));
  assert.equal(result.changed, false);
  const nested = fixtures.parameters(result.tools[0]!).properties as Record<string, Record<string, unknown>>;
  assert.equal(nested.inner!.properties, undefined);
  const data = fixtures.parameters(result.tools[1]!).properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(data.pattern!.enum, ['pattern', 'format', 'minimum']);
  assert.equal(data.format!.default, 'format');
});

test('handles exotic prototypes and keyword-shaped names without pollution', () => {
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.type = 'object';
  const nullResult = normalizeToolSchemas([{ name: 'null-prototype', description: 'd', parameters: nullPrototype } as never]);
  assert.deepEqual(fixtures.parameters(nullResult.tools[0]!).properties, {});
  assert.deepEqual(Object.getPrototypeOf(fixtures.parameters(nullResult.tools[0]!)), Object.prototype);

  const ownProtoKeyword = JSON.parse('{"type":"object","__proto__":{"polluted":true}}') as Record<string, unknown>;
  const protoResult = normalizeToolSchemas([{ name: 'proto', description: 'd', parameters: ownProtoKeyword } as never]);
  const normalized = fixtures.parameters(protoResult.tools[0]!);
  assert.equal(Object.hasOwn(normalized, '__proto__'), true);
  assert.deepEqual(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const named = JSON.parse('{"type":"object","properties":{"constructor":{"type":"string"},"prototype":{"type":"string"},"pattern":{"type":"string"}}}') as Record<string, unknown>;
  const namedResult = normalizeToolSchemas([{ name: 'named', description: 'd', parameters: named } as never]);
  assert.equal(namedResult.changed, false);
  assert.deepEqual(Object.keys(fixtures.parameters(namedResult.tools[0]!).properties as object), ['constructor', 'prototype', 'pattern']);
});

test('route matching requires a listed provider and a family marker', () => {
  assert.equal(matchesRoute('github-copilot', 'gemini-4-argon', settings), true);
  assert.equal(matchesRoute('github-copilot', 'GEMINI-3.7-flash', settings), true);
  assert.equal(matchesRoute('github-copilot', 'gpt-6.1-sol', settings), false);
  assert.equal(matchesRoute('deepseek-account', 'gemini-4-argon', settings), false);
  assert.equal(matchesRoute(undefined, 'gemini-4-argon', settings), false);
  assert.equal(matchesRoute('github-copilot', undefined, settings), false);
  assert.equal(matchesRoute('github-copilot', 'gemini-4-argon', { ...settings, providers: [] }), false);
  assert.equal(matchesRoute('github-copilot', 'gemini-4-argon', { ...settings, families: [''] }), false);
});
