import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
    analyzeResidualBands,
    applyQuantizedBodyResidualCorrection,
    classifyEdgeStructureRisk,
    classifyResidualCorrectionSafety,
    classifyResidualProfile,
    measureAlphaEdgeStructureOverlap,
    selectResidualProfileRecords,
    shouldApplyQuantizedBodyCorrection,
    summarizeResidualProfileRecords
} from '../../scripts/probe-metric-48-96-96-residual-profile.js';

function createImageData(width, height, fill) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
        const value = typeof fill === 'function' ? fill(index / 4) : fill;
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
    }
    return { width, height, data };
}

test('analyzeResidualBands should measure signed residuals by alpha band', () => {
    const imageData = createImageData(2, 2, (pixel) => [100, 96, 90, 80][pixel]);
    const priorImageData = createImageData(2, 2, 100);
    const alphaMap = new Float32Array([0.01, 0.06, 0.2, 0.4]);

    const bands = analyzeResidualBands({
        imageData,
        priorImageData,
        alphaMap,
        position: { x: 0, y: 0, width: 2, height: 2 },
        bands: [
            { key: 'low', minAlpha: 0, maxAlpha: 0.04 },
            { key: 'mid', minAlpha: 0.04, maxAlpha: 0.28 },
            { key: 'body', minAlpha: 0.28, maxAlpha: 1 }
        ]
    });

    assert.deepEqual(bands.map((band) => ({
        key: band.key,
        count: band.count,
        meanResidual: band.meanResidual,
        meanAbsResidual: band.meanAbsResidual,
        negativeRatio: band.negativeRatio
    })), [
        { key: 'low', count: 1, meanResidual: 0, meanAbsResidual: 0, negativeRatio: 0 },
        { key: 'mid', count: 2, meanResidual: -7, meanAbsResidual: 7, negativeRatio: 1 },
        { key: 'body', count: 1, meanResidual: -20, meanAbsResidual: 20, negativeRatio: 1 }
    ]);
});

test('classifyResidualProfile should separate unreliable structured priors from over-subtracted body residuals', () => {
    assert.deepEqual(
        classifyResidualProfile({
            bands: [
                { key: 'low', meanAbsResidual: 24, meanResidual: 10, count: 20 },
                { key: 'body', meanResidual: 32, negativeRatio: 0.1, positiveRatio: 0.8, count: 20 }
            ]
        }),
        {
            label: 'structured-prior-unreliable',
            priorReliable: false,
            reason: 'low-alpha-band-does-not-match-neighborhood-prior'
        }
    );

    assert.deepEqual(
        classifyResidualProfile({
            bands: [
                { key: 'low', meanAbsResidual: 0.6, meanResidual: -0.1, count: 20 },
                { key: 'body', meanResidual: -0.8, negativeRatio: 0.3, positiveRatio: 0, count: 20 }
            ]
        }),
        {
            label: 'over-subtracted-alpha-body',
            priorReliable: true,
            reason: 'reliable-prior-with-negative-body-residual'
        }
    );
});

test('measureAlphaEdgeStructureOverlap should compare image gradients on alpha edges', () => {
    const imageData = createImageData(5, 5, (pixel) => {
        const x = pixel % 5;
        return x >= 2 ? 140 : 80;
    });
    const alphaMap = new Float32Array([
        0, 0, 0, 0, 0,
        0, 0.1, 0.4, 0.1, 0,
        0, 0.1, 0.4, 0.1, 0,
        0, 0.1, 0.4, 0.1, 0,
        0, 0, 0, 0, 0
    ]);

    const overlap = measureAlphaEdgeStructureOverlap({
        imageData,
        alphaMap,
        position: { x: 0, y: 0, width: 5, height: 5 }
    });

    assert.equal(overlap.edgeMean > overlap.nonEdgeMean, true);
    assert.equal(overlap.edgeToNonEdgeRatio > 1, true);
    assert.equal(overlap.highEdgePixels > 0, true);
});

test('classifyEdgeStructureRisk should protect visible structured edge collisions', () => {
    assert.deepEqual(
        classifyEdgeStructureRisk({
            taxonomy: { algorithmicResidualCandidate: true },
            production: { calibratedVisible: true },
            residualProfile: { label: 'structured-prior-unreliable' },
            edgeStructure: { edgeMean: 20, edgeToNonEdgeRatio: 2.0 }
        }),
        {
            label: 'structured-edge-collision-protected',
            actionable: false,
            reason: 'visible-residual-overlaps-strong-image-structure'
        }
    );

    assert.deepEqual(
        classifyEdgeStructureRisk({
            taxonomy: { algorithmicResidualCandidate: true },
            production: { calibratedVisible: false },
            residualProfile: { label: 'structured-prior-unreliable' },
            edgeStructure: { edgeMean: 20, edgeToNonEdgeRatio: 2.0 }
        }),
        {
            label: 'not-protected',
            actionable: false,
            reason: 'edge-structure-risk-gates-not-met'
        }
    );
});

test('applyQuantizedBodyResidualCorrection should brighten only reliable dark body pixels', () => {
    const imageData = createImageData(2, 2, (pixel) => [100, 99, 98, 97][pixel]);
    const priorImageData = createImageData(2, 2, 100);
    const alphaMap = new Float32Array([0.01, 0.06, 0.2, 0.4]);

    const result = applyQuantizedBodyResidualCorrection({
        imageData,
        priorImageData,
        alphaMap,
        position: { x: 0, y: 0, width: 2, height: 2 },
        minAlpha: 0.12,
        residualThreshold: -0.5
    });

    assert.equal(result.changedPixels, 2);
    assert.deepEqual([...result.imageData.data].filter((_, index) => index % 4 === 0), [
        100,
        99,
        99,
        98
    ]);
});

