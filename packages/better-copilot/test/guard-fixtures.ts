/**
 * Sanitized tool declarations shaped like the real DSH ones. No session, user or
 * credential data: only the schema constructs the guard is meant to classify.
 */
import type { ToolSchema } from '../dist/guard-types.js';

/** A declaration exactly as this fixture describes it, before the guard sees it. */
export interface FixtureTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export const conformantTool: FixtureTool = {
  name: 'conformant', description: 'Already declares a properties bucket.',
  parameters: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'] },
};

export const missingBucketTool: FixtureTool = {
  name: 'workspace_project', description: 'Object schema declared as a top-level union without properties.',
  parameters: {
    type: 'object',
    oneOf: [
      { type: 'object', additionalProperties: false, properties: { action: { const: 'list', type: 'string' }, projectId: { type: 'string', format: 'uuid' } }, required: ['action'] },
      { type: 'object', additionalProperties: false, properties: { action: { const: 'remove', type: 'string' }, projectId: { type: 'string' } }, required: ['action', 'projectId'] },
    ],
  },
};

export const workflowTool: FixtureTool = {
  name: 'workflow', description: 'Nested additionalProperties true is left alone.',
  parameters: { type: 'object', properties: { meta: { type: 'object', additionalProperties: true } }, required: [] },
};

export const referenceTool: FixtureTool = { name: 'referenced', description: 'Reference at the root.', parameters: { $ref: '#/$defs/tool' } };
export const dynamicReferenceTool: FixtureTool = { name: 'dynamic', description: 'Dynamic reference at the root.', parameters: { $dynamicRef: '#tool' } };
// Deliberately non-object parameters; the single place this fixture leaves JSON-object shape.
export const scalarParametersTool = { name: 'scalar', description: 'Not an object.', parameters: true } as unknown as FixtureTool;
export const nonObjectTypeTool: FixtureTool = { name: 'array', description: 'Array at the root.', parameters: { type: 'array', items: { type: 'string' } } };
export const invalidPropertiesTool: FixtureTool = { name: 'invalid', description: 'Properties is not a mapping.', parameters: { type: 'object', properties: [] } };
export const noParametersTool: FixtureTool = { name: 'opaque', description: 'No parameters at all.' };

export const nestedDefectTool: FixtureTool = {
  name: 'nested', description: 'Only nested objects lack a bucket; the guard must not add one there.',
  parameters: { type: 'object', properties: { inner: { type: 'object' } } },
};

export const dataKeywordTool: FixtureTool = {
  name: 'data', description: 'Keyword-shaped data must survive untouched.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', enum: ['pattern', 'format', 'minimum'] },
      format: { type: 'string', default: 'format' },
    },
  },
};

/**
 * One serialized chat-completions request carrying the fixture declarations, as
 * the adapter builds it for the Copilot wire.
 */
export function chatBody(list: readonly FixtureTool[], model = 'gemini-4-argon'): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'synthetic' }],
    tools: list.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters } })),
  });
}

/** One serialized Responses request carrying the fixture declarations. */
export function responsesBody(list: readonly FixtureTool[], model = 'gemini-4-argon'): string {
  return JSON.stringify({
    model,
    input: [{ role: 'user', content: 'synthetic' }],
    tools: list.map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.parameters })),
  });
}

/** Read one sent declaration's parameters from either surface. */
export function sentParameters(body: string, index = 0): Record<string, unknown> {
  const parsed = JSON.parse(body) as { tools: { function?: { parameters?: Record<string, unknown> }; parameters?: Record<string, unknown> }[] };
  const declaration = parsed.tools[index]!;
  return (declaration.function?.parameters ?? declaration.parameters ?? {}) as Record<string, unknown>;
}

/** The fixture declarations are structurally the tools the assembler carries. */
export function tools(list: readonly FixtureTool[]): ToolSchema[] {
  return list as unknown as ToolSchema[];
}

/** Read one tool's JSON parameters without repeating the boundary cast. */
export function parameters(tool: ToolSchema): Record<string, unknown> {
  return (tool.parameters ?? {}) as Record<string, unknown>;
}

