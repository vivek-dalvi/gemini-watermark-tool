import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createSyntheticVeoTextWatermarkImageData,
    detectVeoTextWatermarkFromFramesAsync,
    detectVeoTextWatermarkFromFrames,
    resolveVeoTextSearchCandidates,
    scoreVeoTextTemplateAt
} from '../../src/video/veoTextWatermarkDetector.js';
import { getVeoTextWatermarkTemplate } from '../../src/video/veoTextWatermarkTemplates.js';

function createBlankImageData(width, height, value = 48) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
    }
    return { width, height, data };
}

function createCorrelatedTextImageData({
    width,
    height,
    template,
    position,
    signal = 0.5,
    noise = 0.5,
    backgroundValue = 48
}) {
    const imageData = createBlankImageData(width, height, backgroundValue);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const pixel = row * position.width + col;
            const templateValue = template.detectorMap[pixel] || 0;
            const noiseValue = (((row * 17 + col * 31) % 23) / 22) - 0.5;
            const luma = Math.max(0, Math.min(255, Math.round(
                backgroundValue + templateValue * signal * 160 + noiseValue * noise * 160
            )));
            const idx = ((position.y + row) * width + position.x + col) * 4;
            imageData.data[idx] = luma;
            imageData.data[idx + 1] = luma;
            imageData.data[idx + 2] = luma;
        }
    }
    return imageData;
}

test('scoreVeoTextTemplateAt returns strong evidence for a synthetic text watermark', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10', { alphaGain: 0.3 });
    const position = { x: 682, y: 1254, width: 23, height: 10 };
    const imageData = createSyntheticVeoTextWatermarkImageData({
        width: 720,
        height: 1280,
        template,
        position
    });

    const score = scoreVeoTextTemplateAt(imageData, template, position.x, position.y);

    assert.ok(score.ncc > 0.95, score);
});

test('detectVeoTextWatermarkFromFrames selects the 23x10 Veo text template on 720x1280 frames', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10', { alphaGain: 0.3 });
    const position = { x: 682, y: 1254, width: 23, height: 10 };
    const frames = [0, 1, 2, 3, 4].map((timestamp) => ({
        timestamp,
        imageData: createSyntheticVeoTextWatermarkImageData({
            width: 720,
            height: 1280,
            template,
            position,
            backgroundValue: 40 + timestamp
        })
    }));

    const result = detectVeoTextWatermarkFromFrames({
        frames,
        width: 720,
        height: 1280,
        templates: [template],
        minNcc: 0.8
    });

    assert.equal(result.watermarkKind, 'veo-text');
    assert.equal(result.isConfident, true);
    assert.equal(result.template.id, 'veo-text-23x10');
    assert.deepEqual(result.position, position);
    assert.equal(result.summary.best.votes, frames.length);
});

test('detectVeoTextWatermarkFromFrames accepts stable intermittent low-contrast text evidence', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10');
    const position = { x: 682, y: 1254, width: 23, height: 10 };
    const frames = [
        { signal: 0.3, noise: 0.9 },
        { signal: 0.42, noise: 0.75 },
        { signal: 0.35, noise: 0.85 },
        { signal: 0.95, noise: 0.35 },
        { signal: 1, noise: 0.3 }
    ].map((options, timestamp) => ({
        timestamp,
        imageData: createCorrelatedTextImageData({
            width: 720,
            height: 1280,
            template,
            position,
            ...options
        })
    }));

    const result = detectVeoTextWatermarkFromFrames({
        frames,
        width: 720,
        height: 1280,
        templates: [template],
        marginRadiusX: 0,
        marginRadiusY: 0
    });

    assert.equal(result.summary.best.candidateId, 'veo-text-23x10:682:1254');
    assert.equal(result.summary.best.votes, frames.length);
    assert.ok(result.summary.best.maxNcc >= result.summary.minNcc, result.summary.best);
    assert.ok(result.summary.best.meanNcc < result.summary.minNcc, result.summary.best);
    assert.equal(result.isConfident, true);
});

test('detectVeoTextWatermarkFromFramesAsync yields while preserving Veo text detection result', async () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10', { alphaGain: 0.3 });
    const position = { x: 682, y: 1254, width: 23, height: 10 };
    const frames = [0, 1, 2].map((timestamp) => ({
        timestamp,
        imageData: createSyntheticVeoTextWatermarkImageData({
            width: 720,
            height: 1280,
            template,
            position,
            backgroundValue: 40 + timestamp
        })
    }));
    let yieldCount = 0;

    const result = await detectVeoTextWatermarkFromFramesAsync({
        frames,
        width: 720,
        height: 1280,
        templates: [template],
        minNcc: 0.8,
        yieldEveryCandidates: 10,
        yieldToMainThread: async () => {
            yieldCount++;
        }
    });

    assert.ok(yieldCount > 0);
    assert.equal(result.watermarkKind, 'veo-text');
    assert.equal(result.isConfident, true);
    assert.equal(result.template.id, 'veo-text-23x10');
    assert.deepEqual(result.position, position);
    assert.equal(result.summary.best.votes, frames.length);
});

test('detectVeoTextWatermarkFromFrames fails closed on blank frames', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10');
    const frames = [0, 1, 2, 3, 4].map((timestamp) => ({
        timestamp,
        imageData: createBlankImageData(720, 1280)
    }));

    const result = detectVeoTextWatermarkFromFrames({
        frames,
        width: 720,
        height: 1280,
        templates: [template]
    });

    assert.equal(result.watermarkKind, 'veo-text');
    assert.equal(result.isConfident, false);
});

test('detectVeoTextWatermarkFromFrames keeps default-margin candidates for residual tracking', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10');
    const frames = [0, 1, 2, 3].map((timestamp) => ({
        timestamp,
        imageData: createBlankImageData(720, 1280)
    }));

    const result = detectVeoTextWatermarkFromFrames({
        frames,
        width: 720,
        height: 1280,
        templates: [template]
    });

    assert.ok(
        result.summary.candidates.some((candidate) => candidate.candidateId === 'veo-text-23x10:682:1254'),
        result.summary.candidates.map((candidate) => candidate.candidateId)
    );
});

test('resolveVeoTextSearchCandidates keeps the default search set bounded for UI detection', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10');
    const candidates = resolveVeoTextSearchCandidates({
        width: 720,
        height: 1280,
        templates: [template]
    });

    assert.ok(candidates.length <= 100, candidates.length);
    assert.ok(
        candidates.some((candidate) => candidate.id === 'veo-text-23x10:682:1254'),
        candidates.map((candidate) => candidate.id)
    );
});

test('resolveVeoTextSearchCandidates clamps candidates inside bounds', () => {
    const template = getVeoTextWatermarkTemplate('veo-text-99x43');
    const candidates = resolveVeoTextSearchCandidates({
        width: 100,
        height: 44,
        templates: [template],
        marginRadiusX: 100,
        marginRadiusY: 100
    });

    assert.ok(candidates.length > 0);
    assert.ok(candidates.every((candidate) => (
        candidate.x >= 0 &&
        candidate.y >= 0 &&
        candidate.x + candidate.width <= 100 &&
        candidate.y + candidate.height <= 44
    )));
});
