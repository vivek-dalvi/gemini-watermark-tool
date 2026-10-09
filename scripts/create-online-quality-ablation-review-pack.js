import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_ABLATION_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation/phase5-vs-initial/latest.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation-review/phase5-vs-initial'
);
const PANEL_SIZE = 210;
const LABEL_HEIGHT = 58;
const HEADER_HEIGHT = 82;
const ROW_GAP = 12;
const BACKGROUND = '#111111';

function parseArgs(argv) {
    const parsed = {
        ablationPath: DEFAULT_ABLATION_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        queueName: 'perfectLost'
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--ablation') {
            parsed.ablationPath = path.resolve(args.shift() || parsed.ablationPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--queue') {
            parsed.queueName = args.shift() || parsed.queueName;
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

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function resolveAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', getEmbeddedAlphaMap('36-v2')]
    ]);
    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            if (typeof size === 'string') return null;
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

function calculateCropBox(position, imageData) {
    if (!position) {
        const size = Math.min(420, imageData.width, imageData.height);
        return {
            left: imageData.width - size,
            top: imageData.height - size,
            width: size,
            height: size
        };
    }
    const targetSize = Math.max(190, Math.min(460, Math.round(position.width * 4.2)));
    const width = Math.min(targetSize, imageData.width);
    const height = Math.min(targetSize, imageData.height);
    const centerX = position.x + position.width / 2;
    const centerY = position.y + position.height / 2;
    return {
        left: Math.max(0, Math.min(imageData.width - width, Math.round(centerX - width / 2))),
        top: Math.max(0, Math.min(imageData.height - height, Math.round(centerY - height / 2))),
        width,
        height
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

function createDiffImageData(before, after, gain = 6) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const signedDelta = afterLum - beforeLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * gain);
        if (signedDelta >= 0) {
            data[offset] = Math.round(amplified * 0.18);
            data[offset + 1] = Math.round(amplified * 0.52);
            data[offset + 2] = amplified;
        } else {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.48);
            data[offset + 2] = Math.round(amplified * 0.14);
        }
        data[offset + 3] = 255;
    }
    return {
        width: before.width,
        height: before.height,
        data
    };
}

function blendPixel(data, offset, red, green, blue, alpha = 0.78) {
    data[offset] = Math.round(data[offset] * (1 - alpha) + red * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + green * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + blue * alpha);
    data[offset + 3] = 255;
}

function drawCornerMarkers(imageData, position, cropBox) {
    if (!position) return imageData;
    const data = new Uint8ClampedArray(imageData.data);
    const local = {
        x: Math.round(position.x - cropBox.left),
        y: Math.round(position.y - cropBox.top),
        width: Math.round(position.width),
        height: Math.round(position.height)
    };
    const left = Math.max(0, Math.min(imageData.width - 1, local.x));
    const top = Math.max(0, Math.min(imageData.height - 1, local.y));
    const right = Math.max(left, Math.min(imageData.width - 1, local.x + local.width));
    const bottom = Math.max(top, Math.min(imageData.height - 1, local.y + local.height));
    const tickLength = Math.max(10, Math.min(34, Math.round(Math.min(local.width, local.height) * 0.45)));
    const paint = (x, y) => blendPixel(data, (y * imageData.width + x) * 4, 255, 80, 80);
    for (let inset = 0; inset < 2; inset++) {
        const x0 = Math.min(imageData.width - 1, left + inset);
        const x1 = Math.max(0, right - inset);
        const y0 = Math.min(imageData.height - 1, top + inset);
        const y1 = Math.max(0, bottom - inset);
        for (let x = x0; x <= Math.min(x1, x0 + tickLength); x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let x = Math.max(x0, x1 - tickLength); x <= x1; x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let y = y0; y <= Math.min(y1, y0 + tickLength); y++) {
            paint(x0, y);
            paint(x1, y);
        }
        for (let y = Math.max(y0, y1 - tickLength); y <= y1; y++) {
            paint(x0, y);
            paint(x1, y);
        }
    }
    return {
        width: imageData.width,
        height: imageData.height,
        data
    };
}

