import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
    createVideoDeliveryBundleVerification,
    renderVideoDeliveryBundleVerificationMarkdown
} from '../../scripts/verify-video-delivery-bundle.js';

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeText(filePath, value = 'ok\n') {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, 'utf8');
}

async function writePng(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
}

async function createFixture(root, { missingAlphaReview = false } = {}) {
    const acceptedStatuses = [
        'accepted-for-default-review',
        'prefer-current-default-candidate',
        'prefer-light-polish-candidate',
        'prefer-strength018-polish-candidate',
        'prefer-strength022-polish-candidate',
        'prefer-alpha-policy035-candidate'
    ];
    const paths = {
        bundle: path.join(root, 'bundle.json'),
        bundleMd: path.join(root, 'bundle.md'),
        dashboardJson: path.join(root, 'dashboard.json'),
        dashboardHtml: path.join(root, 'dashboard.html'),
        dashboardPng: path.join(root, 'dashboard.png'),
        dashboardScreenshotJson: path.join(root, 'dashboard-screenshot.json'),
        quickstartJson: path.join(root, 'quickstart.json'),
        quickstartMd: path.join(root, 'quickstart.md'),
        quickstartHtml: path.join(root, 'quickstart.html'),
        quickstartPng: path.join(root, 'quickstart.png'),
        quickstartScreenshotJson: path.join(root, 'quickstart-screenshot.json'),
        quickstartThumbnailSheet: path.join(root, 'quickstart-thumbnail-sheet.png'),
        quickstartThumbnailSheetJson: path.join(root, 'quickstart-thumbnail-sheet.json'),
        goalJson: path.join(root, 'goal.json'),
        goalMd: path.join(root, 'goal.md'),
        currentReview: path.join(root, 'current-review.html'),
        alphaReview: path.join(root, 'alpha-review.html'),
        currentTemplate: path.join(root, 'current.template.json'),
        alphaTemplate: path.join(root, 'alpha.template.json'),
        currentDecisionJson: path.join(root, 'current-decision.json'),
        currentDecisionMd: path.join(root, 'current-decision.md'),
        alphaDecisionJson: path.join(root, 'alpha-decision.json'),
        alphaDecisionMd: path.join(root, 'alpha-decision.md'),
        alphaKnownFlawJson: path.join(root, 'alpha-known-flaw.json'),
        alphaRejectedShapeMd: path.join(root, 'alpha-rejected-shape.md'),
        currentVideo: path.join(root, 'current.mp4'),
        currentThumbFull: path.join(root, 'thumbs', 'current-full.png'),
        currentThumbRoi: path.join(root, 'thumbs', 'current-roi.png'),
        alphaVideo: path.join(root, 'alpha.mp4'),
        alphaThumbFull: path.join(root, 'thumbs', 'alpha-full.png'),
        alphaThumbRoi: path.join(root, 'thumbs', 'alpha-roi.png'),
        output: path.join(root, 'verification.json'),
        markdown: path.join(root, 'verification.md')
    };
    for (const file of [
        paths.bundleMd,
        paths.dashboardPng,
        paths.quickstartPng,
        paths.goalJson,
        paths.goalMd,
        paths.currentDecisionJson,
        paths.currentDecisionMd,
        paths.alphaDecisionJson,
        paths.alphaDecisionMd,
        paths.alphaKnownFlawJson,
        paths.alphaRejectedShapeMd,
        paths.currentVideo,
        paths.alphaVideo
    ]) {
        await writeText(file);
    }
    await Promise.all([
        writePng(paths.currentThumbFull),
        writePng(paths.currentThumbRoi),
        writePng(paths.alphaThumbFull),
        writePng(paths.alphaThumbRoi),
        writePng(paths.quickstartThumbnailSheet)
    ]);
    await writeText(paths.dashboardHtml, '<!doctype html><body>Known flaw diagnostics Rejected shape gate</body>\n');
    await writeText(paths.currentReview, `<video src="${path.basename(paths.currentVideo)}"></video>\n`);
    if (!missingAlphaReview) await writeText(paths.alphaReview, `<video src="${path.basename(paths.alphaVideo)}"></video>\n`);
    await writeJson(paths.dashboardScreenshotJson, {
        generatedAt: '2026-06-11T18:08:18.415Z',
        htmlPath: paths.dashboardHtml,
        outputPath: paths.dashboardPng,
        viewport: { width: 1440, height: 1200 },
        documentSize: { scrollWidth: 1440, scrollHeight: 1800, clientWidth: 1440, clientHeight: 1200 },
        fullPage: true
    });
    await writeJson(paths.quickstartScreenshotJson, {
        generatedAt: '2026-06-11T18:08:21.162Z',
        htmlPath: paths.quickstartHtml,
        outputPath: paths.quickstartPng,
        viewport: { width: 1440, height: 1800 },
        documentSize: { scrollWidth: 1440, scrollHeight: 4200, clientWidth: 1440, clientHeight: 1800 },
        fullPage: true
    });
    await writeJson(paths.currentTemplate, {
        template: true,
        templateInstructions: 'Edit decision, notes, and checklist.checked values after human review.',
        templatePath: paths.currentTemplate,
        laneId: 'current025',
        page: pathToFileURL(paths.currentReview).href,
        acceptedStatuses,
        suggestedDecision: 'accept',
        suggestedDecisionOptions: ['accept', 'needs-polish', 'reject'],
        deliveryStatus: 'ready-for-visual-review',
        temporalStatus: 'pass',
        candidate: 'current025',
        videos: [
            { caseId: 'current-case', kind: 'full', src: paths.currentVideo, currentTime: 4 },
            { caseId: 'current-case', kind: 'roi', src: paths.currentVideo, currentTime: 4 }
        ],
        checklist: [
            { index: 0, checked: false, text: 'current review looks acceptable' }
        ]
    });
    await writeJson(paths.alphaTemplate, {
        template: true,
        templateInstructions: 'Edit decision, notes, and checklist.checked values after human review.',
        templatePath: paths.alphaTemplate,
        laneId: 'alphaPolicy035',
        page: pathToFileURL(paths.alphaReview).href,
        acceptedStatuses,
        suggestedDecision: 'prefer-alpha-policy035',
        suggestedDecisionOptions: ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both'],
        deliveryStatus: 'review-only',
        temporalStatus: 'available',
        candidate: 'alphaPolicy035',
        videos: [
            { caseId: 'alpha-case', kind: 'full', src: paths.alphaVideo, currentTime: 4 },
            { caseId: 'alpha-case', kind: 'roi', src: paths.alphaVideo, currentTime: 4 }
        ],
        checklist: [
            { index: 0, checked: false, text: 'alpha review looks acceptable' }
        ]
    });

    const acceptanceLanes = [
        {
            id: 'current025',
            title: 'Current Candidate 0.25',
            complete: false,
            currentStatus: 'needs-polish',
            checklist: { total: 5, checked: 1, unchecked: 4, allChecked: false },
            reviewHtmlPath: paths.currentReview,
            decisionTemplatePath: paths.currentTemplate,
            decisionJsonPath: paths.currentDecisionJson,
            decisionReportPath: paths.currentDecisionMd,
            suggestedDecision: 'accept',
            suggestedDecisionOptions: ['accept', 'needs-polish', 'reject'],
            command: `pnpm report:video-review-decision -- --decision ${paths.currentTemplate} --output ${paths.currentDecisionJson} --markdown ${paths.currentDecisionMd}`
        },
        {
            id: 'alphaPolicy035',
            title: 'Alpha Policy 0.35',
            complete: false,
            currentStatus: 'pending',
            checklist: { total: 5, checked: 0, unchecked: 5, allChecked: false },
            reviewHtmlPath: paths.alphaReview,
            decisionTemplatePath: paths.alphaTemplate,
            decisionJsonPath: paths.alphaDecisionJson,
            decisionReportPath: paths.alphaDecisionMd,
            suggestedDecision: 'prefer-alpha-policy035',
            suggestedDecisionOptions: ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both'],
            command: `pnpm report:video-review-decision -- --decision ${paths.alphaTemplate} --output ${paths.alphaDecisionJson} --markdown ${paths.alphaDecisionMd}`
        }
    ];
    const dashboard = {
        lanes: [
            {
                id: 'current025',
                status: 'ready-for-visual-review',
                temporalStatus: 'pass',
                reviewStatus: 'needs-polish',
                candidateDecision: 'promote-default-candidate',
                comparisons: 4,
                temporalCases: 4
            },
            {
                id: 'alphaPolicy035',
                status: 'review-only',
                temporalStatus: 'available',
                reviewStatus: 'pending',
                candidateDecision: 'candidate-aware-human-review',
                candidateEvidence: {
                    reports: 6,
                    comparedCases: 18,
                    improvedCases: 12,
                    materialRegressedCases: 1,
                    warningRegressedCases: 2
                },
                diagnosticLinks: [
                    { label: 'Known flaw diagnostics', path: paths.alphaKnownFlawJson, exists: true },
                    { label: 'Rejected shape gate', path: paths.alphaRejectedShapeMd, exists: true }
                ],
                comparisons: 6,
                temporalCases: 3
            }
        ],
        temporalRows: [
            { laneId: 'current025', id: 'current-case' },
            { laneId: 'alphaPolicy035', id: 'alpha-case' }
        ],
        missingAssets: []
    };
    const quickstart = {
        status: 'incomplete',
        acceptanceStatus: 'pending-human-review',
        readyLanes: 2,
        laneCount: 2,
        missingAssets: 0,
        reviewThumbnailsEnabled: true,
        reviewVideoCount: 4,
        reviewThumbnailCount: 4,
        reviewThumbnailDir: path.join(root, 'thumbs'),
        reviewThumbnailSheetPath: paths.quickstartThumbnailSheet,
        reviewThumbnailSheetJsonPath: paths.quickstartThumbnailSheetJson,
        reviewOrder: [
            {
                rank: 1,
                laneId: 'current025',
                suggestedDecision: 'accept',
                suggestedStatus: 'accepted-for-default-review',
                candidateDecision: 'promote-default-candidate',
                primaryVideo: { caseId: 'current-case', kind: 'roi', src: paths.currentVideo, currentTime: 4 },
                priority: 10,
                reason: 'lowest-risk default candidate; verify visible quality first'
            },
            {
                rank: 2,
                laneId: 'alphaPolicy035',
                suggestedDecision: 'prefer-alpha-policy035',
                suggestedStatus: 'prefer-alpha-policy035-candidate',
                candidateDecision: 'candidate-aware-human-review',
                primaryVideo: { caseId: 'alpha-case', kind: 'roi', src: paths.alphaVideo, currentTime: 4 },
                priority: 51,
                reason: 'candidate-aware review; inspect diagnostics and 0 material / 0 warning regressions'
            }
        ],
        lanes: [
            {
                id: 'current025',
                comparisons: 4,
                temporalCases: 4,
                candidateDecision: 'promote-default-candidate',
                reviewVideos: [
                    { caseId: 'current-case', kind: 'full', src: paths.currentVideo, currentTime: 4, thumbnailPath: paths.currentThumbFull },
                    { caseId: 'current-case', kind: 'roi', src: paths.currentVideo, currentTime: 4, thumbnailPath: paths.currentThumbRoi }
                ],
                acceptanceChecklist: [
                    { index: 0, checked: false, text: 'current review looks acceptable' }
                ],
                suggestedAction: {
                    decision: 'accept',
                    status: 'accepted-for-default-review',
                    nextAction: 'promote-to-default-strategy-review',
                    acceptanceCommand: `${acceptanceLanes[0].command} --set-decision accept --check-all`,
                    candidateDecision: 'promote-default-candidate'
                },
                decisionPreviews: [
                    { decision: 'accept', status: 'accepted-for-default-review', nextAction: 'promote-to-default-strategy-review', acceptanceCommand: `${acceptanceLanes[0].command} --set-decision accept --check-all` },
                    { decision: 'needs-polish', status: 'needs-polish', acceptanceCommand: `${acceptanceLanes[0].command} --set-decision needs-polish --check-all` },
                    { decision: 'reject', status: 'rejected', acceptanceCommand: `${acceptanceLanes[0].command} --set-decision reject --check-all` }
                ]
            },
            {
                id: 'alphaPolicy035',
                comparisons: 6,
                temporalCases: 3,
                candidateDecision: 'candidate-aware-human-review',
                candidateEvidence: {
                    reports: 6,
                    comparedCases: 18,
                    improvedCases: 12,
                    materialRegressedCases: 1,
                    warningRegressedCases: 2
                },
                diagnosticLinks: [
                    { label: 'Known flaw diagnostics', path: paths.alphaKnownFlawJson, exists: true },
                    { label: 'Rejected shape gate', path: paths.alphaRejectedShapeMd, exists: true }
                ],
                reviewVideos: [
                    { caseId: 'alpha-case', kind: 'full', src: paths.alphaVideo, currentTime: 4, thumbnailPath: paths.alphaThumbFull },
                    { caseId: 'alpha-case', kind: 'roi', src: paths.alphaVideo, currentTime: 4, thumbnailPath: paths.alphaThumbRoi }
                ],
                acceptanceChecklist: [
                    { index: 0, checked: false, text: 'alpha review looks acceptable' }
                ],
                suggestedAction: {
                    decision: 'prefer-alpha-policy035',
                    status: 'prefer-alpha-policy035-candidate',
                    nextAction: 'promote-alpha-policy035-after-human-review',
                    acceptanceCommand: `${acceptanceLanes[1].command} --set-decision prefer-alpha-policy035 --check-all`,
                    candidateDecision: 'candidate-aware-human-review'
                },
                decisionPreviews: [
                    { decision: 'prefer-alpha-policy035', status: 'prefer-alpha-policy035-candidate', nextAction: 'promote-alpha-policy035-after-human-review', acceptanceCommand: `${acceptanceLanes[1].command} --set-decision prefer-alpha-policy035 --check-all` },
                    { decision: 'prefer-current', status: 'prefer-current-default-candidate', acceptanceCommand: `${acceptanceLanes[1].command} --set-decision prefer-current --check-all` },
                    { decision: 'needs-more-polish', status: 'needs-polish', acceptanceCommand: `${acceptanceLanes[1].command} --set-decision needs-more-polish --check-all` },
                    { decision: 'reject-both', status: 'rejected', acceptanceCommand: `${acceptanceLanes[1].command} --set-decision reject-both --check-all` }
                ]
            }
        ]
    };
    const previewText = [
        'promote-default-candidate',
        'candidate-aware-human-review',
        '6 reports, 18 cases, 12 improved, 1 material, 2 warning',
        'alphaPolicy035 | candidate-aware-human-review | 6 | 18 | 12 | 1 | 2',
        `Known flaw diagnostics ${paths.alphaKnownFlawJson}`,
        `Rejected shape gate ${paths.alphaRejectedShapeMd}`,
        `current-case full ${paths.currentVideo}`,
        `current-case roi ${paths.currentVideo}`,
        `alpha-case full ${paths.alphaVideo}`,
        `alpha-case roi ${paths.alphaVideo}`,
        path.basename(paths.currentThumbFull),
        path.basename(paths.currentThumbRoi),
        path.basename(paths.alphaThumbFull),
        path.basename(paths.alphaThumbRoi),
        path.basename(paths.quickstartThumbnailSheet),
        `current025 accept ${acceptanceLanes[0].command} --set-decision accept --check-all`,
        `alphaPolicy035 prefer-alpha-policy035 ${acceptanceLanes[1].command} --set-decision prefer-alpha-policy035 --check-all`,
        'current review looks acceptable',
        'alpha review looks acceptable',
        `accept accepted-for-default-review ${acceptanceLanes[0].command} --set-decision accept --check-all`,
        `needs-polish needs-polish ${acceptanceLanes[0].command} --set-decision needs-polish --check-all`,
        `reject rejected ${acceptanceLanes[0].command} --set-decision reject --check-all`,
        `prefer-alpha-policy035 prefer-alpha-policy035-candidate ${acceptanceLanes[1].command} --set-decision prefer-alpha-policy035 --check-all`,
        `prefer-current prefer-current-default-candidate ${acceptanceLanes[1].command} --set-decision prefer-current --check-all`,
        `needs-more-polish needs-polish ${acceptanceLanes[1].command} --set-decision needs-more-polish --check-all`,
        `reject-both rejected ${acceptanceLanes[1].command} --set-decision reject-both --check-all`
    ].join('\n');
    await writeText(paths.quickstartMd, `# Quickstart\n\n## Review Entry\n\n| Item | Value |\n|---|---|\n| Review thumbnail sheet | ${paths.quickstartThumbnailSheet} |\n\n## Review Order\n\ncurrent025\nalphaPolicy035\n\n## Suggested Review Actions\n\n## Human Acceptance Checklist\n\n## Review Playlist\n\n${previewText}\n`);
    const copyTargets = [
        'accept',
        'needs-polish',
        'reject',
        'prefer-alpha-policy035',
        'prefer-current',
        'needs-more-polish',
        'reject-both'
    ].map((decision) => `<button data-copy-decision="${decision}">Copy</button>`).join('\n');
    await writeText(paths.quickstartHtml, `<!doctype html><body><a href="${paths.quickstartThumbnailSheet}">Thumbnail Sheet ${path.basename(paths.quickstartThumbnailSheet)}</a><section id="review-order"><h2>Review Order</h2><div data-review-order-lane="current025"></div><div data-review-order-lane="alphaPolicy035"></div></section><section id="suggested-review-actions"><h2>Suggested Review Actions</h2><div data-suggested-action-lane="current025"></div><div data-suggested-action-lane="alphaPolicy035"></div>${previewText}</section><section id="human-acceptance-checklist"><h2>Human Acceptance Checklist</h2><div data-acceptance-checklist-lane="current025"></div><div data-acceptance-checklist-lane="alphaPolicy035"></div>${previewText}</section><section id="review-playlist"><h2>Review Playlist</h2>${previewText}</section>\n${copyTargets}</body>\n`);
    const bundle = {
        status: 'incomplete',
        complete: false,
        nextAction: 'collect-human-review-acceptance',
        blockers: ['human-review-acceptance-missing'],
        markdownPath: paths.bundleMd,
        acceptance: {
            status: 'pending-human-review',
            acceptedStatuses,
            lanes: acceptanceLanes
        },
        decisionTemplates: [
            { laneId: 'current025', path: paths.currentTemplate, videos: 4 },
            { laneId: 'alphaPolicy035', path: paths.alphaTemplate, videos: 6 }
        ],
        dashboard: {
            outputPath: paths.dashboardHtml,
            reportPath: paths.dashboardJson,
            screenshotPath: paths.dashboardPng,
            screenshotReportPath: paths.dashboardScreenshotJson,
            lanes: 2,
            readyLanes: 2,
            missingAssets: 0
        },
        goalStatus: {
            outputPath: paths.goalJson,
            markdownPath: paths.goalMd,
            requirementCount: 5,
            satisfiedRequirements: 4
        },
        quickstart: {
            outputPath: paths.quickstartMd,
            jsonPath: paths.quickstartJson,
            htmlPath: paths.quickstartHtml,
            thumbnailSheetPath: paths.quickstartThumbnailSheet,
            thumbnailSheetJsonPath: paths.quickstartThumbnailSheetJson,
            screenshotPath: paths.quickstartPng,
            screenshotReportPath: paths.quickstartScreenshotJson
        }
    };
    await writeJson(paths.dashboardJson, dashboard);
    await writeJson(paths.quickstartJson, quickstart);
    await writeJson(paths.quickstartThumbnailSheetJson, {
        outputPath: paths.quickstartThumbnailSheet,
        totalVideos: 4,
        thumbnails: 4,
        missingThumbnails: 0
    });
    await writeJson(paths.bundle, bundle);
    return paths;
}

