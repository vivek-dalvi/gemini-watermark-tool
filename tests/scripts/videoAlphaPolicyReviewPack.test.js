import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createAlphaPolicyReviewJobs,
    createAlphaPolicyReviewPack,
    createVideoAlphaPolicyReviewPack
} from '../../scripts/create-video-alpha-policy-review-pack.js';

function manifest() {
    return {
        cases: [
            {
                id: 'case-a-baseline-12mbps',
                originalPath: 'original-a.mp4',
                currentPath: 'baseline-a.mp4',
                referencePath: 'allenk-a.mp4',
                expected: { anchor: { x: 1704, y: 864, size: 72 } }
            },
            {
                id: 'case-a-alpha-policy035-12mbps',
                originalPath: 'original-a.mp4',
                currentPath: 'policy-a.mp4',
                referencePath: 'allenk-a.mp4',
                expected: { anchor: { x: 1704, y: 864, size: 72 } }
            },
            {
                id: 'case-b-baseline-12mbps',
                originalPath: 'original-b.mp4',
                currentPath: 'baseline-b.mp4',
                referencePath: 'allenk-b.mp4',
                expected: { anchor: { x: 1740, y: 900, size: 72 } }
            },
            {
                id: 'case-b-alpha-policy035-12mbps',
                originalPath: 'original-b.mp4',
                currentPath: 'policy-b.mp4',
                referencePath: 'allenk-b.mp4',
                expected: { anchor: { x: 1740, y: 900, size: 72 } }
            }
        ]
    };
}

test('createAlphaPolicyReviewJobs should pair baseline and policy videos with ROI crops', () => {
    const jobs = createAlphaPolicyReviewJobs({
        manifest: manifest(),
        artifactRoot: '.artifacts/test-alpha-policy-review'
    });

    assert.equal(jobs.length, 4);
    assert.equal(jobs[0].caseId, 'case-a');
    assert.equal(jobs[0].kind, 'roi');
    assert.deepEqual(jobs[0].cropBox, { x: 1676, y: 836, width: 200, height: 200 });
    assert.deepEqual(jobs[0].inputs.map((item) => item.label), ['original', 'baseline edge045', 'policy035', 'allenk']);
    assert.match(jobs[1].outputPath, /case-a-full-policy035-4up\.mp4$/);
    assert.deepEqual(jobs[2].cropBox, { x: 1712, y: 872, width: 200, height: 200 });
});

test('createAlphaPolicyReviewPack should preserve evidence status and missing-video blockers', () => {
    const jobs = createAlphaPolicyReviewJobs({
        manifest: manifest(),
        artifactRoot: '.artifacts/test-alpha-policy-review'
    });
    const pack = createAlphaPolicyReviewPack({
        jobs,
        evidence: {
            outputPath: 'evidence.json',
            decision: {
                status: 'candidate-aware-human-review',
                reason: 'raw-benchmark-has-material-regression-but-aware-benchmarks-downgrade-or-clear-it'
            },
            total: { comparedCases: 18, improvedCases: 12 }
        },
        artifactRoot: '.artifacts/test-alpha-policy-review'
    });

    assert.equal(pack.title, 'Video Alpha Policy 0.35 Review');
    assert.equal(pack.delivery.status, 'review-only');
    assert.equal(pack.delivery.ready, false);
    assert.equal(pack.delivery.bestCandidate.decision, 'candidate-aware-human-review');
    assert.equal(pack.comparisons.length, 4);
    assert.ok(pack.delivery.blockers.includes('missing-case-a-roi-video'));
    assert.ok(pack.checklist.some((item) => item.includes('policy035')));
    assert.equal(pack.decisionOptions.some((item) => item.value === 'prefer-alpha-policy035'), true);
});

test('createAlphaPolicyReviewPack should expose temporal residual report cases', () => {
    const jobs = createAlphaPolicyReviewJobs({
        manifest: manifest(),
        artifactRoot: '.artifacts/test-alpha-policy-review'
    });
    const pack = createAlphaPolicyReviewPack({
        jobs,
        temporalReportPath: '.artifacts/test-alpha-policy-review/temporal-residual/latest-report.json',
        temporal: {
            generatedAt: '2026-06-11T16:04:22.961Z',
            matchRadius: 2,
            includeVariants: true,
            cases: [
                {
                    id: 'case-a-alpha-policy035-12mbps',
                    sheetPath: '.artifacts/test-alpha-policy-review/temporal-residual/case-a.png',
                    pairs: [{ from: 1, to: 3 }, { from: 3, to: 5 }],
                    aggregate: {
                        n: 144,
                        meanSameJitter: 9.25,
                        meanMatchedJitter: 10.5,
                        improvement: -1.25,
                        meanMatchCost: 15.75,
                        improvedRatio: 0.33,
                        worsenedRatio: 0.42
                    }
                }
            ]
        },
        artifactRoot: '.artifacts/test-alpha-policy-review'
    });

    assert.equal(pack.temporal.matchRadius, 2);
    assert.equal(pack.temporal.includeVariants, true);
    assert.equal(pack.temporal.cases.length, 1);
    assert.equal(pack.temporal.cases[0].pairCount, 2);
    assert.equal(pack.temporal.cases[0].pixelPairCount, 144);
    assert.equal(pack.temporal.cases[0].meanMatchedJitter, 10.5);
    assert.match(pack.temporal.reportPath, /temporal-residual[\\/]latest-report\.json$/);
    assert.match(pack.temporal.markdownPath, /temporal-residual[\\/]latest-report\.md$/);
});

test('createVideoAlphaPolicyReviewPack should write pack JSON without rendering when requested', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-alpha-policy-review');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const manifestPath = path.join(artifactRoot, 'manifest.json');
    const evidencePath = path.join(artifactRoot, 'evidence.json');
    const temporalPath = path.join(artifactRoot, 'temporal.json');
    const outputPath = path.join(artifactRoot, 'review-pack.json');
    await writeFile(manifestPath, JSON.stringify(manifest(), null, 2), 'utf8');
    await writeFile(evidencePath, JSON.stringify({
        outputPath: evidencePath,
        decision: { status: 'candidate-aware-human-review' },
        total: { comparedCases: 4 }
    }), 'utf8');
    await writeFile(temporalPath, JSON.stringify({
        generatedAt: '2026-06-11T16:04:22.961Z',
        matchRadius: 2,
        includeVariants: true,
        cases: [
            {
                id: 'case-a-alpha-policy035-12mbps',
                sheetPath: path.join(artifactRoot, 'case-a-temporal.png'),
                pairs: [{ from: 1, to: 3 }],
                aggregate: {
                    n: 72,
                    meanSameJitter: 8,
                    meanMatchedJitter: 9,
                    improvement: -1,
                    worsenedRatio: 0.4
                }
            }
        ]
    }), 'utf8');

    const result = await createVideoAlphaPolicyReviewPack({
        manifestPath,
        evidenceReportPath: evidencePath,
        temporalReportPath: temporalPath,
        artifactRoot,
        outputPath,
        skipRender: true
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(result.comparisons, 4);
    assert.equal(result.temporalCases, 1);
    assert.equal(result.ready, false);
    assert.equal(saved.delivery.bestCandidate.profileLabel, 'alphaEdgePolicy=standard045-inset035');
    assert.equal(saved.delivery.bestCandidate.decision, 'candidate-aware-human-review');
    assert.equal(saved.temporal.cases[0].pairCount, 1);
    assert.match(saved.comparisons[0].outputPath, /case-a-roi-policy035-4up\.mp4$/);
});
