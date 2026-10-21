import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));

test('browser dependency graph stays browser-only and has no Host/provider/Agent authority', async () => {
  const result = await build({ absWorkingDir: root, entryPoints: ['client.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false, metafile: true, logLevel: 'silent' });
  assert.deepEqual(Object.keys(result.metafile.inputs).sort(), ['client-blocks.ts', 'client-import-model.ts', 'client-import.ts', 'client-model.ts', 'client.ts', 'locale/en.json', 'src/git/context.ts', 'src/git/guidance.ts', 'src/git/sanitize.ts', 'src/import/protocol.ts', 'src/protocol.ts']);
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports), []);
  const bundle = result.outputFiles[0]!.text;
  assert.doesNotMatch(bundle, /node:|@azure\/|resolveAgent|agents\.resolve|sessionPersistence|localStorage|sessionStorage|indexedDB|fetch\(/u);
  assert.doesNotMatch(bundle, /addEventListener\(["'](?:submit|click)|MutationObserver/u, 'no DOM interception adapter');
  assert.match(bundle, /__ModuleLoader__\.load/u);
  const source = await readFile(new URL('../client.ts', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/gu)].map(match => match[1]), ['react']);
});

test('published browser artifact has a fixed module identity and excludes inline sourcemaps/secrets', async () => {
  const source = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.exports['./client'], './dist/client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.match(source, /id:"@1yefuwang1\/dsh-azure-sync"/u);
  assert.doesNotMatch(source, /sourceMappingURL|AccountKey=[A-Za-z0-9+/]{20}/u);
});
