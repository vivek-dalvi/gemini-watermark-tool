import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/gemini-watermark-metric-study/balanced-final/latest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-review/latest');
const DEFAULT_LIMIT = 18;
const TILE_SIZE = 176;
const LABEL_HEIGHT = 58;
const HEADER_HEIGHT = 54;
const ROW_GAP = 12;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: DEFAULT_LIMIT
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function escapeSvgText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function sanitizeFileName(value) {
    return String(value)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 140);
}

function geometryKey(record) {
    const config = record.config ?? {};
    const variant = config.alphaVariant ? `/${config.alphaVariant}` : '';
    return `${config.logoSize ?? '?'}-${config.marginRight ?? '?'}-${config.marginBottom ?? '?'}${variant}`;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin]
    ]);

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

function resolveAlphaMapForConfig(config, alphaMaps) {
    if (!config || !Number.isFinite(config.logoSize)) return null;
    if (config.logoSize === 96 && config.alphaVariant === '20260520') return alphaMaps.alpha96Variants['20260520'];
    if (config.logoSize === 48) return alphaMaps.alpha48;
    if (config.logoSize === 96) return alphaMaps.alpha96;
    return alphaMaps.getAlphaMap(config.logoSize);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function cropBoxForPosition(position, imageData) {
    const padding = Math.max(28, Math.round(position.width * 0.78));
    const left = clamp(Math.round(position.x - padding), 0, Math.max(0, imageData.width - 1));
    const top = clamp(Math.round(position.y - padding), 0, Math.max(0, imageData.height - 1));
    const right = clamp(Math.round(position.x + position.width + padding), left + 1, imageData.width);
    const bottom = clamp(Math.round(position.y + position.height + padding), top + 1, imageData.height);
    return {
        left,
        top,
        width: right - left,
        height: bottom - top
    };
}

function cropImageData(imageData, cropBox) {
    const data = new Uint8ClampedArray(cropBox.width * cropBox.height * 4);
    for (let row = 0; row < cropBox.height; row++) {
        const sourceStart = ((cropBox.top + row) * imageData.width + cropBox.left) * 4;
        const targetStart = row * cropBox.width * 4;
        data.set(imageData.data.subarray(sourceStart, sourceStart + cropBox.width * 4), targetStart);
    }
    return {
        width: cropBox.width,
        height: cropBox.height,
        data
    };
}

function createDiffImageData(before, after, gain = 5) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const delta = beforeLum - afterLum;
        const amp = Math.min(255, Math.abs(delta) * gain);
        if (delta >= 0) {
            data[offset] = amp;
            data[offset + 1] = Math.round(amp * 0.48);
            data[offset + 2] = Math.round(amp * 0.14);
        } else {
            data[offset] = Math.round(amp * 0.18);
            data[offset + 1] = Math.round(amp * 0.52);
            data[offset + 2] = amp;
        }
        data[offset + 3] = 255;
    }
    return {
        width: before.width,
        height: before.height,
        data
    };
}

function createContrastImageData(imageData) {
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        sum += lum;
        sumSquares += lum * lum;
        count++;
    }
    const mean = count ? sum / count : 128;
    const variance = count ? Math.max(1, sumSquares / count - mean * mean) : 1;
    const std = Math.sqrt(variance);
    const gain = std < 16 ? 3.4 : 2.3;
    const data = new Uint8ClampedArray(imageData.data.length);
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        const value = clamp(Math.round(128 + (lum - mean) * gain), 0, 255);
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = imageData.data[offset + 3];
    }
    return {
        width: imageData.width,
        height: imageData.height,
        data
    };
}

function createRemovalCandidate({ originalImageData, alphaMap, position, alphaGain }) {
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, alphaMap, position, { alphaGain });
    return imageData;
}

async function imageDataToBuffer(imageData) {
    return sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toBuffer();
}

