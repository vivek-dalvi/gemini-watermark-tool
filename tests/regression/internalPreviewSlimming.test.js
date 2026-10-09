import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { hasImportedBinding, loadModuleSource } from '../testUtils/moduleStructure.js';

function readRepoText(relativePath) {
    return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('internal preview app should keep lightweight batch processing without retired zip dependency', () => {
    const appSource = loadModuleSource('../../src/app.js', import.meta.url);

    assert.equal(hasImportedBinding(appSource, 'jszip', 'default'), false);
    assert.equal(hasImportedBinding(appSource, 'medium-zoom', 'default'), false);
    assert.equal(appSource.includes('async function downloadAll('), false);
    assert.equal(appSource.includes('downloadAllBtn'), false);
    assert.equal(appSource.includes('function createImageCard('), true);
    assert.equal(appSource.includes('async function processQueue('), true);
    assert.equal(appSource.includes('multiPreview'), true);
    assert.equal(appSource.includes('imageList'), true);
    assert.equal(appSource.includes('batch-comparison'), true);
    assert.equal(appSource.includes('batch-pane original'), true);
    assert.equal(appSource.includes('batch-pane processed'), true);
    assert.equal(appSource.includes('id="original-${item.id}"'), true);
    assert.equal(appSource.includes('id="processed-${item.id}"'), true);
});

test('internal preview app should not keep runtime i18n or dark-mode wiring', () => {
    const appSource = loadModuleSource('../../src/app.js', import.meta.url);

    assert.equal(hasImportedBinding(appSource, './i18n.js', 'default'), false);
    assert.equal(appSource.includes('function setupLanguageSwitch('), false);
    assert.equal(appSource.includes('function setupDarkMode('), false);
    assert.equal(appSource.includes("document.getElementById('langSwitch')"), false);
    assert.equal(appSource.includes("document.getElementById('themeToggle')"), false);
    assert.equal(appSource.includes('i18n.t('), false);
    assert.equal(appSource.includes('dark:bg-'), false);
});

test('package should not keep retired preview-only browser dependencies', () => {
    const packageJson = JSON.parse(readRepoText('package.json'));

    assert.equal(packageJson.dependencies?.jszip, undefined);
    assert.equal(packageJson.dependencies?.['medium-zoom'], undefined);
});
