import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-review-pack'
);
const DEFAULT_LIMIT = 30;
const PANEL_SIZE = 190;
const LABEL_HEIGHT = 54;
const HEADER_HEIGHT = 76;
const ROW_GAP = 12;
const BACKGROUND = '#111111';

function parseArgs(argv) {
    const parsed = {
        currentMonitorPath: DEFAULT_CURRENT_MONITOR,
        baselineMonitorPath: DEFAULT_BASELINE_MONITOR,
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: DEFAULT_LIMIT
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--current-monitor') {
            parsed.currentMonitorPath = path.resolve(args.shift() || parsed.currentMonitorPath);
        } else if (arg === '--baseline-monitor') {
            parsed.baselineMonitorPath = path.resolve(args.shift() || parsed.baselineMonitorPath);
        } else if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
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
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', alpha36V2]
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

function selectReviewQueues({ currentRecords, baselineRecords, limit }) {
    const currentByFile = new Map(currentRecords.map((record) => [record.fileName, record]));
    const baselineByFile = new Map(baselineRecords.map((record) => [record.fileName, record]));
    const shared = [...currentByFile.keys()].filter((fileName) => baselineByFile.has(fileName));

    const perfectLost = [];
    const severeDefectIntroduced = [];
    const passGained = [];
    for (const fileName of shared) {
        const current = currentByFile.get(fileName);
        const baseline = baselineByFile.get(fileName);
        if (baseline.perfect && !current.perfect) perfectLost.push(current);
        if (!baseline.severeDefect && current.severeDefect) severeDefectIntroduced.push(current);
        if (!baseline.metrics.pass && current.metrics.pass) passGained.push(current);
    }

    return {
        perfectLost: sortAndLimit(perfectLost, limit),
        severeDefectIntroduced: sortAndLimit(severeDefectIntroduced, limit),
        passGained: sortAndLimit(passGained, limit)
    };
}

function sortAndLimit(records, limit) {
    return [...records]
        .sort((left, right) => severity(right) - severity(left) || left.fileName.localeCompare(right.fileName))
        .slice(0, limit);
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
        const signedDelta = beforeLum - afterLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * gain);
        if (signedDelta >= 0) {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.48);
            data[offset + 2] = Math.round(amplified * 0.14);
        } else {
            data[offset] = Math.round(amplified * 0.18);
            data[offset + 1] = Math.round(amplified * 0.52);
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

function findSourceRecord(sourceByFile, reviewRecord) {
    return sourceByFile.get(reviewRecord.fileName) ?? null;
}

function fallbackPosition(sourceRecord, imageData) {
    const anchor = sourceRecord?.actualAnchor;
    const size = anchor?.logoSize;
    const marginRight = anchor?.marginRight;
    const marginBottom = anchor?.marginBottom;
    if ([size, marginRight, marginBottom].every(Number.isFinite)) {
        const x = imageData.width - marginRight - size;
        const y = imageData.height - marginBottom - size;
        if (x >= 0 && y >= 0 && x + size <= imageData.width && y + size <= imageData.height) {
            return { x, y, width: size, height: size };
        }
    }
    return null;
}

function scoreLine(record) {
    const metrics = record.metrics ?? {};
    return `s=${formatNumber(metrics.residual)} g=${formatNumber(metrics.gradient)} h=${formatNumber(metrics.positiveHaloLum)}`;
}

function damageLine(record) {
    const metrics = record.metrics ?? {};
    return `dmg=${formatNumber(metrics.damagePenalty)} tex=${formatNumber(metrics.texturePenalty)} nb=${formatNumber(metrics.nearBlackIncrease)}`;
}

async function renderReviewRow({ reviewRecord, sourceByFile, alphaMaps }) {
    const sourceRecord = findSourceRecord(sourceByFile, reviewRecord);
    const original = await decodeImageDataInNode(reviewRecord.filePath);
    const processed = processWatermarkImageData(cloneImageData(original), alphaMaps);
    const position = sourceRecord?.position ?? processed.meta?.position ?? fallbackPosition(sourceRecord, original);
    const cropBox = calculateCropBox(position, original);
    const beforeCrop = cropImageData(original, cropBox);
    const afterCrop = cropImageData(processed.imageData, cropBox);
    const markedBefore = drawCornerMarkers(beforeCrop, position, cropBox);
    const markedAfter = drawCornerMarkers(afterCrop, position, cropBox);
    const panels = [
        await imageDataToPanel(markedBefore, 'before', `${original.width}x${original.height}`, reviewRecord.metrics.anchor),
        await imageDataToPanel(markedAfter, 'current after', scoreLine(reviewRecord), damageLine(reviewRecord)),
        await imageDataToPanel(createDiffImageData(beforeCrop, afterCrop), 'diff x5', 'orange removed', 'blue added')
    ];
    const rowWidth = panels.length * PANEL_SIZE;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const flags = reviewRecord.strictFlags?.length
        ? reviewRecord.strictFlags.join('+')
        : reviewRecord.severeFlags?.join('+') || 'none';
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        '<rect width="100%" height="100%" fill="#070707"/>' +
        `<text x="10" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="12.5" font-weight="700">${escapeSvgText(reviewRecord.fileName).slice(0, 96)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(flags).slice(0, 108)}</text>` +
        `<text x="10" y="56" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(reviewRecord.metrics.source).slice(0, 108)}</text>` +
        `<text x="10" y="71" fill="#78838a" font-family="Arial, sans-serif" font-size="9.5">bucket=${escapeSvgText(reviewRecord.metrics.bucket)} perfect=${reviewRecord.perfect} clean=${reviewRecord.clean} severe=${reviewRecord.severeDefect}</text>` +
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

async function renderSheet({ records, sourceByFile, alphaMaps, outputPath }) {
    if (records.length === 0) return null;
    const rows = [];
    for (let index = 0; index < records.length; index++) {
        console.log(`[quality-review] ${path.basename(outputPath)} ${index + 1}/${records.length} ${records[index].fileName}`);
        rows.push(await renderReviewRow({ reviewRecord: records[index], sourceByFile, alphaMaps }));
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
    return { outputPath, count: records.length, width, height };
}

function summarizeQueue(records) {
    const countBy = (resolveKey) => {
        const counts = {};
        for (const record of records) {
            const values = resolveKey(record);
            for (const value of Array.isArray(values) ? values : [values]) {
                counts[value] = (counts[value] ?? 0) + 1;
            }
        }
        return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    };
    return {
        total: records.length,
        flagCounts: countBy((record) => record.strictFlags?.length ? record.strictFlags : record.severeFlags ?? []),
        sourceCounts: countBy((record) => record.metrics.source),
        anchorCounts: countBy((record) => record.metrics.anchor),
        examples: records.slice(0, 10).map((record) => ({
            fileName: record.fileName,
            flags: record.strictFlags,
            severeFlags: record.severeFlags,
            source: record.metrics.source,
            anchor: record.metrics.anchor,
            residual: round(record.metrics.residual),
            gradient: round(record.metrics.gradient),
            halo: round(record.metrics.positiveHaloLum),
            damage: round(record.metrics.damagePenalty),
            texture: round(record.metrics.texturePenalty),
            nearBlack: round(record.metrics.nearBlackIncrease)
        }))
    };
}

function createMarkdown({ outputDir, queues, sheets, currentMonitorPath, baselineMonitorPath }) {
    const lines = [
        '# Online Quality Review Pack',
        '',
        `- Current monitor: \`${currentMonitorPath}\``,
        `- Baseline monitor: \`${baselineMonitorPath}\``,
        `- Output dir: \`${outputDir}\``,
        '',
        '## Queues',
        ''
    ];
    for (const [name, records] of Object.entries(queues)) {
        lines.push(`- ${name}: ${records.length}`);
    }
    lines.push('');
    lines.push('## Sheets');
    lines.push('');
    for (const [name, sheet] of Object.entries(sheets)) {
        lines.push(`- ${name}: ${sheet?.outputPath ?? 'none'}`);
    }
    lines.push('');
    lines.push('## Review Guidance');
    lines.push('');
    lines.push('- `perfectLost`: 判断当前 damage / texture flag 是否肉眼真实成立。');
    lines.push('- `severeDefectIntroduced`: 判断严重瑕疵是否真实损伤，以及是否集中在某类策略。');
    lines.push('- `passGained`: 判断新增通过样本是否值得用轻微瑕疵换覆盖率。');
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const currentMonitor = JSON.parse(stripBom(await readFile(args.currentMonitorPath, 'utf8')));
    const baselineMonitor = JSON.parse(stripBom(await readFile(args.baselineMonitorPath, 'utf8')));
    const sourceReport = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const sourceByFile = new Map((sourceReport.results ?? []).map((record) => [record.fileName, record]));
    const alphaMaps = resolveAlphaMaps();
    const queues = selectReviewQueues({
        currentRecords: currentMonitor.records ?? [],
        baselineRecords: baselineMonitor.records ?? [],
        limit: args.limit
    });
    const sheets = {};
    for (const [name, records] of Object.entries(queues)) {
        sheets[name] = await renderSheet({
            records,
            sourceByFile,
            alphaMaps,
            outputPath: path.join(args.outputDir, `${name}.png`)
        });
    }
    const summary = {
        generatedAt: new Date().toISOString(),
        currentMonitorPath: args.currentMonitorPath,
        baselineMonitorPath: args.baselineMonitorPath,
        reportPath: args.reportPath,
        limit: args.limit,
        queues: Object.fromEntries(Object.entries(queues).map(([name, records]) => [name, summarizeQueue(records)])),
        sheets
    };
    await writeFile(path.join(args.outputDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'README.md'), createMarkdown({
        outputDir: args.outputDir,
        queues,
        sheets,
        currentMonitorPath: args.currentMonitorPath,
        baselineMonitorPath: args.baselineMonitorPath
    }), 'utf8');
    console.log(JSON.stringify({
        outputDir: args.outputDir,
        queues: Object.fromEntries(Object.entries(queues).map(([name, records]) => [name, records.length])),
        sheets
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
