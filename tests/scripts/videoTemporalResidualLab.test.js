import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderTemporalResidualLabMarkdown,
    selectTemporalResidualCases
} from '../../scripts/run-video-temporal-residual-lab.js';

test('renderTemporalResidualLabMarkdown should include jitter summary and sheet path', () => {
    const markdown = renderTemporalResidualLabMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        matchRadius: 2,
        includeVariants: true,
        cases: [
            {
                id: 'case-a',
                sheetPath: '.artifacts/video-temporal-residual-lab/case-a-temporal-residual.png',
                aggregate: {
                    meanSameJitter: 4.125,
                    meanMatchedJitter: 3.5,
                    improvement: 0.625,
                    meanMatchCost: 8.25,
                    improvedRatio: 0.6,
                    worsenedRatio: 0.2
                }
            }
        ]
    });

    assert.match(markdown, /# Video Temporal Residual Lab/);
    assert.match(markdown, /Match radius: 2/);
    assert.match(markdown, /Include variants: yes/);
    assert.match(markdown, /case-a/);
    assert.match(markdown, /4\.1250/);
    assert.match(markdown, /0\.6250/);
    assert.match(markdown, /video-temporal-residual-lab\/case-a-temporal-residual\.png/);
});

test('selectTemporalResidualCases should keep variants only when requested', () => {
    const cases = [
        {
            id: 'baseline',
            referencePath: 'ref.mp4',
            currentPath: 'baseline.mp4',
            tags: ['baseline'],
            currentProfile: { denoiseBackend: 'none' }
        },
        {
            id: 'candidate',
            referencePath: 'ref.mp4',
            currentPath: 'candidate.mp4',
            tags: ['variant'],
            currentProfile: { denoiseBackend: 'canvas-temporal-match-delta-stabilize' }
        },
        {
            id: 'no-reference',
            referencePath: null,
            currentPath: 'current.mp4',
            tags: ['baseline'],
            currentProfile: { denoiseBackend: 'none' }
        }
    ];

    assert.deepEqual(
        selectTemporalResidualCases(cases).map((item) => item.id),
        ['baseline']
    );
    assert.deepEqual(
        selectTemporalResidualCases(cases, { includeVariants: true }).map((item) => item.id),
        ['baseline', 'candidate']
    );
    assert.deepEqual(
        selectTemporalResidualCases(cases, { cases: ['candidate'], includeVariants: true }).map((item) => item.id),
        ['candidate']
    );
});
