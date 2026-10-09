import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createFirstPassMetrics,
    createRegionCorrelationMetrics,
    shouldStopAfterFirstPass
} from '../../src/core/pipelineMetrics.js';
import {
    createPatternImageData,
    createSyntheticAlphaMap
} from './syntheticWatermarkTestUtils.js';

test('shouldStopAfterFirstPass should stop when spatial residual is already low', () => {
    assert.equal(shouldStopAfterFirstPass({
        originalSpatialScore: 0.7,
        originalGradientScore: 0.3,
        firstPassSpatialScore: 0.24,
        firstPassGradientScore: 0.2
    }), true);
});

test('shouldStopAfterFirstPass should stop on safe sign flip with gradient drop', () => {
    assert.equal(shouldStopAfterFirstPass({
        originalSpatialScore: 0.5,
        originalGradientScore: 0.31,
        firstPassSpatialScore: -0.3,
        firstPassGradientScore: 0.08
    }), true);
});

test('shouldStopAfterFirstPass should continue when residual remains visible', () => {
    assert.equal(shouldStopAfterFirstPass({
        originalSpatialScore: 0.5,
        originalGradientScore: 0.31,
        firstPassSpatialScore: 0.32,
        firstPassGradientScore: 0.2
    }), false);
});

test('createFirstPassMetrics should return a normalized first pass record', () => {
    const imageData = createPatternImageData(160, 160);
    const alphaMap = createSyntheticAlphaMap(48);
    const position = { x: 80, y: 80, width: 48, height: 48 };
    const metrics = createFirstPassMetrics({
        imageData,
        alphaMap,
        position,
        originalSpatialScore: 0.6,
        originalGradientScore: 0.3
    });

    assert.equal(metrics.passRecord.index, 1);
    assert.equal(metrics.passRecord.beforeSpatialScore, 0.6);
    assert.equal(metrics.passRecord.beforeGradientScore, 0.3);
    assert.equal(metrics.passRecord.afterSpatialScore, metrics.spatialScore);
    assert.equal(metrics.passRecord.afterGradientScore, metrics.gradientScore);
    assert.equal(metrics.passRecord.nearBlackRatio, metrics.nearBlackRatio);
    assert.equal(metrics.passStopReason, metrics.clearedResidual ? 'residual-low' : 'single-pass');
});

test('createRegionCorrelationMetrics should score a position and optionally include near-black ratio', () => {
    const imageData = createPatternImageData(128, 128);
    const alphaMap = createSyntheticAlphaMap(48);
    const position = { x: 40, y: 48, width: 48, height: 48 };
    const withoutNearBlack = createRegionCorrelationMetrics({
        imageData,
        alphaMap,
        position
    });
    const withNearBlack = createRegionCorrelationMetrics({
        imageData,
        alphaMap,
        position,
        includeNearBlackRatio: true
    });

    assert.equal(typeof withoutNearBlack.spatialScore, 'number');
    assert.equal(typeof withoutNearBlack.gradientScore, 'number');
    assert.equal(Object.hasOwn(withoutNearBlack, 'nearBlackRatio'), false);
    assert.equal(withNearBlack.spatialScore, withoutNearBlack.spatialScore);
    assert.equal(withNearBlack.gradientScore, withoutNearBlack.gradientScore);
    assert.equal(typeof withNearBlack.nearBlackRatio, 'number');
});
