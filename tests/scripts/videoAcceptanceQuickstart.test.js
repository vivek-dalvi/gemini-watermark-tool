import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoAcceptanceQuickstart,
    createVideoAcceptanceQuickstartSummary,
    renderVideoAcceptanceQuickstartHtml,
    renderVideoAcceptanceQuickstartMarkdown
} from '../../scripts/create-video-acceptance-quickstart.js';

const repoRoot = path.resolve('.');

function bundleReport({
    currentTemplatePath = path.join(repoRoot, '.artifacts/video-delivery-bundle/decision-templates/current025.decision.template.json'),
    alphaTemplatePath = path.join(repoRoot, '.artifacts/video-delivery-bundle/decision-templates/alphaPolicy035.decision.template.json')
} = {}) {
    return {
        status: 'incomplete',
        nextAction: 'collect-human-review-acceptance',
        blockers: ['human-review-acceptance-missing'],
        markdownPath: path.join(repoRoot, '.artifacts/video-delivery-bundle/latest-report.md'),
        dashboard: {
            outputPath: path.join(repoRoot, '.artifacts/video-delivery-dashboard/latest-video-dashboard.html'),
            screenshotPath: path.join(repoRoot, '.artifacts/video-delivery-dashboard/latest-video-dashboard.png'),
            readyLanes: 4,
            lanes: 4,
            missingAssets: 0
        },
        goalStatus: {
            markdownPath: path.join(repoRoot, '.artifacts/video-goal-status/latest-report.md'),
            requirementCount: 5,
            satisfiedRequirements: 4
        },
        acceptance: {
            status: 'pending-human-review',
            requiredForCompletion: 'At least one lane must be accepted.',
            lanes: [
                {
                    id: 'current025',
                    title: 'Current Candidate 0.25',
                    complete: false,
                    currentStatus: 'needs-polish',
                    suggestedDecision: 'accept',
                    suggestedDecisionOptions: ['accept', 'needs-polish', 'reject'],
                    checklist: { checked: 1, total: 5 },
                    reviewHtmlPath: path.join(repoRoot, '.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html'),
                    decisionTemplatePath: currentTemplatePath,
                    decisionJsonPath: path.join(repoRoot, '.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json'),
                    decisionReportPath: path.join(repoRoot, '.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md'),
                    command: 'pnpm report:video-review-decision -- --decision current025.decision.template.json'
                },
                {
                    id: 'alphaPolicy035',
                    title: 'Alpha Policy 0.35',
                    complete: false,
                    currentStatus: 'pending',
                    suggestedDecision: 'prefer-alpha-policy035',
                    suggestedDecisionOptions: ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both'],
                    checklist: { checked: 0, total: 5 },
                    reviewHtmlPath: path.join(repoRoot, '.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html'),
                    decisionTemplatePath: alphaTemplatePath,
                    decisionJsonPath: path.join(repoRoot, '.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json'),
                    decisionReportPath: path.join(repoRoot, '.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md'),
                    command: 'pnpm report:video-review-decision -- --decision alphaPolicy035.decision.template.json'
                }
            ]
        }
    };
}

function dashboardReport() {
    return {
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
                    reportPath: path.join(repoRoot, '.artifacts/video-alpha-policy-evidence/latest-report.json'),
                    reports: 6,
                    comparedCases: 18,
                    improvedCases: 12,
                    materialRegressedCases: 1,
                    warningRegressedCases: 2
                },
                diagnosticLinks: [
                    {
                        label: 'Known flaw diagnostics',
                        path: path.join(repoRoot, '.artifacts/video-policy035-default-review/user-flaw-diagnostics/latest.json'),
                        exists: true
                    },
                    {
                        label: 'Rejected shape gate',
                        path: path.join(repoRoot, '.artifacts/video-alpha-shape-candidate-gate/manual-shape-validated/latest-report.md'),
                        exists: true
                    }
                ],
                comparisons: 6,
                temporalCases: 3
            }
        ],
        temporalRows: [
            { laneId: 'current025', id: 'current-case', same: 1, matched: 2, worsened: 0.1 },
            { laneId: 'alphaPolicy035', id: '4d420881-alpha-policy035-12mbps', same: 3, matched: 4, worsened: 0.2 }
        ]
    };
}

