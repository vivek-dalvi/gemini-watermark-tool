import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { createAllenkFdncnnOnnxRuntime } from '../src/core/allenkFdncnnOnnxRuntime.js';
import {
    applyVideoResidualCleanupAsync,
    VIDEO_DENOISE_BACKENDS
} from '../src/video/videoCleanupBackends.js';
import { getVideoAlphaMap } from '../src/video/videoWatermarkDetector.js';
import {
    loadVideoCropBenchmarkManifest,
    resolveExpectedWatermarkCandidate
} from './video-crop-benchmark.js';

const execFileAsync = promisify(execFile);

const DEFAULT_ONNX_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/roi104/onnx-manifest.json');
const DEFAULT_BENCHMARK_MANIFEST = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_CASE_ID = '4d420881';
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/allenk-fdncnn/video-frame-export');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        manifest: DEFAULT_ONNX_MANIFEST,
        benchmarkManifest: DEFAULT_BENCHMARK_MANIFEST,
        caseId: DEFAULT_CASE_ID,
        outputDir: DEFAULT_OUTPUT_DIR,
        duration: 3,
        sigma: 75,
        padding: 16,
        strength: 0.25,
        fps: null,
        crf: 12,
        preset: 'slow',
        skipDenoise: false,
        executionProvider: 'wasm'
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--manifest') {
            args.manifest = path.resolve(argv[++i]);
        } else if (arg === '--benchmark-manifest') {
            args.benchmarkManifest = path.resolve(argv[++i]);
        } else if (arg === '--case') {
            args.caseId = argv[++i];
        } else if (arg === '--input') {
            args.input = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.output = path.resolve(argv[++i]);
        } else if (arg === '--output-dir') {
            args.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--duration') {
            args.duration = Number(argv[++i]);
        } else if (arg === '--fps') {
            args.fps = Number(argv[++i]);
        } else if (arg === '--sigma') {
            args.sigma = Number(argv[++i]);
        } else if (arg === '--padding') {
            args.padding = Number(argv[++i]);
        } else if (arg === '--strength') {
            args.strength = Number(argv[++i]);
        } else if (arg === '--crf') {
            args.crf = Number(argv[++i]);
        } else if (arg === '--preset') {
            args.preset = argv[++i] || args.preset;
        } else if (arg === '--skip-denoise') {
            args.skipDenoise = true;
        } else if (arg === '--execution-provider') {
            args.executionProvider = argv[++i] || args.executionProvider;
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function parseRate(value, fallback = 24) {
    const text = String(value || '');
    if (text.includes('/')) {
        const [num, den] = text.split('/').map(Number);
        return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : fallback;
    }
    const rate = Number(text);
    return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

async function probeVideoFps(inputPath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=avg_frame_rate,r_frame_rate',
            '-of', 'json',
            inputPath
        ]);
        const payload = JSON.parse(stdout);
        const stream = payload.streams?.[0] || {};
        return parseRate(stream.avg_frame_rate, parseRate(stream.r_frame_rate, 24));
    } catch {
        return 24;
    }
}

function createImageDataContext(imageData) {
    return {
        canvas: {
            width: imageData.width,
            height: imageData.height
        },
        getImageData(x, y, width, height) {
            const left = Math.round(x);
            const top = Math.round(y);
            const w = Math.round(width);
            const h = Math.round(height);
            const output = new Uint8ClampedArray(w * h * 4);
            for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                    const sx = left + col;
                    const sy = top + row;
                    if (sx < 0 || sx >= imageData.width || sy < 0 || sy >= imageData.height) continue;
                    const src = (sy * imageData.width + sx) * 4;
                    const dst = (row * w + col) * 4;
                    output[dst] = imageData.data[src];
                    output[dst + 1] = imageData.data[src + 1];
                    output[dst + 2] = imageData.data[src + 2];
                    output[dst + 3] = imageData.data[src + 3];
                }
            }
            return { width: w, height: h, data: output };
        },
        putImageData(patch, x, y) {
            const left = Math.round(x);
            const top = Math.round(y);
            for (let row = 0; row < patch.height; row++) {
                for (let col = 0; col < patch.width; col++) {
                    const tx = left + col;
                    const ty = top + row;
                    if (tx < 0 || tx >= imageData.width || ty < 0 || ty >= imageData.height) continue;
                    const src = (row * patch.width + col) * 4;
                    const dst = (ty * imageData.width + tx) * 4;
                    imageData.data[dst] = patch.data[src];
                    imageData.data[dst + 1] = patch.data[src + 1];
                    imageData.data[dst + 2] = patch.data[src + 2];
                    imageData.data[dst + 3] = patch.data[src + 3];
                }
            }
        }
    };
}

