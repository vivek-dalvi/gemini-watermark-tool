import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildAlphaGradientMap,
    classifyResidualBucket,
    finalizeResidualStats,
    summarizeResidualFrames,
    summarizeWatermarkResidual
} from '../../scripts/analyze-video-residual.js';

test('classifyResidualBucket should separate background edge and body pixels', () => {
    assert.equal(classifyResidualBucket(0.01, 0.9), 'nearZero');
    assert.equal(classifyResidualBucket(0.12, 0.2), 'edge');
    assert.equal(classifyResidualBucket(0.3, 0.02), 'highBody');
    assert.equal(classifyResidualBucket(0.12, 0.02), 'lowBody');
});

test('buildAlphaGradientMap should expose non-zero gradients around alpha edges', () => {
    const alphaMap = new Float32Array([
        0, 0, 0,
        0, 1, 0,
        0, 0, 0
    ]);
    const { gradient, maxGradient } = buildAlphaGradientMap(alphaMap, 3, 3);

    assert.equal(gradient.length, 9);
    assert.ok(maxGradient >= 0);
});

test('buildAlphaGradientMap should classify crop-boundary alpha edges as gradients', () => {
    const alphaMap = new Float32Array([
        0, 1, 0,
        0, 0, 0,
        0, 0, 0
    ]);
    const { gradient, maxGradient } = buildAlphaGradientMap(alphaMap, 3, 3);

    assert.ok(maxGradient > 0);
    assert.ok(gradient[1] > 0);
});

test('finalizeResidualStats should summarize signed residuals', () => {
    const stats = finalizeResidualStats({
        n: 2,
        sum: 2,
        abs: 6,
        sq: 20,
        neg: 1,
        pos: 1,
        maxAbs: 4
    });

    assert.equal(stats.mean, 1);
    assert.equal(stats.meanAbs, 3);
    assert.equal(stats.rms, Math.sqrt(10));
    assert.equal(stats.negativeRatio, 0.5);
    assert.equal(stats.positiveRatio, 0.5);
    assert.equal(stats.maxAbs, 4);
});

test('summarizeWatermarkResidual should subtract near-zero background drift', () => {
    const width = 4;
    const height = 4;
    const current = new Uint8ClampedArray(width * height * 4);
    const reference = new Uint8ClampedArray(width * height * 4);

    for (let pixel = 0; pixel < width * height; pixel++) {
        const idx = pixel * 4;
        reference[idx] = 50;
        reference[idx + 1] = 50;
        reference[idx + 2] = 50;
        reference[idx + 3] = 255;
        current[idx] = 55;
        current[idx + 1] = 55;
        current[idx + 2] = 55;
        current[idx + 3] = 255;
    }

    const highBodyPixel = (2 * width + 2) * 4;
    current[highBodyPixel] = 45;
    current[highBodyPixel + 1] = 45;
    current[highBodyPixel + 2] = 45;

    const alphaMap = new Float32Array([
        0, 0, 0, 0,
        0, 0.1, 0.1, 0,
        0, 0.1, 0.3, 0,
        0, 0, 0, 0
    ]);

    const report = summarizeWatermarkResidual({
        currentImage: { width, height, data: current },
        referenceImage: { width, height, data: reference },
        alphaMap,
        watermarkPosition: { x: 0, y: 0, width, height },
        edgeGradientThreshold: 2
    });

    assert.equal(report.backgroundMean, 5);
    assert.equal(report.buckets.highBody.n, 1);
    assert.ok(report.buckets.highBody.mean < -9.9);
    assert.equal(report.buckets.nearZero.mean, 0);
});

test('summarizeResidualFrames should aggregate finalized frame buckets', () => {
    const aggregate = summarizeResidualFrames([
        {
            buckets: {
                active: {
                    n: 2,
                    mean: 1,
                    meanAbs: 2,
                    rms: Math.sqrt(5),
                    negativeRatio: 0.5,
                    positiveRatio: 0.5,
                    maxAbs: 3
                }
            }
        },
        {
            buckets: {
                active: {
                    n: 1,
                    mean: -2,
                    meanAbs: 2,
                    rms: 2,
                    negativeRatio: 1,
                    positiveRatio: 0,
                    maxAbs: 2
                }
            }
        }
    ]);

    assert.equal(aggregate.active.n, 3);
    assert.equal(aggregate.active.mean, 0);
    assert.equal(aggregate.active.maxAbs, 3);
});
