import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getDebugFileKind,
    pickDebugUploadFile
} from '../../src/shared/debugFileHandoff.js';

test('getDebugFileKind should classify supported image and video files', () => {
    assert.equal(getDebugFileKind({ name: 'sample.png', type: 'image/png' }), 'image');
    assert.equal(getDebugFileKind({ name: 'sample.webp', type: '' }), 'image');
    assert.equal(getDebugFileKind({ name: 'clip.mp4', type: 'video/mp4' }), 'video');
    assert.equal(getDebugFileKind({ name: 'clip.mov', type: '' }), 'video');
    assert.equal(getDebugFileKind({ name: 'notes.txt', type: 'text/plain' }), null);
});

test('pickDebugUploadFile should prefer video when mixed media is dropped', () => {
    const image = { name: 'sample.png', type: 'image/png' };
    const video = { name: 'clip.mp4', type: 'video/mp4' };

    assert.equal(pickDebugUploadFile([image, video]), video);
    assert.equal(pickDebugUploadFile([image]), image);
    assert.equal(pickDebugUploadFile([{ name: 'notes.txt', type: 'text/plain' }]), null);
});
