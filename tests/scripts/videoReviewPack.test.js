import test from 'node:test';
import assert from 'node:assert/strict';

import { renderVideoReviewPackMarkdown } from '../../scripts/create-video-review-pack.js';

test('renderVideoReviewPackMarkdown should include videos checklist and gate evidence', () => {
    const markdown = renderVideoReviewPackMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        deliveryReportPath: 'delivery.json',
        delivery: {
            status: 'ready-for-visual-review',
            ready: true,
            blockers: [],
            benchmark: { total: 4, rendered: 4, failed: 0 },
            bestCandidate: {
                profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                decision: 'promote-default-candidate',
                materialFailureLayers: 0,
                warningLayers: 0,
                improvedCases: 2
            }
        },
        temporal: {
            reportPath: 'temporal/latest-report.json',
            markdownPath: 'temporal/latest-report.md',
            generatedAt: '2026-06-11T00:01:00.000Z',
            matchRadius: 2,
            includeVariants: true,
            cases: [
                {
                    id: 'deaee69b-auto-relocated',
                    sheetPath: 'temporal/deaee69b-auto-relocated-temporal-residual.png',
                    pairCount: 4,
                    meanSameJitter: 2.5,
                    meanMatchedJitter: 2.125,
                    improvement: 0.375,
                    improvedRatio: 0.55,
                    worsenedRatio: 0.12
                }
            ]
        },
        comparisons: [
            {
                caseId: 'deaee69b',
                kind: 'roi',
                outputPath: 'deaee69b-roi-4up.mp4',
                snapshotPath: 'deaee69b-roi-contact.png',
                cropBox: { x: 1676, y: 836, width: 200, height: 200 },
                inputs: [
                    { label: 'original', path: 'original.mp4' },
                    { label: 'auto boundary', path: 'auto.mp4' }
                ],
                probe: {
                    exists: true,
                    video: {
                        width: 640,
                        height: 640,
                        frameRate: '24fps',
                        duration: 10
                    }
                }
            }
        ],
        checklist: ['ROI looks clean']
    });

    assert.match(markdown, /Delivery status: ready-for-visual-review/);
    assert.match(markdown, /deaee69b-roi-4up\.mp4/);
    assert.match(markdown, /deaee69b-roi-contact\.png/);
    assert.match(markdown, /640x640 \/ 24fps \/ 10\.000s/);
    assert.match(markdown, /- \[ \] ROI looks clean/);
    assert.match(markdown, /Gate: material fail layers `0`, warning layers `0`, improved cases `2`/);
    assert.match(markdown, /## Temporal Residual/);
    assert.match(markdown, /deaee69b-auto-relocated/);
    assert.match(markdown, /2\.1250/);
    assert.match(markdown, /Temporal report: `temporal\/latest-report\.json`/);
});
