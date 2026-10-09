import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createVideoDeliveryDashboard } from './create-video-delivery-dashboard.js';
import { createVideoGoalStatusReport } from './create-video-goal-status-report.js';
import { createVideoReviewScreenshot } from './create-video-review-screenshot.js';
import { createVideoAcceptanceQuickstart } from './create-video-acceptance-quickstart.js';
import { createVideoReviewThumbnailSheet } from './create-video-review-thumbnail-sheet.js';
import { createVideoDeliveryBundleVerification } from './verify-video-delivery-bundle.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-report.md');
const DEFAULT_DASHBOARD_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.html');
const DEFAULT_DASHBOARD_REPORT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.json');
const DEFAULT_DASHBOARD_SCREENSHOT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.png');
const DEFAULT_DASHBOARD_SCREENSHOT_REPORT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard-screenshot.json');
const DEFAULT_GOAL_OUTPUT_PATH = path.resolve('.artifacts/video-goal-status/latest-report.json');
const DEFAULT_GOAL_MARKDOWN_PATH = path.resolve('.artifacts/video-goal-status/latest-report.md');
const DEFAULT_DECISION_TEMPLATE_DIR = path.resolve('.artifacts/video-delivery-bundle/decision-templates');
const DEFAULT_QUICKSTART_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.md');
const DEFAULT_QUICKSTART_JSON_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json');
const DEFAULT_QUICKSTART_HTML_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.html');
const DEFAULT_QUICKSTART_SCREENSHOT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.png');
const DEFAULT_QUICKSTART_SCREENSHOT_REPORT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart-screenshot.json');
const DEFAULT_REVIEW_THUMBNAIL_DIR = path.resolve('.artifacts/video-delivery-bundle/review-thumbnails');
const DEFAULT_REVIEW_THUMBNAIL_SHEET_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.png');
const DEFAULT_REVIEW_THUMBNAIL_SHEET_JSON_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.json');
const DEFAULT_VERIFICATION_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-verification-report.json');
const DEFAULT_VERIFICATION_MARKDOWN_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-verification-report.md');

const ACCEPTANCE_STATUSES = Object.freeze([
    'accepted-for-default-review',
    'prefer-current-default-candidate',
    'prefer-light-polish-candidate',
    'prefer-strength018-polish-candidate',
    'prefer-strength022-polish-candidate',
    'prefer-alpha-policy035-candidate'
]);

function getAssetPath(lane = {}, assetName) {
    return (lane.assets || []).find((asset) => asset.name === assetName)?.path || null;
}

function suggestedDecisionForLane(laneId = null) {
    if (laneId === 'current025') return 'accept';
    if (laneId === 'polish020') return 'prefer-light';
    if (laneId === 'sweep018022') return 'prefer-strength018';
    if (laneId === 'alphaPolicy035') return 'prefer-alpha-policy035';
    return 'accept';
}

function suggestedDecisionOptionsForLane(laneId = null) {
    if (laneId === 'current025') return ['accept', 'needs-polish', 'reject'];
    if (laneId === 'polish020') return ['prefer-light', 'prefer-current', 'needs-more-polish', 'reject-both'];
    if (laneId === 'sweep018022') {
        return ['prefer-strength018', 'prefer-strength022', 'prefer-light', 'prefer-current', 'needs-more-polish', 'reject-both'];
    }
    if (laneId === 'alphaPolicy035') return ['prefer-alpha-policy035', 'prefer-current', 'needs-more-polish', 'reject-both'];
    return [suggestedDecisionForLane(laneId)];
}

function createLaneAcceptancePlan({ dashboardLane = {}, goalLane = {}, decisionTemplatePath = null } = {}) {
    const laneId = dashboardLane.id || goalLane.id || null;
    const decisionJsonPath = getAssetPath(dashboardLane, 'decisionJson');
    const decisionReportPath = getAssetPath(dashboardLane, 'decisionReport');
    const currentStatus = goalLane.reviewStatus || dashboardLane.reviewStatus || null;
    const checklist = goalLane.checklist || dashboardLane.checklist || null;
    const complete = ACCEPTANCE_STATUSES.includes(currentStatus) && checklist?.allChecked === true;
    const suggestedDecision = suggestedDecisionForLane(laneId);
    const decisionInputPath = decisionTemplatePath || '<exported-review-decision.json>';
    const command = dashboardLane.decisionCommand || (decisionJsonPath && decisionReportPath
        ? `pnpm report:video-review-decision -- --decision ${decisionInputPath} --output ${decisionJsonPath} --markdown ${decisionReportPath}`
        : null);
    return {
        id: laneId,
        title: dashboardLane.title || goalLane.title || laneId,
        complete,
        currentStatus,
        checklist,
        reviewHtmlPath: getAssetPath(dashboardLane, 'reviewHtml'),
        decisionTemplatePath,
        decisionJsonPath,
        decisionReportPath,
        acceptedStatuses: ACCEPTANCE_STATUSES,
        suggestedDecision,
        suggestedDecisionOptions: suggestedDecisionOptionsForLane(laneId),
        requirement: 'export a human review decision JSON with an accepted/prefer status and a fully checked checklist',
        command
    };
}

