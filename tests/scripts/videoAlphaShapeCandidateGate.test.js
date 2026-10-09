import test from 'node:test';
import assert from 'node:assert/strict';

import {
    rankVideoAlphaShapeCandidates,
    renderVideoAlphaShapeGateMarkdown
} from '../../scripts/gate-video-alpha-shape-candidates.js';

function createCase(id, currentActiveMeanAbs, candidates) {
    return {
        id,
        currentActiveMeanAbs,
        candidates: new Map(Object.entries(candidates))
    };
}

test('rankVideoAlphaShapeCandidates should reject locally good candidates with video regressions', () => {
    const cases = [
        createCase('case-a', 10, {
            candidate_good_local: { name: 'candidate_good_local', activeMeanAbs: 9.8, params: { lowScale: 0.92 } },
            candidate_bad_local: { name: 'candidate_bad_local', activeMeanAbs: 10.5, params: {} }
        }),
        createCase('case-b', 8, {
            candidate_good_local: { name: 'candidate_good_local', activeMeanAbs: 7.7, params: { lowScale: 0.92 } },
            candidate_bad_local: { name: 'candidate_bad_local', activeMeanAbs: 8.1, params: {} }
        })
    ];
    const benchmarkSummary = {
        variantComparisons: [
            {
                status: 'compared',
                baselineId: 'case-a-baseline',
                variantId: 'case-a-candidate',
                deltas: {
                    active: { meanAbsDelta: 0.2, verdict: 'regressed' },
                    edge: { meanAbsDelta: -0.1, verdict: 'improved' },
                    lowBody: { meanAbsDelta: 0, verdict: 'neutral' },
                    highBody: { meanAbsDelta: 0.3, verdict: 'regressed' }
                }
            }
        ]
    };

    const result = rankVideoAlphaShapeCandidates(cases, {
        benchmarkSummary,
        minFitImprovement: 0.02,
        maxFitRegression: 0.02,
        top: 2
    });

    assert.equal(result.promotedCount, 0);
    assert.equal(result.rejectedByVideoCount, 2);
    assert.equal(result.topCandidates[0].name, 'candidate_good_local');
    assert.equal(result.topCandidates[0].fitGate.verdict, 'fit-pass');
    assert.equal(result.topCandidates[0].videoGate.verdict, 'rejected-video-regression');
    assert.match(result.recommendation, /Reject this alpha-shape branch/);
});

test('rankVideoAlphaShapeCandidates should promote fit-pass candidates without video regressions', () => {
    const cases = [
        createCase('case-a', 10, {
            candidate_good_local: { name: 'candidate_good_local', activeMeanAbs: 9.8, params: {} }
        }),
        createCase('case-b', 8, {
            candidate_good_local: { name: 'candidate_good_local', activeMeanAbs: 7.9, params: {} }
        })
    ];

    const result = rankVideoAlphaShapeCandidates(cases, {
        benchmarkSummary: {
            variantComparisons: [
                {
                    status: 'compared',
                    baselineId: 'case-a-baseline',
                    variantId: 'case-a-candidate',
                    deltas: {
                        active: { meanAbsDelta: -0.1, verdict: 'improved' },
                        edge: { meanAbsDelta: 0, verdict: 'neutral' }
                    }
                }
            ]
        }
    });

    assert.equal(result.promotedCount, 1);
    assert.equal(result.topCandidates[0].videoGate.verdict, 'candidate-visual-review');
});

