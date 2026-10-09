import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_SAMPLE_ROOT = path.resolve(
    process.env.GWR_ONLINE_SAMPLE_ROOT ||
    'sample-files/gemini-watermark/online-sample-2026-06-23-to-2026-06-24-max500'
);
const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-after-rebalance.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/skipped-candidate-audit'
);

const SIZES = Object.freeze([36, 40, 43, 48, 53, 64, 72, 88, 96, 128]);
const MARGINS = Object.freeze([16, 24, 32, 48, 58, 64, 72, 85, 96, 128, 160, 192, 240]);
const ALPHA_GAINS = Object.freeze([0.35, 0.45, 0.55, 0.6, 0.7, 0.85, 1, 1.1, 1.3]);
const POLARITIES = Object.freeze(['white', 'dark']);
const MAX_TRIAL_CANDIDATES_PER_IMAGE = 48;
const PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL = 0.45;
const PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT = 0.16;
const CROP_SIZE = 192;
const PANEL_SIZE = 220;
const LABEL_HEIGHT = 72;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        sampleRoot: DEFAULT_SAMPLE_ROOT,
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || parsed.sampleRoot);
        } else if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        }
    }

    return parsed;
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function round(value, digits = 6) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function negateAlphaMap(alphaMap) {
    return Float32Array.from(alphaMap, (value) => -value);
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const cache = new Map([
        ['48:white', alpha48],
        ['48:dark', negateAlphaMap(alpha48)],
        ['96:white', alpha96],
        ['96:dark', negateAlphaMap(alpha96)]
    ]);

    return (size, polarity) => {
        const key = `${size}:${polarity}`;
        if (cache.has(key)) return cache.get(key);
        const base = size > 72 ? alpha96 : alpha48;
        const baseSize = size > 72 ? 96 : 48;
        const alphaMap = interpolateAlphaMap(base, baseSize, size);
        const resolved = polarity === 'dark' ? negateAlphaMap(alphaMap) : alphaMap;
        cache.set(key, resolved);
        return resolved;
    };
}

function calculateCropBox(position, imageData) {
    const centerX = position.x + position.width / 2;
    const centerY = position.y + position.height / 2;
    const width = Math.min(CROP_SIZE, imageData.width);
    const height = Math.min(CROP_SIZE, imageData.height);
    const left = Math.max(0, Math.min(imageData.width - width, Math.round(centerX - width / 2)));
    const top = Math.max(0, Math.min(imageData.height - height, Math.round(centerY - height / 2)));
    return { left, top, width, height };
}

function cropImageData(imageData, cropBox) {
    const data = new Uint8ClampedArray(cropBox.width * cropBox.height * 4);
    for (let row = 0; row < cropBox.height; row++) {
        const sourceStart = ((cropBox.top + row) * imageData.width + cropBox.left) * 4;
        const targetStart = row * cropBox.width * 4;
        data.set(
            imageData.data.subarray(sourceStart, sourceStart + cropBox.width * 4),
            targetStart
        );
    }
    return {
        width: cropBox.width,
        height: cropBox.height,
        data
    };
}

function createDiffImageData(before, after) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const diff = Math.max(
            Math.abs(before.data[offset] - after.data[offset]),
            Math.abs(before.data[offset + 1] - after.data[offset + 1]),
            Math.abs(before.data[offset + 2] - after.data[offset + 2])
        );
        const amplified = Math.min(255, diff * 5);
        data[offset] = amplified;
        data[offset + 1] = Math.round(amplified * 0.45);
        data[offset + 2] = Math.round(amplified * 0.15);
        data[offset + 3] = 255;
    }

    return {
        width: before.width,
        height: before.height,
        data
    };
}

function scoreTrial(originalImageData, alphaMap, position, alphaGain) {
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, alphaMap, position, { alphaGain });
    const spatial = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const visibility = assessWatermarkResidualVisibility({ imageData, alphaMap, position });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position,
        alphaGain
    });
    const darkHalo = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const artifact = artifacts?.visualArtifactCost ?? Number.POSITIVE_INFINITY;
    const clipped = artifacts?.newlyClippedRatio ?? Number.POSITIVE_INFINITY;
    const safe =
        spatial < 0.22 &&
        Math.abs(spatial) <= 0.22 &&
        gradient <= 0.25 &&
        visibility?.visible === false &&
        artifact <= 0.34 &&
        darkHalo <= 4 &&
        clipped <= 0.02;

    return {
        alphaGain,
        processedSpatial: spatial,
        processedGradient: gradient,
        visible: visibility?.visible,
        visibleSpatial: visibility?.visibleSpatialResidual,
        visibleGradient: visibility?.visibleGradientResidual,
        positiveHaloLum: visibility?.positiveHaloLum,
        artifact,
        darkHalo,
        clipped,
        safe
    };
}