function createAcceptancePlan({ dashboardDetail = {}, goalReport = {} } = {}) {
    const dashboardLanes = Array.isArray(dashboardDetail.lanes) ? dashboardDetail.lanes : [];
    const goalLanes = Array.isArray(goalReport.lanes) ? goalReport.lanes : [];
    const dashboardById = new Map(dashboardLanes.map((lane) => [lane.id, lane]));
    const lanes = goalLanes.map((goalLane) => createLaneAcceptancePlan({
        dashboardLane: dashboardById.get(goalLane.id) || {},
        goalLane,
        decisionTemplatePath: dashboardById.get(goalLane.id)?.decisionTemplatePath || null
    }));
    return {
        status: lanes.some((lane) => lane.complete) ? 'accepted' : 'pending-human-review',
        requiredForCompletion: 'At least one lane must have an accepted/prefer decision report with checklist.allChecked=true.',
        acceptedStatuses: ACCEPTANCE_STATUSES,
        lanes
    };
}

function createPendingDecisionTemplate({ lane = {}, reviewPack = {}, outputPath }) {
    const reviewHtmlPath = getAssetPath(lane, 'reviewHtml');
    const laneId = lane.id || null;
    const candidate = reviewPack.delivery?.bestCandidate?.profileLabel || lane.bestCandidate || null;
    const videos = (reviewPack.comparisons || []).map((item) => ({
        caseId: item.caseId || '',
        kind: item.kind || '',
        src: item.outputPath || '',
        currentTime: 4,
        playbackRate: 1,
        loop: false
    }));
    return {
        exportedAt: new Date().toISOString(),
        template: true,
        templateInstructions: 'Edit decision, notes, and checklist.checked values after human review, then run the matching pnpm report:video-review-decision command from the delivery bundle.',
        templatePath: path.resolve(outputPath),
        laneId,
        suggestedDecision: suggestedDecisionForLane(laneId),
        suggestedDecisionOptions: suggestedDecisionOptionsForLane(laneId),
        acceptedStatuses: ACCEPTANCE_STATUSES,
        page: reviewHtmlPath ? pathToFileURL(reviewHtmlPath).href : null,
        deliveryStatus: reviewPack.delivery?.status || lane.status || null,
        temporalStatus: lane.temporalStatus || (reviewPack.temporal ? 'available' : null),
        candidate,
        videos,
        decision: 'pending',
        notes: '',
        checklist: (reviewPack.checklist || []).map((text, index) => ({
            index,
            checked: false,
            text
        }))
    };
}

async function readJsonIfExists(filePath) {
    if (!filePath) return null;
    try {
        return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
    } catch {
        return null;
    }
}

