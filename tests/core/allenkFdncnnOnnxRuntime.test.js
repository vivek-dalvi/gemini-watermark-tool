import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAllenkFdncnnOnnxRuntime,
    validateImageShape
} from '../../src/core/allenkFdncnnOnnxRuntime.js';

test('validateImageShape should reject mismatched fixed-shape ROI input', () => {
    assert.throws(
        () => validateImageShape({
            width: 4,
            height: 2,
            data: new Uint8ClampedArray(4 * 2 * 4)
        }, [1, 4, 2, 2]),
        /expected 2x2, got 4x2/
    );
});

test('createAllenkFdncnnOnnxRuntime should run an injected ONNX session', async () => {
    const session = {
        inputNames: ['fdncnn_input'],
        outputNames: ['fdncnn_output'],
        async run(feeds) {
            assert.deepEqual(feeds.fdncnn_input.dims, [1, 4, 2, 2]);
            return {
                fdncnn_output: {
                    dims: [1, 3, 2, 2],
                    data: new Float32Array([
                        1, 0.5, 0, 0.25,
                        0, 0.5, 1, 0.25,
                        0.25, 0.5, 0.75, 1
                    ])
                }
            };
        }
    };
    const ort = {
        Tensor: class Tensor {
            constructor(type, data, dims) {
                this.type = type;
                this.data = data;
                this.dims = dims;
            }
        },
        InferenceSession: {
            async create() {
                throw new Error('precreated session should be used');
            }
        }
    };
    const runtime = await createAllenkFdncnnOnnxRuntime({
        ort,
        session,
        executionProvider: 'wasm',
        inputShape: [1, 4, 2, 2],
        outputShape: [1, 3, 2, 2]
    });

    const result = await runtime.denoiseImageData({
        sigma: 25,
        imageData: {
            width: 2,
            height: 2,
            data: new Uint8ClampedArray([
                10, 20, 30, 255,
                40, 50, 60, 255,
                70, 80, 90, 255,
                100, 110, 120, 255
            ])
        }
    });

    assert.equal(result.runtime, 'allenk-fdncnn-onnx-wasm');
    assert.deepEqual(result.outputShape, [1, 3, 2, 2]);
    assert.deepEqual([...result.imageData.data], [
        255, 0, 64, 255,
        128, 128, 128, 255,
        0, 255, 191, 255,
        64, 64, 255, 255
    ]);
});
