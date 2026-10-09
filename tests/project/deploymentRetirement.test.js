import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function readRepoText(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('legacy deployment config should be removed from the repository', () => {
  assert.equal(
    existsSync(new URL('../../wrangler.toml', import.meta.url)),
    false,
    'expected the retired deployment config to be removed from the repository'
  );
});

test('docs and local agent instructions should no longer describe retired asset deployment paths', () => {
  for (const relativePath of ['README.md', 'README_zh.md', 'AGENTS.md']) {
    const source = readRepoText(relativePath);
    assert.doesNotMatch(source, /wrangler\.toml/i);
    assert.doesNotMatch(source, /Cloudflare Worker|Cloudflare 部署|Wrangler/i);
  }
});

test('ci workflow should stay focused on build and test validation without retired deployment references', () => {
  const workflow = readRepoText('.github/workflows/ci.yml');

  assert.match(workflow, /name:\s+Build/i);
  assert.match(workflow, /name:\s+Test/i);
  assert.doesNotMatch(workflow, /wrangler/i);
  assert.doesNotMatch(workflow, /cloudflare/i);
});
