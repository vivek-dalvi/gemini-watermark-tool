import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveReviewScreenshotOptions } from '../../scripts/create-video-review-screenshot.js';

test('resolveReviewScreenshotOptions should normalize paths and viewport settings', () => {
    const options = resolveReviewScreenshotOptions({
        htmlPath: '.artifacts/review/index.html',
        outputPath: '.artifacts/review/index.png',
        reportPath: '.artifacts/review/index-screenshot.json',
        width: '1280',
        height: '720',
        fullPage: false
    });

    assert.equal(options.htmlPath, path.resolve('.artifacts/review/index.html'));
    assert.equal(options.outputPath, path.resolve('.artifacts/review/index.png'));
    assert.equal(options.reportPath, path.resolve('.artifacts/review/index-screenshot.json'));
    assert.equal(options.width, 1280);
    assert.equal(options.height, 720);
    assert.equal(options.fullPage, false);
});

test('resolveReviewScreenshotOptions should default to alpha review screenshot output', () => {
    const options = resolveReviewScreenshotOptions();

    assert.match(options.htmlPath, /video-alpha-policy035-review[\\/]review-pack[\\/]latest-review-index\.html$/);
    assert.match(options.outputPath, /video-alpha-policy035-review[\\/]review-pack[\\/]latest-review-index\.png$/);
    assert.equal(options.width, 1440);
    assert.equal(options.height, 1200);
    assert.equal(options.fullPage, true);
});
