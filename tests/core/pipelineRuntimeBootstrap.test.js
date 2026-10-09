import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineRuntimeBootstrap } from '../../src/core/pipelineRuntimeBootstrap.js';

function createImage(width = 64, height = 64) {
    return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
}

function createAlphaMap(size = 48) {
    return new Float32Array(size * size).fill(0.2);
}

test('createAcceptedPipelineRuntimeBootstrap should seed runtime state, pass state, timings and cleanup flags', () => {
    const debugTimings = {};
    const nowValues = [100, 107, 120, 129];
    const imageData = createImage();
    const alphaMap = createAlphaMap();
    const position = { x: 8, y: 8, width: 48, height: 48 };
    const acceptedPipelineState = {
        finalImageData: imageData,
        alphaMap,
        position,
        config: { logoSize: 48, marginRight: 8, marginBottom: 8 },
        alphaGain: 0.9,
        alphaMapSource: 'embedded-48',
        originalSpatialScore: 0.7,
        originalGradientScore: 0.2,
        source: 'standard+catalog',
        adaptiveConfidence: 0.8,
        templateWarp: null,
        decisionTier: 'direct-match'
    };
    const selectedTrial = {
        provenance: { previewAnchor: true },
        config: acceptedPipelineState.config
    };

    const bootstrap = createAcceptedPipelineRuntimeBootstrap({
        nowMs: () => nowValues.shift(),
        acceptedPipelineState,
        selectedTrial,
        debugTimings,
        debugTimingsEnabled: true,
        cleanupConfig: {
            previewEdgeCleanupMaxSize: 64,
            known48EdgeCleanupMinSize: 44,
            known48EdgeCleanupMaxSize: 52,
            v2SmallEdgeCleanupSize: 36,
            v2SmallEdgeCleanupSizeTolerance: 2
        }
    });

    assert.equal(bootstrap.cleanupFlags.usePreviewAnchorFastCleanup, true);
    assert.equal(bootstrap.cleanupFlags.useKnown48EdgeCleanup, false);
    assert.equal(bootstrap.cleanupFlags.useStrongUndersizedAdaptiveCleanup, false);
    assert.equal(bootstrap.cleanupFlags.useV2SmallEdgeCleanup, false);
    assert.equal(bootstrap.passState.passCount, 1);
    assert.equal(bootstrap.passState.attemptedPassCount, 1);
    assert.equal(bootstrap.passState.passes.length, 1);
    assert.equal(bootstrap.firstPassMetrics.passRecord.beforeSpatialScore, 0.7);
    assert.equal(debugTimings.firstPassMetricsMs, 7);
    assert.equal(debugTimings.extraPassMs, 0);
    assert.equal(debugTimings.finalMetricsMs, 9);

    const runtimeState = bootstrap.readPipelineState();
    assert.equal(runtimeState.finalImageData, imageData);
    assert.equal(runtimeState.alphaMap, alphaMap);
    assert.equal(runtimeState.position, position);
    assert.equal(runtimeState.config, acceptedPipelineState.config);
    assert.equal(runtimeState.alphaGain, 0.9);
    assert.equal(runtimeState.alphaMapSource, 'embedded-48');
    assert.equal(runtimeState.originalSpatialScore, 0.7);
    assert.equal(runtimeState.originalGradientScore, 0.2);
    assert.equal(runtimeState.source, 'standard+catalog');
    assert.equal(typeof runtimeState.finalProcessedSpatialScore, 'number');
    assert.equal(typeof runtimeState.finalProcessedGradientScore, 'number');
    assert.equal(
        Math.abs(runtimeState.suppressionGain - (0.7 - runtimeState.finalProcessedSpatialScore)) < 1e-12,
        true
    );
});

test('createAcceptedPipelineRuntimeBootstrap should expose mutable accessors without requiring timings', () => {
    const imageData = createImage();
    const alphaMap = createAlphaMap();
    const acceptedPipelineState = {
        finalImageData: imageData,
        alphaMap,
        position: { x: 8, y: 8, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 8, marginBottom: 8 },
        alphaGain: 1,
        alphaMapSource: null,
        originalSpatialScore: 0.7,
        originalGradientScore: 0.2,
        source: 'standard'
    };
    const bootstrap = createAcceptedPipelineRuntimeBootstrap({
        acceptedPipelineState,
        selectedTrial: {
            provenance: {},
            config: acceptedPipelineState.config
        }
    });
    const nextState = {
        ...bootstrap.readPipelineState(),
        finalImageData: { id: 'after' },
        finalProcessedSpatialScore: 0.1,
        finalProcessedGradientScore: 0.05,
        suppressionGain: 0.6,
        source: 'standard+gain'
    };

    bootstrap.applyPipelineState(nextState);

    assert.deepEqual(bootstrap.readPipelineState().finalImageData, { id: 'after' });
    assert.equal(bootstrap.readPipelineState().finalProcessedSpatialScore, 0.1);
    assert.equal(bootstrap.readPipelineState().source, 'standard+gain');
});
