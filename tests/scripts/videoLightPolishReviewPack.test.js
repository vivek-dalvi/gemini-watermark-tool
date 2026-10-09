import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createVideoLightPolishReviewPack } from '../../scripts/create-video-light-polish-review-pack.js';

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('createVideoLightPolishReviewPack should collect comparison gate and temporal reports', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-light-polish-review-pack');
    await rm(artifactRoot, { recursive: true, force: true });

    const comparisonDir = path.join(artifactRoot, 'comparison');
    await writeJson(path.join(comparisonDir, 'deaee69b-roi-4up.mp4.json'), {
        outputPath: path.join(comparisonDir, 'deaee69b-roi-4up.mp4'),
        markdownPath: path.join(comparisonDir, 'deaee69b-roi-4up.mp4.md'),
        cropBox: { x: 1676, y: 836, width: 200, height: 200 },
        inputs: [
            { label: 'original', path: 'original.mp4' },
            { label: 'strength025', path: 'strength025.mp4' },
            { label: 'strength020', path: 'strength020.mp4' },
            { label: 'allenk', path: 'allenk.mp4' }
        ]
    });
    await writeJson(path.join(comparisonDir, 'deaee69b-full-4up.mp4.json'), {
        outputPath: path.join(comparisonDir, 'deaee69b-full-4up.mp4'),
        markdownPath: path.join(comparisonDir, 'deaee69b-full-4up.mp4.md'),
        cropBox: null,
        inputs: []
    });
    await writeJson(path.join(artifactRoot, 'gate/latest-report.json'), {
        candidates: [
            {
                profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.2',
                decision: 'promote-default-candidate',
                improvedCases: 2,
                warningLayers: 0,
                materialFailureLayers: 0
            }
        ]
    });
    await writeJson(path.join(artifactRoot, 'temporal-residual/latest-report.json'), {
        generatedAt: '2026-06-11T00:00:00.000Z',
        matchRadius: 2,
        includeVariants: true,
        cases: [{ id: 'deaee69b-strength020', meanSameJitter: 9.3 }]
    });

    const outputPath = path.join(artifactRoot, 'review-pack/latest-polish-review-pack.json');
    const result = await createVideoLightPolishReviewPack({ artifactRoot, outputPath });
    const pack = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(result.comparisons, 2);
    assert.equal(result.temporalCases, 1);
    assert.equal(result.gateCandidates, 1);
    assert.equal(pack.title, 'Video Light Polish Review');
    assert.equal(pack.delivery.status, 'review-only');
    assert.equal(pack.temporal.matchRadius, 2);
    assert.equal(pack.comparisons[0].caseId, 'deaee69b');
    assert.equal(pack.comparisons[0].kind, 'roi');
    assert.equal(pack.decisionOptions.some((item) => item.value === 'prefer-light'), true);
    assert.equal(pack.checklist.length, 5);
});
