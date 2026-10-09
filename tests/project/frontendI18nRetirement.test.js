import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function readRepoText(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('frontend preview i18n runtime and locale assets should be removed from the repository', () => {
  assert.equal(
    existsSync(new URL('../../src/i18n.js', import.meta.url)),
    false,
    'expected src/i18n.js to be removed after retiring the frontend preview i18n runtime'
  );
  assert.equal(
    existsSync(new URL('../../src/i18n', import.meta.url)),
    false,
    'expected src/i18n directory to be removed after retiring the frontend preview locale assets'
  );
});

test('build pipeline should no longer mirror frontend i18n assets into dist', () => {
  const buildScript = readRepoText('build.js');

  assert.doesNotMatch(buildScript, /dist\/i18n/);
  assert.doesNotMatch(buildScript, /src\/i18n/);
});