async function writeDecisionTemplates({ dashboardDetail = {}, templateDir = DEFAULT_DECISION_TEMPLATE_DIR } = {}) {
    const resolvedTemplateDir = path.resolve(templateDir);
    await mkdir(resolvedTemplateDir, { recursive: true });
    const lanes = Array.isArray(dashboardDetail.lanes) ? dashboardDetail.lanes : [];
    const templates = [];
    for (const lane of lanes) {
        const reviewPack = await readJsonIfExists(getAssetPath(lane, 'reviewPack'));
        if (!reviewPack) continue;
        const outputPath = lane.decisionTemplatePath || path.join(resolvedTemplateDir, `${lane.id}.decision.template.json`);
        const template = createPendingDecisionTemplate({ lane, reviewPack, outputPath });
        await writeFile(outputPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
        lane.decisionTemplatePath = path.resolve(outputPath);
        templates.push({
            laneId: lane.id,
            path: path.resolve(outputPath),
            checklistItems: template.checklist.length,
            videos: template.videos.length,
            decision: template.decision
        });
    }
    return templates;
}

export function createVideoDeliveryBundleSummary({
    dashboardReport,
    goalReport,
    dashboardDetail,
    dashboardScreenshot = null,
    quickstart = null,
    verification = null
} = {}) {
    const lanes = goalReport?.lanes || [];
    const acceptance = createAcceptancePlan({ dashboardDetail, goalReport });
    return {
        generatedAt: new Date().toISOString(),
        status: goalReport?.status || 'unknown',
        complete: goalReport?.complete === true,
        nextAction: goalReport?.nextAction || null,
        blockers: goalReport?.blockers || [],
        acceptance,
        decisionTemplates: (dashboardDetail?.decisionTemplates || []).map((item) => ({
            laneId: item.laneId,
            path: item.path,
            checklistItems: item.checklistItems,
            videos: item.videos,
            decision: item.decision
        })),
        dashboard: {
            outputPath: dashboardReport?.outputPath || null,
            reportPath: dashboardReport?.reportPath || null,
            screenshotPath: dashboardScreenshot?.outputPath || null,
            screenshotReportPath: dashboardScreenshot?.reportPath || null,
            screenshotGeneratedAt: dashboardScreenshot?.generatedAt || null,
            lanes: dashboardReport?.lanes ?? null,
            readyLanes: dashboardReport?.readyLanes ?? null,
            missingAssets: dashboardReport?.missingAssets ?? null
        },
        goalStatus: {
            outputPath: goalReport?.outputPath || null,
            markdownPath: goalReport?.markdownPath || null,
            requirementCount: goalReport?.requirements?.length || 0,
            satisfiedRequirements: (goalReport?.requirements || []).filter((item) => item.satisfied).length
        },
        quickstart: {
            outputPath: quickstart?.outputPath || null,
            jsonPath: quickstart?.jsonPath || null,
            htmlPath: quickstart?.htmlPath || null,
            thumbnailSheetPath: quickstart?.thumbnailSheetPath || null,
            thumbnailSheetJsonPath: quickstart?.thumbnailSheetJsonPath || null,
            screenshotPath: quickstart?.screenshotPath || null,
            screenshotReportPath: quickstart?.screenshotReportPath || null,
            screenshotGeneratedAt: quickstart?.screenshotGeneratedAt || null
        },
        verification: {
            status: verification?.status || null,
            outputPath: verification?.outputPath || null,
            markdownPath: verification?.markdownPath || null,
            passed: verification?.summary?.passed ?? null,
            checks: verification?.summary?.checks ?? null,
            failed: verification?.summary?.failed ?? null
        },
        lanes: lanes.map((lane) => ({
            id: lane.id,
            status: lane.status,
            temporalStatus: lane.temporalStatus,
            reviewStatus: lane.reviewStatus,
            checklist: lane.checklist,
            nextAction: lane.nextAction,
            missingAssets: lane.missingAssets
        }))
    };
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

export function renderVideoDeliveryBundleMarkdown(report) {
    const lines = [];
    lines.push('# Video Delivery Bundle');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.status}`);
    lines.push(`Next action: ${report.nextAction || '-'}`);
    lines.push(`Blockers: ${report.blockers.length ? report.blockers.join(', ') : '-'}`);
    lines.push('');
    lines.push('| Artifact | Value |');
    lines.push('|---|---|');
    lines.push(`| Dashboard HTML | ${escapeCell(report.dashboard.outputPath)} |`);
    lines.push(`| Dashboard JSON | ${escapeCell(report.dashboard.reportPath)} |`);
    lines.push(`| Dashboard screenshot | ${escapeCell(report.dashboard.screenshotPath)} |`);
    lines.push(`| Dashboard screenshot JSON | ${escapeCell(report.dashboard.screenshotReportPath)} |`);
    lines.push(`| Acceptance quickstart | ${escapeCell(report.quickstart?.outputPath)} |`);
    lines.push(`| Acceptance quickstart JSON | ${escapeCell(report.quickstart?.jsonPath)} |`);
    lines.push(`| Acceptance quickstart HTML | ${escapeCell(report.quickstart?.htmlPath)} |`);
    lines.push(`| Acceptance thumbnail sheet | ${escapeCell(report.quickstart?.thumbnailSheetPath)} |`);
    lines.push(`| Acceptance thumbnail sheet JSON | ${escapeCell(report.quickstart?.thumbnailSheetJsonPath)} |`);
    lines.push(`| Acceptance quickstart screenshot | ${escapeCell(report.quickstart?.screenshotPath)} |`);
    lines.push(`| Acceptance quickstart screenshot JSON | ${escapeCell(report.quickstart?.screenshotReportPath)} |`);
    lines.push(`| Bundle verification | ${escapeCell(report.verification?.outputPath)} |`);
    lines.push(`| Bundle verification Markdown | ${escapeCell(report.verification?.markdownPath)} |`);
    lines.push(`| Bundle verification status | ${escapeCell(report.verification?.status)} (${escapeCell(report.verification?.passed)}/${escapeCell(report.verification?.checks)} checks, failed ${escapeCell(report.verification?.failed)}) |`);
    lines.push(`| Goal JSON | ${escapeCell(report.goalStatus.outputPath)} |`);
    lines.push(`| Goal Markdown | ${escapeCell(report.goalStatus.markdownPath)} |`);
    lines.push(`| Ready lanes | ${escapeCell(report.dashboard.readyLanes)}/${escapeCell(report.dashboard.lanes)} |`);
    lines.push(`| Missing assets | ${escapeCell(report.dashboard.missingAssets)} |`);
    lines.push(`| Requirements | ${escapeCell(report.goalStatus.satisfiedRequirements)}/${escapeCell(report.goalStatus.requirementCount)} |`);
    lines.push(`| Decision templates | ${escapeCell(report.decisionTemplates?.length || 0)} |`);
    lines.push('');
    lines.push('## Human Acceptance Gate');
    lines.push('');
    lines.push(`Status: ${report.acceptance?.status || '-'}`);
    lines.push(`Required: ${report.acceptance?.requiredForCompletion || '-'}`);
    lines.push('Template use: edit `decision`, `notes`, and every relevant `checklist[].checked` value after human review before running the command.');
    lines.push('');
    lines.push('| Lane | Current review | Checklist | Suggested decision | Template | Review page | Decision command |');
    lines.push('|---|---|---:|---|---|---|---|');
    for (const lane of report.acceptance?.lanes || []) {
        const checklist = lane.checklist ? `${lane.checklist.checked}/${lane.checklist.total}` : '-';
        lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(lane.currentStatus)} | ${escapeCell(checklist)} | ${escapeCell(lane.suggestedDecision)} | ${escapeCell(lane.decisionTemplatePath)} | ${escapeCell(lane.reviewHtmlPath)} | ${escapeCell(lane.command)} |`);
    }
    lines.push('');
    lines.push('## Lanes');
    lines.push('');
    lines.push('| Lane | Status | Temporal | Review | Checklist | Next | Missing assets |');
    lines.push('|---|---|---|---|---:|---|---:|');
    for (const lane of report.lanes) {
        const checklist = lane.checklist ? `${lane.checklist.checked}/${lane.checklist.total}` : '-';
        lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(lane.status)} | ${escapeCell(lane.temporalStatus)} | ${escapeCell(lane.reviewStatus)} | ${escapeCell(checklist)} | ${escapeCell(lane.nextAction)} | ${escapeCell(lane.missingAssets)} |`);
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function writeBundleReport({ report, outputPath, markdownPath }) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
    await writeFile(path.resolve(markdownPath), renderVideoDeliveryBundleMarkdown(report), 'utf8');
}

export async function createVideoDeliveryBundleReport({
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    dashboardOutputPath = DEFAULT_DASHBOARD_OUTPUT_PATH,
    dashboardReportPath = DEFAULT_DASHBOARD_REPORT_PATH,
    dashboardScreenshotPath = DEFAULT_DASHBOARD_SCREENSHOT_PATH,
    dashboardScreenshotReportPath = DEFAULT_DASHBOARD_SCREENSHOT_REPORT_PATH,
    refreshDashboardScreenshot = true,
    dashboardScreenshotGenerator = createVideoReviewScreenshot,
    refreshQuickstartScreenshot = true,
    quickstartScreenshotGenerator = dashboardScreenshotGenerator,
    goalOutputPath = DEFAULT_GOAL_OUTPUT_PATH,
    goalMarkdownPath = DEFAULT_GOAL_MARKDOWN_PATH,
    decisionTemplateDir = DEFAULT_DECISION_TEMPLATE_DIR,
    quickstartOutputPath = DEFAULT_QUICKSTART_OUTPUT_PATH,
    quickstartJsonPath = DEFAULT_QUICKSTART_JSON_PATH,
    quickstartHtmlPath = DEFAULT_QUICKSTART_HTML_PATH,
    quickstartScreenshotPath = DEFAULT_QUICKSTART_SCREENSHOT_PATH,
    quickstartScreenshotReportPath = DEFAULT_QUICKSTART_SCREENSHOT_REPORT_PATH,
    generateReviewThumbnails = false,
    reviewThumbnailDir = DEFAULT_REVIEW_THUMBNAIL_DIR,
    reviewThumbnailGenerator = undefined,
    generateReviewThumbnailSheet = false,
    reviewThumbnailSheetPath = DEFAULT_REVIEW_THUMBNAIL_SHEET_PATH,
    reviewThumbnailSheetJsonPath = DEFAULT_REVIEW_THUMBNAIL_SHEET_JSON_PATH,
    reviewThumbnailSheetGenerator = createVideoReviewThumbnailSheet,
    refreshVerification = true,
    verificationOutputPath = DEFAULT_VERIFICATION_OUTPUT_PATH,
    verificationMarkdownPath = DEFAULT_VERIFICATION_MARKDOWN_PATH,
    verifyMedia = true,
    dashboardLanes = undefined
} = {}) {
    const lanesWithDecisionTemplates = dashboardLanes
        ? dashboardLanes.map((lane) => ({
            ...lane,
            decisionTemplatePath: lane.decisionTemplatePath || path.join(path.resolve(decisionTemplateDir), `${lane.id}.decision.template.json`)
        }))
        : undefined;
    const initialDashboardReport = await createVideoDeliveryDashboard({
        outputPath: dashboardOutputPath,
        reportPath: dashboardReportPath,
        ...(lanesWithDecisionTemplates ? { lanes: lanesWithDecisionTemplates } : {})
    });
    const dashboardDetail = JSON.parse(await readFile(path.resolve(dashboardReportPath), 'utf8'));
    dashboardDetail.decisionTemplates = await writeDecisionTemplates({
        dashboardDetail,
        templateDir: decisionTemplateDir
    });
    const dashboardReport = await createVideoDeliveryDashboard({
        outputPath: dashboardOutputPath,
        reportPath: dashboardReportPath,
        ...(lanesWithDecisionTemplates ? { lanes: lanesWithDecisionTemplates } : {})
    });
    const dashboardScreenshot = refreshDashboardScreenshot
        ? await dashboardScreenshotGenerator({
            htmlPath: dashboardOutputPath,
            outputPath: dashboardScreenshotPath,
            reportPath: dashboardScreenshotReportPath
        })
        : null;
    const goalReport = await createVideoGoalStatusReport({
        dashboardReportPath,
        outputPath: goalOutputPath,
        markdownPath: goalMarkdownPath
    });
    const finalDashboardDetail = JSON.parse(await readFile(path.resolve(dashboardReportPath), 'utf8'));
    finalDashboardDetail.decisionTemplates = dashboardDetail.decisionTemplates;
    for (const lane of finalDashboardDetail.lanes || []) {
        const template = dashboardDetail.decisionTemplates.find((item) => item.laneId === lane.id);
        if (template) lane.decisionTemplatePath = template.path;
    }
    let report = {
        outputPath: path.resolve(outputPath),
        markdownPath: path.resolve(markdownPath),
        initialDashboard: {
            outputPath: initialDashboardReport.outputPath,
            reportPath: initialDashboardReport.reportPath
        },
        ...createVideoDeliveryBundleSummary({
            dashboardReport,
            goalReport,
            dashboardDetail: finalDashboardDetail,
            dashboardScreenshot,
            quickstart: null,
            verification: null
        })
    };
    const quickstart = await createVideoAcceptanceQuickstart({
        bundleReport: report,
        dashboardReport: finalDashboardDetail,
        outputPath: quickstartOutputPath,
        jsonPath: quickstartJsonPath,
        htmlPath: quickstartHtmlPath,
        generateReviewThumbnails,
        reviewThumbnailDir,
        ...(generateReviewThumbnailSheet ? { reviewThumbnailSheetPath, reviewThumbnailSheetJsonPath } : {}),
        ...(reviewThumbnailGenerator ? { reviewThumbnailGenerator } : {})
    });
    const reviewThumbnailSheet = generateReviewThumbnailSheet
        ? await reviewThumbnailSheetGenerator({
            quickstartPath: quickstartJsonPath,
            outputPath: reviewThumbnailSheetPath,
            jsonPath: reviewThumbnailSheetJsonPath
        })
        : null;
    const quickstartScreenshot = refreshQuickstartScreenshot
        ? await quickstartScreenshotGenerator({
            htmlPath: quickstartHtmlPath,
            outputPath: quickstartScreenshotPath,
            reportPath: quickstartScreenshotReportPath,
            width: 1440,
            height: 1800,
            fullPage: true
        })
        : null;
    report = {
        ...report,
        quickstart: {
            outputPath: quickstart.outputPath,
            jsonPath: quickstart.jsonPath,
            htmlPath: quickstart.htmlPath,
            thumbnailSheetPath: reviewThumbnailSheet?.outputPath || null,
            thumbnailSheetJsonPath: reviewThumbnailSheet?.jsonPath || null,
            screenshotPath: quickstartScreenshot?.outputPath || null,
            screenshotReportPath: quickstartScreenshot?.reportPath || null,
            screenshotGeneratedAt: quickstartScreenshot?.generatedAt || null
        }
    };
    await writeBundleReport({ report, outputPath, markdownPath });
    const verification = refreshVerification
        ? await createVideoDeliveryBundleVerification({
            bundlePath: outputPath,
            dashboardPath: dashboardReportPath,
            quickstartPath: quickstartJsonPath,
            outputPath: verificationOutputPath,
            markdownPath: verificationMarkdownPath,
            verifyMedia
        })
        : null;
    const verifiedGoalReport = verification
        ? await createVideoGoalStatusReport({
            dashboardReportPath,
            verificationReportPath: verification.outputPath,
            outputPath: goalOutputPath,
            markdownPath: goalMarkdownPath
        })
        : goalReport;
    report = {
        outputPath: path.resolve(outputPath),
        markdownPath: path.resolve(markdownPath),
        initialDashboard: report.initialDashboard,
        ...createVideoDeliveryBundleSummary({
            dashboardReport,
            goalReport: verifiedGoalReport,
            dashboardDetail: finalDashboardDetail,
            dashboardScreenshot,
            quickstart: {
                ...quickstart,
                thumbnailSheetPath: reviewThumbnailSheet?.outputPath || null,
                thumbnailSheetJsonPath: reviewThumbnailSheet?.jsonPath || null,
                screenshotPath: quickstartScreenshot?.outputPath || null,
                screenshotReportPath: quickstartScreenshot?.reportPath || null,
                screenshotGeneratedAt: quickstartScreenshot?.generatedAt || null
            },
            verification
        })
    };
    const finalQuickstart = await createVideoAcceptanceQuickstart({
        bundleReport: report,
        dashboardReport: finalDashboardDetail,
        outputPath: quickstartOutputPath,
        jsonPath: quickstartJsonPath,
        htmlPath: quickstartHtmlPath,
        generateReviewThumbnails,
        reviewThumbnailDir,
        ...(generateReviewThumbnailSheet ? { reviewThumbnailSheetPath, reviewThumbnailSheetJsonPath } : {}),
        ...(reviewThumbnailGenerator ? { reviewThumbnailGenerator } : {})
    });
    const finalReviewThumbnailSheet = generateReviewThumbnailSheet
        ? await reviewThumbnailSheetGenerator({
            quickstartPath: quickstartJsonPath,
            outputPath: reviewThumbnailSheetPath,
            jsonPath: reviewThumbnailSheetJsonPath
        })
        : reviewThumbnailSheet;
    const finalQuickstartScreenshot = refreshQuickstartScreenshot
        ? await quickstartScreenshotGenerator({
            htmlPath: quickstartHtmlPath,
            outputPath: quickstartScreenshotPath,
            reportPath: quickstartScreenshotReportPath,
            width: 1440,
            height: 1800,
            fullPage: true
        })
        : quickstartScreenshot;
    report.quickstart = {
        outputPath: finalQuickstart.outputPath,
        jsonPath: finalQuickstart.jsonPath,
        htmlPath: finalQuickstart.htmlPath,
        thumbnailSheetPath: finalReviewThumbnailSheet?.outputPath || null,
        thumbnailSheetJsonPath: finalReviewThumbnailSheet?.jsonPath || null,
        screenshotPath: finalQuickstartScreenshot?.outputPath || null,
        screenshotReportPath: finalQuickstartScreenshot?.reportPath || null,
        screenshotGeneratedAt: finalQuickstartScreenshot?.generatedAt || null
    };
    await writeBundleReport({ report, outputPath, markdownPath });
    if (refreshVerification) {
        const finalVerification = await createVideoDeliveryBundleVerification({
            bundlePath: outputPath,
            dashboardPath: dashboardReportPath,
            quickstartPath: quickstartJsonPath,
            outputPath: verificationOutputPath,
            markdownPath: verificationMarkdownPath,
            verifyMedia
        });
        const finalGoalReport = await createVideoGoalStatusReport({
            dashboardReportPath,
            verificationReportPath: finalVerification.outputPath,
            outputPath: goalOutputPath,
            markdownPath: goalMarkdownPath
        });
        report = {
            outputPath: path.resolve(outputPath),
            markdownPath: path.resolve(markdownPath),
            initialDashboard: report.initialDashboard,
            ...createVideoDeliveryBundleSummary({
                dashboardReport,
                goalReport: finalGoalReport,
                dashboardDetail: finalDashboardDetail,
                dashboardScreenshot,
                quickstart: {
                    ...finalQuickstart,
                    thumbnailSheetPath: finalReviewThumbnailSheet?.outputPath || null,
                    thumbnailSheetJsonPath: finalReviewThumbnailSheet?.jsonPath || null,
                    screenshotPath: finalQuickstartScreenshot?.outputPath || null,
                    screenshotReportPath: finalQuickstartScreenshot?.reportPath || null,
                    screenshotGeneratedAt: finalQuickstartScreenshot?.generatedAt || null
                },
                verification: finalVerification
            })
        };
        await writeBundleReport({ report, outputPath, markdownPath });
    }
    return report;
}

function parseArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        dashboardOutputPath: DEFAULT_DASHBOARD_OUTPUT_PATH,
        dashboardReportPath: DEFAULT_DASHBOARD_REPORT_PATH,
        dashboardScreenshotPath: DEFAULT_DASHBOARD_SCREENSHOT_PATH,
        dashboardScreenshotReportPath: DEFAULT_DASHBOARD_SCREENSHOT_REPORT_PATH,
        refreshDashboardScreenshot: true,
        refreshQuickstartScreenshot: true,
        goalOutputPath: DEFAULT_GOAL_OUTPUT_PATH,
        goalMarkdownPath: DEFAULT_GOAL_MARKDOWN_PATH,
        decisionTemplateDir: DEFAULT_DECISION_TEMPLATE_DIR,
        quickstartOutputPath: DEFAULT_QUICKSTART_OUTPUT_PATH,
        quickstartJsonPath: DEFAULT_QUICKSTART_JSON_PATH,
        quickstartHtmlPath: DEFAULT_QUICKSTART_HTML_PATH,
        quickstartScreenshotPath: DEFAULT_QUICKSTART_SCREENSHOT_PATH,
        quickstartScreenshotReportPath: DEFAULT_QUICKSTART_SCREENSHOT_REPORT_PATH,
        generateReviewThumbnails: true,
        reviewThumbnailDir: DEFAULT_REVIEW_THUMBNAIL_DIR,
        generateReviewThumbnailSheet: true,
        reviewThumbnailSheetPath: DEFAULT_REVIEW_THUMBNAIL_SHEET_PATH,
        reviewThumbnailSheetJsonPath: DEFAULT_REVIEW_THUMBNAIL_SHEET_JSON_PATH,
        refreshVerification: true,
        verificationOutputPath: DEFAULT_VERIFICATION_OUTPUT_PATH,
        verificationMarkdownPath: DEFAULT_VERIFICATION_MARKDOWN_PATH,
        verifyMedia: true,
        failOnIncomplete: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
        } else if (arg === '--dashboard-output') {
            parsed.dashboardOutputPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_OUTPUT_PATH);
        } else if (arg === '--dashboard-report') {
            parsed.dashboardReportPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_REPORT_PATH);
        } else if (arg === '--dashboard-screenshot-output') {
            parsed.dashboardScreenshotPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_SCREENSHOT_PATH);
        } else if (arg === '--dashboard-screenshot-report') {
            parsed.dashboardScreenshotReportPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_SCREENSHOT_REPORT_PATH);
        } else if (arg === '--skip-dashboard-screenshot') {
            parsed.refreshDashboardScreenshot = false;
        } else if (arg === '--quickstart-screenshot-output') {
            parsed.quickstartScreenshotPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_SCREENSHOT_PATH);
        } else if (arg === '--quickstart-screenshot-report') {
            parsed.quickstartScreenshotReportPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_SCREENSHOT_REPORT_PATH);
        } else if (arg === '--skip-quickstart-screenshot') {
            parsed.refreshQuickstartScreenshot = false;
        } else if (arg === '--goal-output') {
            parsed.goalOutputPath = path.resolve(argv[++i] || DEFAULT_GOAL_OUTPUT_PATH);
        } else if (arg === '--goal-markdown') {
            parsed.goalMarkdownPath = path.resolve(argv[++i] || DEFAULT_GOAL_MARKDOWN_PATH);
        } else if (arg === '--decision-template-dir') {
            parsed.decisionTemplateDir = path.resolve(argv[++i] || DEFAULT_DECISION_TEMPLATE_DIR);
        } else if (arg === '--quickstart-output') {
            parsed.quickstartOutputPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_OUTPUT_PATH);
        } else if (arg === '--quickstart-json') {
            parsed.quickstartJsonPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_JSON_PATH);
        } else if (arg === '--quickstart-html') {
            parsed.quickstartHtmlPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_HTML_PATH);
        } else if (arg === '--review-thumbnail-dir') {
            parsed.reviewThumbnailDir = path.resolve(argv[++i] || DEFAULT_REVIEW_THUMBNAIL_DIR);
        } else if (arg === '--skip-review-thumbnails') {
            parsed.generateReviewThumbnails = false;
            parsed.generateReviewThumbnailSheet = false;
        } else if (arg === '--review-thumbnail-sheet') {
            parsed.reviewThumbnailSheetPath = path.resolve(argv[++i] || DEFAULT_REVIEW_THUMBNAIL_SHEET_PATH);
        } else if (arg === '--review-thumbnail-sheet-json') {
            parsed.reviewThumbnailSheetJsonPath = path.resolve(argv[++i] || DEFAULT_REVIEW_THUMBNAIL_SHEET_JSON_PATH);
        } else if (arg === '--skip-review-thumbnail-sheet') {
            parsed.generateReviewThumbnailSheet = false;
        } else if (arg === '--skip-verification') {
            parsed.refreshVerification = false;
        } else if (arg === '--verification-output') {
            parsed.verificationOutputPath = path.resolve(argv[++i] || DEFAULT_VERIFICATION_OUTPUT_PATH);
        } else if (arg === '--verification-markdown') {
            parsed.verificationMarkdownPath = path.resolve(argv[++i] || DEFAULT_VERIFICATION_MARKDOWN_PATH);
        } else if (arg === '--skip-media-probe') {
            parsed.verifyMedia = false;
        } else if (arg === '--fail-on-incomplete') {
            parsed.failOnIncomplete = true;
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/create-video-delivery-bundle.js [--fail-on-incomplete] [--skip-dashboard-screenshot] [--skip-review-thumbnails] [--skip-review-thumbnail-sheet]

Default output:
  .artifacts/video-delivery-bundle/latest-report.json
  .artifacts/video-delivery-bundle/latest-report.md
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoDeliveryBundleReport(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`next: ${report.nextAction || '-'}`);
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            if (report.dashboard?.screenshotPath) console.log(`dashboard screenshot: ${report.dashboard.screenshotPath}`);
            if (report.quickstart?.outputPath) console.log(`acceptance quickstart: ${report.quickstart.outputPath}`);
            if (report.quickstart?.htmlPath) console.log(`acceptance quickstart html: ${report.quickstart.htmlPath}`);
            if (report.quickstart?.thumbnailSheetPath) console.log(`acceptance thumbnail sheet: ${report.quickstart.thumbnailSheetPath}`);
            if (report.quickstart?.screenshotPath) console.log(`acceptance quickstart screenshot: ${report.quickstart.screenshotPath}`);
            if (report.verification?.outputPath) console.log(`verification: ${report.verification.status} (${report.verification.passed}/${report.verification.checks}) ${report.verification.outputPath}`);
            if (args.failOnIncomplete && report.complete !== true) {
                process.exitCode = 1;
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