async function imageDataToPanel(imageData, title, line1 = '', line2 = '') {
    const image = await sharp(Buffer.from(imageData.data), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 }
    })
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'contain', background: '#0a0a0a' })
        .png()
        .toBuffer();
    const label = `<svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#101010"/>' +
        `<text x="8" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 36)}</text>` +
        `<text x="8" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 48)}</text>` +
        `<text x="8" y="53" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(line2).slice(0, 48)}</text>` +
        '</svg>';
    return sharp({
        create: { width: PANEL_SIZE, height: PANEL_SIZE + LABEL_HEIGHT, channels: 4, background: BACKGROUND }
    })
        .composite([
            { input: image, left: 0, top: 0 },
            { input: Buffer.from(label), left: 0, top: PANEL_SIZE }
        ])
        .png()
        .toBuffer();
}

function metricsLine(candidate) {
    return `s=${formatNumber(candidate?.spatialResidual)} g=${formatNumber(candidate?.gradientResidual)} h=${formatNumber(candidate?.positiveHaloLum)}`;
}

function damageLine(candidate) {
    return `dmg=${formatNumber(candidate?.damagePenalty)} tex=${formatNumber(candidate?.texturePenalty)} nb=${formatNumber(candidate?.nearBlackIncrease)}`;
}

function materializeDirectAlpha({ original, alphaMaps, record, candidate }) {
    const alphaMap = alphaMaps.getAlphaMap(record.anchor?.logoSize);
    if (!alphaMap || !record.position || !candidate) return null;
    const imageData = cloneImageData(original);
    removeWatermark(imageData, alphaMap, record.position, { alphaGain: candidate.alphaGain });
    return imageData;
}

async function renderReviewRow({ record, alphaMaps }) {
    const original = await decodeImageDataInNode(record.filePath);
    const processed = processWatermarkImageData(cloneImageData(original), alphaMaps);
    const direct = materializeDirectAlpha({
        original,
        alphaMaps,
        record,
        candidate: record.bestClean ?? record.bestPerfect ?? record.bestOverall
    });
    if (!direct) throw new Error(`Unable to materialize direct candidate for ${record.fileName}`);

    const cropBox = calculateCropBox(record.position, original);
    const beforeCrop = cropImageData(original, cropBox);
    const currentCrop = cropImageData(processed.imageData, cropBox);
    const directCrop = cropImageData(direct, cropBox);
    const panels = [
        await imageDataToPanel(
            drawCornerMarkers(beforeCrop, record.position, cropBox),
            'before',
            `${original.width}x${original.height}`,
            `${record.anchor?.logoSize}/${record.anchor?.marginRight}/${record.anchor?.marginBottom}`
        ),
        await imageDataToPanel(
            drawCornerMarkers(currentCrop, record.position, cropBox),
            'current production',
            metricsLine(record.production),
            damageLine(record.production)
        ),
        await imageDataToPanel(
            drawCornerMarkers(directCrop, record.position, cropBox),
            `direct alpha ${record.bestClean?.alphaGain ?? record.bestPerfect?.alphaGain ?? record.bestOverall?.alphaGain}`,
            metricsLine(record.bestClean ?? record.bestPerfect ?? record.bestOverall),
            damageLine(record.bestClean ?? record.bestPerfect ?? record.bestOverall)
        ),
        await imageDataToPanel(
            createDiffImageData(currentCrop, directCrop),
            'current to direct diff x6',
            'blue brighter, orange darker',
            'compare texture drift'
        )
    ];
    const rowWidth = panels.length * PANEL_SIZE;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const flags = record.production?.strictFlags?.length ? record.production.strictFlags.join('+') : 'none';
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#070707"/>' +
        `<text x="10" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="12.5" font-weight="700">${escapeSvgText(record.fileName).slice(0, 112)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">diag=${escapeSvgText(record.diagnosis)} flags=${escapeSvgText(flags).slice(0, 86)}</text>` +
        `<text x="10" y="57" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(record.source).slice(0, 112)}</text>` +
        `<text x="10" y="74" fill="#78838a" font-family="Arial, sans-serif" font-size="9.5">current=${record.currentAlphaGain ?? 'n/a'} bestClean=${record.bestClean?.alphaGain ?? 'none'} bestPerfect=${record.bestPerfect?.alphaGain ?? 'none'}</text>` +
        '</svg>';
    const rowBuffer = await sharp({
        create: { width: rowWidth, height: rowHeight, channels: 4, background: BACKGROUND }
    })
        .composite([
            { input: Buffer.from(header), left: 0, top: 0 },
            ...panels.map((panel, index) => ({ input: panel, left: index * PANEL_SIZE, top: HEADER_HEIGHT }))
        ])
        .png()
        .toBuffer();
    return { rowBuffer, rowWidth, rowHeight };
}

