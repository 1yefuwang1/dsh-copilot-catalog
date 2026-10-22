import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const { compactDeclaration } = await import(new URL('../scripts/compact-declarations.mjs', import.meta.url).href) as {
  compactDeclaration(source: string, fileName?: string): string;
};
const normalized = (text: string) => ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile('sample.d.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));

test('own declaration compaction preserves generic, mapped, conditional and branded public type syntax', () => {
  const cases = [
    'export interface Example<T extends object> { readonly value: T; map<U>(fn: (value: T) => U): Example<U>; }',
    'declare function value<T extends Array<Array<number>> = Array<Array<number>>>(): T; export { value };',
    'export type Picked<T> = { -readonly [K in keyof T]-?: T[K] extends infer U ? U : never };',
    'declare const brand: unique symbol; export interface Branded { readonly [brand]: "nominal"; }',
    'declare namespace Parent { interface Child { readonly value: -1 | 1.25; } } export = Parent;',
    'export type π = { readonly " spaced key ": " keep  spaces "; readonly λ: "λ" };',
  ];
  for (const source of cases) {
    const output = compactDeclaration(source);
    assert.equal(normalized(output), normalized(source));
    assert.equal(output.endsWith('\n'), true);
  }
});

test('literal and multiline template type contents are not whitespace-minified', () => {
  const source = [
    'export type Render<T extends string> = `  header',
    '    ${T & string}',
    '  tail  `;',
    'export type Escaped = "\\u0061\\n  ";',
  ].join('\n');
  const output = compactDeclaration(source);
  assert.equal(normalized(output), normalized(source));
  assert.match(output, /header\n    \$\{T/u);
  assert.ok(output.includes('  tail  `'));
  assert.ok(output.includes('"\\u0061\\n  "'));
});

test('triple-slash references remain part of the declaration graph and formatted declarations shrink', () => {
  const source = [
    '/// <reference types="node" />',
    'export interface Outer {',
    '    readonly value: {',
    '        readonly first: string;',
    '        readonly second: number;',
    '    };',
    '}',
  ].join('\n');
  const output = compactDeclaration(source);
  assert.match(output, /^\/\/\/ <reference types="node"/u);
  assert.equal(normalized(output), normalized(source));
  assert.ok(Buffer.byteLength(output) < Buffer.byteLength(source));
});
