import test from 'node:test';
import assert from 'node:assert/strict';

import { hasImportedBinding, loadModuleSource } from '../testUtils/moduleStructure.js';

test('app should not depend on Gemini original-source validation helpers', () => {
    const appSource = loadModuleSource('../../src/app.js', import.meta.url);

    assert.equal(hasImportedBinding(appSource, './utils.js', 'checkOriginal'), false);
    assert.equal(hasImportedBinding(appSource, './utils.js', 'getOriginalStatus'), false);
    assert.equal(hasImportedBinding(appSource, './utils.js', 'resolveOriginalValidation'), false);
    assert.equal(appSource.includes('checkOriginal('), false);
    assert.equal(appSource.includes('getOriginalStatus('), false);
    assert.equal(appSource.includes('resolveOriginalValidation('), false);
});
