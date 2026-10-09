import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-power088-gate.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const PANEL_SIZE = 170;
const LABEL_HEIGHT = 44;
const HEADER_HEIGHT = 70;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#161616';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        includeAll: false
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
        if (arg === '--all') {
            parsed.includeAll = true;
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

function resolvePosition(config, imageData) {
    const size = config.logoSize ?? config.size;
    return {
        x: imageData.width - config.marginRight - size,
        y: imageData.height - config.marginBottom - size,
        width: size,
        height: size
    };
}

function calculateCropBox(position, imageData) {
    const padding = Math.max(10, Math.round(position.width * 0.35));
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
    const gain = std < 18 ? 3.5 : 2.3;
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

function transformPower(alphaMap, exponent) {
    const transformed = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        transformed[index] = Math.max(0, Math.min(0.99, Math.pow(alphaMap[index], exponent)));
    }
    return transformed;
}

function applyCandidate(original, report) {
    const config = report.candidate.config;
    const position = resolvePosition(config, original);
    const alpha48 = getEmbeddedAlphaMap(48);
    const alphaMap = transformPower(alpha48, 0.88);
    const imageData = cloneImageData(original);
    removeWatermark(imageData, alphaMap, position, { alphaGain: report.candidate.alphaGain });
    return {
        imageData,
        position
    };
}

async function encodePanel(imageData, { title, line1 = '' }) {
    const image = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'contain', background: '#000000' })
        .png()
        .toBuffer();
    const label = `<svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#101010"/>` +
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 34)}</text>` +
        `<text x="8" y="35" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 44)}</text>` +
        `</svg>`;

    return await sharp({
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
        .toBuffer();
}

function classifyRecord(record) {
    if (record.candidate.clearedVisible) return 'cleared-applicable';
    if (!record.candidate.texture.safe) return 'unsafe';
    if (record.candidate.applicable && record.candidate.improvedSeverity) return 'applicable-improved';
    if (record.candidate.applicable) return 'applicable-no-clear';
    return 'not-applicable';
}

function shouldRenderRecord(record, includeAll) {
    return includeAll ||
        record.candidate.applicable ||
        record.candidate.clearedVisible ||
        !record.candidate.texture.safe ||
        record.targetProfile;
}

function recordSortKey(record) {
    const classOrder = {
        'cleared-applicable': 0,
        unsafe: 1,
        'applicable-improved': 2,
        'applicable-no-clear': 3,
        'not-applicable': 4
    };
    return [
        classOrder[classifyRecord(record)] ?? 9,
        record.targetProfile ? 0 : 1,
        record.profileLine,
        record.file
    ];
}

async function renderRecordRow({ record, report }) {
    const original = await decodeImageDataInNode(path.resolve(report.sampleRoot, record.file));
    const { imageData: candidate, position } = applyCandidate(original, report);
    const cropBox = calculateCropBox(position, original);
    const beforeCrop = cropImageData(original, cropBox);
    const afterCrop = cropImageData(candidate, cropBox);
    const className = classifyRecord(record);
    const panels = [
        await encodePanel(beforeCrop, {
            title: 'before 48/96/96',
            line1: `e=${record.candidate.originalEvidence.spatial}/${record.candidate.originalEvidence.gradient}`
        }),
        await encodePanel(afterCrop, {
            title: 'candidate after',
            line1: `sev=${record.candidate.visibility.severity} d=${record.candidate.severityDelta}`
        }),
        await encodePanel(createLocalContrastImageData(afterCrop), {
            title: 'after contrast',
            line1: `visible=${record.candidate.visibility.visible} safe=${record.candidate.texture.safe}`
        })
    ];
    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0b0b0b"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 110)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">class=${escapeSvgText(className)} profile=${escapeSvgText(record.profileLine)} target=${record.targetProfile}</text>` +
        `<text x="10" y="56" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">cleared=${record.candidate.clearedVisible} applicable=${record.candidate.applicable} texture=${record.candidate.texture.texturePenalty} unsafe=${!record.candidate.texture.safe}</text>` +
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
            ...panels.map((input, index) => ({
                input,
                left: index * (PANEL_SIZE + PANEL_GAP),
                top: HEADER_HEIGHT
            }))
        ])
        .png()
        .toBuffer();

    return {
        rowBuffer,
        rowWidth,
        rowHeight
    };
}

async function renderSheet({ rows, outputPath }) {
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    await mkdir(args.outputDir, { recursive: true });
    const records = [...(report.records ?? [])]
        .filter((record) => shouldRenderRecord(record, args.includeAll))
        .sort((left, right) => {
            const leftKey = recordSortKey(left);
            const rightKey = recordSortKey(right);
            return leftKey.join('\u0000').localeCompare(rightKey.join('\u0000'));
        });
    const rows = [];
    for (const record of records) {
        rows.push(await renderRecordRow({ record, report }));
    }
    const sheetPath = path.join(args.outputDir, 'large-margin-48-power088-gate.png');
    await renderSheet({ rows, outputPath: sheetPath });
    const summaryPath = path.join(args.outputDir, 'large-margin-48-power088-gate-sheet.json');
    await writeFile(summaryPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        sheetPath,
        count: rows.length,
        includeAll: args.includeAll
    }, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        sheetPath,
        summaryPath,
        count: rows.length
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
