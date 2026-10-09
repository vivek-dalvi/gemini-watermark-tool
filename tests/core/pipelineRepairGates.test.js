import test from 'node:test';
import assert from 'node:assert/strict';

import * as repairGates from '../../src/core/pipelineRepairGates.js';

import {
    createRepairCleanupFlags,
    isKnown48AnchorConfig,
    isV2SmallAnchorConfig,
    shouldUseKnown48EdgeCleanup,
    shouldUsePreviewAnchorFastCleanup,
    shouldUseV2SmallEdgeCleanup
} from '../../src/core/pipelineRepairGates.js';

test('shouldUsePreviewAnchorFastCleanup should accept preview anchors in size range', () => {
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 27 }
    ), true);
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 34 }
    ), false);
    assert.equal(shouldUsePreviewAnchorFastCleanup(
        { provenance: { previewAnchor: true } },
        { width: 40 }
    ), false);
});

test('known 48 cleanup gate should accept canonical and large-margin anchors', () => {
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 32, marginBottom: 32 }), true);
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 96, marginBottom: 96 }), true);
    assert.equal(isKnown48AnchorConfig({ logoSize: 48, marginRight: 64, marginBottom: 64 }), false);

    assert.equal(shouldUseKnown48EdgeCleanup({
        selectedTrial: {
            config: { logoSize: 48, marginRight: 96, marginBottom: 96 },
            provenance: {}
        },
        position: { width: 48 },
        source: 'standard+catalog'
    }), true);
});

test('known 48 cleanup gate should accept only marked undersized adaptive matches', () => {
    const selectedTrial = {
        config: { logoSize: 40, marginRight: 82, marginBottom: 82 },
        provenance: { adaptive: true, strongUndersizedMatch: true }
    };

    assert.equal(shouldUseKnown48EdgeCleanup({
        selectedTrial,
        position: { width: 40 },
        source: 'adaptive+gain+fine-alpha'
    }), true);

    for (const rejected of [
        {
            selectedTrial: { ...selectedTrial, provenance: { adaptive: true } },
            position: { width: 40 },
            source: 'adaptive'
        },
        { selectedTrial, position: { width: 43 }, source: 'adaptive' },
        { selectedTrial, position: { width: 40 }, source: 'standard' }
    ]) {
        assert.equal(shouldUseKnown48EdgeCleanup(rejected), false);
    }
});

test('strong undersized cleanup gate should require complete adaptive provenance', () => {
    assert.equal(typeof repairGates.shouldUseStrongUndersizedAdaptiveCleanup, 'function');
    const shouldUseStrongUndersizedAdaptiveCleanup =
        repairGates.shouldUseStrongUndersizedAdaptiveCleanup;
    const selectedTrial = {
        config: { logoSize: 40, marginRight: 82, marginBottom: 82 },
        provenance: { adaptive: true, strongUndersizedMatch: true }
    };

    assert.equal(shouldUseStrongUndersizedAdaptiveCleanup({
        selectedTrial,
        position: { width: 40 },
        source: 'adaptive+gain+fine-alpha'
    }), true);

    for (const rejected of [
        {
            selectedTrial: { ...selectedTrial, provenance: { adaptive: true } },
            position: { width: 40 },
            source: 'adaptive'
        },
        {
            selectedTrial: { ...selectedTrial, provenance: { strongUndersizedMatch: true } },
            position: { width: 40 },
            source: 'adaptive'
        },
        {
            selectedTrial: {
                ...selectedTrial,
                provenance: { ...selectedTrial.provenance, previewAnchor: true }
            },
            position: { width: 40 },
            source: 'adaptive'
        },
        { selectedTrial, position: { width: 37 }, source: 'adaptive' },
        { selectedTrial, position: { width: 43 }, source: 'adaptive' },
        { selectedTrial, position: { width: 40 }, source: 'standard' }
    ]) {
        assert.equal(shouldUseStrongUndersizedAdaptiveCleanup(rejected), false);
    }
});

test('known 48 cleanup gate should preserve the marked adaptive refinement band', () => {
    for (const width of [38, 39, 40, 41, 42]) {
        assert.equal(shouldUseKnown48EdgeCleanup({
            selectedTrial: {
                config: { logoSize: width, marginRight: 82, marginBottom: 82 },
                provenance: { adaptive: true, strongUndersizedMatch: true }
            },
            position: { width },
            source: 'adaptive+gain+fine-alpha'
        }), true, `width=${width}`);
    }
});

test('v2 small cleanup gate should require v2 catalog provenance', () => {
    const selectedTrial = {
        config: { logoSize: 36, marginRight: 64, marginBottom: 64, alphaVariant: 'v2' },
        provenance: { catalogFamily: 'gemini-v2-small' }
    };

    assert.equal(isV2SmallAnchorConfig(selectedTrial.config), true);
    assert.equal(shouldUseV2SmallEdgeCleanup({
        selectedTrial,
        position: { width: 36 },
        source: 'standard+catalog'
    }), true);
    assert.equal(shouldUseV2SmallEdgeCleanup({
        selectedTrial: { ...selectedTrial, provenance: {} },
        position: { width: 36 },
        source: 'standard+catalog'
    }), false);
});

test('createRepairCleanupFlags should aggregate cleanup gates', () => {
    const flags = createRepairCleanupFlags({
        selectedTrial: {
            config: { logoSize: 48, marginRight: 32, marginBottom: 32 },
            provenance: {}
        },
        position: { width: 48 },
        source: 'standard'
    });

    assert.deepEqual(flags, {
        usePreviewAnchorFastCleanup: false,
        useKnown48EdgeCleanup: true,
        useStrongUndersizedAdaptiveCleanup: false,
        useV2SmallEdgeCleanup: false
    });
});

test('createRepairCleanupFlags should expose marked undersized adaptive cleanup', () => {
    const flags = createRepairCleanupFlags({
        selectedTrial: {
            config: { logoSize: 40, marginRight: 82, marginBottom: 82 },
            provenance: { adaptive: true, strongUndersizedMatch: true }
        },
        position: { width: 40 },
        source: 'adaptive+gain+fine-alpha'
    });

    assert.deepEqual(flags, {
        usePreviewAnchorFastCleanup: false,
        useKnown48EdgeCleanup: true,
        useStrongUndersizedAdaptiveCleanup: true,
        useV2SmallEdgeCleanup: false
    });
});
