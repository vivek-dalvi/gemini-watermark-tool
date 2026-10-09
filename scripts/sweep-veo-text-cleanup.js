import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { parseTimestampList } from './render-video-crop-sheet.js';
import { exportVideoBackendVariant } from './export-video-backend-variant.js';
import { getVeoTextWatermarkTemplate } from '../src/video/veoTextWatermarkTemplates.js';
import { scoreVeoTextTemplateAt } from '../src/video/veoTextWatermarkDetector.js';

const DEFAULT_OUTPUT_DIR = '.artifacts/veo-text-sweep';
const DEFAULT_TIMESTAMPS = Object.freeze([1, 2, 4, 6, 7]);
const DEFAULT_ROI = Object.freeze({ x: 682, y: 1254, width: 23, height: 10 });
const DEFAULT_CROP = Object.freeze({ left: 618, top: 1190, width: 102, height: 90 });
const DEFAULT_DENOISE_BACKEND = 'allenk-fdncnn-browser-spike';
const DEFAULT_VARIANTS = Object.freeze([
    Object.freeze({
        id: 'pad32-edge18',
        label: 'pad32-edge18',
        denoiseBackend: DEFAULT_DENOISE_BACKEND,
        alphaGain: null,
        sigma: 75,
        padding: 32,
        edgeDenoiseStrength: 1.8,
        residualCleanupStrength: 0.4
    }),
    Object.freeze({
        id: 'pad24-edge12',
        label: 'pad24-edge12',
        denoiseBackend: DEFAULT_DENOISE_BACKEND,
        alphaGain: null,
        sigma: 75,
        padding: 24,
        edgeDenoiseStrength: 1.2,
        residualCleanupStrength: 0.4
    }),
    Object.freeze({
        id: 'pad16-edge18',
        label: 'pad16-edge18',
        denoiseBackend: DEFAULT_DENOISE_BACKEND,
        alphaGain: null,
        sigma: 75,
        padding: 16,
        edgeDenoiseStrength: 1.8,
        residualCleanupStrength: 0.4
    })
]);

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function createSafeId(value) {
    return String(value || 'variant')
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'variant';
}

function cloneVariant(variant) {
    return { ...variant };
}

export function parseSweepVariantSpec(spec) {
    const text = String(spec || '').trim();
    if (!text) {
        throw new Error('variant spec is empty');
    }

    const colonIndex = text.indexOf(':');
    const id = createSafeId(colonIndex >= 0 ? text.slice(0, colonIndex) : text);
    const body = colonIndex >= 0 ? text.slice(colonIndex + 1) : '';
    const variant = {
        id,
        label: id,
        denoiseBackend: DEFAULT_DENOISE_BACKEND,
        alphaGain: null,
        sigma: 75,
        padding: 32,
        edgeDenoiseStrength: 1.8,
        residualCleanupStrength: 0.4
    };

    if (!body) return variant;

    for (const part of body.split(',')) {
        if (!part.trim()) continue;
        const [rawKey, ...rawValueParts] = part.split('=');
        const key = rawKey.trim().toLowerCase();
        const value = rawValueParts.join('=').trim();
        const number = toFiniteNumber(value);

        if (key === 'label') {
            variant.label = value || variant.label;
        } else if (key === 'backend' || key === 'denoisebackend') {
            variant.denoiseBackend = value || DEFAULT_DENOISE_BACKEND;
        } else if (key === 'alpha' || key === 'alphagain') {
            variant.alphaGain = number ?? variant.alphaGain;
        } else if (key === 'sigma') {
            variant.sigma = number ?? variant.sigma;
        } else if (key === 'padding' || key === 'pad') {
            variant.padding = number ?? variant.padding;
        } else if (key === 'edge' || key === 'edgedenoisestrength') {
            variant.edgeDenoiseStrength = number ?? variant.edgeDenoiseStrength;
        } else if (key === 'residual' || key === 'residualcleanupstrength') {
            variant.residualCleanupStrength = number ?? variant.residualCleanupStrength;
        } else if (key === 'output' || key === 'outputpath') {
            variant.outputPath = value;
        } else {
            throw new Error(`unknown variant option: ${key}`);
        }
    }

    return variant;
}

function parseBox(value, names) {
    const parts = String(value || '').split(',').map((part) => Number(part.trim()));
    if (parts.length !== names.length || parts.some((part) => !Number.isFinite(part))) {
        throw new Error(`expected ${names.join(',')} box`);
    }
    return Object.fromEntries(names.map((name, index) => [name, parts[index]]));
}

