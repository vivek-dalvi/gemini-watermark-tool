import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAllenkBinaryPriorCoverage,
    createAllenkVideoBinaryAnalysisReport,
    parseAllenkVideoDisassemblyHints,
    parseAllenkVideoBinaryHints
} from '../../scripts/create-allenk-video-binary-analysis.js';

const SAMPLE_STRINGS = `
Veo alpha maps: 720p={}x{}, 1080p={}x{}
1080p standard (seed-only)
1080p landscape relocated (seed-only)
1080p portrait (seed-only)
1080p portrait relocated (seed-only)
720p-1 standard (per-frame adaptive)
720p-1 portrait (per-frame adaptive)
720p-1 portrait relocated (per-frame adaptive)
720p-2 compact (per-frame adaptive)
720p-2 compact portrait (per-frame adaptive)
smart-search relocated 1080-class (seed-only)
smart-search relocated 720-class (seed-only)
--variant 720p-1   (48x48 diamond, low-bitrate tier)
--variant 720p-2   (44x44 diamond, high-bitrate tier)
For pre-Gemini-3.5 "Veo" text watermarks, try --legacy.
{}: Veo-text removal supports 720p only ({}x{} given)
Veo text: region ({},{}) {}x{} (mean NCC {:.2f})
Video profile override (advanced): auto (default), 720p-1, 720p-2 [experimental]
Watermark type: auto (default), diamond (Gemini 3.5), veo (new small 'Veo' text)
process_video_diamond
process_video_veo_text
`;

test('parseAllenkVideoBinaryHints should extract binary-backed video variant names', () => {
    const hints = parseAllenkVideoBinaryHints(SAMPLE_STRINGS);

    assert.deepEqual(hints.diamondVariants.map((variant) => variant.id), [
        'allenk-binary-video-1080p-standard',
        'allenk-binary-video-1080p-landscape-relocated',
        'allenk-binary-video-1080p-portrait',
        'allenk-binary-video-1080p-portrait-relocated',
        'allenk-binary-video-720p-1-standard',
        'allenk-binary-video-720p-1-portrait',
        'allenk-binary-video-720p-1-portrait-relocated',
        'allenk-binary-video-720p-2-compact',
        'allenk-binary-video-720p-2-compact-portrait'
    ]);
    assert.deepEqual(hints.smartSearchClasses.map((item) => item.id), [
        'allenk-binary-video-smart-search-1080-class-relocated',
        'allenk-binary-video-smart-search-720-class-relocated'
    ]);
    assert.deepEqual(hints.diamondVariants.find((variant) => variant.id === 'allenk-binary-video-720p-1-standard'), {
        id: 'allenk-binary-video-720p-1-standard',
        sourceLevel: 'binary-string',
        tier: '720p-1',
        orientation: 'landscape',
        placement: 'standard',
        adaptation: 'per-frame adaptive',
        logoSize: 48,
        bitrateTier: 'low-bitrate'
    });
});

test('parseAllenkVideoBinaryHints should extract CLI options and Veo text constraints', () => {
    const hints = parseAllenkVideoBinaryHints(SAMPLE_STRINGS);

    assert.deepEqual(hints.cliOptions.map((option) => option.name), [
        '--legacy',
        '--variant'
    ]);
    assert.deepEqual(hints.watermarkTypes.map((type) => type.id), [
        'diamond',
        'veo-text'
    ]);
    assert.equal(hints.veoText.sourceLevel, 'binary-string');
    assert.equal(hints.veoText.supportedTier, '720p-only');
    assert.equal(hints.veoText.processFunction, 'process_video_veo_text');
});

test('createAllenkVideoBinaryAnalysisReport should summarize binary string evidence without claiming exact margins', () => {
    const report = createAllenkVideoBinaryAnalysisReport({
        stringsText: SAMPLE_STRINGS,
        releaseTag: 'v0.6.3-demo',
        zipSha256: 'f1544edff72b7f20bda25b79bcc9cc6d1ba57c49e9fc5f9b28d1b645706f1731',
        exeSha256: 'b149a693647467b520a93af636b0a2c2ebc1dd94a6d9ee4a07088cf6e3342738'
    });

    assert.equal(report.summary.diamondVariantHints, 9);
    assert.equal(report.summary.smartSearchHints, 2);
    assert.equal(report.summary.veoTextSupportedTier, '720p-only');
    assert.equal(report.recommendation, 'treat-binary-strings-as-priors-until-geometry-is-verified');
    assert.equal(report.evidence.zipSha256, 'f1544edff72b7f20bda25b79bcc9cc6d1ba57c49e9fc5f9b28d1b645706f1731');
    assert.ok(
        report.limitations.includes('variant names do not expose exact x/y margins in strings'),
        'binary strings should not be treated as exact geometry'
    );
});