test('createVideoDeliveryBundleVerification should pass for a complete handoff bundle', async () => {
    const root = path.resolve('.artifacts/test-tmp/video-delivery-bundle-verification-pass');
    await rm(root, { recursive: true, force: true });
    const paths = await createFixture(root);

    const report = await createVideoDeliveryBundleVerification({
        bundlePath: paths.bundle,
        dashboardPath: paths.dashboardJson,
        quickstartPath: paths.quickstartJson,
        outputPath: paths.output,
        markdownPath: paths.markdown,
        videoProbe: async () => ({ width: 1280, height: 720, duration: 10, fps: 24 })
    });
    const saved = JSON.parse(await readFile(paths.output, 'utf8'));
    const markdown = await readFile(paths.markdown, 'utf8');

    assert.equal(report.status, 'ready-for-human-review');
    assert.equal(report.summary.failed, 0);
    assert.equal(saved.summary.lanes, 2);
    assert.equal(report.mediaVerification.videoChecks, 4);
    assert.equal(report.mediaVerification.failedVideoChecks, 0);
    assert.equal(report.mediaVerification.htmlReferenceChecks, 4);
    assert.equal(report.mediaVerification.failedHtmlReferenceChecks, 0);
    assert.equal(report.mediaVerification.reviewTimeChecks, 4);
    assert.equal(report.mediaVerification.failedReviewTimeChecks, 0);
    assert.equal(report.decisionVerification.optionChecks, 7);
    assert.equal(report.decisionVerification.failedOptionChecks, 0);
    assert.equal(report.decisionVerification.templateOptionPresenceChecks, 2);
    assert.equal(report.decisionVerification.failedTemplateOptionPresenceChecks, 0);
    assert.equal(report.decisionVerification.templateSuggestedDecisionChecks, 2);
    assert.equal(report.decisionVerification.failedTemplateSuggestedDecisionChecks, 0);
    assert.equal(report.templateVerification.pathChecks, 2);
    assert.equal(report.templateVerification.failedPathChecks, 0);
    assert.equal(report.templateVerification.pageChecks, 2);
    assert.equal(report.templateVerification.failedPageChecks, 0);
    assert.equal(report.templateVerification.instructionChecks, 2);
    assert.equal(report.templateVerification.failedInstructionChecks, 0);
    assert.equal(report.templateVerification.acceptedStatusChecks, 2);
    assert.equal(report.templateVerification.failedAcceptedStatusChecks, 0);
    assert.equal(report.templateVerification.checklistChecks, 2);
    assert.equal(report.templateVerification.failedChecklistChecks, 0);
    assert.equal(report.acceptanceDryRunVerification.suggestedGoalCompatibleChecks, 2);
    assert.equal(report.acceptanceDryRunVerification.failedSuggestedGoalCompatibleChecks, 0);
    assert.equal(report.acceptanceDryRunVerification.acceptedOptionAvailabilityChecks, 2);
    assert.equal(report.acceptanceDryRunVerification.failedAcceptedOptionAvailabilityChecks, 0);
    assert.equal(report.quickstartDecisionVerification.previewChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedPreviewChecks, 0);
    assert.equal(report.quickstartDecisionVerification.previewParserMatchChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedPreviewParserMatchChecks, 0);
    assert.equal(report.quickstartDecisionVerification.acceptanceCommandChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedAcceptanceCommandChecks, 0);
    assert.equal(report.quickstartDecisionVerification.previewPresenceChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedPreviewPresenceChecks, 0);
    assert.equal(report.quickstartDecisionVerification.reviewOrderChecks, 1);
    assert.equal(report.quickstartDecisionVerification.failedReviewOrderChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlReviewOrderChecks, 1);
    assert.equal(report.quickstartDecisionVerification.failedHtmlReviewOrderChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownReviewOrderChecks, 1);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownReviewOrderChecks, 0);
    assert.equal(report.quickstartDecisionVerification.suggestedActionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedSuggestedActionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlSuggestedActionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlSuggestedActionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownSuggestedActionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownSuggestedActionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.acceptanceChecklistChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedAcceptanceChecklistChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlAcceptanceChecklistChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlAcceptanceChecklistChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownAcceptanceChecklistChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownAcceptanceChecklistChecks, 0);
    assert.equal(report.quickstartDecisionVerification.candidateDecisionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedCandidateDecisionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.candidateEvidenceStatsChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedCandidateEvidenceStatsChecks, 0);
    assert.equal(report.quickstartDecisionVerification.diagnosticLinkChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedDiagnosticLinkChecks, 0);
    assert.equal(report.quickstartDecisionVerification.diagnosticPathChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedDiagnosticPathChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlCandidateDecisionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlCandidateDecisionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlCandidateEvidenceStatsChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlCandidateEvidenceStatsChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlDiagnosticLinkChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlDiagnosticLinkChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownCandidateDecisionChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownCandidateDecisionChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownCandidateEvidenceStatsChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownCandidateEvidenceStatsChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownDiagnosticLinkChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownDiagnosticLinkChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlPreviewChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedHtmlPreviewChecks, 0);
    assert.equal(report.quickstartDecisionVerification.decisionCopyTargetChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedDecisionCopyTargetChecks, 0);
    assert.equal(report.quickstartDecisionVerification.acceptanceCommandCopyTargetChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedAcceptanceCommandCopyTargetChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownPreviewChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownPreviewChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownAcceptanceCommandChecks, 7);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownAcceptanceCommandChecks, 0);
    assert.equal(report.quickstartDecisionVerification.reviewVideoChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedReviewVideoChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlReviewVideoChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedHtmlReviewVideoChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownReviewVideoChecks, 2);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownReviewVideoChecks, 0);
    assert.equal(report.reviewThumbnailVerification.enabled, true);
    assert.equal(report.reviewThumbnailVerification.completenessChecks, 2);
    assert.equal(report.reviewThumbnailVerification.failedCompletenessChecks, 0);
    assert.equal(report.reviewThumbnailVerification.htmlVisibilityChecks, 2);
    assert.equal(report.reviewThumbnailVerification.failedHtmlVisibilityChecks, 0);
    assert.equal(report.reviewThumbnailVerification.markdownVisibilityChecks, 2);
    assert.equal(report.reviewThumbnailVerification.failedMarkdownVisibilityChecks, 0);
    assert.equal(report.reviewThumbnailVerification.fileChecks, 4);
    assert.equal(report.reviewThumbnailVerification.failedFileChecks, 0);
    assert.equal(report.reviewThumbnailVerification.pngChecks, 4);
    assert.equal(report.reviewThumbnailVerification.failedPngChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.enabled, true);
    assert.equal(report.reviewThumbnailSheetVerification.pathChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedPathChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.jsonPathChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedJsonPathChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.pngChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedPngChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.countChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedCountChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.htmlLinkChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedHtmlLinkChecks, 0);
    assert.equal(report.reviewThumbnailSheetVerification.markdownLinkChecks, 1);
    assert.equal(report.reviewThumbnailSheetVerification.failedMarkdownLinkChecks, 0);
    assert.equal(report.quickstartDecisionVerification.htmlReviewPlaylistChecks, 1);
    assert.equal(report.quickstartDecisionVerification.failedHtmlReviewPlaylistChecks, 0);
    assert.equal(report.quickstartDecisionVerification.markdownReviewPlaylistChecks, 1);
    assert.equal(report.quickstartDecisionVerification.failedMarkdownReviewPlaylistChecks, 0);
    assert.equal(report.commandVerification.scriptChecks, 2);
    assert.equal(report.commandVerification.failedScriptChecks, 0);
    assert.equal(report.commandVerification.decisionPathChecks, 2);
    assert.equal(report.commandVerification.failedDecisionPathChecks, 0);
    assert.equal(report.commandVerification.outputPathChecks, 2);
    assert.equal(report.commandVerification.failedOutputPathChecks, 0);
    assert.equal(report.commandVerification.markdownPathChecks, 2);
    assert.equal(report.commandVerification.failedMarkdownPathChecks, 0);
    assert.equal(report.dashboardDiagnosticVerification.htmlDiagnosticLinkChecks, 2);
    assert.equal(report.dashboardDiagnosticVerification.failedHtmlDiagnosticLinkChecks, 0);
    assert.equal(report.screenshotVerification.reportChecks, 2);
    assert.equal(report.screenshotVerification.failedReportChecks, 0);
    assert.equal(report.screenshotVerification.htmlPathChecks, 2);
    assert.equal(report.screenshotVerification.failedHtmlPathChecks, 0);
    assert.equal(report.screenshotVerification.outputPathChecks, 2);
    assert.equal(report.screenshotVerification.failedOutputPathChecks, 0);
    assert.equal(report.screenshotVerification.viewportChecks, 2);
    assert.equal(report.screenshotVerification.failedViewportChecks, 0);
    assert.equal(report.screenshotVerification.documentSizeChecks, 2);
    assert.equal(report.screenshotVerification.failedDocumentSizeChecks, 0);
    assert.equal(report.screenshotVerification.generatedAtChecks, 2);
    assert.equal(report.screenshotVerification.failedGeneratedAtChecks, 0);
    assert.equal(report.screenshotVerification.fullPageChecks, 2);
    assert.equal(report.screenshotVerification.failedFullPageChecks, 0);
    assert.match(report.quickstartUrl, /^file:\/\/\//);
    assert.ok(report.checks.some((item) => item.id === 'lane-video-media-readable' && item.laneId === 'alphaPolicy035'));
    assert.ok(report.checks.some((item) => item.id === 'lane-video-html-reference' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-video-view-coverage' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-video-review-time-valid' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-template-decision-option-recognized' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-template-page-matches-review' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-quickstart-decision-preview-valid' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-quickstart-suggested-action-matches-preview' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-quickstart-acceptance-checklist-matches-template' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'lane-quickstart-review-videos-match-template' && item.laneId === 'alphaPolicy035' && item.status === 'pass'));
    assert.ok(report.checks.some((item) => item.id === 'quickstart-review-order-matches-policy' && item.status === 'pass'));
    assert.match(markdown, /Decision verification/);
    assert.match(markdown, /Template verification/);
    assert.match(markdown, /Acceptance dry-run/);
    assert.match(markdown, /Quickstart decision previews/);
    assert.match(markdown, /Quickstart review order/);
    assert.match(markdown, /Quickstart suggested actions/);
    assert.match(markdown, /Quickstart acceptance checklist/);
    assert.match(markdown, /Quickstart review videos/);
    assert.match(markdown, /Review thumbnails/);
    assert.match(markdown, /Review thumbnail sheet/);
    assert.match(markdown, /Command verification/);
    assert.match(markdown, /Dashboard diagnostics/);
    assert.match(markdown, /Screenshot verification/);
    assert.match(markdown, /Video Delivery Bundle Verification/);
    assert.match(markdown, /None\./);
});

test('createVideoDeliveryBundleVerification should fail broken lane assets', async () => {
    const root = path.resolve('.artifacts/test-tmp/video-delivery-bundle-verification-fail');
    await rm(root, { recursive: true, force: true });
    const paths = await createFixture(root, { missingAlphaReview: true });

    const report = await createVideoDeliveryBundleVerification({
        bundlePath: paths.bundle,
        dashboardPath: paths.dashboardJson,
        quickstartPath: paths.quickstartJson,
        outputPath: paths.output,
        markdownPath: paths.markdown,
        videoProbe: async () => ({ width: 1280, height: 720, duration: 10, fps: 24 })
    });

    assert.equal(report.status, 'invalid');
    assert.ok(report.failedChecks.some((item) => item.id === 'lane-review-html' && item.laneId === 'alphaPolicy035'));
    assert.match(renderVideoDeliveryBundleVerificationMarkdown(report), /alphaPolicy035/);
});
