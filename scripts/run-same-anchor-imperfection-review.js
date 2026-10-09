import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { removeWatermarkFromImageDataSync } from '../src/sdk/image-data.js';
import {
    getCandidatePosition,
    hasSameAnchor,
    selectSameAnchorAlternative
} from './same-anchor-imperfection-review.js';

const DEFAULT_REPORT_PATH =
    '.artifacts/expanded-sample-validation/curated-top-n/combined-report.json';
const DEFAULT_OUTPUT_DIR = '.artifacts/same-anchor-imperfection-review';

export function parseArgs(argv = process.argv.slice(2)) {
    const getValue = (name, fallback) => {
        const index = argv.indexOf(name);
        return index >= 0 ? argv[index + 1] : fallback;
    };
    return {
        reportPath: path.resolve(getValue('--report', DEFAULT_REPORT_PATH)),
        outputDir: path.resolve(getValue('--output-dir', DEFAULT_OUTPUT_DIR))
    };
}

async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath, { limitInputPixels: false })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function compactCandidate(candidate) {
    const hypothesis = candidate.hypothesis ?? {};
    const signals = candidate.qualitySignals ?? {};
    return {
        id: hypothesis.id ?? null,
        family: hypothesis.family ?? null,
        source:
            candidate.result?.meta?.source ?? hypothesis.trial?.source ?? null,
        position: getCandidatePosition(candidate),
        alphaProfile: hypothesis.alphaProfile ?? null,
        polarity: hypothesis.polarity ?? null,
        qualityStatus: signals.qualityStatus ?? null,
        losses: {
            evidence: signals.evidenceLoss ?? null,
            residual: signals.residualLoss ?? null,
            damage: signals.damageLoss ?? null
        },
        imperfections: signals.imperfections ?? null,
        final: signals.final ?? null,
        artifacts: signals.artifacts
            ? {
                  visualArtifactCost:
                      signals.artifacts.visualArtifactCost ?? null,
                  newlyClippedRatio:
                      signals.artifacts.newlyClippedRatio ?? null,
                  halo: signals.artifacts.halo ?? null
              }
            : null
    };
}

function createCrop(position, imageData, padding = 24) {
    const left = Math.max(0, Math.floor(position.x - padding));
    const top = Math.max(0, Math.floor(position.y - padding));
    return {
        left,
        top,
        width: Math.max(
            1,
            Math.min(
                imageData.width - left,
                Math.ceil(position.width + padding * 2)
            )
        ),
        height: Math.max(
            1,
            Math.min(
                imageData.height - top,
                Math.ceil(position.height + padding * 2)
            )
        )
    };
}

function imageDataSharp(imageData) {
    return sharp(
        Buffer.from(
            imageData.data.buffer,
            imageData.data.byteOffset,
            imageData.data.byteLength
        ),
        {
            raw: {
                width: imageData.width,
                height: imageData.height,
                channels: 4
            }
        }
    );
}

export async function renderTriplet({
    sourcePath,
    selectedImageData,
    alternativeImageData,
    position,
    outputPath,
    scale = 4
}) {
    const crop = createCrop(position, selectedImageData);
    const tileWidth = crop.width * scale;
    const tileHeight = crop.height * scale;
    const sourceTile = await sharp(sourcePath, { limitInputPixels: false })
        .extract(crop)
        .resize(tileWidth, tileHeight, { kernel: 'nearest' })
        .png()
        .toBuffer();
    const selectedTile = await imageDataSharp(selectedImageData)
        .extract(crop)
        .resize(tileWidth, tileHeight, { kernel: 'nearest' })
        .png()
        .toBuffer();
    const alternativeTile = await imageDataSharp(alternativeImageData)
        .extract(crop)
        .resize(tileWidth, tileHeight, { kernel: 'nearest' })
        .png()
        .toBuffer();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({
        create: {
            width: tileWidth * 3,
            height: tileHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 }
        }
    })
        .composite(
            [sourceTile, selectedTile, alternativeTile].map((input, index) => ({
                input,
                left: index * tileWidth,
                top: 0
            }))
        )
        .png()
        .toFile(outputPath);
    return outputPath;
}

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export async function renderContactSheet({ records, outputPath }) {
    const ordered = [...records].sort(
        (left, right) =>
            left.selected.position.width - right.selected.position.width ||
            left.selected.position.x - right.selected.position.x ||
            left.fileName.localeCompare(right.fileName)
    );
    const columns = 2;
    const tileWidth = 900;
    const imageHeight = 320;
    const labelHeight = 24;
    const gap = 8;
    const tileHeight = labelHeight + imageHeight;
    const tiles = [];
    for (const [index, record] of ordered.entries()) {
        const image = await sharp(record.tripletPath)
            .resize(tileWidth, imageHeight, {
                fit: 'contain',
                background: { r: 0, g: 0, b: 0, alpha: 1 }
            })
            .png()
            .toBuffer();
        const label = Buffer.from(
            `<svg width="${tileWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg">` +
                '<rect width="100%" height="100%" fill="#111"/>' +
                '<text x="8" y="17" fill="#fff" font-size="13" font-family="sans-serif">' +
                `${escapeXml(record.fileName)} | ${record.selected.position.width}px` +
                '</text></svg>'
        );
        const tile = await sharp({
            create: {
                width: tileWidth,
                height: tileHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 1 }
            }
        })
            .composite([
                { input: label, left: 0, top: 0 },
                { input: image, left: 0, top: labelHeight }
            ])
            .png()
            .toBuffer();
        tiles.push({
            input: tile,
            left: (index % columns) * (tileWidth + gap),
            top: Math.floor(index / columns) * (tileHeight + gap)
        });
    }
    const rows = Math.ceil(Math.max(1, ordered.length) / columns);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({
        create: {
            width: columns * tileWidth + (columns - 1) * gap,
            height: rows * tileHeight + (rows - 1) * gap,
            channels: 4,
            background: { r: 28, g: 28, b: 28, alpha: 1 }
        }
    })
        .composite(tiles)
        .png()
        .toFile(outputPath);
    return outputPath;
}

