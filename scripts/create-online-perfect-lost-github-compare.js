import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_CURRENT_MONITOR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-current/latest.json'
);
const DEFAULT_BASELINE_MONITOR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/initial/latest.json'
);
const DEFAULT_OLD_ROOT = path.resolve('.artifacts/baseline-642db00');
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/github-compare/perfect-lost-v1.0.27-vs-current'
);
const PANEL_SIZE = 190;
const LABEL_HEIGHT = 54;
const HEADER_HEIGHT = 76;
const ROW_GAP = 12;
const BACKGROUND = '#111111';

function parseArgs(argv) {
    const parsed = {
        currentMonitorPath: DEFAULT_CURRENT_MONITOR,
        baselineMonitorPath: DEFAULT_BASELINE_MONITOR,
        oldRoot: DEFAULT_OLD_ROOT,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: Infinity
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--current-monitor') {
            parsed.currentMonitorPath = path.resolve(args.shift() || parsed.currentMonitorPath);
        } else if (arg === '--baseline-monitor') {
            parsed.baselineMonitorPath = path.resolve(args.shift() || parsed.baselineMonitorPath);
        } else if (arg === '--old-root') {
            parsed.oldRoot = path.resolve(args.shift() || parsed.oldRoot);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--limit') {
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

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function severity(record) {
    const metrics = record.metrics ?? {};
    return (
        (record.severeDefect ? 1000 : 0) +
        (record.strictFlags?.length ?? 0) * 25 +
        Math.max(0, metrics.damagePenalty ?? 0) * 120 +
        Math.max(0, metrics.texturePenalty ?? 0) * 100 +
        Math.max(0, metrics.positiveHaloLum ?? 0) * 3 +
        Math.max(0, metrics.gradient ?? 0) * 90 +
        Math.max(0, metrics.residual ?? 0) * 90 +
        Math.max(0, metrics.nearBlackIncrease ?? 0) * 200
    );
}

function selectPerfectLost(currentRecords, baselineRecords, limit) {
    const currentByFile = new Map(currentRecords.map((record) => [record.fileName, record]));
    const baselineByFile = new Map(baselineRecords.map((record) => [record.fileName, record]));
    return [...currentByFile.keys()]
        .filter((fileName) => baselineByFile.has(fileName))
        .map((fileName) => ({
            current: currentByFile.get(fileName),
            baseline: baselineByFile.get(fileName)
        }))
        .filter(({ current, baseline }) => baseline.perfect && !current.perfect)
        .sort((left, right) => (
            severity(right.current) - severity(left.current) ||
            left.current.fileName.localeCompare(right.current.fileName)
        ))
        .slice(0, limit);
}

function resolveCurrentAlphaMaps() {
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
        alpha96Variants: { '20260520': alpha96NewMargin },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            if (typeof size === 'string') return null;
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

async function resolveOldRuntime(oldRoot) {
    const oldProcessor = await import(pathToFileURL(path.join(oldRoot, 'src/core/watermarkProcessor.js')).href);
    const oldAdaptive = await import(pathToFileURL(path.join(oldRoot, 'src/core/adaptiveDetector.js')).href);
    const oldEmbedded = await import(pathToFileURL(path.join(oldRoot, 'src/core/embeddedAlphaMaps.js')).href);
    const alpha48 = oldEmbedded.getEmbeddedAlphaMap(48);
    const alpha96 = oldEmbedded.getEmbeddedAlphaMap(96);
    const alpha96NewMargin = oldEmbedded.getEmbeddedAlphaMap('96-20260520');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', oldEmbedded.getEmbeddedAlphaMap('36-v2')]
    ]);
    return {
        processWatermarkImageData: oldProcessor.processWatermarkImageData,
        alphaMaps: {
            alpha48,
            alpha96,
            alpha96Variants: { '20260520': alpha96NewMargin },
            getAlphaMap(size) {
                if (cache.has(size)) return cache.get(size);
                if (typeof size === 'string') return null;
                const alphaMap = oldAdaptive.interpolateAlphaMap(alpha96, 96, size);
                cache.set(size, alphaMap);
                return alphaMap;
            }
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
    const targetSize = Math.max(180, Math.min(430, Math.round(position.width * 3.6)));
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
    return { width: cropBox.width, height: cropBox.height, data };
}

function createDiffImageData(before, after, gain = 8) {
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
    return { width: before.width, height: before.height, data };
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
    const tickLength = Math.max(10, Math.min(30, Math.round(Math.min(local.width, local.height) * 0.35)));
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
    return { width: imageData.width, height: imageData.height, data };
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
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 34)}</text>` +
        `<text x="8" y="35" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 44)}</text>` +
        `<text x="8" y="50" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(line2).slice(0, 44)}</text>` +
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

function scoreLine(meta) {
    const residual = meta?.residualVisibility ?? meta?.metrics?.residualVisibility;
    return `applied=${meta?.applied === true} skip=${meta?.skipReason ?? 'none'}`;
}

function anchorLine(record) {
    return `${record.metrics?.anchor ?? 'anchor=n/a'} ${record.metrics?.source ?? ''}`;
}

async function renderRow({ pair, currentAlphaMaps, oldRuntime }) {
    const record = pair.current;
    const original = await decodeImageDataInNode(record.filePath);
    const oldProcessed = oldRuntime.processWatermarkImageData(cloneImageData(original), oldRuntime.alphaMaps);
    const currentProcessed = processWatermarkImageData(cloneImageData(original), currentAlphaMaps);
    const position = currentProcessed.meta?.position ?? oldProcessed.meta?.position ?? null;
    const cropBox = calculateCropBox(position, original);
    const beforeCrop = cropImageData(original, cropBox);
    const oldCrop = cropImageData(oldProcessed.imageData, cropBox);
    const currentCrop = cropImageData(currentProcessed.imageData, cropBox);
    const panels = [
        await imageDataToPanel(drawCornerMarkers(beforeCrop, position, cropBox), 'source', `${original.width}x${original.height}`, record.metrics?.anchor),
        await imageDataToPanel(drawCornerMarkers(oldCrop, position, cropBox), 'github v1.0.27', scoreLine(oldProcessed.meta), oldProcessed.meta?.source ?? ''),
        await imageDataToPanel(drawCornerMarkers(currentCrop, position, cropBox), 'current', scoreLine(currentProcessed.meta), currentProcessed.meta?.source ?? ''),
        await imageDataToPanel(createDiffImageData(oldCrop, currentCrop), 'old to current diff x8', 'blue brighter, orange darker', 'visual delta')
    ];
    const rowWidth = panels.length * PANEL_SIZE;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const flags = record.strictFlags?.length ? record.strictFlags.join('+') : 'none';
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#070707"/>' +
        `<text x="10" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="12.5" font-weight="700">${escapeSvgText(record.fileName).slice(0, 110)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">flags=${escapeSvgText(flags).slice(0, 95)}</text>` +
        `<text x="10" y="57" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(anchorLine(record)).slice(0, 110)}</text>` +
        `<text x="10" y="74" fill="#78838a" font-family="Arial, sans-serif" font-size="9.5">current clean=${record.clean} severe=${record.severeDefect} residual=${formatNumber(record.metrics?.residual)} dmg=${formatNumber(record.metrics?.damagePenalty)}</text>` +
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

async function renderSheet({ pairs, currentAlphaMaps, oldRuntime, outputPath }) {
    const rows = [];
    for (let index = 0; index < pairs.length; index++) {
        console.log(`[github-compare] ${index + 1}/${pairs.length} ${pairs[index].current.fileName}`);
        rows.push(await renderRow({ pair: pairs[index], currentAlphaMaps, oldRuntime }));
    }
    const width = Math.max(...rows.map((row) => row.rowWidth));
    const height = rows.reduce((sum, row) => sum + row.rowHeight, 0) + ROW_GAP * (rows.length - 1);
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
    return { outputPath, count: pairs.length, width, height };
}

function createMarkdown({ sheet, pairs, oldRoot }) {
    return [
        '# Perfect Lost GitHub Compare',
        '',
        `- Old root: \`${oldRoot}\``,
        `- Sheet: \`${sheet.outputPath}\``,
        `- Records: ${pairs.length}`,
        '',
        'Each row compares source, GitHub v1.0.27 output, current output, and old-to-current diff.',
        ''
    ].join('\n') + '\n';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const currentMonitor = JSON.parse(stripBom(await readFile(args.currentMonitorPath, 'utf8')));
    const baselineMonitor = JSON.parse(stripBom(await readFile(args.baselineMonitorPath, 'utf8')));
    const pairs = selectPerfectLost(currentMonitor.records ?? [], baselineMonitor.records ?? [], args.limit);
    const currentAlphaMaps = resolveCurrentAlphaMaps();
    const oldRuntime = await resolveOldRuntime(args.oldRoot);
    const sheet = await renderSheet({
        pairs,
        currentAlphaMaps,
        oldRuntime,
        outputPath: path.join(args.outputDir, 'perfectLost-github-v1.0.27-vs-current.png')
    });
    const summary = {
        generatedAt: new Date().toISOString(),
        oldRoot: args.oldRoot,
        currentMonitorPath: args.currentMonitorPath,
        baselineMonitorPath: args.baselineMonitorPath,
        sheet,
        records: pairs.map(({ current }) => ({
            fileName: current.fileName,
            flags: current.strictFlags ?? [],
            anchor: current.metrics?.anchor ?? null,
            source: current.metrics?.source ?? null,
            residual: current.metrics?.residual ?? null,
            damagePenalty: current.metrics?.damagePenalty ?? null,
            texturePenalty: current.metrics?.texturePenalty ?? null,
            nearBlackIncrease: current.metrics?.nearBlackIncrease ?? null,
            severeDefect: current.severeDefect === true,
            clean: current.clean === true
        }))
    };
    await writeFile(path.join(args.outputDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'README.md'), createMarkdown({ sheet, pairs, oldRoot: args.oldRoot }), 'utf8');
    console.log(JSON.stringify({ outputDir: args.outputDir, sheet, records: pairs.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
