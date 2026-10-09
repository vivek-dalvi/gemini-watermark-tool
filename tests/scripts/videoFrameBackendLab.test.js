import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateBucketDeltas,
    renderVideoFrameBackendLabMarkdown
} from '../../scripts/run-video-frame-backend-lab.js';

test('calculateBucketDeltas should classify per-bucket improvement and regression', () => {
    const deltas = calculateBucketDeltas({
        active: { meanAbs: 3.9, rms: 7.8, mean: 0.8 },
        edge: { meanAbs: 5.5, rms: 9.5, mean: 0.2 },
        lowBody: { meanAbs: 6.1, rms: 8.9, mean: 0.4 },
        highBody: { meanAbs: 3.02, rms: 5.1, mean: 0.9 }
    }, {
        active: { meanAbs: 4, rms: 8, mean: 1 },
        edge: { meanAbs: 5.7, rms: 10, mean: 0.5 },
        lowBody: { meanAbs: 6, rms: 9, mean: 0.5 },
        highBody: { meanAbs: 3, rms: 5, mean: 1 }
    });

    assert.equal(deltas.active.verdict, 'improved');
    assert.equal(deltas.edge.verdict, 'improved');
    assert.equal(deltas.lowBody.verdict, 'regressed');
    assert.equal(deltas.highBody.verdict, 'neutral');
});

test('renderVideoFrameBackendLabMarkdown should include profile and sheet paths', () => {
    const markdown = renderVideoFrameBackendLabMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        profile: {
            denoiseBackend: 'canvas-edge-denoise',
            edgeDenoiseStrength: 0.65,
            residualCleanupStrength: 0
        },
        cases: [
            {
                id: 'case-a',
                sheetPath: '.artifacts/video-frame-backend-lab/case-a.png',
                baselineAggregate: {
                    active: { meanAbs: 4, rms: 8 },
                    edge: { meanAbs: 6, rms: 10 },
                    lowBody: { meanAbs: 5, rms: 7 },
                    highBody: { meanAbs: 3, rms: 4 }
                },
                variantAggregate: {
                    active: { meanAbs: 3.9, rms: 7.8 },
                    edge: { meanAbs: 5.8, rms: 9.5 },
                    lowBody: { meanAbs: 5.1, rms: 7.2 },
                    highBody: { meanAbs: 3, rms: 4 }
                },
                deltas: {
                    active: { meanAbsDelta: -0.1, verdict: 'improved' },
                    edge: { meanAbsDelta: -0.2, verdict: 'improved' },
                    lowBody: { meanAbsDelta: 0.1, verdict: 'regressed' },
                    highBody: { meanAbsDelta: 0, verdict: 'neutral' }
                }
            }
        ]
    });

    assert.match(markdown, /# Video Frame Backend Lab/);
    assert.match(markdown, /canvas-edge-denoise/);
    assert.match(markdown, /case-a/);
    assert.match(markdown, /-0\.2000/);
    assert.match(markdown, /video-frame-backend-lab\/case-a\.png/);
});