async function decodeFrame(framePath) {
    const { data, info } = await sharp(framePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

async function encodeFrame(imageData, framePath) {
    await sharp(imageData.data, {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toFile(framePath);
}

async function createRuntimeFromManifest({ manifest, executionProvider = 'wasm' } = {}) {
    const onnxManifest = JSON.parse(await readFile(manifest, 'utf8'));
    const modelBytes = await readFile(path.resolve(onnxManifest.model.onnx.path));
    return {
        runtime: await createAllenkFdncnnOnnxRuntime({
            modelBytes,
            executionProvider,
            inputName: onnxManifest.model.metadata.inputName,
            outputName: onnxManifest.model.metadata.outputName,
            inputShape: onnxManifest.model.metadata.inputShape,
            outputShape: onnxManifest.model.metadata.outputShape
        }),
        onnxManifest
    };
}

async function resolveCaseConfig({ benchmarkManifest, caseId, input }) {
    if (input) {
        return {
            input,
            caseItem: null,
            candidate: null
        };
    }
    const manifest = await loadVideoCropBenchmarkManifest(benchmarkManifest);
    const caseItem = manifest.cases.find((item) => item.id === caseId);
    if (!caseItem) throw new Error(`Unknown benchmark case: ${caseId}`);
    const candidate = resolveExpectedWatermarkCandidate(caseItem.expected);
    if (!candidate) throw new Error(`Benchmark case ${caseId} is missing expected anchor`);
    return {
        input: caseItem.currentPath,
        caseItem,
        candidate
    };
}

async function exportAllenkFdncnnOnnxFrameVideo({
    manifest = DEFAULT_ONNX_MANIFEST,
    benchmarkManifest = DEFAULT_BENCHMARK_MANIFEST,
    caseId = DEFAULT_CASE_ID,
    input = null,
    output = null,
    outputDir = DEFAULT_OUTPUT_DIR,
    duration = 3,
    fps = null,
    sigma = 75,
    padding = 16,
    strength = 0.25,
    crf = 12,
    preset = 'slow',
    skipDenoise = false,
    executionProvider = 'wasm'
} = {}) {
    const resolvedOutputDir = path.resolve(outputDir);
    const frameDir = path.join(resolvedOutputDir, 'frames');
    const processedDir = path.join(resolvedOutputDir, 'processed-frames');
    await rm(frameDir, { recursive: true, force: true });
    await rm(processedDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });
    await mkdir(processedDir, { recursive: true });

    const caseConfig = await resolveCaseConfig({ benchmarkManifest, caseId, input });
    const inputPath = caseConfig.input;
    const candidate = caseConfig.candidate || {
        x: 1740,
        y: 900,
        size: 72
    };
    const resolvedFps = Number.isFinite(fps) && fps > 0 ? fps : await probeVideoFps(inputPath);
    const outputPath = output
        ? path.resolve(output)
        : path.join(resolvedOutputDir, `${caseId || 'video'}-pad16-strength025.mp4`);
    const reportPath = path.join(resolvedOutputDir, `${path.basename(outputPath, '.mp4')}-report.json`);
    const startedAt = Date.now();

    await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', inputPath,
        '-t', String(duration),
        path.join(frameDir, 'frame-%06d.png')
    ]);

    const runtimeBundle = skipDenoise
        ? { runtime: null, onnxManifest: null }
        : await createRuntimeFromManifest({ manifest, executionProvider });
    const { runtime, onnxManifest } = runtimeBundle;
    const alphaMap = getVideoAlphaMap(candidate.size, { candidate });
    const position = {
        x: candidate.x,
        y: candidate.y,
        width: candidate.size,
        height: candidate.size
    };
    const files = (await readdir(frameDir)).filter((name) => name.endsWith('.png')).sort();
    const runtimeSamples = [];

    for (const fileName of files) {
        const sourcePath = path.join(frameDir, fileName);
        const targetPath = path.join(processedDir, fileName);
        const imageData = await decodeFrame(sourcePath);
        const cleanupResult = skipDenoise
            ? { denoiseRuntimeStatus: 'skipped-control', denoiseRuntimeRunMs: null }
            : await applyVideoResidualCleanupAsync(createImageDataContext(imageData), position, alphaMap, {
                residualCleanupStrength: 0,
                denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
                edgeDenoiseStrength: strength,
                allenkFdncnnRuntime: runtime,
                allenkFdncnnSigma: sigma,
                allenkFdncnnPadding: padding
            });
        runtimeSamples.push({
            frame: fileName,
            denoiseRuntimeStatus: cleanupResult.denoiseRuntimeStatus,
            denoiseRuntimeRunMs: cleanupResult.denoiseRuntimeRunMs ?? null
        });
        await encodeFrame(imageData, targetPath);
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    const encodeCrf = Number.isFinite(crf) && crf >= 0 && crf <= 51 ? crf : 12;
    const encodePreset = typeof preset === 'string' && preset.trim() ? preset.trim() : 'slow';
    await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-framerate', String(resolvedFps),
        '-i', path.join(processedDir, 'frame-%06d.png'),
        '-c:v', 'libx264',
        '-crf', String(encodeCrf),
        '-preset', encodePreset,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
    ]);

    const applied = runtimeSamples.filter((item) => item.denoiseRuntimeStatus === 'applied');
    const avgRunMs = applied.length
        ? applied.reduce((sum, item) => sum + (item.denoiseRuntimeRunMs || 0), 0) / applied.length
        : null;
    const report = {
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        input: inputPath,
        output: outputPath,
        caseId,
        duration,
        fps: resolvedFps,
        frames: files.length,
        candidate,
        profile: {
            runtime: runtime?.id || 'none',
            onnx: onnxManifest?.model?.onnx || null,
            sigma,
            padding,
            strength,
            encodeCrf,
            encodePreset,
            skipDenoise
        },
        runtimeSummary: {
            appliedFrames: applied.length,
            avgRunMs,
            samples: runtimeSamples.slice(0, 10)
        }
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return { ...report, reportPath };
}

function printHelp() {
    console.log(`Usage: pnpm export:allenk-fdncnn-onnx-frame-video -- [--case 4d420881] [--duration 3] [--output out.mp4] [--crf 12] [--preset slow] [--skip-denoise]

Offline frame-based video export for the current allenk FDnCNN ONNX candidate.`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }
    const result = await exportAllenkFdncnnOnnxFrameVideo(args);
    console.log(`output: ${path.relative(process.cwd(), result.output)}`);
    console.log(`report: ${path.relative(process.cwd(), result.reportPath)}`);
    console.log(`frames: ${result.frames}, avg runtime: ${result.runtimeSummary.avgRunMs?.toFixed(1) ?? '-'}ms`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_BENCHMARK_MANIFEST,
    DEFAULT_CASE_ID,
    DEFAULT_ONNX_MANIFEST,
    DEFAULT_OUTPUT_DIR,
    exportAllenkFdncnnOnnxFrameVideo,
    parseArgs
};
