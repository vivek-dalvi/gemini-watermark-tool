import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeReview } from '../../scripts/summarize-same-anchor-imperfection-review.js';

function createReport() {
    return {
        sourceReportSha256: 'abc',
        records: [
            {
                fileName: 'a.png',
                status: 'matched',
                selected: {
                    family: 'standard',
                    position: { width: 48 },
                    imperfections: { types: ['spatial-residual'] }
                },
                alternative: {
                    family: 'alpha',
                    imperfections: { score: 0.4 }
                }
            },
            {
                fileName: 'b.png',
                status: 'matched',
                selected: {
                    family: 'alpha',
                    position: { width: 96 },
                    imperfections: { types: ['gradient-residual'] }
                },
                alternative: {
                    family: 'alpha',
                    imperfections: { score: 0.7 }
                }
            },
            { fileName: 'ignored.png', status: 'not-reproduced' }
        ]
    };
}

test('summarizeReview should validate decisions and aggregate geometry and verdicts', () => {
    const report = createReport();
    const review = {
        sourceReportSha256: 'abc',
        decisions: [
            {
                fileName: 'a.png',
                verdict: 'alternative-better',
                reason: 'dark body is weaker'
            },
            {
                fileName: 'b.png',
                verdict: 'current-better',
                reason: 'alternative adds a bright edge'
            }
        ]
    };

    const summary = summarizeReview({ report, review });

    assert.deepEqual(summary.verdicts, {
        'alternative-better': 1,
        tie: 0,
        'current-better': 1,
        unclear: 0
    });
    assert.equal(summary.byWidth['48']['alternative-better'], 1);
    assert.equal(
        summary.byFamilyTransition['standard>alpha']['alternative-better'],
        1
    );
    assert.equal(
        summary.bySelectedImperfectionType['gradient-residual'][
            'current-better'
        ],
        1
    );
    assert.equal(summary.requiresSeparateProductionDesign, true);
});

test('summarizeReview should reject stale, incomplete, duplicate, unknown, or invalid decisions', () => {
    const report = createReport();
    assert.throws(
        () =>
            summarizeReview({
                report,
                review: { sourceReportSha256: 'old', decisions: [] }
            }),
        /hash mismatch/
    );
    assert.throws(
        () =>
            summarizeReview({
                report,
                review: {
                    sourceReportSha256: 'abc',
                    decisions: [
                        { fileName: 'a.png', verdict: 'tie' },
                        { fileName: 'a.png', verdict: 'tie' }
                    ]
                }
            }),
        /duplicate review decision/
    );
    assert.throws(
        () =>
            summarizeReview({
                report,
                review: {
                    sourceReportSha256: 'abc',
                    decisions: [
                        { fileName: 'a.png', verdict: 'tie' },
                        { fileName: 'unknown.png', verdict: 'tie' }
                    ]
                }
            }),
        /unknown review file/
    );
    assert.throws(
        () =>
            summarizeReview({
                report,
                review: {
                    sourceReportSha256: 'abc',
                    decisions: [
                        { fileName: 'a.png', verdict: 'better' },
                        { fileName: 'b.png', verdict: 'tie' }
                    ]
                }
            }),
        /invalid review verdict/
    );
    assert.throws(
        () =>
            summarizeReview({
                report,
                review: {
                    sourceReportSha256: 'abc',
                    decisions: [{ fileName: 'a.png', verdict: 'tie' }]
                }
            }),
        /missing review decision/
    );
});
