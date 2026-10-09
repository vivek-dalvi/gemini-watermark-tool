import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import {
    formatTimestampFileSuffix,
    normalizeCropBox,
    parseCropBox,
    parseTimestampList,
    resolveDefaultVideoCropBox,
    resolveVideoCropTimestamps
} from './render-video-crop-sheet.js';
import { getVideoAlphaMap } from '../src/video/videoWatermarkDetector.js';
import { resolveVideoWatermarkCandidates } from '../src/video/videoWatermarkCatalog.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-residual/latest.json');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_BACKGROUND_ALPHA_THRESHOLD = 0.035;
const DEFAULT_EDGE_GRADIENT_THRESHOLD = 0.18;
const DEFAULT_HIGH_ALPHA_THRESHOLD = 0.22;

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function resolveDefaultFrameDir(outputPath) {
    const resolvedOutput = path.resolve(outputPath || DEFAULT_OUTPUT_PATH);
    const parsed = path.parse(resolvedOutput);
    return path.join(parsed.dir, `frames-${parsed.name}`);
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

async function probeVideo(videoPath) {
    const { stdout } = await runProcess('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height:format=duration',
        '-of', 'json',
        videoPath
    ]);
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams?.[0];
    if (!stream) {
        throw new Error(`无法读取视频流：${videoPath}`);
    }
    return {
        width: Number(stream.width),
        height: Number(stream.height),
        duration: Number(parsed.format?.duration)
    };
}

async function extractCropFrame({ videoPath, timestamp, cropBox, outputPath }) {
    const filter = `crop=${cropBox.width}:${cropBox.height}:${cropBox.left}:${cropBox.top}`;
    await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', filter,
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

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

export function buildAlphaGradientMap(alphaMap, width, height) {
    const gradient = new Float32Array(width * height);
    let maxGradient = 0;
    const sample = (x, y) => {
        const xx = Math.max(0, Math.min(width - 1, x));
        const yy = Math.max(0, Math.min(height - 1, y));
        return alphaMap[yy * width + xx] || 0;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const gx =
                -sample(x - 1, y - 1) - 2 * sample(x - 1, y) - sample(x - 1, y + 1) +
                sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1);
            const gy =
                -sample(x - 1, y - 1) - 2 * sample(x, y - 1) - sample(x + 1, y - 1) +
                sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1);
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }

    return { gradient, maxGradient };
}

export function classifyResidualBucket(alpha, normalizedGradient, {
    backgroundAlphaThreshold = DEFAULT_BACKGROUND_ALPHA_THRESHOLD,
    edgeGradientThreshold = DEFAULT_EDGE_GRADIENT_THRESHOLD,
    highAlphaThreshold = DEFAULT_HIGH_ALPHA_THRESHOLD
} = {}) {
    if (alpha <= backgroundAlphaThreshold) return 'nearZero';
    if (normalizedGradient >= edgeGradientThreshold) return 'edge';
    if (alpha >= highAlphaThreshold) return 'highBody';
    return 'lowBody';
}

function createResidualAccumulator() {
    return {
        n: 0,
        sum: 0,
        abs: 0,
        sq: 0,
        neg: 0,
        pos: 0,
        maxAbs: 0
    };
}

function addResidual(accumulator, value) {
    accumulator.n++;
    accumulator.sum += value;
    accumulator.abs += Math.abs(value);
    accumulator.sq += value * value;
    if (value < 0) accumulator.neg++;
    if (value > 0) accumulator.pos++;
    accumulator.maxAbs = Math.max(accumulator.maxAbs, Math.abs(value));
}

export function finalizeResidualStats(accumulator) {
    if (!accumulator || accumulator.n <= 0) {
        return {
            n: 0,
            mean: 0,
            meanAbs: 0,
            rms: 0,
            negativeRatio: 0,
            positiveRatio: 0,
            maxAbs: 0
        };
    }
    return {
        n: accumulator.n,
        mean: accumulator.sum / accumulator.n,
        meanAbs: accumulator.abs / accumulator.n,
        rms: Math.sqrt(accumulator.sq / accumulator.n),
        negativeRatio: accumulator.neg / accumulator.n,
        positiveRatio: accumulator.pos / accumulator.n,
        maxAbs: accumulator.maxAbs
    };
}

function roundResidualStats(stats) {
    return {
        n: stats.n,
        mean: Number(stats.mean.toFixed(6)),
        meanAbs: Number(stats.meanAbs.toFixed(6)),
        rms: Number(stats.rms.toFixed(6)),
        negativeRatio: Number(stats.negativeRatio.toFixed(6)),
        positiveRatio: Number(stats.positiveRatio.toFixed(6)),
        maxAbs: Number(stats.maxAbs.toFixed(6))
    };
}

