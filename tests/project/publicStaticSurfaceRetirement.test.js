import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function readRepoText(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('retired public legal landing page should be removed from the repository', () => {
  assert.equal(
    existsSync(new URL('../../public/terms.html', import.meta.url)),
    false,
    'expected public/terms.html to be removed after retiring the old public preview site surface'
  );
});

test('active static pages and docs should no longer reference retired terms.html', () => {
  for (const relativePath of [
    'public/dev-preview.html',
    'README.md',
    'README_zh.md'
  ]) {
    assert.doesNotMatch(readRepoText(relativePath), /terms\.html/);
  }
});
