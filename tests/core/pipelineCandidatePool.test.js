import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classifyCandidateFamily,
    createCandidateHypothesis,
    dedupeCandidateHypotheses,
    selectDiverseCandidateHypotheses
} from '../../src/core/pipelineCandidatePool.js';

function createTrial(source, overrides = {}) {
    return {
        source,
        config: { logoSize: 96, marginRight: 64, marginBottom: 64 },
        position: { x: 100, y: 100, width: 96, height: 96 },
        alphaGain: 1,
        provenance: {},
        rankingKey: [0, 0, 0, 0, 0, 0],
        ...overrides
    };
}

test('classifyCandidateFamily should identify each distinct hypothesis family', () => {
    assert.equal(classifyCandidateFamily(createTrial('standard')), 'standard');
    assert.equal(classifyCandidateFamily(createTrial('adaptive', {
        provenance: { adaptive: true }
    })), 'geometry');
    assert.equal(classifyCandidateFamily(createTrial('standard+outline-dark', {
        provenance: { outlineDark: true }
    })), 'polarity');
    assert.equal(classifyCandidateFamily(createTrial('standard+gain', {
        alphaGain: 0.75
    })), 'alpha');
    assert.equal(classifyCandidateFamily(createTrial(
        'adaptive+aggressive-located'
    )), 'aggressive');
});

test('createCandidateHypothesis should reject structurally invalid trials', () => {
    assert.equal(createCandidateHypothesis(null), null);
    assert.equal(createCandidateHypothesis(createTrial('invalid', {
        position: { x: NaN, y: 0, width: 96, height: 96 }
    })), null);
});

test('dedupeCandidateHypotheses should keep the better near-equivalent candidate', () => {
    const hypotheses = [
        createCandidateHypothesis(createTrial('worse', {
            rankingKey: [1, 0, 0, 0, 0, 0]
        }), 0),
        createCandidateHypothesis(createTrial('better', {
            position: { x: 101, y: 100, width: 96, height: 96 },
            rankingKey: [0, 0, 0, 0, 0, 0]
        }), 1)
    ];

    const deduped = dedupeCandidateHypotheses(hypotheses);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].trial.source, 'better');
});

test('dedupeCandidateHypotheses should preserve materially different alpha gains at the same anchor', () => {
    const full = createCandidateHypothesis(createTrial('full', {
        alphaGain: 1,
        rankingKey: [0, 0, 0, 0, 0, 0]
    }), 0);
    const conservative = createCandidateHypothesis(createTrial('conservative', {
        alphaGain: 0.6,
        rankingKey: [1, 0, 0, 0, 0, 0]
    }), 1);

    const deduped = dedupeCandidateHypotheses([full, conservative]);

    assert.deepEqual(deduped.map((candidate) => candidate.alphaGain), [1, 0.6]);
});

test('dedupeCandidateHypotheses should preserve different alpha maps at the same anchor', () => {
    const canonical = createCandidateHypothesis(createTrial('canonical', {
        alphaMap: new Float32Array([0.1]),
        rankingKey: [0, 0, 0, 0, 0, 0]
    }), 0);
    const warped = createCandidateHypothesis(createTrial('warped', {
        alphaMap: new Float32Array([0.2]),
        rankingKey: [1, 0, 0, 0, 0, 0]
    }), 1);

    assert.equal(dedupeCandidateHypotheses([canonical, warped]).length, 2);
});

test('selectDiverseCandidateHypotheses should reserve families before global fill', () => {
    const selected = selectDiverseCandidateHypotheses([
        createTrial('standard-a', {
            rankingKey: [0, 0, 0, 0, 0, 0]
        }),
        createTrial('standard-b', {
            position: { x: 90, y: 100, width: 96, height: 96 },
            rankingKey: [0, 0, 0, 1, 0, 0]
        }),
        createTrial('adaptive', {
            provenance: { adaptive: true },
            position: { x: 80, y: 100, width: 96, height: 96 },
            rankingKey: [1, 0, 0, 0, 0, 0]
        }),
        createTrial('outline', {
            provenance: { outlineDark: true },
            position: { x: 70, y: 100, width: 96, height: 96 },
            rankingKey: [2, 0, 0, 0, 0, 0]
        }),
        createTrial('gain', {
            alphaGain: 0.75,
            position: { x: 60, y: 100, width: 96, height: 96 },
            rankingKey: [3, 0, 0, 0, 0, 0]
        }),
        createTrial('adaptive+aggressive-located', {
            position: { x: 50, y: 100, width: 96, height: 96 },
            rankingKey: [4, 0, 0, 0, 0, 0]
        })
    ], { limit: 5 });

    assert.deepEqual(selected.map((item) => item.family), [
        'standard',
        'geometry',
        'polarity',
        'alpha',
        'aggressive'
    ]);
});

test('selectDiverseCandidateHypotheses should fill unused slots globally', () => {
    const selected = selectDiverseCandidateHypotheses([
        createTrial('standard-a', {
            position: { x: 100, y: 100, width: 96, height: 96 },
            rankingKey: [0, 0, 0, 0, 0, 0]
        }),
        createTrial('standard-b', {
            position: { x: 90, y: 100, width: 96, height: 96 },
            rankingKey: [1, 0, 0, 0, 0, 0]
        }),
        createTrial('standard-c', {
            position: { x: 80, y: 100, width: 96, height: 96 },
            rankingKey: [2, 0, 0, 0, 0, 0]
        })
    ], { limit: 3 });

    assert.deepEqual(selected.map((item) => item.trial.source), [
        'standard-a',
        'standard-b',
        'standard-c'
    ]);
});
