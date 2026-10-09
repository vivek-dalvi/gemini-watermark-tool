import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    DEFAULT_ROI_SIZE,
    exportAllenkFdncnnOnnxArtifact,
    parseArgs
} from '../../scripts/export-allenk-fdncnn-onnx.js';

const FIXTURE_DIR = path.resolve('.artifacts/test-allenk-fdncnn-onnx');

function int32Bytes(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, true);
    return [...bytes];
}

function float32Bytes(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return [...bytes];
}

function createTinyParamBuffer() {
    const bytes = [];
    const pushI32 = (value) => bytes.push(...int32Bytes(value));

    pushI32(7767517);
    pushI32(2);
    pushI32(2);

    pushI32(16);
    pushI32(0);
    pushI32(1);
    pushI32(0);
    pushI32(-233);

    pushI32(6);
    pushI32(1);
    pushI32(1);
    pushI32(0);
    pushI32(1);
    for (const [key, value] of [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 0],
        [5, 1],
        [6, 4],
        [9, 0],
        [11, 1],
        [12, 1],
        [13, 1],
        [14, 0]
    ]) {
        pushI32(key);
        pushI32(value);
    }
    pushI32(-233);

    return Buffer.from(bytes);
}

function createTinyBinBuffer() {
    const bytes = [
        0x47, 0x6b, 0x30, 0x01,
        0x00, 0x3c,
        0x00, 0x00,
        0x00, 0x00,
        0x00, 0x00,
        ...float32Bytes(0)
    ];
    return Buffer.from(bytes);
}

test('parseArgs should accept ONNX export options', () => {
    const args = parseArgs(['--input-dir', 'a', '--output-dir', 'b', '--roi-size', '96']);
    assert.equal(args.inputDir, path.resolve('a'));
    assert.equal(args.outputDir, path.resolve('b'));
    assert.equal(args.roiSize, 96);
    assert.equal(DEFAULT_ROI_SIZE, 72);
});

test('parseArgs should accept rectangular ONNX export options', () => {
    const args = parseArgs(['--roi-width', '87', '--roi-height', '74']);
    assert.equal(args.roiWidth, 87);
    assert.equal(args.roiHeight, 74);
    assert.equal(args.roiSize, 72);
});

test('exportAllenkFdncnnOnnxArtifact should write ONNX and manifest files', async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    const inputDir = path.join(FIXTURE_DIR, 'input');
    const outputDir = path.join(FIXTURE_DIR, 'output');
    await mkdir(inputDir, { recursive: true });

    const paramPath = path.join(inputDir, 'model_core_fp16.param.bin');
    const binPath = path.join(inputDir, 'model_core_fp16.bin');
    await writeFile(paramPath, createTinyParamBuffer());
    await writeFile(binPath, createTinyBinBuffer());
    await writeFile(path.join(inputDir, 'manifest.json'), `${JSON.stringify({
        upstream: 'allenk/GeminiWatermarkTool',
        license: 'MIT',
        model: {
            name: 'FDnCNN Color FP16',
            runtime: 'NCNN',
            param: { path: path.relative(process.cwd(), paramPath) },
            bin: { path: path.relative(process.cwd(), binPath) }
        }
    }, null, 2)}\n`);

    const result = await exportAllenkFdncnnOnnxArtifact({
        inputDir,
        outputDir,
        roiSize: 2
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const onnx = await readFile(result.onnxPath);
    const text = new TextDecoder().decode(onnx);

    assert.equal(manifest.model.onnx.path, path.relative(process.cwd(), result.onnxPath));
    assert.equal(manifest.model.metadata.inputShape[2], 2);
    assert.equal(manifest.model.metadata.nodeCount, 1);
    assert.match(text, /Conv/);
    assert.match(text, /fdncnn_output/);
});

test('exportAllenkFdncnnOnnxArtifact should write rectangular ONNX artifacts', async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    const inputDir = path.join(FIXTURE_DIR, 'input');
    const outputDir = path.join(FIXTURE_DIR, 'rect-output');
    await mkdir(inputDir, { recursive: true });

    const paramPath = path.join(inputDir, 'model_core_fp16.param.bin');
    const binPath = path.join(inputDir, 'model_core_fp16.bin');
    await writeFile(paramPath, createTinyParamBuffer());
    await writeFile(binPath, createTinyBinBuffer());
    await writeFile(path.join(inputDir, 'manifest.json'), `${JSON.stringify({
        upstream: 'allenk/GeminiWatermarkTool',
        license: 'MIT',
        model: {
            name: 'FDnCNN Color FP16',
            runtime: 'NCNN',
            param: { path: path.relative(process.cwd(), paramPath) },
            bin: { path: path.relative(process.cwd(), binPath) }
        }
    }, null, 2)}\n`);

    const result = await exportAllenkFdncnnOnnxArtifact({
        inputDir,
        outputDir,
        roiWidth: 4,
        roiHeight: 3
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));

    assert.equal(path.basename(result.onnxPath), 'model_core_fp32_4x3.onnx');
    assert.deepEqual(manifest.model.metadata.inputShape, [1, 4, 3, 4]);
});
