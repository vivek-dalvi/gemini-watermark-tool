import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import {
    NCNN_BINARY_PARAM_MAGIC,
    NCNN_WEIGHT_FP16_STORAGE_TAG,
    buildAllenkFdncnnWeightLayout,
    halfToFloat,
    parseAllenkFdncnnParam,
    summarizeAllenkFdncnnModel
} from '../../src/core/allenkFdncnnNcnnModel.js';

const EXTRACTED_PARAM_PATH = '.artifacts/allenk-fdncnn/model_core_fp16.param.bin';
const EXTRACTED_WEIGHT_PATH = '.artifacts/allenk-fdncnn/model_core_fp16.bin';

async function readExtractedAllenkFdncnnFixture(t, { weight = false } = {}) {
    try {
        await access(EXTRACTED_PARAM_PATH);
        if (weight) await access(EXTRACTED_WEIGHT_PATH);
    } catch {
        t.skip('extracted allenk FDnCNN NCNN fixture is not present in this checkout');
        return null;
    }

    const paramBin = await readFile(EXTRACTED_PARAM_PATH);
    const weightBin = weight ? await readFile(EXTRACTED_WEIGHT_PATH) : null;
    return { paramBin, weightBin };
}

test('halfToFloat should decode common FP16 values', () => {
    assert.equal(halfToFloat(0x0000), 0);
    assert.equal(halfToFloat(0x3c00), 1);
    assert.equal(halfToFloat(0xc000), -2);
    assert.equal(halfToFloat(0x3800), 0.5);
});

test('parseAllenkFdncnnParam should decode the extracted allenk FDnCNN graph', async (t) => {
    const fixture = await readExtractedAllenkFdncnnFixture(t);
    if (!fixture) return;

    const { paramBin } = fixture;
    const parsed = parseAllenkFdncnnParam(paramBin);

    assert.equal(parsed.magic, NCNN_BINARY_PARAM_MAGIC);
    assert.equal(parsed.layerCount, 21);
    assert.equal(parsed.blobCount, 21);
    assert.equal(parsed.bytesRead, parsed.byteLength);
    assert.equal(parsed.layers[0].type, 'Input');
    assert.equal(parsed.layers[1].type, 'Convolution');
    assert.equal(parsed.layers[1].convolution.numOutput, 64);
    assert.equal(parsed.layers[1].convolution.weightDataSize, 2304);
    assert.equal(parsed.layers[1].convolution.activationType, 1);
    assert.equal(parsed.layers[20].convolution.numOutput, 3);
    assert.equal(parsed.layers[20].convolution.weightDataSize, 1728);
    assert.equal(parsed.layers[20].convolution.activationType, 0);
});

test('buildAllenkFdncnnWeightLayout should map every layer into the extracted weight bin', async (t) => {
    const fixture = await readExtractedAllenkFdncnnFixture(t, { weight: true });
    if (!fixture) return;

    const { paramBin, weightBin } = fixture;
    const parsed = parseAllenkFdncnnParam(paramBin);
    const layout = buildAllenkFdncnnWeightLayout(parsed, weightBin);

    assert.equal(layout.storage, 'fp16-weights-fp32-bias');
    assert.equal(layout.bytesRead, weightBin.length);
    assert.equal(layout.segments.length, 20);
    assert.equal(layout.segments[0].storageTag, NCNN_WEIGHT_FP16_STORAGE_TAG);
    assert.deepEqual(layout.segments[0], {
        layerIndex: 1,
        type: 'Convolution',
        inputChannels: 4,
        outputChannels: 64,
        kernelW: 3,
        kernelH: 3,
        strideW: 1,
        strideH: 1,
        padW: 1,
        padH: 1,
        activationType: 1,
        storageTag: NCNN_WEIGHT_FP16_STORAGE_TAG,
        weightOffset: 4,
        weightBytes: 4608,
        weightCount: 2304,
        biasOffset: 4612,
        biasBytes: 256,
        biasCount: 64
    });
    assert.equal(layout.segments[19].inputChannels, 64);
    assert.equal(layout.segments[19].outputChannels, 3);
    assert.equal(layout.segments[19].activationType, 0);
});

test('summarizeAllenkFdncnnModel should expose a compact browser-backend contract', async (t) => {
    const fixture = await readExtractedAllenkFdncnnFixture(t, { weight: true });
    if (!fixture) return;

    const { paramBin, weightBin } = fixture;
    const parsed = parseAllenkFdncnnParam(paramBin);
    const layout = buildAllenkFdncnnWeightLayout(parsed, weightBin);

    assert.deepEqual(summarizeAllenkFdncnnModel(parsed, layout), {
        layerCount: 21,
        blobCount: 21,
        convolutionLayerCount: 20,
        reluConvolutionLayerCount: 19,
        inputBlob: 0,
        outputBlob: 20,
        inputChannels: 4,
        hiddenChannels: 64,
        outputChannels: 3,
        kernel: '3x3',
        bytesRead: weightBin.length,
        weightBinBytes: weightBin.length
    });
});

test('buildAllenkFdncnnWeightLayout should fail when weight storage does not match FP16 NCNN layout', async (t) => {
    const fixture = await readExtractedAllenkFdncnnFixture(t, { weight: true });
    if (!fixture) return;

    const { paramBin, weightBin } = fixture;
    const parsed = parseAllenkFdncnnParam(paramBin);
    const corrupted = new Uint8Array(weightBin);
    corrupted[0] = 0;

    assert.throws(
        () => buildAllenkFdncnnWeightLayout(parsed, corrupted),
        /Unexpected NCNN weight storage tag/
    );
});
