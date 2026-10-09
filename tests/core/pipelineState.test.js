import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAcceptedPipelineState,
    createInitialPipelineRuntimeState,
    createPipelineStateAccessors,
    createPipelineStateCommit
} from '../../src/core/pipelineState.js';

function createCurrentState() {
    return {
        finalImageData: { id: 'before-image' },
        alphaMap: { id: 'before-alpha' },
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
        alphaGain: 1,
        alphaMapSource: 'embedded-48',
        originalSpatialScore: 0.7,
        originalGradientScore: 0.2,
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.1,
        suppressionGain: 0.3,
        source: 'standard'
    };
}

test('createAcceptedPipelineState should seed state from accepted initial selection', () => {
    const selectedTrial = {
        imageData: { id: 'selected-image' },
        originalSpatialScore: 0.61,
        originalGradientScore: 0.22
    };
    const initialSelection = {
        selectedTrial,
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        position: { x: 10, y: 20, width: 96, height: 96 },
        alphaMap: { id: 'alpha-96' },
        source: 'standard+catalog',
        adaptiveConfidence: 0.7,
        templateWarp: { dx: 1, dy: 0, scale: 1 },
        alphaGain: 0.85,
        decisionTier: 'direct-match'
    };

    const state = createAcceptedPipelineState({ initialSelection });

    assert.equal(state.finalImageData, selectedTrial.imageData);
    assert.equal(state.originalSpatialScore, 0.61);
    assert.equal(state.originalGradientScore, 0.22);
    assert.equal(state.alphaGain, 0.85);
    assert.equal(state.source, 'standard+catalog');
    assert.equal(state.subpixelShift, null);
    assert.equal(state.alphaMapSource, null);
});

test('createAcceptedPipelineState should return null for skipped initial selection', () => {
    assert.equal(createAcceptedPipelineState({
        initialSelection: { selectedTrial: null, source: 'skipped' }
    }), null);
});

test('createPipelineStateCommit should apply a scored result onto current state', () => {
    const next = createPipelineStateCommit({
        current: createCurrentState(),
        result: {
            imageData: { id: 'after-image' },
            alphaGain: 0.8,
            spatialScore: 0.12,
            gradientScore: 0.03,
            suppressionGain: 0.58
        },
        source: 'standard+fine-alpha'
    });

    assert.deepEqual(next.finalImageData, { id: 'after-image' });
    assert.equal(next.alphaGain, 0.8);
    assert.equal(next.finalProcessedSpatialScore, 0.12);
    assert.equal(next.finalProcessedGradientScore, 0.03);
    assert.equal(next.suppressionGain, 0.58);
    assert.equal(next.source, 'standard+fine-alpha');
    assert.deepEqual(next.alphaMap, { id: 'before-alpha' });
});

test('createPipelineStateCommit should support processed score aliases and derive suppression gain', () => {
    const next = createPipelineStateCommit({
        current: createCurrentState(),
        result: {
            imageData: { id: 'after-image' },
            processedSpatialScore: 0.2,
            processedGradientScore: 0.04
        }
    });

    assert.equal(next.finalProcessedSpatialScore, 0.2);
    assert.equal(next.finalProcessedGradientScore, 0.04);
    assert.ok(Math.abs(next.suppressionGain - 0.5) < 1e-12);
    assert.equal(next.source, 'standard');
});

test('createPipelineStateCommit should carry geometry and original score updates when present', () => {
    const next = createPipelineStateCommit({
        current: createCurrentState(),
        result: {
            alphaMap: { id: 'after-alpha' },
            position: { x: 10, y: 20, width: 96, height: 96 },
            config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
            alphaMapSource: 'variant-96',
            originalSpatialScore: 0.9,
            originalGradientScore: 0.31,
            spatialScore: 0.1,
            gradientScore: 0.02
        },
        source: 'standard+relocated'
    });

    assert.deepEqual(next.alphaMap, { id: 'after-alpha' });
    assert.deepEqual(next.position, { x: 10, y: 20, width: 96, height: 96 });
    assert.deepEqual(next.config, { logoSize: 96, marginRight: 64, marginBottom: 64 });
    assert.equal(next.alphaMapSource, 'variant-96');
    assert.equal(next.originalSpatialScore, 0.9);
    assert.equal(next.originalGradientScore, 0.31);
    assert.equal(next.suppressionGain, 0.8);
    assert.equal(next.source, 'standard+relocated');
});

test('createInitialPipelineRuntimeState should combine accepted state and processed metrics', () => {
    const acceptedState = {
        ...createCurrentState(),
        finalImageData: { id: 'selected-image' },
        originalSpatialScore: 0.72,
        originalGradientScore: 0.31,
        source: 'standard+catalog'
    };
    const state = createInitialPipelineRuntimeState({
        acceptedState,
        processedMetrics: {
            spatialScore: 0.18,
            gradientScore: 0.04
        }
    });

    assert.equal(state.finalImageData.id, 'selected-image');
    assert.equal(state.alphaMapSource, 'embedded-48');
    assert.equal(state.finalProcessedSpatialScore, 0.18);
    assert.equal(state.finalProcessedGradientScore, 0.04);
    assert.ok(Math.abs(state.suppressionGain - 0.54) < 1e-12);
    assert.equal(state.source, 'standard+catalog');
});

test('createPipelineStateAccessors should read and apply pipeline state fields', () => {
    let localState = {
        ...createCurrentState(),
        ignoredField: 'keep-local'
    };
    const appliedStates = [];
    const accessors = createPipelineStateAccessors({
        get: () => localState,
        set: (state) => {
            appliedStates.push(state);
            localState = { ...localState, ...state };
        }
    });

    const read = accessors.readPipelineState();
    assert.equal(read.finalImageData.id, 'before-image');
    assert.equal(read.alphaMapSource, 'embedded-48');
    assert.equal(Object.hasOwn(read, 'ignoredField'), false);

    accessors.applyPipelineState({
        finalImageData: { id: 'after-image' },
        alphaMap: { id: 'after-alpha' },
        position: { x: 3, y: 4, width: 96, height: 96 },
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        alphaGain: 0.9,
        alphaMapSource: 'variant-96',
        originalSpatialScore: 0.8,
        originalGradientScore: 0.3,
        finalProcessedSpatialScore: 0.1,
        finalProcessedGradientScore: 0.02,
        suppressionGain: 0.7,
        source: 'standard+variant'
    });

    assert.equal(appliedStates.length, 1);
    assert.equal(localState.finalImageData.id, 'after-image');
    assert.equal(localState.alphaMapSource, 'variant-96');
    assert.equal(localState.ignoredField, 'keep-local');
});