async function renderPanel({ imageData, title, line1 = '', line2 = '' }) {
    const image = await sharp(await imageDataToBuffer(imageData))
        .resize(TILE_SIZE, TILE_SIZE, { fit: 'contain', background: '#0d0d0d' })
        .png()
        .toBuffer();
    const label = `<svg width="${TILE_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#101010"/>` +
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 32)}</text>` +
        `<text x="8" y="36" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 44)}</text>` +
        `<text x="8" y="51" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(line2).slice(0, 44)}</text>` +
        `</svg>`;

    return sharp({
        create: {
            width: TILE_SIZE,
            height: TILE_SIZE + LABEL_HEIGHT,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite([
            { input: image, left: 0, top: 0 },
            { input: Buffer.from(label), left: 0, top: TILE_SIZE }
        ])
        .png()
        .toBuffer();
}

function metricLine(score) {
    return `r=${formatNumber(score?.residualCost)} b=${formatNumber(score?.balancedCost)}`;
}

function detailLine(score) {
    return `g=${formatNumber(score?.gradient)} s=${formatNumber(score?.spatial)}`;
}

async function renderRecordRow({ record, alphaMaps, outputDir, queueName, index }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const processed = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48: alphaMaps.alpha48,
        alpha96: alphaMaps.alpha96,
        alpha96Variants: alphaMaps.alpha96Variants,
        getAlphaMap: alphaMaps.getAlphaMap
    });
    const position = processed.meta.position ?? record.position;
    const config = processed.meta.config ?? record.config;
    const alphaMap = resolveAlphaMapForConfig(config, alphaMaps);
    if (!position || !alphaMap) return null;

    const standard = createRemovalCandidate({
        originalImageData,
        alphaMap,
        position,
        alphaGain: 1
    });
    const bestResidualGain = record.bestResidual?.alphaGain ?? 1;
    const bestBalancedGain = record.bestBalanced?.alphaGain ?? 1;
    const bestResidual = createRemovalCandidate({
        originalImageData,
        alphaMap,
        position,
        alphaGain: bestResidualGain
    });
    const bestBalanced = createRemovalCandidate({
        originalImageData,
        alphaMap,
        position,
        alphaGain: bestBalancedGain
    });

    const cropBox = cropBoxForPosition(position, originalImageData);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const productionCrop = cropImageData(processed.imageData, cropBox);
    const standardCrop = cropImageData(standard, cropBox);
    const residualCrop = cropImageData(bestResidual, cropBox);
    const balancedCrop = cropImageData(bestBalanced, cropBox);
    const diffCrop = createDiffImageData(beforeCrop, productionCrop);
    const contrastCrop = createContrastImageData(productionCrop);

    const panels = [
        await renderPanel({
            imageData: beforeCrop,
            title: 'before',
            line1: `${position.width}px ${geometryKey({ config })}`,
            line2: `${record.width}x${record.height}`
        }),
        await renderPanel({
            imageData: productionCrop,
            title: 'production',
            line1: metricLine(record.production),
            line2: detailLine(record.production)
        }),
        await renderPanel({
            imageData: standardCrop,
            title: 'standard a=1',
            line1: metricLine(record.standardAlpha?.score),
            line2: detailLine(record.standardAlpha?.score)
        }),
        await renderPanel({
            imageData: residualCrop,
            title: `best residual a=${bestResidualGain}`,
            line1: metricLine(record.bestResidual?.score),
            line2: detailLine(record.bestResidual?.score)
        }),
        await renderPanel({
            imageData: balancedCrop,
            title: `best balanced a=${bestBalancedGain}`,
            line1: metricLine(record.bestBalanced?.score),
            line2: detailLine(record.bestBalanced?.score)
        }),
        await renderPanel({
            imageData: diffCrop,
            title: 'prod diff x5',
            line1: 'orange removed',
            line2: 'blue added'
        }),
        await renderPanel({
            imageData: contrastCrop,
            title: 'prod contrast',
            line1: 'local luma',
            line2: 'visual check'
        })
    ];

    const rowWidth = panels.length * TILE_SIZE;
    const rowHeight = HEADER_HEIGHT + TILE_SIZE + LABEL_HEIGHT;
    const reasons = [
        record.production?.visiblePositiveHalo ? 'positiveHalo' : null,
        record.production?.visibleGradientResidual ? 'gradient' : null,
        record.production?.visibleSpatialResidual ? 'spatial' : null
    ].filter(Boolean);
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${index + 1}. ${escapeSvgText(record.file).slice(0, 132)}</text>` +
        `<text x="10" y="36" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(record.source).slice(0, 140)}</text>` +
        `<text x="10" y="50" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10.5">queue=${escapeSvgText(queueName)} geom=${escapeSvgText(geometryKey(record))} alpha=${formatNumber(record.alphaGain, 2)} reasons=${escapeSvgText(reasons.join('+') || 'none')} mismatch=${record.classification?.proxyMismatch === true}</text>` +
        `</svg>`;
    const composites = [
        { input: Buffer.from(header), left: 0, top: 0 },
        ...panels.map((panel, panelIndex) => ({
            input: panel,
            left: panelIndex * TILE_SIZE,
            top: HEADER_HEIGHT
        }))
    ];
    const rowBuffer = await sharp({
        create: {
            width: rowWidth,
            height: rowHeight,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toBuffer();
    const rowPath = path.join(
        outputDir,
        'rows',
        queueName,
        `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(record.file)}.png`
    );
    await mkdir(path.dirname(rowPath), { recursive: true });
    await writeFile(rowPath, rowBuffer);

    return {
        rowPath,
        rowBuffer,
        rowWidth,
        rowHeight,
        record
    };
}

async function renderSheet({ rows, outputPath }) {
    if (rows.length === 0) return null;
    const width = Math.max(...rows.map((row) => row.rowWidth));
    const height = rows.reduce((sum, row) => sum + row.rowHeight, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.rowBuffer, left: 0, top });
        top += row.rowHeight + ROW_GAP;
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
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
    return {
        outputPath,
        count: rows.length,
        width,
        height
    };
}

function sortByProductionBalanced(records) {
    return [...records].sort((left, right) => (
        (right.production?.balancedCost ?? 0) - (left.production?.balancedCost ?? 0) ||
        (right.production?.residualCost ?? 0) - (left.production?.residualCost ?? 0)
    ));
}

function sortByProxyRisk(records) {
    return [...records].sort((left, right) => (
        (right.classification?.artifactIncrease ?? 0) - (left.classification?.artifactIncrease ?? 0) ||
        (right.classification?.clipIncrease ?? 0) - (left.classification?.clipIncrease ?? 0) ||
        (right.classification?.gradientIncrease ?? 0) - (left.classification?.gradientIncrease ?? 0)
    ));
}

function isProductionVisibleForReview(record) {
    if (typeof record.production?.calibratedVisible === 'boolean') {
        return record.production.calibratedVisible;
    }
    return record.production?.visible === true;
}

function normalizeReviewRecord(record) {
    const bestRemoval = record.bestRemoval ?? {};
    const config = record.config ?? record.productionConfig ?? (
        Number.isFinite(bestRemoval.size)
            ? {
                logoSize: bestRemoval.size,
                marginRight: bestRemoval.marginRight,
                marginBottom: bestRemoval.marginBottom
            }
            : null
    );
    const position = record.position ?? record.productionPosition ?? bestRemoval.position ?? null;
    const classification = record.classification ?? {
        proxyMismatch: record.taxonomy?.metricMismatchCandidate === true,
        mismatchReason: record.taxonomy?.mismatchReason ?? null
    };
    const bestCandidate = bestRemoval.position
        ? {
            alphaGain: bestRemoval.alphaGain,
            score: bestRemoval.processed
        }
        : null;

    return {
        ...record,
        applied: record.applied ?? Boolean(position && config),
        position,
        config,
        alphaGain: record.alphaGain ?? bestRemoval.alphaGain,
        source: record.source ?? record.productionAlphaMapSource ?? record.taxonomy?.label ?? '',
        classification,
        bestResidual: record.bestResidual ?? bestCandidate,
        bestBalanced: record.bestBalanced ?? bestCandidate,
        standardAlpha: record.standardAlpha ?? (
            bestRemoval.evidence
                ? { score: bestRemoval.evidence }
                : record.standardAlpha
        )
    };
}

export function buildQueues(records, limit) {
    const applied = records
        .map(normalizeReviewRecord)
        .filter((record) => record.applied && record.position && record.config);
    return {
        visible: sortByProductionBalanced(applied.filter(isProductionVisibleForReview)).slice(0, limit),
        'proxy-mismatch': sortByProxyRisk(applied.filter((record) => record.classification?.proxyMismatch)).slice(0, limit),
        'taxonomy-mismatch': sortByProductionBalanced(applied.filter((record) => (
            record.taxonomy?.metricMismatchCandidate === true
        ))).slice(0, limit),
        'geometry-48-96-96': sortByProductionBalanced(applied.filter((record) => (
            record.config?.logoSize === 48 &&
            record.config?.marginRight === 96 &&
            record.config?.marginBottom === 96
        ))).slice(0, limit)
    };
}

function buildDecisionTemplate(queueRows) {
    const decisions = [];
    for (const [queueName, rows] of Object.entries(queueRows)) {
        rows.forEach((row, index) => {
            const record = row.record;
            decisions.push({
                queue: queueName,
                index,
                file: record.file,
                rowPath: row.rowPath,
                geometry: geometryKey(record),
                source: record.source,
                suggestedLabels: {
                    visibleWatermark: isProductionVisibleForReview(record),
                    metricMismatch: record.classification?.proxyMismatch === true,
                    likelyFalsePositive: isProductionVisibleForReview(record) &&
                        Math.max(0, record.production?.gradient ?? 0) < 0.06 &&
                        Math.abs(record.production?.spatial ?? 0) > 0.25
                },
                metrics: {
                    production: record.production,
                    standardAlpha: record.standardAlpha?.score,
                    bestResidual: record.bestResidual,
                    bestBalanced: record.bestBalanced,
                    classification: record.classification
                },
                humanLabel: null,
                humanConfidence: null,
                humanNotes: ''
            });
        });
    }
    return {
        schemaVersion: 1,
        instructions: {
            humanLabelValues: [
                'clean',
                'visible-watermark',
                'oversubtracted-dark',
                'edge-halo',
                'metric-false-positive',
                'content-collision',
                'unsure'
            ],
            confidenceValues: ['high', 'medium', 'low'],
            editPolicy: 'Edit review-decisions.json only; generated sheets are evidence artifacts.'
        },
        decisions
    };
}

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function decisionsToCsv(decisions) {
    const columns = [
        'queue',
        'index',
        'file',
        'rowPath',
        'geometry',
        'source',
        'prodResidual',
        'prodBalanced',
        'prodGradient',
        'prodSpatial',
        'proxyMismatch',
        'humanLabel',
        'humanConfidence',
        'humanNotes'
    ];
    const rows = decisions.map((decision) => ({
        queue: decision.queue,
        index: decision.index,
        file: decision.file,
        rowPath: decision.rowPath,
        geometry: decision.geometry,
        source: decision.source,
        prodResidual: decision.metrics.production?.residualCost,
        prodBalanced: decision.metrics.production?.balancedCost,
        prodGradient: decision.metrics.production?.gradient,
        prodSpatial: decision.metrics.production?.spatial,
        proxyMismatch: decision.metrics.classification?.proxyMismatch,
        humanLabel: decision.humanLabel,
        humanConfidence: decision.humanConfidence,
        humanNotes: decision.humanNotes
    }));
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
    ].join('\n') + '\n';
}

