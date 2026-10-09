import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildReviewDecisions,
    buildSheetGroups,
    classifyCandidateSafety,
    classifyRecord,
    summarize
} from '../../scripts/create-metric-48-96-96-failure-taxonomy.js';

test('classifyRecord should keep dark halo failures separate from negative spatial ghosts', () => {
    const taxonomy = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: -0.29,
            gradient: 0.001,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            darkHaloLum: 15.8
        },
        bestRemoval: {
            removalGain: 0,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });

    assert.equal(taxonomy.label, 'dark-halo');
});

test('classifyRecord should flag non-improving visible collisions as metric mismatch candidates', () => {
    const taxonomy = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: 0.18,
            gradient: 0.04,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            darkHaloLum: 0
        },
        bestRemoval: {
            removalGain: -0.12,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });

    assert.equal(taxonomy.label, 'background-collision-or-metric-false-positive');
    assert.equal(taxonomy.metricMismatchCandidate, true);
    assert.equal(taxonomy.algorithmicResidualCandidate, false);
    assert.equal(taxonomy.mismatchReason, 'positive-spatial-background-collision');
});

test('classifyRecord should keep directional residuals out of metric mismatch candidates', () => {
    const edgeTaxonomy = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: 0.15,
            gradient: 0.21,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            darkHaloLum: 0
        },
        bestRemoval: {
            removalGain: -0.16,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });
    const negativeTaxonomy = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: -0.34,
            gradient: -0.05,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            darkHaloLum: 0.4
        },
        bestRemoval: {
            removalGain: -0.23,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });

    assert.equal(edgeTaxonomy.label, 'edge-gradient-residual');
    assert.equal(edgeTaxonomy.metricMismatchCandidate, false);
    assert.equal(edgeTaxonomy.algorithmicResidualCandidate, true);
    assert.equal(edgeTaxonomy.mismatchReason, null);
    assert.equal(negativeTaxonomy.label, 'negative-spatial-ghost');
    assert.equal(negativeTaxonomy.metricMismatchCandidate, false);
    assert.equal(negativeTaxonomy.algorithmicResidualCandidate, true);
    assert.equal(negativeTaxonomy.mismatchReason, null);
});

test('classifyRecord should expose low-texture and weak-halo mismatch reasons', () => {
    const lowTexture = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: 0.34,
            gradient: 0.11,
            nearBlackRatio: 0.39,
            newlyClippedRatio: 0,
            darkHaloLum: 0
        },
        bestRemoval: {
            removalGain: -0.03,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });
    const weakHalo = classifyRecord({
        production: {
            calibratedVisible: true,
            visible: true,
            spatial: 0.09,
            gradient: 0.04,
            nearBlackRatio: 0,
            newlyClippedRatio: 0,
            darkHaloLum: 0
        },
        bestRemoval: {
            removalGain: -0.14,
            processed: {
                calibratedVisible: true,
                visible: true
            }
        }
    });

    assert.equal(lowTexture.mismatchReason, 'low-texture-background-collision');
    assert.equal(weakHalo.mismatchReason, 'weak-halo-background-collision');
});

test('buildSheetGroups should split metric mismatch sheets by reason', () => {
    const records = [
        {
            file: 'a.png',
            production: { calibratedVisible: true },
            taxonomy: {
                label: 'background-collision-or-metric-false-positive',
                metricMismatchCandidate: true,
                mismatchReason: 'positive-spatial-background-collision'
            }
        },
        {
            file: 'b.png',
            production: { calibratedVisible: true },
            taxonomy: {
                label: 'background-collision-or-metric-false-positive',
                metricMismatchCandidate: true,
                mismatchReason: 'low-texture-background-collision'
            }
        },
        {
            file: 'c.png',
            production: { calibratedVisible: true },
            taxonomy: {
                label: 'edge-gradient-residual',
                algorithmicResidualCandidate: true,
                mismatchReason: null
            }
        },
        {
            file: 'clean.png',
            production: { calibratedVisible: false },
            taxonomy: {
                label: 'clean-or-metric-pass'
            }
        }
    ];

    const groups = buildSheetGroups(records);

    assert.deepEqual(
        groups.map((group) => [group.key, group.records.map((record) => record.file)]),
        [
            ['background-collision-or-metric-false-positive', ['a.png', 'b.png']],
            ['edge-gradient-residual', ['c.png']],
            ['mismatch-low-texture-background-collision', ['b.png']],
            ['mismatch-positive-spatial-background-collision', ['a.png']]
        ]
    );
});

test('buildReviewDecisions should group algorithmic residuals before mismatch reasons', () => {
    const records = [
        {
            file: 'positive.png',
            production: { calibratedVisible: true },
            bestRemoval: null,
            taxonomy: {
                label: 'background-collision-or-metric-false-positive',
                action: 'needs human label before production changes',
                severity: 30,
                metricMismatchCandidate: true,
                algorithmicResidualCandidate: false,
                mismatchReason: 'positive-spatial-background-collision'
            }
        },
        {
            file: 'edge.png',
            production: { calibratedVisible: true },
            bestRemoval: null,
            taxonomy: {
                label: 'edge-gradient-residual',
                action: 'investigate edge cleanup/profile shape; not solved by global gain',
                severity: 10,
                metricMismatchCandidate: false,
                algorithmicResidualCandidate: true,
                mismatchReason: null
            }
        },
        {
            file: 'low-texture.png',
            production: { calibratedVisible: true },
            bestRemoval: null,
            taxonomy: {
                label: 'background-collision-or-metric-false-positive',
                action: 'needs human label before production changes',
                severity: 20,
                metricMismatchCandidate: true,
                algorithmicResidualCandidate: false,
                mismatchReason: 'low-texture-background-collision'
            }
        }
    ];

    const decisions = buildReviewDecisions(records);

    assert.deepEqual(
        decisions.map((decision) => ({
            file: decision.file,
            reviewGroup: decision.reviewGroup,
            mismatchReason: decision.mismatchReason
        })),
        [
            {
                file: 'edge.png',
                reviewGroup: 'algorithmic-residual',
                mismatchReason: null
            },
            {
                file: 'low-texture.png',
                reviewGroup: 'metric-mismatch:low-texture-background-collision',
                mismatchReason: 'low-texture-background-collision'
            },
            {
                file: 'positive.png',
                reviewGroup: 'metric-mismatch:positive-spatial-background-collision',
                mismatchReason: 'positive-spatial-background-collision'
            }
        ]
    );
});