function rankCandidates(left, right) {
    if (left.productionEvidence !== right.productionEvidence) return left.productionEvidence ? -1 : 1;
    if (left.bestSafe !== right.bestSafe) return left.bestSafe ? -1 : 1;
    const leftEvidence = Math.max(0, left.originalSpatial) + Math.max(0, left.originalGradient) * 0.6;
    const rightEvidence = Math.max(0, right.originalSpatial) + Math.max(0, right.originalGradient) * 0.6;
    if (Math.abs(rightEvidence - leftEvidence) > 0.000001) return rightEvidence - leftEvidence;
    return left.bestCost - right.bestCost;
}

function rankEvidence(left, right) {
    const leftEvidence = Math.max(0, left.originalSpatial) + Math.max(0, left.originalGradient) * 0.6;
    const rightEvidence = Math.max(0, right.originalSpatial) + Math.max(0, right.originalGradient) * 0.6;
    return rightEvidence - leftEvidence;
}

function rankTrials(left, right) {
    if (left.safe !== right.safe) return left.safe ? -1 : 1;
    return Math.abs(left.processedSpatial) + Math.max(0, left.processedGradient) * 0.8 -
        (Math.abs(right.processedSpatial) + Math.max(0, right.processedGradient) * 0.8);
}

function candidateLabel(candidate) {
    return `${candidate.size}/${candidate.marginRight}/${candidate.marginBottom}/${candidate.polarity}`;
}

function hasProductionEvidence(candidate) {
    return candidate.originalSpatial >= PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL &&
        candidate.originalGradient >= PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT;
}

function summarizeClassification(candidates) {
    const top = candidates[0] ?? null;
    const evaluatedCandidates = candidates.filter((candidate) => candidate.evaluated === true);
    const productionEvidenceCount = candidates.filter((candidate) => candidate.productionEvidence).length;
    const safeCount = evaluatedCandidates.filter((candidate) => candidate.bestSafe).length;
    const productionEvidenceSafeCount = candidates.filter((candidate) => (
        candidate.evaluated === true && candidate.productionEvidence && candidate.bestSafe
    )).length;

    let classification = 'no-template-evidence';
    if (productionEvidenceSafeCount > 0) {
        classification = 'probable-safe-watermark-candidate';
    } else if (productionEvidenceCount > 0) {
        classification = 'evidence-but-unsafe-removal';
    } else if (safeCount > 0) {
        classification = 'safe-looking-without-production-evidence';
    } else if (top && (top.originalSpatial >= 0.3 || top.originalGradient >= 0.2)) {
        classification = 'weak-or-conflicting-evidence';
    }

    return {
        classification,
        productionEvidenceCount,
        safeCount,
        productionEvidenceSafeCount
    };
}

function evaluateCandidates(imageData, resolveAlphaMap) {
    const candidates = [];

    for (const size of SIZES) {
        for (const marginRight of MARGINS) {
            for (const marginBottom of MARGINS) {
                const position = {
                    x: imageData.width - marginRight - size,
                    y: imageData.height - marginBottom - size,
                    width: size,
                    height: size
                };
                if (position.x < 0 || position.y < 0) continue;

                for (const polarity of POLARITIES) {
                    const alphaMap = resolveAlphaMap(size, polarity);
                    const originalSpatial = computeRegionSpatialCorrelation({
                        imageData,
                        alphaMap,
                        region: { x: position.x, y: position.y, size }
                    });
                    const originalGradient = computeRegionGradientCorrelation({
                        imageData,
                        alphaMap,
                        region: { x: position.x, y: position.y, size }
                    });
                    const candidate = {
                        label: `${size}/${marginRight}/${marginBottom}/${polarity}`,
                        size,
                        marginRight,
                        marginBottom,
                        polarity,
                        position,
                        originalSpatial,
                        originalGradient,
                        productionEvidence: false,
                        evaluated: false,
                        best: null,
                        bestSafe: false,
                        bestCost: Number.POSITIVE_INFINITY
                    };
                    candidate.productionEvidence = hasProductionEvidence(candidate);
                    candidates.push(candidate);
                }
            }
        }
    }

    const trialCandidates = new Set(
        candidates
            .filter((candidate) => candidate.productionEvidence)
            .concat([...candidates].sort(rankEvidence).slice(0, MAX_TRIAL_CANDIDATES_PER_IMAGE))
            .map((candidate) => candidate.label)
    );
    for (const candidate of candidates) {
        if (!trialCandidates.has(candidate.label)) continue;
        const alphaMap = resolveAlphaMap(candidate.size, candidate.polarity);
        const trials = ALPHA_GAINS.map((alphaGain) =>
            scoreTrial(imageData, alphaMap, candidate.position, alphaGain)
        ).sort(rankTrials);
        const best = trials[0];
        candidate.evaluated = true;
        candidate.best = best;
        candidate.bestSafe = best.safe === true;
        candidate.bestCost = Math.abs(best.processedSpatial) + Math.max(0, best.processedGradient) * 0.8;
    }

    candidates.sort(rankCandidates);
    return candidates;
}