function createSummaryMarkdown({ sourceReport, outputDir, sheets, queues, decisionTemplate }) {
    const lines = [
        '# Metric Mismatch Review Pack',
        '',
        `- source report: \`${sourceReport}\``,
        `- output dir: \`${outputDir}\``,
        `- decision count: ${decisionTemplate.decisions.length}`,
        '',
        '## Queues',
        '',
        ...Object.entries(queues).map(([name, records]) => `- ${name}: ${records.length}`),
        '',
        '## Sheets',
        '',
        ...Object.entries(sheets).map(([name, sheet]) => (
            sheet
                ? `- ${name}: \`${sheet.outputPath}\` (${sheet.count} rows)`
                : `- ${name}: not generated`
        )),
        '',
        '## Labels',
        '',
        'Use `review-decisions.json` for human labels. The important split is whether a row is truly visible damage/residual, or only a metric false positive.',
        ''
    ];
    return lines.join('\n');
}

function summarizeSourceReport(summary) {
    if (!summary) return null;
    return {
        total: summary.total,
        applied: summary.applied,
        skipped: summary.skipped,
        aggressiveCount: summary.aggressiveCount,
        proxyMismatchCount: summary.proxyMismatchCount,
        conservativeWouldBeSaferCount: summary.conservativeWouldBeSaferCount,
        visibleAfterProductionCount: summary.visibleAfterProductionCount,
        topGeometryClusters: (summary.geometryClusters ?? []).slice(0, 8),
        topSourceClusters: (summary.sourceClusters ?? []).slice(0, 8)
    };
}

