import test from 'node:test';
import assert from 'node:assert/strict';

import { renderVideoCropBenchmarkMarkdown } from '../../scripts/report-video-crop-benchmark.js';

test('renderVideoCropBenchmarkMarkdown should include cases, variant deltas, and recommendation', () => {
    const markdown = renderVideoCropBenchmarkMarkdown({
        generatedAt: '2026-06-10T00:00:00.000Z',
        summary: {
            rendered: 2,
            total: 2,
            failed: 0
        },
        results: [
            {
                id: 'case-a',
                status: 'rendered-comparison',
                currentProfile: { denoiseBackend: 'none' },
                outputPath: '.artifacts/video-crop-benchmark/case-a.png',
                residualMetrics: {
                    aggregate: {
                        active: { meanAbs: 4, rms: 8 },
                        edge: { meanAbs: 6, rms: 10 },
                        lowBody: { meanAbs: 5, rms: 7 },
                        highBody: { meanAbs: 3, rms: 4 }
                    }
                }
            },
            {
                id: 'case-a-edge',
                status: 'rendered-comparison',
                currentProfile: {
                    denoiseBackend: 'canvas-edge-denoise',
                    edgeDenoiseStrength: 0.65
                },
                outputPath: '.artifacts/video-crop-benchmark/case-a-edge.png',
                residualMetrics: {
                    aggregate: {
                        active: { meanAbs: 3.9, rms: 7.9 },
                        edge: { meanAbs: 5.8, rms: 9.8 },
                        lowBody: { meanAbs: 5.2, rms: 7.1 },
                        highBody: { meanAbs: 3.1, rms: 4.2 }
                    }
                }
            }
        ],
        variantComparisons: [
            {
                baselineId: 'case-a',
                variantId: 'case-a-edge',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'canvas-edge-denoise',
                    edgeDenoiseStrength: 0.65
                },
                deltas: {
                    active: { meanAbsDelta: -0.1, rmsDelta: -0.1, meanDelta: 0, verdict: 'improved' },
                    edge: { meanAbsDelta: -0.2, rmsDelta: -0.2, meanDelta: 0, verdict: 'improved' },
                    lowBody: { meanAbsDelta: 0.2, rmsDelta: 0.1, meanDelta: 0, verdict: 'regressed' },
                    highBody: { meanAbsDelta: 0.1, rmsDelta: 0.2, meanDelta: 0, verdict: 'regressed' }
                }
            }
        ]
    });

    assert.match(markdown, /# Video Crop Benchmark Report/);
    assert.match(markdown, /Recommendation:/);
    assert.match(markdown, /case-a-edge/);
    assert.match(markdown, /-0\.2000 \(improved\)/);
    assert.match(markdown, /0\.65/);
});

test('renderVideoCropBenchmarkMarkdown should reject edge-band variants with video-level regressions', () => {
    const markdown = renderVideoCropBenchmarkMarkdown({
        generatedAt: '2026-06-10T00:00:00.000Z',
        summary: {
            rendered: 2,
            total: 2,
            failed: 0
        },
        results: [],
        variantComparisons: [
            {
                baselineId: 'case-a',
                variantId: 'case-a-edge-band',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'canvas-edge-band-denoise',
                    edgeDenoiseStrength: 0.8
                },
                deltas: {
                    active: { meanAbsDelta: 0.08, verdict: 'regressed' },
                    edge: { meanAbsDelta: -0.03, verdict: 'improved' },
                    lowBody: { meanAbsDelta: 0.01, verdict: 'neutral' },
                    highBody: { meanAbsDelta: 0.03, verdict: 'regressed' }
                }
            },
            {
                baselineId: 'case-b',
                variantId: 'case-b-edge-band',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'canvas-edge-band-denoise',
                    edgeDenoiseStrength: 0.5
                },
                deltas: {
                    active: { meanAbsDelta: -0.01, verdict: 'neutral' },
                    edge: { meanAbsDelta: -0.02, verdict: 'neutral' },
                    lowBody: { meanAbsDelta: 0.05, verdict: 'regressed' },
                    highBody: { meanAbsDelta: 0.01, verdict: 'neutral' }
                }
            }
        ]
    });

    assert.match(markdown, /edge-band denoise did not survive video-level validation/);
    assert.match(markdown, /no registered edge-band strength is regression-free/);
    assert.match(markdown, /case-a-edge-band/);
});

test('renderVideoCropBenchmarkMarkdown should recommend warning-only candidates as usable with review', () => {
    const markdown = renderVideoCropBenchmarkMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        summary: {
            rendered: 4,
            total: 4,
            failed: 0
        },
        results: [],
        variantComparisons: [
            {
                baselineId: 'case-a',
                variantId: 'case-a-policy',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'none',
                    alphaEdgePolicy: 'standard045-inset035'
                },
                deltas: {
                    active: { meanAbsDelta: -0.2, verdict: 'improved' },
                    edge: { meanAbsDelta: 0.01, verdict: 'neutral' },
                    lowBody: { meanAbsDelta: 0.3, verdict: 'regressed' },
                    highBody: { meanAbsDelta: -0.3, verdict: 'improved' }
                },
                riskNotes: [
                    {
                        code: 'sparse-low-body-regression',
                        severity: 'warning',
                        bucket: 'lowBody'
                    }
                ]
            },
            {
                baselineId: 'case-b',
                variantId: 'case-b-policy',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'none',
                    alphaEdgePolicy: 'standard045-inset035'
                },
                deltas: {
                    active: { meanAbsDelta: 0, verdict: 'neutral' },
                    edge: { meanAbsDelta: 0, verdict: 'neutral' },
                    lowBody: { meanAbsDelta: 0, verdict: 'neutral' },
                    highBody: { meanAbsDelta: 0, verdict: 'neutral' }
                },
                riskNotes: []
            }
        ]
    });

    assert.match(markdown, /usable with warning-level risk/);
    assert.match(markdown, /sparse-low-body-regression/);
});

test('renderVideoCropBenchmarkMarkdown should recommend regression-free candidates distinctly', () => {
    const markdown = renderVideoCropBenchmarkMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        summary: {
            rendered: 2,
            total: 2,
            failed: 0
        },
        results: [],
        variantComparisons: [
            {
                baselineId: 'case-a',
                variantId: 'case-a-policy',
                status: 'compared',
                currentProfile: {
                    denoiseBackend: 'none',
                    alphaEdgePolicy: 'standard045-inset035'
                },
                deltas: {
                    active: { meanAbsDelta: -0.2, verdict: 'improved' },
                    edge: { meanAbsDelta: -0.1, verdict: 'improved' },
                    lowBody: { meanAbsDelta: -0.05, verdict: 'improved' },
                    highBody: { meanAbsDelta: -0.3, verdict: 'improved' }
                },
                riskNotes: []
            }
        ]
    });

    assert.match(markdown, /regression-free on this benchmark set/);
    assert.doesNotMatch(markdown, /warning-level risk/);
});
