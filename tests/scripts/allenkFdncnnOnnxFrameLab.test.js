import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
    DEFAULT_OUTPUT_DIR,
    parseArgs
} from '../../scripts/run-allenk-fdncnn-onnx-frame-lab.js';

test('parseArgs should accept allenk ONNX frame lab options', () => {
    const args = parseArgs([
        '--manifest', 'm.json',
        '--output-dir', 'out',
        '--cases', 'a,b',
        '--timestamps', '1,3',
        '--sigma', '75',
        '--padding', '0',
        '--strength', '0.9',
        '--execution-provider', 'wasm'
    ]);

    assert.equal(args.manifest, path.resolve('m.json'));
    assert.equal(args.outputDir, path.resolve('out'));
    assert.deepEqual(args.cases, ['a', 'b']);
    assert.equal(args.timestamps, '1,3');
    assert.equal(args.sigma, 75);
    assert.equal(args.padding, 0);
    assert.equal(args.edgeDenoiseStrength, 0.9);
    assert.equal(args.executionProvider, 'wasm');
    assert.equal(DEFAULT_OUTPUT_DIR, path.resolve('.artifacts/allenk-fdncnn/onnx-frame-lab'));
});
