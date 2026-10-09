import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const MANIFEST_URL = new URL('../fixtures/video-regression-samples/gemini-video-regression-samples.json', import.meta.url);

test('Gemini video regression manifest should pin the real video regression samples', async () => {
    const manifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
    assert.equal(manifest.name, 'gemini-video-regression-samples');
    assert.equal(manifest.inputs.length, 5);

    const expectedCandidates = new Map([
        ['20260615', 'veo-720p-3-inset'],
        ['20260615-2', 'veo-720p-3-inset'],
        ['20260615-3', 'veo-720x1280-portrait-relocated-48'],
        ['veo-20260615', 'veo-text-23x10:682:1254'],
        ['20260619', 'veo-720x1280-portrait-relocated-48']
    ]);

    for (const item of manifest.inputs) {
        assert.match(item.input, /^src\/assets\/video-samples\/(?:20260615|20260619|veo-20260615)/);
        assert.equal(item.candidateId, expectedCandidates.get(item.id));
        assert.deepEqual(item.thresholds, {
            maxAllowedConfidence: 0.08,
            minReductionRatio: 0.75
        });
        assert.ok(item.timestamps.length >= 4);
    }
});
