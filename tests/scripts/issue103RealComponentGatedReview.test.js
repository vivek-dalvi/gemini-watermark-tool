import { strict as assert } from 'node:assert';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { createIssue103RealComponentGatedReview } from '../../scripts/create-issue103-real-component-gated-review.js';

test('createIssue103RealComponentGatedReview should write report and review crops', async () => {
    const tempRoot = path.resolve('.artifacts/test-tmp');
    await mkdir(tempRoot, { recursive: true });
    const outputDir = path.join(tempRoot, `issue103-real-review-${Date.now()}`);
    const inputPath = path.join(outputDir, 'input.png');

    try {
        await mkdir(outputDir, { recursive: true });
        await sharp({
            create: {
                width: 256,
                height: 256,
                channels: 4,
                background: { r: 32, g: 228, b: 4, alpha: 1 }
            }
        }).png().toFile(inputPath);

        const { reportPath, sheetPath, report } = await createIssue103RealComponentGatedReview({
            inputPath,
            outputDir,
            position: { x: 80, y: 80, width: 96, height: 96 }
        });

        assert.equal(report.position.width, 96);
        assert.equal(typeof report.gatedDecision.adopted, 'boolean');
        assert.equal(report.columns.includes('component-gated'), true);
        await stat(reportPath);
        await stat(sheetPath);
        await stat(report.paths.inputCrop);
        await stat(report.paths.inverseCrop);
        await stat(report.paths.paletteSnapCrop);
        await stat(report.paths.componentGatedCrop);
        await stat(report.paths.componentMap);
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});