export function parseCliArgs(argv) {
    const parsed = {
        outputDir: DEFAULT_OUTPUT_DIR,
        timestamps: [...DEFAULT_TIMESTAMPS],
        variants: [],
        referencePath: null,
        skipExport: false,
        timeoutMs: 6 * 60 * 1000,
        roi: { ...DEFAULT_ROI },
        crop: { ...DEFAULT_CROP },
        cropScale: 2,
        keepFrames: false
    };

    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--input' || arg === '--source' || arg === '--original') {
            parsed.inputPath = args.shift();
            continue;
        }
        if (arg === '--output-dir') {
            parsed.outputDir = args.shift() || parsed.outputDir;
            continue;
        }
        if (arg === '--report') {
            parsed.reportPath = args.shift();
            continue;
        }
        if (arg === '--crop-sheet') {
            parsed.cropSheetPath = args.shift();
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--variant') {
            parsed.variants.push(parseSweepVariantSpec(args.shift()));
            continue;
        }
        if (arg === '--reference' || arg === '--allenk') {
            parsed.referencePath = args.shift();
            continue;
        }
        if (arg === '--skip-export') {
            parsed.skipExport = true;
            continue;
        }
        if (arg === '--timeout-ms') {
            parsed.timeoutMs = toFiniteNumber(args.shift()) ?? parsed.timeoutMs;
            continue;
        }
        if (arg === '--roi') {
            parsed.roi = parseBox(args.shift(), ['x', 'y', 'width', 'height']);
            continue;
        }
        if (arg === '--crop') {
            parsed.crop = parseBox(args.shift(), ['left', 'top', 'width', 'height']);
            continue;
        }
        if (arg === '--crop-scale') {
            parsed.cropScale = Math.max(1, Math.round(toFiniteNumber(args.shift()) ?? parsed.cropScale));
            continue;
        }
        if (arg === '--keep-frames') {
            parsed.keepFrames = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }
        if (!parsed.inputPath) {
            parsed.inputPath = arg;
            continue;
        }
        throw new Error(`unknown argument: ${arg}`);
    }

    if (parsed.variants.length === 0) {
        parsed.variants = DEFAULT_VARIANTS.map(cloneVariant);
    }

    return parsed;
}

export function createSweepSummary(rows, variants) {
    const byVideo = {};
    for (const variant of variants) {
        const values = rows
            .filter((row) => row.video === variant.id)
            .map((row) => row.ncc)
            .filter(Number.isFinite);
        byVideo[variant.id] = {
            label: variant.label || variant.id,
            meanNcc: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
            maxNcc: values.length ? Math.max(...values) : 0,
            minNcc: values.length ? Math.min(...values) : 0,
            frames: values.length
        };
    }

    return {
        byVideo,
        sorted: Object.entries(byVideo).sort((left, right) => left[1].meanNcc - right[1].meanNcc)
    };
}

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
            }
        });
    });
}

async function extractFrame(videoPath, timestamp, outputPath) {
    await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        outputPath
    ]);
}

async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function resolveVariantOutputPath(variant, outputDir) {
    return path.resolve(variant.outputPath || path.join(outputDir, `${variant.id}.mp4`));
}

async function exportVariants({
    inputPath,
    outputDir,
    variants,
    skipExport,
    timeoutMs
}) {
    const results = [];
    for (const variant of variants) {
        const outputPath = resolveVariantOutputPath(variant, outputDir);
        if (!skipExport) {
            const exportReport = await exportVideoBackendVariant({
                inputPath,
                outputPath,
                denoiseBackend: variant.denoiseBackend,
                alphaGain: variant.alphaGain,
                allenkFdncnnSigma: variant.sigma,
                allenkFdncnnPadding: variant.padding,
                edgeDenoiseStrength: variant.edgeDenoiseStrength,
                residualCleanupStrength: variant.residualCleanupStrength,
                timeoutMs
            });
            results.push({ ...variant, outputPath, exportReport });
        } else {
            results.push({ ...variant, outputPath, exportReport: null });
        }
    }
    return results;
}

function buildScoreTargets({ inputPath, exportedVariants, referencePath }) {
    const targets = [
        {
            id: 'original',
            label: 'Original',
            outputPath: path.resolve(inputPath)
        },
        ...exportedVariants.map((variant) => ({
            id: variant.id,
            label: variant.label || variant.id,
            outputPath: path.resolve(variant.outputPath)
        }))
    ];
    if (referencePath) {
        targets.push({
            id: 'reference',
            label: 'Reference',
            outputPath: path.resolve(referencePath)
        });
    }
    return targets;
}

