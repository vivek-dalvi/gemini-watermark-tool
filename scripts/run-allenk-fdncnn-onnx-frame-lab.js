import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createAllenkFdncnnOnnxRuntime } from '../src/core/allenkFdncnnOnnxRuntime.js';
import { VIDEO_DENOISE_BACKENDS } from '../src/video/videoCleanupBackends.js';
import { runVideoFrameBackendLab } from './run-video-frame-backend-lab.js';

const DEFAULT_ONNX_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/onnx-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/allenk-fdncnn/onnx-frame-lab');
const DEFAULT_EDGE_DENOISE_STRENGTH = 0.85;

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        manifest: DEFAULT_ONNX_MANIFEST,
        outputDir: DEFAULT_OUTPUT_DIR,
        cases: null,
        timestamps: null,
        sigma: 75,
        padding: 0,
        edgeDenoiseStrength: DEFAULT_EDGE_DENOISE_STRENGTH,
        executionProvider: 'wasm'
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--manifest') {
            args.manifest = path.resolve(argv[++i]);
        } else if (arg === '--output-dir') {
            args.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--cases' || arg === '--only') {
            args.cases = String(argv[++i] || '').split(',').map((item) => item.trim()).filter(Boolean);
        } else if (arg === '--timestamps') {
            args.timestamps = argv[++i];
        } else if (arg === '--sigma') {
            const value = Number.parseFloat(argv[++i]);
            if (Number.isFinite(value)) args.sigma = value;
        } else if (arg === '--padding') {
            const value = Number.parseInt(argv[++i], 10);
            if (Number.isFinite(value)) args.padding = value;
        } else if (arg === '--strength') {
            const value = Number.parseFloat(argv[++i]);
            if (Number.isFinite(value)) args.edgeDenoiseStrength = value;
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
    return createAllenkFdncnnOnnxRuntime({
        modelBytes,
        executionProvider,
        inputName: onnxManifest.model.metadata.inputName,
        outputName: onnxManifest.model.metadata.outputName,
        inputShape: onnxManifest.model.metadata.inputShape,
        outputShape: onnxManifest.model.metadata.outputShape
    });
}

async function runAllenkFdncnnOnnxFrameLab({
    manifest = DEFAULT_ONNX_MANIFEST,
    outputDir = DEFAULT_OUTPUT_DIR,
    cases = null,
    timestamps = null,
    sigma = 75,
    padding = 0,
    edgeDenoiseStrength = DEFAULT_EDGE_DENOISE_STRENGTH,
    executionProvider = 'wasm'
} = {}) {
    const runtime = await createRuntimeFromManifest({ manifest, executionProvider });
    return runVideoFrameBackendLab({
        outputDir,
        cases,
        timestamps,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength,
        residualCleanupStrength: 0,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: sigma,
        allenkFdncnnPadding: padding
    });
}

function printHelp() {
    console.log(`Usage: pnpm lab:allenk-fdncnn-onnx-frames [--cases ids] [--timestamps 1,3,5] [--sigma 75] [--padding 0] [--strength 0.85]

Run the video frame backend lab with the exported allenk FDnCNN ONNX runtime.

Default output:
  ${DEFAULT_OUTPUT_DIR}`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }
    const report = await runAllenkFdncnnOnnxFrameLab(args);
    console.log(`report: ${path.relative(process.cwd(), report.jsonPath)}`);
    console.log(`markdown: ${path.relative(process.cwd(), report.markdownPath)}`);
    for (const item of report.cases) {
        console.log(`${item.id}: active ${item.deltas.active?.meanAbsDelta?.toFixed(4) ?? '-'} (${item.deltas.active?.verdict || '-'})`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_ONNX_MANIFEST,
    DEFAULT_OUTPUT_DIR,
    createRuntimeFromManifest,
    parseArgs,
    runAllenkFdncnnOnnxFrameLab
};
