import ts from 'typescript';

/** Compact package-owned declarations without renaming symbols or changing literal/token semantics. */
export function compactDeclaration(source, fileName = 'artifact.d.ts') {
  const parse = text => ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const normalized = printer.printFile(parse(source));
  const tree = parse(normalized), tokens = [];
  function collect(node) {
    const children = node.getChildren(tree);
    if (children.length) { for (const child of children) collect(child); return; }
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    const text = normalized.slice(node.getStart(tree), node.end);
    if (text) tokens.push(text);
  }
  collect(tree);
  // Triple-slash references affect the public type graph and are not disposable comments.
  const first = tree.getFirstToken()?.getStart(tree) ?? normalized.length;
  const directives = normalized.slice(0, first).split('\n').filter(line => /^\s*\/\/\//u.test(line)).join('\n');
  const wordEnd = /[\p{ID_Continue}$\\]$/u, wordStart = /^[\p{ID_Continue}$\\]/u;
  const operatorEnd = /[<>+\-*/&|?=!.]$/u, operatorStart = /^[<>+\-*/&|?=!.]/u;
  let text = directives ? directives + '\n' : '', previous = '';
  for (const token of tokens) {
    // Keep identifiers/keywords distinct and avoid accidentally creating compound operators/comments.
    const separator = previous && ((wordEnd.test(previous) && wordStart.test(token)) ||
      (operatorEnd.test(previous) && operatorStart.test(token) && !(previous === '>' && token === '>')) || (/[0-9]$/u.test(previous) && token.startsWith('.')));
    if (separator) text += ' ';
    text += token; previous = token;
  }
  text += '\n';
  // Fail closed if any lexical join changes the parsed/printed declaration, including template literals.
  if (printer.printFile(parse(text)) !== normalized) throw new Error(`Declaration compaction changed syntax: ${fileName}`);
  return text;
}
