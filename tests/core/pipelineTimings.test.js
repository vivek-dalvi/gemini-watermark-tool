import test from 'node:test';
import assert from 'node:assert/strict';

import { createTailDebugTimings } from '../../src/core/pipelineTimings.js';

test('createTailDebugTimings should preserve tail timing calculations', () => {
    const nowValues = [1000, 1005, 1010, 1020, 1030];
    const timings = createTailDebugTimings({
        nowMs: () => nowValues.shift(),
        totalStartedAt: 10,
        previewEdgeCleanupElapsedMs: 12,
        smallPreviewRefinementStartedAt: 900,
        locatedAggressiveStartedAt: 800,
        smoothPriorStartedAt: 700,
        newMargin96VariantRescueStartedAt: 100,
        known48AntiTemplateRescueStartedAt: 130,
        powerProfileRescueStartedAt: 170,
        positiveResidualRebalanceStartedAt: 220,
        smallMarginPriorRepairStartedAt: 280,
        smallLocatedPriorRepairStartedAt: 350,
        boundaryRepairRescueStartedAt: 430,
        darkHaloRescueStartedAt: 520,
        quantizedBodyCorrectionStartedAt: 620,
        midCoreBiasStartedAt: 730
    });

    assert.deepEqual(timings, {
        previewEdgeCleanupMs: 12,
        smallPreviewRefinementMs: 100,
        locatedAggressiveRemovalMs: 205,
        smoothPriorCleanupMs: 310,
        newMargin96VariantRescueMs: 30,
        known48AntiTemplateRescueMs: 40,
        powerProfileRescueMs: 50,
        positiveResidualRebalanceMs: 60,
        smallMarginPriorRepairMs: 70,
        smallLocatedPriorRepairMs: 80,
        boundaryRepairRescueMs: 90,
        darkHaloRescueMs: 100,
        quantizedBodyCorrectionMs: 110,
        midCoreBiasCorrectionMs: 290,
        totalMs: 1020
    });
});
