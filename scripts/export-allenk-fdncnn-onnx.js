import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import {
    buildAllenkFdncnnWeightLayout,
    parseAllenkFdncnnParam
} from '../src/core/allenkFdncnnNcnnModel.js';
import { exportAllenkFdncnnOnnx } from '../src/core/allenkFdncnnOnnxExport.js';

const DEFAULT_INPUT_DIR = path.resolve('.artifacts/allenk-fdncnn');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/allenk-fdncnn');
const DEFAULT_ROI_SIZE = 72;

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        inputDir: DEFAULT_INPUT_DIR,
        outputDir: DEFAULT_OUTPUT_DIR,
        roiSize: DEFAULT_ROI_SIZE,
        roiWidth: null,
        roiHeight: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input-dir') {
            args.inputDir = path.resolve(argv[++i]);
        } else if (arg === '--output-dir') {
            args.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--roi-size') {
            args.roiSize = Number.parseInt(argv[++i], 10);
        } else if (arg === '--roi-width') {
            args.roiWidth = Number.parseInt(argv[++i], 10);
        } else if (arg === '--roi-height') {
            args.roiHeight = Number.parseInt(argv[++i], 10);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.help && (!Number.isInteger(args.roiSize) || args.roiSize <= 0)) {
        throw new Error(`Invalid --roi-size: ${args.roiSize}`);
    }
    if (!args.help && args.roiWidth !== null && (!Number.isInteger(args.roiWidth) || args.roiWidth <= 0)) {
        throw new Error(`Invalid --roi-width: ${args.roiWidth}`);
    }
    if (!args.help && args.roiHeight !== null && (!Number.isInteger(args.roiHeight) || args.roiHeight <= 0)) {
        throw new Error(`Invalid --roi-height: ${args.roiHeight}`);
    }

    return args;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function exportAllenkFdncnnOnnxArtifact({
    inputDir = DEFAULT_INPUT_DIR,
    outputDir = DEFAULT_OUTPUT_DIR,
    roiSize = DEFAULT_ROI_SIZE,
    roiWidth = null,
    roiHeight = null
} = {}) {
    const exportWidth = Number.isInteger(roiWidth) && roiWidth > 0 ? roiWidth : roiSize;
    const exportHeight = Number.isInteger(roiHeight) && roiHeight > 0 ? roiHeight : roiSize;
    const manifestPath = path.join(inputDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const paramPath = path.resolve(manifest.model.param.path);
    const binPath = path.resolve(manifest.model.bin.path);
    const paramBuffer = await readFile(paramPath);
    const binBuffer = await readFile(binPath);
    const parsedParam = parseAllenkFdncnnParam(paramBuffer);
    const weightLayout = buildAllenkFdncnnWeightLayout(parsedParam, binBuffer);
    const exported = exportAllenkFdncnnOnnx({
        bin: binBuffer,
        weightLayout,
        roiSize,
        roiWidth: exportWidth,
        roiHeight: exportHeight
    });

    await mkdir(outputDir, { recursive: true });
    const shapeLabel = exportWidth === exportHeight ? String(exportWidth) : `${exportWidth}x${exportHeight}`;
    const onnxPath = path.join(outputDir, `model_core_fp32_${shapeLabel}.onnx`);
    const onnxManifestPath = path.join(outputDir, 'onnx-manifest.json');
    await writeFile(onnxPath, exported.bytes);

    const onnxManifest = {
        generatedAt: new Date().toISOString(),
        sourceManifest: path.relative(process.cwd(), manifestPath),
        upstream: manifest.upstream,
        license: manifest.license,
        model: {
            name: `${manifest.model.name} ONNX FP32 ${shapeLabel}`,
            sourceRuntime: manifest.model.runtime,
            runtimeTarget: 'ONNX Runtime Web / WebGPU spike',
            onnx: {
                path: path.relative(process.cwd(), onnxPath),
                bytes: exported.bytes.length,
                sha256: sha256(exported.bytes)
            },
            metadata: exported.metadata
        },
        notes: [
            'Generated from allenk NCNN FP16 weights and FP32 bias into ONNX FLOAT raw_data initializers.',
            'The export uses a fixed square ROI shape so the first browser runtime spike can avoid dynamic-shape ambiguity.',
            'This is a candidate runtime asset, not yet bundled into the production userscript.'
        ]
    };
    await writeFile(onnxManifestPath, `${JSON.stringify(onnxManifest, null, 2)}\n`);

    return {
        onnxPath,
        manifestPath: onnxManifestPath,
        manifest: onnxManifest
    };
}

function printHelp() {
    console.log(`Usage: pnpm export:allenk-fdncnn-onnx [--input-dir <dir>] [--output-dir <dir>] [--roi-size 72] [--roi-width 87 --roi-height 74]

Export the extracted allenk FDnCNN NCNN model into a fixed-shape ONNX asset for browser runtime spikes.

Default input/output:
  ${DEFAULT_INPUT_DIR}`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }

    const result = await exportAllenkFdncnnOnnxArtifact(args);
    console.log(`onnx: ${path.relative(process.cwd(), result.onnxPath)} (${result.manifest.model.onnx.bytes} bytes)`);
    console.log(`manifest: ${path.relative(process.cwd(), result.manifestPath)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_INPUT_DIR,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_ROI_SIZE,
    exportAllenkFdncnnOnnxArtifact,
    parseArgs
};
