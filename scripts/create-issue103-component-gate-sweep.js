import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { createComponentGatedVectorRepair } from './create-issue103-vector-repair-fixture-pack.js';

const DEFAULT_INPUT_PATH = path.resolve('.artifacts/issue-103/issue-103-input.png');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/issue-103/component-gate-sweep');
const DEFAULT_POSITION = Object.freeze({ x: 1760, y: 1760, width: 96, height: 96 });
const DEFAULT_ALPHA_KEY = '96-20260520';
const DEFAULT_ALPHA_GAIN = 0.85;
const DEFAULT_INVERSE_ALPHA_GAIN = 0.85;
const DEFAULT_CANDIDATES = Object.freeze([
    { id: 'strict-a256-fill084-boundary', minArea: 256, minFillRatio: 0.84, requireBoundary: true },
    { id: 'mid-a128-fill060-boundary', minArea: 128, minFillRatio: 0.6, requireBoundary: true },
    { id: 'loose-a64-fill040-boundary', minArea: 64, minFillRatio: 0.4, requireBoundary: true },
    { id: 'loose-a64-fill040-anywhere', minArea: 64, minFillRatio: 0.4, requireBoundary: false },
    { id: 'very-loose-a64-fill030-anywhere', minArea: 64, minFillRatio: 0.3, requireBoundary: false }
]);

