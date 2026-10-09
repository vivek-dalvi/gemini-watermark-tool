import path from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createVideoReviewDecisionSummary } from './create-video-review-decision-report.js';

const DEFAULT_BUNDLE_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-report.json');
const DEFAULT_DASHBOARD_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.json');
const DEFAULT_QUICKSTART_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-verification-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-verification-report.md');
const execFileAsync = promisify(execFile);

async function pathExists(filePath) {
    if (!filePath) return false;
    try {
        await access(path.resolve(filePath), constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

async function readJsonIfExists(filePath) {
    if (!filePath || !(await pathExists(filePath))) return null;
    try {
        return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
    } catch {
        return null;
    }
}

async function readTextIfExists(filePath) {
    if (!filePath || !(await pathExists(filePath))) return '';
    return readFile(path.resolve(filePath), 'utf8');
}

async function isReadablePng(filePath) {
    if (!filePath || !(await pathExists(filePath))) return false;
    try {
        const bytes = await readFile(path.resolve(filePath));
        return bytes.length > 8 &&
            bytes[0] === 0x89 &&
            bytes[1] === 0x50 &&
            bytes[2] === 0x4e &&
            bytes[3] === 0x47 &&
            bytes[4] === 0x0d &&
            bytes[5] === 0x0a &&
            bytes[6] === 0x1a &&
            bytes[7] === 0x0a;
    } catch {
        return false;
    }
}

function parseRate(value) {
    const [num, den] = String(value || '').split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return num / den;
    const direct = Number(value);
    return Number.isFinite(direct) ? direct : null;
}

async function probeVideoFile(filePath) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,duration:format=duration',
        '-of', 'json',
        path.resolve(filePath)
    ], { windowsHide: true });
    const data = JSON.parse(stdout || '{}');
    const stream = data.streams?.[0] || {};
    const duration = Number(stream.duration ?? data.format?.duration);
    const fps = parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate);
    return {
        width: Number(stream.width) || null,
        height: Number(stream.height) || null,
        duration: Number.isFinite(duration) ? duration : null,
        fps
    };
}

function addCheck(checks, { id, status, message, path: filePath = null, laneId = null }) {
    checks.push({
        id,
        status,
        message,
        path: filePath,
        laneId
    });
}

async function addPathCheck(checks, { id, label, path: filePath, laneId = null }) {
    addCheck(checks, {
        id,
        status: await pathExists(filePath) ? 'pass' : 'fail',
        message: filePath ? `${label} exists` : `${label} path is missing`,
        path: filePath || null,
        laneId
    });
}

function laneById(items = []) {
    return new Map(items.map((item) => [item.id || item.laneId, item]));
}

function tokenizeCommand(command = '') {
    const tokens = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    for (const match of String(command || '').matchAll(pattern)) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return tokens;
}

function getCommandArg(tokens = [], flag) {
    const index = tokens.indexOf(flag);
    return index >= 0 ? tokens[index + 1] || null : null;
}

function normalizeForCompare(filePath) {
    return filePath ? path.resolve(filePath).toLowerCase() : null;
}

function commandPathMatches(actual, expected) {
    return Boolean(actual && expected && normalizeForCompare(actual) === normalizeForCompare(expected));
}

function urlMatchesFilePath(actualUrl, expectedPath) {
    return Boolean(actualUrl && expectedPath && actualUrl === pathToFileURL(path.resolve(expectedPath)).href);
}

function acceptedStatusesCover(actual = [], expectedSet = new Set()) {
    const actualSet = new Set(Array.isArray(actual) ? actual.filter(Boolean) : []);
    return expectedSet.size > 0 && [...expectedSet].every((status) => actualSet.has(status));
}

function hasTemplateInstructions(value) {
    const text = String(value || '').toLowerCase();
    return text.includes('decision') && text.includes('checklist');
}

function formatEvidenceSummary(evidence = null) {
    if (!evidence) return null;
    return `${evidence.reports} reports, ${evidence.comparedCases} cases, ${evidence.improvedCases} improved, ${evidence.materialRegressedCases} material, ${evidence.warningRegressedCases} warning`;
}

function evidenceMatches(actual = null, expected = null) {
    if (!actual && !expected) return true;
    if (!actual || !expected) return false;
    return ['reports', 'comparedCases', 'improvedCases', 'materialRegressedCases', 'warningRegressedCases']
        .every((key) => Number(actual[key]) === Number(expected[key]));
}

function normalizeDiagnosticLinks(links = []) {
    return (Array.isArray(links) ? links : []).map((item) => ({
        label: item?.label || 'Diagnostic',
        path: item?.path ? path.resolve(item.path) : null
    }));
}

function diagnosticLinksMatch(actual = [], expected = []) {
    const normalizedActual = normalizeDiagnosticLinks(actual);
    const normalizedExpected = normalizeDiagnosticLinks(expected);
    if (normalizedActual.length !== normalizedExpected.length) return false;
    return normalizedExpected.every((expectedItem, index) => {
        const actualItem = normalizedActual[index];
        return actualItem?.label === expectedItem.label &&
            commandPathMatches(actualItem?.path, expectedItem.path);
    });
}

async function diagnosticLinksExist(links = []) {
    const normalizedLinks = normalizeDiagnosticLinks(links);
    if (!normalizedLinks.length) return true;
    const results = await Promise.all(normalizedLinks.map((item) => pathExists(item.path)));
    return results.every(Boolean);
}

function diagnosticLinksVisible(text = '', links = []) {
    const normalizedLinks = normalizeDiagnosticLinks(links);
    if (!normalizedLinks.length) return true;
    return normalizedLinks.every((item) => text.includes(item.label));
}

function normalizeReviewVideos(videos = []) {
    return (Array.isArray(videos) ? videos : []).map((video) => ({
        caseId: video?.caseId || null,
        kind: video?.kind || null,
        src: video?.src ? path.resolve(video.src) : null,
        currentTime: Number.isFinite(Number(video?.currentTime)) ? Number(video.currentTime) : null
    }));
}

function reviewVideosMatch(actual = [], expected = []) {
    const normalizedActual = normalizeReviewVideos(actual);
    const normalizedExpected = normalizeReviewVideos(expected);
    if (normalizedActual.length !== normalizedExpected.length) return false;
    return normalizedExpected.every((expectedItem, index) => {
        const actualItem = normalizedActual[index];
        return actualItem?.caseId === expectedItem.caseId &&
            actualItem?.kind === expectedItem.kind &&
            commandPathMatches(actualItem?.src, expectedItem.src) &&
            actualItem?.currentTime === expectedItem.currentTime;
    });
}

function reviewVideosVisible(text = '', videos = []) {
    const normalizedVideos = normalizeReviewVideos(videos);
    if (!normalizedVideos.length) return true;
    return normalizedVideos.every((video) => {
        const filename = video.src ? path.basename(video.src) : '';
        return (video.caseId ? text.includes(video.caseId) : true) &&
            (video.kind ? text.includes(video.kind) : true) &&
            (filename ? text.includes(filename) || text.includes(video.src) : false);
    });
}

function reviewVideoThumbnailsVisible(text = '', videos = []) {
    const items = Array.isArray(videos) ? videos : [];
    if (!items.length) return true;
    return items.every((video) => {
        const filename = video?.thumbnailPath ? path.basename(video.thumbnailPath) : '';
        return filename && text.includes(filename);
    });
}

function suggestedActionMatchesPreview(action = null, lane = {}, preview = null) {
    if (!action || !preview) return false;
    return action.decision === lane.suggestedDecision &&
        action.status === preview.status &&
        action.nextAction === preview.nextAction &&
        action.acceptanceCommand === preview.acceptanceCommand;
}

function reviewPriorityForQuickLane(lane = {}) {
    let priority = 50;
    const candidate = lane.candidateDecision || '';
    const actionStatus = lane.suggestedAction?.status || '';
    if (candidate === 'promote-default-candidate' || actionStatus === 'accepted-for-default-review') {
        priority = 10;
    } else if (candidate === 'human-review') {
        priority = 30;
    } else if (candidate === 'candidate-aware-human-review') {
        priority = 40;
    }
    const evidence = lane.candidateEvidence || {};
    priority += Number(evidence.materialRegressedCases || 0) * 6;
    priority += Number(evidence.warningRegressedCases || 0) * 2;
    priority += (lane.diagnosticLinks || []).length > 0 ? 1 : 0;
    return priority;
}

function expectedReviewOrderForQuickstart(quickstart = {}) {
    return (quickstart.lanes || [])
        .map((lane, index) => ({
            laneId: lane.id,
            priority: reviewPriorityForQuickLane(lane),
            primaryVideo: normalizeReviewVideos(lane.reviewVideos || []).find((video) => video.kind === 'roi') ||
                normalizeReviewVideos(lane.reviewVideos || []).find((video) => video.kind === 'full') ||
                normalizeReviewVideos(lane.reviewVideos || [])[0] ||
                null,
            originalIndex: index
        }))
        .sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex)
        .map((item, index) => ({
            rank: index + 1,
            laneId: item.laneId,
            priority: item.priority,
            primaryVideo: item.primaryVideo
        }));
}

function reviewOrderMatches(actual = [], expected = []) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((expectedItem, index) => {
        const actualItem = actual[index];
        return actualItem?.rank === expectedItem.rank &&
            actualItem?.laneId === expectedItem.laneId &&
            Number(actualItem?.priority) === Number(expectedItem.priority) &&
            commandPathMatches(actualItem?.primaryVideo?.src, expectedItem.primaryVideo?.src);
    });
}

function reviewOrderPrimaryVideosVisible(text = '', expected = []) {
    return expected.every((item) => {
        const video = item.primaryVideo || {};
        const filename = video.src ? path.basename(video.src) : '';
        return !filename || text.includes(filename);
    });
}

function normalizeAcceptanceChecklist(items = []) {
    return (Array.isArray(items) ? items : []).map((item) => ({
        index: Number.isFinite(Number(item?.index)) ? Number(item.index) : null,
        checked: item?.checked === true,
        text: item?.text || ''
    }));
}

