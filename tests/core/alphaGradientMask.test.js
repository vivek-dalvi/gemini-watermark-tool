import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAlphaGradientMask,
    getAlphaGradientWeight
} from '../../src/core/alphaGradientMask.js';

test('createAlphaGradientMask should emphasize alpha edges over flat centers', () => {
    const size = 21;
    const alphaMap = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - 10;
            const dy = y - 10;
            alphaMap[y * size + x] = Math.sqrt(dx * dx + dy * dy) <= 5 ? 0.7 : 0;
        }
    }

    const mask = createAlphaGradientMask({
        alphaMap,
        width: size,
        height: size,
        dilateRadius: 1,
        blurSigma: 0.5
    });

    assert.equal(mask.length, size * size);
    const center = mask[10 * size + 10];
    const edge = mask[10 * size + 15];
    const outside = mask[0];

    assert.ok(edge > center, `edge=${edge}, center=${center}`);
    assert.ok(edge > outside, `edge=${edge}, outside=${outside}`);
});

test('getAlphaGradientWeight should keep a conservative floor for existing cleanup paths', () => {
    const mask = new Float32Array([0, 0.2, 0.8]);

    assert.equal(getAlphaGradientWeight(mask, 0, 0.35), 0.35);
    assert.equal(getAlphaGradientWeight(mask, 1, 0.35), 0.35);
    assert.ok(Math.abs(getAlphaGradientWeight(mask, 2, 0.35) - 0.8) < 1e-6);
    assert.equal(getAlphaGradientWeight(mask, 99, 0.35), 0.35);
});