export async function createMetricMismatchReviewPack(options = {}) {
    const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const limit = options.limit ?? DEFAULT_LIMIT;
    await mkdir(outputDir, { recursive: true });

    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    const records = report.records ?? [];
    const alphaMaps = await loadAlphaMaps();
    const queues = buildQueues(records, limit);
    const queueRows = {};
    const sheets = {};

    for (const [queueName, queueRecords] of Object.entries(queues)) {
        const rows = [];
        for (let index = 0; index < queueRecords.length; index++) {
            console.log(`[review-pack] ${queueName} ${index + 1}/${queueRecords.length} ${queueRecords[index].file}`);
            const row = await renderRecordRow({
                record: queueRecords[index],
                alphaMaps,
                outputDir,
                queueName,
                index
            });
            if (row) rows.push(row);
        }
        queueRows[queueName] = rows;
        sheets[queueName] = await renderSheet({
            rows,
            outputPath: path.join(outputDir, `${queueName}-sheet.png`)
        });
    }

    const decisionTemplate = buildDecisionTemplate(queueRows);
    await writeFile(
        path.join(outputDir, 'review-decisions.template.json'),
        `${JSON.stringify(decisionTemplate, null, 2)}\n`,
        'utf8'
    );
    await writeFile(
        path.join(outputDir, 'review-decisions.json'),
        `${JSON.stringify(decisionTemplate, null, 2)}\n`,
        'utf8'
    );
    await writeFile(
        path.join(outputDir, 'review-table.csv'),
        decisionsToCsv(decisionTemplate.decisions),
        'utf8'
    );
    await writeFile(
        path.join(outputDir, 'summary.md'),
        createSummaryMarkdown({
            sourceReport: reportPath,
            outputDir,
            sheets,
            queues,
            decisionTemplate
        }),
        'utf8'
    );

    const summary = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        limit,
        sourceSummary: summarizeSourceReport(report.summary),
        queues: Object.fromEntries(Object.entries(queues).map(([name, queueRecords]) => [name, queueRecords.length])),
        sheets,
        decisionCount: decisionTemplate.decisions.length
    };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const summary = await createMetricMismatchReviewPack(args);
    console.log(JSON.stringify({
        outputDir: summary.outputDir,
        queues: summary.queues,
        sheets: summary.sheets,
        decisionCount: summary.decisionCount
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