function acceptanceChecklistMatches(actual = [], expected = []) {
    const normalizedActual = normalizeAcceptanceChecklist(actual);
    const normalizedExpected = normalizeAcceptanceChecklist(expected);
    if (normalizedActual.length !== normalizedExpected.length) return false;
    return normalizedExpected.every((expectedItem, index) => {
        const actualItem = normalizedActual[index];
        return actualItem?.index === expectedItem.index &&
            actualItem?.checked === expectedItem.checked &&
            actualItem?.text === expectedItem.text;
    });
}

function acceptanceChecklistVisible(text = '', laneId = '', checklist = []) {
    const normalized = normalizeAcceptanceChecklist(checklist);
    if (!normalized.length) return true;
    return text.includes(laneId) && normalized.every((item) => item.text && text.includes(item.text));
}

function parseDecisionCommand(command = '') {
    const tokens = tokenizeCommand(command);
    return {
        tokens,
        isReviewDecisionCommand: tokens[0] === 'pnpm' && tokens[1] === 'report:video-review-decision' && tokens.includes('--'),
        decisionPath: getCommandArg(tokens, '--decision'),
        outputPath: getCommandArg(tokens, '--output'),
        markdownPath: getCommandArg(tokens, '--markdown')
    };
}

async function addScreenshotReportChecks(checks, {
    prefix,
    label,
    reportPath,
    expectedHtmlPath,
    expectedOutputPath,
    expectedFullPage = null
}) {
    const report = await readJsonIfExists(reportPath);
    addCheck(checks, {
        id: `${prefix}-screenshot-report-readable`,
        status: report ? 'pass' : 'fail',
        message: `${label} screenshot report ${report ? 'is readable' : 'is missing or invalid'}`,
        path: reportPath || null
    });
    addCheck(checks, {
        id: `${prefix}-screenshot-report-html-matches`,
        status: report && commandPathMatches(report.htmlPath, expectedHtmlPath) ? 'pass' : 'fail',
        message: `${label} screenshot htmlPath = ${report?.htmlPath || '-'}`,
        path: reportPath || null
    });
    addCheck(checks, {
        id: `${prefix}-screenshot-report-output-matches`,
        status: report && commandPathMatches(report.outputPath, expectedOutputPath) ? 'pass' : 'fail',
        message: `${label} screenshot outputPath = ${report?.outputPath || '-'}`,
        path: reportPath || null
    });
    addCheck(checks, {
        id: `${prefix}-screenshot-report-viewport-valid`,
        status: Number(report?.viewport?.width) > 0 && Number(report?.viewport?.height) > 0 ? 'pass' : 'fail',
        message: `${label} screenshot viewport = ${report?.viewport?.width || '-'}x${report?.viewport?.height || '-'}`,
        path: reportPath || null
    });
    addCheck(checks, {
        id: `${prefix}-screenshot-report-document-size-valid`,
        status: Number(report?.documentSize?.scrollWidth) > 0 &&
            Number(report?.documentSize?.scrollHeight) > 0 &&
            Number(report?.documentSize?.clientWidth) > 0 &&
            Number(report?.documentSize?.clientHeight) > 0
            ? 'pass'
            : 'fail',
        message: `${label} screenshot document size = ${report?.documentSize?.scrollWidth || '-'}x${report?.documentSize?.scrollHeight || '-'}`,
        path: reportPath || null
    });
    addCheck(checks, {
        id: `${prefix}-screenshot-report-generated-at-present`,
        status: typeof report?.generatedAt === 'string' && report.generatedAt.length > 0 ? 'pass' : 'fail',
        message: `${label} screenshot generatedAt = ${report?.generatedAt || '-'}`,
        path: reportPath || null
    });
    if (typeof expectedFullPage === 'boolean') {
        addCheck(checks, {
            id: `${prefix}-screenshot-report-fullpage-matches`,
            status: report && report.fullPage === expectedFullPage ? 'pass' : 'fail',
            message: `${label} screenshot fullPage = ${report?.fullPage ?? '-'}`,
            path: reportPath || null
        });
    }
}

function createCheckedDecisionTemplate(decisionTemplate = {}, decision) {
    const checklist = Array.isArray(decisionTemplate.checklist)
        ? decisionTemplate.checklist.map((item) => ({ ...item, checked: true }))
        : [];
    return {
        ...decisionTemplate,
        decision,
        checklist
    };
}