test('rankVideoAlphaShapeCandidates should bind benchmark gates to the named candidate only', () => {
    const cases = [
        createCase('case-a', 10, {
            candidate_target: { name: 'candidate_target', activeMeanAbs: 9.8, params: {} },
            candidate_other: { name: 'candidate_other', activeMeanAbs: 9.7, params: {} }
        }),
        createCase('case-b', 8, {
            candidate_target: { name: 'candidate_target', activeMeanAbs: 7.8, params: {} },
            candidate_other: { name: 'candidate_other', activeMeanAbs: 7.7, params: {} }
        })
    ];

    const result = rankVideoAlphaShapeCandidates(cases, {
        benchmarkCandidateName: 'candidate_target',
        benchmarkSummary: {
            variantComparisons: [
                {
                    status: 'compared',
                    variantId: 'case-a-target',
                    deltas: {
                        active: { meanAbsDelta: 0.2, verdict: 'regressed' }
                    }
                }
            ]
        }
    });

    assert.equal(result.promotedCount, 0);
    assert.equal(result.rejectedByVideoCount, 1);
    assert.equal(result.topCandidates[0].name, 'candidate_target');
    assert.equal(result.topCandidates[0].videoGate.verdict, 'rejected-video-regression');
    assert.equal(result.topCandidates[1].name, 'candidate_other');
    assert.equal(result.topCandidates[1].videoGate.verdict, 'no-video-benchmark');
});

test('rankVideoAlphaShapeCandidates should combine multiple named candidate benchmarks', () => {
    const cases = [
        createCase('case-a', 10, {
            candidate_rejected: { name: 'candidate_rejected', activeMeanAbs: 9.8, params: {} },
            candidate_review: { name: 'candidate_review', activeMeanAbs: 9.7, params: {} },
            candidate_unchecked: { name: 'candidate_unchecked', activeMeanAbs: 9.6, params: {} }
        }),
        createCase('case-b', 8, {
            candidate_rejected: { name: 'candidate_rejected', activeMeanAbs: 7.8, params: {} },
            candidate_review: { name: 'candidate_review', activeMeanAbs: 7.7, params: {} },
            candidate_unchecked: { name: 'candidate_unchecked', activeMeanAbs: 7.6, params: {} }
        })
    ];

    const result = rankVideoAlphaShapeCandidates(cases, {
        candidateBenchmarkSummaries: new Map([
            ['candidate_rejected', {
                variantComparisons: [
                    {
                        status: 'compared',
                        variantId: 'rejected',
                        deltas: {
                            active: { meanAbsDelta: 0.2, verdict: 'regressed' }
                        }
                    }
                ]
            }],
            ['candidate_review', {
                variantComparisons: [
                    {
                        status: 'compared',
                        variantId: 'review',
                        deltas: {
                            active: { meanAbsDelta: -0.2, verdict: 'improved' },
                            edge: { meanAbsDelta: 0, verdict: 'neutral' }
                        }
                    }
                ]
            }]
        ]),
        top: 3
    });

    const byName = new Map(result.topCandidates.map((candidate) => [candidate.name, candidate]));
    assert.equal(byName.get('candidate_rejected')?.videoGate.verdict, 'rejected-video-regression');
    assert.equal(byName.get('candidate_review')?.videoGate.verdict, 'candidate-visual-review');
    assert.equal(byName.get('candidate_unchecked')?.videoGate.verdict, 'no-video-benchmark');
    assert.equal(result.promotedCount, 1);
    assert.equal(result.rejectedByVideoCount, 1);
});

test('renderVideoAlphaShapeGateMarkdown should include candidate gate details', () => {
    const markdown = renderVideoAlphaShapeGateMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        inputs: {
            fitSummaryPath: 'fit.json',
            benchmarkSummaryPath: 'benchmark.json'
        },
        result: {
            recommendation: 'Keep default.',
            topCandidates: [
                {
                    name: 'candidate-a',
                    fitGate: {
                        verdict: 'fit-pass',
                        meanDelta: -0.2,
                        maxRegression: -0.1,
                        improvedCases: 2,
                        regressedCases: 0
                    },
                    videoGate: {
                        verdict: 'candidate-visual-review',
                        regressions: []
                    }
                }
            ]
        }
    });

    assert.match(markdown, /Video Alpha Shape Candidate Gate/);
    assert.match(markdown, /candidate-a/);
    assert.match(markdown, /fit-pass/);
    assert.match(markdown, /candidate-visual-review/);
});
