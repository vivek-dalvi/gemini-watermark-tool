import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAlphaRescueStageSequenceSpecs,
    createFineAlphaTrialSequenceSpecs,
    createLocatedAggressiveStageSpec,
    createRecalibrationStageSpec,
    createSmallAnchorAlphaStageSequenceSpecs,
    createSubpixelOutlineAlphaStageSpecs
} from '../../src/core/pipelineAlphaStageSpecs.js';
import {
    runCurrentAlphaStageSequence,
    runCurrentAlphaTrialSequence,
    runRecalibrationStage
} from '../../src/core/pipelineRuntime.js';

test('createFineAlphaTrialSequenceSpecs should build ordered dynamic alpha trial specs', () => {
    const debugTimings = {};
    const nowValues = [100, 104, 110, 116, 120, 127];
    let currentState = {
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    function makeRefiner(name) {
        return (payload) => {
            calls.push({
                name,
                source: payload.source,
                alphaMap: payload.alphaMap,
                alphaGain: payload.currentAlphaGain,
                nearBlackRatio: payload.originalNearBlackRatio
            });
            return {
                imageData: { id: `${name}-image` },
                alphaGain: payload.currentAlphaGain + 0.1,
                spatialScore: payload.currentSpatialScore - 0.01,
                gradientScore: payload.currentGradientScore - 0.01
            };
        };
    }

    const stages = createFineAlphaTrialSequenceSpecs({
        nowMs: () => nowValues.shift(),
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        calculateNearBlackRatio: () => 0.123,
        acceptCurrentAlphaTrialResult: (trial) => {
            accepted.push(trial);
            currentState = {
                ...currentState,
                alphaGain: trial.result.alphaGain,
                finalProcessedSpatialScore: trial.result.spatialScore,
                finalProcessedGradientScore: trial.result.gradientScore,
                source: trial.source
            };
        },
        debugTimings,
        debugTimingsEnabled: true,
        refiners: {
            recalibrateOverSubtractedAlpha: makeRefiner('over'),
            fineTuneDarkCatalogAlpha: makeRefiner('dark'),
            fineTuneWeakPositiveResidualAlpha: makeRefiner('weak')
        }
    });

    const results = runCurrentAlphaTrialSequence({ stages });

    assert.deepEqual(stages.map((stage) => stage.stage), [
        'over-subtraction-recalibration',
        'dark-catalog-fine-alpha',
        'weak-positive-residual-fine-alpha'
    ]);
    assert.equal(results.length, 3);
    assert.deepEqual(calls.map((call) => call.alphaGain), [
        1,
        1.1,
        1.2000000000000002
    ]);
    assert.deepEqual(calls.map((call) => call.source), [
        undefined,
        'standard+gain',
        undefined
    ]);
    assert.deepEqual(accepted.map((trial) => trial.source), [
        'standard+gain',
        'standard+gain+fine-alpha',
        'standard+gain+fine-alpha'
    ]);
    assert.deepEqual(debugTimings, {
        overSubtractionRecalibrationMs: 4,
        darkCatalogFineTuneMs: 6,
        weakAlphaFineTuneMs: 7
    });
    assert.ok(calls.every((call) => call.nearBlackRatio === 0.123));
});

test('createFineAlphaTrialSequenceSpecs should preserve existing source suffixes', () => {
    let currentState = {
        alphaMap: 'alpha-0',
        position: { x: 0, y: 0, width: 48, height: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard+gain+fine-alpha'
    };
    const accepted = [];
    const result = {
        imageData: { id: 'same' },
        alphaGain: 1,
        spatialScore: 0.4,
        gradientScore: 0.3
    };

    runCurrentAlphaTrialSequence({
        stages: createFineAlphaTrialSequenceSpecs({
            readState: () => currentState,
            originalImageData: { id: 'original' },
            originalSpatialScore: 0.8,
            originalGradientScore: 0.7,
            acceptCurrentAlphaTrialResult: (trial) => {
                accepted.push(trial);
                currentState = {
                    ...currentState,
                    source: trial.source
                };
            },
            refiners: {
                recalibrateOverSubtractedAlpha: () => result,
                fineTuneDarkCatalogAlpha: () => result,
                fineTuneWeakPositiveResidualAlpha: () => result
            }
        })
    });

    assert.deepEqual(accepted.map((trial) => trial.source), [
        'standard+gain+fine-alpha',
        'standard+gain+fine-alpha',
        'standard+gain+fine-alpha'
    ]);
});

test('createRecalibrationStageSpec should build gated dynamic recalibration spec', () => {
    const debugTimings = {};
    const nowValues = [100, 111];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        originalSpatialScore: 0.8,
        finalProcessedSpatialScore: 0.55,
        suppressionGain: 0.1
    };
    const calls = [];
    const accepted = [];
    const result = {
        imageData: { id: 'recalibrated' },
        processedSpatialScore: 0.12,
        alphaGain: 0.85,
        suppressionGain: 0.68
    };

    const spec = createRecalibrationStageSpec({
        nowMs: () => nowValues.shift(),
        readState: () => currentState,
        shouldRecalibrateAlphaStrength: (payload) => {
            calls.push({
                name: 'gate',
                originalScore: payload.originalScore,
                processedScore: payload.processedScore,
                suppressionGain: payload.suppressionGain
            });
            return true;
        },
        calculateNearBlackRatio: (imageData, position) => {
            calls.push({
                name: 'near-black',
                imageId: imageData?.id,
                positionWidth: position?.width
            });
            return 0.123;
        },
        computeRegionGradientCorrelation: (payload) => {
            calls.push({
                name: 'gradient',
                imageId: payload.imageData?.id,
                alphaMap: payload.alphaMap,
                region: payload.region
            });
            return 0.06;
        },
        acceptRecalibrationStageResult: (stage) => accepted.push(stage),
        debugTimings,
        debugTimingsEnabled: true,
        refiners: {
            recalibrateAlphaStrength: (payload) => {
                calls.push({
                    name: 'recalibrate',
                    imageId: payload.sourceImageData?.id,
                    alphaMap: payload.alphaMap,
                    processedSpatialScore: payload.processedSpatialScore,
                    originalNearBlackRatio: payload.originalNearBlackRatio
                });
                return result;
            }
        }
    });

    currentState = {
        ...currentState,
        finalImageData: { id: 'image-1' },
        alphaMap: 'alpha-1',
        finalProcessedSpatialScore: 0.5
    };
    const returned = runRecalibrationStage(spec);

    assert.equal(spec.shouldRun, true);
    assert.equal(returned, result);
    assert.deepEqual(accepted, [{
        result,
        gradientScore: 0.06
    }]);
    assert.deepEqual(debugTimings, {
        recalibrationMs: 11
    });
    assert.deepEqual(calls, [
        {
            name: 'gate',
            originalScore: 0.8,
            processedScore: 0.55,
            suppressionGain: 0.1
        },
        {
            name: 'near-black',
            imageId: 'image-1',
            positionWidth: 48
        },
        {
            name: 'recalibrate',
            imageId: 'image-1',
            alphaMap: 'alpha-1',
            processedSpatialScore: 0.5,
            originalNearBlackRatio: 0.123
        },
        {
            name: 'gradient',
            imageId: 'recalibrated',
            alphaMap: 'alpha-1',
            region: {
                x: 1,
                y: 2,
                size: 48
            }
        }
    ]);
});

test('createRecalibrationStageSpec should skip creation when recalibration gate is false', () => {
    const accepted = [];
    const spec = createRecalibrationStageSpec({
        readState: () => ({
            finalImageData: { id: 'image-0' },
            alphaMap: 'alpha-0',
            position: { x: 0, y: 0, width: 48, height: 48 },
            originalSpatialScore: 0.2,
            finalProcessedSpatialScore: 0.1,
            suppressionGain: 0.4
        }),
        shouldRecalibrateAlphaStrength: () => false,
        acceptRecalibrationStageResult: (stage) => accepted.push(stage),
        refiners: {
            recalibrateAlphaStrength: () => {
                throw new Error('should not run');
            }
        }
    });

    assert.equal(spec.shouldRun, false);
    assert.equal(runRecalibrationStage(spec), null);
    assert.deepEqual(accepted, []);
});

test('createAlphaRescueStageSequenceSpecs should build ordered dynamic alpha rescue specs', () => {
    const timingAnchors = {};
    const nowValues = [200, 210, 220, 230];
    let variantResolved = false;
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    function makeRefiner(name) {
        return (payload) => {
            calls.push({
                name,
                imageId: payload.currentImageData?.id,
                alphaGain: payload.currentAlphaGain,
                variantAlphaMap: payload.variantAlphaMap
            });
            return {
                imageData: { id: `${name}-image` },
                alphaGain: (payload.currentAlphaGain ?? currentState.alphaGain) + 0.1,
                spatialScore: payload.currentSpatialScore - 0.01,
                gradientScore: payload.currentGradientScore - 0.01,
                profileExponent: calls.length
            };
        };
    }

    const stages = createAlphaRescueStageSequenceSpecs({
        nowMs: () => nowValues.shift(),
        timingAnchors,
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        resolveVariantAlphaMap: () => {
            variantResolved = true;
            return 'variant-alpha';
        },
        acceptCurrentAlphaStageResult: (stage) => {
            accepted.push(stage);
            currentState = {
                ...currentState,
                finalImageData: stage.result.imageData,
                alphaGain: stage.result.alphaGain,
                finalProcessedSpatialScore: stage.result.spatialScore,
                finalProcessedGradientScore: stage.result.gradientScore,
                source: stage.source
            };
        },
        refiners: {
            refineNewMargin96VariantResidual: makeRefiner('new-margin'),
            refineKnown48AntiTemplateResidual: makeRefiner('anti-template'),
            refineKnown48PowerProfileResidual: makeRefiner('power'),
            refineKnown48PositiveResidualRebalance: makeRefiner('rebalance')
        }
    });

    const results = runCurrentAlphaStageSequence({ stages });

    assert.equal(variantResolved, true);
    assert.deepEqual(stages.map((stage) => stage.stage), [
        'new-margin-96-variant-rescue',
        'known-48-anti-template-rescue',
        'known-48-power-profile-rescue',
        'known-48-positive-residual-rebalance'
    ]);
    assert.equal(results.length, 4);
    assert.deepEqual(timingAnchors, {
        newMargin96VariantRescueStartedAt: 200,
        known48AntiTemplateRescueStartedAt: 210,
        powerProfileRescueStartedAt: 220,
        positiveResidualRebalanceStartedAt: 230
    });
    assert.deepEqual(calls.map((call) => call.imageId), [
        'image-0',
        'new-margin-image',
        'anti-template-image',
        'power-image'
    ]);
    assert.deepEqual(accepted.map((stage) => stage.source), [
        'standard+new-margin-variant',
        'standard+new-margin-variant+anti-template-rescue',
        'standard+new-margin-variant+anti-template-rescue+power-profile-rescue',
        'standard+new-margin-variant+anti-template-rescue+power-profile-rescue+residual-rebalance'
    ]);
    assert.deepEqual(accepted.map((stage) => stage.stageExtras), [
        { profileExponent: 1 },
        { allowSameAlphaGain: true },
        { profileExponent: 3, allowSameAlphaGain: true },
        { profileExponent: 4, allowSameAlphaGain: true }
    ]);
    assert.equal(calls[0].variantAlphaMap, 'variant-alpha');
});

test('createSmallAnchorAlphaStageSequenceSpecs should build dynamic small-anchor alpha specs', () => {
    const timingAnchors = {};
    const nowValues = [300];
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48 },
        finalProcessedSpatialScore: 0.4,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1,
        source: 'standard'
    };
    const calls = [];
    const accepted = [];

    const stages = createSmallAnchorAlphaStageSequenceSpecs({
        nowMs: () => nowValues.shift(),
        timingAnchors,
        readState: () => currentState,
        originalImageData: { id: 'original', width: 200, height: 120 },
        originalGradientScore: 0.7,
        alpha96: 'alpha-96',
        getAlphaMap: () => 'resolved-alpha',
        visualPostProcessingEnabled: true,
        assessWatermarkResidualVisibility: (payload) => {
            calls.push({
                name: 'visibility',
                imageId: payload.imageData?.id,
                positionWidth: payload.position?.width
            });
            return { visible: true };
        },
        acceptCurrentAlphaStageResult: (stage) => {
            accepted.push(stage);
            currentState = {
                ...currentState,
                finalImageData: stage.result.imageData,
                position: stage.result.position ?? currentState.position,
                config: stage.result.config ?? currentState.config,
                finalProcessedSpatialScore: stage.result.spatialScore ?? currentState.finalProcessedSpatialScore,
                finalProcessedGradientScore: stage.result.gradientScore ?? currentState.finalProcessedGradientScore,
                source: stage.source
            };
        },
        refiners: {
            refineSmallPreviewAnchorCandidate: (payload) => {
                calls.push({
                    name: 'small-preview',
                    source: payload.source,
                    positionWidth: payload.position?.width
                });
                return {
                    imageData: { id: 'preview-image' },
                    position: { x: 10, y: 20, width: 36, height: 36 },
                    spatialScore: 0.3,
                    gradientScore: 0.2
                };
            },
            refineSmallFixedLocalAnchorGeometry: (payload) => {
                calls.push({
                    name: 'small-fixed',
                    source: payload.currentSource,
                    positionWidth: payload.currentPosition?.width,
                    visible: payload.currentResidualVisibility?.visible
                });
                return {
                    imageData: { id: 'fixed-image' },
                    position: { x: 11, y: 21, width: 36, height: 36 },
                    spatialScore: 0.25,
                    gradientScore: 0.18,
                    residualVisibility: { visible: true }
                };
            }
        }
    });

    const results = runCurrentAlphaStageSequence({ stages });

    assert.deepEqual(stages.map((stage) => stage.stage), [
        'small-preview-refinement',
        'small-fixed-local-anchor-relocation'
    ]);
    assert.deepEqual(timingAnchors, {
        smallPreviewRefinementStartedAt: 300
    });
    assert.equal(results[1].residualVisibility.visible, true);
    assert.deepEqual(calls, [
        {
            name: 'small-preview',
            source: 'standard',
            positionWidth: 48
        },
        {
            name: 'visibility',
            imageId: 'preview-image',
            positionWidth: 36
        },
        {
            name: 'small-fixed',
            source: 'standard+small-preview-refine',
            positionWidth: 36,
            visible: true
        }
    ]);
    assert.deepEqual(accepted.map((stage) => stage.source), [
        'standard+small-preview-refine',
        'standard+small-preview-refine+small-anchor-relocated'
    ]);
    assert.deepEqual(accepted[0].result.config, {
        logoSize: 36,
        marginRight: 154,
        marginBottom: 64
    });
    assert.deepEqual(accepted[1].stageExtras, {
        allowSameAlphaGain: true
    });
});

