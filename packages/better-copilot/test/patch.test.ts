import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const patchUrl = new URL('../cordis.patch.yml', import.meta.url);

/**
 * The bundle patch is the only thing that makes the merged plugin a drop-in
 * replacement: one row, the adapter override, and the web-search selection.
 * Static assertions keep that contract reviewable without a live host.
 */
test('the bundle patch inserts exactly one merged row and keeps the two overrides', async () => {
  const patch = await readFile(patchUrl, 'utf8');

  // Exactly one inserted row, and it is the merged plugin.
  assert.equal((patch.match(/^ {4}- id: /gmu) ?? []).length, 1, 'one inserted row');
  assert.match(patch, /^- insert:$/mu);
  assert.match(patch, /^ {4}- id: better-copilot$/mu);
  assert.match(patch, /^ {6}name: dsh-better-copilot$/mu);

  // The stock adapter is disabled in the same layer that replaces it.
  assert.match(patch, /^- id: llm-pi-ai$/mu);
  assert.match(patch, /^ {2}name: '@deepseek-ai\/dsh-llm-pi-ai'$/mu);
  assert.match(patch, /^ {2}disabled: true$/mu);

  // Search is selected explicitly; the HTTP fetch provider is preserved.
  assert.match(patch, /^- id: web$/mu);
  assert.match(patch, /^ {2}name: '@deepseek-ai\/dsh-web'$/mu);
  assert.match(patch, /^ {4}searchProvider: github-copilot-search$/mu);
  assert.match(patch, /^ {4}fetchProvider: http$/mu);

  // The inserted row names a github-copilot profile: an empty providers map
  // would leave the adapter with no route at all.
  assert.match(patch, /^ {10}github-copilot: \{\}$/mu);
  assert.match(patch, /^ {8}search: \{\}$/mu);
  assert.match(patch, /^ {8}toolSchema: \{\}$/mu);

  // Never select a different fetch provider or a second adapter row.
  assert.equal((patch.match(/^- id: llm-pi-ai$/gmu) ?? []).length, 1);
  assert.doesNotMatch(patch, /disabled: false/u);
});
