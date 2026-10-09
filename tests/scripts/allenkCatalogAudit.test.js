import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAllenkCatalogAuditReport,
    createCurrentVideoCoverage,
    parseAllenkImageCatalogFromSource,
    parseAllenkVideoPriorsFromReadme
} from '../../scripts/create-allenk-catalog-audit.js';

test('parseAllenkImageCatalogFromSource should extract source-backed V1/V2 image rules', () => {
    const source = `
        if (variant == WatermarkVariant::V1) {
            if (is_large) return {.margin_right = 64, .margin_bottom = 64, .logo_size = 96};
            return {.margin_right = 32, .margin_bottom = 32, .logo_size = 48};
        }
        const int margin = static_cast<int>(std::round(192.0 * scale));
        return WatermarkPosition{.margin_right = margin, .margin_bottom = margin, .logo_size = 36};
        if (is_large) return {.margin_right = 192, .margin_bottom = 192, .logo_size = 96};
    `;

    const catalog = parseAllenkImageCatalogFromSource(source);

    assert.deepEqual(catalog.rules.map((rule) => rule.id), [
        'allenk-image-v1-small',
        'allenk-image-v1-large',
        'allenk-image-v2-small-scaled',
        'allenk-image-v2-large'
    ]);
    assert.equal(catalog.rules[2].logoSize, 36);
    assert.equal(catalog.rules[2].marginRule, 'round(192 * scale)');
});

test('parseAllenkVideoPriorsFromReadme should mark README video specs as priors', () => {
    const readme = `
        - **1080p**: 1920x1080 landscape, 1080x1920 portrait (validated end-to-end)
        - **720p**: 1280x720 landscape, 720x1280 portrait - both **standard** (48x48) and **compact** (44x44) diamond variants
        720p-1 standard (48x48 at margin 72,72)
        720p-2 compact (44x44 at margin 29,40)
    `;

    const priors = parseAllenkVideoPriorsFromReadme(readme);

    assert.deepEqual(priors.knownResolutions.map((item) => item.size), [
        '1920x1080',
        '1080x1920',
        '1280x720',
        '720x1280'
    ]);
    assert.deepEqual(priors.known720pVariants.map((item) => ({
        id: item.id,
        logoSize: item.logoSize,
        marginRight: item.marginRight,
        marginBottom: item.marginBottom
    })), [
        { id: 'allenk-video-720p-1-standard', logoSize: 48, marginRight: 72, marginBottom: 72 },
        { id: 'allenk-video-720p-2-compact', logoSize: 44, marginRight: 29, marginBottom: 40 }
    ]);
    assert.equal(priors.sourceLevel, 'readme-prior');
});

test('createAllenkCatalogAuditReport should separate source-backed rules from priors', () => {
    const report = createAllenkCatalogAuditReport({
        upstreamPath: '<allenk-upstream-root>',
        imageSource: 'WatermarkVariant::V1 logo_size = 48; margin_right = 32; logo_size = 96; margin_right = 64; logo_size = 36; 192.0 * scale; margin_right = 192;',
        videoReadme: '1920x1080 landscape 1080x1920 portrait 1280x720 landscape 720x1280 portrait 720p-1 standard (48x48 at margin 72,72) 720p-2 compact (44x44 at margin 29,40)',
        videoSourceMatches: []
    });

    assert.equal(report.upstreamPath, '<allenk-upstream-root>');
    assert.equal(report.summary.imageSourceBackedRules, 4);
    assert.equal(report.summary.videoSourceFilesFound, 0);
    assert.equal(report.summary.videoReadmePriors, 6);
    assert.equal(report.recommendation, 'use-video-priors-only-after-local-evidence-gate');
});

test('createCurrentVideoCoverage should summarize local candidates for upstream video priors', () => {
    const coverage = createCurrentVideoCoverage({
        videoPriors: {
            knownResolutions: [
                { size: '1280x720', sourceLevel: 'readme-prior' },
                { size: '720x1280', sourceLevel: 'readme-prior' },
                { size: '999x999', sourceLevel: 'readme-prior' }
            ]
        },
        resolveCandidates: (width, height) => {
            if (width === 1280 && height === 720) {
                return [
                    { id: 'veo-720p-3-inset', sourceFamily: 'reference-projected', evidenceGate: 'standard' },
                    { id: 'veo-720p-2-compact', sourceFamily: 'exact-size-exception', evidenceGate: 'required' }
                ];
            }
            if (width === 720 && height === 1280) {
                return [
                    { id: 'veo-720x1280-vertical-inset', sourceFamily: 'exact-size-exception', evidenceGate: 'required' }
                ];
            }
            return [];
        }
    });

    assert.deepEqual(coverage.map((item) => ({
        size: item.size,
        candidateCount: item.candidateCount,
        confirmedCandidateIds: item.confirmedCandidateIds,
        status: item.status
    })), [
        {
            size: '1280x720',
            candidateCount: 2,
            confirmedCandidateIds: ['veo-720p-2-compact'],
            status: 'covered-with-local-confirmed-candidates'
        },
        {
            size: '720x1280',
            candidateCount: 1,
            confirmedCandidateIds: ['veo-720x1280-vertical-inset'],
            status: 'covered-with-local-confirmed-candidates'
        },
        {
            size: '999x999',
            candidateCount: 0,
            confirmedCandidateIds: [],
            status: 'missing-local-candidates'
        }
    ]);
});
