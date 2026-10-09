import test from 'node:test';
import assert from 'node:assert/strict';

import { buildQueues } from '../../scripts/create-metric-mismatch-review-pack.js';

test('buildQueues should include taxonomy metric mismatch records', () => {
    const queues = buildQueues([
        {
            file: 'sample.png',
            taxonomy: {
                metricMismatchCandidate: true,
                mismatchReason: 'low-texture-background-collision'
            },
            production: {
                visible: true,
                balancedCost: 0.28,
                residualCost: 0.23
            },
            bestRemoval: {
                position: {
                    x: 10,
                    y: 20,
                    width: 48,
                    height: 48
                },
                size: 48,
                marginRight: 96,
                marginBottom: 96
            }
        }
    ], 10);

    assert.equal(queues.visible.length, 1);
    assert.equal(queues['taxonomy-mismatch'].length, 1);
    assert.equal(queues['geometry-48-96-96'].length, 1);
});

test('buildQueues should prefer calibrated visibility when present', () => {
    const queues = buildQueues([
        {
            file: 'raw-risk.png',
            taxonomy: {
                metricMismatchCandidate: true
            },
            production: {
                visible: true,
                calibratedVisible: false,
                balancedCost: 0.5,
                residualCost: 0.3
            },
            productionPosition: {
                x: 10,
                y: 20,
                width: 48,
                height: 48
            },
            productionConfig: {
                logoSize: 48,
                marginRight: 96,
                marginBottom: 96
            }
        }
    ], 10);

    assert.equal(queues.visible.length, 0);
    assert.equal(queues['taxonomy-mismatch'].length, 1);
});
