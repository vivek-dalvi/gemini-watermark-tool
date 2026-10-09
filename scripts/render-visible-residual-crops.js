import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_SUMMARY_PATH = path.resolve('.artifacts/sample-files-gemini-watermark-residual-visibility-20260610/summary.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest');
const DEFAULT_LIMIT = 30;
const PANEL_SIZE = 180;
const LABEL_HEIGHT = 40;
const HEADER_HEIGHT = 58;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        summaryPath: DEFAULT_SUMMARY_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        sampleRoot: null,
        limit: DEFAULT_LIMIT
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--summary') {
            parsed.summaryPath = path.resolve(args.shift() || parsed.summaryPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || '.');
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

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

    const getAlphaMap = (size) => {
        if (cache.has(size)) return cache.get(size);
        if (typeof size === 'string') return null;
        const alphaMap = interpolateAlphaMap(alpha96, 96, size);
        cache.set(size, alphaMap);
        return alphaMap;
    };

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap
    };
}

function resolvePosition(record, imageData) {
    const config = record.config;
    if (!config) return null;
    const size = config.logoSize ?? config.size;
    const { marginRight, marginBottom } = config;
    if (![size, marginRight, marginBottom].every(Number.isFinite)) return null;

    const x = imageData.width - marginRight - size;
    const y = imageData.height - marginBottom - size;
    if (x < 0 || y < 0 || x + size > imageData.width || y + size > imageData.height) return null;

    return {
        x,
        y,
        width: size,
        height: size
    };
}

function calculateCropBox(position, imageData) {
    const centerX = position.x + position.width / 2;
    const centerY = position.y + position.height / 2;
    const targetSize = Math.max(160, Math.min(384, Math.round(position.width * 2.8)));
    const width = Math.min(targetSize, imageData.width);
    const height = Math.min(targetSize, imageData.height);
    const left = Math.max(0, Math.min(imageData.width - width, Math.round(centerX - width / 2)));
    const top = Math.max(0, Math.min(imageData.height - height, Math.round(centerY - height / 2)));
    return { left, top, width, height };
}

function calculateRoiCropBox(position, imageData) {
    const padding = Math.max(8, Math.round(position.width * 0.22));
    const left = Math.max(0, position.x - padding);
    const top = Math.max(0, position.y - padding);
    const right = Math.min(imageData.width, position.x + position.width + padding);
    const bottom = Math.min(imageData.height, position.y + position.height + padding);
    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
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
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const signedDelta = beforeLum - afterLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * 5);
        if (signedDelta >= 0) {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.48);
            data[offset + 2] = Math.round(amplified * 0.16);
        } else {
            data[offset] = Math.round(amplified * 0.2);
            data[offset + 1] = Math.round(amplified * 0.55);
            data[offset + 2] = amplified;
        }
        data[offset + 3] = 255;
    }

    return {
        width: before.width,
        height: before.height,
        data
    };
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function parseHexColor(color) {
    const match = /^#?([0-9a-f]{6})$/i.exec(color);
    if (!match) return [255, 255, 255];
    const value = Number.parseInt(match[1], 16);
    return [
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ];
}

function blendPixel(data, offset, red, green, blue, alpha = 0.72) {
    data[offset] = Math.round(data[offset] * (1 - alpha) + red * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + green * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + blue * alpha);
    data[offset + 3] = 255;
}

function drawCornerMarkersOnImageData(imageData, position, color) {
    const data = new Uint8ClampedArray(imageData.data);
    const [red, green, blue] = parseHexColor(color);
    const strokeWidth = 2;
    const tickLength = Math.max(10, Math.min(24, Math.round(Math.min(position.width, position.height) * 0.32)));
    const left = Math.max(0, Math.min(imageData.width - 1, Math.round(position.x)));
    const top = Math.max(0, Math.min(imageData.height - 1, Math.round(position.y)));
    const right = Math.max(left, Math.min(imageData.width - 1, Math.round(position.x + position.width)));
    const bottom = Math.max(top, Math.min(imageData.height - 1, Math.round(position.y + position.height)));

    const paint = (x, y) => {
        const offset = (y * imageData.width + x) * 4;
        blendPixel(data, offset, red, green, blue);
    };

    for (let inset = 0; inset < strokeWidth; inset++) {
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

function createLocalContrastImageData(imageData) {
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        sum += lum;
        sumSquares += lum * lum;
        count++;
    }
    const mean = count > 0 ? sum / count : 128;
    const variance = count > 0 ? Math.max(1, sumSquares / count - mean * mean) : 1;
    const std = Math.sqrt(variance);
    const gain = std < 18 ? 3.2 : 2.2;
    const data = new Uint8ClampedArray(imageData.data.length);
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        const enhanced = Math.max(0, Math.min(255, 128 + (lum - mean) * gain));
        data[offset] = enhanced;
        data[offset + 1] = enhanced;
        data[offset + 2] = enhanced;
        data[offset + 3] = imageData.data[offset + 3];
    }
    return {
        width: imageData.width,
        height: imageData.height,
        data
    };
}

