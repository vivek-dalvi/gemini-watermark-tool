import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createVideoDenoiseCandidateGateReport,
    renderVideoDenoiseCandidateGateMarkdown
} from '../../scripts/gate-video-denoise-candidates.js';

function deltas({
    active = 'neutral',
    edge = 'neutral',
    lowBody = 'neutral',
    highBody = 'neutral'
} = {}) {
    const valueFor = (verdict) => verdict === 'improved'
        ? -0.1
        : verdict === 'regressed'
            ? 0.1
            : 0;
    return {
        active: { meanAbsDelta: valueFor(active), verdict: active },
        edge: { meanAbsDelta: valueFor(edge), verdict: edge },
        lowBody: { meanAbsDelta: valueFor(lowBody), verdict: lowBody },
        highBody: { meanAbsDelta: valueFor(highBody), verdict: highBody }
    };
}

function benchmarkReport(variantComparisons) {
    return {
        generatedAt: '2026-06-11T00:00:00.000Z',
        variantComparisons
    };
}

function frameLabReport(profile, cases) {
    return {
        generatedAt: '2026-06-11T00:00:00.000Z',
        profile,
        cases
    };
}

const profile = {
    denoiseBackend: 'canvas-ml-roi-denoise',
    edgeDenoiseStrength: 0.5
};

test('createVideoDenoiseCandidateGateReport should promote candidates that improve without regressions across layers', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'frame-lab.json',
                report: frameLabReport(profile, [
                    { id: 'case-a', deltas: deltas({ edge: 'improved' }) },
                    { id: 'case-b', deltas: deltas({ active: 'improved' }) }
                ])
            },
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ edge: 'improved' })
                    }
                ])
            },
            {
                reportPath: 'high-bitrate.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi-12mbps',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved', edge: 'improved' })
                    }
                ])
            }
        ]
    });

    assert.equal(report.summary.totalCandidates, 1);
    assert.equal(report.candidates[0].decision, 'promote-default-candidate');
    assert.equal(report.candidates[0].summary.layerCount, 3);
    assert.equal(report.candidates[0].summary.improvedCases, 4);
});

test('createVideoDenoiseCandidateGateReport should reject candidates with material video-level regression', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'frame-lab.json',
                report: frameLabReport(profile, [
                    { id: 'case-a', deltas: deltas({ edge: 'improved' }) }
                ])
            },
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ edge: 'improved', lowBody: 'regressed' })
                    }
                ])
            }
        ]
    });

    assert.equal(report.candidates[0].decision, 'reject');
    assert.equal(report.candidates[0].summary.materialFailureLayers, 1);
    assert.deepEqual(
        report.candidates[0].layers[1].summary.failures[0].buckets,
        ['lowBody']
    );
});

test('createVideoDenoiseCandidateGateReport should send warning-only regressions to human review', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved', lowBody: 'regressed' }),
                        riskNotes: [
                            {
                                severity: 'warning',
                                bucket: 'lowBody',
                                code: 'sparse-low-body-regression'
                            }
                        ]
                    }
                ])
            }
        ]
    });

    assert.equal(report.candidates[0].decision, 'human-review');
    assert.equal(report.candidates[0].summary.warningLayers, 1);
});

test('createVideoDenoiseCandidateGateReport should not promote synthetic seam-only evidence', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'runtime-seam.json',
                report: frameLabReport({
                    denoiseBackend: 'allenk-fdncnn-browser-spike',
                    edgeDenoiseStrength: 1,
                    syntheticSeamFixture: true
                }, [
                    { id: 'synthetic-case', deltas: deltas({ active: 'improved', edge: 'improved' }) }
                ])
            }
        ]
    });

    assert.equal(report.candidates[0].decision, 'synthetic-seam-evidence-only');
    assert.equal(report.candidates[0].summary.syntheticSeamOnly, true);
});

test('createVideoDenoiseCandidateGateReport should not reject regressions reproduced by encoding control', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved', edge: 'regressed' })
                    },
                    {
                        status: 'compared',
                        baselineId: 'case-b',
                        variantId: 'case-b-roi',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved', lowBody: 'regressed' }),
                        riskNotes: [
                            {
                                severity: 'warning',
                                bucket: 'lowBody',
                                code: 'sparse-low-body-regression'
                            }
                        ]
                    }
                ])
            }
        ],
        controlReports: [
            {
                reportPath: 'encoding-control.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-none-12mbps',
                        currentProfile: { denoiseBackend: 'none', encodingControl: true },
                        deltas: deltas({ edge: 'regressed' })
                    }
                ])
            }
        ]
    });

    const candidate = report.candidates[0];
    assert.equal(candidate.decision, 'human-review');
    assert.equal(candidate.summary.materialFailureLayers, 0);
    assert.equal(candidate.summary.warningLayers, 1);
    assert.deepEqual(candidate.layers[0].cases[0].controlAdjustments.map((item) => item.bucket), ['edge']);
});

test('renderVideoDenoiseCandidateGateMarkdown should include control adjustments', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved', edge: 'regressed' })
                    }
                ])
            }
        ],
        controlReports: [
            {
                reportPath: 'encoding-control.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-none-12mbps',
                        currentProfile: { denoiseBackend: 'none', encodingControl: true },
                        deltas: deltas({ edge: 'regressed' })
                    }
                ])
            }
        ]
    });
    const markdown = renderVideoDenoiseCandidateGateMarkdown(report);

    assert.match(markdown, /Control reports: 1/);
    assert.match(markdown, /Control Adjustments/);
    assert.match(markdown, /edge:\+0\.1000 covered by case-a-none-12mbps/);
});

test('createVideoDenoiseCandidateGateReport should keep same-named reports as separate evidence layers', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: '.artifacts/video-crop-benchmark/latest-summary.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ edge: 'improved' })
                    }
                ])
            },
            {
                reportPath: '.artifacts/video-crop-benchmark-12mbps/latest-summary.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi-12mbps',
                        currentProfile: profile,
                        deltas: deltas({ active: 'improved' })
                    }
                ])
            }
        ]
    });

    assert.equal(report.layers.length, 2);
    assert.deepEqual(
        report.candidates[0].layers.map((layer) => layer.layerId),
        [
            'video-benchmark:video-crop-benchmark/latest-summary',
            'video-benchmark:video-crop-benchmark-12mbps/latest-summary'
        ]
    );
    assert.equal(report.candidates[0].summary.layerCount, 2);
});

test('renderVideoDenoiseCandidateGateMarkdown should expose layer and case level details', () => {
    const report = createVideoDenoiseCandidateGateReport({
        reports: [
            {
                reportPath: 'standard.json',
                report: benchmarkReport([
                    {
                        status: 'compared',
                        baselineId: 'case-a',
                        variantId: 'case-a-roi',
                        currentProfile: profile,
                        deltas: deltas({ edge: 'improved' })
                    }
                ])
            }
        ]
    });
    const markdown = renderVideoDenoiseCandidateGateMarkdown(report);

    assert.match(markdown, /Video Denoise Candidate Gate/);
    assert.match(markdown, /promote-default-candidate/);
    assert.match(markdown, /case-a-roi/);
    assert.match(markdown, /edge:-0\.1000 improved/);
});
