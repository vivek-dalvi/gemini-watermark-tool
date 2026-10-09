import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createDetectionCandidateContractSummary,
    createDetectionCandidateFromSelectedTrial,
    createRejectedDetectionCandidate
} from '../../src/core/pipelineDetectionCandidate.js';

test('createDetectionCandidateFromSelectedTrial should map accepted detection evidence', () => {
    const selectedTrial = {
        source: 'standard+catalog',
        config: {
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192,
            alphaVariant: '20260520'
        },
        position: { x: 736, y: 736, width: 96, height: 96 },
        originalSpatialScore: 0.8,
        originalGradientScore: 0.72,
        adaptiveConfidence: 0.9,
        provenance: {
            catalogVariant: true,
            darkPolarity: true
        },
        originalEvidence: { tier: 3 }
    };

    const candidate = createDetectionCandidateFromSelectedTrial({
        selectedTrial,
        source: 'standard+catalog',
        decisionTier: 'direct-match'
    });

    assert.equal(candidate.id, 'det:96/192/192/20260520:736,736,96,96:standard+catalog');
    assert.equal(candidate.source, 'standard+catalog');
    assert.equal(candidate.decisionTier, 'direct-match');
    assert.deepEqual(candidate.config, {
        logoSize: 96,
        marginRight: 192,
        marginBottom: 192,
        alphaVariant: '20260520'
    });
    assert.deepEqual(candidate.position, { x: 736, y: 736, width: 96, height: 96 });
    assert.equal(candidate.alphaMapHint, '96-20260520');
    assert.equal(candidate.polarityHint, 'dark');
    assert.deepEqual(candidate.evidence, {
        spatialScore: 0.8,
        gradientScore: 0.72,
        confidence: 0.9,
        productionEvidence: true,
        originalEvidenceTier: 3
    });
    assert.equal(candidate.provenance, selectedTrial.provenance);
});

test('createRejectedDetectionCandidate should map skipped evidence', () => {
    const candidate = createRejectedDetectionCandidate({
        reason: 'no-watermark-detected',
        source: 'skipped',
        decisionTier: 'insufficient',
        originalSpatialScore: 0.08,
        originalGradientScore: 0.04,
        adaptiveConfidence: 0.2
    });

    assert.equal(candidate.id, 'det:rejected:no-watermark-detected');
    assert.equal(candidate.source, 'skipped');
    assert.equal(candidate.decisionTier, 'insufficient');
    assert.equal(candidate.config, null);
    assert.equal(candidate.position, null);
    assert.equal(candidate.alphaMapHint, null);
    assert.equal(candidate.polarityHint, null);
    assert.deepEqual(candidate.evidence, {
        spatialScore: 0.08,
        gradientScore: 0.04,
        confidence: 0.2,
        productionEvidence: false,
        originalEvidenceTier: null
    });
    assert.equal(candidate.provenance, null);
});

test('createDetectionCandidateContractSummary should expose detection contract flags', () => {
    const candidate = createDetectionCandidateFromSelectedTrial({
        selectedTrial: {
            source: 'standard',
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            position: { x: 80, y: 80, width: 48, height: 48 },
            originalSpatialScore: 0.7,
            originalGradientScore: 0.2
        },
        decisionTier: 'direct-match'
    });

    assert.deepEqual(createDetectionCandidateContractSummary(candidate), {
        id: 'det:48/32/32:80,80,48,48:standard',
        source: 'standard',
        decisionTier: 'direct-match',
        hasConfig: true,
        hasPosition: true,
        productionEvidence: true
    });
});
