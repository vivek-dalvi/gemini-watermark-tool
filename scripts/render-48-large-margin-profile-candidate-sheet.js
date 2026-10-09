import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-profile-candidate.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const PANEL_SIZE = 170;
const LABEL_HEIGHT = 42;
const HEADER_HEIGHT = 58;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
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
    return {
        x: imageData.width - config.marginRight - config.logoSize,
        y: imageData.height - config.marginBottom - config.logoSize,
        width: config.logoSize,
        height: config.logoSize
    };
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

function transformMidBoost(alphaMap) {
    const transformed = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        const alpha = alphaMap[index];
        transformed[index] = alpha >= 0.12 && alpha <= 0.4
            ? Math.max(0, Math.min(0.99, alpha * 1.24))
            : alpha;
    }
    return transformed;
}

function applyRemoval(original, alphaMap, position, alphaGain) {
    const imageData = cloneImageData(original);
    removeWatermark(imageData, alphaMap, position, { alphaGain });
    return imageData;
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
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 32)}</text>` +
        `<text x="8" y="34" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 42)}</text>` +
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

async function renderProbeRow({ probe, sampleRoot, alpha48, profileAlpha }) {
    const original = await decodeImageDataInNode(path.join(sampleRoot, probe.file));
    const position = resolvePosition({ logoSize: 48, marginRight: 96, marginBottom: 96 }, original);
    const cropBox = calculateRoiCropBox(position, original);
    const base = applyRemoval(original, alpha48, position, 1);
    const best = probe.best
        ? applyRemoval(original, profileAlpha, position, probe.best.alphaGain)
        : base;
    const panels = [
        await encodePanel(cropImageData(original, cropBox), {
            title: 'before ROI',
            line1: probe.reviewVerdict
        }),
        await encodePanel(cropImageData(base, cropBox), {
            title: 'base a=1',
            line1: `baseline sev=${probe.baseline.severity}`
        }),
        await encodePanel(cropImageData(best, cropBox), {
            title: 'mid-boost best',
            line1: `a=${probe.best?.alphaGain} visible=${probe.best?.visible}`
        }),
        await encodePanel(createLocalContrastImageData(cropImageData(best, cropBox)), {
            title: 'best contrast',
            line1: `sev=${probe.best?.severity}`
        })
    ];

    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0b0b0b"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(probe.file).slice(0, 120)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">baseline=${probe.baseline.severity} best=${probe.best?.severity} cleared=${probe.clearedVisible}</text>` +
        `<text x="10" y="53" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">halo=${probe.best?.positiveHaloLum} gr=${probe.best?.gradientResidual} sp=${probe.best?.spatialResidual} tex=${probe.best?.texturePenalty}</text>` +
        `</svg>`;

    return {
        rowWidth,
        rowHeight,
        rowBuffer: await sharp({
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
            .toBuffer()
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
    const alpha48 = getEmbeddedAlphaMap(48);
    const profileAlpha = transformMidBoost(alpha48);
    const rows = [];
    for (const probe of report.probes ?? []) {
        rows.push(await renderProbeRow({
            probe,
            sampleRoot: report.sampleRoot,
            alpha48,
            profileAlpha
        }));
    }
    const sheetPath = path.join(args.outputDir, 'large-margin-48-profile-candidate.png');
    await renderSheet({ rows, outputPath: sheetPath });
    const summaryPath = path.join(args.outputDir, 'large-margin-48-profile-candidate-sheet.json');
    await writeFile(summaryPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        sheetPath,
        count: rows.length
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