test('classifyResidualCorrectionSafety should require visibility clear plus balanced and artifact improvement', () => {
    assert.deepEqual(
        classifyResidualCorrectionSafety({
            production: {
                calibratedVisible: true,
                balancedCost: 0.37,
                visualArtifactCost: 0.08
            },
            score: {
                calibratedVisible: false,
                balancedCost: 0.11,
                visualArtifactCost: 0.03
            }
        }),
        {
            label: 'safe-quantized-body-correction',
            clearsVisible: true,
            improvesBalanced: true,
            artifactWorse: false,
            balancedDelta: -0.26,
            artifactDelta: -0.05
        }
    );
});

test('shouldApplyQuantizedBodyCorrection should require visible algorithmic residuals', () => {
    assert.equal(shouldApplyQuantizedBodyCorrection({
        classification: { label: 'over-subtracted-alpha-body' },
        production: { calibratedVisible: true },
        taxonomy: { algorithmicResidualCandidate: true }
    }), true);

    assert.equal(shouldApplyQuantizedBodyCorrection({
        classification: { label: 'over-subtracted-alpha-body' },
        production: { calibratedVisible: false },
        taxonomy: { algorithmicResidualCandidate: true }
    }), false);

    assert.equal(shouldApplyQuantizedBodyCorrection({
        classification: { label: 'over-subtracted-alpha-body' },
        production: { calibratedVisible: true },
        taxonomy: { metricMismatchCandidate: true }
    }), false);

    assert.equal(shouldApplyQuantizedBodyCorrection({
        classification: { label: 'structured-prior-unreliable' },
        production: { calibratedVisible: true },
        taxonomy: { algorithmicResidualCandidate: true }
    }), false);
});

test('summarizeResidualProfileRecords should count profile labels', () => {
    const summary = summarizeResidualProfileRecords([
        {
            classification: { label: 'over-subtracted-alpha-body', priorReliable: true },
            edgeStructureRisk: { label: 'not-protected' },
            correction: { safety: { label: 'safe-quantized-body-correction' } }
        },
        {
            classification: { label: 'structured-prior-unreliable', priorReliable: false },
            edgeStructureRisk: { label: 'structured-edge-collision-protected' },
            correction: null
        },
        {
            classification: { label: 'over-subtracted-alpha-body', priorReliable: true },
            edgeStructureRisk: { label: 'not-protected' },
            correction: { safety: { label: 'quantized-correction-still-visible' } }
        }
    ]);

    assert.deepEqual(summary, {
        total: 3,
        priorReliableCount: 2,
        safeCorrectionCount: 1,
        labelCounts: {
            'over-subtracted-alpha-body': 2,
            'structured-prior-unreliable': 1
        },
        correctionSafetyCounts: {
            'quantized-correction-still-visible': 1,
            'safe-quantized-body-correction': 1
        },
        safeCorrectionTaxonomyCounts: {
            unknown: 1
        },
        edgeStructureRiskCounts: {
            'not-protected': 2,
            'structured-edge-collision-protected': 1
        }
    });
});

test('selectResidualProfileRecords should support all-sample counterfactual scope', () => {
    const records = [
        {
            file: 'algorithmic.png',
            taxonomy: { algorithmicResidualCandidate: true }
        },
        {
            file: 'metric.png',
            taxonomy: { algorithmicResidualCandidate: false, metricMismatchCandidate: true }
        },
        {
            file: 'clean.png',
            taxonomy: { algorithmicResidualCandidate: false, metricMismatchCandidate: false }
        }
    ];

    assert.deepEqual(
        selectResidualProfileRecords({ records }).map((record) => record.file),
        ['algorithmic.png']
    );
    assert.deepEqual(
        selectResidualProfileRecords({ records, scope: 'all' }).map((record) => record.file),
        ['algorithmic.png', 'metric.png', 'clean.png']
    );
    assert.deepEqual(
        selectResidualProfileRecords({ records, scope: 'all', filePattern: 'metric|clean' }).map((record) => record.file),
        ['metric.png', 'clean.png']
    );
});

test('summarizeResidualProfileRecords should expose safe correction taxonomy counts', () => {
    const summary = summarizeResidualProfileRecords([
        {
            taxonomy: { label: 'negative-spatial-ghost' },
            classification: { label: 'over-subtracted-alpha-body', priorReliable: true },
            correction: { safety: { label: 'safe-quantized-body-correction' } }
        },
        {
            taxonomy: { label: 'background-collision-or-metric-false-positive' },
            classification: { label: 'over-subtracted-alpha-body', priorReliable: true },
            correction: { safety: { label: 'safe-quantized-body-correction' } }
        },
        {
            taxonomy: { label: 'clean-or-metric-pass' },
            classification: { label: 'structured-prior-unreliable', priorReliable: false },
            correction: null
        }
    ]);

    assert.deepEqual(summary.safeCorrectionTaxonomyCounts, {
        'background-collision-or-metric-false-positive': 1,
        'negative-spatial-ghost': 1
    });
});
