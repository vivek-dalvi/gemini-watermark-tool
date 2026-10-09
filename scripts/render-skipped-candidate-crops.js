import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_SCAN_PATH = path.resolve('.artifacts/download-samples-geometry-scan-current-skipped/geometry-scan.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/download-samples-skipped-crops');
const CROP_SIZE = 192;
const PANEL_SIZE = 220;
const LABEL_HEIGHT = 64;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        scanPath: DEFAULT_SCAN_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--scan') {
            parsed.scanPath = path.resolve(args.shift() || parsed.scanPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
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

function chooseCandidate(record) {
    return record.bestAccepted ??
        record.bestEvidence ??
        record.bestValidation ??
        record.coarseTop?.[0] ??
        null;
}

function getCandidatePosition(candidate, imageData) {
    const size = candidate.size ?? candidate.width ?? candidate.logoSize;
    const marginRight = candidate.marginRight;
    const marginBottom = candidate.marginBottom;
    const x = Number.isFinite(candidate.x)
        ? candidate.x
        : imageData.width - marginRight - size;
    const y = Number.isFinite(candidate.y)
        ? candidate.y
        : imageData.height - marginBottom - size;

    if (![x, y, size].every(Number.isFinite)) return null;
    return { x, y, width: size, height: size };
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

async function encodePanel(imageData, { cropBox, position, title, metrics, color = '#27ae60' }) {
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
        `<text x="8" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(metrics.slice(0, 54))}</text>` +
        `<text x="8" y="56" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(metrics.slice(54, 108))}</text>` +
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

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const cache = new Map([
        [48, alpha48],
        [96, alpha96]
    ]);

    return (size) => {
        if (cache.has(size)) return cache.get(size);
        const alphaMap = interpolateAlphaMap(alpha96, 96, size);
        cache.set(size, alphaMap);
        return alphaMap;
    };
}

function formatCandidateMetrics(record, candidate) {
    const accepted = candidate.accepted === true ? 'accepted' : 'rejected';
    const alphaGain = Number.isFinite(candidate.alphaGain) ? candidate.alphaGain : 1;
    return `${accepted} ${candidate.size}/${candidate.marginRight}/${candidate.marginBottom} a=${alphaGain} ` +
        `sp=${candidate.spatial} gr=${candidate.gradient} psp=${candidate.processedSpatial ?? 'n/a'} pgr=${candidate.processedGradient ?? 'n/a'} ` +
        `hard=${candidate.hardReject ?? 'n/a'} tex=${candidate.texturePenalty ?? 'n/a'} prev=${record.previousMeta?.originalSpatial}/${record.previousMeta?.originalGradient}`;
}

async function renderRecord({ record, resolveAlphaMap, outputDir }) {
    const candidate = chooseCandidate(record);
    if (!candidate) return null;

    const original = await decodeImageDataInNode(record.input);
    const position = getCandidatePosition(candidate, original);
    if (!position) return null;

    const alphaMap = resolveAlphaMap(position.width);
    const restored = cloneImageData(original);
    removeWatermark(restored, alphaMap, position, {
        alphaGain: Number.isFinite(candidate.alphaGain) ? candidate.alphaGain : 1
    });

    const cropBox = calculateCropBox(position, original);
    const originalCrop = cropImageData(original, cropBox);
    const restoredCrop = cropImageData(restored, cropBox);
    const diffCrop = createDiffImageData(originalCrop, restoredCrop);
    const metrics = formatCandidateMetrics(record, candidate);
    const panelColor = candidate.accepted === true ? '#27ae60' : '#eb5757';
    const baseName = path.basename(record.fileName, path.extname(record.fileName));

    const panels = [
        await encodePanel(originalCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: position.x - cropBox.left,
                y: position.y - cropBox.top,
                width: position.width,
                height: position.height
            },
            title: `${record.fileName} original`,
            metrics,
            color: panelColor
        }),
        await encodePanel(restoredCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: position.x - cropBox.left,
                y: position.y - cropBox.top,
                width: position.width,
                height: position.height
            },
            title: 'restored candidate',
            metrics,
            color: panelColor
        }),
        await encodePanel(diffCrop, {
            cropBox: { ...cropBox, left: 0, top: 0 },
            position: {
                x: position.x - cropBox.left,
                y: position.y - cropBox.top,
                width: position.width,
                height: position.height
            },
            title: 'diff x5',
            metrics,
            color: panelColor
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

    const outputPath = path.join(outputDir, `${baseName}-candidate-crops.png`);
    await writeFile(outputPath, rowBuffer);

    return {
        record,
        candidate,
        outputPath,
        rowBuffer,
        rowWidth,
        rowHeight
    };
}

async function renderSheet({ rows, outputPath }) {
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const scan = JSON.parse(stripBom(await readFile(args.scanPath, 'utf8')));
    await mkdir(args.outputDir, { recursive: true });
    const resolveAlphaMap = await loadAlphaMaps();
    const rows = [];

    for (const record of scan.records ?? []) {
        const row = await renderRecord({
            record,
            resolveAlphaMap,
            outputDir: args.outputDir
        });
        if (row) rows.push(row);
    }

    const sheetPath = path.join(args.outputDir, 'skipped-candidate-crops.png');
    await renderSheet({ rows, outputPath: sheetPath });
    const summaryPath = path.join(args.outputDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        scanPath: args.scanPath,
        sheetPath,
        records: rows.map((row) => ({
            fileName: row.record.fileName,
            candidate: {
                accepted: row.candidate.accepted ?? null,
                size: row.candidate.size,
                marginRight: row.candidate.marginRight,
                marginBottom: row.candidate.marginBottom,
                alphaGain: row.candidate.alphaGain ?? null,
                spatial: row.candidate.spatial ?? null,
                gradient: row.candidate.gradient ?? null,
                processedSpatial: row.candidate.processedSpatial ?? null,
                processedGradient: row.candidate.processedGradient ?? null,
                hardReject: row.candidate.hardReject ?? null,
                texturePenalty: row.candidate.texturePenalty ?? null
            },
            cropPath: row.outputPath
        }))
    }, null, 2));

    console.log(JSON.stringify({
        count: rows.length,
        sheetPath,
        summaryPath
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
