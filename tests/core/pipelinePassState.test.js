import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyPipelinePassOutcome,
    createEmptyPipelinePassState,
    createFirstPassPipelinePassState
} from '../../src/core/pipelinePassState.js';

test('createEmptyPipelinePassState should match pre-pass defaults', () => {
    assert.deepEqual(createEmptyPipelinePassState(), {
        passCount: 0,
        attemptedPassCount: 0,
        passStopReason: null,
        passes: null
    });
});

test('createFirstPassPipelinePassState should seed first pass metadata', () => {
    const passRecord = {
        index: 1,
        beforeSpatialScore: 0.7,
        afterSpatialScore: 0.1
    };

    assert.deepEqual(createFirstPassPipelinePassState({
        firstPassMetrics: {
            passStopReason: 'clean-after-first-pass',
            passRecord
        }
    }), {
        passCount: 1,
        attemptedPassCount: 1,
        passStopReason: 'clean-after-first-pass',
        passes: [passRecord]
    });
});

test('applyPipelinePassOutcome should increment counters and preserve passes', () => {
    const passes = [{ index: 1 }];
    const next = applyPipelinePassOutcome({
        current: {
            passCount: 1,
            attemptedPassCount: 1,
            passStopReason: 'first-pass',
            passes
        },
        outcome: {
            passIncrement: 2,
            passStopReason: 'located-aggressive-alpha'
        }
    });

    assert.deepEqual(next, {
        passCount: 3,
        attemptedPassCount: 3,
        passStopReason: 'located-aggressive-alpha',
        passes
    });
});
