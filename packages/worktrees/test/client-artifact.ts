import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

export const clientArtifact = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
// STATIC-ONLY readable assertions derived from the actual typed source. This text
// is never evaluated as a behavioral substitute for the shipped minified bundle.
export const staticClientSource = ts.transpileModule(await readFile(new URL('../client.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, newLine: ts.NewLineKind.LineFeed },
}).outputText;

/** Test-only introspection of the ACTUAL emitted factory. KeepNames metadata
 * resolves lexical aliases; no function/component/guard implementation changes.
 * Unstable emitted spelling is not a compatibility or authority assertion.
 */
export function exposeClient(artifact: string, names: readonly string[], outlet = 'renderTest'): string {
  const file = ts.createSourceFile('client.js', artifact, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const aliases = new Map<string, string>();
  const seams: ts.ObjectLiteralExpression[] = [];
  let protocolSeam: ts.ObjectLiteralExpression | undefined;
  const key = (name: ts.PropertyName | undefined): string | undefined => name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.arguments.length === 2 && ts.isIdentifier(node.arguments[0]!) && ts.isStringLiteral(node.arguments[1]!)) aliases.set(node.arguments[1]!.text, node.arguments[0]!.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = node.initializer;
      if (ts.isCallExpression(value) && value.arguments.length === 2 && ts.isStringLiteral(value.arguments[1]!)) aliases.set(value.arguments[1]!.text, node.name.text);
      if (ts.isObjectLiteralExpression(value)) {
        const search = value.properties.find(property => ts.isPropertyAssignment(property) && key(property.name) === 'searchProjects');
        if (search && ts.isPropertyAssignment(search) && ts.isStringLiteral(search.initializer)) aliases.set(search.initializer.text === 'Search projects and sessions' ? 'en' : 'zh', node.name.text);
      }
      if (ts.isArrayLiteralExpression(value) && value.elements.some(element => ts.isStringLiteral(element) && element.text === 'sidebar.workspaces.directoryFlow')) aliases.set('projectSlots', node.name.text);
    }
    if (ts.isObjectLiteralExpression(node) && ['inject', 'protocol', 'apply'].every(name => node.properties.some(property => key(property.name) === name))) {
      seams.push(node);
      const protocol = node.properties.find(property => key(property.name) === 'protocol');
      if (protocol && ts.isPropertyAssignment(protocol) && ts.isCallExpression(protocol.initializer)) {
        const value = protocol.initializer.arguments[0];
        if (value && ts.isObjectLiteralExpression(value)) { protocolSeam = value; }
        if (value && ts.isObjectLiteralExpression(value)) for (const property of value.properties) {
          if (ts.isShorthandPropertyAssignment(property)) aliases.set(property.name.text, property.name.text);
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) { const name = key(property.name); if (name) aliases.set(name, property.initializer.text); }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(seams.length, 1, 'actual minified factory has one inject/protocol/apply export seam');
  const additions = names.map(name => { const alias = aliases.get(name); assert.ok(alias, `actual keepNames/protocol binding: ${name}`); return `${JSON.stringify(name)}:${alias}`; }).join(',');
  if (outlet === 'protocol') {
    assert.ok(protocolSeam, 'actual minified factory.protocol object');
    const offset = protocolSeam.getStart(file) + 1;
    return artifact.slice(0, offset) + additions + ',' + artifact.slice(offset);
  }
  const offset = seams[0]!.getStart(file) + 1;
  return artifact.slice(0, offset) + `${JSON.stringify(outlet)}:{${additions}},` + artifact.slice(offset);
}

export function clientModule(artifact = clientArtifact, sandbox: Record<string, unknown> = {}) {
  let module!: { id: string; factory(require: (name: string) => unknown): any };
  vm.runInNewContext(artifact, { AbortController, AbortSignal, crypto: webcrypto, ...sandbox,
    window: { __ModuleLoader__: { load(value: typeof module) { module = value; } } },
  });
  assert.equal(module.id, '@1yefuwang1/dsh-worktrees'); return module;
}
export function clientProtocol(sandbox: Record<string, unknown> = {}) {
  return clientModule(clientArtifact, sandbox).factory(name => {
    assert.equal(name, 'react', 'the emitted factory imports only React');
    return { createElement() { throw new Error('Pure protocol tests do not render components.'); }, forwardRef: (component: unknown) => component };
  }).protocol;
}
export function clientProbe(names: readonly string[], sandbox: Record<string, unknown> = {}) {
  return clientModule(exposeClient(clientArtifact, names, 'protocol'), sandbox).factory(name => {
    assert.equal(name, 'react');
    return { createElement() { throw new Error('Pure protocol tests do not render components.'); }, forwardRef: (component: unknown) => component };
  }).protocol;
}
