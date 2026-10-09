import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    DEFAULT_CASE_ID,
    DEFAULT_OUTPUT_DIR,
    parseArgs
} from '../../scripts/export-allenk-fdncnn-onnx-frame-video.js';

test('parseArgs should accept allenk ONNX frame video export options', () => {
    const args = parseArgs([
        '--case', 'deaee69b',
        '--output-dir', 'out',
        '--duration', '2',
        '--fps', '24',
        '--sigma', '75',
        '--padding', '16',
        '--strength', '0.25',
        '--crf', '10',
        '--preset', 'medium',
        '--skip-denoise',
        '--execution-provider', 'wasm'
    ]);

    assert.equal(args.caseId, 'deaee69b');
    assert.equal(args.outputDir, path.resolve('out'));
    assert.equal(args.duration, 2);
    assert.equal(args.fps, 24);
    assert.equal(args.sigma, 75);
    assert.equal(args.padding, 16);
    assert.equal(args.strength, 0.25);
    assert.equal(args.crf, 10);
    assert.equal(args.preset, 'medium');
    assert.equal(args.skipDenoise, true);
    assert.equal(args.executionProvider, 'wasm');
    assert.equal(DEFAULT_CASE_ID, '4d420881');
    assert.equal(DEFAULT_OUTPUT_DIR, path.resolve('.artifacts/allenk-fdncnn/video-frame-export'));
});
