import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

async function exists(filePath) {
    try {
        await access(new URL(filePath, import.meta.url), fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

test('package should expose sdk and runtime public subpaths', async () => {
    const browserSdk = await import('@pilio/gemini-watermark-remover/browser');
    const imageDataSdk = await import('@pilio/gemini-watermark-remover/image-data');
    const nodeSdk = await import('@pilio/gemini-watermark-remover/node');
    const videoSdk = await import('@pilio/gemini-watermark-remover/video');
    const runtimeBrowserSdk = await import('@pilio/gemini-watermark-remover/runtime-browser');
    const runtimeUserscriptSdk = await import('@pilio/gemini-watermark-remover/runtime-userscript');

    assert.equal(typeof browserSdk.removeWatermarkFromImage, 'function');
    assert.equal(typeof browserSdk.createWatermarkEngine, 'function');
    assert.equal(typeof imageDataSdk.removeWatermarkFromImageData, 'function');
    assert.equal(typeof imageDataSdk.removeWatermarkFromImageDataSync, 'function');
    assert.equal(typeof imageDataSdk.createWatermarkEngine, 'function');
    assert.equal(typeof nodeSdk.removeWatermarkFromBuffer, 'function');
    assert.equal(typeof nodeSdk.removeWatermarkFromFile, 'function');
    assert.equal(typeof nodeSdk.removeVideoWatermarkFromFile, 'function');
    assert.equal(typeof videoSdk.removeVideoWatermarkFromFile, 'function');
    assert.equal(typeof videoSdk.removeVideoWatermarkFromBuffer, 'function');
    assert.equal(typeof runtimeBrowserSdk.createBrowserRuntimeProcessor, 'function');
    assert.equal(typeof runtimeUserscriptSdk.createUserscriptRuntimeProcessor, 'function');
});

test('package exports should declare type entrypoints for public sdk surface', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    const exportsMap = packageJson.exports || {};

    assert.equal(typeof exportsMap['.'], 'object');
    assert.equal(typeof exportsMap['./browser'], 'object');
    assert.equal(typeof exportsMap['./image-data'], 'object');
    assert.equal(typeof exportsMap['./node'], 'object');
    assert.equal(typeof exportsMap['./video'], 'object');
    assert.equal(typeof exportsMap['./runtime-browser'], 'object');
    assert.equal(typeof exportsMap['./runtime-userscript'], 'object');
    assert.equal(typeof packageJson.types, 'string');

    assert.equal(await exists('../../src/sdk/index.d.ts'), true);
    assert.equal(await exists('../../src/sdk/browser.d.ts'), true);
    assert.equal(await exists('../../src/sdk/image-data.d.ts'), true);
    assert.equal(await exists('../../src/sdk/node.d.ts'), true);
    assert.equal(await exists('../../src/sdk/video.d.ts'), true);
    assert.equal(await exists('../../src/runtime/browser.d.ts'), true);
    assert.equal(await exists('../../src/runtime/userscript.d.ts'), true);

    assert.equal(exportsMap['./runtime-browser'].types, './src/runtime/browser.d.ts');
    assert.equal(exportsMap['./runtime-browser'].import, './src/runtime/browser.js');
    assert.equal(exportsMap['./runtime-userscript'].types, './src/runtime/userscript.d.ts');
    assert.equal(exportsMap['./runtime-userscript'].import, './src/runtime/userscript.js');
});
