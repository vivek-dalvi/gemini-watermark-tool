import test from 'node:test';
import assert from 'node:assert/strict';

import {
    encodeVarint,
    exportAllenkFdncnnOnnx,
    varintField
} from '../../src/core/allenkFdncnnOnnxExport.js';

function writeFloat32LE(buffer, offset, value) {
    new DataView(buffer.buffer, buffer.byteOffset + offset, 4).setFloat32(0, value, true);
}

function writeFp16One(buffer, offset) {
    buffer[offset] = 0;
    buffer[offset + 1] = 0x3c;
}

function createTinyWeightFixture() {
    const weightBin = new Uint8Array(4 + 4 * 2 + 4);
    weightBin[0] = 0x47;
    weightBin[1] = 0x6b;
    weightBin[2] = 0x30;
    weightBin[3] = 0x01;
    writeFp16One(weightBin, 4);
    writeFloat32LE(weightBin, 12, 0.25);

    return {
        bin: weightBin,
        weightLayout: {
            segments: [
                {
                    layerIndex: 1,
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
                    weightBytes: 8,
                    weightCount: 4,
                    biasOffset: 12,
                    biasBytes: 4,
                    biasCount: 1
                }
            ]
        }
    };
}

test('encodeVarint should encode protobuf varints', () => {
    assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
    assert.deepEqual([...varintField(1, 8)], [0x08, 0x08]);
});

test('exportAllenkFdncnnOnnx should create a fixed-shape ONNX model', () => {
    const fixture = createTinyWeightFixture();
    const exported = exportAllenkFdncnnOnnx({
        ...fixture,
        roiSize: 2
    });
    const text = new TextDecoder('latin1').decode(exported.bytes);

    assert.equal(exported.metadata.nodeCount, 1);
    assert.equal(exported.metadata.initializerCount, 2);
    assert.deepEqual(exported.metadata.inputShape, [1, 4, 2, 2]);
    assert.deepEqual(exported.metadata.outputShape, [1, 1, 2, 2]);
    assert.match(text, /Conv/);
    assert.match(text, /fdncnn_input/);
    assert.match(text, /fdncnn_output/);
    assert.match(text, /conv1\.weight/);
});

test('exportAllenkFdncnnOnnx should create a rectangular fixed-shape ONNX model', () => {
    const fixture = createTinyWeightFixture();
    const exported = exportAllenkFdncnnOnnx({
        ...fixture,
        roiWidth: 4,
        roiHeight: 3
    });

    assert.deepEqual(exported.metadata.inputShape, [1, 4, 3, 4]);
    assert.deepEqual(exported.metadata.outputShape, [1, 1, 3, 4]);
    assert.equal(exported.metadata.roiWidth, 4);
    assert.equal(exported.metadata.roiHeight, 3);
});

test('exportAllenkFdncnnOnnx should reject missing weights', () => {
    assert.throws(
        () => exportAllenkFdncnnOnnx({ bin: new Uint8Array(), weightLayout: { segments: [] } }),
        /requires weightLayout\.segments/
    );
});
