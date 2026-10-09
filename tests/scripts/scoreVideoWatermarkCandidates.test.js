import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import sharp from 'sharp';

import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from '../../src/core/adaptiveDetector.js';
import { getVideoAlphaMap } from '../../src/video/videoWatermarkDetector.js';
import { resolveVideoWatermarkCandidates } from '../../src/video/videoWatermarkCatalog.js';
import * as videoCandidateScoreScript from '../../scripts/score-video-watermark-candidates.js';

const {
    classifyCatalogRecommendation,
    createGridSearchRanges,
    summarizeCandidateScores,
    summarizeGridSearch
} = videoCandidateScoreScript;

const CATALOG_FIXTURE_CROP = Object.freeze({
    sourceWidth: 1280,
    sourceHeight: 720,
    left: 1040,
    top: 480
});

const VERTICAL_CATALOG_FIXTURE_CROP = Object.freeze({
    sourceWidth: 720,
    sourceHeight: 1280,
    left: 510,
    top: 1060
});

async function decodeFixtureImageData(fileName) {
    const fixturePath = path.resolve('tests/fixtures/video-watermark-catalog', fileName);
    const { data, info } = await sharp(fixturePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function scoreCandidateOnCrop(imageData, candidate, crop = CATALOG_FIXTURE_CROP) {
    const relativeCandidate = {
        ...candidate,
        x: candidate.x - crop.left,
        y: candidate.y - crop.top
    };
    const alphaMap = getVideoAlphaMap(relativeCandidate.size, { candidate: relativeCandidate });
    const region = {
        x: relativeCandidate.x,
        y: relativeCandidate.y,
        size: relativeCandidate.size
    };
    const spatial = computeRegionSpatialCorrelation({ imageData, alphaMap, region });
    const gradient = computeRegionGradientCorrelation({ imageData, alphaMap, region });
    return Math.max(0, spatial) * 0.35 + Math.max(0, gradient) * 0.65;
}

test('summarizeCandidateScores should sort candidates by mean confidence', () => {
    const candidates = [
        { id: 'low', label: 'low candidate', x: 10, y: 10, size: 48 },
        { id: 'high', label: 'high candidate', x: 20, y: 20, size: 48 }
    ];
    const perCandidateFrameScores = new Map([
        ['low', [
            { spatial: 0.1, gradient: 0.1, confidence: 0.1 },
            { spatial: 0.2, gradient: 0.2, confidence: 0.2 }
        ]],
        ['high', [
            { spatial: 0.8, gradient: 0.7, confidence: 0.735 },
            { spatial: 0.7, gradient: 0.8, confidence: 0.765 }
        ]]
    ]);

    const scores = summarizeCandidateScores(candidates, perCandidateFrameScores, {
        width: 1280,
        height: 720
    });

    assert.equal(scores[0].candidateId, 'high');
    assert.equal(scores[0].meanConfidence, 0.75);
    assert.equal(scores[0].marginRight, 1212);
    assert.equal(scores[1].candidateId, 'low');
});

test('vertical video catalog fixture crop should prefer the allenk binary 48px portrait footprint', async () => {
    const candidates = resolveVideoWatermarkCandidates(
        VERTICAL_CATALOG_FIXTURE_CROP.sourceWidth,
        VERTICAL_CATALOG_FIXTURE_CROP.sourceHeight
    );

    const imageData = await decodeFixtureImageData('20260615-3-t4-vertical-crop.png');
    const scored = candidates
        .map((candidate) => ({
            candidateId: candidate.id,
            confidence: scoreCandidateOnCrop(imageData, candidate, VERTICAL_CATALOG_FIXTURE_CROP),
            marginRight: candidate.marginRight,
            marginBottom: candidate.marginBottom,
            size: candidate.size
        }))
        .sort((left, right) => right.confidence - left.confidence);

    assert.equal(scored[0].candidateId, 'veo-720x1280-portrait-relocated-48');
    assert.equal(scored[0].size, 48);
    assert.equal(scored[0].marginRight, 96);
    assert.equal(scored[0].marginBottom, 96);
    assert.ok(
        scored[0].confidence > scored[1].confidence + 0.2,
        'expected binary 48px portrait footprint to clearly outrank bright-core alternatives'
    );
});

test('summarizeGridSearch should keep the strongest grid candidates', () => {
    const summary = summarizeGridSearch([
        { x: 1, y: 1, size: 48, marginRight: 10, marginBottom: 10, meanConfidence: 0.1 },
        { x: 2, y: 2, size: 48, marginRight: 20, marginBottom: 20, meanConfidence: 0.8 },
        { x: 3, y: 3, size: 48, marginRight: 30, marginBottom: 30, meanConfidence: 0.4 }
    ], { limit: 2 });

    assert.deepEqual(
        summary.map((candidate) => ({
            x: candidate.x,
            y: candidate.y,
            meanConfidence: candidate.meanConfidence
        })),
        [
            { x: 2, y: 2, meanConfidence: 0.8 },
            { x: 3, y: 3, meanConfidence: 0.4 }
        ]
    );
});

test('classifyCatalogRecommendation should accept strong matching catalog candidates', () => {
    const recommendation = classifyCatalogRecommendation({
        catalogScores: [
            {
                candidateId: 'veo-720p-3-inset',
                size: 48,
                marginRight: 96,
                marginBottom: 96,
                meanConfidence: 0.72
            }
        ],
        gridScores: [
            {
                size: 48,
                marginRight: 96,
                marginBottom: 96,
                meanConfidence: 0.74
            }
        ]
    });

    assert.deepEqual(recommendation, {
        action: 'catalog-ok',
        reason: 'best-catalog-matches-grid',
        catalogCandidateId: 'veo-720p-3-inset',
        catalogMeanConfidence: 0.72,
        gridMeanConfidence: 0.74,
        suggestedCandidate: null
    });
});

test('classifyCatalogRecommendation should suggest catalog candidate for strong off-catalog grid hit', () => {
    const recommendation = classifyCatalogRecommendation({
        catalogScores: [
            {
                candidateId: 'veo-720p-1-standard',
                size: 48,
                marginRight: 72,
                marginBottom: 72,
                meanConfidence: 0.08
            }
        ],
        gridScores: [
            {
                size: 48,
                marginRight: 96,
                marginBottom: 96,
                meanConfidence: 0.74
            }
        ]
    });

    assert.equal(recommendation.action, 'catalog-gap');
    assert.equal(recommendation.reason, 'grid-stronger-than-catalog');
    assert.deepEqual(recommendation.suggestedCandidate, {
        size: 48,
        marginRight: 96,
        marginBottom: 96
    });
});

test('classifyCatalogRecommendation should accept strong catalog footprints when grid hits a smaller inner core', () => {
    const recommendation = classifyCatalogRecommendation({
        catalogScores: [
            {
                candidateId: 'veo-720x1280-vertical-inset',
                x: 583,
                y: 1149,
                size: 35,
                marginRight: 102,
                marginBottom: 96,
                meanConfidence: 0.289
            }
        ],
        gridScores: [
            {
                x: 584,
                y: 1152,
                size: 24,
                marginRight: 112,
                marginBottom: 104,
                meanConfidence: 0.307
            }
        ]
    });

    assert.deepEqual(recommendation, {
        action: 'catalog-ok',
        reason: 'best-catalog-covers-grid-core',
        catalogCandidateId: 'veo-720x1280-vertical-inset',
        catalogMeanConfidence: 0.289,
        gridMeanConfidence: 0.307,
        suggestedCandidate: null
    });
});

test('createGridSearchRanges should include catalog margins and bounded nearby margins', () => {
    const ranges = createGridSearchRanges({
        width: 1280,
        height: 720,
        candidates: [
            { size: 48, marginRight: 96, marginBottom: 96 },
            { size: 44, marginRight: 29, marginBottom: 40 }
        ],
        step: 8,
        marginPadding: 16
    });

    assert.ok(ranges.sizes.includes(48));
    assert.ok(ranges.sizes.includes(44));
    assert.ok(ranges.marginRights.includes(96));
    assert.ok(ranges.marginBottoms.includes(96));
    assert.ok(ranges.marginRights.every((value) => value >= 8 && value <= 112));
});

test('createGridSearchRanges should include extra binary-prior sizes outside catalog range', () => {
    const ranges = createGridSearchRanges({
        width: 720,
        height: 1280,
        candidates: [
            { size: 35, marginRight: 102, marginBottom: 96 }
        ],
        extraSizes: [44, 48],
        step: 4,
        sizePadding: 0
    });

    assert.ok(ranges.sizes.includes(35));
    assert.ok(ranges.sizes.includes(44));
    assert.ok(ranges.sizes.includes(48));
    assert.ok(ranges.marginRights.includes(102));
    assert.ok(ranges.marginBottoms.includes(96));
});

test('parseCliArgs should enable fail-on-catalog-gap mode', () => {
    assert.equal(typeof videoCandidateScoreScript.parseCliArgs, 'function');
    const parsed = videoCandidateScoreScript.parseCliArgs([
        '--input',
        'sample.mp4',
        '--fail-on-catalog-gap'
    ]);

    assert.equal(parsed.inputPath, 'sample.mp4');
    assert.equal(parsed.failOnCatalogGap, true);
});

test('parseCliArgs should collect extra grid sizes for binary-prior sweeps', () => {
    const parsed = videoCandidateScoreScript.parseCliArgs([
        '--input',
        'portrait.mp4',
        '--grid-size',
        '44',
        '--grid-size',
        '48'
    ]);

    assert.deepEqual(parsed.gridExtraSizes, [44, 48]);
});

test('resolveVideoCandidateScoreExitCode should fail only catalog gaps when requested', () => {
    assert.equal(typeof videoCandidateScoreScript.resolveVideoCandidateScoreExitCode, 'function');
    assert.equal(
        videoCandidateScoreScript.resolveVideoCandidateScoreExitCode({
            recommendation: { action: 'catalog-ok' }
        }, { failOnCatalogGap: true }),
        0
    );
    assert.equal(
        videoCandidateScoreScript.resolveVideoCandidateScoreExitCode({
            recommendation: { action: 'catalog-gap' }
        }, { failOnCatalogGap: true }),
        1
    );
    assert.equal(
        videoCandidateScoreScript.resolveVideoCandidateScoreExitCode({
            recommendation: { action: 'catalog-gap' }
        }, { failOnCatalogGap: false }),
        0
    );
});

test('resolveVideoCandidateScoreExitCode should ignore diamond catalog gaps when Veo text wins', () => {
    assert.equal(
        videoCandidateScoreScript.resolveVideoCandidateScoreExitCode({
            recommendation: { action: 'catalog-gap' },
            selectedWatermarkKind: 'veo-text',
            selectedDetection: {
                watermarkKind: 'veo-text',
                isConfident: true
            }
        }, { failOnCatalogGap: true }),
        0
    );
});

test('video catalog fixture crops should prefer the 720p inset candidate', async () => {
    const candidates = resolveVideoWatermarkCandidates(
        CATALOG_FIXTURE_CROP.sourceWidth,
        CATALOG_FIXTURE_CROP.sourceHeight
    ).filter((candidate) => [
        'veo-720p-1-standard',
        'veo-720p-2-compact',
        'veo-720p-3-inset'
    ].includes(candidate.id));

    assert.deepEqual(
        candidates.map((candidate) => candidate.id).sort(),
        [
            'veo-720p-1-standard',
            'veo-720p-2-compact',
            'veo-720p-3-inset'
        ]
    );

    for (const fixtureName of [
        '20260615-t5-br-crop.png',
        '20260615-2-t4-br-crop.png'
    ]) {
        const imageData = await decodeFixtureImageData(fixtureName);
        const scored = candidates
            .map((candidate) => ({
                candidateId: candidate.id,
                confidence: scoreCandidateOnCrop(imageData, candidate),
                marginRight: candidate.marginRight,
                marginBottom: candidate.marginBottom,
                size: candidate.size
            }))
            .sort((left, right) => right.confidence - left.confidence);

        assert.equal(scored[0].candidateId, 'veo-720p-3-inset', fixtureName);
        assert.equal(scored[0].size, 48);
        assert.equal(scored[0].marginRight, 96);
        assert.equal(scored[0].marginBottom, 96);
        assert.ok(
            scored[0].confidence > scored[1].confidence + 0.2,
            `${fixtureName} expected inset candidate to clearly outrank alternatives`
        );
    }
});