test('parseAllenkVideoDisassemblyHints should extract conservative search-behavior hints', () => {
    const disassemblyText = `
       140202d50: 41 83 ff 10           cmp    $0x10,%r15d
       140202e89: 41 83 c7 04           add    $0x4,%r15d
       140203ca3: 41 be fc ff ff ff     mov    $0xfffffffc,%r14d
       140203cb0: bb fc ff ff ff        mov    $0xfffffffc,%ebx
       140203e27: 83 fb 04              cmp    $0x4,%ebx
       140203e33: 41 83 fe 04           cmp    $0x4,%r14d
       1402035f3: 83 fe 03              cmp    $0x3,%esi
       140203600: 8d 04 36              lea    (%rsi,%rsi,1),%eax
       140203603: 41 3b c7              cmp    %r15d,%eax
       140203fa1: 48 8d 1d 90 49 04 02  lea    0x2044990(%rip),%rbx        # 0x142248938
       140203fa8: 83 ff 3c              cmp    $0x3c,%edi
    `;

    const hints = parseAllenkVideoDisassemblyHints(disassemblyText);

    assert.equal(hints.sourceLevel, 'binary-disassembly');
    assert.equal(hints.candidateSizeSweep.minCandidateSize, 16);
    assert.equal(hints.candidateSizeSweep.step, 4);
    assert.equal(hints.localRefinement.offsetRadius, 4);
    assert.equal(hints.frameConsistency.minSupportingFrames, 3);
    assert.equal(hints.frameConsistency.consensusRule, 'supportingFrames * 2 >= totalFrames');
    assert.equal(hints.smartSearchClassSwitch.immediate, 60);
    assert.equal(hints.interpretationSafety, 'behavioral-hints-only');
});

test('createAllenkBinaryPriorCoverage should compare binary priors against local candidate coverage', () => {
    const binaryHints = parseAllenkVideoBinaryHints(SAMPLE_STRINGS);
    const coverage = createAllenkBinaryPriorCoverage({
        binaryHints,
        resolveCandidates: (width, height) => {
            if (width === 1080 && height === 1920) {
                return [
                    { id: 'veo-1080x1920-portrait-72', size: 72, sourceFamily: 'binary-prior' },
                    { id: 'veo-1080x1920-portrait-relocated-72', size: 72, sourceFamily: 'binary-prior' }
                ];
            }
            if (width === 1280 && height === 720) {
                return [
                    { id: 'veo-720p-1-standard', size: 48, sourceFamily: 'reference-projected' },
                    { id: 'veo-720p-2-compact', size: 44, sourceFamily: 'exact-size-exception' }
                ];
            }
            if (width === 720 && height === 1280) {
                return [
                    { id: 'veo-720x1280-portrait-48', size: 48, sourceFamily: 'binary-prior' },
                    { id: 'veo-720x1280-portrait-relocated-48', size: 48, sourceFamily: 'exact-size-exception' },
                    { id: 'veo-720x1280-vertical-inset', size: 35, sourceFamily: 'exact-size-exception' },
                    { id: 'veo-720x1280-compact-44', size: 44, sourceFamily: 'binary-prior' }
                ];
            }
            return [];
        }
    });

    assert.deepEqual(
        coverage
            .filter((item) => item.variantId.includes('1080p-portrait'))
            .map((item) => ({
                variantId: item.variantId,
                matchingCandidateIds: item.matchingCandidateIds,
                status: item.status
            })),
        [
            {
                variantId: 'allenk-binary-video-1080p-portrait',
                matchingCandidateIds: ['veo-1080x1920-portrait-72'],
                status: 'covered-by-local-candidate'
            },
            {
                variantId: 'allenk-binary-video-1080p-portrait-relocated',
                matchingCandidateIds: ['veo-1080x1920-portrait-relocated-72'],
                status: 'covered-by-local-candidate'
            }
        ]
    );

    assert.deepEqual(
        coverage
            .filter((item) => item.variantId.includes('720p'))
            .map((item) => ({
                variantId: item.variantId,
                expectedSize: item.expectedResolution,
                expectedLogoSize: item.expectedLogoSize,
                status: item.status,
                matchingCandidateIds: item.matchingCandidateIds,
                placementCandidateIds: item.placementCandidateIds
            })),
        [
            {
                variantId: 'allenk-binary-video-720p-1-standard',
                expectedSize: '1280x720',
                expectedLogoSize: 48,
                status: 'covered-by-local-candidate',
                matchingCandidateIds: ['veo-720p-1-standard'],
                placementCandidateIds: ['veo-720p-1-standard']
            },
            {
                variantId: 'allenk-binary-video-720p-1-portrait',
                expectedSize: '720x1280',
                expectedLogoSize: 48,
                status: 'covered-by-local-candidate',
                matchingCandidateIds: ['veo-720x1280-portrait-48'],
                placementCandidateIds: ['veo-720x1280-portrait-48']
            },
            {
                variantId: 'allenk-binary-video-720p-1-portrait-relocated',
                expectedSize: '720x1280',
                expectedLogoSize: 48,
                status: 'covered-with-local-confirmed-candidate',
                matchingCandidateIds: ['veo-720x1280-portrait-relocated-48'],
                placementCandidateIds: ['veo-720x1280-portrait-relocated-48', 'veo-720x1280-vertical-inset']
            },
            {
                variantId: 'allenk-binary-video-720p-2-compact',
                expectedSize: '1280x720',
                expectedLogoSize: 44,
                status: 'covered-with-local-confirmed-candidate',
                matchingCandidateIds: ['veo-720p-2-compact'],
                placementCandidateIds: ['veo-720p-2-compact']
            },
            {
                variantId: 'allenk-binary-video-720p-2-compact-portrait',
                expectedSize: '720x1280',
                expectedLogoSize: 44,
                status: 'covered-by-local-candidate',
                matchingCandidateIds: ['veo-720x1280-compact-44'],
                placementCandidateIds: ['veo-720x1280-compact-44']
            }
        ]
    );
});
