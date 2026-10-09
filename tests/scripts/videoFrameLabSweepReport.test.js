import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderVideoFrameLabSweepMarkdown,
    summarizeVideoFrameLabSweep
} from '../../scripts/report-video-frame-lab-sweep.js';

function createReport(strength, cases) {
    return {
        generatedAt: '2026-06-11T00:00:00.000Z',
        reportPath: `.artifacts/video-frame-backend-lab/edge${strength}/latest-report.json`,
        profile: {
            denoiseBackend: 'canvas-edge-denoise',
            edgeDenoiseStrength: strength,
            residualCleanupStrength: 0
        },
        cases
    };
}

function createCase(id, edgeDelta, bodyDelta) {
    return {
        id,
        deltas: {
            active: { meanAbsDelta: 0, verdict: 'neutral' },
            edge: { meanAbsDelta: edgeDelta, verdict: edgeDelta < -0.02 ? 'improved' : 'neutral' },
            lowBody: { meanAbsDelta: bodyDelta, verdict: bodyDelta > 0.02 ? 'regressed' : 'neutral' },
            highBody: { meanAbsDelta: 0, verdict: 'neutral' }
        }
    };
}

test('summarizeVideoFrameLabSweep should prefer stable complete reports', () => {
    const summary = summarizeVideoFrameLabSweep([
        createReport(0.5, [
            createCase('a', -0.03, 0),
            createCase('b', -0.01, 0)
        ]),
        createReport(1, [
            createCase('a', -0.08, 0.04),
            createCase('b', -0.06, 0)
        ])
    ]);

    assert.equal(summary.profiles.length, 2);
    assert.equal(summary.recommendedProfile.profile.edgeDenoiseStrength, 0.5);
    assert.equal(summary.profiles[1].totals.regressed, 1);
});

test('renderVideoFrameLabSweepMarkdown should include recommendation and deltas', () => {
    const summary = summarizeVideoFrameLabSweep([
        createReport(0.65, [
            createCase('4d420881', -0.03, 0)
        ])
    ]);
    const markdown = renderVideoFrameLabSweepMarkdown(summary);

    assert.match(markdown, /# Video Frame Lab Sweep/);
    assert.match(markdown, /Recommended stable profile: canvas-edge-denoise edge=0\.65 cleanup=0/);
    assert.match(markdown, /4d420881/);
    assert.match(markdown, /-0\.0300 \(improved\)/);
});
