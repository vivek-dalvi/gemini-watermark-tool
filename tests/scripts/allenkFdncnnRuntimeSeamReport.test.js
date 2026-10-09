import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile, rm } from 'node:fs/promises';

import { createAllenkFdncnnRuntimeSeamReport } from '../../scripts/create-allenk-fdncnn-runtime-seam-report.js';

const TEST_TMP_DIR = path.resolve('.artifacts/test-tmp/allenk-runtime-seam');

test.afterEach(async () => {
    await rm(TEST_TMP_DIR, { recursive: true, force: true });
});

test('createAllenkFdncnnRuntimeSeamReport should create frame-lab compatible evidence', async () => {
    const report = await createAllenkFdncnnRuntimeSeamReport({
        outputDir: TEST_TMP_DIR
    });

    assert.equal(report.profile.denoiseBackend, 'allenk-fdncnn-browser-spike');
    assert.equal(report.profile.runtimeStatus, 'applied');
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].runtime.denoiseRuntimeStatus, 'applied');
    assert.equal(report.cases[0].runtime.denoiseRuntime, 'allenk-fdncnn-runtime-seam-fixture');
    assert.equal(report.cases[0].deltas.active.verdict, 'improved');
    assert.equal(report.cases[0].deltas.edge.verdict, 'improved');

    await access(report.cases[0].sheetPath);
    await access(report.cases[0].referencePath);
    await access(report.cases[0].currentPath);
    await access(report.cases[0].variantPath);

    const persisted = JSON.parse(await readFile(report.jsonPath, 'utf8'));
    assert.equal(persisted.profile.syntheticSeamFixture, true);
    assert.match(await readFile(report.markdownPath, 'utf8'), /allenk-fdncnn-browser-spike/);
});
