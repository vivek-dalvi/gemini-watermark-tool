import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

function projectUrl(relativePath) {
    return new URL(`../../${relativePath}`, import.meta.url);
}

test('video WebGPU runtime should use asyncify wasm assets', async () => {
    const source = await readFile(projectUrl('src/video-app.js'), 'utf8');

    assert.match(source, /ort-wasm-simd-threaded\.asyncify\.mjs/);
    assert.match(source, /ort-wasm-simd-threaded\.asyncify\.wasm/);
    assert.doesNotMatch(source, /ALLENK_FDNCNN_WEBGPU_WASM_PATHS[\s\S]*?ort-wasm-simd-threaded\.jsep/);
});

test('video WebGPU asyncify runtime assets should be bundled in public', async () => {
    for (const fileName of [
        'ort-wasm-simd-threaded.asyncify.mjs',
        'ort-wasm-simd-threaded.asyncify.wasm'
    ]) {
        const info = await stat(projectUrl(`public/onnxruntime/${fileName}`));
        assert.ok(info.size > 0, `${fileName} should not be empty`);
    }
});

test('video allenk FDnCNN model assets should be bundled in public', async () => {
    for (const fileName of [
        'model_core_fp32_86x74.onnx',
        'model_core_fp32_104.onnx',
        'model_core_fp32_200.onnx'
    ]) {
        const info = await stat(projectUrl(`public/models/allenk-fdncnn/${fileName}`));
        assert.ok(info.size > 0, `${fileName} should not be empty`);
    }
});

test('video app should route allenk FDnCNN through runtime profiles', async () => {
    const source = await readFile(projectUrl('src/video-app.js'), 'utf8');
    const exportSource = await readFile(projectUrl('src/video/videoExport.js'), 'utf8');
    const policySource = await readFile(projectUrl('src/video/videoDenoiseRuntimePolicy.js'), 'utf8');

    assert.match(source, /resolveAllenkFdncnnRuntimeProfile/);
    assert.match(exportSource, /resolveAllenkFdncnnRuntimeProfile/);
    assert.match(exportSource, /resolveExportAllenkFdncnnPadding/);
    assert.match(policySource, /model_core_fp32_86x74\.onnx/);
    assert.match(policySource, /model_core_fp32_104\.onnx/);
    assert.match(policySource, /model_core_fp32_200\.onnx/);
    assert.match(source, /runtimeProfile\.padding/);
    assert.match(source, /runtimePromise\.catch/);
    assert.match(source, /allenkFdncnnRuntimePromises\.delete\(profile\.id\)/);
    assert.doesNotMatch(source, /allenkFdncnnPadding:\s*64/);
    assert.doesNotMatch(exportSource, /allenkFdncnnPadding:\s*64/);
    assert.doesNotMatch(source, /ALLENK_FDNCNN_INPUT_SHAPE/);
    assert.doesNotMatch(source, /ALLENK_FDNCNN_OUTPUT_SHAPE/);
});