async function encodePanel(imageData, { cropBox, position, title, metrics, color }) {
    const localX = position.x - cropBox.left;
    const localY = position.y - cropBox.top;
    const svg = `<svg width="${cropBox.width}" height="${cropBox.height}" viewBox="0 0 ${cropBox.width} ${cropBox.height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${localX}" y="${localY}" width="${position.width}" height="${position.height}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>` +
        `</svg>`;
    const image = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'contain', background: '#000000' })
        .png()
        .toBuffer();
    const label = `<svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#101010"/>` +
        `<text x="8" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(title)}</text>` +
        `<text x="8" y="40" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(metrics.slice(0, 58))}</text>` +
        `<text x="8" y="58" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(metrics.slice(58, 116))}</text>` +
        `</svg>`;

    return {
        width: PANEL_SIZE,
        height: PANEL_SIZE + LABEL_HEIGHT,
        buffer: await sharp({
            create: {
                width: PANEL_SIZE,
                height: PANEL_SIZE + LABEL_HEIGHT,
                channels: 4,
                background: BACKGROUND
            }
        })
            .composite([
                { input: image, left: 0, top: 0 },
                { input: Buffer.from(label), left: 0, top: PANEL_SIZE }
            ])
            .png()
            .toBuffer()
    };
}

async function renderCandidateRow({ record, imageData, candidate, alphaMap, outputDir }) {
    const restored = cloneImageData(imageData);
    removeWatermark(restored, alphaMap, candidate.position, { alphaGain: candidate.best.alphaGain });

    const cropBox = calculateCropBox(candidate.position, imageData);
    const originalCrop = cropImageData(imageData, cropBox);
    const restoredCrop = cropImageData(restored, cropBox);
    const diffCrop = createDiffImageData(originalCrop, restoredCrop);
    const metrics = [
        `${candidateLabel(candidate)} a=${candidate.best.alphaGain}`,
        `orig=${round(candidate.originalSpatial, 3)}/${round(candidate.originalGradient, 3)}`,
        `after=${round(candidate.best.processedSpatial, 3)}/${round(candidate.best.processedGradient, 3)}`,
        `safe=${candidate.bestSafe} prod=${candidate.productionEvidence}`
    ].join(' ');
    const color = candidate.productionEvidence
        ? '#27ae60'
        : candidate.bestSafe
            ? '#f2c94c'
            : '#eb5757';

    const panels = [
        await encodePanel(originalCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: candidate.position.x - cropBox.left,
                y: candidate.position.y - cropBox.top,
                width: candidate.position.width,
                height: candidate.position.height
            },
            title: `${path.basename(record.fileName)} original`,
            metrics,
            color
        }),
        await encodePanel(restoredCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: candidate.position.x - cropBox.left,
                y: candidate.position.y - cropBox.top,
                width: candidate.position.width,
                height: candidate.position.height
            },
            title: record.classification,
            metrics,
            color
        }),
        await encodePanel(diffCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: candidate.position.x - cropBox.left,
                y: candidate.position.y - cropBox.top,
                width: candidate.position.width,
                height: candidate.position.height
            },
            title: 'diff x5',
            metrics,
            color
        })
    ];

    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = PANEL_SIZE + LABEL_HEIGHT;
    const rowBuffer = await sharp({
        create: {
            width: rowWidth,
            height: rowHeight,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(panels.map((panel, index) => ({
            input: panel.buffer,
            left: index * (PANEL_SIZE + PANEL_GAP),
            top: 0
        })))
        .png()
        .toBuffer();

    const baseName = path.basename(record.fileName, path.extname(record.fileName));
    const outputPath = path.join(outputDir, `${baseName}-top-candidate.png`);
    await writeFile(outputPath, rowBuffer);

    return {
        rowBuffer,
        rowWidth,
        rowHeight,
        cropPath: outputPath
    };
}

async function renderSheet(rows, outputPath) {
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((row) => row.rowWidth));
    const height = rows.reduce((sum, row) => sum + row.rowHeight, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.rowBuffer, left: 0, top });
        top += row.rowHeight + ROW_GAP;
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
}

