import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderVideoDeliveryReadinessMarkdown,
    summarizeTemporalResidualReadiness,
    summarizeVideoDeliveryReadiness
} from '../../scripts/run-video-delivery-gate.js';

function benchmarkSummary(overrides = {}) {
    return {
        summary: {
            total: 4,
            rendered: 4,
            renderedComparison: 4,
            failed: 0,
            ...overrides
        }
    };
}

function gateReport(candidateOverrides = {}) {
    return {
        generatedAt: '2026-06-11T00:00:00.000Z',
        requiredLayerCount: 1,
        candidates: [
            {
                profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                decision: 'promote-default-candidate',
                summary: {
                    layerCount: 1,
                    improvedCases: 2,
                    materialFailureLayers: 0,
                    warningLayers: 0,
                    ...candidateOverrides.summary
                },
                ...candidateOverrides
            }
        ]
    };
}

function temporalReport(overrides = {}) {
    return {
        generatedAt: '2026-06-11T00:01:00.000Z',
        matchRadius: 2,
        includeVariants: true,
        cases: [
            {
                id: 'case-a',
                aggregate: {
                    meanSameJitter: 10,
                    meanMatchedJitter: 12,
                    improvement: -2,
                    improvedRatio: 0.3,
                    worsenedRatio: 0.4
                }
            },
            {
                id: 'case-a-auto-relocated',
                aggregate: {
                    meanSameJitter: 10.2,
                    meanMatchedJitter: 12.1,
                    improvement: -1.9,
                    improvedRatio: 0.31,
                    worsenedRatio: 0.38,
                    ...overrides.aggregate
                }
            }
        ],
        ...overrides
    };
}

test('summarizeVideoDeliveryReadiness should pass promoted regression-free candidates', () => {
    const report = summarizeVideoDeliveryReadiness({
        benchmarkReport: benchmarkSummary(),
        gateReport: gateReport(),
        temporalReport: temporalReport(),
        artifacts: { deliveryMarkdown: 'delivery.md' }
    });

    assert.equal(report.status, 'ready-for-visual-review');
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.gate.bestCandidate.decision, 'promote-default-candidate');
    assert.equal(report.temporal.status, 'pass');
});

test('summarizeVideoDeliveryReadiness should block missing promotions and benchmark failures', () => {
    const report = summarizeVideoDeliveryReadiness({
        benchmarkReport: benchmarkSummary({ failed: 1 }),
        gateReport: gateReport({ decision: 'human-review' })
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.ready, false);
    assert.ok(report.blockers.includes('video-benchmark-failed-cases'));
    assert.ok(report.blockers.includes('video-gate-missing-promote-default-candidate'));
});

test('summarizeTemporalResidualReadiness should block material temporal regressions', () => {
    const temporal = summarizeTemporalResidualReadiness(temporalReport({
        aggregate: {
            meanSameJitter: 12,
            meanMatchedJitter: 14,
            worsenedRatio: 0.48
        }
    }));

    assert.equal(temporal.status, 'blocked');
    assert.equal(temporal.ready, false);
    assert.ok(temporal.blockers.some((item) => item.includes('same-jitter-regression')));
    assert.ok(temporal.blockers.some((item) => item.includes('matched-jitter-regression')));
});

test('summarizeVideoDeliveryReadiness should block temporal material regressions', () => {
    const report = summarizeVideoDeliveryReadiness({
        benchmarkReport: benchmarkSummary(),
        gateReport: gateReport(),
        temporalReport: temporalReport({
            aggregate: {
                meanSameJitter: 12
            }
        })
    });

    assert.equal(report.status, 'blocked');
    assert.equal(report.ready, false);
    assert.ok(report.blockers.includes('video-temporal-material-regression'));
});

test('renderVideoDeliveryReadinessMarkdown should include gate outcome and artifacts', () => {
    const report = summarizeVideoDeliveryReadiness({
        benchmarkReport: benchmarkSummary(),
        gateReport: gateReport(),
        temporalReport: temporalReport(),
        artifacts: { gateMarkdown: 'gate.md' }
    });
    const markdown = renderVideoDeliveryReadinessMarkdown(report);

    assert.match(markdown, /Status: ready-for-visual-review/);
    assert.match(markdown, /promote-default-candidate/);
    assert.match(markdown, /## Temporal Residual/);
    assert.match(markdown, /case-a-auto-relocated/);
    assert.match(markdown, /pass/);
    assert.match(markdown, /gateMarkdown: `gate\.md`/);
});
