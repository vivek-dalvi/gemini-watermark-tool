import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_PROFILE_REPORT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/model-investigation-alpha-profile.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const PANEL_SIZE = 170;
const LABEL_HEIGHT = 42;
const HEADER_HEIGHT = 58;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        profileReportPath: DEFAULT_PROFILE_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.profileReportPath = path.resolve(args.shift() || parsed.profileReportPath);
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
    const size = config.logoSize ?? config.size;
    return {
        x: imageData.width - config.marginRight - size,
        y: imageData.height - config.marginBottom - size,
        width: size,
        height: size
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

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function blurAlphaMap(alphaMap, width, height) {
    const blurred = new Float32Array(alphaMap.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const sy = y + dy;
                if (sy < 0 || sy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sx = x + dx;
                    if (sx < 0 || sx >= width) continue;
                    sum += alphaMap[sy * width + sx];
                    count++;
                }
            }
            blurred[y * width + x] = count > 0 ? sum / count : alphaMap[y * width + x];
        }
    }
    return blurred;
}

function transformAlphaMap(alphaMap, width, height, variant) {
    if (!variant || variant.type === 'identity') return alphaMap;
    const transformed = new Float32Array(alphaMap.length);
    if (variant.type === 'band-scale') {
        for (let index = 0; index < alphaMap.length; index++) {
            const alpha = alphaMap[index];
            transformed[index] = alpha >= variant.minAlpha && alpha <= variant.maxAlpha
                ? clampAlpha(alpha * variant.scale)
                : alpha;
        }
        return transformed;
    }
    if (variant.type === 'power') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(Math.pow(alphaMap[index], variant.exponent));
        }
        return transformed;
    }

    const blurred = blurAlphaMap(alphaMap, width, height);
    if (variant.type === 'blur-mix') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] * (1 - variant.mix) + blurred[index] * variant.mix);
        }
        return transformed;
    }
    if (variant.type === 'sharpen') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] + (alphaMap[index] - blurred[index]) * variant.amount);
        }
        return transformed;
    }
    return alphaMap;
}

function buildAlphaResolver() {
    const alpha96 = getEmbeddedAlphaMap(96);
    const cache = new Map([
        [36, getEmbeddedAlphaMap('36-v2')],
        [48, getEmbeddedAlphaMap(48)],
        [96, alpha96],
        ['36-v2', getEmbeddedAlphaMap('36-v2')]
    ]);

    return (config) => {
        if (config.alphaVariant) {
            const key = `${config.logoSize}-${config.alphaVariant}`;
            if (cache.has(key)) return cache.get(key);
        }
        if (cache.has(config.logoSize)) return cache.get(config.logoSize);
        const alphaMap = interpolateAlphaMap(alpha96, 96, config.logoSize);
        cache.set(config.logoSize, alphaMap);
        return alphaMap;
    };
}

function applyTrial(original, position, baseAlphaMap, variant, alphaGain) {
    const transformedAlpha = transformAlphaMap(baseAlphaMap, position.width, position.height, variant);
    const imageData = cloneImageData(original);
    removeWatermark(imageData, transformedAlpha, position, { alphaGain });
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

async function renderProbeRow({ probe, sampleRoot, profileVariants, resolveAlphaMap }) {
    const original = await decodeImageDataInNode(path.join(sampleRoot, probe.file));
    const position = resolvePosition(probe.config, original);
    const roiCropBox = calculateRoiCropBox(position, original);
    const baseAlphaMap = resolveAlphaMap(probe.config);
    const variantByName = new Map(profileVariants.map((variant) => [variant.name, variant]));
    const baseVariant = variantByName.get('base');
    const bestSeverityVariant = variantByName.get(probe.bestBySeverity?.profileName);
    const bestClearedVariant = variantByName.get(probe.bestCleared?.profileName);
    const baseImage = applyTrial(original, position, baseAlphaMap, baseVariant, 1);
    const bestSeverityImage = probe.bestBySeverity
        ? applyTrial(original, position, baseAlphaMap, bestSeverityVariant, probe.bestBySeverity.alphaGain)
        : baseImage;
    const bestClearedImage = probe.bestCleared
        ? applyTrial(original, position, baseAlphaMap, bestClearedVariant, probe.bestCleared.alphaGain)
        : bestSeverityImage;

    const bestClearedLabel = probe.bestCleared
        ? `${probe.bestCleared.profileName} a=${probe.bestCleared.alphaGain}`
        : 'none';
    const panels = [
        await encodePanel(cropImageData(original, roiCropBox), {
            title: 'before ROI',
            line1: probe.profileLine
        }),
        await encodePanel(cropImageData(baseImage, roiCropBox), {
            title: 'base a=1',
            line1: `halo=${probe.baselineFromReview?.positiveHaloLum ?? 'n/a'}`
        }),
        await encodePanel(cropImageData(bestSeverityImage, roiCropBox), {
            title: 'best severity',
            line1: `${probe.bestBySeverity?.profileName} a=${probe.bestBySeverity?.alphaGain}`
        }),
        await encodePanel(cropImageData(bestClearedImage, roiCropBox), {
            title: probe.bestCleared ? 'best cleared' : 'no cleared',
            line1: bestClearedLabel
        }),
        await encodePanel(createLocalContrastImageData(cropImageData(bestClearedImage, roiCropBox)), {
            title: 'cleared contrast',
            line1: probe.bestCleared ? `sev=${probe.bestCleared.severity}` : 'best severity contrast'
        })
    ];
    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0b0b0b"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(probe.file).slice(0, 130)}</text>` +
        `<text x="10" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">best=${escapeSvgText(probe.bestBySeverity?.profileName ?? 'n/a')} cleared=${escapeSvgText(bestClearedLabel)}</text>` +
        `<text x="10" y="53" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">clearedCount=${probe.clearedCount} baseline halo=${probe.baselineFromReview?.positiveHaloLum ?? 'n/a'} gr=${probe.baselineFromReview?.gradientResidual ?? 'n/a'} sp=${probe.baselineFromReview?.spatialResidual ?? 'n/a'}</text>` +
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
    const report = JSON.parse(stripBom(await readFile(args.profileReportPath, 'utf8')));
    await mkdir(args.outputDir, { recursive: true });
    const resolveAlphaMap = buildAlphaResolver();
    const rows = [];
    for (const probe of report.probes ?? []) {
        rows.push(await renderProbeRow({
            probe,
            sampleRoot: report.sampleRoot,
            profileVariants: report.profileVariants,
            resolveAlphaMap
        }));
    }

    const sheetPath = path.join(args.outputDir, 'model-investigation-alpha-profile.png');
    await renderSheet({ rows, outputPath: sheetPath });
    const summaryPath = path.join(args.outputDir, 'model-investigation-alpha-profile-sheet.json');
    await writeFile(summaryPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        profileReportPath: args.profileReportPath,
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