function summarizeCandidate(candidate) {
    return {
        label: candidate.label,
        size: candidate.size,
        marginRight: candidate.marginRight,
        marginBottom: candidate.marginBottom,
        polarity: candidate.polarity,
        originalSpatial: round(candidate.originalSpatial),
        originalGradient: round(candidate.originalGradient),
        productionEvidence: candidate.productionEvidence,
        bestSafe: candidate.bestSafe,
        alphaGain: candidate.best.alphaGain,
        processedSpatial: round(candidate.best.processedSpatial),
        processedGradient: round(candidate.best.processedGradient),
        visible: candidate.best.visible,
        artifact: round(candidate.best.artifact),
        darkHalo: round(candidate.best.darkHalo),
        clipped: round(candidate.best.clipped)
    };
}

function createMarkdown(report) {
    const lines = [
        '# Online Skipped Watermark Candidate Audit',
        '',
        `- Generated: ${report.generatedAt}`,
        `- Benchmark: \`${report.reportPath}\``,
        `- Samples: ${report.records.length}`,
        `- Sheet: \`${report.sheetPath}\``,
        '',
        '## Summary',
        '',
        ...Object.entries(report.summary.byClassification)
            .map(([key, value]) => `- ${key}: ${value}`),
        '',
        '## Records',
        ''
    ];

    for (const record of report.records) {
        const top = record.topCandidates[0];
        lines.push(`### ${record.classification}: ${record.fileName}`);
        lines.push(`- dimensions: ${record.width}x${record.height}`);
        lines.push(`- productionEvidenceSafeCount: ${record.productionEvidenceSafeCount}`);
        lines.push(`- productionEvidenceCount: ${record.productionEvidenceCount}`);
        lines.push(`- safeCount: ${record.safeCount}`);
        lines.push(
            `- top: ${top?.label ?? 'none'} ` +
            `orig=${top?.originalSpatial ?? 'n/a'}/${top?.originalGradient ?? 'n/a'} ` +
            `after=${top?.processedSpatial ?? 'n/a'}/${top?.processedGradient ?? 'n/a'} ` +
            `safe=${top?.bestSafe ?? 'n/a'} prod=${top?.productionEvidence ?? 'n/a'}`
        );
        lines.push(`- crop: \`${record.cropPath}\``);
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const skipped = (report.failures ?? []).filter((failure) => failure.bucket === 'missed-detection');
    const resolveAlphaMap = await loadAlphaMaps();
    await mkdir(args.outputDir, { recursive: true });

    const rows = [];
    const records = [];

    for (const failure of skipped) {
        const inputPath = path.join(args.sampleRoot, failure.fileName);
        const imageData = await decodeImageDataInNode(inputPath);
        const candidates = evaluateCandidates(imageData, resolveAlphaMap);
        const summary = summarizeClassification(candidates);
        const topCandidate = candidates[0];
        const alphaMap = resolveAlphaMap(topCandidate.size, topCandidate.polarity);
        const record = {
            fileName: failure.fileName,
            width: failure.width,
            height: failure.height,
            ...summary,
            cropPath: null,
            topCandidates: candidates.slice(0, 8).map(summarizeCandidate)
        };
        const rendered = await renderCandidateRow({
            record,
            imageData,
            candidate: topCandidate,
            alphaMap,
            outputDir: args.outputDir
        });
        record.cropPath = rendered.cropPath;
        rows.push(rendered);
        records.push(record);
    }

    const sheetPath = path.join(args.outputDir, 'skipped-candidate-audit-sheet.png');
    await renderSheet(rows, sheetPath);

    const summary = {
        byClassification: records.reduce((acc, record) => {
            acc[record.classification] = (acc[record.classification] ?? 0) + 1;
            return acc;
        }, {}),
        productionEvidenceSafeTotal: records.reduce((sum, record) => sum + record.productionEvidenceSafeCount, 0),
        productionEvidenceTotal: records.reduce((sum, record) => sum + record.productionEvidenceCount, 0),
        safeTotal: records.reduce((sum, record) => sum + record.safeCount, 0)
    };
    const output = {
        generatedAt: new Date().toISOString(),
        sampleRoot: args.sampleRoot,
        reportPath: args.reportPath,
        outputDir: args.outputDir,
        sheetPath,
        criteria: {
            productionEvidence: {
                originalSpatialMin: PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL,
                originalGradientMin: PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT
            }
        },
        summary,
        records
    };

    const jsonPath = path.join(args.outputDir, 'skipped-candidate-audit.json');
    const markdownPath = path.join(args.outputDir, 'skipped-candidate-audit.md');
    await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, createMarkdown(output), 'utf8');

    console.log(JSON.stringify({
        count: records.length,
        summary,
        jsonPath,
        markdownPath,
        sheetPath
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
