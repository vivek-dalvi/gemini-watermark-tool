import test from 'node:test';
import assert from 'node:assert/strict';

import { createPipelineTraceRecorder } from '../../src/core/pipelineTrace.js';

test('createPipelineTraceRecorder should record alpha trial events verbatim', () => {
    const recorder = createPipelineTraceRecorder();
    const event = {
        strategy: 'located-aggressive-alpha',
        decision: 'reject',
        blockedGate: 'passable-spatial-drift'
    };

    recorder.recordAlphaTrialEvent(null);
    recorder.recordAlphaTrialEvent(event);

    assert.deepEqual(recorder.alphaTrialEvents, [event]);
});

test('createPipelineTraceRecorder should normalize stage fields and gate same-gain stages', () => {
    const recorder = createPipelineTraceRecorder();

    recorder.recordAlphaAdjustmentStage({
        stage: 'same-alpha-without-allow',
        fromAlphaGain: 1,
        toAlphaGain: 1
    });
    recorder.recordAlphaAdjustmentStage({
        stage: 'known-48-luma-edge-correction',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.2,
        beforeGradientScore: Number.NaN,
        afterSpatialScore: 0.1,
        afterGradientScore: 0.05,
        suppressionGain: 0.1,
        cost: 0.03,
        profileExponent: Infinity,
        alphaStrategy: '',
        repairStrategy: 'luma-edge',
        allowSameAlphaGain: true
    });

    assert.equal(recorder.alphaAdjustmentStages.length, 1);
    assert.deepEqual(recorder.alphaAdjustmentStages[0], {
        stage: 'known-48-luma-edge-correction',
        fromAlphaGain: 1,
        toAlphaGain: 1,
        beforeSpatialScore: 0.2,
        beforeGradientScore: null,
        afterSpatialScore: 0.1,
        afterGradientScore: 0.05,
        suppressionGain: 0.1,
        cost: 0.03,
        profileExponent: null,
        alphaStrategy: null,
        repairStrategy: 'luma-edge'
    });
});
