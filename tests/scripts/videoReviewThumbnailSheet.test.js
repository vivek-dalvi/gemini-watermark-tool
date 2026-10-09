import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { createVideoReviewThumbnailSheet } from '../../scripts/create-video-review-thumbnail-sheet.js';

async function writePng(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
}

test('createVideoReviewThumbnailSheet should compose quickstart review thumbnails', async () => {
    const root = path.resolve('.artifacts/test-tmp/video-review-thumbnail-sheet');
    await rm(root, { recursive: true, force: true });
    const quickstartPath = path.join(root, 'quickstart.json');
    const outputPath = path.join(root, 'sheet.png');
    const jsonPath = path.join(root, 'sheet.json');
    const thumbnails = [
        path.join(root, 'thumbs', 'current-full.png'),
        path.join(root, 'thumbs', 'current-roi.png'),
        path.join(root, 'thumbs', 'alpha-full.png'),
        path.join(root, 'thumbs', 'alpha-roi.png')
    ];
    await Promise.all(thumbnails.map(writePng));
    await mkdir(root, { recursive: true });
    await writeFile(quickstartPath, `${JSON.stringify({
        lanes: [
            {
                id: 'current025',
                reviewVideos: [
                    { caseId: 'case-a', kind: 'full', src: path.join(root, 'current-full.mp4'), currentTime: 4, thumbnailPath: thumbnails[0] },
                    { caseId: 'case-a', kind: 'roi', src: path.join(root, 'current-roi.mp4'), currentTime: 4, thumbnailPath: thumbnails[1] }
                ]
            },
            {
                id: 'alphaPolicy035',
                reviewVideos: [
                    { caseId: 'case-b', kind: 'full', src: path.join(root, 'alpha-full.mp4'), currentTime: 4, thumbnailPath: thumbnails[2] },
                    { caseId: 'case-b', kind: 'roi', src: path.join(root, 'alpha-roi.mp4'), currentTime: 4, thumbnailPath: thumbnails[3] }
                ]
            }
        ]
    }, null, 2)}\n`, 'utf8');

    const report = await createVideoReviewThumbnailSheet({
        quickstartPath,
        outputPath,
        jsonPath,
        columns: 2
    });
    const saved = JSON.parse(await readFile(jsonPath, 'utf8'));
    const output = await readFile(outputPath);

    assert.equal(report.thumbnails, 4);
    assert.equal(report.totalVideos, 4);
    assert.equal(report.missingThumbnails, 0);
    assert.equal(report.columns, 2);
    assert.equal(saved.items[0].laneId, 'current025');
    assert.equal(saved.items[3].kind, 'roi');
    assert.equal(output[0], 0x89);
    assert.equal(output[1], 0x50);
    assert.equal(output[2], 0x4e);
    assert.equal(output[3], 0x47);
});