test('createSubpixelOutlineAlphaStageSpecs should build gated subpixel alpha specs', () => {
    const currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        finalProcessedSpatialScore: 0.2,
        finalProcessedGradientScore: 0.5,
        alphaGain: 1,
        source: 'standard'
    };
    const accepted = [];
    const calls = [];
    const result = {
        imageData: { id: 'subpixel-image' },
        shift: { dx: 0.25, dy: 0, scale: 1 },
        spatialScore: 0.1,
        gradientScore: 0.2
    };

    const stages = createSubpixelOutlineAlphaStageSpecs({
        readState: () => currentState,
        calculateNearBlackRatio: () => 0.123,
        templateWarp: { dx: 0.1, dy: -0.1, scale: 0.99 },
        visualPostProcessingEnabled: true,
        usePreviewAnchorFastCleanup: false,
        outlineConfig: {
            outlineRefinementThreshold: 0.42,
            outlineRefinementMinGain: 1.2,
            subpixelRefineShifts: [-0.25, 0, 0.25],
            subpixelRefineScales: [0.99, 1, 1.01],
            minGradientImprovement: 0.04,
            maxSpatialDrift: 0.08
        },
        acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
        refiners: {
            refineSubpixelOutline: (payload) => {
                calls.push(payload);
                return result;
            }
        }
    });

    const results = runCurrentAlphaStageSequence({ stages });

    assert.deepEqual(stages.map((stage) => stage.stage), [
        'subpixel-outline-refinement'
    ]);
    assert.deepEqual(results, [result]);
    assert.equal(calls[0].sourceImageData, currentState.finalImageData);
    assert.equal(calls[0].alphaMap, 'alpha-0');
    assert.equal(calls[0].originalNearBlackRatio, 0.123);
    assert.deepEqual(calls[0].baselineShift, {
        dx: 0.1,
        dy: -0.1,
        scale: 0.99
    });
    assert.deepEqual(calls[0].shiftCandidates, [-0.25, 0, 0.25]);
    assert.deepEqual(accepted, [{
        stage: 'subpixel-outline-refinement',
        strategy: null,
        result,
        source: 'standard+subpixel',
        suppressionGain: null,
        stageExtras: undefined
    }]);
});

