import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComparisonGridFilter,
  parseCropBox,
  parseInputSpec,
  renderComparisonGridMarkdown
} from '../../scripts/render-video-comparison-grid.js';

test('parseInputSpec should split label and path at the first equals sign', () => {
  const input = parseInputSpec('current MVP=.artifacts/out=file.mp4');

  assert.equal(input.label, 'current MVP');
  assert.match(input.path, /out=file\.mp4$/);
});

test('buildComparisonGridFilter should create crop, labels, and 2x2 xstack layout', () => {
  const filter = buildComparisonGridFilter({
    inputs: [
      { label: 'original' },
      { label: 'current MVP' },
      { label: 'UI preset' },
      { label: 'allenk' }
    ],
    cropBox: parseCropBox('1676,836,200,200'),
    tileWidth: 320
  });

  assert.match(filter, /crop=200:200:1676:836/);
  assert.match(filter, /drawtext=text='current MVP'/);
  assert.match(filter, /xstack=inputs=4:layout=0_0\|w0_0\|0_h0\|w0_h0/);
});

test('parseCropBox should accept comma or whitespace separated coordinates', () => {
  assert.deepEqual(parseCropBox('1676,836,200,200'), {
    x: 1676,
    y: 836,
    width: 200,
    height: 200
  });
  assert.deepEqual(parseCropBox('1676 836 200 200'), {
    x: 1676,
    y: 836,
    width: 200,
    height: 200
  });
});

test('renderComparisonGridMarkdown should include output, crop, and input labels', () => {
  const markdown = renderComparisonGridMarkdown({
    generatedAt: '2026-06-11T00:00:00.000Z',
    outputPath: 'review.mp4',
    cropBox: { x: 1, y: 2, width: 3, height: 4 },
    tileWidth: 320,
    inputs: [
      { label: 'original', path: 'a.mp4' },
      { label: 'UI preset', path: 'b.mp4' }
    ]
  });

  assert.match(markdown, /review\.mp4/);
  assert.match(markdown, /1,2,3,4/);
  assert.match(markdown, /UI preset/);
});
