import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('export-video-backend-variant should report actual UI controls after auto presets', () => {
  const source = readFileSync(new URL('../../scripts/export-video-backend-variant.js', import.meta.url), 'utf8');

  assert.match(source, /collectVideoExportControls/);
  assert.match(source, /setNumericInputValue/);
  assert.match(source, /step: 'any'/);
  assert.match(source, /#alphaGain/);
  assert.doesNotMatch(source, /locator\('#alphaGain'\)\.fill/);
  assert.match(source, /actualDenoiseBackend: actualControls\.denoiseBackend/);
  assert.match(source, /allowLowConfidence/);
  assert.match(source, /__gwrVideoOverrideBitrate/);
  assert.match(source, /withLocalStaticPreviewPage/);
  assert.match(source, /pageUrl/);
});

test('video app should not reset Veo text preset when debug backend override is already selected', () => {
  const source = readFileSync(new URL('../../src/video-app.js', import.meta.url), 'utf8');

  assert.match(source, /window\.__gwrVideoOverrideDenoiseBackend/);
  assert.match(source, /els\.denoiseBackend\.value !== window\.__gwrVideoOverrideDenoiseBackend/);
});
