import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
    classifyProfileTrialSafety,
    resolvePosition,
    resolveRecordConfig,
    scoreCandidate,
    summarizeProfileRecords
} from '../../scripts/probe-metric-48-96-96-alpha-profile.js';

test('classifyProfileTrialSafety should require calibrated clear plus balanced improvement without artifact regression', () => {
    const production = {
        calibratedVisible: true,
        visible: true,
        balancedCost: 0.42,
        visualArtifactCost: 0.12
    };

    assert.deepEqual(
        classifyProfileTrialSafety({
            production,
            score: {
                calibratedVisible: false,
                visible: false,
                balancedCost: 0.34,
                visualArtifactCost: 0.13
            }
        }),
        {
            label: 'safe-profile-improvement',
            clearsVisible: true,
            improvesBalanced: true,
            artifactWorse: false,
            balancedDelta: -0.07999999999999996,
            artifactDelta: 0.010000000000000009
        }
    );

    assert.equal(
        classifyProfileTrialSafety({
            production,
            score: {
                calibratedVisible: false,
                visible: false,
                balancedCost: 0.35,
                visualArtifactCost: 0.24
            }
        }).label,
        'profile-clears-but-damages'
    );

    assert.equal(
        classifyProfileTrialSafety({
            production,
            score: {
                calibratedVisible: true,
                visible: false,
                balancedCost: 0.34,
                visualArtifactCost: 0.13
            }
        }).label,
        'profile-improves-still-visible'
    );
});

test('summarizeProfileRecords should count only safe profile improvements as fixable evidence', () => {
    const records = [
        {
            production: { calibratedVisible: true },
            best: { safety: { label: 'profile-clears-but-damages' } },
            bestSafe: null,
            bestNonVisible: { safety: { label: 'profile-clears-but-damages' } },
            reference: { safety: { label: 'profile-improves-still-visible' } }
        },
        {
            production: { calibratedVisible: true },
            best: { safety: { label: 'safe-profile-improvement' } },
            bestSafe: { safety: { label: 'safe-profile-improvement' } },
            bestNonVisible: { safety: { label: 'safe-profile-improvement' } },
            reference: { safety: { label: 'safe-profile-improvement' } }
        }
    ];

    const summary = summarizeProfileRecords(records);

    assert.equal(summary.productionCalibratedVisible, 2);
    assert.equal(summary.bestSafeCount, 1);
    assert.deepEqual(summary.bestSafetyLabels, {
        'profile-clears-but-damages': 1,
        'safe-profile-improvement': 1
    });
});

test('resolvePosition and resolveRecordConfig should prefer production fields from taxonomy reports', () => {
    const record = {
        productionConfig: {
            logoSize: 48,
            marginRight: 96,
            marginBottom: 96
        },
        productionPosition: {
            x: 100,
            y: 200,
            width: 48,
            height: 48
        },
        bestEvidence: {
            size: 48,
            marginRight: 96,
            marginBottom: 96,
            position: {
                x: 101,
                y: 201,
                width: 48,
                height: 48
            }
        }
    };

    assert.deepEqual(resolveRecordConfig(record), record.productionConfig);
    assert.deepEqual(resolvePosition(record, { width: 720, height: 1456 }), record.productionPosition);
});

test('scoreCandidate should include near-black increase in balanced cost', () => {
    const original = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            80, 80, 80, 255, 80, 80, 80, 255,
            80, 80, 80, 255, 80, 80, 80, 255
        ])
    };
    const candidate = {
        width: 2,
        height: 2,
        data: new Uint8ClampedArray([
            0, 0, 0, 255, 0, 0, 0, 255,
            0, 0, 0, 255, 0, 0, 0, 255
        ])
    };
    const alphaMap = new Float32Array([0.4, 0.5, 0.6, 0.7]);
    const score = scoreCandidate({
        imageData: candidate,
        originalImageData: original,
        alphaMapForScoring: alphaMap,
        alphaMapForDiff: alphaMap,
        position: { x: 0, y: 0, width: 2, height: 2 },
        alphaGain: 0.65
    });

    assert.equal(score.nearBlackRatio, 1);
    assert.equal(score.baselineNearBlackRatio, 0);
    assert.equal(score.nearBlackIncrease, 1);
    assert.ok(
        score.balancedCost > score.residualCost,
        `expected near-black damage to increase balanced cost, score=${JSON.stringify(score)}`
    );
});
