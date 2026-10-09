import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
    createAllenkV2ComparisonReport,
    renderAllenkV2ComparisonMarkdown,
    summarizeAllenkV2ComparisonGate
} from '../../scripts/create-allenk-v2-comparison-report.js';

const ALLENK_HEAD = '632348868da0653d5c1e99680d2c448f4d8505eb';

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createProjectTempDir(prefix) {
    const root = path.join(process.cwd(), '.artifacts', 'test-tmp');
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, prefix));
}

async function writeFailingGitShim(tempDir) {
    const binDir = path.join(tempDir, 'bin');
    await mkdir(binDir, { recursive: true });
    if (process.platform === 'win32') {
        const gitCmd = path.join(binDir, 'git.cmd');
        await writeFile(gitCmd, '@echo off\r\nexit /b 1\r\n', 'utf8');
        return binDir;
    }
    const gitPath = path.join(binDir, 'git');
    await writeFile(gitPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(gitPath, 0o755);
    return binDir;
}

async function createFixture({
    includeVideoReference = true,
    includeVideoOutputArtifact = true,
    imageV2Selected = 1,
    imageV2Cleanup = 1,
    imageV2Records = null,
    denoisePromoted = false,
    alphaPromoted = false
} = {}) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-allenk-v2-comparison-'));
    const imageV2Summary = path.join(tempDir, 'image-v2-summary.json');
    const videoCropBenchmark = path.join(tempDir, 'video-crop-benchmark.json');
    const videoDenoiseGate = path.join(tempDir, 'video-denoise-gate.json');
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    const allenkRepo = path.join(tempDir, 'GeminiWatermarkTool');
    const renderedComparisonPath = path.join(tempDir, '4d420881.png');
    await mkdir(allenkRepo, { recursive: true });
    if (includeVideoReference && includeVideoOutputArtifact) {
        await writeFile(renderedComparisonPath, 'fake png artifact\n', 'utf8');
    }

    const defaultImageV2Records = [
        {
            file: '2026-06-09/sample.png',
            bucket: 'pass',
            applied: true,
            source: 'standard+catalog+validated+v2-small-edge-cleanup',
            config: { logoSize: 36, marginRight: 71, marginBottom: 71, alphaVariant: 'v2' },
            detection: {
                processedSpatialScore: 0.058,
                processedGradientScore: -0.051
            }
        }
    ];

    await writeJson(imageV2Summary, {
        summary: {
            total: 189,
            applied: 152,
            pass: 66,
            residual: 86,
            v2Selected: imageV2Selected,
            v2Cleanup: imageV2Cleanup
        },
        v2Records: imageV2Records || defaultImageV2Records
    });

    await writeJson(videoCropBenchmark, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        results: includeVideoReference
            ? [
                {
                    id: '4d420881',
                    label: 'current vs allenk',
                    status: 'rendered-comparison',
                    outputPath: renderedComparisonPath,
                    currentProfile: {
                        algorithm: 'gwr-video-mvp',
                        alphaProfile: 'edgeboost045',
                        denoiseBackend: 'none'
                    },
                    referenceProfile: {
                        algorithm: 'allenk',
                        version: '0.6.2',
                        denoiseBackend: 'ncnn'
                    },
                    paths: {
                        reference: path.join(tempDir, '4d420881-allenk-v062.mp4')
                    },
                    metrics: {
                        currentVsReference: { meanAbsDeltaPerChannel: 3.2 },
                        originalVsReference: { meanAbsDeltaPerChannel: 4.9 }
                    },
                    residualMetrics: {
                        aggregate: {
                            active: { mean: 0.44, meanAbs: 1.31, rms: 2.01 },
                            edge: { mean: -0.21, meanAbs: 1.26, rms: 1.91 },
                            lowBody: { mean: -0.11, meanAbs: 1.87, rms: 2.74 },
                            highBody: { mean: 0.71, meanAbs: 1.33, rms: 2.04 }
                        }
                    }
                }
            ]
            : []
    });

    await writeJson(videoDenoiseGate, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        requiredLayerCount: 3,
        layers: [{ id: 'frame-lab:latest-report' }, { id: 'video-benchmark:latest-summary' }],
        candidates: denoisePromoted
            ? [{ profileLabel: 'ml-roi-denoise', decision: 'promote-default-candidate' }]
            : [
                { profileLabel: 'canvas-edge-denoise, strength=0.65', decision: 'reject' },
                { profileLabel: 'none, alphaEdgePolicy=standard045-inset035', decision: 'insufficient-evidence' }
            ]
    });

    await writeJson(path.join(alphaRoot, 'candidate-a', 'latest-report.json'), {
        result: {
            totalCommonCandidates: 10,
            promotedCount: alphaPromoted ? 1 : 0,
            rejectedByVideoCount: alphaPromoted ? 0 : 2,
            topCandidates: [
                {
                    name: 'candidate-a',
                    fitGate: { verdict: 'fit-pass' },
                    videoGate: {
                        verdict: alphaPromoted ? 'candidate-visual-review' : 'rejected-video-regression',
                        regressions: alphaPromoted ? [] : [{ bucket: 'active' }]
                    }
                }
            ]
        }
    });

    return {
        imageV2Summary,
        videoCropBenchmark,
        videoDenoiseGate,
        videoAlphaShapeGateRoot: alphaRoot,
        allenkRepo
    };
}

