import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAcceptedDecisionPath,
    createDecisionPathContractSummary,
    createRejectedDecisionPath
} from '../../src/core/pipelineDecisionPath.js';

test('createAcceptedDecisionPath should assemble accepted layered decision path', () => {
    const selectedTrial = {
        source: 'standard+catalog',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        },
        position: { x: 736, y: 736, width: 96, height: 96 },
        alphaGain: 1,
        originalSpatialScore: 0.8,
        originalGradientScore: 0.72,
        processedSpatialScore: 0.12,
        processedGradientScore: 0.08,
        improvement: 0.68,
        provenance: { catalogVariant: true, alphaVariant: '20260520' },
        originalEvidence: { tier: 3 },
        residual: { cleared: true, score: 0.12 },
        damage: { safe: true, penalty: 0.01 },
        evaluation: {
            eligible: true,
            riskFlags: ['sample-risk-flag'],
            gates: { originalEvidenceAllowed: true }
        }
    };

    const decisionPath = createAcceptedDecisionPath({
        selectedTrial,
        selectionSource: 'standard+catalog',
        source: 'standard+catalog+gain+luma-edge',
        decisionTier: 'direct-match',
        config: selectedTrial.config,
        position: selectedTrial.position,
        alphaGain: 0.85,
        alphaAdjustmentStages: [
            {
                stage: 'weak-positive-residual-fine-alpha',
                fromAlphaGain: 1,
                toAlphaGain: 0.85,
                alphaStrategy: 'over-subtraction-fine-alpha'
            },
            { stage: 'known-48-luma-edge-cleanup', fromAlphaGain: 0.85, toAlphaGain: 0.85, cost: 0.1 }
        ],
        alphaTrialEvents: [
            {
                stage: 'weak-positive-residual-fine-alpha',
                strategy: 'over-subtraction-fine-alpha',
                decision: 'accept',
                alphaGain: 0.85
            }
        ],
        processedSpatialScore: 0.04,
        processedGradientScore: 0.03,
        suppressionGain: 0.76
    });

    assert.equal(decisionPath.version, 1);
    assert.equal(decisionPath.decision, 'accept');
    assert.equal(decisionPath.detectionSource, 'standard+catalog');
    assert.equal(decisionPath.alphaSource, 'standard+catalog+gain+luma-edge');
    assert.equal(decisionPath.repairSource, 'standard+catalog+gain+luma-edge');
    assert.equal(decisionPath.evaluationDecision, 'accepted');
    assert.deepEqual(decisionPath.riskFlags, ['sample-risk-flag']);
    assert.equal(decisionPath.detectionCandidate.id, 'det:96/192/192/20260520:736,736,96,96:standard+catalog');
    assert.equal(decisionPath.alphaTrial.strategy, 'over-subtraction-fine-alpha');
    assert.equal(decisionPath.repairTrial.repairType, 'luma-edge');
    assert.equal(
        decisionPath.evaluation.pathId,
        `${decisionPath.detectionCandidate.id}->${decisionPath.alphaTrial.id}->${decisionPath.repairTrial.id}`
    );
    assert.deepEqual(decisionPath.evaluation.finalScores, {
        originalSpatial: 0.8,
        originalGradient: 0.72,
        processedSpatial: 0.04,
        processedGradient: 0.03,
        suppressionGain: 0.76
    });
});

test('createRejectedDecisionPath should assemble rejected decision path', () => {
    const decisionPath = createRejectedDecisionPath({
        reason: 'no-watermark-detected',
        source: 'skipped',
        decisionTier: 'insufficient',
        originalSpatialScore: 0.08,
        originalGradientScore: 0.04,
        adaptiveConfidence: 0.2
    });

    assert.equal(decisionPath.version, 1);
    assert.equal(decisionPath.decision, 'reject');
    assert.equal(decisionPath.detectionSource, 'skipped');
    assert.equal(decisionPath.alphaSource, null);
    assert.equal(decisionPath.repairSource, null);
    assert.equal(decisionPath.evaluationDecision, 'rejected');
    assert.equal(decisionPath.blockedGate, 'no-watermark-detected');
    assert.equal(decisionPath.detectionCandidate.evidence.productionEvidence, false);
    assert.equal(decisionPath.alphaTrial, null);
    assert.equal(decisionPath.repairTrial, null);
    assert.deepEqual(decisionPath.evaluation, {
        pathId: 'det:rejected:no-watermark-detected->reject',
        detectionId: 'det:rejected:no-watermark-detected',
        alphaTrialId: null,
        repairTrialId: null,
        eligible: false,
        decision: 'reject',
        blockedGate: 'no-watermark-detected',
        riskFlags: [],
        evidenceClass: 'insufficient-production-evidence',
        explanation: 'no-watermark-detected'
    });
});

test('createDecisionPathContractSummary should expose decision path contract flags', () => {
    const rejectedPath = createRejectedDecisionPath({
        reason: 'no-watermark-detected',
        source: 'skipped'
    });

    assert.deepEqual(createDecisionPathContractSummary(rejectedPath), {
        version: 1,
        decision: 'reject',
        detectionSource: 'skipped',
        alphaSource: null,
        repairSource: null,
        evaluationDecision: 'rejected',
        blockedGate: 'no-watermark-detected',
        hasDetectionCandidate: true,
        hasAlphaTrial: false,
        hasRepairTrial: false
    });
});
