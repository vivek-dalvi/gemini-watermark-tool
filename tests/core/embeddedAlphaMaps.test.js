import test from 'node:test';
import assert from 'node:assert/strict';

import { getEmbeddedAlphaMap } from '../../src/core/embeddedAlphaMaps.js';

test('getEmbeddedAlphaMap should expose the allenk V2 36px alpha map', () => {
    const alpha = getEmbeddedAlphaMap('36-v2');

    assert.equal(alpha.length, 36 * 36);
    assert.ok(Math.max(...alpha) > 0.32);
    assert.ok(Math.max(...alpha) < 0.34);
});
