import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { runSameAnchorImperfectionReview } from '../../scripts/run-same-anchor-imperfection-review.js';

function createImageData(width, height, value) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }
    return { width, height, data };
}

async function exists(filePath) {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

test('runSameAnchorImperfectionReview should emit one matched triplet from residual-risk input', async (t) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'gwr-imperfection-review-'));
    t.after(() => rm(tempRoot, { recursive: true, force: true }));
    const inputPath = path.join(tempRoot, 'input.png');
    await sharp({
        create: {
            width: 32,
            height: 32,
            channels: 4,
            background: '#808080'
        }
    })
        .png()
        .toFile(inputPath);
    const reportPath = path.join(tempRoot, 'combined-report.json');
    await writeFile(
        reportPath,
        JSON.stringify({
            generatedAt: '2026-07-16T00:00:00.000Z',
            results: [
                {
                    fileName: 'input.png',
                    input: inputPath,
                    classification: 'residual-risk'
                },
                {
                    fileName: 'ignored.png',
                    input: inputPath,
                    classification: 'applied-clean'
                }
            ]
        })
    );
    const makeCandidate = (id, score, value) => ({
        hypothesis: {
            id,
            family: 'alpha',
            trial: {
                position: { x: 8, y: 8, width: 16, height: 16 },
                source: id
            }
        },
        result: {
            imageData: createImageData(32, 32, value),
            meta: {}
        },
        qualitySignals: {
            qualityStatus: 'visible-residual',
            evidenceLoss: 0.1,
            residualLoss: score,
            damageLoss: 0.1,
            imperfections: {
                score,
                severity: 'high',
                types: ['spatial-residual']
            }
        }
    });
    let processCalls = 0;
    const outputDir = path.join(tempRoot, 'out');

    const result = await runSameAnchorImperfectionReview({
        reportPath,
        outputDir,
        processImageData: (imageData, options) => {
            processCalls += 1;
            options.onCandidateCompleted(makeCandidate('selected', 1.2, 100));
            options.onCandidateCompleted(makeCandidate('alternative', 0.4, 120));
            return {
                imageData,
                meta: { selectedCandidate: { id: 'selected' } },
                debugTimings: { totalMs: 1 }
            };
        }
    });

    assert.equal(processCalls, 1);
    assert.equal(result.summary.residualRiskInputs, 1);
    assert.equal(result.summary.matched, 1);
    assert.equal(result.records[0].alternative.id, 'alternative');
    assert.equal(await exists(result.records[0].tripletPath), true);
    assert.equal(await exists(path.join(outputDir, 'contact-sheet.png')), true);
    assert.equal(await exists(path.join(outputDir, 'report.json')), true);
    const review = JSON.parse(await readFile(path.join(outputDir, 'review.json'), 'utf8'));
    assert.equal(review.decisions.length, 1);
    assert.equal(review.decisions[0].verdict, 'unclear');
    assert.equal(JSON.stringify(result).includes('imageData'), false);
});