test('createVideoAcceptanceQuickstartSummary should merge bundle and dashboard review facts', () => {
    const summary = createVideoAcceptanceQuickstartSummary({
        bundleReport: bundleReport(),
        dashboardReport: dashboardReport()
    });
    const alpha = summary.lanes.find((lane) => lane.id === 'alphaPolicy035');
    const markdown = renderVideoAcceptanceQuickstartMarkdown(summary);
    const html = renderVideoAcceptanceQuickstartHtml(summary);

    assert.equal(summary.status, 'incomplete');
    assert.equal(summary.acceptanceStatus, 'pending-human-review');
    assert.equal(summary.readyLanes, 4);
    assert.equal(summary.missingAssets, 0);
    assert.equal(alpha.suggestedDecision, 'prefer-alpha-policy035');
    assert.equal(alpha.comparisons, 6);
    assert.equal(alpha.temporalCases, 3);
    assert.equal(alpha.temporalRows, 1);
    assert.equal(alpha.candidateDecision, 'candidate-aware-human-review');
    assert.equal(alpha.candidateEvidence.comparedCases, 18);
    assert.equal(alpha.diagnosticLinks.length, 2);
    assert.match(alpha.reviewHtmlUrl, /^file:\/\/\//);
    assert.match(markdown, /Video Acceptance Quickstart/);
    assert.match(markdown, /Human Decision Flow/);
    assert.match(markdown, /prefer-alpha-policy035/);
    assert.match(markdown, /candidate-aware-human-review/);
    assert.match(markdown, /Candidate Evidence/);
    assert.match(markdown, /Diagnostic Links/);
    assert.match(markdown, /alphaPolicy035 \| candidate-aware-human-review \| 6 \| 18 \| 12 \| 1 \| 2/);
    assert.match(markdown, /Known flaw diagnostics/);
    assert.match(markdown, /manual-shape-validated[\\/]latest-report\.md/);
    assert.match(markdown, /video-alpha-policy-evidence[\\/]latest-report\.json/);
    assert.match(markdown, /pnpm report:video-review-decision/);
    assert.match(html, /Video Acceptance Quickstart/);
    assert.match(html, /Open Dashboard/);
    assert.match(html, /data-copy-command=/);
    assert.match(html, /Video delivery dashboard screenshot/);
    assert.match(html, /prefer-alpha-policy035/);
    assert.match(html, /candidate-aware-human-review/);
    assert.match(html, /6 reports, 18 cases, 12 improved, 1 material, 2 warning/);
    assert.match(html, /Evidence report/);
    assert.match(html, /video-alpha-policy-evidence\/latest-report\.json/);
    assert.match(html, /Known flaw diagnostics/);
    assert.match(html, /manual-shape-validated\/latest-report\.md/);
    assert.match(html, /pill warn"><span>evidence<\/span><strong>candidate-aware-human-review/);
    assert.match(html, /pill good"><span>evidence<\/span><strong>promote-default-candidate/);
});

test('createVideoAcceptanceQuickstart should write markdown and json outputs', async () => {
    const artifactRoot = path.resolve('.artifacts/test-tmp/video-acceptance-quickstart');
    await rm(artifactRoot, { recursive: true, force: true });
    await mkdir(artifactRoot, { recursive: true });
    const bundlePath = path.join(artifactRoot, 'bundle.json');
    const dashboardPath = path.join(artifactRoot, 'dashboard.json');
    const outputPath = path.join(artifactRoot, 'quickstart.md');
    const jsonPath = path.join(artifactRoot, 'quickstart.json');
    const htmlPath = path.join(artifactRoot, 'quickstart.html');
    const thumbnailDir = path.join(artifactRoot, 'thumbnails');
    const thumbnailSheetPath = path.join(artifactRoot, 'thumbnail-sheet.png');
    const thumbnailSheetJsonPath = path.join(artifactRoot, 'thumbnail-sheet.json');
    const currentTemplatePath = path.join(artifactRoot, 'current025.decision.template.json');
    const alphaTemplatePath = path.join(artifactRoot, 'alphaPolicy035.decision.template.json');
    await writeFile(currentTemplatePath, `${JSON.stringify({
        suggestedDecisionOptions: ['accept', 'needs-polish', 'reject'],
        deliveryStatus: 'ready-for-visual-review',
        temporalStatus: 'pass',
        videos: [
            { caseId: 'current-case', kind: 'full', src: path.join(artifactRoot, 'current-full.mp4'), currentTime: 4 },
            { caseId: 'current-case', kind: 'roi', src: path.join(artifactRoot, 'current-roi.mp4'), currentTime: 4 }
        ],
        checklist: [{ index: 0, checked: false, text: 'current checked' }]
    }, null, 2)}\n`, 'utf8');
    await writeFile(alphaTemplatePath, `${JSON.stringify({
        suggestedDecisionOptions: ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both'],
        deliveryStatus: 'review-only',
        temporalStatus: 'available',
        videos: [
            { caseId: 'alpha-case', kind: 'full', src: path.join(artifactRoot, 'alpha-full.mp4'), currentTime: 4 },
            { caseId: 'alpha-case', kind: 'roi', src: path.join(artifactRoot, 'alpha-roi.mp4'), currentTime: 4 }
        ],
        checklist: [{ index: 0, checked: false, text: 'alpha checked' }]
    }, null, 2)}\n`, 'utf8');
    await writeFile(bundlePath, `${JSON.stringify(bundleReport({ currentTemplatePath, alphaTemplatePath }), null, 2)}\n`, 'utf8');
    await writeFile(dashboardPath, `${JSON.stringify(dashboardReport(), null, 2)}\n`, 'utf8');

    const report = await createVideoAcceptanceQuickstart({
        bundlePath,
        dashboardPath,
        outputPath,
        jsonPath,
        htmlPath,
        generateReviewThumbnails: true,
        reviewThumbnailDir: thumbnailDir,
        reviewThumbnailSheetPath: thumbnailSheetPath,
        reviewThumbnailSheetJsonPath: thumbnailSheetJsonPath,
        reviewThumbnailGenerator: async ({ outputPath: thumbnailPath }) => {
            await mkdir(path.dirname(thumbnailPath), { recursive: true });
            await writeFile(thumbnailPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64'));
            return { outputPath: thumbnailPath };
        }
    });
    const saved = JSON.parse(await readFile(jsonPath, 'utf8'));
    const markdown = await readFile(outputPath, 'utf8');
    const html = await readFile(htmlPath, 'utf8');

    assert.equal(report.outputPath, outputPath);
    assert.equal(report.jsonPath, jsonPath);
    assert.equal(report.htmlPath, htmlPath);
    assert.equal(saved.lanes.length, 2);
    assert.equal(saved.decisionPreviewCount, 7);
    assert.equal(saved.failedDecisionPreviewCount, 0);
    assert.equal(saved.reviewVideoCount, 4);
    assert.equal(saved.reviewThumbnailsEnabled, true);
    assert.equal(saved.reviewThumbnailCount, 4);
    assert.equal(saved.reviewThumbnailDir, thumbnailDir);
    assert.equal(saved.reviewThumbnailSheetPath, thumbnailSheetPath);
    assert.equal(saved.reviewThumbnailSheetJsonPath, thumbnailSheetJsonPath);
    assert.equal(saved.suggestedActionCount, 2);
    assert.equal(saved.acceptanceChecklistCount, 2);
    assert.equal(saved.reviewOrder.length, 2);
    assert.equal(saved.reviewOrder[0].laneId, 'current025');
    assert.equal(saved.reviewOrder[0].primaryVideo.kind, 'roi');
    assert.equal(saved.reviewOrder[1].laneId, 'alphaPolicy035');
    assert.equal(saved.reviewOrder[1].primaryVideo.kind, 'roi');
    assert.equal(saved.lanes[1].suggestedAction.decision, 'prefer-alpha-policy035');
    assert.equal(saved.lanes[1].suggestedAction.status, 'prefer-alpha-policy035-candidate');
    assert.match(saved.lanes[1].suggestedAction.acceptanceCommand, /--set-decision prefer-alpha-policy035 --check-all/);
    assert.equal(saved.lanes[1].acceptanceChecklist[0].text, 'alpha checked');
    assert.equal(saved.lanes[1].reviewVideos.length, 2);
    assert.equal(saved.lanes[1].reviewVideos[0].caseId, 'alpha-case');
    assert.equal(saved.lanes[1].reviewVideos[0].kind, 'full');
    assert.match(saved.lanes[1].reviewVideos[0].thumbnailPath, /alphaPolicy035-01-alpha-case-full-[a-f0-9]+\.png$/);
    assert.equal(saved.lanes[1].decisionPreviews.length, 4);
    assert.equal(saved.lanes[1].candidateDecision, 'candidate-aware-human-review');
    assert.equal(saved.lanes[1].candidateEvidence.materialRegressedCases, 1);
    assert.equal(saved.lanes[1].diagnosticLinks[1].label, 'Rejected shape gate');
    assert.equal(saved.lanes[1].decisionPreviews[0].status, 'prefer-alpha-policy035-candidate');
    assert.match(saved.lanes[1].decisionPreviews[0].acceptanceCommand, /--set-decision prefer-alpha-policy035 --check-all/);
    assert.match(markdown, /Lane Commands/);
    assert.match(markdown, /Review Order/);
    assert.match(markdown, /alpha-case roi alpha-roi\.mp4/);
    assert.match(markdown, /Suggested Review Actions/);
    assert.match(markdown, /Human Acceptance Checklist/);
    assert.match(markdown, /alpha checked/);
    assert.match(markdown, /Decision Previews/);
    assert.match(markdown, /prefer-alpha-policy035-candidate/);
    assert.match(markdown, /candidate-aware-human-review/);
    assert.match(markdown, /alphaPolicy035 \| candidate-aware-human-review \| 6 \| 18 \| 12 \| 1 \| 2/);
    assert.match(markdown, /video-alpha-policy-evidence[\\/]latest-report\.json/);
    assert.match(markdown, /Diagnostic Links/);
    assert.match(markdown, /Review Playlist/);
    assert.match(markdown, /Review thumbnail sheet/);
    assert.match(markdown, /thumbnail-sheet\.png/);
    assert.match(markdown, /alpha-full\.mp4/);
    assert.match(markdown, /alpha-roi\.mp4/);
    assert.match(markdown, /alphaPolicy035-01-alpha-case-full-[a-f0-9]+\.png/);
    assert.match(markdown, /--set-decision prefer-alpha-policy035 --check-all/);
    assert.match(markdown, /alphaPolicy035/);
    assert.match(html, /Copy/);
    assert.match(html, /data-copy-decision="prefer-alpha-policy035"/);
    assert.match(html, /data-copy-decision="accept"/);
    assert.match(html, /Copy cmd/);
    assert.match(html, /id="review-order"/);
    assert.match(html, /data-review-order-lane="current025"/);
    assert.match(html, /alpha-case roi alpha-roi\.mp4/);
    assert.match(html, /id="suggested-review-actions"/);
    assert.match(html, /data-suggested-action-lane="alphaPolicy035"/);
    assert.match(html, /id="human-acceptance-checklist"/);
    assert.match(html, /data-acceptance-checklist-lane="alphaPolicy035"/);
    assert.match(html, /alpha checked/);
    assert.match(html, /--set-decision prefer-alpha-policy035 --check-all/);
    assert.match(html, /Preview/);
    assert.match(html, /prefer-alpha-policy035-candidate/);
    assert.match(html, /candidate-aware-human-review/);
    assert.match(html, /6 reports, 18 cases, 12 improved, 1 material, 2 warning/);
    assert.match(html, /Evidence report/);
    assert.match(html, /Rejected shape gate/);
    assert.match(html, /id="review-playlist"/);
    assert.match(html, /Review Playlist/);
    assert.match(html, /Thumbnail Sheet/);
    assert.match(html, /thumbnail-sheet\.png/);
    assert.match(html, /alpha-case full alpha-full\.mp4/);
    assert.match(html, /alpha-case roi alpha-roi\.mp4/);
    assert.match(html, /class="video-thumb"/);
    assert.match(html, /alphaPolicy035-01-alpha-case-full-[a-f0-9]+\.png/);
    assert.match(html, /alphaPolicy035/);
});
