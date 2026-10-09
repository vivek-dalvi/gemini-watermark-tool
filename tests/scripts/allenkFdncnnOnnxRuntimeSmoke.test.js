import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { exportAllenkFdncnnOnnx } from '../../src/core/allenkFdncnnOnnxExport.js';
import {
    parseArgs,
    runAllenkFdncnnOnnxRuntimeSmoke
} from '../../scripts/smoke-allenk-fdncnn-onnx-runtime.js';

const FIXTURE_DIR = path.resolve('.artifacts/test-allenk-fdncnn-runtime-smoke');

function writeFloat32LE(buffer, offset, value) {
    new DataView(buffer.buffer, buffer.byteOffset + offset, 4).setFloat32(0, value, true);
}

function writeFp16One(buffer, offset) {
    buffer[offset] = 0;
    buffer[offset + 1] = 0x3c;
}

function createTinyOnnxFixture() {
    const bin = new Uint8Array(4 + 4 * 2 + 4);
    bin[0] = 0x47;
    bin[1] = 0x6b;
    bin[2] = 0x30;
    bin[3] = 0x01;
    writeFp16One(bin, 4);
    writeFloat32LE(bin, 12, 0);

    return exportAllenkFdncnnOnnx({
        bin,
        roiSize: 2,
        weightLayout: {
            segments: [
                {
                    inputChannels: 4,
                    outputChannels: 1,
                    kernelW: 1,
                    kernelH: 1,
                    strideW: 1,
                    strideH: 1,
                    padW: 0,
                    padH: 0,
                    activationType: 0,
                    weightOffset: 4,
                    weightCount: 4,
                    biasOffset: 12,
                    biasCount: 1
                }
            ]
        }
    });
}

test('parseArgs should accept ONNX runtime smoke options', () => {
    const args = parseArgs([
        '--manifest', 'm.json',
        '--output', 'o.json',
        '--execution-provider', 'wasm'
    ]);

    assert.equal(args.manifest, path.resolve('m.json'));
    assert.equal(args.output, path.resolve('o.json'));
    assert.equal(args.executionProvider, 'wasm');
});

test('runAllenkFdncnnOnnxRuntimeSmoke should execute a tiny ONNX model', async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    await mkdir(FIXTURE_DIR, { recursive: true });
    const onnxPath = path.join(FIXTURE_DIR, 'tiny.onnx');
    const manifestPath = path.join(FIXTURE_DIR, 'onnx-manifest.json');
    const outputPath = path.join(FIXTURE_DIR, 'smoke.json');
    const exported = createTinyOnnxFixture();

    await writeFile(onnxPath, exported.bytes);
    await writeFile(manifestPath, `${JSON.stringify({
        model: {
            onnx: {
                path: path.relative(process.cwd(), onnxPath),
                bytes: exported.bytes.length,
                sha256: 'tiny'
            },
            metadata: exported.metadata
        }
    }, null, 2)}\n`);

    const report = await runAllenkFdncnnOnnxRuntimeSmoke({
        manifest: manifestPath,
        output: outputPath,
        executionProvider: 'wasm'
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));

    assert.equal(report.decision.onnxRuntimeWebExecutable, true);
    assert.deepEqual(report.inference.outputShape, [1, 1, 2, 2]);
    assert.equal(saved.inference.outputLength, 4);
});
