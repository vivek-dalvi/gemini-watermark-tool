import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createImageWatermarkPipelineCleanupConfig,
    createImageWatermarkPipelineRequest
} from '../../src/core/imageWatermarkPipelineRequest.js';

test('createImageWatermarkPipelineCleanupConfig should map cleanup constants', () => {
    const config = createImageWatermarkPipelineCleanupConfig({
        previewEdgeCleanupMaxSize: 40,
        known48EdgeCleanupMinSize: 41,
        known48EdgeCleanupMaxSize: 56,
        v2SmallEdgeCleanupSize: 36,
        v2SmallEdgeCleanupSizeTolerance: 2
    });

    assert.deepEqual(config, {
        previewEdgeCleanupMaxSize: 40,
        known48EdgeCleanupMinSize: 41,
        known48EdgeCleanupMaxSize: 56,
        v2SmallEdgeCleanupSize: 36,
        v2SmallEdgeCleanupSizeTolerance: 2
    });
});

test('createImageWatermarkPipelineRequest should preserve adapter references', () => {
    const imageData = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
    const options = { debugTimings: true };
    const nowMs = () => 1;
    const cloneImageData = (value) => value;
    const alphaGainCandidates = [0.8, 1];
    const alphaPriorityGains = [1];
    const createAcceptedPipelineDependencies = () => ({});
    const cleanupConfig = { previewEdgeCleanupMaxSize: 40 };

    const request = createImageWatermarkPipelineRequest({
        imageData,
        options,
        nowMs,
        cloneImageData,
        alphaGainCandidates,
        alphaPriorityGains,
        createAcceptedPipelineDependencies,
        cleanupConfig,
        visualPostProcessingEnabled: true
    });

    assert.equal(request.imageData, imageData);
    assert.equal(request.options, options);
    assert.equal(request.nowMs, nowMs);
    assert.equal(request.cloneImageData, cloneImageData);
    assert.equal(request.alphaGainCandidates, alphaGainCandidates);
    assert.equal(request.alphaPriorityGains, alphaPriorityGains);
    assert.equal(request.createAcceptedPipelineDependencies, createAcceptedPipelineDependencies);
    assert.equal(request.cleanupConfig, cleanupConfig);
    assert.equal(request.visualPostProcessingEnabled, true);
});

test('createImageWatermarkPipelineRequest should default visual post processing to false', () => {
    const request = createImageWatermarkPipelineRequest();

    assert.equal(request.visualPostProcessingEnabled, false);
});
