import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-safety-tradeoff-alpha-profile.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const PANEL_SIZE = 172;
const LABEL_HEIGHT = 44;
const HEADER_HEIGHT = 64;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#161616';

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
    const size = config.logoSize ?? config.size;
    return {
        x: imageData.width - config.marginRight - size,
        y: imageData.height - config.marginBottom - size,
        width: size,
        height: size
    };
}

function calculateUnionCropBox(positions, imageData) {
    const valid = positions.filter(Boolean);
    const minX = Math.min(...valid.map((position) => position.x));
    const minY = Math.min(...valid.map((position) => position.y));
    const maxX = Math.max(...valid.map((position) => position.x + position.width));
    const maxY = Math.max(...valid.map((position) => position.y + position.height));
    const padding = Math.max(10, Math.round(Math.max(...valid.map((position) => position.width)) * 0.25));
    const left = Math.max(0, minX - padding);
    const top = Math.max(0, minY - padding);
    const right = Math.min(imageData.width, maxX + padding);
    const bottom = Math.min(imageData.height, maxY + padding);
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
    const gain = std < 18 ? 3.4 : 2.25;
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

function buildAlphaResolver() {
    const alpha96 = getEmbeddedAlphaMap(96);
    const cache = new Map([
        [36, getEmbeddedAlphaMap('36-v2')],
        [48, getEmbeddedAlphaMap(48)],
        [96, alpha96],
        ['36-v2', getEmbeddedAlphaMap('36-v2')],
        ['96-20260520', getEmbeddedAlphaMap('96-20260520')]
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
                const sourceY = y + dy;
                if (sourceY < 0 || sourceY >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    if (sourceX < 0 || sourceX >= width) continue;
                    sum += alphaMap[sourceY * width + sourceX];
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

function applyTrial(original, config, variant, alphaGain, resolveAlphaMap) {
    const position = resolvePosition(config, original);
    const baseAlphaMap = resolveAlphaMap(config);
    const profileAlphaMap = transformAlphaMap(baseAlphaMap, position.width, position.height, variant);
    const imageData = cloneImageData(original);
    removeWatermark(imageData, profileAlphaMap, position, { alphaGain });
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

function findGeometryProbe(probe, name) {
    return probe.probes.find((item) => item.geometryName === name) ?? null;
}

function findVariant(variantByName, trial) {
    return variantByName.get(trial?.profileName) ?? variantByName.get('base');
}

async function renderProbeRow({ probe, sampleRoot, profileVariants, resolveAlphaMap }) {
    const original = await decodeImageDataInNode(path.resolve(sampleRoot, probe.file));
    const selectedProbe = findGeometryProbe(probe, 'selected-current');
    const catalogProbe = findGeometryProbe(probe, 'best-evidence-catalog');
    const selectedPosition = resolvePosition(selectedProbe.config, original);
    const catalogPosition = resolvePosition(catalogProbe.config, original);
    const cropBox = calculateUnionCropBox([selectedPosition, catalogPosition], original);
    const variantByName = new Map(profileVariants.map((variant) => [variant.name, variant]));
    const baseVariant = variantByName.get('base');
    const selectedBest = selectedProbe.bestSafe;
    const catalogBase = catalogProbe.bestBaseSafe ?? catalogProbe.bestSafe;
    const catalogBest = catalogProbe.bestSafe;
    const selectedImage = applyTrial(
        original,
        selectedProbe.config,
        findVariant(variantByName, selectedBest),
        selectedBest.alphaGain,
        resolveAlphaMap
    );
    const catalogBaseImage = applyTrial(
        original,
        catalogProbe.config,
        baseVariant,
        catalogBase.alphaGain,
        resolveAlphaMap
    );
    const catalogBestImage = applyTrial(
        original,
        catalogProbe.config,
        findVariant(variantByName, catalogBest),
        catalogBest.alphaGain,
        resolveAlphaMap
    );
    const panels = [
        await encodePanel(cropImageData(original, cropBox), {
            title: 'before ROI',
            line1: `${probe.geometryRisk.selectedKey} -> ${probe.geometryRisk.bestEvidenceKey}`
        }),
        await encodePanel(cropImageData(selectedImage, cropBox), {
            title: 'selected best',
            line1: `${selectedBest.profileName} a=${selectedBest.alphaGain} sev=${selectedBest.severity}`
        }),
        await encodePanel(cropImageData(catalogBaseImage, cropBox), {
            title: 'catalog base',
            line1: `a=${catalogBase.alphaGain} sev=${catalogBase.severity}`
        }),
        await encodePanel(cropImageData(catalogBestImage, cropBox), {
            title: catalogBest.visible ? 'catalog profile' : 'catalog cleared',
            line1: `${catalogBest.profileName} a=${catalogBest.alphaGain} sev=${catalogBest.severity}`
        }),
        await encodePanel(createLocalContrastImageData(cropImageData(catalogBestImage, cropBox)), {
            title: 'catalog contrast',
            line1: `visible=${catalogBest.visible} texture=${catalogBest.texturePenalty}`
        })
    ];
    const rowWidth = panels.length * PANEL_SIZE + (panels.length - 1) * PANEL_GAP;
    const rowHeight = HEADER_HEIGHT + PANEL_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#0b0b0b"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(probe.file).slice(0, 130)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">catalogBeatsSelected=${probe.conclusion.catalogBeatsSelected} catalogCleared=${probe.conclusion.catalogClearedSafely} improvement=${probe.conclusion.catalogProfileImprovement}</text>` +
        `<text x="10" y="55" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="11">selected=${probe.conclusion.selectedBestSafeSeverity} catalog=${probe.conclusion.catalogBestSafeSeverity} base=${probe.conclusion.catalogBestBaseSeverity}</text>` +
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
    const sheetPath = path.join(args.outputDir, 'geometry-safety-tradeoff-alpha-profile.png');
    await renderSheet({ rows, outputPath: sheetPath });
    const summaryPath = path.join(args.outputDir, 'geometry-safety-tradeoff-alpha-profile-sheet.json');
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
