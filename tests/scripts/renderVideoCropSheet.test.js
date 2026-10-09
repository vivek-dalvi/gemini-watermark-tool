import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildComparisonColumns,
    normalizeCropBox,
    parseCropBox,
    parseTimestampList,
    resolveDefaultVideoCropBox,
    resolveVideoCropTimestamps
} from '../../scripts/render-video-crop-sheet.js';

test('parseTimestampList should parse comma-separated seconds', () => {
    assert.deepEqual(parseTimestampList('1, 2.5, 7'), [1, 2.5, 7]);
    assert.deepEqual(parseTimestampList('1 2.5 7'), [1, 2.5, 7]);
    assert.deepEqual(parseTimestampList([0, '3']), [0, 3]);
});

test('parseTimestampList should reject empty explicit timestamp sets', () => {
    assert.throws(
        () => parseTimestampList('bad,-1'),
        /至少需要一个有效时间点/
    );
});

test('parseCropBox should parse and normalize crop boxes', () => {
    assert.deepEqual(parseCropBox('10.2,20.7,199.8,200.1'), {
        left: 10,
        top: 21,
        width: 200,
        height: 200
    });
    assert.deepEqual(parseCropBox('10.2 20.7 199.8 200.1'), {
        left: 10,
        top: 21,
        width: 200,
        height: 200
    });
});

test('normalizeCropBox should clamp boxes to video bounds', () => {
    assert.deepEqual(
        normalizeCropBox({ left: -5, top: 90, width: 30, height: 30 }, { width: 100, height: 100 }),
        { left: 0, top: 90, width: 25, height: 10 }
    );
});

test('resolveDefaultVideoCropBox should use the 1080p video catalog anchor', () => {
    assert.deepEqual(resolveDefaultVideoCropBox({ width: 1920, height: 1080 }), {
        left: 1676,
        top: 836,
        width: 200,
        height: 200
    });
});

test('buildComparisonColumns should include residual diff when all videos are provided', () => {
    assert.deepEqual(
        buildComparisonColumns({ currentPath: 'current.mp4', referencePath: 'allenk.mp4' }).map((column) => column.id),
        ['original', 'current', 'reference', 'changed', 'residual']
    );
});

test('buildComparisonColumns should allow reference-only comparisons', () => {
    assert.deepEqual(
        buildComparisonColumns({ currentPath: null, referencePath: 'allenk.mp4' }).map((column) => column.id),
        ['original', 'reference']
    );
});

test('buildComparisonColumns should support original-only intake sheets', () => {
    assert.deepEqual(
        buildComparisonColumns({ currentPath: null, referencePath: null }).map((column) => column.id),
        ['original']
    );
});

test('resolveVideoCropTimestamps should drop timestamps past the video duration', () => {
    assert.deepEqual(
        resolveVideoCropTimestamps([1, 3, 9], { duration: 4 }),
        [1, 3]
    );
    assert.deepEqual(
        resolveVideoCropTimestamps([9], { duration: 4 }),
        [2]
    );
});