test('createAllenkV2ComparisonReport should keep current image V2 guarded while blocking video allenk parity', async () => {
    const inputs = await createFixture();
    const report = await createAllenkV2ComparisonReport({
        inputs: {
            ...inputs,
            allenkLocalHead: ALLENK_HEAD,
            allenkRemoteHead: ALLENK_HEAD
        }
    });

    assert.equal(report.overall.status, 'current-gap-known');
    assert.equal(report.overall.comparisonEvidenceReady, true);
    assert.equal(report.overall.canClaimImageV2SmallGuarded, true);
    assert.equal(report.overall.canClaimBroadImageV2Coverage, false);
    assert.equal(report.overall.canClaimVideoAllenkParity, false);
    assert.ok(report.overall.blockedClaims.includes('video-v2-allenk-parity'));
    assert.ok(report.overall.blockedClaims.includes('new-video-denoise-default'));
    assert.ok(report.overall.blockedClaims.includes('new-video-alpha-shape-default'));
    assert.equal(report.imageV2.status, 'guarded-release');
    assert.deepEqual(report.imageV2.knownGaps, ['v2-36-core-gray-shadow-needs-render-composite-model']);
    assert.equal(report.imageV2.evidence.v2RecordCount, 1);
    assert.equal(report.imageV2.evidence.passingCleanupRecordCount, 1);
    assert.equal(report.videoBenchmark.status, 'compared');
    assert.equal(report.videoBenchmark.evidence.allenkCaseCount, 1);
    assert.equal(report.videoBenchmark.evidence.missingOutputArtifactCount, 0);
    assert.equal(report.videoBenchmark.evidence.meanCurrentVsAllenkMeanAbs, 3.2);
    assert.equal(report.videoBenchmark.evidence.currentCloserThanOriginalCount, 1);
    assert.equal(report.provenance.sourceArtifacts.length, 5);
    assert.deepEqual(
        report.provenance.sourceArtifacts.map((item) => item.id),
        [
            'allenk-v2-comparison-script',
            'image-v2-summary',
            'video-crop-benchmark',
            'video-denoise-gate',
            'video-alpha-shape:candidate-a'
        ]
    );
    assert.ok(report.provenance.sourceArtifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
    assert.equal(summarizeAllenkV2ComparisonGate(report).ok, true);
    assert.deepEqual(report.overall.comparisonGate, {
        ok: true,
        requiredStatus: 'current-gap-known',
        actualStatus: 'current-gap-known',
        blockers: []
    });

    const markdown = renderAllenkV2ComparisonMarkdown(report);
    assert.match(markdown, /Gate Summary/);
    assert.match(markdown, /Gate: pass/);
    assert.match(markdown, /Required status: current-gap-known/);
    assert.match(markdown, /Actual status: current-gap-known/);
    assert.match(markdown, /video-v2-allenk-parity/);
    assert.match(markdown, /Image V2 36 Evidence/);
    assert.match(markdown, /v2 selected: 1, v2 cleanup: 1, v2 records: 1/);
    assert.match(markdown, /2026-06-09\/sample\.png \| pass \| 36\/71\/71\/v2/);
    assert.match(markdown, /v2-36-core-gray-shadow-needs-render-composite-model/);
    assert.match(markdown, /missing rendered artifacts: 0/);
    assert.match(markdown, /mean current\/allenk ROI abs delta: 3.2/);
    assert.match(markdown, /Video allenk Case Gaps/);
    assert.match(markdown, /4d420881 \| gwr-video-mvp \/ edgeboost045 \/ denoise=none \| 3.2 \| 4.9 \| yes \| lowBody \(1.87\)/);
    assert.match(markdown, /Source Provenance/);
});

test('createAllenkV2ComparisonReport should block inconsistent image V2 36 summary counts', async () => {
    const inputs = await createFixture({
        imageV2Selected: 2,
        imageV2Cleanup: 1
    });
    const report = await createAllenkV2ComparisonReport({
        inputs: {
            ...inputs,
            allenkLocalHead: ALLENK_HEAD,
            allenkRemoteHead: ALLENK_HEAD
        }
    });

    assert.equal(report.imageV2.status, 'missing-evidence');
    assert.ok(report.imageV2.blockers.includes('image-v2-36-record-count-mismatch'));
    assert.equal(report.overall.status, 'missing-evidence');
    assert.equal(summarizeAllenkV2ComparisonGate(report).ok, false);

    const markdown = renderAllenkV2ComparisonMarkdown(report);
    assert.match(markdown, /image V2 36 \| missing-evidence \| image-v2-36-record-count-mismatch/);
    assert.match(markdown, /v2 selected: 2, v2 cleanup: 1, v2 records: 1/);
});

test('createAllenkV2ComparisonReport should require rendered comparison image artifacts to exist', async () => {
    const inputs = await createFixture({ includeVideoOutputArtifact: false });
    const report = await createAllenkV2ComparisonReport({
        inputs: {
            ...inputs,
            allenkLocalHead: ALLENK_HEAD,
            allenkRemoteHead: ALLENK_HEAD
        }
    });

    assert.equal(report.overall.status, 'missing-evidence');
    assert.equal(report.overall.comparisonEvidenceReady, false);
    assert.equal(report.videoBenchmark.status, 'incomplete');
    assert.equal(report.videoBenchmark.evidence.missingOutputArtifactCount, 1);
    assert.deepEqual(report.videoBenchmark.evidence.missingOutputArtifactCases, ['4d420881']);
    assert.ok(report.videoBenchmark.blockers.includes('video-allenk-rendered-artifacts-missing'));
    assert.equal(summarizeAllenkV2ComparisonGate(report).ok, false);

    const markdown = renderAllenkV2ComparisonMarkdown(report);
    assert.match(markdown, /missing rendered artifacts: 1/);
    assert.match(markdown, /video-allenk-rendered-artifacts-missing/);
});

test('createAllenkV2ComparisonReport should require rendered allenk video comparison evidence', async () => {
    const inputs = await createFixture({ includeVideoReference: false });
    const report = await createAllenkV2ComparisonReport({
        inputs: {
            ...inputs,
            allenkLocalHead: ALLENK_HEAD,
            allenkRemoteHead: ALLENK_HEAD
        }
    });

    assert.equal(report.overall.status, 'missing-evidence');
    assert.equal(report.overall.comparisonEvidenceReady, false);
    assert.equal(report.videoBenchmark.status, 'incomplete');
    assert.ok(report.videoBenchmark.blockers.includes('video-allenk-reference-cases-missing'));
    assert.ok(report.videoBenchmark.blockers.includes('video-allenk-rendered-comparisons-missing'));
    const gate = summarizeAllenkV2ComparisonGate(report);
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.blockers, [
        'allenk-v2-comparison-not-current-gap-known',
        'allenk-v2-comparison-evidence-incomplete'
    ]);
    assert.deepEqual(report.overall.comparisonGate, gate);

    const markdown = renderAllenkV2ComparisonMarkdown(report);
    assert.match(markdown, /Gate: fail/);
    assert.match(markdown, /Gate blockers: allenk-v2-comparison-not-current-gap-known, allenk-v2-comparison-evidence-incomplete/);
});

