import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
    applyLumaThenSignedTemplateRepair,
    applySignedTemplateRepair,
    classifyBoundaryRepairApplicability,
    classifyBoundaryRepairTrialSafety,
    resolveBoundaryRepairPresetsForRecord,
    selectBoundaryRepairRecords,
    selectBestStructurePreservingTrial,
    summarizeBoundaryRepairRecords
} from '../../scripts/probe-metric-48-96-96-boundary-repair.js';

test('classifyBoundaryRepairTrialSafety should require calibrated clear, balanced improvement, and bounded artifacts', () => {
    const production = {
        calibratedVisible: true,
        balancedCost: 0.5,
        visualArtifactCost: 0.1
    };

    assert.equal(
        classifyBoundaryRepairTrialSafety({
            production,
            score: {
                calibratedVisible: false,
                balancedCost: 0.42,
                visualArtifactCost: 0.12
            }
        }).label,
        'safe-boundary-repair'
    );

    assert.equal(
        classifyBoundaryRepairTrialSafety({
            production,
            score: {
                calibratedVisible: false,
                balancedCost: 0.48,
                visualArtifactCost: 0.24
            }
        }).label,
        'boundary-clears-but-damages'
    );

    assert.equal(
        classifyBoundaryRepairTrialSafety({
            production,
            score: {
                calibratedVisible: true,
                balancedCost: 0.4,
                gradient: 0.2,
                visualArtifactCost: 0.11
            }
        }).label,
        'boundary-improves-still-visible'
    );

    assert.equal(
        classifyBoundaryRepairTrialSafety({
            production: {
                calibratedVisible: true,
                balancedCost: 0.365,
                gradient: 0.21,
                visualArtifactCost: 0.248
            },
            score: {
                calibratedVisible: true,
                balancedCost: 0.359,
                gradient: 0.19,
                visualArtifactCost: 0.231
            }
        }).label,
        'boundary-structure-improves-still-visible'
    );
});

test('summarizeBoundaryRepairRecords should count only safe boundary repairs as fixable evidence', () => {
    const summary = summarizeBoundaryRepairRecords([
        {
            production: { calibratedVisible: true },
            best: { safety: { label: 'boundary-clears-but-damages' } },
            bestSafe: null
        },
        {
            production: { calibratedVisible: true },
            best: { safety: { label: 'safe-boundary-repair' } },
            bestSafe: { safety: { label: 'safe-boundary-repair' } }
        }
    ]);

    assert.equal(summary.total, 2);
    assert.equal(summary.productionCalibratedVisible, 2);
    assert.equal(summary.bestSafeCount, 1);
    assert.deepEqual(summary.bestSafetyLabels, {
        'boundary-clears-but-damages': 1,
        'safe-boundary-repair': 1
    });
});

test('classifyBoundaryRepairApplicability should split smooth negative ghosts from structured edge residuals', () => {
    assert.deepEqual(
        classifyBoundaryRepairApplicability({
            taxonomy: { label: 'negative-spatial-ghost' },
            production: {
                spatial: -0.33,
                gradient: -0.04,
                visualArtifactCost: 0.08,
                nearBlackRatio: 0
            }
        }),
        {
            label: 'smooth-negative-prior-candidate',
            allowBoundaryRepair: true,
            reason: 'negative-spatial-low-gradient'
        }
    );

    assert.deepEqual(
        classifyBoundaryRepairApplicability({
            taxonomy: { label: 'edge-gradient-residual' },
            production: {
                spatial: 0.15,
                gradient: 0.21,
                visualArtifactCost: 0.24,
                nearBlackRatio: 0
            }
        }),
        {
            label: 'structured-edge-protected',
            allowBoundaryRepair: false,
            reason: 'high-gradient-structure'
        }
    );
});

test('resolveBoundaryRepairPresetsForRecord should keep gated presets out of protected records', () => {
    const presets = [
        { name: 'base' },
        { name: 'smooth-only', requiresBoundaryAllowed: true }
    ];

    assert.deepEqual(
        resolveBoundaryRepairPresetsForRecord({
            repairApplicability: { allowBoundaryRepair: false }
        }, presets).map((preset) => preset.name),
        ['base']
    );

    assert.deepEqual(
        resolveBoundaryRepairPresetsForRecord({
            repairApplicability: { allowBoundaryRepair: true }
        }, presets).map((preset) => preset.name),
        ['base', 'smooth-only']
    );
});