test('buildReviewDecisions should explain why visible rows are not blind tuning targets', () => {
    const records = [
        {
            file: 'edge.png',
            production: { calibratedVisible: true },
            bestRemoval: null,
            taxonomy: {
                label: 'edge-gradient-residual',
                action: 'investigate edge cleanup/profile shape; not solved by global gain',
                severity: 20,
                metricMismatchCandidate: false,
                algorithmicResidualCandidate: true,
                mismatchReason: null,
                candidateSafety: {
                    label: 'worsens-or-no-safe-candidate'
                }
            }
        },
        {
            file: 'collision.png',
            production: { calibratedVisible: true },
            bestRemoval: null,
            taxonomy: {
                label: 'background-collision-or-metric-false-positive',
                action: 'needs human label before production changes',
                severity: 10,
                metricMismatchCandidate: true,
                algorithmicResidualCandidate: false,
                mismatchReason: 'low-texture-background-collision',
                candidateSafety: {
                    label: 'worsens-or-no-safe-candidate'
                }
            }
        }
    ];

    const decisions = buildReviewDecisions(records);

    assert.deepEqual(decisions.map((decision) => decision.decisionEvidence), [
        {
            safeProductionChange: false,
            candidateSafetyLabel: 'worsens-or-no-safe-candidate',
            reasonCodes: [
                'candidate-worsens-or-no-safe-candidate',
                'algorithmic-residual-needs-profile-investigation'
            ],
            nextStep: 'investigate-profile-or-alpha-model'
        },
        {
            safeProductionChange: false,
            candidateSafetyLabel: 'worsens-or-no-safe-candidate',
            reasonCodes: [
                'candidate-worsens-or-no-safe-candidate',
                'metric-mismatch-candidate',
                'human-label-required'
            ],
            nextStep: 'human-label-before-production-change'
        }
    ]);
});

test('classifyCandidateSafety should separate safe fixes from metric-only clears that damage texture', () => {
    const safeFix = classifyCandidateSafety({
        production: {
            calibratedVisible: true,
            balancedCost: 0.42,
            visualArtifactCost: 0.12
        },
        bestRemoval: {
            removalGain: 0.08,
            processed: {
                calibratedVisible: false,
                balancedCost: 0.34,
                visualArtifactCost: 0.13
            }
        }
    });

    assert.deepEqual(
        {
            label: safeFix.label,
            clearsVisible: safeFix.clearsVisible,
            improvesBalanced: safeFix.improvesBalanced,
            artifactWorse: safeFix.artifactWorse
        },
        {
            label: 'safe-improvement',
            clearsVisible: true,
            improvesBalanced: true,
            artifactWorse: false
        }
    );

    const metricOnlyClear = classifyCandidateSafety({
        production: {
            calibratedVisible: true,
            balancedCost: 0.20,
            visualArtifactCost: 0.05
        },
        bestRemoval: {
            removalGain: -0.15,
            processed: {
                calibratedVisible: false,
                balancedCost: 0.35,
                visualArtifactCost: 0.18
            }
        }
    });

    assert.deepEqual(
        {
            label: metricOnlyClear.label,
            clearsVisible: metricOnlyClear.clearsVisible,
            improvesBalanced: metricOnlyClear.improvesBalanced,
            artifactWorse: metricOnlyClear.artifactWorse
        },
        {
            label: 'metric-clears-but-damages',
            clearsVisible: true,
            improvesBalanced: false,
            artifactWorse: true
        }
    );
});

test('summarize should expose metric risk counts by reason', () => {
    const summary = summarize([
        {
            production: {
                calibratedVisible: false,
                metricRisk: 'flat-clipped-low-texture-spatial-correlation'
            },
            taxonomy: {
                label: 'metric-risk-calibrated-pass',
                metricMismatchCandidate: true,
                algorithmicResidualCandidate: false,
                candidateSafety: { label: 'worsens-or-no-safe-candidate' }
            }
        },
        {
            production: {
                calibratedVisible: false,
                metricRisk: 'positive-halo-background-collision'
            },
            taxonomy: {
                label: 'metric-risk-calibrated-pass',
                metricMismatchCandidate: true,
                algorithmicResidualCandidate: false,
                candidateSafety: { label: 'worsens-or-no-safe-candidate' }
            }
        },
        {
            production: {
                calibratedVisible: true,
                metricRisk: null
            },
            taxonomy: {
                label: 'edge-gradient-residual',
                metricMismatchCandidate: false,
                algorithmicResidualCandidate: true,
                mismatchReason: null,
                candidateSafety: { label: 'worsens-or-no-safe-candidate' }
            }
        }
    ]);

    assert.deepEqual(summary.metricRiskCounts, {
        'flat-clipped-low-texture-spatial-correlation': 1,
        'positive-halo-background-collision': 1
    });
});