export async function createVideoDeliveryBundleVerification({
    bundlePath = DEFAULT_BUNDLE_PATH,
    dashboardPath = DEFAULT_DASHBOARD_PATH,
    quickstartPath = DEFAULT_QUICKSTART_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    failOnIncomplete = false,
    verifyMedia = true,
    videoProbe = probeVideoFile
} = {}) {
    const resolvedBundlePath = path.resolve(bundlePath);
    const resolvedDashboardPath = path.resolve(dashboardPath);
    const resolvedQuickstartPath = path.resolve(quickstartPath);
    const bundle = await readJson(resolvedBundlePath);
    const dashboard = await readJson(resolvedDashboardPath);
    const quickstart = await readJson(resolvedQuickstartPath);
    const checks = [];

    await addPathCheck(checks, { id: 'bundle-json', label: 'Bundle JSON', path: resolvedBundlePath });
    await addPathCheck(checks, { id: 'bundle-markdown', label: 'Bundle markdown', path: bundle.markdownPath });
    await addPathCheck(checks, { id: 'dashboard-html', label: 'Dashboard HTML', path: bundle.dashboard?.outputPath });
    await addPathCheck(checks, { id: 'dashboard-json', label: 'Dashboard JSON', path: bundle.dashboard?.reportPath });
    await addPathCheck(checks, { id: 'dashboard-screenshot', label: 'Dashboard screenshot', path: bundle.dashboard?.screenshotPath });
    await addPathCheck(checks, { id: 'dashboard-screenshot-json', label: 'Dashboard screenshot JSON', path: bundle.dashboard?.screenshotReportPath });
    await addPathCheck(checks, { id: 'quickstart-md', label: 'Acceptance quickstart markdown', path: bundle.quickstart?.outputPath });
    await addPathCheck(checks, { id: 'quickstart-json', label: 'Acceptance quickstart JSON', path: bundle.quickstart?.jsonPath });
    await addPathCheck(checks, { id: 'quickstart-html', label: 'Acceptance quickstart HTML', path: bundle.quickstart?.htmlPath });
    await addPathCheck(checks, { id: 'quickstart-screenshot', label: 'Acceptance quickstart screenshot', path: bundle.quickstart?.screenshotPath });
    await addPathCheck(checks, { id: 'quickstart-screenshot-json', label: 'Acceptance quickstart screenshot JSON', path: bundle.quickstart?.screenshotReportPath });
    if (bundle.quickstart?.thumbnailSheetPath) {
        await addPathCheck(checks, { id: 'quickstart-thumbnail-sheet', label: 'Acceptance thumbnail sheet', path: bundle.quickstart.thumbnailSheetPath });
    }
    if (bundle.quickstart?.thumbnailSheetJsonPath) {
        await addPathCheck(checks, { id: 'quickstart-thumbnail-sheet-json', label: 'Acceptance thumbnail sheet JSON', path: bundle.quickstart.thumbnailSheetJsonPath });
    }
    await addPathCheck(checks, { id: 'goal-json', label: 'Goal JSON', path: bundle.goalStatus?.outputPath });
    await addPathCheck(checks, { id: 'goal-markdown', label: 'Goal markdown', path: bundle.goalStatus?.markdownPath });
    await addScreenshotReportChecks(checks, {
        prefix: 'dashboard',
        label: 'Dashboard',
        reportPath: bundle.dashboard?.screenshotReportPath,
        expectedHtmlPath: bundle.dashboard?.outputPath,
        expectedOutputPath: bundle.dashboard?.screenshotPath,
        expectedFullPage: true
    });
    await addScreenshotReportChecks(checks, {
        prefix: 'quickstart',
        label: 'Acceptance quickstart',
        reportPath: bundle.quickstart?.screenshotReportPath,
        expectedHtmlPath: bundle.quickstart?.htmlPath,
        expectedOutputPath: bundle.quickstart?.screenshotPath,
        expectedFullPage: true
    });
    const dashboardHtml = await readTextIfExists(bundle.dashboard?.outputPath);
    const quickstartHtml = await readTextIfExists(bundle.quickstart?.htmlPath);
    const quickstartMarkdown = await readTextIfExists(bundle.quickstart?.outputPath);
    const thumbnailSheetReport = await readJsonIfExists(bundle.quickstart?.thumbnailSheetJsonPath);
    if (bundle.quickstart?.thumbnailSheetPath || quickstart.reviewThumbnailSheetPath) {
        addCheck(checks, {
            id: 'quickstart-thumbnail-sheet-png-readable',
            status: await isReadablePng(bundle.quickstart?.thumbnailSheetPath) ? 'pass' : 'fail',
            message: `Acceptance thumbnail sheet PNG = ${bundle.quickstart?.thumbnailSheetPath || '-'}`,
            path: bundle.quickstart?.thumbnailSheetPath || null
        });
        addCheck(checks, {
            id: 'quickstart-thumbnail-sheet-report-output-matches',
            status: thumbnailSheetReport && commandPathMatches(thumbnailSheetReport.outputPath, bundle.quickstart?.thumbnailSheetPath) ? 'pass' : 'fail',
            message: `Acceptance thumbnail sheet outputPath = ${thumbnailSheetReport?.outputPath || '-'}`,
            path: bundle.quickstart?.thumbnailSheetJsonPath || null
        });
        addCheck(checks, {
            id: 'quickstart-thumbnail-sheet-count-matches',
            status: Number(thumbnailSheetReport?.totalVideos) === Number(quickstart.reviewVideoCount || 0) &&
                Number(thumbnailSheetReport?.thumbnails) === Number(quickstart.reviewThumbnailCount || 0) &&
                Number(thumbnailSheetReport?.missingThumbnails) === 0
                ? 'pass'
                : 'fail',
            message: `Acceptance thumbnail sheet thumbnails = ${thumbnailSheetReport?.thumbnails ?? '-'}/${thumbnailSheetReport?.totalVideos ?? '-'}`,
            path: bundle.quickstart?.thumbnailSheetJsonPath || null
        });
        const sheetName = bundle.quickstart?.thumbnailSheetPath ? path.basename(bundle.quickstart.thumbnailSheetPath) : '';
        addCheck(checks, {
            id: 'quickstart-html-thumbnail-sheet-link-visible',
            status: sheetName && quickstartHtml.includes('Thumbnail Sheet') && quickstartHtml.includes(sheetName) ? 'pass' : 'fail',
            message: `Acceptance quickstart HTML thumbnail sheet link = ${sheetName || '-'}`,
            path: bundle.quickstart?.htmlPath || null
        });
        addCheck(checks, {
            id: 'quickstart-markdown-thumbnail-sheet-link-visible',
            status: bundle.quickstart?.thumbnailSheetPath && quickstartMarkdown.includes(bundle.quickstart.thumbnailSheetPath) ? 'pass' : 'fail',
            message: `Acceptance quickstart Markdown thumbnail sheet path = ${bundle.quickstart?.thumbnailSheetPath || '-'}`,
            path: bundle.quickstart?.outputPath || null
        });
    }

    const dashboardLaneMap = laneById(dashboard.lanes || []);
    const quickLaneMap = laneById(quickstart.lanes || []);
    const templateMap = laneById(bundle.decisionTemplates || []);
    const acceptanceLanes = bundle.acceptance?.lanes || [];
    const acceptedStatuses = new Set(bundle.acceptance?.acceptedStatuses || []);

    addCheck(checks, {
        id: 'bundle-status-incomplete-or-complete',
        status: ['incomplete', 'complete'].includes(bundle.status) ? 'pass' : 'fail',
        message: `Bundle status is ${bundle.status || '-'}`
    });
    addCheck(checks, {
        id: 'acceptance-status-known',
        status: ['pending-human-review', 'accepted'].includes(bundle.acceptance?.status) ? 'pass' : 'fail',
        message: `Acceptance status is ${bundle.acceptance?.status || '-'}`
    });
    addCheck(checks, {
        id: 'lane-counts-match',
        status: acceptanceLanes.length > 0
            && acceptanceLanes.length === (dashboard.lanes || []).length
            && acceptanceLanes.length === (quickstart.lanes || []).length
            ? 'pass'
            : 'fail',
        message: `lane counts bundle/dashboard/quickstart = ${acceptanceLanes.length}/${(dashboard.lanes || []).length}/${(quickstart.lanes || []).length}`
    });
    addCheck(checks, {
        id: 'dashboard-missing-assets-empty',
        status: (dashboard.missingAssets || []).length === 0 && Number(bundle.dashboard?.missingAssets || 0) === 0 ? 'pass' : 'fail',
        message: `missing assets = ${Number(bundle.dashboard?.missingAssets || 0)}`
    });
    const quickstartReviewVideoCount = (quickstart.lanes || [])
        .reduce((total, lane) => total + (Array.isArray(lane.reviewVideos) ? lane.reviewVideos.length : 0), 0);
    const expectedReviewOrder = expectedReviewOrderForQuickstart(quickstart);
    const quickstartReviewOrder = Array.isArray(quickstart.reviewOrder) ? quickstart.reviewOrder : [];
    addCheck(checks, {
        id: 'quickstart-review-order-matches-policy',
        path: resolvedQuickstartPath,
        status: reviewOrderMatches(quickstartReviewOrder, expectedReviewOrder) ? 'pass' : 'fail',
        message: `quickstart review order = ${quickstartReviewOrder.map((item) => item.laneId).join(', ') || '-'}`
    });
    addCheck(checks, {
        id: 'quickstart-html-review-order-visible',
        path: bundle.quickstart?.htmlPath || null,
        status: expectedReviewOrder.length === 0 || (
            quickstartHtml.includes('id="review-order"') &&
            expectedReviewOrder.every((item) => quickstartHtml.includes(`data-review-order-lane="${item.laneId}"`)) &&
            reviewOrderPrimaryVideosVisible(quickstartHtml, expectedReviewOrder)
        ) ? 'pass' : 'fail',
        message: `quickstart HTML review order lanes = ${expectedReviewOrder.map((item) => item.laneId).join(', ') || '-'}`
    });
    addCheck(checks, {
        id: 'quickstart-markdown-review-order-visible',
        path: bundle.quickstart?.outputPath || null,
        status: expectedReviewOrder.length === 0 || (
            quickstartMarkdown.includes('## Review Order') &&
            expectedReviewOrder.every((item) => quickstartMarkdown.includes(item.laneId)) &&
            reviewOrderPrimaryVideosVisible(quickstartMarkdown, expectedReviewOrder)
        ) ? 'pass' : 'fail',
        message: `quickstart markdown review order lanes = ${expectedReviewOrder.map((item) => item.laneId).join(', ') || '-'}`
    });
    addCheck(checks, {
        id: 'quickstart-html-review-playlist-present',
        path: bundle.quickstart?.htmlPath || null,
        status: quickstartReviewVideoCount === 0 || (quickstartHtml.includes('id="review-playlist"') && quickstartHtml.includes('Review Playlist')) ? 'pass' : 'fail',
        message: `quickstart HTML review playlist videos = ${quickstartReviewVideoCount}`
    });
    addCheck(checks, {
        id: 'quickstart-markdown-review-playlist-present',
        path: bundle.quickstart?.outputPath || null,
        status: quickstartReviewVideoCount === 0 || quickstartMarkdown.includes('## Review Playlist') ? 'pass' : 'fail',
        message: `quickstart markdown review playlist videos = ${quickstartReviewVideoCount}`
    });

    for (const lane of acceptanceLanes) {
        const dashboardLane = dashboardLaneMap.get(lane.id);
        const quickLane = quickLaneMap.get(lane.id);
        const template = templateMap.get(lane.id);
        addCheck(checks, {
            id: 'lane-dashboard-present',
            laneId: lane.id,
            status: dashboardLane ? 'pass' : 'fail',
            message: `${lane.id} exists in dashboard`
        });
        addCheck(checks, {
            id: 'lane-quickstart-present',
            laneId: lane.id,
            status: quickLane ? 'pass' : 'fail',
            message: `${lane.id} exists in quickstart`
        });
        addCheck(checks, {
            id: 'lane-template-listed',
            laneId: lane.id,
            status: template ? 'pass' : 'fail',
            message: `${lane.id} decision template is listed`
        });
        await addPathCheck(checks, { id: 'lane-review-html', label: `${lane.id} review HTML`, path: lane.reviewHtmlPath, laneId: lane.id });
        await addPathCheck(checks, { id: 'lane-decision-template', label: `${lane.id} decision template`, path: lane.decisionTemplatePath, laneId: lane.id });
        const decisionTemplate = lane.decisionTemplatePath && await pathExists(lane.decisionTemplatePath)
            ? await readJson(lane.decisionTemplatePath)
            : null;
        const reviewHtml = await readTextIfExists(lane.reviewHtmlPath);
        const videoKinds = new Set((decisionTemplate?.videos || []).map((video) => video.kind).filter(Boolean));
        const templateDecisionOptions = Array.isArray(decisionTemplate?.suggestedDecisionOptions)
            ? decisionTemplate.suggestedDecisionOptions.filter(Boolean)
            : [];
        const quickDecisionPreviews = Array.isArray(quickLane?.decisionPreviews)
            ? quickLane.decisionPreviews
            : [];
        const dashboardCandidateDecision = dashboardLane?.candidateDecision || null;
        const quickCandidateDecision = quickLane?.candidateDecision || null;
        const dashboardCandidateEvidence = dashboardLane?.candidateEvidence || null;
        const quickCandidateEvidence = quickLane?.candidateEvidence || null;
        const dashboardDiagnosticLinks = normalizeDiagnosticLinks(dashboardLane?.diagnosticLinks || []);
        const quickDiagnosticLinks = normalizeDiagnosticLinks(quickLane?.diagnosticLinks || []);
        const templateReviewVideos = normalizeReviewVideos(decisionTemplate?.videos || []);
        const quickReviewVideosRaw = Array.isArray(quickLane?.reviewVideos) ? quickLane.reviewVideos : [];
        const quickReviewVideos = normalizeReviewVideos(quickLane?.reviewVideos || []);
        const quickSuggestedAction = quickLane?.suggestedAction || null;
        const templateAcceptanceChecklist = normalizeAcceptanceChecklist(decisionTemplate?.checklist || []);
        const quickAcceptanceChecklist = normalizeAcceptanceChecklist(quickLane?.acceptanceChecklist || []);
        const evidenceText = formatEvidenceSummary(dashboardCandidateEvidence);
        const parsedCommand = parseDecisionCommand(lane.command || '');
        const optionReports = new Map(templateDecisionOptions.map((option) => [
            option,
            createVideoReviewDecisionSummary(createCheckedDecisionTemplate(decisionTemplate, option))
        ]));
        const acceptedOptionReports = [...optionReports.entries()].filter(([, report]) => acceptedStatuses.has(report.status));
        addCheck(checks, {
            id: 'lane-command-present',
            laneId: lane.id,
            status: lane.command?.includes('pnpm report:video-review-decision') ? 'pass' : 'fail',
            message: `${lane.id} decision command ${lane.command ? 'is present' : 'is missing'}`
        });
        addCheck(checks, {
            id: 'lane-command-script-valid',
            laneId: lane.id,
            status: parsedCommand.isReviewDecisionCommand ? 'pass' : 'fail',
            message: `${lane.id} decision command script ${parsedCommand.isReviewDecisionCommand ? 'is valid' : 'is invalid'}`
        });
        addCheck(checks, {
            id: 'lane-command-decision-matches-template',
            laneId: lane.id,
            status: commandPathMatches(parsedCommand.decisionPath, lane.decisionTemplatePath) ? 'pass' : 'fail',
            message: `${lane.id} command --decision = ${parsedCommand.decisionPath || '-'}`
        });
        addCheck(checks, {
            id: 'lane-command-output-matches-json',
            laneId: lane.id,
            status: commandPathMatches(parsedCommand.outputPath, lane.decisionJsonPath) ? 'pass' : 'fail',
            message: `${lane.id} command --output = ${parsedCommand.outputPath || '-'}`
        });
        addCheck(checks, {
            id: 'lane-command-markdown-matches-report',
            laneId: lane.id,
            status: commandPathMatches(parsedCommand.markdownPath, lane.decisionReportPath) ? 'pass' : 'fail',
            message: `${lane.id} command --markdown = ${parsedCommand.markdownPath || '-'}`
        });
        addCheck(checks, {
            id: 'lane-suggested-decision-present',
            laneId: lane.id,
            status: lane.suggestedDecision && (lane.suggestedDecisionOptions || []).includes(lane.suggestedDecision) ? 'pass' : 'fail',
            message: `${lane.id} suggested decision = ${lane.suggestedDecision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-decision-options-present',
            laneId: lane.id,
            status: templateDecisionOptions.length > 0 ? 'pass' : 'fail',
            message: `${lane.id} template decision options = ${templateDecisionOptions.join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-suggested-decision-present',
            laneId: lane.id,
            status: decisionTemplate?.suggestedDecision && templateDecisionOptions.includes(decisionTemplate.suggestedDecision) ? 'pass' : 'fail',
            message: `${lane.id} template suggested decision = ${decisionTemplate?.suggestedDecision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-path-matches-lane',
            laneId: lane.id,
            path: lane.decisionTemplatePath || null,
            status: commandPathMatches(decisionTemplate?.templatePath, lane.decisionTemplatePath) ? 'pass' : 'fail',
            message: `${lane.id} templatePath = ${decisionTemplate?.templatePath || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-page-matches-review',
            laneId: lane.id,
            path: lane.reviewHtmlPath || null,
            status: urlMatchesFilePath(decisionTemplate?.page, lane.reviewHtmlPath) ? 'pass' : 'fail',
            message: `${lane.id} template page = ${decisionTemplate?.page || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-instructions-present',
            laneId: lane.id,
            status: hasTemplateInstructions(decisionTemplate?.templateInstructions) ? 'pass' : 'fail',
            message: `${lane.id} template instructions ${decisionTemplate?.templateInstructions ? 'present' : 'missing'}`
        });
        addCheck(checks, {
            id: 'lane-template-accepted-statuses-cover-bundle',
            laneId: lane.id,
            status: acceptedStatusesCover(decisionTemplate?.acceptedStatuses, acceptedStatuses) ? 'pass' : 'fail',
            message: `${lane.id} template accepted statuses = ${(decisionTemplate?.acceptedStatuses || []).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-template-checklist-nonempty',
            laneId: lane.id,
            status: Array.isArray(decisionTemplate?.checklist) && decisionTemplate.checklist.length > 0 ? 'pass' : 'fail',
            message: `${lane.id} template checklist items = ${Array.isArray(decisionTemplate?.checklist) ? decisionTemplate.checklist.length : 0}`
        });
        const suggestedReport = optionReports.get(lane.suggestedDecision);
        addCheck(checks, {
            id: 'lane-suggested-decision-goal-compatible',
            laneId: lane.id,
            status: suggestedReport && acceptedStatuses.has(suggestedReport.status) && suggestedReport.checklist?.allChecked === true ? 'pass' : 'fail',
            message: `${lane.id} suggested decision ${lane.suggestedDecision || '-'} -> status=${suggestedReport?.status || '-'}, checklist=${suggestedReport?.checklist?.checked ?? '-'}/${suggestedReport?.checklist?.total ?? '-'}`
        });
        addCheck(checks, {
            id: 'lane-accepted-decision-option-available',
            laneId: lane.id,
            status: acceptedOptionReports.length > 0 ? 'pass' : 'fail',
            message: `${lane.id} accepted decision options = ${acceptedOptionReports.map(([option]) => option).join(', ') || '-'}`
        });
        for (const option of templateDecisionOptions) {
            const decisionReport = optionReports.get(option);
            const isRecognized = decisionReport.decision !== 'pending' && decisionReport.status !== 'invalid';
            addCheck(checks, {
                id: 'lane-template-decision-option-recognized',
                laneId: lane.id,
                status: isRecognized ? 'pass' : 'fail',
                message: `${lane.id} template decision option ${option} -> decision=${decisionReport.decision}, status=${decisionReport.status}`
            });
        }
        addCheck(checks, {
            id: 'lane-quickstart-decision-previews-present',
            laneId: lane.id,
            status: templateDecisionOptions.length > 0 && quickDecisionPreviews.length === templateDecisionOptions.length ? 'pass' : 'fail',
            message: `${lane.id} quickstart decision previews = ${quickDecisionPreviews.length}/${templateDecisionOptions.length}`
        });
        const suggestedPreview = quickDecisionPreviews.find((item) => item?.decision === lane.suggestedDecision) || null;
        addCheck(checks, {
            id: 'lane-quickstart-suggested-action-matches-preview',
            laneId: lane.id,
            status: suggestedActionMatchesPreview(quickSuggestedAction, lane, suggestedPreview) ? 'pass' : 'fail',
            message: `${lane.id} suggested action = ${quickSuggestedAction?.decision || '-'} / ${quickSuggestedAction?.status || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-suggested-action-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: quickSuggestedAction?.acceptanceCommand &&
                quickstartHtml.includes('id="suggested-review-actions"') &&
                quickstartHtml.includes(`data-suggested-action-lane="${lane.id}"`) &&
                quickstartHtml.includes(quickSuggestedAction.acceptanceCommand) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML suggested action ${quickSuggestedAction?.decision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-suggested-action-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: quickSuggestedAction?.acceptanceCommand &&
                quickstartMarkdown.includes('## Suggested Review Actions') &&
                quickstartMarkdown.includes(lane.id) &&
                quickstartMarkdown.includes(quickSuggestedAction.acceptanceCommand) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown suggested action ${quickSuggestedAction?.decision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-acceptance-checklist-matches-template',
            laneId: lane.id,
            status: acceptanceChecklistMatches(quickAcceptanceChecklist, templateAcceptanceChecklist) ? 'pass' : 'fail',
            message: `${lane.id} quickstart acceptance checklist = ${quickAcceptanceChecklist.length}/${templateAcceptanceChecklist.length}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-acceptance-checklist-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: quickstartHtml.includes('id="human-acceptance-checklist"') &&
                quickstartHtml.includes(`data-acceptance-checklist-lane="${lane.id}"`) &&
                acceptanceChecklistVisible(quickstartHtml, lane.id, templateAcceptanceChecklist) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML acceptance checklist items = ${templateAcceptanceChecklist.length}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-acceptance-checklist-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: quickstartMarkdown.includes('## Human Acceptance Checklist') &&
                acceptanceChecklistVisible(quickstartMarkdown, lane.id, templateAcceptanceChecklist) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown acceptance checklist items = ${templateAcceptanceChecklist.length}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-candidate-decision-matches-dashboard',
            laneId: lane.id,
            status: quickCandidateDecision === dashboardCandidateDecision ? 'pass' : 'fail',
            message: `${lane.id} quickstart candidate decision = ${quickCandidateDecision || '-'}, dashboard = ${dashboardCandidateDecision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-candidate-decision-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: !dashboardCandidateDecision || quickstartHtml.includes(dashboardCandidateDecision) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML candidate decision ${dashboardCandidateDecision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-candidate-decision-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: !dashboardCandidateDecision || quickstartMarkdown.includes(dashboardCandidateDecision) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown candidate decision ${dashboardCandidateDecision || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-candidate-evidence-stats-match-dashboard',
            laneId: lane.id,
            status: evidenceMatches(quickCandidateEvidence, dashboardCandidateEvidence) ? 'pass' : 'fail',
            message: `${lane.id} quickstart candidate evidence stats = ${formatEvidenceSummary(quickCandidateEvidence) || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-candidate-evidence-stats-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: !evidenceText || quickstartHtml.includes(evidenceText) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML candidate evidence stats ${evidenceText || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-candidate-evidence-stats-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: !dashboardCandidateEvidence || (
                quickstartMarkdown.includes(String(dashboardCandidateEvidence.reports)) &&
                quickstartMarkdown.includes(String(dashboardCandidateEvidence.comparedCases)) &&
                quickstartMarkdown.includes(String(dashboardCandidateEvidence.improvedCases)) &&
                quickstartMarkdown.includes(String(dashboardCandidateEvidence.materialRegressedCases)) &&
                quickstartMarkdown.includes(String(dashboardCandidateEvidence.warningRegressedCases))
            ) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown candidate evidence stats ${evidenceText || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-diagnostic-links-match-dashboard',
            laneId: lane.id,
            status: diagnosticLinksMatch(quickDiagnosticLinks, dashboardDiagnosticLinks) ? 'pass' : 'fail',
            message: `${lane.id} diagnostic links quickstart/dashboard = ${quickDiagnosticLinks.length}/${dashboardDiagnosticLinks.length}`
        });
        addCheck(checks, {
            id: 'lane-dashboard-diagnostic-link-paths-exist',
            laneId: lane.id,
            status: await diagnosticLinksExist(dashboardDiagnosticLinks) ? 'pass' : 'fail',
            message: `${lane.id} diagnostic link paths = ${dashboardDiagnosticLinks.map((item) => item.path).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-diagnostic-links-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: diagnosticLinksVisible(quickstartHtml, dashboardDiagnosticLinks) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML diagnostic links = ${dashboardDiagnosticLinks.map((item) => item.label).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-dashboard-html-diagnostic-links-visible',
            laneId: lane.id,
            path: bundle.dashboard?.outputPath || null,
            status: diagnosticLinksVisible(dashboardHtml, dashboardDiagnosticLinks) ? 'pass' : 'fail',
            message: `${lane.id} dashboard HTML diagnostic links = ${dashboardDiagnosticLinks.map((item) => item.label).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-diagnostic-links-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: diagnosticLinksVisible(quickstartMarkdown, dashboardDiagnosticLinks) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown diagnostic links = ${dashboardDiagnosticLinks.map((item) => item.label).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-review-videos-match-template',
            laneId: lane.id,
            status: reviewVideosMatch(quickReviewVideos, templateReviewVideos) ? 'pass' : 'fail',
            message: `${lane.id} quickstart review videos = ${quickReviewVideos.length}/${templateReviewVideos.length}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-html-review-videos-visible',
            laneId: lane.id,
            path: bundle.quickstart?.htmlPath || null,
            status: reviewVideosVisible(quickstartHtml, templateReviewVideos) ? 'pass' : 'fail',
            message: `${lane.id} quickstart HTML review videos = ${templateReviewVideos.map((video) => `${video.caseId || '-'}:${video.kind || '-'}`).join(', ') || '-'}`
        });
        addCheck(checks, {
            id: 'lane-quickstart-markdown-review-videos-visible',
            laneId: lane.id,
            path: bundle.quickstart?.outputPath || null,
            status: reviewVideosVisible(quickstartMarkdown, templateReviewVideos) ? 'pass' : 'fail',
            message: `${lane.id} quickstart markdown review videos = ${templateReviewVideos.map((video) => `${video.caseId || '-'}:${video.kind || '-'}`).join(', ') || '-'}`
        });
        if (quickstart.reviewThumbnailsEnabled === true) {
            const quickReviewThumbnailVideos = quickReviewVideosRaw.filter((video) => video?.thumbnailPath);
            addCheck(checks, {
                id: 'lane-quickstart-review-thumbnails-complete',
                laneId: lane.id,
                status: quickReviewThumbnailVideos.length === quickReviewVideosRaw.length && quickReviewVideosRaw.length === templateReviewVideos.length ? 'pass' : 'fail',
                message: `${lane.id} quickstart review thumbnails = ${quickReviewThumbnailVideos.length}/${quickReviewVideosRaw.length}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-html-review-thumbnails-visible',
                laneId: lane.id,
                path: bundle.quickstart?.htmlPath || null,
                status: reviewVideoThumbnailsVisible(quickstartHtml, quickReviewThumbnailVideos) ? 'pass' : 'fail',
                message: `${lane.id} quickstart HTML review thumbnail filenames = ${quickReviewThumbnailVideos.length}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-markdown-review-thumbnails-visible',
                laneId: lane.id,
                path: bundle.quickstart?.outputPath || null,
                status: reviewVideoThumbnailsVisible(quickstartMarkdown, quickReviewThumbnailVideos) ? 'pass' : 'fail',
                message: `${lane.id} quickstart markdown review thumbnail filenames = ${quickReviewThumbnailVideos.length}`
            });
            for (const video of quickReviewThumbnailVideos) {
                const thumbnailPath = video.thumbnailPath || null;
                addCheck(checks, {
                    id: 'lane-review-thumbnail-file-exists',
                    laneId: lane.id,
                    path: thumbnailPath,
                    status: await pathExists(thumbnailPath) ? 'pass' : 'fail',
                    message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} thumbnail ${thumbnailPath ? path.basename(thumbnailPath) : 'missing'}`
                });
                addCheck(checks, {
                    id: 'lane-review-thumbnail-png-readable',
                    laneId: lane.id,
                    path: thumbnailPath,
                    status: await isReadablePng(thumbnailPath) ? 'pass' : 'fail',
                    message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} thumbnail PNG signature`
                });
            }
        }
        for (const option of templateDecisionOptions) {
            const preview = quickDecisionPreviews.find((item) => item?.decision === option);
            const previewStatus = preview?.status || null;
            const decisionReport = optionReports.get(option);
            const previewOk = preview && !['pending', 'invalid', 'unverified-template-missing'].includes(previewStatus);
            addCheck(checks, {
                id: 'lane-quickstart-decision-preview-valid',
                laneId: lane.id,
                status: previewOk ? 'pass' : 'fail',
                message: `${lane.id} quickstart decision preview ${option} -> ${previewStatus || '-'}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-decision-preview-matches-parser',
                laneId: lane.id,
                status: previewStatus && previewStatus === decisionReport.status ? 'pass' : 'fail',
                message: `${lane.id} quickstart decision preview ${option} status=${previewStatus || '-'} parser=${decisionReport.status || '-'}`
            });
            const acceptanceCommand = preview?.acceptanceCommand || '';
            const acceptanceCommandOk = acceptanceCommand.includes('--set-decision') &&
                acceptanceCommand.includes(`--set-decision ${option}`) &&
                acceptanceCommand.includes('--check-all');
            addCheck(checks, {
                id: 'lane-quickstart-acceptance-command-present',
                laneId: lane.id,
                status: acceptanceCommandOk ? 'pass' : 'fail',
                message: `${lane.id} quickstart acceptance command ${option}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-html-preview-visible',
                laneId: lane.id,
                path: bundle.quickstart?.htmlPath || null,
                status: previewStatus && quickstartHtml.includes(option) && quickstartHtml.includes(previewStatus) ? 'pass' : 'fail',
                message: `${lane.id} quickstart HTML preview ${option} -> ${previewStatus || '-'}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-decision-copy-target-present',
                laneId: lane.id,
                path: bundle.quickstart?.htmlPath || null,
                status: quickstartHtml.includes(`data-copy-decision="${option}"`) ? 'pass' : 'fail',
                message: `${lane.id} quickstart copy decision target ${option}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-acceptance-command-copy-target-present',
                laneId: lane.id,
                path: bundle.quickstart?.htmlPath || null,
                status: acceptanceCommandOk && quickstartHtml.includes(`--set-decision ${option} --check-all`) ? 'pass' : 'fail',
                message: `${lane.id} quickstart copy acceptance command target ${option}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-markdown-preview-visible',
                laneId: lane.id,
                path: bundle.quickstart?.outputPath || null,
                status: previewStatus && quickstartMarkdown.includes(option) && quickstartMarkdown.includes(previewStatus) ? 'pass' : 'fail',
                message: `${lane.id} quickstart markdown preview ${option} -> ${previewStatus || '-'}`
            });
            addCheck(checks, {
                id: 'lane-quickstart-markdown-acceptance-command-visible',
                laneId: lane.id,
                path: bundle.quickstart?.outputPath || null,
                status: acceptanceCommandOk && quickstartMarkdown.includes(`--set-decision ${option} --check-all`) ? 'pass' : 'fail',
                message: `${lane.id} quickstart markdown acceptance command ${option}`
            });
        }
        addCheck(checks, {
            id: 'lane-video-count-positive',
            laneId: lane.id,
            status: Number(quickLane?.comparisons || template?.videos || decisionTemplate?.videos?.length || 0) > 0 ? 'pass' : 'fail',
            message: `${lane.id} review videos = ${Number(quickLane?.comparisons || template?.videos || decisionTemplate?.videos?.length || 0)}`
        });
        addCheck(checks, {
            id: 'lane-video-view-coverage',
            laneId: lane.id,
            status: videoKinds.has('full') && videoKinds.has('roi') ? 'pass' : 'fail',
            message: `${lane.id} review video kinds = ${[...videoKinds].sort().join(', ') || '-'}`
        });
        if (verifyMedia) {
            for (const video of decisionTemplate?.videos || []) {
                const videoName = video.src ? path.basename(video.src) : '';
                addCheck(checks, {
                    id: 'lane-video-html-reference',
                    laneId: lane.id,
                    path: lane.reviewHtmlPath,
                    status: videoName && reviewHtml.includes(videoName) ? 'pass' : 'fail',
                    message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} review HTML ${videoName ? `references ${videoName}` : 'has no video path'}`
                });
                const videoExists = await pathExists(video.src);
                addCheck(checks, {
                    id: 'lane-video-file-exists',
                    laneId: lane.id,
                    path: video.src || null,
                    status: videoExists ? 'pass' : 'fail',
                    message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} video ${videoExists ? 'exists' : 'is missing'}`
                });
                if (!videoExists) continue;
                try {
                    const media = await videoProbe(video.src);
                    const mediaOk = Number(media.duration) > 0 && Number(media.fps) > 0 && Number(media.width) > 0 && Number(media.height) > 0;
                    addCheck(checks, {
                        id: 'lane-video-media-readable',
                        laneId: lane.id,
                        path: video.src,
                        status: mediaOk ? 'pass' : 'fail',
                        message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} media duration=${media.duration ?? '-'} fps=${media.fps ?? '-'} size=${media.width || '-'}x${media.height || '-'}`
                    });
                    const currentTime = Number(video.currentTime);
                    const timeOk = Number.isFinite(currentTime) &&
                        currentTime >= 0 &&
                        Number(media.duration) > 0 &&
                        currentTime < Number(media.duration);
                    addCheck(checks, {
                        id: 'lane-video-review-time-valid',
                        laneId: lane.id,
                        path: video.src,
                        status: timeOk ? 'pass' : 'fail',
                        message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} review time=${Number.isFinite(currentTime) ? currentTime : '-'} duration=${media.duration ?? '-'}`
                    });
                } catch (error) {
                    addCheck(checks, {
                        id: 'lane-video-media-readable',
                        laneId: lane.id,
                        path: video.src,
                        status: 'fail',
                        message: `${lane.id} ${video.caseId || '-'} ${video.kind || '-'} media probe failed: ${error?.message || String(error)}`
                    });
                }
            }
        }
        addCheck(checks, {
            id: 'lane-temporal-count-consistent',
            laneId: lane.id,
            status: Number(dashboardLane?.temporalCases || 0) === Number(quickLane?.temporalCases || 0) ? 'pass' : 'fail',
            message: `${lane.id} temporal dashboard/quickstart = ${dashboardLane?.temporalCases ?? '-'}/${quickLane?.temporalCases ?? '-'}`
        });
    }

    const failed = checks.filter((item) => item.status === 'fail');
    const status = failed.length ? 'invalid' : bundle.complete === true ? 'complete' : 'ready-for-human-review';
    const report = {
        generatedAt: new Date().toISOString(),
        status,
        complete: bundle.complete === true,
        acceptanceStatus: bundle.acceptance?.status || null,
        nextAction: bundle.nextAction || null,
        blockers: bundle.blockers || [],
        bundlePath: resolvedBundlePath,
        dashboardPath: resolvedDashboardPath,
        quickstartPath: resolvedQuickstartPath,
        dashboardUrl: bundle.dashboard?.outputPath ? pathToFileURL(path.resolve(bundle.dashboard.outputPath)).href : null,
        quickstartUrl: bundle.quickstart?.htmlPath ? pathToFileURL(path.resolve(bundle.quickstart.htmlPath)).href : null,
        summary: {
            checks: checks.length,
            passed: checks.filter((item) => item.status === 'pass').length,
            failed: failed.length,
            lanes: acceptanceLanes.length,
            missingAssets: Number(bundle.dashboard?.missingAssets || 0)
        },
        checks,
        failedChecks: failed,
        outputPath: path.resolve(outputPath),
        markdownPath: path.resolve(markdownPath),
        mediaVerification: {
            enabled: verifyMedia,
            htmlReferenceChecks: checks.filter((item) => item.id === 'lane-video-html-reference').length,
            failedHtmlReferenceChecks: checks.filter((item) => item.id === 'lane-video-html-reference' && item.status === 'fail').length,
            videoChecks: checks.filter((item) => item.id === 'lane-video-media-readable').length,
            failedVideoChecks: checks.filter((item) => item.id === 'lane-video-media-readable' && item.status === 'fail').length,
            reviewTimeChecks: checks.filter((item) => item.id === 'lane-video-review-time-valid').length,
            failedReviewTimeChecks: checks.filter((item) => item.id === 'lane-video-review-time-valid' && item.status === 'fail').length
        },
        reviewThumbnailVerification: {
            enabled: quickstart.reviewThumbnailsEnabled === true,
            completenessChecks: checks.filter((item) => item.id === 'lane-quickstart-review-thumbnails-complete').length,
            failedCompletenessChecks: checks.filter((item) => item.id === 'lane-quickstart-review-thumbnails-complete' && item.status === 'fail').length,
            htmlVisibilityChecks: checks.filter((item) => item.id === 'lane-quickstart-html-review-thumbnails-visible').length,
            failedHtmlVisibilityChecks: checks.filter((item) => item.id === 'lane-quickstart-html-review-thumbnails-visible' && item.status === 'fail').length,
            markdownVisibilityChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-review-thumbnails-visible').length,
            failedMarkdownVisibilityChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-review-thumbnails-visible' && item.status === 'fail').length,
            fileChecks: checks.filter((item) => item.id === 'lane-review-thumbnail-file-exists').length,
            failedFileChecks: checks.filter((item) => item.id === 'lane-review-thumbnail-file-exists' && item.status === 'fail').length,
            pngChecks: checks.filter((item) => item.id === 'lane-review-thumbnail-png-readable').length,
            failedPngChecks: checks.filter((item) => item.id === 'lane-review-thumbnail-png-readable' && item.status === 'fail').length
        },
        reviewThumbnailSheetVerification: {
            enabled: Boolean(bundle.quickstart?.thumbnailSheetPath),
            pathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet').length,
            failedPathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet' && item.status === 'fail').length,
            jsonPathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-json').length,
            failedJsonPathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-json' && item.status === 'fail').length,
            pngChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-png-readable').length,
            failedPngChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-png-readable' && item.status === 'fail').length,
            outputPathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-report-output-matches').length,
            failedOutputPathChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-report-output-matches' && item.status === 'fail').length,
            countChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-count-matches').length,
            failedCountChecks: checks.filter((item) => item.id === 'quickstart-thumbnail-sheet-count-matches' && item.status === 'fail').length,
            htmlLinkChecks: checks.filter((item) => item.id === 'quickstart-html-thumbnail-sheet-link-visible').length,
            failedHtmlLinkChecks: checks.filter((item) => item.id === 'quickstart-html-thumbnail-sheet-link-visible' && item.status === 'fail').length,
            markdownLinkChecks: checks.filter((item) => item.id === 'quickstart-markdown-thumbnail-sheet-link-visible').length,
            failedMarkdownLinkChecks: checks.filter((item) => item.id === 'quickstart-markdown-thumbnail-sheet-link-visible' && item.status === 'fail').length
        },
        decisionVerification: {
            templateOptionPresenceChecks: checks.filter((item) => item.id === 'lane-template-decision-options-present').length,
            failedTemplateOptionPresenceChecks: checks.filter((item) => item.id === 'lane-template-decision-options-present' && item.status === 'fail').length,
            templateSuggestedDecisionChecks: checks.filter((item) => item.id === 'lane-template-suggested-decision-present').length,
            failedTemplateSuggestedDecisionChecks: checks.filter((item) => item.id === 'lane-template-suggested-decision-present' && item.status === 'fail').length,
            optionChecks: checks.filter((item) => item.id === 'lane-template-decision-option-recognized').length,
            failedOptionChecks: checks.filter((item) => item.id === 'lane-template-decision-option-recognized' && item.status === 'fail').length
        },
        templateVerification: {
            pathChecks: checks.filter((item) => item.id === 'lane-template-path-matches-lane').length,
            failedPathChecks: checks.filter((item) => item.id === 'lane-template-path-matches-lane' && item.status === 'fail').length,
            pageChecks: checks.filter((item) => item.id === 'lane-template-page-matches-review').length,
            failedPageChecks: checks.filter((item) => item.id === 'lane-template-page-matches-review' && item.status === 'fail').length,
            instructionChecks: checks.filter((item) => item.id === 'lane-template-instructions-present').length,
            failedInstructionChecks: checks.filter((item) => item.id === 'lane-template-instructions-present' && item.status === 'fail').length,
            acceptedStatusChecks: checks.filter((item) => item.id === 'lane-template-accepted-statuses-cover-bundle').length,
            failedAcceptedStatusChecks: checks.filter((item) => item.id === 'lane-template-accepted-statuses-cover-bundle' && item.status === 'fail').length,
            checklistChecks: checks.filter((item) => item.id === 'lane-template-checklist-nonempty').length,
            failedChecklistChecks: checks.filter((item) => item.id === 'lane-template-checklist-nonempty' && item.status === 'fail').length
        },
        acceptanceDryRunVerification: {
            suggestedGoalCompatibleChecks: checks.filter((item) => item.id === 'lane-suggested-decision-goal-compatible').length,
            failedSuggestedGoalCompatibleChecks: checks.filter((item) => item.id === 'lane-suggested-decision-goal-compatible' && item.status === 'fail').length,
            acceptedOptionAvailabilityChecks: checks.filter((item) => item.id === 'lane-accepted-decision-option-available').length,
            failedAcceptedOptionAvailabilityChecks: checks.filter((item) => item.id === 'lane-accepted-decision-option-available' && item.status === 'fail').length
        },
        quickstartDecisionVerification: {
            previewPresenceChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-previews-present').length,
            failedPreviewPresenceChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-previews-present' && item.status === 'fail').length,
            reviewOrderChecks: checks.filter((item) => item.id === 'quickstart-review-order-matches-policy').length,
            failedReviewOrderChecks: checks.filter((item) => item.id === 'quickstart-review-order-matches-policy' && item.status === 'fail').length,
            htmlReviewOrderChecks: checks.filter((item) => item.id === 'quickstart-html-review-order-visible').length,
            failedHtmlReviewOrderChecks: checks.filter((item) => item.id === 'quickstart-html-review-order-visible' && item.status === 'fail').length,
            markdownReviewOrderChecks: checks.filter((item) => item.id === 'quickstart-markdown-review-order-visible').length,
            failedMarkdownReviewOrderChecks: checks.filter((item) => item.id === 'quickstart-markdown-review-order-visible' && item.status === 'fail').length,
            suggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-suggested-action-matches-preview').length,
            failedSuggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-suggested-action-matches-preview' && item.status === 'fail').length,
            htmlSuggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-html-suggested-action-visible').length,
            failedHtmlSuggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-html-suggested-action-visible' && item.status === 'fail').length,
            markdownSuggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-suggested-action-visible').length,
            failedMarkdownSuggestedActionChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-suggested-action-visible' && item.status === 'fail').length,
            acceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-checklist-matches-template').length,
            failedAcceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-checklist-matches-template' && item.status === 'fail').length,
            htmlAcceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-html-acceptance-checklist-visible').length,
            failedHtmlAcceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-html-acceptance-checklist-visible' && item.status === 'fail').length,
            markdownAcceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-acceptance-checklist-visible').length,
            failedMarkdownAcceptanceChecklistChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-acceptance-checklist-visible' && item.status === 'fail').length,
            previewChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-preview-valid').length,
            failedPreviewChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-preview-valid' && item.status === 'fail').length,
            previewParserMatchChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-preview-matches-parser').length,
            failedPreviewParserMatchChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-preview-matches-parser' && item.status === 'fail').length,
            acceptanceCommandChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-command-present').length,
            failedAcceptanceCommandChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-command-present' && item.status === 'fail').length,
            htmlPreviewChecks: checks.filter((item) => item.id === 'lane-quickstart-html-preview-visible').length,
            failedHtmlPreviewChecks: checks.filter((item) => item.id === 'lane-quickstart-html-preview-visible' && item.status === 'fail').length,
            decisionCopyTargetChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-copy-target-present').length,
            failedDecisionCopyTargetChecks: checks.filter((item) => item.id === 'lane-quickstart-decision-copy-target-present' && item.status === 'fail').length,
            acceptanceCommandCopyTargetChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-command-copy-target-present').length,
            failedAcceptanceCommandCopyTargetChecks: checks.filter((item) => item.id === 'lane-quickstart-acceptance-command-copy-target-present' && item.status === 'fail').length,
            markdownPreviewChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-preview-visible').length,
            failedMarkdownPreviewChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-preview-visible' && item.status === 'fail').length,
            markdownAcceptanceCommandChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-acceptance-command-visible').length,
            failedMarkdownAcceptanceCommandChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-acceptance-command-visible' && item.status === 'fail').length,
            candidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-candidate-decision-matches-dashboard').length,
            failedCandidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-candidate-decision-matches-dashboard' && item.status === 'fail').length,
            htmlCandidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-html-candidate-decision-visible').length,
            failedHtmlCandidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-html-candidate-decision-visible' && item.status === 'fail').length,
            markdownCandidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-candidate-decision-visible').length,
            failedMarkdownCandidateDecisionChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-candidate-decision-visible' && item.status === 'fail').length,
            candidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-candidate-evidence-stats-match-dashboard').length,
            failedCandidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-candidate-evidence-stats-match-dashboard' && item.status === 'fail').length,
            htmlCandidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-html-candidate-evidence-stats-visible').length,
            failedHtmlCandidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-html-candidate-evidence-stats-visible' && item.status === 'fail').length,
            markdownCandidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-candidate-evidence-stats-visible').length,
            failedMarkdownCandidateEvidenceStatsChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-candidate-evidence-stats-visible' && item.status === 'fail').length,
            diagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-diagnostic-links-match-dashboard').length,
            failedDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-diagnostic-links-match-dashboard' && item.status === 'fail').length,
            diagnosticPathChecks: checks.filter((item) => item.id === 'lane-dashboard-diagnostic-link-paths-exist').length,
            failedDiagnosticPathChecks: checks.filter((item) => item.id === 'lane-dashboard-diagnostic-link-paths-exist' && item.status === 'fail').length,
            htmlDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-html-diagnostic-links-visible').length,
            failedHtmlDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-html-diagnostic-links-visible' && item.status === 'fail').length,
            markdownDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-diagnostic-links-visible').length,
            failedMarkdownDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-diagnostic-links-visible' && item.status === 'fail').length,
            reviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-review-videos-match-template').length,
            failedReviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-review-videos-match-template' && item.status === 'fail').length,
            htmlReviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-html-review-videos-visible').length,
            failedHtmlReviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-html-review-videos-visible' && item.status === 'fail').length,
            markdownReviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-review-videos-visible').length,
            failedMarkdownReviewVideoChecks: checks.filter((item) => item.id === 'lane-quickstart-markdown-review-videos-visible' && item.status === 'fail').length,
            htmlReviewPlaylistChecks: checks.filter((item) => item.id === 'quickstart-html-review-playlist-present').length,
            failedHtmlReviewPlaylistChecks: checks.filter((item) => item.id === 'quickstart-html-review-playlist-present' && item.status === 'fail').length,
            markdownReviewPlaylistChecks: checks.filter((item) => item.id === 'quickstart-markdown-review-playlist-present').length,
            failedMarkdownReviewPlaylistChecks: checks.filter((item) => item.id === 'quickstart-markdown-review-playlist-present' && item.status === 'fail').length
        },
        commandVerification: {
            scriptChecks: checks.filter((item) => item.id === 'lane-command-script-valid').length,
            failedScriptChecks: checks.filter((item) => item.id === 'lane-command-script-valid' && item.status === 'fail').length,
            decisionPathChecks: checks.filter((item) => item.id === 'lane-command-decision-matches-template').length,
            failedDecisionPathChecks: checks.filter((item) => item.id === 'lane-command-decision-matches-template' && item.status === 'fail').length,
            outputPathChecks: checks.filter((item) => item.id === 'lane-command-output-matches-json').length,
            failedOutputPathChecks: checks.filter((item) => item.id === 'lane-command-output-matches-json' && item.status === 'fail').length,
            markdownPathChecks: checks.filter((item) => item.id === 'lane-command-markdown-matches-report').length,
            failedMarkdownPathChecks: checks.filter((item) => item.id === 'lane-command-markdown-matches-report' && item.status === 'fail').length
        },
        dashboardDiagnosticVerification: {
            htmlDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-dashboard-html-diagnostic-links-visible').length,
            failedHtmlDiagnosticLinkChecks: checks.filter((item) => item.id === 'lane-dashboard-html-diagnostic-links-visible' && item.status === 'fail').length
        },
        screenshotVerification: {
            reportChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-readable')).length,
            failedReportChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-readable') && item.status === 'fail').length,
            htmlPathChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-html-matches')).length,
            failedHtmlPathChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-html-matches') && item.status === 'fail').length,
            outputPathChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-output-matches')).length,
            failedOutputPathChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-output-matches') && item.status === 'fail').length,
            viewportChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-viewport-valid')).length,
            failedViewportChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-viewport-valid') && item.status === 'fail').length,
            documentSizeChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-document-size-valid')).length,
            failedDocumentSizeChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-document-size-valid') && item.status === 'fail').length,
            generatedAtChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-generated-at-present')).length,
            failedGeneratedAtChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-generated-at-present') && item.status === 'fail').length,
            fullPageChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-fullpage-matches')).length,
            failedFullPageChecks: checks.filter((item) => item.id.endsWith('-screenshot-report-fullpage-matches') && item.status === 'fail').length
        }
    };
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
    await writeFile(path.resolve(markdownPath), renderVideoDeliveryBundleVerificationMarkdown(report), 'utf8');
    if (failOnIncomplete && report.status !== 'complete') {
        report.exitCode = 1;
    }
    return report;
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

export function renderVideoDeliveryBundleVerificationMarkdown(report = {}) {
    const lines = [];
    lines.push('# Video Delivery Bundle Verification');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt || '-'}`);
    lines.push(`Status: ${report.status || '-'}`);
    lines.push(`Acceptance: ${report.acceptanceStatus || '-'}`);
    lines.push(`Next action: ${report.nextAction || '-'}`);
    lines.push(`Blockers: ${(report.blockers || []).length ? report.blockers.join(', ') : '-'}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Checks | ${escapeCell(report.summary?.passed)}/${escapeCell(report.summary?.checks)} passed |`);
    lines.push(`| Failed | ${escapeCell(report.summary?.failed)} |`);
    lines.push(`| Lanes | ${escapeCell(report.summary?.lanes)} |`);
    lines.push(`| Missing assets | ${escapeCell(report.summary?.missingAssets)} |`);
    lines.push(`| Media verification | ${report.mediaVerification?.enabled ? 'enabled' : 'disabled'} (${escapeCell(report.mediaVerification?.htmlReferenceChecks)} HTML refs, failed ${escapeCell(report.mediaVerification?.failedHtmlReferenceChecks)}; ${escapeCell(report.mediaVerification?.videoChecks)} video probes, failed ${escapeCell(report.mediaVerification?.failedVideoChecks)}; ${escapeCell(report.mediaVerification?.reviewTimeChecks)} review time checks, failed ${escapeCell(report.mediaVerification?.failedReviewTimeChecks)}) |`);
    lines.push(`| Review thumbnails | ${report.reviewThumbnailVerification?.enabled ? 'enabled' : 'disabled'} (${escapeCell(report.reviewThumbnailVerification?.completenessChecks)} completeness checks, failed ${escapeCell(report.reviewThumbnailVerification?.failedCompletenessChecks)}; ${escapeCell(report.reviewThumbnailVerification?.htmlVisibilityChecks)} HTML visibility checks, failed ${escapeCell(report.reviewThumbnailVerification?.failedHtmlVisibilityChecks)}; ${escapeCell(report.reviewThumbnailVerification?.markdownVisibilityChecks)} Markdown visibility checks, failed ${escapeCell(report.reviewThumbnailVerification?.failedMarkdownVisibilityChecks)}; ${escapeCell(report.reviewThumbnailVerification?.fileChecks)} file checks, failed ${escapeCell(report.reviewThumbnailVerification?.failedFileChecks)}; ${escapeCell(report.reviewThumbnailVerification?.pngChecks)} PNG checks, failed ${escapeCell(report.reviewThumbnailVerification?.failedPngChecks)}) |`);
    lines.push(`| Review thumbnail sheet | ${report.reviewThumbnailSheetVerification?.enabled ? 'enabled' : 'disabled'} (${escapeCell(report.reviewThumbnailSheetVerification?.pathChecks)} path checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedPathChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.jsonPathChecks)} JSON path checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedJsonPathChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.pngChecks)} PNG checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedPngChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.outputPathChecks)} output-path checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedOutputPathChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.countChecks)} count checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedCountChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.htmlLinkChecks)} HTML link checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedHtmlLinkChecks)}; ${escapeCell(report.reviewThumbnailSheetVerification?.markdownLinkChecks)} Markdown link checks, failed ${escapeCell(report.reviewThumbnailSheetVerification?.failedMarkdownLinkChecks)}) |`);
    lines.push(`| Decision verification | ${escapeCell(report.decisionVerification?.optionChecks)} option parser checks, failed ${escapeCell(report.decisionVerification?.failedOptionChecks)}; ${escapeCell(report.decisionVerification?.templateOptionPresenceChecks)} option-list checks, failed ${escapeCell(report.decisionVerification?.failedTemplateOptionPresenceChecks)}; ${escapeCell(report.decisionVerification?.templateSuggestedDecisionChecks)} suggested-decision checks, failed ${escapeCell(report.decisionVerification?.failedTemplateSuggestedDecisionChecks)} |`);
    lines.push(`| Template verification | ${escapeCell(report.templateVerification?.pathChecks)} path checks, failed ${escapeCell(report.templateVerification?.failedPathChecks)}; ${escapeCell(report.templateVerification?.pageChecks)} page checks, failed ${escapeCell(report.templateVerification?.failedPageChecks)}; ${escapeCell(report.templateVerification?.instructionChecks)} instruction checks, failed ${escapeCell(report.templateVerification?.failedInstructionChecks)}; ${escapeCell(report.templateVerification?.acceptedStatusChecks)} accepted-status checks, failed ${escapeCell(report.templateVerification?.failedAcceptedStatusChecks)}; ${escapeCell(report.templateVerification?.checklistChecks)} checklist checks, failed ${escapeCell(report.templateVerification?.failedChecklistChecks)} |`);
    lines.push(`| Acceptance dry-run | ${escapeCell(report.acceptanceDryRunVerification?.suggestedGoalCompatibleChecks)} suggested-decision goal checks, failed ${escapeCell(report.acceptanceDryRunVerification?.failedSuggestedGoalCompatibleChecks)}; ${escapeCell(report.acceptanceDryRunVerification?.acceptedOptionAvailabilityChecks)} accepted-option availability checks, failed ${escapeCell(report.acceptanceDryRunVerification?.failedAcceptedOptionAvailabilityChecks)} |`);
    lines.push(`| Quickstart review order | ${escapeCell(report.quickstartDecisionVerification?.reviewOrderChecks)} JSON order checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedReviewOrderChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlReviewOrderChecks)} HTML order checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlReviewOrderChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownReviewOrderChecks)} Markdown order checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownReviewOrderChecks)} |`);
    lines.push(`| Quickstart decision previews | ${escapeCell(report.quickstartDecisionVerification?.previewChecks)} JSON preview checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedPreviewChecks)}; ${escapeCell(report.quickstartDecisionVerification?.previewPresenceChecks)} presence checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedPreviewPresenceChecks)}; ${escapeCell(report.quickstartDecisionVerification?.previewParserMatchChecks)} parser-match checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedPreviewParserMatchChecks)}; ${escapeCell(report.quickstartDecisionVerification?.acceptanceCommandChecks)} acceptance command checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedAcceptanceCommandChecks)}; ${escapeCell(report.quickstartDecisionVerification?.candidateDecisionChecks)} candidate evidence checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedCandidateDecisionChecks)}; ${escapeCell(report.quickstartDecisionVerification?.candidateEvidenceStatsChecks)} candidate evidence stat checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedCandidateEvidenceStatsChecks)}; ${escapeCell(report.quickstartDecisionVerification?.diagnosticLinkChecks)} diagnostic link checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedDiagnosticLinkChecks)}; ${escapeCell(report.quickstartDecisionVerification?.diagnosticPathChecks)} diagnostic path checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedDiagnosticPathChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlPreviewChecks)} HTML preview checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlPreviewChecks)}; ${escapeCell(report.quickstartDecisionVerification?.decisionCopyTargetChecks)} decision copy-target checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedDecisionCopyTargetChecks)}; ${escapeCell(report.quickstartDecisionVerification?.acceptanceCommandCopyTargetChecks)} acceptance command copy-target checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedAcceptanceCommandCopyTargetChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlCandidateDecisionChecks)} HTML candidate evidence checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlCandidateDecisionChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlCandidateEvidenceStatsChecks)} HTML candidate evidence stat checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlCandidateEvidenceStatsChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlDiagnosticLinkChecks)} HTML diagnostic link checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlDiagnosticLinkChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownPreviewChecks)} Markdown preview checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownPreviewChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownAcceptanceCommandChecks)} Markdown acceptance command checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownAcceptanceCommandChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownCandidateDecisionChecks)} Markdown candidate evidence checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownCandidateDecisionChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownCandidateEvidenceStatsChecks)} Markdown candidate evidence stat checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownCandidateEvidenceStatsChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownDiagnosticLinkChecks)} Markdown diagnostic link checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownDiagnosticLinkChecks)} |`);
    lines.push(`| Quickstart suggested actions | ${escapeCell(report.quickstartDecisionVerification?.suggestedActionChecks)} JSON action checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedSuggestedActionChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlSuggestedActionChecks)} HTML action checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlSuggestedActionChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownSuggestedActionChecks)} Markdown action checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownSuggestedActionChecks)} |`);
    lines.push(`| Quickstart acceptance checklist | ${escapeCell(report.quickstartDecisionVerification?.acceptanceChecklistChecks)} JSON checklist checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedAcceptanceChecklistChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlAcceptanceChecklistChecks)} HTML checklist checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlAcceptanceChecklistChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownAcceptanceChecklistChecks)} Markdown checklist checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownAcceptanceChecklistChecks)} |`);
    lines.push(`| Quickstart review videos | ${escapeCell(report.quickstartDecisionVerification?.reviewVideoChecks)} JSON video checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedReviewVideoChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlReviewVideoChecks)} HTML video checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlReviewVideoChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownReviewVideoChecks)} Markdown video checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownReviewVideoChecks)}; ${escapeCell(report.quickstartDecisionVerification?.htmlReviewPlaylistChecks)} HTML playlist checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedHtmlReviewPlaylistChecks)}; ${escapeCell(report.quickstartDecisionVerification?.markdownReviewPlaylistChecks)} Markdown playlist checks, failed ${escapeCell(report.quickstartDecisionVerification?.failedMarkdownReviewPlaylistChecks)} |`);
    lines.push(`| Command verification | ${escapeCell(report.commandVerification?.scriptChecks)} script checks, failed ${escapeCell(report.commandVerification?.failedScriptChecks)}; ${escapeCell(report.commandVerification?.decisionPathChecks)} decision-path checks, failed ${escapeCell(report.commandVerification?.failedDecisionPathChecks)}; ${escapeCell(report.commandVerification?.outputPathChecks)} output-path checks, failed ${escapeCell(report.commandVerification?.failedOutputPathChecks)}; ${escapeCell(report.commandVerification?.markdownPathChecks)} markdown-path checks, failed ${escapeCell(report.commandVerification?.failedMarkdownPathChecks)} |`);
    lines.push(`| Dashboard diagnostics | ${escapeCell(report.dashboardDiagnosticVerification?.htmlDiagnosticLinkChecks)} HTML diagnostic link checks, failed ${escapeCell(report.dashboardDiagnosticVerification?.failedHtmlDiagnosticLinkChecks)} |`);
    lines.push(`| Screenshot verification | ${escapeCell(report.screenshotVerification?.reportChecks)} report checks, failed ${escapeCell(report.screenshotVerification?.failedReportChecks)}; ${escapeCell(report.screenshotVerification?.htmlPathChecks)} HTML-path checks, failed ${escapeCell(report.screenshotVerification?.failedHtmlPathChecks)}; ${escapeCell(report.screenshotVerification?.outputPathChecks)} output-path checks, failed ${escapeCell(report.screenshotVerification?.failedOutputPathChecks)}; ${escapeCell(report.screenshotVerification?.viewportChecks)} viewport checks, failed ${escapeCell(report.screenshotVerification?.failedViewportChecks)}; ${escapeCell(report.screenshotVerification?.documentSizeChecks)} document-size checks, failed ${escapeCell(report.screenshotVerification?.failedDocumentSizeChecks)}; ${escapeCell(report.screenshotVerification?.generatedAtChecks)} generatedAt checks, failed ${escapeCell(report.screenshotVerification?.failedGeneratedAtChecks)}; ${escapeCell(report.screenshotVerification?.fullPageChecks)} fullPage checks, failed ${escapeCell(report.screenshotVerification?.failedFullPageChecks)} |`);
    lines.push(`| Dashboard URL | ${escapeCell(report.dashboardUrl)} |`);
    lines.push(`| Quickstart URL | ${escapeCell(report.quickstartUrl)} |`);
    lines.push('');
    lines.push('## Failed Checks');
    lines.push('');
    if ((report.failedChecks || []).length === 0) {
        lines.push('None.');
    } else {
        lines.push('| Check | Lane | Path | Message |');
        lines.push('|---|---|---|---|');
        for (const item of report.failedChecks || []) {
            lines.push(`| ${escapeCell(item.id)} | ${escapeCell(item.laneId)} | ${escapeCell(item.path)} | ${escapeCell(item.message)} |`);
        }
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
    const parsed = {
        bundlePath: DEFAULT_BUNDLE_PATH,
        dashboardPath: DEFAULT_DASHBOARD_PATH,
        quickstartPath: DEFAULT_QUICKSTART_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        failOnInvalid: false,
        failOnIncomplete: false,
        verifyMedia: true
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--bundle') {
            parsed.bundlePath = path.resolve(argv[++i] || DEFAULT_BUNDLE_PATH);
        } else if (arg === '--dashboard') {
            parsed.dashboardPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_PATH);
        } else if (arg === '--quickstart') {
            parsed.quickstartPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
        } else if (arg === '--fail-on-invalid') {
            parsed.failOnInvalid = true;
        } else if (arg === '--fail-on-incomplete') {
            parsed.failOnIncomplete = true;
        } else if (arg === '--skip-media-probe') {
            parsed.verifyMedia = false;
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
  node scripts/verify-video-delivery-bundle.js [--fail-on-invalid] [--fail-on-incomplete] [--skip-media-probe]

Default output:
  .artifacts/video-delivery-bundle/latest-verification-report.json
  .artifacts/video-delivery-bundle/latest-verification-report.md
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoDeliveryBundleVerification(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`checks: ${report.summary.passed}/${report.summary.checks}`);
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            if (args.failOnInvalid && report.status === 'invalid') {
                process.exitCode = 1;
            } else if (args.failOnIncomplete && report.status !== 'complete') {
                process.exitCode = 1;
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
