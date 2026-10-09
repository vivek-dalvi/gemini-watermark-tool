import test from 'node:test';
import assert from 'node:assert/strict';

import { createAcceptedPipelineFinalizationRequest } from '../../src/core/pipelineAcceptedFinalizationRequest.js';

test('createAcceptedPipelineFinalizationRequest should map accepted run, trace and context', () => {
    const pipelineState = { finalImageData: { id: 'image' } };
    const passState = { passCount: 2 };
    const alphaAdjustmentStages = [{ stage: 'fine-alpha' }];
    const alphaTrialEvents = [{ stage: 'fine-alpha', decision: 'accept' }];
    const resultContext = { decisionTier: 'standard' };
    const originalImageData = { width: 128, height: 128 };
    const initialSelection = { source: 'standard' };
    const resolvedConfig = { logoSize: 48 };

    const request = createAcceptedPipelineFinalizationRequest({
        acceptedPipelineRun: {
            readPipelineState: () => pipelineState,
            passState
        },
        pipelineTraceRecorder: {
            alphaAdjustmentStages,
            alphaTrialEvents
        },
        resultContext,
        originalImageData,
        initialSelection,
        resolvedConfig
    });

    assert.equal(request.pipelineState, pipelineState);
    assert.equal(request.passState, passState);
    assert.equal(request.traceState.alphaAdjustmentStages, alphaAdjustmentStages);
    assert.equal(request.traceState.alphaTrialEvents, alphaTrialEvents);
    assert.equal(request.resultContext, resultContext);
    assert.equal(request.originalImageData, originalImageData);
    assert.equal(request.initialSelection, initialSelection);
    assert.equal(request.resolvedConfig, resolvedConfig);
});
