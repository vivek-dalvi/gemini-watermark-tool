import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createVideoUiPresetBatchSummary,
    normalizeBatchInputItems,
    parseCliArgs,
    resolveVideoUiPresetBatchReviewArtifactPath,
    resolveVideoUiPresetBatchItemOptions,
    shouldCreateVideoUiPresetReviewArtifact,
    resolveVideoUiPresetBatchExitCode
} from '../../scripts/verify-video-ui-preset-batch.js';

test('normalizeBatchInputItems should accept strings and manifest case objects', () => {
    const items = normalizeBatchInputItems([
        'a.mp4',
        {
            id: 'sample-b',
            input: 'b.mp4',
            timestamps: [1, 2.5, 4]
        },
        {
            path: 'c.mp4'
        }
    ]);

    assert.deepEqual(items, [
        { id: 'a', inputPath: 'a.mp4', timestamps: null },
        { id: 'sample-b', inputPath: 'b.mp4', timestamps: [1, 2.5, 4] },
        { id: 'c', inputPath: 'c.mp4', timestamps: null }
    ]);
});

test('normalizeBatchInputItems should preserve per-sample gate expectations', () => {
    const [item] = normalizeBatchInputItems([
        {
            id: 'sample-a',
            input: 'a.mp4',
            candidateId: 'veo-720p-3-inset',
            thresholds: {
                maxAllowedConfidence: 0.08,
                minReductionRatio: 0.75
            }
        }
    ]);

    assert.equal(item.candidateId, 'veo-720p-3-inset');
    assert.deepEqual(item.residualThresholds, {
        maxAllowedConfidence: 0.08,
        minReductionRatio: 0.75
    });
});

test('resolveVideoUiPresetBatchItemOptions should let manifest cases override batch defaults', () => {
    const item = {
        id: 'sample-a',
        inputPath: 'a.mp4',
        timestamps: [1, 2.5, 4],
        candidateId: 'veo-720p-3-inset',
        residualThresholds: {
            maxAllowedConfidence: 0.08
        }
    };
    const options = resolveVideoUiPresetBatchItemOptions(item, {
        outputDir: 'out',
        timestamps: [1, 3, 5],
        candidateId: 'fallback-candidate',
        residualThresholds: {
            maxAllowedConfidence: 0.12,
            minReductionRatio: 0.75
        },
        gridLimit: 10,
        gridStep: 8,
        screenshots: false,
        timeoutMs: 420000
    });

    assert.equal(options.inputPath, 'a.mp4');
    assert.match(options.outputDir, /out[\\/]sample-a$/);
    assert.deepEqual(options.timestamps, [1, 2.5, 4]);
    assert.equal(options.candidateId, 'veo-720p-3-inset');
    assert.deepEqual(options.residualThresholds, {
        maxAllowedConfidence: 0.08,
        minReductionRatio: 0.75
    });
});

test('createVideoUiPresetBatchSummary should aggregate pass and review counts', () => {
    const summary = createVideoUiPresetBatchSummary({
        items: [
            {
                id: 'a',
                inputPath: 'a.mp4',
                report: {
                    status: 'pass',
                    reportPath: 'a.json',
                    outputPath: 'a.mp4',
                    fixedAnchor: { candidateId: 'veo-720p-3-inset' },
                    residual: {
                        verdict: {
                            action: 'pass',
                            originalMeanConfidence: 0.75,
                            currentMeanConfidence: 0.01,
                            reductionRatio: 0.986
                        }
                    }
                }
            },
            {
                id: 'b',
                inputPath: 'b.mp4',
                report: {
                    status: 'needs-review',
                    reportPath: 'b.json',
                    outputPath: 'b.mp4',
                    fixedAnchor: { candidateId: 'veo-720p-3-inset' },
                    residual: {
                        verdict: {
                            action: 'needs-review',
                            originalMeanConfidence: 0.75,
                            currentMeanConfidence: 0.12,
                            reductionRatio: 0.84
                        }
                    }
                }
            }
        ],
        outputPath: 'summary.json'
    });

    assert.equal(summary.status, 'needs-review');
    assert.equal(summary.counts.total, 2);
    assert.equal(summary.counts.pass, 1);
    assert.equal(summary.counts.needsReview, 1);
    assert.equal(summary.results[0].fixedAnchor, 'veo-720p-3-inset');
});

test('createVideoUiPresetBatchSummary should include review artifact paths', () => {
    const summary = createVideoUiPresetBatchSummary({
        items: [
            {
                id: 'a',
                inputPath: 'a.mp4',
                reviewArtifactPath: 'review/a.png',
                report: {
                    status: 'needs-review',
                    reportPath: 'a.json',
                    outputPath: 'a-output.mp4',
                    residual: { verdict: { action: 'needs-review' } }
                }
            }
        ],
        outputPath: 'summary.json'
    });

    assert.equal(summary.results[0].reviewArtifactPath, 'review/a.png');
});

test('shouldCreateVideoUiPresetReviewArtifact should only select non-pass items when enabled', () => {
    assert.equal(shouldCreateVideoUiPresetReviewArtifact({ status: 'pass' }, { reviewOnFailure: true }), false);
    assert.equal(shouldCreateVideoUiPresetReviewArtifact({ status: 'needs-review' }, { reviewOnFailure: true }), true);
    assert.equal(shouldCreateVideoUiPresetReviewArtifact({ status: 'fail' }, { reviewOnFailure: true }), true);
    assert.equal(shouldCreateVideoUiPresetReviewArtifact({ status: 'needs-review' }, { reviewOnFailure: false }), false);
});

test('resolveVideoUiPresetBatchReviewArtifactPath should create stable per-item crop sheet paths', () => {
    const outputPath = resolveVideoUiPresetBatchReviewArtifactPath({
        outputDir: 'out',
        itemId: 'sample-a'
    });

    assert.match(outputPath, /out[\\/]sample-a[\\/]sample-a-review-crops\.png$/);
});

test('parseCliArgs should collect multiple inputs and batch options', () => {
    const parsed = parseCliArgs([
        '--input',
        'a.mp4',
        '--input',
        'b.mp4',
        '--manifest',
        'manifest.json',
        '--output-dir',
        'out',
        '--summary',
        'summary.json',
        '--timestamps',
        '1,2.5,4',
        '--review-on-failure',
        '--fail-on-residual',
        '--no-screenshots'
    ]);

    assert.deepEqual(parsed.inputPaths, ['a.mp4', 'b.mp4']);
    assert.equal(parsed.manifestPath, 'manifest.json');
    assert.equal(parsed.outputDir, 'out');
    assert.equal(parsed.summaryPath, 'summary.json');
    assert.deepEqual(parsed.timestamps, [1, 2.5, 4]);
    assert.equal(parsed.reviewOnFailure, true);
    assert.equal(parsed.failOnResidual, true);
    assert.equal(parsed.screenshots, false);
});

test('resolveVideoUiPresetBatchExitCode should fail when any item is not pass', () => {
    assert.equal(resolveVideoUiPresetBatchExitCode({ status: 'pass' }, { failOnResidual: true }), 0);
    assert.equal(resolveVideoUiPresetBatchExitCode({ status: 'needs-review' }, { failOnResidual: true }), 1);
    assert.equal(resolveVideoUiPresetBatchExitCode({ status: 'needs-review' }, { failOnResidual: false }), 0);
});