export function summarizeWatermarkResidual({
    currentImage,
    referenceImage,
    alphaMap,
    watermarkPosition,
    backgroundAlphaThreshold = DEFAULT_BACKGROUND_ALPHA_THRESHOLD,
    edgeGradientThreshold = DEFAULT_EDGE_GRADIENT_THRESHOLD,
    highAlphaThreshold = DEFAULT_HIGH_ALPHA_THRESHOLD
}) {
    if (!currentImage || !referenceImage || currentImage.width !== referenceImage.width || currentImage.height !== referenceImage.height) {
        throw new Error('current/reference 图像尺寸不一致');
    }
    const width = watermarkPosition.width;
    const height = watermarkPosition.height;
    if (alphaMap.length !== width * height) {
        throw new Error('alphaMap 尺寸与 watermarkPosition 不一致');
    }

    const { gradient, maxGradient } = buildAlphaGradientMap(alphaMap, width, height);
    const rawResiduals = new Float32Array(width * height);
    let backgroundSum = 0;
    let backgroundCount = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const alphaIndex = y * width + x;
            const imageX = watermarkPosition.x + x;
            const imageY = watermarkPosition.y + y;
            if (imageX < 0 || imageX >= currentImage.width || imageY < 0 || imageY >= currentImage.height) {
                continue;
            }

            const idx = (imageY * currentImage.width + imageX) * 4;
            const residual = lumaAt(currentImage.data, idx) - lumaAt(referenceImage.data, idx);
            rawResiduals[alphaIndex] = residual;
            if ((alphaMap[alphaIndex] || 0) <= backgroundAlphaThreshold) {
                backgroundSum += residual;
                backgroundCount++;
            }
        }
    }

    const backgroundMean = backgroundCount > 0 ? backgroundSum / backgroundCount : 0;
    const accumulators = {
        active: createResidualAccumulator(),
        nearZero: createResidualAccumulator(),
        edge: createResidualAccumulator(),
        lowBody: createResidualAccumulator(),
        highBody: createResidualAccumulator()
    };

    for (let i = 0; i < rawResiduals.length; i++) {
        const alpha = alphaMap[i] || 0;
        const normalizedGradient = maxGradient > 0 ? gradient[i] / maxGradient : 0;
        const bucket = classifyResidualBucket(alpha, normalizedGradient, {
            backgroundAlphaThreshold,
            edgeGradientThreshold,
            highAlphaThreshold
        });
        const normalizedResidual = rawResiduals[i] - backgroundMean;
        addResidual(accumulators[bucket], normalizedResidual);
        if (bucket !== 'nearZero') {
            addResidual(accumulators.active, normalizedResidual);
        }
    }

    return {
        backgroundMean,
        buckets: Object.fromEntries(
            Object.entries(accumulators).map(([key, value]) => [key, finalizeResidualStats(value)])
        )
    };
}

function mergeBucketStats(target, frameBuckets) {
    for (const [bucket, stats] of Object.entries(frameBuckets)) {
        if (!target[bucket]) target[bucket] = createResidualAccumulator();
        target[bucket].n += stats.n;
        target[bucket].sum += stats.mean * stats.n;
        target[bucket].abs += stats.meanAbs * stats.n;
        target[bucket].sq += stats.rms * stats.rms * stats.n;
        target[bucket].neg += stats.negativeRatio * stats.n;
        target[bucket].pos += stats.positiveRatio * stats.n;
        target[bucket].maxAbs = Math.max(target[bucket].maxAbs, stats.maxAbs);
    }
}

export function summarizeResidualFrames(frames) {
    const totals = {};
    for (const frame of frames) {
        mergeBucketStats(totals, frame.buckets);
    }
    return Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [key, finalizeResidualStats(value)])
    );
}

function resolvePrimaryWatermark({ metadata, cropBox }) {
    const candidates = resolveVideoWatermarkCandidates(metadata.width, metadata.height);
    const primary = candidates[0];
    if (!primary) {
        throw new Error('无法根据视频尺寸推断视频水印候选');
    }
    const localPosition = {
        x: primary.x - cropBox.left,
        y: primary.y - cropBox.top,
        width: primary.size,
        height: primary.size
    };
    return { candidates, primary, localPosition };
}

