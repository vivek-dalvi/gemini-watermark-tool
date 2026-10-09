import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';

import {
    calculateMacsForRoi,
    createAllenkFdncnnBrowserSpikeReport,
    renderMarkdown,
    writeReportFiles
} from '../../scripts/create-allenk-fdncnn-browser-spike-report.js';

const TEST_TMP_DIR = path.resolve('.artifacts/test-tmp/allenk-browser-spike');

test.afterEach(async () => {
    await rm(TEST_TMP_DIR, { recursive: true, force: true });
});

function createManifestFixture() {
    return {
        source: '.artifacts/external-repos/GeminiWatermarkTool/external/ncnn/model-convert/output/model_core.mem.h',
        license: 'MIT',
        upstream: 'allenk/GeminiWatermarkTool',
        model: {
            name: 'FDnCNN Color FP16',
            runtime: 'NCNN',
            input: '[R, G, B, sigma] CHW float32',
            output: 'Denoised [R, G, B] CHW float32',
            summary: {
                convolutionLayerCount: 2,
                reluConvolutionLayerCount: 1,
                inputChannels: 4,
                hiddenChannels: 64,
                outputChannels: 3,
                kernel: '3x3'
            },
            param: { path: 'model.param.bin', bytes: 128, sha256: 'p' },
            bin: { path: 'model.bin', bytes: 1172, sha256: 'b' },
            weightLayout: {
                segments: [
                    {
                        inputChannels: 4,
                        outputChannels: 64,
                        kernelW: 3,
                        kernelH: 3
                    },
                    {
                        inputChannels: 64,
                        outputChannels: 3,
                        kernelW: 3,
                        kernelH: 3
                    }
                ]
            }
        }
    };
}

test('calculateMacsForRoi should sum per-layer convolution work', () => {
    const segments = createManifestFixture().model.weightLayout.segments;
    assert.equal(calculateMacsForRoi(segments, 10), 100 * (4 * 64 * 9 + 64 * 3 * 9));
});

test('createAllenkFdncnnBrowserSpikeReport should select a browser GPU spike path', () => {
    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest: createManifestFixture(),
        roiSizes: [10, 100]
    });

    assert.equal(report.model.upstream, 'allenk/GeminiWatermarkTool');
    assert.equal(report.roiEstimates.length, 2);
    assert.equal(report.browserRuntimeCandidates[0].id, 'onnxruntime-web-webgpu');
    assert.equal(report.browserRuntimeCandidates[0].status, 'needs-conversion');
    assert.equal(
        report.browserRuntimeCandidates.find((item) => item.id === 'pure-js-reference')?.status,
        'implemented-debug-only'
    );
    assert.equal(report.decision.selectedNextSpike, 'onnxruntime-web-webgpu');
    assert.equal(report.decision.referenceRuntime, 'allenk-fdncnn-pure-js-reference');
    assert.equal(report.decision.keepCanvasFallback, true);
    assert.equal(report.roiEstimates[1].pureJsRisk, 'medium');
});

test('createAllenkFdncnnBrowserSpikeReport should surface exported ONNX assets', () => {
    const manifest = createManifestFixture();
    manifest.model.onnx = {
        path: '.artifacts/allenk-fdncnn/model_core_fp32_72.onnx',
        bytes: 2679703,
        sha256: 'onnx'
    };

    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest,
        roiSizes: [72]
    });

    assert.equal(report.assets.onnx.path, manifest.model.onnx.path);
    assert.equal(report.browserRuntimeCandidates[0].status, 'prototype-ready');
    assert.match(renderMarkdown(report), /model_core_fp32_72\.onnx/);
});

test('createAllenkFdncnnBrowserSpikeReport should surface ONNX Runtime smoke evidence', () => {
    const manifest = createManifestFixture();
    manifest.model.onnx = {
        path: '.artifacts/allenk-fdncnn/model_core_fp32_72.onnx',
        bytes: 2679703,
        sha256: 'onnx'
    };
    manifest.model.onnxRuntimeSmoke = {
        executionProvider: 'wasm',
        session: { createMs: 198.2 },
        inference: { runMs: 223.5 },
        decision: { onnxRuntimeWebExecutable: true }
    };

    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest,
        roiSizes: [72]
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.assets.onnxRuntimeSmoke.executionProvider, 'wasm');
    assert.equal(report.browserRuntimeCandidates[0].status, 'runtime-smoke-passed');
    assert.match(markdown, /ONNX Runtime smoke: wasm/);
});

test('renderMarkdown should include model, ROI, and decision sections', () => {
    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest: createManifestFixture(),
        roiSizes: [10]
    });
    const markdown = renderMarkdown(report);

    assert.match(markdown, /allenk FDnCNN Browser Spike Report/);
    assert.match(markdown, /onnxruntime-web-webgpu/);
    assert.match(markdown, /Pure JS risk/);
});

test('writeReportFiles should persist json and markdown artifacts', async () => {
    await mkdir(TEST_TMP_DIR, { recursive: true });
    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest: createManifestFixture(),
        roiSizes: [10]
    });
    const output = path.join(TEST_TMP_DIR, 'report.json');
    const markdown = path.join(TEST_TMP_DIR, 'report.md');

    await writeReportFiles(report, { output, markdown });

    const saved = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(saved.decision.selectedNextSpike, 'onnxruntime-web-webgpu');
    assert.match(await readFile(markdown, 'utf8'), /Browser Runtime Candidates/);
});
