import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import {
    buildAllenkFdncnnWeightLayout,
    parseAllenkFdncnnParam,
    summarizeAllenkFdncnnModel
} from '../src/core/allenkFdncnnNcnnModel.js';

const DEFAULT_MEM_HEADER = path.resolve(
    '.artifacts/external-repos/GeminiWatermarkTool/external/ncnn/model-convert/output/model_core.mem.h'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/allenk-fdncnn');

const MODEL_ARRAYS = Object.freeze({
    param: /model_core_fp16_param_bin\[\]\s*=\s*\{([\s\S]*?)\};/m,
    bin: /model_core_fp16_bin\[\]\s*=\s*\{([\s\S]*?)\};/m
});

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        source: DEFAULT_MEM_HEADER,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--source') {
            args.source = path.resolve(argv[++i]);
        } else if (arg === '--output-dir') {
            args.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function parseByteArray(headerText, kind) {
    const matcher = MODEL_ARRAYS[kind];
    if (!matcher) {
        throw new Error(`Unsupported model array kind: ${kind}`);
    }

    const match = headerText.match(matcher);
    if (!match) {
        throw new Error(`Unable to find ${kind} byte array in model header`);
    }

    const tokens = match[1].match(/0x[0-9a-fA-F]{1,2}|\b\d{1,3}\b/g) || [];
    if (!tokens.length) {
        throw new Error(`No bytes parsed from ${kind} byte array`);
    }

    const bytes = Uint8Array.from(tokens.map((token) => {
        const value = token.startsWith('0x')
            ? Number.parseInt(token.slice(2), 16)
            : Number.parseInt(token, 10);
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            throw new Error(`Invalid byte value in ${kind} array: ${token}`);
        }
        return value;
    }));

    return Buffer.from(bytes);
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function extractAllenkFdncnnModel({
    source = DEFAULT_MEM_HEADER,
    outputDir = DEFAULT_OUTPUT_DIR
} = {}) {
    const headerText = await readFile(source, 'utf8');
    const paramBuffer = parseByteArray(headerText, 'param');
    const binBuffer = parseByteArray(headerText, 'bin');
    const parsedParam = parseAllenkFdncnnParam(paramBuffer);
    const weightLayout = buildAllenkFdncnnWeightLayout(parsedParam, binBuffer);
    const summary = summarizeAllenkFdncnnModel(parsedParam, weightLayout);

    await mkdir(outputDir, { recursive: true });

    const paramPath = path.join(outputDir, 'model_core_fp16.param.bin');
    const binPath = path.join(outputDir, 'model_core_fp16.bin');
    const manifestPath = path.join(outputDir, 'manifest.json');

    await writeFile(paramPath, paramBuffer);
    await writeFile(binPath, binBuffer);

    const manifest = {
        generatedAt: new Date().toISOString(),
        source: path.relative(process.cwd(), source),
        license: 'MIT',
        upstream: 'allenk/GeminiWatermarkTool',
        model: {
            name: 'FDnCNN Color FP16',
            runtime: 'NCNN',
            input: '[R, G, B, sigma] CHW float32, RGB normalized to 0..1, sigma/255',
            output: 'Denoised [R, G, B] CHW float32, RGB normalized to 0..1',
            summary,
            param: {
                path: path.relative(process.cwd(), paramPath),
                bytes: paramBuffer.length,
                sha256: sha256(paramBuffer)
            },
            bin: {
                path: path.relative(process.cwd(), binPath),
                bytes: binBuffer.length,
                sha256: sha256(binBuffer)
            },
            weightLayout: {
                storage: weightLayout.storage,
                bytesRead: weightLayout.bytesRead,
                segments: weightLayout.segments
            }
        },
        notes: [
            'Extracted from GeminiWatermarkTool external/ncnn/model-convert/output/model_core.mem.h.',
            'The browser integration should either convert this NCNN model to ONNX or run it through a Web-compatible NCNN runtime.',
            'Keep generated binary assets outside package distribution until size, license notices, and browser loading are finalized.'
        ]
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
        paramPath,
        binPath,
        manifestPath,
        manifest
    };
}

function printHelp() {
    console.log(`Usage: pnpm extract:allenk-fdncnn [--source <model_core.mem.h>] [--output-dir <dir>]

Extract allenk/GeminiWatermarkTool MIT FDnCNN NCNN model bytes from model_core.mem.h.

Default source:
  ${DEFAULT_MEM_HEADER}

Default output:
  ${DEFAULT_OUTPUT_DIR}`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }

    const result = await extractAllenkFdncnnModel(args);
    console.log(`param: ${path.relative(process.cwd(), result.paramPath)} (${result.manifest.model.param.bytes} bytes)`);
    console.log(`bin: ${path.relative(process.cwd(), result.binPath)} (${result.manifest.model.bin.bytes} bytes)`);
    console.log(`manifest: ${path.relative(process.cwd(), result.manifestPath)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_MEM_HEADER,
    DEFAULT_OUTPUT_DIR,
    extractAllenkFdncnnModel,
    parseByteArray,
    parseArgs
};
