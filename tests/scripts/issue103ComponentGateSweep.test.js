import { strict as assert } from 'node:assert';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { createIssue103ComponentGateSweep } from '../../scripts/create-issue103-component-gate-sweep.js';

test('createIssue103ComponentGateSweep should write candidate report and crop sheet', async () => {
    const tempRoot = path.resolve('.artifacts/test-tmp');
    await mkdir(tempRoot, { recursive: true });
    const outputDir = path.join(tempRoot, `issue103-gate-sweep-${Date.now()}`);
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

        const { reportPath, sheetPath, report } = await createIssue103ComponentGateSweep({
            inputPath,
            outputDir,
            position: { x: 80, y: 80, width: 96, height: 96 },
            candidates: [
                { id: 'strict', minArea: 256, minFillRatio: 0.84, requireBoundary: true },
                { id: 'loose', minArea: 64, minFillRatio: 0.35, requireBoundary: false }
            ]
        });

        assert.equal(report.candidates.length, 2);
        assert.deepEqual(report.columns.slice(0, 3), ['input', 'inverse', 'palette-snap']);
        await stat(reportPath);
        await stat(sheetPath);
        await stat(report.paths.inputCrop);
        await stat(report.paths.inverseCrop);
        await stat(report.paths.paletteSnapCrop);
        for (const candidate of report.candidates) {
            assert.equal(typeof candidate.gatedDecision.adopted, 'boolean');
            await stat(candidate.paths.crop);
            await stat(candidate.paths.componentMap);
        }
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});