async function scoreTargets({
    targets,
    timestamps,
    roi,
    crop,
    cropScale,
    frameDir,
    cropSheetPath
}) {
    const template = getVeoTextWatermarkTemplate('veo-text-23x10');
    const rows = [];
    const composites = [];
    const cellWidth = Math.round(crop.width * cropScale);
    const cellHeight = Math.round(crop.height * cropScale);

    for (let row = 0; row < timestamps.length; row++) {
        const timestamp = timestamps[row];
        for (let col = 0; col < targets.length; col++) {
            const target = targets[col];
            const framePath = path.join(frameDir, `${target.id}-t${timestamp}.png`);
            const cropPath = path.join(frameDir, `${target.id}-t${timestamp}-crop.png`);
            await extractFrame(target.outputPath, timestamp, framePath);
            const imageData = await decodeImageData(framePath);
            const score = scoreVeoTextTemplateAt(imageData, template, roi.x, roi.y);
            rows.push({
                video: target.id,
                label: target.label,
                timestamp,
                ncc: score.ncc,
                confidence: score.confidence
            });
            await sharp(framePath)
                .extract(crop)
                .resize(cellWidth, cellHeight, { kernel: 'nearest' })
                .png()
                .toFile(cropPath);
            composites.push({
                input: cropPath,
                left: col * cellWidth,
                top: row * cellHeight
            });
        }
    }

    await sharp({
        create: {
            width: cellWidth * targets.length,
            height: cellHeight * timestamps.length,
            channels: 3,
            background: '#202020'
        }
    })
        .composite(composites)
        .png()
        .toFile(cropSheetPath);

    return rows;
}

export async function runVeoTextCleanupSweep({
    inputPath,
    outputDir = DEFAULT_OUTPUT_DIR,
    reportPath = null,
    cropSheetPath = null,
    timestamps = [...DEFAULT_TIMESTAMPS],
    variants = DEFAULT_VARIANTS.map(cloneVariant),
    referencePath = null,
    skipExport = false,
    timeoutMs = 6 * 60 * 1000,
    roi = { ...DEFAULT_ROI },
    crop = { ...DEFAULT_CROP },
    cropScale = 2,
    keepFrames = false
} = {}) {
    if (!inputPath) {
        throw new Error('missing input video path');
    }

    const resolvedOutputDir = path.resolve(outputDir);
    const resolvedReportPath = path.resolve(reportPath || path.join(resolvedOutputDir, 'veo-text-cleanup-sweep.json'));
    const resolvedCropSheetPath = path.resolve(cropSheetPath || path.join(resolvedOutputDir, 'veo-text-cleanup-sweep.png'));
    const frameDir = path.join(
        resolvedOutputDir,
        `${path.basename(resolvedReportPath, path.extname(resolvedReportPath))}-frames`
    );

    await mkdir(resolvedOutputDir, { recursive: true });
    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });

    const exportedVariants = await exportVariants({
        inputPath: path.resolve(inputPath),
        outputDir: resolvedOutputDir,
        variants,
        skipExport,
        timeoutMs
    });
    const targets = buildScoreTargets({
        inputPath,
        exportedVariants,
        referencePath
    });
    const rows = await scoreTargets({
        targets,
        timestamps,
        roi,
        crop,
        cropScale,
        frameDir,
        cropSheetPath: resolvedCropSheetPath
    });
    const summary = createSweepSummary(rows, targets);
    const report = {
        generatedAt: new Date().toISOString(),
        inputPath: path.resolve(inputPath),
        outputDir: resolvedOutputDir,
        reportPath: resolvedReportPath,
        cropSheetPath: resolvedCropSheetPath,
        frameDir: keepFrames ? frameDir : null,
        timestamps,
        roi,
        crop,
        variants: exportedVariants,
        targets,
        rows,
        summary: summary.byVideo,
        sorted: summary.sorted
    };

    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!keepFrames) {
        await rm(frameDir, { recursive: true, force: true });
    }
    return report;
}

function printHelp() {
    console.log(`Usage:
  node scripts/sweep-veo-text-cleanup.js --input <video.mp4> [options]

Options:
  --output-dir <dir>          Defaults to ${DEFAULT_OUTPUT_DIR}
  --report <json>             Defaults to <output-dir>/veo-text-cleanup-sweep.json
  --crop-sheet <png>          Defaults to <output-dir>/veo-text-cleanup-sweep.png
  --timestamps <list>         Defaults to ${DEFAULT_TIMESTAMPS.join(',')}
  --variant <spec>            Repeatable. Example: pad24:sigma=75,padding=24,edge=1.2,residual=0.4,alpha=1.256
  --reference <video.mp4>     Optional reference output, such as Allenk --mark veo
  --skip-export               Score existing variant output files instead of exporting
  --roi x,y,w,h               Defaults to ${DEFAULT_ROI.x},${DEFAULT_ROI.y},${DEFAULT_ROI.width},${DEFAULT_ROI.height}
  --crop left,top,w,h         Defaults to ${DEFAULT_CROP.left},${DEFAULT_CROP.top},${DEFAULT_CROP.width},${DEFAULT_CROP.height}
  --crop-scale <n>            Defaults to 2
  --keep-frames               Keep extracted frame/crop intermediates
`);
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const report = await runVeoTextCleanupSweep(options);
    console.log(`report: ${report.reportPath}`);
    console.log(`cropSheet: ${report.cropSheetPath}`);
    console.log(`best: ${report.sorted[0]?.[0] || 'none'} ${report.sorted[0]?.[1]?.meanNcc?.toFixed(4) || '0.0000'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    });
}
