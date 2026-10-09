import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createRepairTrialContractSummary,
    createRepairTrialFromStages
} from '../../src/core/pipelineRepairTrial.js';

test('createRepairTrialFromStages should return none when no repair stages are present', () => {
    const alphaTrial = { id: 'alpha:48/32/32:80,80,48,48:standard:1' };

    const repairTrial = createRepairTrialFromStages({
        alphaTrial,
        source: 'standard',
        alphaAdjustmentStages: [
            'weak-positive-residual-fine-alpha',
            { stage: 'new-margin-96-variant-rescue' }
        ]
    });

    assert.deepEqual(repairTrial, {
        id: 'alpha:48/32/32:80,80,48,48:standard:1:repair:none',
        alphaTrialId: alphaTrial.id,
        source: null,
        repairType: 'none',
        applied: false,
        params: null,
        scores: null,
        artifacts: null,
        gates: null,
        provenance: null
    });
});

test('createRepairTrialFromStages should map repair stages and infer strategies', () => {
    const alphaTrial = { id: 'alpha:48/32/32:80,80,48,48:standard:0.85' };
    const residualVisibility = { visible: false, score: 0.04 };

    const repairTrial = createRepairTrialFromStages({
        alphaTrial,
        source: 'standard+gain+luma-edge',
        alphaAdjustmentStages: [
            {
                stage: 'weak-positive-residual-fine-alpha',
                fromAlphaGain: 1,
                toAlphaGain: 0.85,
                alphaStrategy: 'over-subtraction-fine-alpha'
            },
            {
                stage: 'known-48-luma-edge-cleanup',
                fromAlphaGain: 0.85,
                toAlphaGain: 0.85,
                beforeSpatialScore: 0.08,
                beforeGradientScore: Number.NaN,
                afterSpatialScore: 0.04,
                afterGradientScore: 0.03,
                suppressionGain: 0.04,
                cost: 0.1
            },
            {
                stage: 'known-48-flat-background-fill',
                repairStrategy: 'custom-flat-fill',
                fromAlphaGain: 0.85,
                toAlphaGain: 0.85
            }
        ],
        processedSpatialScore: 0.04,
        processedGradientScore: 0.03,
        suppressionGain: 0.76,
        residualVisibility
    });

    assert.equal(
        repairTrial.id,
        'alpha:48/32/32:80,80,48,48:standard:0.85:repair:known-48-luma-edge-cleanup+known-48-flat-background-fill'
    );
    assert.equal(repairTrial.alphaTrialId, alphaTrial.id);
    assert.equal(repairTrial.source, 'standard+gain+luma-edge');
    assert.equal(repairTrial.repairType, 'known-48-flat-fill');
    assert.equal(repairTrial.applied, true);
    assert.deepEqual(repairTrial.params, [
        {
            stage: 'known-48-luma-edge-cleanup',
            repairStrategy: 'luma-edge',
            fromAlphaGain: 0.85,
            toAlphaGain: 0.85,
            beforeSpatialScore: 0.08,
            afterSpatialScore: 0.04,
            afterGradientScore: 0.03,
            suppressionGain: 0.04,
            cost: 0.1
        },
        {
            stage: 'known-48-flat-background-fill',
            repairStrategy: 'custom-flat-fill',
            fromAlphaGain: 0.85,
            toAlphaGain: 0.85
        }
    ]);
    assert.deepEqual(repairTrial.scores, {
        processedSpatial: 0.04,
        processedGradient: 0.03,
        suppressionGain: 0.76
    });
    assert.equal(repairTrial.artifacts, residualVisibility);
    assert.deepEqual(repairTrial.gates, {
        stageCount: 2,
        stages: ['known-48-luma-edge-cleanup', 'known-48-flat-background-fill']
    });
    assert.deepEqual(repairTrial.provenance, {
        stageCount: 2,
        strategies: ['luma-edge', 'custom-flat-fill']
    });
});

test('createRepairTrialContractSummary should expose repair contract fields', () => {
    const repairTrial = createRepairTrialFromStages({
        alphaTrial: { id: 'alpha:48/32/32:80,80,48,48:standard:1' },
        source: 'standard+repair',
        alphaAdjustmentStages: [
            { stage: 'known-48-mid-core-bias-correction' }
        ]
    });

    assert.deepEqual(createRepairTrialContractSummary(repairTrial), {
        id: 'alpha:48/32/32:80,80,48,48:standard:1:repair:known-48-mid-core-bias-correction',
        alphaTrialId: 'alpha:48/32/32:80,80,48,48:standard:1',
        source: 'standard+repair',
        repairType: 'mid-core-bias-correction',
        applied: true,
        stageCount: 1,
        strategyCount: 1
    });
});
