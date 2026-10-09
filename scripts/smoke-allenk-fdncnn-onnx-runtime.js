import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';

const DEFAULT_ONNX_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/onnx-manifest.json');
const DEFAULT_OUTPUT = path.resolve('.artifacts/allenk-fdncnn/onnx-runtime-smoke.json');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        manifest: DEFAULT_ONNX_MANIFEST,
        output: DEFAULT_OUTPUT,
        executionProvider: 'wasm'
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--manifest') {
            args.manifest = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.output = path.resolve(argv[++i]);
        } else if (arg === '--execution-provider') {
            args.executionProvider = argv[++i];
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function createZeroInput(shape) {
    const size = shape.reduce((product, value) => product * value, 1);
    return new Float32Array(size);
}

async function runAllenkFdncnnOnnxRuntimeSmoke({
    manifest = DEFAULT_ONNX_MANIFEST,
    output = DEFAULT_OUTPUT,
    executionProvider = 'wasm'
} = {}) {
    const onnxManifest = JSON.parse(await readFile(manifest, 'utf8'));
    const modelPath = path.resolve(onnxManifest.model.onnx.path);
    const metadata = onnxManifest.model.metadata;
    const modelBytes = await readFile(modelPath);

    if (executionProvider === 'wasm') {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
    }

    const createStarted = performance.now();
    const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [executionProvider],
        graphOptimizationLevel: 'disabled'
    });
    const createMs = performance.now() - createStarted;

    const input = new ort.Tensor('float32', createZeroInput(metadata.inputShape), metadata.inputShape);
    const runStarted = performance.now();
    const outputs = await session.run({ [metadata.inputName]: input });
    const runMs = performance.now() - runStarted;
    const outputTensor = outputs[metadata.outputName];

    const report = {
        generatedAt: new Date().toISOString(),
        executionProvider,
        model: {
            path: onnxManifest.model.onnx.path,
            bytes: onnxManifest.model.onnx.bytes,
            sha256: onnxManifest.model.onnx.sha256
        },
        session: {
            inputNames: session.inputNames,
            outputNames: session.outputNames,
            createMs
        },
        inference: {
            inputName: metadata.inputName,
            outputName: metadata.outputName,
            inputShape: metadata.inputShape,
            outputShape: [...outputTensor.dims],
            outputLength: outputTensor.data.length,
            runMs
        },
        decision: {
            onnxRuntimeWebExecutable: true,
            next: 'wire this session behind an explicit video ROI runtime adapter, then run real video gate evidence before exposing it in UI'
        }
    };

    if (output) {
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    }

    return report;
}

function printHelp() {
    console.log(`Usage: pnpm smoke:allenk-fdncnn-onnx-runtime [--manifest <onnx-manifest.json>] [--output <json>] [--execution-provider wasm]

Load the exported allenk FDnCNN ONNX model with onnxruntime-web and run one zero-input inference smoke.`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }

    const report = await runAllenkFdncnnOnnxRuntimeSmoke(args);
    console.log(`provider: ${report.executionProvider}`);
    console.log(`session: ${report.session.inputNames.join(', ')} -> ${report.session.outputNames.join(', ')}`);
    console.log(`shape: [${report.inference.inputShape.join(', ')}] -> [${report.inference.outputShape.join(', ')}]`);
    console.log(`timing: create=${report.session.createMs.toFixed(1)}ms run=${report.inference.runMs.toFixed(1)}ms`);
    if (args.output) {
        console.log(`report: ${path.relative(process.cwd(), args.output)}`);
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
    DEFAULT_OUTPUT,
    parseArgs,
    runAllenkFdncnnOnnxRuntimeSmoke
};
