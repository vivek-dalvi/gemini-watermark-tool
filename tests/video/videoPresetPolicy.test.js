import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getAutomaticVideoPresetConfig,
    getRelocatedReviewPresetConfig,
    getStandardAutoPresetConfig,
    isRelocatedVideoWatermarkPosition,
    shouldUseRelocatedReviewPreset
} from '../../src/video/videoPresetPolicy.js';
import { VIDEO_DENOISE_BACKENDS } from '../../src/video/videoCleanupBackends.js';

test('isRelocatedVideoWatermarkPosition should identify inset video anchors', () => {
    assert.equal(isRelocatedVideoWatermarkPosition({
        width: 72,
        marginRight: 144,
        marginBottom: 144
    }), true);
    assert.equal(isRelocatedVideoWatermarkPosition({
        width: 72,
        marginRight: 108,
        marginBottom: 108
    }), false);
    assert.equal(isRelocatedVideoWatermarkPosition({
        x: 1704,
        y: 864,
        width: 72,
        height: 72,
        videoWidth: 1920,
        videoHeight: 1080
    }), true);
});

test('shouldUseRelocatedReviewPreset should require confident relocated detection', () => {
    const position = { width: 72, marginRight: 144, marginBottom: 144 };

    assert.equal(shouldUseRelocatedReviewPreset({ isConfident: true, position }), true);
    assert.equal(shouldUseRelocatedReviewPreset({ isConfident: false, position }), false);
    assert.equal(shouldUseRelocatedReviewPreset({ isConfident: true, position: null }), false);
    assert.equal(shouldUseRelocatedReviewPreset({
        isConfident: true,
        position: { x: 1704, y: 864, width: 72, height: 72 },
        summary: { best: { id: 'veo-1080p-inset', label: '1080p inset, 72px, margin 144' } }
    }, { width: 1920, height: 1080 }), true);
});

test('getRelocatedReviewPresetConfig should keep relocated anchors on the footprint polish path', () => {
    assert.deepEqual({
        label: getRelocatedReviewPresetConfig().label,
        denoiseBackend: getRelocatedReviewPresetConfig().denoiseBackend,
        edgeDenoiseStrength: getRelocatedReviewPresetConfig().edgeDenoiseStrength,
        residualCleanupStrength: getRelocatedReviewPresetConfig().residualCleanupStrength,
        videoBitrateMbps: getRelocatedReviewPresetConfig().videoBitrateMbps,
        allowLowConfidence: getRelocatedReviewPresetConfig().allowLowConfidence
    }, {
        label: 'AI 自动处理',
        denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH,
        edgeDenoiseStrength: 1,
        residualCleanupStrength: 1.2,
        videoBitrateMbps: 12,
        allowLowConfidence: true
    });
});

test('getAutomaticVideoPresetConfig should keep normal detections on conservative auto settings', () => {
    const preset = getAutomaticVideoPresetConfig({
        isConfident: true,
        position: { width: 72, marginRight: 72, marginBottom: 72 }
    }, { width: 1920, height: 1080 });

    assert.equal(preset.id, 'standard-auto');
    assert.equal(preset.denoiseBackend, VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE);
    assert.equal(preset.edgeDenoiseStrength, 1.8);
    assert.equal(preset.residualCleanupStrength, 0.4);
    assert.deepEqual(preset, getStandardAutoPresetConfig());
});

test('getAutomaticVideoPresetConfig should tune cleanup for Veo text detections', () => {
    const preset = getAutomaticVideoPresetConfig({
        isConfident: true,
        watermarkKind: 'veo-text',
        position: { width: 23, height: 10, marginRight: 15, marginBottom: 16 }
    }, { width: 720, height: 1280 });

    assert.equal(preset.id, 'veo-text-auto');
    assert.equal(preset.denoiseBackend, VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE);
    assert.equal(preset.edgeDenoiseStrength, 1.45);
    assert.equal(preset.residualCleanupStrength, 0.9);
    assert.equal(preset.allowLowConfidence, false);
});

test('getAutomaticVideoPresetConfig should switch relocated detections to review preset', () => {
    const preset = getAutomaticVideoPresetConfig({
        isConfident: true,
        position: { width: 72, marginRight: 144, marginBottom: 144 }
    }, { width: 1920, height: 1080 });

    assert.equal(preset.id, 'relocated-review');
    assert.equal(preset.denoiseBackend, VIDEO_DENOISE_BACKENDS.CANVAS_FOOTPRINT_POLISH);
});
