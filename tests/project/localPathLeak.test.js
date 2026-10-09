import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const LOCAL_PATH_PATTERNS = [
  /D:\\Project\\/,
  /D:\/Project\//,
  /C:\\Users\\/,
  /C:\/Users\//
];

const SKIPPED_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpg',
  '.jpeg',
  '.mp4',
  '.onnx',
  '.png',
  '.wasm',
  '.webp',
  '.zip'
]);

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'buffer'
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function extensionOf(filePath) {
  const match = filePath.match(/(\.[^./\\]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function isLikelyText(buffer) {
  return buffer.includes(0) === false;
}

test('tracked text files should not leak local absolute paths', () => {
  const leaks = [];
  for (const filePath of trackedFiles()) {
    if (SKIPPED_EXTENSIONS.has(extensionOf(filePath))) continue;

    const buffer = readFileSync(new URL(`../../${filePath}`, import.meta.url));
    if (!isLikelyText(buffer)) continue;

    const text = buffer.toString('utf8');
    for (const pattern of LOCAL_PATH_PATTERNS) {
      if (pattern.test(text)) {
        leaks.push(`${filePath}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(leaks, []);
});
