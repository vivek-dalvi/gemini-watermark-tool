import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { createComponentGatedVectorRepair } from './create-issue103-vector-repair-fixture-pack.js';

const DEFAULT_INPUT_PATH = path.resolve('.artifacts/issue-103/issue-103-input.png');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/issue-103/real-component-gated-vector-review');
const DEFAULT_POSITION = Object.freeze({ x: 1760, y: 1760, width: 96, height: 96 });
const DEFAULT_ALPHA_KEY = '96-20260520';
const DEFAULT_ALPHA_GAIN = 0.85;
const DEFAULT_INVERSE_ALPHA_GAIN = 0.85;
const COLUMNS = Object.freeze(['input', 'inverse', 'palette-snap', 'component-gated', 'component-map']);

function escapeSvgText(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function labelSvg({ width, height, text, background = '#111827' }) {
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="${background}"/>` +
        `<text x="8" y="18" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="13">` +
        `${escapeSvgText(text)}</text></svg>`
    );
}

async function loadImageData(inputPath) {
    const { data, info } = await sharp(inputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data)
    };
}

async function saveCrop(imageData, position, filePath, scale = 4) {
    const buffer = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .extract({
            left: position.x,
            top: position.y,
            width: position.width,
            height: position.height
        })
        .resize(position.width * scale, position.height * scale, { kernel: 'nearest' })
        .png()
        .toBuffer();
    await writeFile(filePath, buffer);
    return buffer;
}

async function saveScaledImage(imageData, filePath, scale = 4) {
    const buffer = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .resize(imageData.width * scale, imageData.height * scale, { kernel: 'nearest' })
        .png()
        .toBuffer();
    await writeFile(filePath, buffer);
    return buffer;
}

async function createSheet({ panels, tileSize, filePath }) {
    const labelHeight = 26;
    const base = sharp({
        create: {
            width: tileSize * panels.length,
            height: tileSize + labelHeight,
            channels: 4,
            background: '#ffffff'
        }
    });
    const overlays = [];

    panels.forEach((panel, index) => {
        overlays.push({
            input: labelSvg({
                width: tileSize,
                height: labelHeight,
                text: panel.label,
                background: panel.background
            }),
            left: index * tileSize,
            top: 0
        });
        overlays.push({
            input: panel.buffer,
            left: index * tileSize,
            top: labelHeight
        });
    });

    await base.composite(overlays).png().toFile(filePath);
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
    const parsed = {
        inputPath: DEFAULT_INPUT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        position: { ...DEFAULT_POSITION },
        alphaKey: DEFAULT_ALPHA_KEY,
        alphaGain: DEFAULT_ALPHA_GAIN,
        inverseAlphaGain: DEFAULT_INVERSE_ALPHA_GAIN
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--input') parsed.inputPath = path.resolve(argv[++index] ?? parsed.inputPath);
        if (arg === '--output-dir') parsed.outputDir = path.resolve(argv[++index] ?? parsed.outputDir);
        if (arg === '--x') parsed.position.x = parseInteger(argv[++index], parsed.position.x);
        if (arg === '--y') parsed.position.y = parseInteger(argv[++index], parsed.position.y);
        if (arg === '--width') parsed.position.width = parseInteger(argv[++index], parsed.position.width);
        if (arg === '--height') parsed.position.height = parseInteger(argv[++index], parsed.position.height);
        if (arg === '--alpha-key') parsed.alphaKey = argv[++index] ?? parsed.alphaKey;
        if (arg === '--alpha-gain') parsed.alphaGain = Number(argv[++index] ?? parsed.alphaGain);
        if (arg === '--inverse-alpha-gain') {
            parsed.inverseAlphaGain = Number(argv[++index] ?? parsed.inverseAlphaGain);
        }
    }

    return parsed;
}

export async function createIssue103RealComponentGatedReview({
    inputPath = DEFAULT_INPUT_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    position = DEFAULT_POSITION,
    alphaKey = DEFAULT_ALPHA_KEY,
    alphaGain = DEFAULT_ALPHA_GAIN,
    inverseAlphaGain = DEFAULT_INVERSE_ALPHA_GAIN
} = {}) {
    await mkdir(outputDir, { recursive: true });
    const resolvedInputPath = path.resolve(inputPath);
    const resolvedOutputDir = path.resolve(outputDir);
    const alphaMap = getEmbeddedAlphaMap(alphaKey);
    if (alphaMap.length !== position.width * position.height) {
        throw new Error(`Alpha map ${alphaKey} does not match ${position.width}x${position.height}`);
    }

    const imageData = await loadImageData(resolvedInputPath);
    const review = createComponentGatedVectorRepair({
        imageData,
        position,
        alphaMap,
        alphaGain,
        inverseAlphaGain
    });

    const paths = {
        inputCrop: path.join(resolvedOutputDir, 'input-crop-4x.png'),
        inverseCrop: path.join(resolvedOutputDir, 'inverse-crop-4x.png'),
        paletteSnapCrop: path.join(resolvedOutputDir, 'palette-snap-crop-4x.png'),
        componentGatedCrop: path.join(resolvedOutputDir, 'component-gated-crop-4x.png'),
        componentMap: path.join(resolvedOutputDir, 'component-map-4x.png'),
        sheet: path.join(resolvedOutputDir, 'comparison-sheet.png'),
        report: path.join(resolvedOutputDir, 'report.json')
    };

    const inputCrop = await saveCrop(imageData, position, paths.inputCrop);
    const inverseCrop = await saveCrop(review.inverseImageData, position, paths.inverseCrop);
    const paletteSnapCrop = await saveCrop(review.paletteSnapImageData, position, paths.paletteSnapCrop);
    const componentGatedCrop = await saveCrop(
        review.componentGatedImageData,
        position,
        paths.componentGatedCrop
    );
    const componentMap = await saveScaledImage(review.componentMapImageData, paths.componentMap);

    await createSheet({
        tileSize: position.width * 4,
        filePath: paths.sheet,
        panels: [
            { label: 'input', buffer: inputCrop, background: '#111827' },
            { label: `inverse alpha=${inverseAlphaGain}`, buffer: inverseCrop, background: '#111827' },
            { label: 'palette-snap raw', buffer: paletteSnapCrop, background: '#7f1d1d' },
            {
                label: review.gatedDecision.adopted ? 'component-gated partial' : 'component-gated no-op',
                buffer: componentGatedCrop,
                background: review.gatedDecision.adopted ? '#14532d' : '#7f1d1d'
            },
            {
                label: 'component-map',
                buffer: componentMap,
                background: '#111827'
            }
        ]
    });

    const report = {
        generatedAt: new Date().toISOString(),
        inputPath: resolvedInputPath,
        alphaKey,
        alphaGain,
        inverseAlphaGain,
        columns: COLUMNS,
        position,
        paletteSize: review.palette.length,
        paletteSnapChangedPixels: review.paletteSnapChangedPixels,
        gatedDecision: review.gatedDecision,
        paths
    };
    await writeFile(paths.report, JSON.stringify(report, null, 2));

    return {
        reportPath: paths.report,
        sheetPath: paths.sheet,
        report
    };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = parseArgs(process.argv.slice(2));
    createIssue103RealComponentGatedReview(options)
        .then(({ reportPath, sheetPath, report }) => {
            console.log(JSON.stringify({
                reportPath,
                sheetPath,
                gatedDecision: {
                    adopted: report.gatedDecision.adopted,
                    changedPixels: report.gatedDecision.changedPixels,
                    adoptedComponents: report.gatedDecision.safety.adoptedComponents,
                    rejectedComponents: report.gatedDecision.safety.rejectedComponents,
                    reasons: report.gatedDecision.safety.reasons
                }
            }, null, 2));
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