test('resolveBoundaryRepairPresetsForRecord should scope label-specific presets to matching residual classes', () => {
    const presets = [
        { name: 'base' },
        { name: 'smooth-only', requiresApplicabilityLabels: ['smooth-negative-prior-candidate'] },
        { name: 'edge-aware-only', requiresApplicabilityLabels: ['structured-edge-protected'] }
    ];

    assert.deepEqual(
        resolveBoundaryRepairPresetsForRecord({
            repairApplicability: { label: 'structured-edge-protected', allowBoundaryRepair: false }
        }, presets).map((preset) => preset.name),
        ['base', 'edge-aware-only']
    );

    assert.deepEqual(
        resolveBoundaryRepairPresetsForRecord({
            repairApplicability: { label: 'smooth-negative-prior-candidate', allowBoundaryRepair: true }
        }, presets).map((preset) => preset.name),
        ['base', 'smooth-only']
    );
});

test('selectBoundaryRepairRecords should support visible scope without changing the default algorithmic scope', () => {
    const records = [
        {
            file: 'algorithmic.png',
            production: { calibratedVisible: true },
            taxonomy: { algorithmicResidualCandidate: true }
        },
        {
            file: 'metric.png',
            production: { calibratedVisible: true },
            taxonomy: { metricMismatchCandidate: true }
        },
        {
            file: 'clean.png',
            production: { calibratedVisible: false },
            taxonomy: { algorithmicResidualCandidate: true }
        }
    ];

    assert.deepEqual(
        selectBoundaryRepairRecords(records, { filePattern: /./ }).map((record) => record.file),
        ['algorithmic.png', 'clean.png']
    );
    assert.deepEqual(
        selectBoundaryRepairRecords(records, { filePattern: /./, scope: 'visible' }).map((record) => record.file),
        ['algorithmic.png', 'metric.png']
    );
});

test('selectBestStructurePreservingTrial should prefer low-artifact edge repair over broad smoothing', () => {
    const selected = selectBestStructurePreservingTrial([
        {
            preset: 'wide-strong-r24',
            score: {
                balancedCost: 0.32,
                gradient: 0.336,
                visualArtifactCost: 0.336,
                visibilitySeverity: 26,
                residualCost: 0.2
            },
            safety: { label: 'boundary-improves-still-visible', artifactDelta: 0.088 }
        },
        {
            preset: 'edge-aware-luma-r5',
            score: {
                balancedCost: 0.359,
                gradient: 0.19,
                visualArtifactCost: 0.231,
                visibilitySeverity: 21,
                residualCost: 0.277
            },
            safety: { label: 'boundary-structure-improves-still-visible', artifactDelta: -0.017 }
        }
    ]);

    assert.equal(selected?.preset, 'edge-aware-luma-r5');
});

test('applySignedTemplateRepair should apply a bounded correction opposite to alpha polarity', () => {
    const imageData = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
            100, 100, 100, 255,
            100, 100, 100, 255
        ])
    };
    const repaired = applySignedTemplateRepair({
        productionImageData: imageData,
        alphaMap: new Float32Array([0.5, -0.5]),
        position: { x: 0, y: 0, width: 2, height: 1 },
        preset: {
            minAlpha: 0.01,
            maxAlpha: 1,
            strength: 12,
            gamma: 1,
            maxDelta: 4,
            edgeWeightFloor: 1
        }
    });

    assert.equal(repaired.data[0], 96);
    assert.equal(repaired.data[4], 104);
    assert.equal(imageData.data[0], 100);
});

test('applyLumaThenSignedTemplateRepair should support a luma-preserving prepass before signed correction', () => {
    const imageData = {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([
            100, 100, 100, 255,
            100, 100, 100, 255
        ])
    };
    const repaired = applyLumaThenSignedTemplateRepair({
        productionImageData: imageData,
        alphaMap: new Float32Array([0.5, -0.5]),
        position: { x: 0, y: 0, width: 2, height: 1 },
        preset: {
            luma: {
                minAlpha: 0.01,
                maxAlpha: 1,
                referenceAlphaMax: 0.01,
                radius: 1,
                strength: 0,
                colorSigma: 18,
                maxDelta: 4
            },
            signed: {
                minAlpha: 0.01,
                maxAlpha: 1,
                strength: 10,
                gamma: 1,
                maxDelta: 3,
                edgeWeightFloor: 1
            }
        }
    });

    assert.equal(repaired.data[0], 97);
    assert.equal(repaired.data[4], 103);
    assert.equal(imageData.data[0], 100);
});
