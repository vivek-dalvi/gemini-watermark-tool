import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createSweepSummary,
    parseCliArgs,
    parseSweepVariantSpec
} from '../../scripts/sweep-veo-text-cleanup.js';

test('parseSweepVariantSpec should parse cleanup sweep overrides', () => {
    assert.deepEqual(
        parseSweepVariantSpec('pad24:sigma=75,padding=24,edge=1.2,residual=0.4,alpha=1.256'),
        {
            id: 'pad24',
            label: 'pad24',
            denoiseBackend: 'allenk-fdncnn-browser-spike',
            alphaGain: 1.256,
            sigma: 75,
            padding: 24,
            edgeDenoiseStrength: 1.2,
            residualCleanupStrength: 0.4
        }
    );
});

test('parseCliArgs should accept repeated cleanup sweep variants', () => {
    const parsed = parseCliArgs([
        '--input',
        'sample.mp4',
        '--output-dir',
        '.artifacts/custom-sweep',
        '--timestamps',
        '1,2,4',
        '--variant',
        'pad32:sigma=75,padding=32,edge=1.8,residual=0.4,alpha=1.0',
        '--variant',
        'pad16:sigma=75,padding=16,edge=1.8,residual=0.4,alpha=1.35',
        '--reference',
        'allenk.mp4',
        '--skip-export'
    ]);

    assert.equal(parsed.inputPath, 'sample.mp4');
    assert.equal(parsed.outputDir, '.artifacts/custom-sweep');
    assert.deepEqual(parsed.timestamps, [1, 2, 4]);
    assert.equal(parsed.referencePath, 'allenk.mp4');
    assert.equal(parsed.skipExport, true);
    assert.deepEqual(parsed.variants.map((variant) => variant.id), ['pad32', 'pad16']);
    assert.deepEqual(parsed.variants.map((variant) => variant.alphaGain), [1.0, 1.35]);
});

test('createSweepSummary should rank variants by mean NCC', () => {
    const rows = [
        { video: 'a', ncc: 0.2 },
        { video: 'a', ncc: 0.4 },
        { video: 'b', ncc: -0.1 },
        { video: 'b', ncc: 0.1 }
    ];
    const summary = createSweepSummary(rows, [
        { id: 'a', label: 'Variant A' },
        { id: 'b', label: 'Variant B' }
    ]);

    assert.deepEqual(summary.sorted.map(([id]) => id), ['b', 'a']);
    assert.ok(Math.abs(summary.byVideo.a.meanNcc - 0.3) < 1e-9);
    assert.equal(summary.byVideo.b.meanNcc, 0);
});
