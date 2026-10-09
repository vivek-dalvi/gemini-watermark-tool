import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAllenkFdncnnOnnxRuntime } from '../src/core/allenkFdncnnOnnxRuntime.js';
import { removeGeminiVideoWatermark } from '../src/video/videoExport.js';
import { VIDEO_DENOISE_BACKENDS } from '../src/video/videoCleanupBackends.js';

const DEFAULT_ONNX_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/roi104/onnx-manifest.json');
const DEFAULT_OUTPUT = path.resolve('.artifacts/allenk-fdncnn/video-export/pad16-strength025.mp4');
const DEFAULT_REPORT = path.resolve('.artifacts/allenk-fdncnn/video-export/pad16-strength025-report.json');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        manifest: DEFAULT_ONNX_MANIFEST,
        output: DEFAULT_OUTPUT,
        report: DEFAULT_REPORT,
        sigma: 75,
        padding: 16,
        strength: 0.25,
        videoBitrate: 12_000_000,
        sampleCount: undefined,
        executionProvider: 'wasm'
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input') {
            args.input = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.output = path.resolve(argv[++i]);
        } else if (arg === '--report') {
            args.report = path.resolve(argv[++i]);
        } else if (arg === '--manifest') {
            args.manifest = path.resolve(argv[++i]);
        } else if (arg === '--sigma') {
            args.sigma = Number(argv[++i]);
        } else if (arg === '--padding') {
            args.padding = Number(argv[++i]);
        } else if (arg === '--strength') {
            args.strength = Number(argv[++i]);
        } else if (arg === '--video-bitrate') {
            args.videoBitrate = Number(argv[++i]);
        } else if (arg === '--sample-count') {
            args.sampleCount = Number.parseInt(argv[++i], 10);
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

async function exportAllenkFdncnnOnnxVideo({
    input,
    output = DEFAULT_OUTPUT,
    report = DEFAULT_REPORT,
    manifest = DEFAULT_ONNX_MANIFEST,
    sigma = 75,
    padding = 16,
    strength = 0.25,
    videoBitrate = 12_000_000,
    sampleCount = undefined,
    executionProvider = 'wasm'
} = {}) {
    if (!input) throw new Error('Missing --input');
    const inputBuffer = await readFile(input);
    const file = new File([inputBuffer], path.basename(input), { type: 'video/mp4' });
    const { runtime, onnxManifest } = await createRuntimeFromManifest({ manifest, executionProvider });
    const progressSamples = [];
    const startedAt = Date.now();
    const result = await removeGeminiVideoWatermark(file, {
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: strength,
        residualCleanupStrength: 0,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: sigma,
        allenkFdncnnPadding: padding,
        videoBitrate,
        sampleCount,
        preserveAudio: true,
        onProgress(progress) {
            if (progressSamples.length < 12 || progress.phase !== progressSamples.at(-1)?.phase) {
                progressSamples.push({
                    phase: progress.phase,
                    progress: progress.progress,
                    processedFrames: progress.processedFrames,
                    frameEstimate: progress.frameEstimate,
                    elapsedSeconds: progress.elapsedSeconds
                });
            }
        }
    });
    const outputBuffer = Buffer.from(await result.blob.arrayBuffer());
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, outputBuffer);

    const payload = {
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        input,
        output,
        outputBytes: outputBuffer.length,
        profile: {
            denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
            runtime: runtime.id,
            onnx: onnxManifest.model.onnx,
            sigma,
            padding,
            strength,
            videoBitrate
        },
        result: {
            metadata: result.metadata,
            detection: result.detection,
            processedFrames: result.processedFrames,
            skippedFrames: result.skippedFrames,
            adaptiveFrames: result.adaptiveFrames,
            seedFrames: result.seedFrames,
            audioCopied: result.audioCopied,
            audioPacketCount: result.audioPacketCount,
            audioCodec: result.audioCodec,
            audioSkipReason: result.audioSkipReason
        },
        progressSamples
    };
    if (report) {
        await mkdir(path.dirname(report), { recursive: true });
        await writeFile(report, `${JSON.stringify(payload, null, 2)}\n`);
    }
    return payload;
}

function printHelp() {
    console.log(`Usage: pnpm export:allenk-fdncnn-onnx-video -- --input <video.mp4> [--output out.mp4]

Export a video through the allenk FDnCNN ONNX ROI backend. Defaults use the current promoted frame-gate candidate:
  roi=104, padding=16, sigma=75, strength=0.25`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }
    const result = await exportAllenkFdncnnOnnxVideo(args);
    console.log(`output: ${path.relative(process.cwd(), result.output)} (${result.outputBytes} bytes)`);
    console.log(`report: ${path.relative(process.cwd(), args.report)}`);
    console.log(`frames: ${result.result.processedFrames}, skipped: ${result.result.skippedFrames}, elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_ONNX_MANIFEST,
    DEFAULT_OUTPUT,
    DEFAULT_REPORT,
    createRuntimeFromManifest,
    exportAllenkFdncnnOnnxVideo,
    parseArgs
};