function getVisibility(record) {
    return record.detection?.residualVisibility ?? null;
}

function getVisibleReasons(record) {
    const visibility = getVisibility(record);
    if (!visibility?.visible) return [];
    return [
        visibility.visiblePositiveHalo ? 'positiveHalo' : null,
        visibility.visibleGradientResidual ? 'gradient' : null,
        visibility.visibleSpatialResidual ? 'spatial' : null
    ].filter(Boolean);
}

function calculateSeverity(record) {
    const visibility = getVisibility(record);
    if (!visibility) return 0;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function describeRecord(record) {
    const visibility = getVisibility(record);
    const config = record.config ?? {};
    const alphaVariant = config.alphaVariant ? `/${config.alphaVariant}` : '';
    const reasons = getVisibleReasons(record).join('+') || 'none';
    return {
        title: `${record.file}`,
        line1: `${record.bucket} ${config.logoSize}/${config.marginRight}/${config.marginBottom}${alphaVariant} ${record.source}`,
        line2: `halo=${formatNumber(visibility?.positiveHaloLum, 2)} gr=${formatNumber(visibility?.gradientResidual)} sp=${formatNumber(visibility?.spatialResidual)} reasons=${reasons}`
    };
}

async function encodePanel(imageData, { position = null, title, line1 = '', color = '#f2c94c' }) {
    const framedImageData = position
        ? drawCornerMarkersOnImageData(imageData, position, color)
        : imageData;
    const image = await sharp(Buffer.from(framedImageData.data), {
        raw: {
            width: framedImageData.width,
            height: framedImageData.height,
            channels: 4
        }
    })
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'contain', background: '#000000' })
        .png()
        .toBuffer();
    const label = `<svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#101010"/>` +
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 32)}</text>` +
        `<text x="8" y="34" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 42)}</text>` +
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

async function renderRecord({ record, sampleRoot, alphaOptions, outputDir }) {
    const inputPath = path.join(sampleRoot, record.file);
    const original = await decodeImageDataInNode(inputPath);
    const processed = processWatermarkImageData(cloneImageData(original), alphaOptions);
    const currentRecord = {
        ...record,
        source: processed.meta.source || record.source,
        config: processed.meta.config ?? record.config ?? null,
        detection: {
            ...(record.detection ?? {}),
            residualVisibility: processed.meta.detection?.residualVisibility ?? null
        }
    };
    if (currentRecord.detection.residualVisibility?.visible !== true) {
        return null;
    }
    const position = resolvePosition(currentRecord, original) ?? resolvePosition(record, original);
    if (!position) return null;

    const contextCropBox = calculateCropBox(position, original);
    const roiCropBox = calculateRoiCropBox(position, original);
    const contextPosition = {
        x: position.x - contextCropBox.left,
        y: position.y - contextCropBox.top,
        width: position.width,
        height: position.height
    };
    const beforeContextCrop = cropImageData(original, contextCropBox);
    const afterContextCrop = cropImageData(processed.imageData, contextCropBox);
    const afterRoiCrop = cropImageData(processed.imageData, roiCropBox);
    const afterContrastCrop = createLocalContrastImageData(afterRoiCrop);
    const diffRoiCrop = createDiffImageData(
        cropImageData(original, roiCropBox),
        afterRoiCrop
    );
    const { title, line1, line2 } = describeRecord(currentRecord);
    const color = record.bucket === 'metric-pass' ? '#f2c94c' : '#eb5757';
    const baseName = path.basename(record.file, path.extname(record.file)).replace(/[^\w.-]+/g, '_');

    const panels = [
        await encodePanel(beforeContextCrop, {
            position: contextPosition,
            title: 'before context',
            line1: `${position.width}px anchor`,
            color
        }),
        await encodePanel(afterContextCrop, {
            position: contextPosition,
            title: 'after context',
            line1: `halo=${formatNumber(processed.meta.detection?.residualVisibility?.positiveHaloLum, 2)}`,
            color
        }),
        await encodePanel(afterRoiCrop, {
            title: 'after ROI raw',
            line1: 'no overlay'
        }),
        await encodePanel(afterContrastCrop, {
            title: 'after contrast',
            line1: 'local luma contrast'
        }),
        await encodePanel(diffRoiCrop, {
            title: 'ROI diff x5',
            line1: 'orange removed / blue added',
            color
        })
    ];

    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0b0b0b"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(title).slice(0, 130)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(line1).slice(0, 150)}</text>` +
        `<text x="10" y="53" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(line2).slice(0, 150)} current=${escapeSvgText(processed.meta.source || 'skipped').slice(0, 80)}</text>` +
        `</svg>`;
    const rowBuffer = await sharp({
        create: {
            width: rowWidth,
            height: rowHeight,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite([
            { input: Buffer.from(header), left: 0, top: 0 },
            ...panels.map((panel, index) => ({
                input: panel.buffer,
                left: index * (PANEL_SIZE + PANEL_GAP),
                top: HEADER_HEIGHT
            }))
        ])
        .png()
        .toBuffer();

    const cropPath = path.join(outputDir, 'rows', `${baseName}-visible-residual.png`);
    await mkdir(path.dirname(cropPath), { recursive: true });
    await writeFile(cropPath, rowBuffer);

    return {
        record: currentRecord,
        sourceRecord: record,
        cropPath,
        rowBuffer,
        rowWidth,
        rowHeight,
        currentMeta: {
            applied: processed.meta.applied === true,
            source: processed.meta.source || null,
            config: processed.meta.config ?? null,
            residualVisibility: processed.meta.detection?.residualVisibility ?? null
        }
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
    return outputPath;
}

function uniqueRecords(records) {
    const seen = new Set();
    const deduped = [];
    for (const record of records) {
        if (!record?.file || seen.has(record.file)) continue;
        seen.add(record.file);
        deduped.push(record);
    }
    return deduped;
}

function pickGroups(summary, recordsByFile, limit) {
    const visibleRecords = [...recordsByFile.values()]
        .filter((record) => getVisibility(record)?.visible)
        .sort((left, right) => calculateSeverity(right) - calculateSeverity(left));
    const visibleTop = uniqueRecords((summary.visibleTop ?? [])
        .map((item) => recordsByFile.get(item.file) ?? item))
        .slice(0, limit);

    return {
        metricPassVisible: visibleRecords
            .filter((record) => record.bucket === 'metric-pass')
            .slice(0, limit),
        visibleTop,
        positiveHalo: visibleRecords
            .filter((record) => getVisibility(record)?.visiblePositiveHalo)
            .slice(0, limit),
        gradientResidual: visibleRecords
            .filter((record) => getVisibility(record)?.visibleGradientResidual)
            .slice(0, limit),
        spatialResidual: visibleRecords
            .filter((record) => getVisibility(record)?.visibleSpatialResidual)
            .slice(0, limit)
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const summary = JSON.parse(stripBom(await readFile(args.summaryPath, 'utf8')));
    const sampleRoot = args.sampleRoot || path.resolve(summary.root || '.');
    const recordsByFile = new Map((summary.records ?? []).map((record) => [record.file, record]));
    const groups = pickGroups(summary, recordsByFile, args.limit);
    const alphaOptions = resolveAlphaMaps();
    await mkdir(args.outputDir, { recursive: true });

    const renderedGroups = {};
    for (const [groupName, groupRecords] of Object.entries(groups)) {
        const groupDir = path.join(args.outputDir, groupName);
        await mkdir(groupDir, { recursive: true });
        const rows = [];
        for (const record of groupRecords) {
            const row = await renderRecord({
                record,
                sampleRoot,
                alphaOptions,
                outputDir: groupDir
            });
            if (row) rows.push(row);
        }
        const sheetPath = await renderSheet({
            rows,
            outputPath: path.join(args.outputDir, `${groupName}.png`)
        });
        renderedGroups[groupName] = {
            count: rows.length,
            sheetPath,
            records: rows.map((row) => ({
                file: row.record.file,
                bucket: row.record.bucket,
                source: row.record.source,
                config: row.record.config ?? null,
                residualVisibility: getVisibility(row.record),
                currentMeta: row.currentMeta,
                cropPath: row.cropPath
            }))
        };
    }

    const report = {
        generatedAt: new Date().toISOString(),
        summaryPath: args.summaryPath,
        sampleRoot,
        outputDir: args.outputDir,
        limit: args.limit,
        sourceSummary: summary.summary ?? null,
        groups: renderedGroups
    };
    const reportPath = path.join(args.outputDir, 'summary.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
        outputDir: args.outputDir,
        reportPath,
        groups: Object.fromEntries(
            Object.entries(renderedGroups).map(([name, group]) => [name, {
                count: group.count,
                sheetPath: group.sheetPath
            }])
        )
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
