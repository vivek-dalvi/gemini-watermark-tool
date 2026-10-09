import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createVideoPolishSweepReviewPack } from '../../scripts/create-video-polish-sweep-review-pack.js';

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('createVideoPolishSweepReviewPack should collect strength sweep comparisons', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-polish-sweep-review-pack');
    await rm(artifactRoot, { recursive: true, force: true });

    const comparisonDir = path.join(artifactRoot, 'comparison');
    await writeJson(path.join(comparisonDir, 'deaee69b-roi-strength-sweep-4up.mp4.json'), {
        outputPath: path.join(comparisonDir, 'deaee69b-roi-strength-sweep-4up.mp4'),
        markdownPath: path.join(comparisonDir, 'deaee69b-roi-strength-sweep-4up.mp4.md'),
        cropBox: { x: 1676, y: 836, width: 200, height: 200 },
        inputs: [
            { label: 's018', path: 'strength018.mp4' },
            { label: 's020', path: 'strength020.mp4' },
            { label: 's022', path: 'strength022.mp4' },
            { label: 's025', path: 'strength025.mp4' }
        ]
    });
    await writeJson(path.join(comparisonDir, 'deaee69b-full-strength-sweep-4up.mp4.json'), {
        outputPath: path.join(comparisonDir, 'deaee69b-full-strength-sweep-4up.mp4'),
        markdownPath: path.join(comparisonDir, 'deaee69b-full-strength-sweep-4up.mp4.md'),
        cropBox: null,
        inputs: []
    });
    await writeJson(path.join(artifactRoot, 'gate/latest-report.json'), {
        candidates: [
            {
                profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.18',
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
        cases: [{ id: 'deaee69b-strength018', aggregate: { meanSameJitter: 9.3 } }]
    });

    const outputPath = path.join(artifactRoot, 'review-pack/latest-sweep-review-pack.json');
    const result = await createVideoPolishSweepReviewPack({ artifactRoot, outputPath });
    const pack = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(result.comparisons, 2);
    assert.equal(result.temporalCases, 1);
    assert.equal(result.gateCandidates, 1);
    assert.equal(pack.title, 'Video Polish Strength Sweep Review');
    assert.equal(pack.delivery.status, 'review-only');
    assert.equal(pack.comparisons[0].caseId, 'deaee69b');
    assert.equal(pack.comparisons[0].kind, 'roi');
    assert.equal(pack.decisionOptions.some((item) => item.value === 'prefer-strength018'), true);
    assert.equal(pack.decisionOptions.some((item) => item.value === 'prefer-strength022'), true);
    assert.equal(pack.checklist.length, 5);
});