test('createSubpixelOutlineAlphaStageSpecs should skip unsafe subpixel gates', () => {
    const accepted = [];
    const stages = createSubpixelOutlineAlphaStageSpecs({
        readState: () => ({
            finalImageData: { id: 'image-0' },
            alphaMap: 'alpha-0',
            position: { x: 0, y: 0, width: 48, height: 48 },
            finalProcessedSpatialScore: 0.31,
            finalProcessedGradientScore: 0.5,
            alphaGain: 1,
            source: 'standard'
        }),
        visualPostProcessingEnabled: true,
        outlineConfig: {
            outlineRefinementThreshold: 0.42
        },
        acceptCurrentAlphaStageResult: (stage) => accepted.push(stage),
        refiners: {
            refineSubpixelOutline: () => {
                throw new Error('should not run');
            }
        }
    });

    assert.deepEqual(runCurrentAlphaStageSequence({ stages }), [null]);
    assert.deepEqual(accepted, []);
});

test('createLocatedAggressiveStageSpec should build gated aggressive removal spec', () => {
    let currentState = {
        finalImageData: { id: 'image-0' },
        alphaMap: 'alpha-0',
        position: { x: 1, y: 2, width: 48, height: 48 },
        config: { logoSize: 48 },
        finalProcessedSpatialScore: 0.28,
        finalProcessedGradientScore: 0.35,
        alphaGain: 1.1,
        source: 'standard'
    };
    const passState = {
        passCount: 1,
        attemptedPassCount: 1,
        passStopReason: 'single-pass',
        passes: []
    };
    const calls = [];
    const rejectedEvents = [];
    const acceptedPayloads = [];
    const result = {
        imageData: { id: 'aggressive-image' },
        spatialScore: 0.1,
        gradientScore: 0.08,
        alphaGain: 1.3
    };

    const spec = createLocatedAggressiveStageSpec({
        readState: () => currentState,
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        smallFixedLocalRelocated: {
            residualVisibility: { visible: true }
        },
        locatedAggressiveRemovalEnabled: true,
        assessWatermarkResidualVisibility: (payload) => {
            calls.push({
                name: 'visibility',
                imageId: payload.imageData?.id,
                alphaMap: payload.alphaMap,
                positionWidth: payload.position?.width
            });
            return { visible: true };
        },
        shouldSkipLocatedAggressiveForCleanCanonical96: (payload) => {
            calls.push({
                name: 'skip-clean-canonical',
                logoSize: payload.config?.logoSize,
                alphaGain: payload.alphaGain,
                currentSpatialScore: payload.currentSpatialScore,
                currentGradientScore: payload.currentGradientScore
            });
            return false;
        },
        recordAlphaTrialEvent: (event) => rejectedEvents.push(event),
        acceptLocatedAggressiveResult: (payload) => acceptedPayloads.push(payload),
        currentPassState: passState,
        refiners: {
            refineLocatedAggressiveRemoval: (payload) => {
                calls.push({
                    name: 'aggressive',
                    imageId: payload.currentImageData?.id,
                    alphaMap: payload.alphaMap,
                    alphaGain: payload.currentAlphaGain,
                    currentSpatialScore: payload.currentSpatialScore,
                    currentGradientScore: payload.currentGradientScore
                });
                payload.onRejected({
                    strategy: 'located-aggressive-alpha',
                    blockedGate: 'artifact-risk'
                });
                return result;
            }
        }
    });

    currentState = {
        ...currentState,
        finalImageData: { id: 'image-1' },
        alphaMap: 'alpha-1',
        finalProcessedSpatialScore: 0.25,
        finalProcessedGradientScore: 0.3,
        alphaGain: 1.2
    };
    const stageResult = spec.createStage({
        onRejected: (event) => rejectedEvents.push({
            ...event,
            decision: 'reject'
        })
    });

    assert.equal(spec.shouldRun, true);
    assert.equal(stageResult, result);
    assert.equal(spec.currentPassState, passState);
    assert.equal(spec.fromAlphaGain, 1.1);
    assert.equal(spec.beforeSpatialScore, 0.28);
    assert.equal(spec.beforeGradientScore, 0.35);
    assert.equal(spec.originalSpatialScore, 0.8);
    assert.equal(spec.source(), 'standard+located-aggressive');
    assert.equal(typeof spec.recordAlphaTrialEvent, 'function');
    assert.equal(typeof spec.acceptLocatedAggressiveResult, 'function');
    assert.deepEqual(calls, [
        {
            name: 'visibility',
            imageId: 'image-0',
            alphaMap: 'alpha-0',
            positionWidth: 48
        },
        {
            name: 'skip-clean-canonical',
            logoSize: 48,
            alphaGain: 1.1,
            currentSpatialScore: 0.28,
            currentGradientScore: 0.35
        },
        {
            name: 'aggressive',
            imageId: 'image-1',
            alphaMap: 'alpha-1',
            alphaGain: 1.2,
            currentSpatialScore: 0.25,
            currentGradientScore: 0.3
        }
    ]);
    assert.deepEqual(rejectedEvents, [{
        strategy: 'located-aggressive-alpha',
        blockedGate: 'artifact-risk',
        decision: 'reject'
    }]);
});

test('createLocatedAggressiveStageSpec should skip hidden relocated residuals and preserve existing suffix', () => {
    const spec = createLocatedAggressiveStageSpec({
        readState: () => ({
            finalImageData: { id: 'image-0' },
            alphaMap: 'alpha-0',
            position: { x: 0, y: 0, width: 48, height: 48 },
            config: { logoSize: 48 },
            finalProcessedSpatialScore: 0.2,
            finalProcessedGradientScore: 0.1,
            alphaGain: 1,
            source: 'standard+located-aggressive'
        }),
        originalImageData: { id: 'original' },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.7,
        smallFixedLocalRelocated: {
            residualVisibility: { visible: false }
        },
        locatedAggressiveRemovalEnabled: true,
        assessWatermarkResidualVisibility: () => ({ visible: true }),
        shouldSkipLocatedAggressiveForCleanCanonical96: () => {
            throw new Error('should not evaluate later gates');
        },
        refiners: {
            refineLocatedAggressiveRemoval: () => {
                throw new Error('should not run');
            }
        }
    });

    assert.equal(spec.shouldRun, false);
    assert.equal(spec.source(), 'standard+located-aggressive');
});
