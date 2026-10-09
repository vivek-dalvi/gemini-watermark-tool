import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialPipelineContext } from '../../src/core/pipelineInitialContext.js';

test('createInitialPipelineContext should build cloned initial geometry context', () => {
    const sourceImageData = {
        width: 200,
        height: 100,
        data: new Uint8ClampedArray(200 * 100 * 4)
    };
    const clonedImageData = {
        width: 200,
        height: 100,
        data: new Uint8ClampedArray(sourceImageData.data)
    };
    const alpha48 = new Float32Array(48 * 48);
    const alpha96 = new Float32Array(96 * 96);
    const defaultConfig = { logoSize: 48, marginRight: 32, marginBottom: 32 };
    const resolvedConfig = { logoSize: 48, marginRight: 16, marginBottom: 24 };
    const position = { x: 136, y: 28, width: 48, height: 48 };
    const calls = [];

    const context = createInitialPipelineContext({
        imageData: sourceImageData,
        options: {
            alpha48,
            alpha96,
            adaptiveMode: 'off'
        },
        cloneImageData: (imageData) => {
            calls.push(['clone', imageData]);
            return clonedImageData;
        },
        alphaGainCandidates: [0.8, 1],
        alphaPriorityGains: [1],
        detectConfig: (width, height) => {
            calls.push(['detect', width, height]);
            return defaultConfig;
        },
        resolveConfig: (payload) => {
            calls.push(['resolve', payload]);
            return resolvedConfig;
        },
        calculatePosition: (width, height, config) => {
            calls.push(['position', width, height, config]);
            return position;
        }
    });

    assert.equal(context.originalImageData, clonedImageData);
    assert.equal(context.alpha48, alpha48);
    assert.equal(context.alpha96, alpha96);
    assert.deepEqual(context.alphaGainCandidates, [0.8, 1]);
    assert.deepEqual(context.alphaPriorityGains, [1]);
    assert.equal(context.allowAdaptiveSearch, false);
    assert.equal(context.defaultConfig, defaultConfig);
    assert.equal(context.resolvedConfig, resolvedConfig);
    assert.equal(context.position, position);
    assert.deepEqual(calls, [
        ['clone', sourceImageData],
        ['detect', 200, 100],
        ['resolve', {
            imageData: clonedImageData,
            defaultConfig,
            alpha48,
            alpha96
        }],
        ['position', 200, 100, resolvedConfig]
    ]);
});

test('createInitialPipelineContext should keep adaptive search on by default', () => {
    const context = createInitialPipelineContext({
        imageData: { width: 10, height: 10, data: new Uint8ClampedArray(400) },
        options: {
            alpha48: new Float32Array(48 * 48),
            alpha96: new Float32Array(96 * 96)
        },
        cloneImageData: (imageData) => imageData,
        detectConfig: () => ({ logoSize: 48, marginRight: 32, marginBottom: 32 }),
        resolveConfig: ({ defaultConfig }) => defaultConfig,
        calculatePosition: () => ({ x: 0, y: 0, width: 48, height: 48 })
    });

    assert.equal(context.allowAdaptiveSearch, true);
});

test('createInitialPipelineContext should preserve missing alpha validation', () => {
    assert.throws(
        () => createInitialPipelineContext({
            imageData: { width: 10, height: 10, data: new Uint8ClampedArray(400) },
            options: {
                alpha48: new Float32Array(48 * 48)
            },
            cloneImageData: (imageData) => imageData
        }),
        /processWatermarkImageData requires alpha48 and alpha96/
    );
});