async function renderSheet({ records, alphaMaps, outputPath }) {
    const rows = [];
    for (let index = 0; index < records.length; index++) {
        console.log(`[quality-ablation-review] ${index + 1}/${records.length} ${records[index].fileName}`);
        rows.push(await renderReviewRow({ record: records[index], alphaMaps }));
    }
    const width = Math.max(...rows.map((row) => row.rowWidth));
    const height = rows.reduce((sum, row) => sum + row.rowHeight, 0) + ROW_GAP * Math.max(0, rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.rowBuffer, left: 0, top });
        top += row.rowHeight + ROW_GAP;
    }
    await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return { outputPath, count: records.length, width, height };
}

function summarizeRecords(records) {
    return records.map((record) => ({
        fileName: record.fileName,
        diagnosis: record.diagnosis,
        source: record.source,
        anchor: record.anchor,
        currentAlphaGain: record.currentAlphaGain ?? null,
        bestCleanAlphaGain: record.bestClean?.alphaGain ?? null,
        bestPerfectAlphaGain: record.bestPerfect?.alphaGain ?? null,
        production: {
            strictFlags: record.production?.strictFlags ?? [],
            cleanFlags: record.production?.cleanFlags ?? [],
            spatialResidual: round(record.production?.spatialResidual),
            gradientResidual: round(record.production?.gradientResidual),
            positiveHaloLum: round(record.production?.positiveHaloLum),
            damagePenalty: round(record.production?.damagePenalty),
            texturePenalty: round(record.production?.texturePenalty)
        },
        bestClean: record.bestClean
            ? {
                spatialResidual: round(record.bestClean.spatialResidual),
                gradientResidual: round(record.bestClean.gradientResidual),
                positiveHaloLum: round(record.bestClean.positiveHaloLum),
                damagePenalty: round(record.bestClean.damagePenalty),
                texturePenalty: round(record.bestClean.texturePenalty)
            }
            : null
    }));
}

function createMarkdown({ outputDir, records, sheet }) {
    const lines = [
        '# Online Quality Ablation Review Pack',
        '',
        `- Output dir: \`${outputDir}\``,
        `- Sheet: \`${sheet.outputPath}\``,
        `- Records: ${records.length}`,
        '',
        '## Review Target',
        '',
        '- Compare current production against the best clean direct-alpha candidate.',
        '- Use this only as visual evidence for a narrow conservative-alpha gate.',
        '- A candidate is not production-ready unless it also protects pass rate and strict/severe defect counts on the same Phase 5 baseline.',
        '',
        '## Records',
        ''
    ];
    for (const record of records) {
        lines.push(
            `- ${record.fileName} | ${record.diagnosis} | current=${record.currentAlphaGain ?? 'n/a'} | bestClean=${record.bestClean?.alphaGain ?? 'none'} | source=${record.source}`
        );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const ablation = JSON.parse(stripBom(await readFile(args.ablationPath, 'utf8')));
    const records = (ablation.records ?? [])
        .filter((record) => record.queueName === args.queueName && record.bestClean)
        .sort((left, right) => {
            const leftDelta = Math.abs((left.currentAlphaGain ?? 0) - (left.bestClean?.alphaGain ?? 0));
            const rightDelta = Math.abs((right.currentAlphaGain ?? 0) - (right.bestClean?.alphaGain ?? 0));
            return rightDelta - leftDelta || left.fileName.localeCompare(right.fileName);
        });
    if (records.length === 0) {
        throw new Error(`No bestClean records found for queue ${args.queueName}`);
    }
    const alphaMaps = resolveAlphaMaps();
    const sheet = await renderSheet({
        records,
        alphaMaps,
        outputPath: path.join(args.outputDir, `${args.queueName}-bestClean.png`)
    });
    const summary = {
        generatedAt: new Date().toISOString(),
        ablationPath: args.ablationPath,
        outputDir: args.outputDir,
        queueName: args.queueName,
        sheet,
        records: summarizeRecords(records)
    };
    await writeFile(path.join(args.outputDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'README.md'), createMarkdown({
        outputDir: args.outputDir,
        records,
        sheet
    }), 'utf8');
    console.log(JSON.stringify({ outputDir: args.outputDir, sheet, records: records.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