test('createAllenkV2ComparisonReport should only allow video parity when video gates are promoted', async () => {
    const inputs = await createFixture({ denoisePromoted: true, alphaPromoted: true });
    const report = await createAllenkV2ComparisonReport({
        inputs: {
            ...inputs,
            allenkLocalHead: ALLENK_HEAD,
            allenkRemoteHead: ALLENK_HEAD
        }
    });

    assert.equal(report.overall.status, 'current-gap-known');
    assert.equal(report.overall.canClaimVideoAllenkParity, true);
    assert.ok(!report.overall.blockedClaims.includes('video-v2-allenk-parity'));
    assert.ok(!report.overall.blockedClaims.includes('new-video-denoise-default'));
    assert.ok(!report.overall.blockedClaims.includes('new-video-alpha-shape-default'));
});

test('allenk V2 comparison CLI should exit non-zero with --fail-on-incomplete when evidence is missing', async () => {
    const tempDir = await createProjectTempDir('allenk-v2-comparison-cli-');
    const fakeGitBin = await writeFailingGitShim(tempDir);
    const reportPath = path.join(tempDir, 'report.json');
    const markdownPath = path.join(tempDir, 'report.md');
    const scriptPath = path.resolve('scripts/create-allenk-v2-comparison-report.js');

    const result = spawnSync(process.execPath, [
        scriptPath,
        '--output',
        reportPath,
        '--markdown',
        markdownPath,
        '--fail-on-incomplete'
    ], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fakeGitBin}${path.delimiter}${process.env.PATH || ''}`
        }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /status: missing-evidence/);
    assert.match(result.stdout, /allenk comparison gate: fail/);
    assert.match(result.stderr, /allenk comparison gate blockers:/);

    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.overall.status, 'missing-evidence');
    assert.equal(report.overall.comparisonEvidenceReady, false);
});
