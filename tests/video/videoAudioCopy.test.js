import test from 'node:test';
import assert from 'node:assert/strict';

import {
    Mp4OutputFormat
} from 'mediabunny';

import {
    canCopyAudioCodecToMp4,
    normalizePacketTimestamp
} from '../../src/video/videoExport.js';

test('canCopyAudioCodecToMp4 should accept supported MP4 audio codecs', () => {
    const format = new Mp4OutputFormat();

    assert.equal(canCopyAudioCodecToMp4(format, 'aac'), true);
    assert.equal(canCopyAudioCodecToMp4(format, 'opus'), true);
    assert.equal(canCopyAudioCodecToMp4(format, 'unsupported-codec'), false);
    assert.equal(canCopyAudioCodecToMp4(format, null), false);
});

test('normalizePacketTimestamp should drop packets ending before the export start', () => {
    const packet = {
        timestamp: -0.05,
        duration: 0.02,
        clone() {
            throw new Error('should not clone dropped packets');
        }
    };

    assert.equal(normalizePacketTimestamp(packet, 0), null);
});

test('normalizePacketTimestamp should trim packets that overlap the export start', () => {
    const packet = {
        timestamp: -0.02,
        duration: 0.05,
        clone(options) {
            return {
                ...this,
                ...options
            };
        }
    };

    const normalized = normalizePacketTimestamp(packet, 0);
    assert.equal(normalized.timestamp, 0);
    assert.ok(Math.abs(normalized.duration - 0.03) < 1e-9);
});

test('normalizePacketTimestamp should keep packets after the export start unchanged', () => {
    const packet = {
        timestamp: 0.5,
        duration: 0.02
    };

    assert.equal(normalizePacketTimestamp(packet, 0), packet);
});