export async function analyzeVideoResidual({
    currentPath,
    referencePath,
    originalPath = null,
    outputPath = DEFAULT_OUTPUT_PATH,
    frameDir = null,
    timestamps = [...DEFAULT_TIMESTAMPS],
    cropBox = null,
    keepFrames = false,
    backgroundAlphaThreshold = DEFAULT_BACKGROUND_ALPHA_THRESHOLD,
    edgeGradientThreshold = DEFAULT_EDGE_GRADIENT_THRESHOLD,
    highAlphaThreshold = DEFAULT_HIGH_ALPHA_THRESHOLD
} = {}) {
    if (!currentPath) throw new Error('缺少 --current 视频路径');
    if (!referencePath) throw new Error('缺少 --reference/--allenk 视频路径');

    const metadataSource = originalPath || currentPath;
    const metadata = await probeVideo(metadataSource);
    const resolvedTimestamps = resolveVideoCropTimestamps(timestamps, metadata);
    const resolvedCropBox = cropBox
        ? normalizeCropBox(cropBox, metadata)
        : resolveDefaultVideoCropBox(metadata);
    const { candidates, primary, localPosition } = resolvePrimaryWatermark({
        metadata,
        cropBox: resolvedCropBox
    });
    const alphaMap = getVideoAlphaMap(primary.size);

    const resolvedFrameDir = path.resolve(frameDir || resolveDefaultFrameDir(outputPath));
    await rm(resolvedFrameDir, { recursive: true, force: true });
    await mkdir(resolvedFrameDir, { recursive: true });

    try {
        const frames = [];
        for (const timestamp of resolvedTimestamps) {
            const suffix = formatTimestampFileSuffix(timestamp);
            const currentFrame = path.join(resolvedFrameDir, `current-${suffix}.png`);
            const referenceFrame = path.join(resolvedFrameDir, `reference-${suffix}.png`);

            await extractCropFrame({
                videoPath: currentPath,
                timestamp,
                cropBox: resolvedCropBox,
                outputPath: currentFrame
            });
            await extractCropFrame({
                videoPath: referencePath,
                timestamp,
                cropBox: resolvedCropBox,
                outputPath: referenceFrame
            });

            const currentImage = await decodeImageData(currentFrame);
            const referenceImage = await decodeImageData(referenceFrame);
            const residual = summarizeWatermarkResidual({
                currentImage,
                referenceImage,
                alphaMap,
                watermarkPosition: localPosition,
                backgroundAlphaThreshold,
                edgeGradientThreshold,
                highAlphaThreshold
            });

            frames.push({
                timestamp,
                backgroundMean: residual.backgroundMean,
                buckets: residual.buckets
            });
        }

        const report = {
            currentPath: path.resolve(currentPath),
            referencePath: path.resolve(referencePath),
            originalPath: originalPath ? path.resolve(originalPath) : null,
            outputPath: path.resolve(outputPath),
            frameDir: keepFrames ? resolvedFrameDir : null,
            metadata,
            cropBox: resolvedCropBox,
            timestamps: resolvedTimestamps,
            primaryCandidate: primary,
            localWatermarkPosition: localPosition,
            candidates,
            thresholds: {
                backgroundAlphaThreshold,
                edgeGradientThreshold,
                highAlphaThreshold
            },
            aggregate: summarizeResidualFrames(frames),
            frames
        };

        await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
        await writeFile(outputPath, JSON.stringify(report, null, 2));
        return report;
    } finally {
        if (!keepFrames) {
            await rm(resolvedFrameDir, { recursive: true, force: true });
        }
    }
}

function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        timestamps: [...DEFAULT_TIMESTAMPS],
        frameDir: null,
        keepFrames: false
    };
    const args = [...argv];

    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--current') {
            parsed.currentPath = args.shift();
            continue;
        }
        if (arg === '--reference' || arg === '--allenk') {
            parsed.referencePath = args.shift();
            continue;
        }
        if (arg === '--original') {
            parsed.originalPath = args.shift();
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift() || parsed.outputPath;
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--crop') {
            parsed.cropBox = parseCropBox(args.shift());
            continue;
        }
        if (arg === '--frame-dir') {
            parsed.frameDir = args.shift() || parsed.frameDir;
            continue;
        }
        if (arg === '--keep-frames') {
            parsed.keepFrames = true;
            continue;
        }
        if (arg === '--background-alpha-threshold') {
            parsed.backgroundAlphaThreshold = toFiniteNumber(args.shift());
            continue;
        }
        if (arg === '--edge-gradient-threshold') {
            parsed.edgeGradientThreshold = toFiniteNumber(args.shift());
            continue;
        }
        if (arg === '--high-alpha-threshold') {
            parsed.highAlphaThreshold = toFiniteNumber(args.shift());
            continue;
        }
        if (!parsed.currentPath) {
            parsed.currentPath = arg;
        }
    }

    return parsed;
}

function formatBucketLine(label, stats) {
    return `${label}: mean=${stats.mean.toFixed(4)} meanAbs=${stats.meanAbs.toFixed(4)} rms=${stats.rms.toFixed(4)} neg=${stats.negativeRatio.toFixed(3)}`;
}

async function runCli() {
    const report = await analyzeVideoResidual(parseCliArgs(process.argv.slice(2)));
    const aggregate = Object.fromEntries(
        Object.entries(report.aggregate).map(([key, value]) => [key, roundResidualStats(value)])
    );
    console.log(`report: ${report.outputPath}`);
    console.log(`crop: ${report.cropBox.left},${report.cropBox.top},${report.cropBox.width},${report.cropBox.height}`);
    console.log(`timestamps: ${report.timestamps.join(', ')}`);
    for (const key of ['active', 'edge', 'lowBody', 'highBody', 'nearZero']) {
        if (aggregate[key]) console.log(formatBucketLine(key, aggregate[key]));
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
