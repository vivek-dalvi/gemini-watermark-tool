import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_DAMAGE_TOLERANCE,
    DEFAULT_EVIDENCE_TOLERANCE,
    getCandidatePosition,
    hasSameAnchor,
    selectSameAnchorAlternative
} from '../../scripts/same-anchor-imperfection-review.js';

function createCandidate({
    id,
    x = 100,
    y = 120,
    watermarkSize = 96,
    imperfectionScore,
    evidenceLoss,
    residualLoss,
    damageLoss
}) {
    return {
        hypothesis: {
            id,
            position: { x, y },
            config: { watermarkSize }
        },
        qualitySignals: {
            imperfections: { score: imperfectionScore },
            evidenceLoss,
            residualLoss,
            damageLoss
        }
    };
}

test('same-anchor selector should expose stable defaults and structured positions', () => {
    const candidate = createCandidate({
        id: 'candidate-with-misleading-48-96-96-id',
        x: 17,
        y: 29,
        watermarkSize: 48,
        imperfectionScore: 0.8,
        evidenceLoss: 0.2,
        residualLoss: 0.3,
        damageLoss: 0.1
    });

    assert.equal(DEFAULT_EVIDENCE_TOLERANCE, 0.05);
    assert.equal(DEFAULT_DAMAGE_TOLERANCE, 0.05);
    assert.deepEqual(getCandidatePosition(candidate), {
        x: 17,
        y: 29,
        width: 48,
        height: 48
    });
    assert.equal(
        hasSameAnchor(
            candidate,
            createCandidate({
                id: 'different-size',
                x: 17,
                y: 29,
                watermarkSize: 96,
                imperfectionScore: 0.1,
                evidenceLoss: 0.2,
                residualLoss: 0.1,
                damageLoss: 0.1
            })
        ),
        false
    );
});

test('same-anchor selector should choose the lowest plausible imperfection score', () => {
    const selected = createCandidate({
        id: 'selected',
        imperfectionScore: 0.9,
        evidenceLoss: 0.2,
        residualLoss: 0.4,
        damageLoss: 0.1
    });
    const candidates = [
        selected,
        createCandidate({
            id: 'plausible',
            imperfectionScore: 0.4,
            evidenceLoss: 0.25,
            residualLoss: 0.2,
            damageLoss: 0.15
        }),
        createCandidate({
            id: 'best-but-damaging',
            imperfectionScore: 0.1,
            evidenceLoss: 0.2,
            residualLoss: 0.1,
            damageLoss: 0.16
        }),
        createCandidate({
            id: 'different-anchor',
            x: 101,
            imperfectionScore: 0.05,
            evidenceLoss: 0.2,
            residualLoss: 0.1,
            damageLoss: 0.1
        })
    ];

    const result = selectSameAnchorAlternative({
        selectedId: 'selected',
        completedCandidates: candidates
    });

    assert.equal(result.reason, 'matched');
    assert.equal(result.selected, selected);
    assert.equal(result.alternative.hypothesis.id, 'plausible');
});

test('same-anchor selector should break equal imperfection ties by residual loss then id', () => {
    const selected = createCandidate({
        id: 'selected',
        imperfectionScore: 0.9,
        evidenceLoss: 0.2,
        residualLoss: 0.5,
        damageLoss: 0.1
    });
    const candidates = [
        selected,
        createCandidate({
            id: 'z-last',
            imperfectionScore: 0.4,
            evidenceLoss: 0.2,
            residualLoss: 0.2,
            damageLoss: 0.1
        }),
        createCandidate({
            id: 'b-second',
            imperfectionScore: 0.4,
            evidenceLoss: 0.2,
            residualLoss: 0.1,
            damageLoss: 0.1
        }),
        createCandidate({
            id: 'a-first',
            imperfectionScore: 0.4,
            evidenceLoss: 0.2,
            residualLoss: 0.1,
            damageLoss: 0.1
        })
    ];

    const result = selectSameAnchorAlternative({
        selectedId: 'selected',
        completedCandidates: candidates
    });

    assert.equal(result.alternative.hypothesis.id, 'a-first');
});

test('same-anchor selector should explain unmatched selections', () => {
    const only = createCandidate({
        id: 'only',
        imperfectionScore: 0.5,
        evidenceLoss: 0.2,
        residualLoss: 0.2,
        damageLoss: 0.1
    });

    assert.deepEqual(
        selectSameAnchorAlternative({
            selectedId: 'missing',
            completedCandidates: [only]
        }),
        {
            reason: 'selected-not-captured',
            selected: null,
            alternative: null
        }
    );
    assert.deepEqual(
        selectSameAnchorAlternative({
            selectedId: 'only',
            completedCandidates: [only]
        }),
        {
            reason: 'no-plausible-same-anchor-alternative',
            selected: only,
            alternative: null
        }
    );
});
