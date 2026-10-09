import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    DEFAULT_MEM_HEADER,
    DEFAULT_OUTPUT_DIR,
    extractAllenkFdncnnModel,
    parseArgs,
    parseByteArray
} from '../../scripts/extract-allenk-fdncnn-model.js';

const TEST_TMP_DIR = path.resolve('.artifacts/test-tmp/allenk-fdncnn');

function int32Buffer(values) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeInt32LE(value, index * 4));
    return buffer;
}

function fp16WeightBinBuffer(segments) {
    const chunks = [];
    for (const segment of segments) {
        const weightBytes = Buffer.alloc(segment.weightCount * 2);
        const biasBytes = Buffer.alloc(segment.biasCount * 4);
        const tag = Buffer.alloc(4);
        tag.writeUInt32LE(0x01306b47, 0);
        chunks.push(tag, weightBytes, biasBytes);
    }
    return Buffer.concat(chunks);
}

function byteArrayLiteral(buffer) {
    return [...buffer].map((value) => `0x${value.toString(16).padStart(2, '0')}`).join(', ');
}

test.afterEach(async () => {
    await rm(TEST_TMP_DIR, { recursive: true, force: true });
});

test('parseByteArray should extract hex and decimal bytes from the allenk header shape', () => {
    const header = `
        static const unsigned char model_core_fp16_param_bin[] = { 0x01, 2, 0xff };
        static const unsigned char model_core_fp16_bin[] = { 3, 0x04, 5 };
    `;

    assert.deepEqual([...parseByteArray(header, 'param')], [1, 2, 255]);
    assert.deepEqual([...parseByteArray(header, 'bin')], [3, 4, 5]);
});

test('parseByteArray should fail closed for missing or invalid arrays', () => {
    assert.throws(() => parseByteArray('', 'param'), /Unable to find param/);
    assert.throws(() => parseByteArray('model_core_fp16_bin[] = { 256 };', 'bin'), /Invalid byte value/);
    assert.throws(() => parseByteArray('model_core_fp16_bin[] = { 1 };', 'unknown'), /Unsupported model array kind/);
});

test('parseArgs should keep the repo-local allenk defaults and accept explicit paths', () => {
    assert.deepEqual(parseArgs([]), {
        source: DEFAULT_MEM_HEADER,
        outputDir: DEFAULT_OUTPUT_DIR
    });

    assert.deepEqual(parseArgs(['--source', 'foo.h', '--output-dir', 'out']), {
        source: path.resolve('foo.h'),
        outputDir: path.resolve('out')
    });
});

test('extractAllenkFdncnnModel should write binary assets and a manifest', async () => {
    await mkdir(TEST_TMP_DIR, { recursive: true });
    const sourcePath = path.join(TEST_TMP_DIR, 'model_core.mem.h');
    const outputDir = path.join(TEST_TMP_DIR, 'output');
    const paramBuffer = int32Buffer([
        7767517, 3, 3,
        16, 0, 1, 0, -233,
        6, 1, 1, 0, 1, 0, 64, 1, 1, 4, 0, 5, 1, 6, 256, 9, 1, -233,
        6, 1, 1, 1, 2, 0, 3, 1, 1, 4, 0, 5, 1, 6, 192, 9, 0, -233
    ]);
    const binBuffer = fp16WeightBinBuffer([
        { weightCount: 256, biasCount: 64 },
        { weightCount: 192, biasCount: 3 }
    ]);

    await writeFile(sourcePath, `
        static const unsigned char model_core_fp16_param_bin[] = { ${byteArrayLiteral(paramBuffer)} };
        static const unsigned char model_core_fp16_bin[] = { ${byteArrayLiteral(binBuffer)} };
    `);

    const result = await extractAllenkFdncnnModel({
        source: sourcePath,
        outputDir
    });

    assert.deepEqual(await readFile(result.paramPath), paramBuffer);
    assert.deepEqual(await readFile(result.binPath), binBuffer);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.license, 'MIT');
    assert.equal(manifest.upstream, 'allenk/GeminiWatermarkTool');
    assert.equal(manifest.model.name, 'FDnCNN Color FP16');
    assert.equal(manifest.model.summary.convolutionLayerCount, 2);
    assert.equal(manifest.model.summary.reluConvolutionLayerCount, 1);
    assert.equal(manifest.model.summary.inputChannels, 4);
    assert.equal(manifest.model.summary.outputChannels, 3);
    assert.equal(manifest.model.weightLayout.storage, 'fp16-weights-fp32-bias');
    assert.equal(manifest.model.weightLayout.segments.length, 2);
    assert.equal(manifest.model.param.bytes, paramBuffer.length);
    assert.equal(manifest.model.bin.bytes, binBuffer.length);
    assert.equal(manifest.model.param.path, path.relative(process.cwd(), result.paramPath));
    assert.equal(manifest.model.bin.path, path.relative(process.cwd(), result.binPath));
    assert.match(manifest.model.param.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.model.bin.sha256, /^[a-f0-9]{64}$/);
});
