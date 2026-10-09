import test from 'node:test';
import assert from 'node:assert/strict';

import {
    VEO_TEXT_TEMPLATE_IDS,
    getVeoTextTemplateAlphaMap,
    getVeoTextTemplateMetadata,
    getVeoTextWatermarkTemplates
} from '../../src/video/veoTextWatermarkTemplates.js';

test('Veo text templates expose Allenk-derived dimensions and anchors', () => {
    const templates = getVeoTextWatermarkTemplates();

    assert.deepEqual(templates.map((template) => template.id), VEO_TEXT_TEMPLATE_IDS);
    assert.deepEqual(
        templates.map((template) => [template.width, template.height]),
        [[23, 10], [68, 30], [99, 43]]
    );

    const small = getVeoTextTemplateMetadata('veo-text-23x10');
    assert.equal(small.marginRight, 15);
    assert.equal(small.marginBottom, 16);
    assert.deepEqual(small.allenkObservedRegion, {
        x: 682,
        y: 1254,
        width: 23,
        height: 10
    });
});

test('Veo text templates keep Allenk observed sigma separate from browser runtime sigma', () => {
    const small = getVeoTextTemplateMetadata('veo-text-23x10');

    assert.equal(small.cleanup.allenkObservedFdncnnSigma, 20);
    assert.equal(small.cleanup.runtimeFdncnnSigma, 90);
    assert.equal(small.cleanup.allenkFdncnnPadding, 32);
});

test('Veo text alpha maps are bounded and match template area', () => {
    for (const template of getVeoTextWatermarkTemplates()) {
        const alphaMap = getVeoTextTemplateAlphaMap(template.id);
        assert.equal(alphaMap.length, template.width * template.height);
        assert.ok(alphaMap.every((value) => Number.isFinite(value) && value >= 0 && value <= 0.99));
        assert.ok(Math.max(...alphaMap) > 0.05);
    }
});