function escapeSvgText(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function labelSvg({ width, height, text, background = '#111827', fontSize = 12 }) {
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="${background}"/>` +
        `<text x="8" y="${Math.round(height / 2 + fontSize / 3)}" fill="#e5e7eb" ` +
        `font-family="Arial, sans-serif" font-size="${fontSize}">${escapeSvgText(text)}</text></svg>`
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

async function imageDataToPngBuffer(imageData, position = null, scale = 4) {
    let pipeline = sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    });

    if (position) {
        pipeline = pipeline.extract({
            left: position.x,
            top: position.y,
            width: position.width,
            height: position.height
        });
    }

    const width = position?.width ?? imageData.width;
    const height = position?.height ?? imageData.height;
    return pipeline
        .resize(width * scale, height * scale, { kernel: 'nearest' })
        .png()
        .toBuffer();
}

async function writePngBuffer(buffer, filePath) {
    await writeFile(filePath, buffer);
    return buffer;
}

async function createSheet({ panels, tileSize, filePath }) {
    const labelHeight = 34;
    const overlays = [];
    const base = sharp({
        create: {
            width: tileSize * panels.length,
            height: tileSize + labelHeight,
            channels: 4,
            background: '#ffffff'
        }
    });

    panels.forEach((panel, index) => {
        overlays.push({
            input: labelSvg({
                width: tileSize,
                height: labelHeight,
                text: panel.label,
                background: panel.background,
                fontSize: 11
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

function parseCandidateSpec(value) {
    const [id, minArea, minFillRatio, requireBoundary] = value.split(':');
    return {
        id,
        minArea: Number(minArea),
        minFillRatio: Number(minFillRatio),
        requireBoundary: requireBoundary !== 'false'
    };
}

function parseArgs(argv) {
    const parsed = {
        inputPath: DEFAULT_INPUT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        position: { ...DEFAULT_POSITION },
        alphaKey: DEFAULT_ALPHA_KEY,
        alphaGain: DEFAULT_ALPHA_GAIN,
        inverseAlphaGain: DEFAULT_INVERSE_ALPHA_GAIN,
        candidates: [...DEFAULT_CANDIDATES]
    };

    const candidates = [];
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
        if (arg === '--candidate') candidates.push(parseCandidateSpec(argv[++index] ?? 'custom:256:0.84:true'));
    }

    if (candidates.length > 0) parsed.candidates = candidates;
    return parsed;
}

export async function createIssue103ComponentGateSweep({
    inputPath = DEFAULT_INPUT_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    position = DEFAULT_POSITION,
    alphaKey = DEFAULT_ALPHA_KEY,
    alphaGain = DEFAULT_ALPHA_GAIN,
    inverseAlphaGain = DEFAULT_INVERSE_ALPHA_GAIN,
    candidates = DEFAULT_CANDIDATES
} = {}) {
    await mkdir(outputDir, { recursive: true });
    const resolvedInputPath = path.resolve(inputPath);
    const resolvedOutputDir = path.resolve(outputDir);
    const imageData = await loadImageData(resolvedInputPath);
    const alphaMap = getEmbeddedAlphaMap(alphaKey);
    if (alphaMap.length !== position.width * position.height) {
        throw new Error(`Alpha map ${alphaKey} does not match ${position.width}x${position.height}`);
    }

    const baseReview = createComponentGatedVectorRepair({
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
        sheet: path.join(resolvedOutputDir, 'comparison-sheet.png'),
        report: path.join(resolvedOutputDir, 'report.json')
    };
    const inputCrop = await writePngBuffer(
        await imageDataToPngBuffer(imageData, position),
        paths.inputCrop
    );
    const inverseCrop = await writePngBuffer(
        await imageDataToPngBuffer(baseReview.inverseImageData, position),
        paths.inverseCrop
    );
    const paletteSnapCrop = await writePngBuffer(
        await imageDataToPngBuffer(baseReview.paletteSnapImageData, position),
        paths.paletteSnapCrop
    );

    const panels = [
        { label: 'input', buffer: inputCrop, background: '#111827' },
        { label: `inverse ${inverseAlphaGain}`, buffer: inverseCrop, background: '#111827' },
        { label: 'palette-snap raw', buffer: paletteSnapCrop, background: '#7f1d1d' }
    ];
    const reportCandidates = [];

    for (const candidate of candidates) {
        const review = createComponentGatedVectorRepair({
            imageData,
            position,
            alphaMap,
            alphaGain,
            inverseAlphaGain,
            gateOptions: candidate
        });
        const cropPath = path.join(resolvedOutputDir, `${candidate.id}-crop-4x.png`);
        const componentMapPath = path.join(resolvedOutputDir, `${candidate.id}-component-map-4x.png`);
        const cropBuffer = await writePngBuffer(
            await imageDataToPngBuffer(review.componentGatedImageData, position),
            cropPath
        );
        await writePngBuffer(
            await imageDataToPngBuffer(review.componentMapImageData),
            componentMapPath
        );

        panels.push({
            label: `${candidate.id} | ch=${review.gatedDecision.changedPixels}`,
            buffer: cropBuffer,
            background: review.gatedDecision.adopted ? '#14532d' : '#7f1d1d'
        });
        reportCandidates.push({
            id: candidate.id,
            gateOptions: {
                minArea: candidate.minArea,
                minFillRatio: candidate.minFillRatio,
                requireBoundary: candidate.requireBoundary
            },
            gatedDecision: review.gatedDecision,
            paths: {
                crop: cropPath,
                componentMap: componentMapPath
            }
        });
    }

    await createSheet({
        panels,
        tileSize: position.width * 4,
        filePath: paths.sheet
    });

    const report = {
        generatedAt: new Date().toISOString(),
        inputPath: resolvedInputPath,
        alphaKey,
        alphaGain,
        inverseAlphaGain,
        columns: ['input', 'inverse', 'palette-snap', ...candidates.map((candidate) => candidate.id)],
        position,
        paletteSnapChangedPixels: baseReview.paletteSnapChangedPixels,
        paths,
        candidates: reportCandidates
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
    createIssue103ComponentGateSweep(options)
        .then(({ reportPath, sheetPath, report }) => {
            console.log(JSON.stringify({
                reportPath,
                sheetPath,
                candidates: report.candidates.map((candidate) => ({
                    id: candidate.id,
                    adopted: candidate.gatedDecision.adopted,
                    changedPixels: candidate.gatedDecision.changedPixels,
                    adoptedComponents: candidate.gatedDecision.safety.adoptedComponents,
                    rejectedComponents: candidate.gatedDecision.safety.rejectedComponents
                }))
            }, null, 2));
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
