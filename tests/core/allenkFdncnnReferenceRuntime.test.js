import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateLayoutMacs,
    createAllenkFdncnnReferenceRuntime,
    runSamePaddingConvolution
} from '../../src/core/allenkFdncnnReferenceRuntime.js';

function writeFloat32LE(buffer, offset, value) {
    new DataView(buffer.buffer, buffer.byteOffset + offset, 4).setFloat32(0, value, true);
}

function writeFp16One(buffer, offset) {
    buffer[offset] = 0;
    buffer[offset + 1] = 0x3c;
}

function createIdentityRuntimeFixture() {
    const weightBin = new Uint8Array(4 + 4 * 2 + 4);
    weightBin[0] = 0x47;
    weightBin[1] = 0x6b;
    weightBin[2] = 0x30;
    weightBin[3] = 0x01;
    writeFp16One(weightBin, 4);
    writeFloat32LE(weightBin, 12, 0);

    return {
        weightBin,
        weightLayout: {
            segments: [
                {
                    layerIndex: 1,
                    inputChannels: 4,
                    outputChannels: 1,
                    kernelW: 1,
                    kernelH: 1,
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

test('calculateLayoutMacs should sum convolution work for the reference runtime', () => {
    const { weightLayout } = createIdentityRuntimeFixture();
    assert.equal(calculateLayoutMacs(weightLayout.segments, 3, 2), 3 * 2 * 1 * 4);
});

test('runSamePaddingConvolution should apply bias and optional ReLU', () => {
    const output = runSamePaddingConvolution({
        input: new Float32Array([1, 2, 3, 4]),
        width: 2,
        height: 2,
        segment: {
            inputChannels: 1,
            outputChannels: 1,
            kernelW: 1,
            kernelH: 1,
            padW: 0,
            padH: 0,
            activationType: 1
        },
        weights: new Float32Array([-1]),
        bias: new Float32Array([2])
    });

    assert.deepEqual([...output], [1, 0, 0, 0]);
});

test('createAllenkFdncnnReferenceRuntime should run a tiny browser-compatible model', () => {
    const { weightBin, weightLayout } = createIdentityRuntimeFixture();
    const runtime = createAllenkFdncnnReferenceRuntime({
        weightBin,
        weightLayout,
        maxMacs: 100
    });

    const result = runtime.denoiseImageData({
        sigma: 25,
        imageData: {
            width: 1,
            height: 1,
            data: new Uint8ClampedArray([128, 64, 32, 255])
        }
    });

    assert.equal(result.runtime, 'allenk-fdncnn-pure-js-reference');
    assert.equal(result.macs, 4);
    assert.deepEqual([...result.imageData.data], [128, 0, 0, 255]);
});

test('createAllenkFdncnnReferenceRuntime should refuse oversized pure JS inference', () => {
    const { weightBin, weightLayout } = createIdentityRuntimeFixture();
    const runtime = createAllenkFdncnnReferenceRuntime({
        weightBin,
        weightLayout,
        maxMacs: 3
    });

    assert.throws(
        () => runtime.execute(new Float32Array(4), 1, 1),
        /pure JS reference refused/
    );
});
