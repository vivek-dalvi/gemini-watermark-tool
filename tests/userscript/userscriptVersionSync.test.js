import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('userscript metadata version should be derived from package.json', () => {
  const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');

  assert.match(buildScript, /\/\/ @version\s+\$\{pkg\.version\}/);
  assert.doesNotMatch(buildScript, /\/\/ @version\s+0\.\d+\.\d+/);
});

test('userscript metadata should declare hosted auto-update URLs', () => {
  const buildScript = readFileSync(new URL('../../build.js', import.meta.url), 'utf8');
  const hostedUserscriptUrl = 'https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js';

  assert.match(buildScript, new RegExp(`// @downloadURL\\s+${hostedUserscriptUrl.replaceAll('.', '\\.')}`));
  assert.match(buildScript, new RegExp(`// @updateURL\\s+${hostedUserscriptUrl.replaceAll('.', '\\.')}`));
});