export async function runSameAnchorImperfectionReview({
    reportPath = path.resolve(DEFAULT_REPORT_PATH),
    outputDir = path.resolve(DEFAULT_OUTPUT_DIR),
    processImageData = removeWatermarkFromImageDataSync
} = {}) {
    const sourceReportBuffer = await readFile(reportPath);
    const sourceReportSha256 = createHash('sha256')
        .update(sourceReportBuffer)
        .digest('hex');
    const sourceReport = JSON.parse(sourceReportBuffer.toString('utf8'));
    const residualRiskInputs = (sourceReport.results ?? []).filter(
        (record) => record.classification === 'residual-risk'
    );
    const records = [];
    await mkdir(path.join(outputDir, 'triplets'), { recursive: true });

    for (const [index, sourceRecord] of residualRiskInputs.entries()) {
        try {
            const originalImageData = await decodeImageData(sourceRecord.input);
            const completedCandidates = [];
            const result = processImageData(originalImageData, {
                adaptiveMode: 'auto',
                debugTimings: true,
                onCandidateCompleted: (candidate) =>
                    completedCandidates.push(candidate)
            });
            const selectedId = result.meta?.selectedCandidate?.id;
            const match = selectSameAnchorAlternative({
                selectedId,
                completedCandidates
            });
            if (match.reason !== 'matched') {
                records.push({
                    fileName: sourceRecord.fileName,
                    input: sourceRecord.input,
                    status: 'not-reproduced',
                    reason: match.reason,
                    selectedId: selectedId ?? null,
                    capturedCandidateCount: completedCandidates.length
                });
                continue;
            }
            const selectedPosition = getCandidatePosition(match.selected);
            if (!hasSameAnchor(match.selected, match.alternative)) {
                throw new Error(
                    `Structured anchor mismatch: ${sourceRecord.fileName}`
                );
            }
            const tripletPath = await renderTriplet({
                sourcePath: sourceRecord.input,
                selectedImageData: match.selected.result.imageData,
                alternativeImageData: match.alternative.result.imageData,
                position: selectedPosition,
                outputPath: path.join(
                    outputDir,
                    'triplets',
                    `${path.parse(sourceRecord.fileName).name}.png`
                )
            });
            records.push({
                fileName: sourceRecord.fileName,
                input: sourceRecord.input,
                status: 'matched',
                selected: compactCandidate(match.selected),
                alternative: compactCandidate(match.alternative),
                tripletPath,
                processingMs: result.debugTimings?.totalMs ?? null
            });
        } catch (error) {
            records.push({
                fileName: sourceRecord.fileName,
                input: sourceRecord.input,
                status: 'not-reproduced',
                reason: 'processing-error',
                error: error instanceof Error ? error.message : String(error)
            });
        }
        if ((index + 1) % 10 === 0 || index + 1 === residualRiskInputs.length) {
            console.log(
                `same-anchor imperfection review: ${index + 1}/${residualRiskInputs.length}`
            );
        }
    }

    const matchedRecords = records.filter((record) => record.status === 'matched');
    const report = {
        generatedAt: new Date().toISOString(),
        reportPath: path.resolve(reportPath),
        sourceReportSha256,
        summary: {
            residualRiskInputs: residualRiskInputs.length,
            matched: matchedRecords.length,
            notReproduced: records.length - matchedRecords.length,
            processingErrors: records.filter(
                (record) => record.reason === 'processing-error'
            ).length
        },
        records
    };
    const review = {
        sourceReportSha256,
        decisions: matchedRecords.map((record) => ({
            fileName: record.fileName,
            verdict: 'unclear',
            reason: ''
        }))
    };
    const contactSheetPath = path.join(outputDir, 'contact-sheet.png');
    await renderContactSheet({ records: matchedRecords, outputPath: contactSheetPath });
    await writeFile(
        path.join(outputDir, 'report.json'),
        `${JSON.stringify(report, null, 2)}\n`
    );
    await writeFile(
        path.join(outputDir, 'review.json'),
        `${JSON.stringify(review, null, 2)}\n`
    );
    return report;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    runSameAnchorImperfectionReview(parseArgs())
        .then((report) => console.log(JSON.stringify(report.summary, null, 2)))
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
