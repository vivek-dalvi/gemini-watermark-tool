import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { createVideoReviewDecisionSummary } from './create-video-review-decision-report.js';

const DEFAULT_BUNDLE_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-report.json');
const DEFAULT_DASHBOARD_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.md');
const DEFAULT_JSON_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json');
const DEFAULT_HTML_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.html');
const DEFAULT_REVIEW_THUMBNAIL_DIR = path.resolve('.artifacts/video-delivery-bundle/review-thumbnails');
const execFileAsync = promisify(execFile);

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function toFileUrl(filePath) {
    return filePath ? pathToFileURL(path.resolve(filePath)).href : null;
}

function commandForLane(lane = {}) {
    return lane.decisionCommand || lane.command || '';
}

function acceptanceCommandForDecision(lane = {}, decision = null) {
    const command = commandForLane(lane);
    return command && decision ? `${command} --set-decision ${decision} --check-all` : '';
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

function createReviewVideoItem(video = {}) {
    const src = video.src || null;
    const currentTime = Number(video.currentTime);
    const playbackRate = Number(video.playbackRate);
    return {
        caseId: video.caseId || null,
        kind: video.kind || null,
        src,
        srcUrl: toFileUrl(src),
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        playbackRate: Number.isFinite(playbackRate) ? playbackRate : null
    };
}

function sanitizeSegment(value = '') {
    return String(value || 'item')
        .replace(/[^a-z0-9_.-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72) || 'item';
}

function createReviewThumbnailPath({ laneId = 'lane', video = {}, index = 0, thumbnailDir = DEFAULT_REVIEW_THUMBNAIL_DIR } = {}) {
    const hash = createHash('sha1')
        .update(`${video.src || ''}|${video.currentTime ?? ''}|${video.caseId || ''}|${video.kind || ''}`)
        .digest('hex')
        .slice(0, 10);
    const filename = [
        sanitizeSegment(laneId),
        String(index + 1).padStart(2, '0'),
        sanitizeSegment(video.caseId || 'case'),
        sanitizeSegment(video.kind || 'video'),
        hash
    ].join('-');
    return path.join(path.resolve(thumbnailDir), `${filename}.png`);
}

export async function createVideoReviewThumbnail({
    video = {},
    outputPath,
    width = 360
} = {}) {
    if (!video.src) throw new Error('review video source is missing');
    const resolvedOutputPath = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    const time = Number.isFinite(Number(video.currentTime)) ? Math.max(0, Number(video.currentTime)) : 0;
    await execFileAsync('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(time),
        '-i', path.resolve(video.src),
        '-frames:v', '1',
        '-vf', `scale=${Number(width) || 360}:-2`,
        '-q:v', '3',
        resolvedOutputPath
    ], { windowsHide: true });
    return {
        outputPath: resolvedOutputPath,
        width: Number(width) || 360
    };
}

function createAcceptanceChecklistItem(item = {}) {
    const index = Number(item.index);
    return {
        index: Number.isFinite(index) ? index : null,
        checked: item.checked === true,
        text: item.text || ''
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

async function createReviewVideosForLane(lane = {}, {
    generateReviewThumbnails = false,
    reviewThumbnailDir = DEFAULT_REVIEW_THUMBNAIL_DIR,
    reviewThumbnailGenerator = createVideoReviewThumbnail
} = {}) {
    const decisionTemplate = await readJsonIfExists(lane.decisionTemplatePath);
    const videos = Array.isArray(decisionTemplate?.videos)
        ? decisionTemplate.videos.map(createReviewVideoItem)
        : [];
    if (!generateReviewThumbnails) return videos;
    return Promise.all(videos.map(async (video, index) => {
        if (!video.src) return video;
        const thumbnailPath = createReviewThumbnailPath({
            laneId: lane.id,
            video,
            index,
            thumbnailDir: reviewThumbnailDir
        });
        const thumbnail = await reviewThumbnailGenerator({
            laneId: lane.id,
            video,
            outputPath: thumbnailPath
        });
        const outputPath = thumbnail?.outputPath || thumbnailPath;
        return {
            ...video,
            thumbnailPath: outputPath,
            thumbnailUrl: toFileUrl(outputPath)
        };
    }));
}

async function createAcceptanceChecklistForLane(lane = {}) {
    const decisionTemplate = await readJsonIfExists(lane.decisionTemplatePath);
    return Array.isArray(decisionTemplate?.checklist)
        ? decisionTemplate.checklist.map(createAcceptanceChecklistItem)
        : [];
}

function createSuggestedActionForLane(lane = {}, decisionPreviews = []) {
    const decision = lane.suggestedDecision || null;
    if (!decision) return null;
    const preview = decisionPreviews.find((item) => item?.decision === decision) || null;
    return {
        decision,
        status: preview?.status || null,
        nextAction: preview?.nextAction || null,
        acceptanceCommand: preview?.acceptanceCommand || acceptanceCommandForDecision(lane, decision),
        candidateDecision: lane.candidateDecision || null
    };
}

function reviewPriorityForLane(lane = {}) {
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

function reviewReasonForLane(lane = {}) {
    const candidate = lane.candidateDecision || '';
    const evidence = lane.candidateEvidence || {};
    if (candidate === 'promote-default-candidate') {
        return 'lowest-risk default candidate; verify visible quality first';
    }
    if (candidate === 'candidate-aware-human-review') {
        const material = Number(evidence.materialRegressedCases || 0);
        const warning = Number(evidence.warningRegressedCases || 0);
        return `candidate-aware review; inspect diagnostics and ${material} material / ${warning} warning regressions`;
    }
    if (candidate === 'human-review') {
        return 'polish tradeoff candidate; compare residual reduction against texture drift';
    }
    return 'review candidate evidence before accepting';
}

function primaryReviewVideoForLane(lane = {}) {
    const videos = lane.reviewVideos || [];
    return videos.find((video) => video.kind === 'roi') || videos.find((video) => video.kind === 'full') || videos[0] || null;
}

function createReviewOrder(lanes = []) {
    return lanes
        .map((lane, index) => ({
            laneId: lane.id,
            title: lane.title || lane.id,
            suggestedDecision: lane.suggestedDecision || null,
            suggestedStatus: lane.suggestedAction?.status || null,
            candidateDecision: lane.candidateDecision || null,
            primaryVideo: primaryReviewVideoForLane(lane),
            priority: reviewPriorityForLane(lane),
            reason: reviewReasonForLane(lane),
            originalIndex: index
        }))
        .sort((a, b) => a.priority - b.priority || a.originalIndex - b.originalIndex)
        .map((item, index) => ({
            rank: index + 1,
            laneId: item.laneId,
            title: item.title,
            suggestedDecision: item.suggestedDecision,
            suggestedStatus: item.suggestedStatus,
            candidateDecision: item.candidateDecision,
            primaryVideo: item.primaryVideo,
            priority: item.priority,
            reason: item.reason
        }));
}

async function createDecisionPreviewsForLane(lane = {}) {
    const decisionTemplate = await readJsonIfExists(lane.decisionTemplatePath);
    const options = Array.isArray(decisionTemplate?.suggestedDecisionOptions)
        ? decisionTemplate.suggestedDecisionOptions
        : lane.suggestedDecisionOptions || [];
    return options.filter(Boolean).map((decision) => {
        if (!decisionTemplate) {
            return {
                decision,
                normalizedDecision: decision,
                status: 'unverified-template-missing',
                reviewMode: null,
                nextAction: 'open-decision-template-before-review',
                acceptanceCommand: '',
                blockers: ['decision-template-missing'],
                warnings: []
            };
        }
        const report = createVideoReviewDecisionSummary(createCheckedDecisionTemplate(decisionTemplate, decision));
        return {
            decision,
            normalizedDecision: report.decision,
            status: report.status,
            reviewMode: report.reviewMode,
            nextAction: report.nextAction,
            acceptanceCommand: acceptanceCommandForDecision(lane, decision),
            blockers: report.blockers,
            warnings: report.warnings
        };
    });
}

async function enrichDecisionPreviews(summary = {}, options = {}) {
    const generateReviewThumbnails = options.generateReviewThumbnails === true;
    const lanes = await Promise.all((summary.lanes || []).map(async (lane) => {
        const [decisionPreviews, reviewVideos, acceptanceChecklist] = await Promise.all([
            createDecisionPreviewsForLane(lane),
            createReviewVideosForLane(lane, options),
            createAcceptanceChecklistForLane(lane)
        ]);
        const suggestedAction = createSuggestedActionForLane(lane, decisionPreviews);
        return {
            ...lane,
            decisionPreviews,
            suggestedAction,
            acceptanceChecklist,
            reviewVideos
        };
    }));
    const decisionPreviewCount = lanes.reduce((total, lane) => total + (lane.decisionPreviews || []).length, 0);
    const failedDecisionPreviewCount = lanes.reduce((total, lane) => total + (lane.decisionPreviews || []).filter((item) => item.status === 'invalid' || item.status === 'pending' || item.status === 'unverified-template-missing').length, 0);
    const reviewVideoCount = lanes.reduce((total, lane) => total + (lane.reviewVideos || []).length, 0);
    const reviewThumbnailCount = lanes.reduce((total, lane) => total + (lane.reviewVideos || []).filter((video) => video.thumbnailPath).length, 0);
    const suggestedActionCount = lanes.reduce((total, lane) => total + (lane.suggestedAction ? 1 : 0), 0);
    const acceptanceChecklistCount = lanes.reduce((total, lane) => total + (lane.acceptanceChecklist || []).length, 0);
    const reviewOrder = createReviewOrder(lanes);
    return {
        ...summary,
        decisionPreviewCount,
        failedDecisionPreviewCount,
        reviewVideoCount,
        reviewThumbnailCount,
        reviewThumbnailsEnabled: generateReviewThumbnails,
        reviewThumbnailDir: generateReviewThumbnails ? path.resolve(options.reviewThumbnailDir || DEFAULT_REVIEW_THUMBNAIL_DIR) : null,
        suggestedActionCount,
        acceptanceChecklistCount,
        reviewOrder,
        lanes
    };
}

export function createVideoAcceptanceQuickstartSummary({
    bundleReport = {},
    dashboardReport = {}
} = {}) {
    const dashboardLanes = new Map((dashboardReport.lanes || []).map((lane) => [lane.id, lane]));
    const temporalRows = Array.isArray(dashboardReport.temporalRows) ? dashboardReport.temporalRows : [];
    const lanes = (bundleReport.acceptance?.lanes || []).map((lane) => {
        const dashboardLane = dashboardLanes.get(lane.id) || {};
        const laneTemporalRows = temporalRows.filter((row) => row.laneId === lane.id);
        return {
            id: lane.id,
            title: lane.title,
            complete: lane.complete === true,
            currentStatus: lane.currentStatus || null,
            suggestedDecision: lane.suggestedDecision || null,
            suggestedDecisionOptions: lane.suggestedDecisionOptions || [],
            checklist: lane.checklist || null,
            reviewHtmlPath: lane.reviewHtmlPath || null,
            reviewHtmlUrl: toFileUrl(lane.reviewHtmlPath),
            decisionTemplatePath: lane.decisionTemplatePath || null,
            decisionJsonPath: lane.decisionJsonPath || null,
            decisionReportPath: lane.decisionReportPath || null,
            decisionCommand: commandForLane(lane),
            status: dashboardLane.status || null,
            temporalStatus: dashboardLane.temporalStatus || null,
            reviewStatus: dashboardLane.reviewStatus || null,
            candidateDecision: dashboardLane.candidateDecision || null,
            candidateEvidence: dashboardLane.candidateEvidence || null,
            diagnosticLinks: dashboardLane.diagnosticLinks || [],
            comparisons: dashboardLane.comparisons || 0,
            temporalCases: dashboardLane.temporalCases || 0,
            temporalRows: laneTemporalRows.length
        };
    });
    return {
        generatedAt: new Date().toISOString(),
        status: bundleReport.status || 'unknown',
        nextAction: bundleReport.nextAction || null,
        blockers: bundleReport.blockers || [],
        acceptanceStatus: bundleReport.acceptance?.status || null,
        requiredForCompletion: bundleReport.acceptance?.requiredForCompletion || null,
        dashboardHtmlPath: bundleReport.dashboard?.outputPath || null,
        dashboardHtmlUrl: toFileUrl(bundleReport.dashboard?.outputPath),
        dashboardScreenshotPath: bundleReport.dashboard?.screenshotPath || null,
        bundleMarkdownPath: bundleReport.markdownPath || null,
        goalStatusMarkdownPath: bundleReport.goalStatus?.markdownPath || null,
        readyLanes: bundleReport.dashboard?.readyLanes || 0,
        laneCount: bundleReport.dashboard?.lanes || lanes.length,
        missingAssets: bundleReport.dashboard?.missingAssets || 0,
        requirementCount: bundleReport.goalStatus?.requirementCount || 0,
        satisfiedRequirements: bundleReport.goalStatus?.satisfiedRequirements || 0,
        lanes
    };
}

export function renderVideoAcceptanceQuickstartMarkdown(summary = {}) {
    const lines = [];
    lines.push('# Video Acceptance Quickstart');
    lines.push('');
    lines.push(`Generated: ${summary.generatedAt || '-'}`);
    lines.push(`Status: ${summary.status || '-'}`);
    lines.push(`Next action: ${summary.nextAction || '-'}`);
    lines.push(`Blockers: ${(summary.blockers || []).length ? summary.blockers.join(', ') : '-'}`);
    lines.push('');
    lines.push('## Review Entry');
    lines.push('');
    lines.push('| Item | Value |');
    lines.push('|---|---|');
    lines.push(`| Dashboard HTML | ${escapeCell(summary.dashboardHtmlPath)} |`);
    lines.push(`| Dashboard URL | ${escapeCell(summary.dashboardHtmlUrl)} |`);
    lines.push(`| Dashboard screenshot | ${escapeCell(summary.dashboardScreenshotPath)} |`);
    lines.push(`| Bundle report | ${escapeCell(summary.bundleMarkdownPath)} |`);
    lines.push(`| Goal status | ${escapeCell(summary.goalStatusMarkdownPath)} |`);
    lines.push(`| Ready lanes | ${escapeCell(summary.readyLanes)}/${escapeCell(summary.laneCount)} |`);
    lines.push(`| Missing assets | ${escapeCell(summary.missingAssets)} |`);
    lines.push(`| Requirements | ${escapeCell(summary.satisfiedRequirements)}/${escapeCell(summary.requirementCount)} |`);
    lines.push(`| Review thumbnails | ${escapeCell(summary.reviewThumbnailCount || 0)}/${escapeCell(summary.reviewVideoCount || 0)} |`);
    lines.push(`| Review thumbnail sheet | ${escapeCell(summary.reviewThumbnailSheetPath || '-')} |`);
    lines.push('');
    lines.push('## Human Decision Flow');
    lines.push('');
    lines.push('1. Open the dashboard and compare the full-frame and ROI videos for each lane.');
    lines.push('2. Choose one acceptable lane, or choose a needs-polish/reject decision if none is usable.');
    lines.push('3. Edit that lane decision template: set `decision`, write `notes`, and set each relevant `checklist[].checked` to `true` only after review.');
    lines.push('4. Run that lane command, then rebuild the delivery bundle.');
    lines.push('');
    if ((summary.reviewOrder || []).length) {
        lines.push('## Review Order');
        lines.push('');
        lines.push('| Rank | Lane | Suggested decision | Status | Candidate evidence | Start video | Reason |');
        lines.push('|---:|---|---|---|---|---|---|');
        for (const item of summary.reviewOrder || []) {
            const video = item.primaryVideo || {};
            const videoLabel = video.src ? `${video.caseId || '-'} ${video.kind || '-'} ${path.basename(video.src)}` : '-';
            lines.push(`| ${escapeCell(item.rank)} | ${escapeCell(item.laneId)} | ${escapeCell(item.suggestedDecision || '-')} | ${escapeCell(item.suggestedStatus || '-')} | ${escapeCell(item.candidateDecision || '-')} | ${escapeCell(videoLabel)} | ${escapeCell(item.reason || '-')} |`);
        }
        lines.push('');
    }
    if ((summary.lanes || []).some((lane) => lane.suggestedAction)) {
        lines.push('## Suggested Review Actions');
        lines.push('');
        lines.push('| Lane | Suggested decision | Report status | Candidate evidence | Acceptance command |');
        lines.push('|---|---|---|---|---|');
        for (const lane of summary.lanes || []) {
            const action = lane.suggestedAction || {};
            if (!action.decision) continue;
            lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(action.decision)} | ${escapeCell(action.status || '-')} | ${escapeCell(action.candidateDecision || lane.candidateDecision || '-')} | ${escapeCell(action.acceptanceCommand || '-')} |`);
        }
        lines.push('');
    }
    if ((summary.lanes || []).some((lane) => (lane.acceptanceChecklist || []).length)) {
        lines.push('## Human Acceptance Checklist');
        lines.push('');
        lines.push('| Lane | Item | Checked | Text |');
        lines.push('|---|---:|---|---|');
        for (const lane of summary.lanes || []) {
            for (const item of lane.acceptanceChecklist || []) {
                const index = Number.isFinite(Number(item.index)) ? Number(item.index) + 1 : '-';
                lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(index)} | ${escapeCell(item.checked ? 'yes' : 'no')} | ${escapeCell(item.text || '-')} |`);
            }
        }
        lines.push('');
    }
    if ((summary.lanes || []).some((lane) => (lane.reviewVideos || []).length)) {
        lines.push('## Review Playlist');
        lines.push('');
        lines.push('| Lane | Case | Kind | Time | Video | Thumbnail |');
        lines.push('|---|---|---|---:|---|---|');
        for (const lane of summary.lanes || []) {
            for (const video of lane.reviewVideos || []) {
                const time = Number.isFinite(Number(video.currentTime)) ? `${Number(video.currentTime)}s` : '-';
                lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(video.caseId || '-')} | ${escapeCell(video.kind || '-')} | ${escapeCell(time)} | ${escapeCell(video.src || '-')} | ${escapeCell(video.thumbnailPath || '-')} |`);
            }
        }
        lines.push('');
    }
    lines.push('## Lane Commands');
    lines.push('');
    lines.push('| Lane | Candidate evidence | Suggested decision | Options | Videos | Temporal | Checklist | Template | Review page | Command |');
    lines.push('|---|---|---|---|---:|---:|---:|---|---|---|');
    for (const lane of summary.lanes || []) {
        const checklist = lane.checklist ? `${lane.checklist.checked}/${lane.checklist.total}` : '-';
        lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(lane.candidateDecision)} | ${escapeCell(lane.suggestedDecision)} | ${escapeCell((lane.suggestedDecisionOptions || []).join(', '))} | ${escapeCell(lane.comparisons)} | ${escapeCell(lane.temporalCases)} | ${escapeCell(checklist)} | ${escapeCell(lane.decisionTemplatePath)} | ${escapeCell(lane.reviewHtmlPath)} | ${escapeCell(lane.decisionCommand)} |`);
    }
    lines.push('');
    if ((summary.lanes || []).some((lane) => lane.candidateEvidence)) {
        lines.push('## Candidate Evidence');
        lines.push('');
        lines.push('| Lane | Decision | Reports | Cases | Improved | Material regressions | Warning regressions | Evidence report |');
        lines.push('|---|---|---:|---:|---:|---:|---:|---|');
        for (const lane of summary.lanes || []) {
            const evidence = lane.candidateEvidence || {};
            lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(lane.candidateDecision)} | ${escapeCell(evidence.reports)} | ${escapeCell(evidence.comparedCases)} | ${escapeCell(evidence.improvedCases)} | ${escapeCell(evidence.materialRegressedCases)} | ${escapeCell(evidence.warningRegressedCases)} | ${escapeCell(evidence.reportPath || '-')} |`);
        }
        lines.push('');
    }
    if ((summary.lanes || []).some((lane) => (lane.diagnosticLinks || []).length)) {
        lines.push('## Diagnostic Links');
        lines.push('');
        lines.push('| Lane | Link | Path |');
        lines.push('|---|---|---|');
        for (const lane of summary.lanes || []) {
            for (const item of lane.diagnosticLinks || []) {
                lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(item.label || 'Diagnostic')} | ${escapeCell(item.path || '-')} |`);
            }
        }
        lines.push('');
    }
    if ((summary.lanes || []).some((lane) => (lane.decisionPreviews || []).length)) {
        lines.push('## Decision Previews');
        lines.push('');
        lines.push('| Lane | Decision | Report status | Next action | Acceptance command | Blockers |');
        lines.push('|---|---|---|---|---|---|');
        for (const lane of summary.lanes || []) {
            for (const preview of lane.decisionPreviews || []) {
                lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(preview.decision)} | ${escapeCell(preview.status)} | ${escapeCell(preview.nextAction)} | ${escapeCell(preview.acceptanceCommand)} | ${escapeCell((preview.blockers || []).join(', ') || '-')} |`);
            }
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

function statusTone(value) {
    if (['pass', 'ready-for-visual-review', 'accepted', 'accepted-for-default-review', 'promote-default-candidate', 'regression-free-human-review'].includes(value)) return 'good';
    if (String(value || '').startsWith('prefer-')) return 'good';
    if (['pending-human-review', 'pending', 'needs-polish', 'review-only', 'available', 'incomplete', 'human-review', 'candidate-aware-human-review', 'insufficient-evidence', 'insufficient-improvement'].includes(value)) return 'warn';
    if (['rejected', 'reject', 'invalid', 'unverified-template-missing'].includes(value)) return 'bad';
    return 'muted';
}

function renderPill(label, value, tone = 'muted') {
    return `<span class="pill ${escapeHtml(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? '-')}</strong></span>`;
}

function formatEvidenceSummary(evidence = null) {
    if (!evidence) return '-';
    return `${evidence.reports} reports, ${evidence.comparedCases} cases, ${evidence.improvedCases} improved, ${evidence.materialRegressedCases} material, ${evidence.warningRegressedCases} warning`;
}

function renderEvidenceSummary(evidence = null) {
    const summary = escapeHtml(formatEvidenceSummary(evidence));
    if (!evidence?.reportPath) return summary;
    return `${summary}<br><a href="${escapeHtml(toFileUrl(evidence.reportPath) || '#')}">Evidence report</a>`;
}

function renderDiagnosticLinks(links = []) {
    if (!links.length) return '-';
    return links.map((item) => `<a href="${escapeHtml(toFileUrl(item.path) || '#')}">${escapeHtml(item.label || 'Diagnostic')}</a>`).join(' ');
}

function renderReviewVideoLinks(videos = []) {
    if (!videos.length) return '';
    return `<div class="video-links">
                  ${videos.map((video) => {
                    const basename = video.src ? path.basename(video.src) : 'missing-video';
                    const label = `${video.caseId || 'case'} ${video.kind || 'video'} ${basename}`;
                    const time = Number.isFinite(Number(video.currentTime)) ? `t=${Number(video.currentTime)}s` : '';
                    const thumbName = video.thumbnailPath ? path.basename(video.thumbnailPath) : '';
                    return `<div class="video-link-row">
                      ${video.thumbnailPath ? `<a class="video-thumb-mini" href="${escapeHtml(video.srcUrl || toFileUrl(video.src) || '#')}"><img src="${escapeHtml(video.thumbnailUrl || toFileUrl(video.thumbnailPath) || '#')}" alt="${escapeHtml(label)} thumbnail"></a>` : ''}
                      <div>
                        <a href="${escapeHtml(video.srcUrl || toFileUrl(video.src) || '#')}">${escapeHtml(label)}</a>
                        ${time ? `<span>${escapeHtml(time)}</span>` : ''}
                        ${thumbName ? `<span>${escapeHtml(thumbName)}</span>` : ''}
                      </div>
                    </div>`;
                }).join('')}
                </div>`;
}

function renderReviewPlaylist(summary = {}) {
    const lanes = summary.lanes || [];
    const hasVideos = lanes.some((lane) => (lane.reviewVideos || []).length);
    if (!hasVideos) return '';
    return `
    <section class="panel playlist" id="review-playlist">
      <div class="panel-head">
        <div>
          <h2>Review Playlist</h2>
          <p>Direct links to the full-frame and ROI comparison videos from every decision template.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Lane</th><th>Case</th><th>Kind</th><th>Time</th><th>Thumbnail</th><th>Video</th></tr>
        </thead>
        <tbody>
          ${lanes.flatMap((lane) => (lane.reviewVideos || []).map((video) => {
            const basename = video.src ? path.basename(video.src) : '-';
            const time = Number.isFinite(Number(video.currentTime)) ? `${Number(video.currentTime)}s` : '-';
            const thumbName = video.thumbnailPath ? path.basename(video.thumbnailPath) : '-';
            return `<tr>
              <td><code>${escapeHtml(lane.id || '-')}</code></td>
              <td>${escapeHtml(video.caseId || '-')}</td>
              <td>${escapeHtml(video.kind || '-')}</td>
              <td>${escapeHtml(time)}</td>
              <td>${video.thumbnailPath ? `<a class="video-thumb" href="${escapeHtml(video.thumbnailUrl || toFileUrl(video.thumbnailPath) || '#')}"><img src="${escapeHtml(video.thumbnailUrl || toFileUrl(video.thumbnailPath) || '#')}" alt="${escapeHtml(`${lane.id || '-'} ${video.caseId || '-'} ${video.kind || '-'} thumbnail`)}"><span>${escapeHtml(thumbName)}</span></a>` : '-'}</td>
              <td><a href="${escapeHtml(video.srcUrl || toFileUrl(video.src) || '#')}">${escapeHtml(basename)}</a></td>
            </tr>`;
        })).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderSuggestedActions(summary = {}) {
    const actions = (summary.lanes || [])
        .map((lane) => ({ lane, action: lane.suggestedAction }))
        .filter((item) => item.action?.decision);
    if (!actions.length) return '';
    return `
    <section class="panel suggested-actions" id="suggested-review-actions">
      <div class="panel-head">
        <div>
          <h2>Suggested Review Actions</h2>
          <p>After visual review, copy the matching command for the lane you accept.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Lane</th><th>Decision</th><th>Status</th><th>Evidence</th><th>Command</th></tr>
        </thead>
        <tbody>
          ${actions.map(({ lane, action }) => `<tr data-suggested-action-lane="${escapeHtml(lane.id || '')}">
            <td><code>${escapeHtml(lane.id || '-')}</code></td>
            <td><code>${escapeHtml(action.decision || '-')}</code></td>
            <td><span class="preview-status ${escapeHtml(statusTone(action.status))}">${escapeHtml(action.status || '-')}</span></td>
            <td>${escapeHtml(action.candidateDecision || lane.candidateDecision || '-')}</td>
            <td>
              <div class="copy-command suggested-command">
                <span>Acceptance command</span>
                <button type="button" data-copy-command="${escapeHtml(action.acceptanceCommand || '')}">Copy</button>
              </div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderReviewOrder(summary = {}) {
    const items = summary.reviewOrder || [];
    if (!items.length) return '';
    return `
    <section class="panel review-order" id="review-order">
      <div class="panel-head">
        <div>
          <h2>Review Order</h2>
          <p>Start with the lowest-risk candidate, then inspect polish and candidate-aware tradeoffs.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Rank</th><th>Lane</th><th>Decision</th><th>Status</th><th>Start video</th><th>Reason</th></tr>
        </thead>
        <tbody>
          ${items.map((item) => {
            const video = item.primaryVideo || {};
            const videoName = video.src ? path.basename(video.src) : '-';
            const videoLabel = video.src ? `${video.caseId || '-'} ${video.kind || '-'} ${videoName}` : '-';
            return `<tr data-review-order-lane="${escapeHtml(item.laneId || '')}">
            <td>${escapeHtml(item.rank)}</td>
            <td><code>${escapeHtml(item.laneId || '-')}</code></td>
            <td><code>${escapeHtml(item.suggestedDecision || '-')}</code></td>
            <td><span class="preview-status ${escapeHtml(statusTone(item.suggestedStatus))}">${escapeHtml(item.suggestedStatus || '-')}</span></td>
            <td>${video.src ? `<a href="${escapeHtml(video.srcUrl || toFileUrl(video.src) || '#')}">${escapeHtml(videoLabel)}</a>` : '-'}</td>
            <td>${escapeHtml(item.reason || '-')}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderAcceptanceChecklist(summary = {}) {
    const lanes = summary.lanes || [];
    const hasChecklist = lanes.some((lane) => (lane.acceptanceChecklist || []).length);
    if (!hasChecklist) return '';
    return `
    <section class="panel acceptance-checklist" id="human-acceptance-checklist">
      <div class="panel-head">
        <div>
          <h2>Human Acceptance Checklist</h2>
          <p>Only copy an acceptance command after the relevant lane checklist is true by eye.</p>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Lane</th><th>Item</th><th>Text</th></tr>
        </thead>
        <tbody>
          ${lanes.flatMap((lane) => (lane.acceptanceChecklist || []).map((item) => {
            const index = Number.isFinite(Number(item.index)) ? Number(item.index) + 1 : '-';
            return `<tr data-acceptance-checklist-lane="${escapeHtml(lane.id || '')}">
              <td><code>${escapeHtml(lane.id || '-')}</code></td>
              <td>${escapeHtml(index)}</td>
              <td>${escapeHtml(item.text || '-')}</td>
            </tr>`;
        })).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderDecisionPreviewTable(lane = {}) {
    const previews = lane.decisionPreviews || [];
    if (!previews.length) return '';
    return `
            <tr>
              <th>Preview</th>
              <td>
                <div class="preview-list">
                  ${previews.map((preview) => `
                    <div class="preview-row">
                      <code>${escapeHtml(preview.decision || '-')}</code>
                      <button type="button" data-copy-decision="${escapeHtml(preview.decision || '')}" aria-label="Copy decision ${escapeHtml(preview.decision || '')}">Copy</button>
                      <button type="button" data-copy-command="${escapeHtml(preview.acceptanceCommand || '')}" aria-label="Copy acceptance command for ${escapeHtml(preview.decision || '')}">Copy cmd</button>
                      <span class="preview-status ${escapeHtml(statusTone(preview.status))}">${escapeHtml(preview.status || '-')}</span>
                      <span class="preview-next">${escapeHtml(preview.nextAction || '-')}</span>
                    </div>
                  `).join('')}
                </div>
              </td>
            </tr>`;
}

function renderLaneCard(lane = {}) {
    const checklist = lane.checklist ? `${lane.checklist.checked}/${lane.checklist.total}` : '-';
    const options = (lane.suggestedDecisionOptions || []).join(', ');
    return `
      <article class="lane" data-lane="${escapeHtml(lane.id)}">
        <div class="lane-head">
          <div>
            <h3>${escapeHtml(lane.title || lane.id)}</h3>
            <p>${escapeHtml(lane.id)}</p>
          </div>
          <div class="pill-stack">
            ${renderPill('status', lane.status, statusTone(lane.status))}
            ${renderPill('review', lane.reviewStatus || lane.currentStatus, statusTone(lane.reviewStatus || lane.currentStatus))}
            ${renderPill('temporal', lane.temporalStatus, statusTone(lane.temporalStatus))}
            ${renderPill('evidence', lane.candidateDecision, statusTone(lane.candidateDecision))}
          </div>
        </div>
        <table>
          <tbody>
            <tr><th>Suggested</th><td><code>${escapeHtml(lane.suggestedDecision || '-')}</code></td></tr>
            <tr><th>Options</th><td>${escapeHtml(options || '-')}</td></tr>
            <tr><th>Evidence</th><td>${renderEvidenceSummary(lane.candidateEvidence)}</td></tr>
            <tr><th>Diagnostics</th><td>${renderDiagnosticLinks(lane.diagnosticLinks || [])}</td></tr>
            ${renderDecisionPreviewTable(lane)}
            <tr><th>Videos</th><td>${escapeHtml(lane.comparisons)} comparison videos, ${escapeHtml(lane.temporalRows)} temporal rows${renderReviewVideoLinks(lane.reviewVideos || [])}</td></tr>
            <tr><th>Checklist</th><td>${escapeHtml(checklist)}</td></tr>
            <tr><th>Template</th><td><a href="${escapeHtml(toFileUrl(lane.decisionTemplatePath) || '#')}">${escapeHtml(lane.decisionTemplatePath || '-')}</a></td></tr>
            <tr><th>Review page</th><td><a href="${escapeHtml(lane.reviewHtmlUrl || '#')}">${escapeHtml(lane.reviewHtmlPath || '-')}</a></td></tr>
            <tr>
              <th>Command</th>
              <td>
                <div class="copy-command">
                  <code>${escapeHtml(lane.decisionCommand || '-')}</code>
                  <button type="button" data-copy-command="${escapeHtml(lane.decisionCommand || '')}">Copy</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </article>`;
}

export function renderVideoAcceptanceQuickstartHtml(summary = {}) {
    const dashboardUrl = summary.dashboardHtmlUrl || '#';
    const screenshotUrl = toFileUrl(summary.dashboardScreenshotPath) || '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Video Acceptance Quickstart</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: oklch(16% 0.012 250);
      --panel: oklch(21% 0.014 250);
      --panel-2: oklch(26% 0.018 250);
      --text: oklch(95% 0.008 250);
      --muted: oklch(73% 0.018 250);
      --line: oklch(34% 0.02 250);
      --good: oklch(73% 0.14 155);
      --warn: oklch(78% 0.13 82);
      --bad: oklch(70% 0.16 25);
      --accent: oklch(72% 0.12 235);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 22px; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    h3 { font-size: 16px; }
    p { margin: 6px 0 0; color: var(--muted); max-width: 72ch; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; color: var(--text); overflow-wrap: anywhere; }
    .top-pills, .pill-stack, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .top-pills { justify-content: flex-end; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; color: var(--muted); display: inline-flex; gap: 8px; align-items: center; }
    .pill strong { color: var(--text); }
    .pill.good strong { color: var(--good); }
    .pill.warn strong { color: var(--warn); }
    .pill.bad strong { color: var(--bad); }
    .panel, .lane { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .panel { margin-top: 18px; }
    .panel-head { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 14px; border-bottom: 1px solid var(--line); }
    .actions a, button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      min-height: 32px;
      padding: 0 11px;
      display: inline-flex;
      align-items: center;
      font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .actions a:hover, button:hover { border-color: var(--accent); text-decoration: none; }
    button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .hero-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr); gap: 16px; align-items: start; }
    .shot { background: oklch(12% 0.01 250); border-top: 1px solid var(--line); }
    .shot img { width: 100%; display: block; object-fit: cover; object-position: top left; max-height: 420px; }
    .facts { padding: 14px; display: grid; gap: 10px; }
    .fact { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 9px; }
    .fact span { color: var(--muted); }
    .playlist table th:nth-child(1) { width: 132px; }
    .playlist table th:nth-child(2), .playlist table th:nth-child(3), .playlist table th:nth-child(4) { width: 92px; }
    .playlist table th:nth-child(5) { width: 180px; }
    .review-order table th:nth-child(1) { width: 72px; }
    .review-order table th:nth-child(2), .review-order table th:nth-child(3), .review-order table th:nth-child(4) { width: 170px; }
    .suggested-actions table th:nth-child(1) { width: 132px; }
    .suggested-actions table th:nth-child(2), .suggested-actions table th:nth-child(3), .suggested-actions table th:nth-child(4) { width: 140px; }
    .acceptance-checklist table th:nth-child(1) { width: 132px; }
    .acceptance-checklist table th:nth-child(2) { width: 72px; }
    .lanes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 18px; }
    .lane-head { display: flex; justify-content: space-between; gap: 12px; padding: 14px; border-bottom: 1px solid var(--line); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-bottom: 1px solid var(--line); }
    th { width: 108px; color: var(--muted); font-weight: 650; background: color-mix(in srgb, var(--panel-2) 62%, transparent); }
    .copy-command { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
    .suggested-command span { color: var(--muted); font-weight: 650; }
    .preview-list { display: grid; gap: 7px; }
    .preview-row { display: grid; grid-template-columns: minmax(90px, 0.55fr) max-content max-content minmax(120px, 0.95fr); gap: 8px; align-items: center; }
    .preview-row button { min-height: 28px; padding: 0 9px; }
    .video-links { display: grid; gap: 8px; margin-top: 8px; }
    .video-links a { overflow-wrap: anywhere; }
    .video-links span { color: var(--muted); font-size: 12px; }
    .video-link-row { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; align-items: start; }
    .video-link-row:not(:has(.video-thumb-mini)) { grid-template-columns: 1fr; }
    .video-thumb, .video-thumb-mini { display: grid; gap: 5px; color: var(--muted); font-size: 11px; }
    .video-thumb img, .video-thumb-mini img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--line); border-radius: 6px; background: oklch(12% 0.01 250); }
    .video-thumb-mini img { width: 64px; }
    .preview-status { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
    .preview-status.good { color: var(--good); }
    .preview-status.warn { color: var(--warn); }
    .preview-status.bad { color: var(--bad); }
    .preview-status.muted { color: var(--muted); }
    .preview-next { grid-column: 1 / -1; color: var(--muted); overflow-wrap: anywhere; padding-left: 2px; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      header, .panel-head, .lane-head { display: block; }
      .top-pills, .pill-stack, .actions { justify-content: flex-start; margin-top: 10px; }
      .hero-grid, .lanes { grid-template-columns: 1fr; }
      .copy-command { grid-template-columns: 1fr; }
      .copy-command button { width: max-content; }
      .preview-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Video Acceptance Quickstart</h1>
        <p>Open the dashboard, choose one lane that is usable by eye, update its decision template, then run the matching command.</p>
      </div>
      <div class="top-pills">
        ${renderPill('status', summary.status, statusTone(summary.status))}
        ${renderPill('acceptance', summary.acceptanceStatus, statusTone(summary.acceptanceStatus))}
        ${renderPill('lanes', `${summary.readyLanes}/${summary.laneCount}`, 'good')}
        ${renderPill('assets missing', summary.missingAssets, summary.missingAssets ? 'bad' : 'good')}
      </div>
    </header>

    <section class="hero-grid">
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Review Entry</h2>
            <p>${escapeHtml(summary.requiredForCompletion || '')}</p>
          </div>
          <div class="actions">
            <a href="${escapeHtml(dashboardUrl)}">Open Dashboard</a>
            <a href="${escapeHtml(toFileUrl(summary.bundleMarkdownPath) || '#')}">Bundle Report</a>
            <a href="${escapeHtml(toFileUrl(summary.goalStatusMarkdownPath) || '#')}">Goal Status</a>
            ${summary.reviewThumbnailSheetUrl ? `<a href="${escapeHtml(summary.reviewThumbnailSheetUrl)}">Thumbnail Sheet</a>` : ''}
          </div>
        </div>
        ${screenshotUrl ? `<a class="shot" href="${escapeHtml(dashboardUrl)}"><img src="${escapeHtml(screenshotUrl)}" alt="Video delivery dashboard screenshot"></a>` : ''}
      </div>
      <aside class="panel">
        <div class="panel-head"><h2>Gate</h2></div>
        <div class="facts">
          <div class="fact"><span>Next action</span><strong>${escapeHtml(summary.nextAction || '-')}</strong></div>
          <div class="fact"><span>Blockers</span><strong>${escapeHtml((summary.blockers || []).join(', ') || '-')}</strong></div>
          <div class="fact"><span>Requirements</span><strong>${escapeHtml(summary.satisfiedRequirements)}/${escapeHtml(summary.requirementCount)}</strong></div>
          <div class="fact"><span>Review thumbnails</span><strong>${escapeHtml(summary.reviewThumbnailCount || 0)}/${escapeHtml(summary.reviewVideoCount || 0)}</strong></div>
          <div class="fact"><span>Missing assets</span><strong>${escapeHtml(summary.missingAssets)}</strong></div>
        </div>
      </aside>
    </section>

    ${renderReviewOrder(summary)}

    ${renderSuggestedActions(summary)}

    ${renderAcceptanceChecklist(summary)}

    ${renderReviewPlaylist(summary)}

    <section class="lanes">
      ${(summary.lanes || []).map((lane) => renderLaneCard(lane)).join('')}
    </section>
  </main>
  <script>
    (() => {
      async function copyText(text) {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      document.querySelectorAll('[data-copy-command], [data-copy-decision]').forEach((button) => {
        const original = button.textContent;
        button.addEventListener('click', async () => {
          try {
            await copyText(button.dataset.copyCommand || button.dataset.copyDecision || '');
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = original; }, 1200);
          } catch {
            button.textContent = 'Failed';
            setTimeout(() => { button.textContent = original; }, 1600);
          }
        });
      });
    })();
  </script>
</body>
</html>
`;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function createVideoAcceptanceQuickstart({
    bundlePath = DEFAULT_BUNDLE_PATH,
    dashboardPath = DEFAULT_DASHBOARD_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    jsonPath = DEFAULT_JSON_PATH,
    htmlPath = DEFAULT_HTML_PATH,
    bundleReport = null,
    dashboardReport = null,
    generateReviewThumbnails = false,
    reviewThumbnailDir = DEFAULT_REVIEW_THUMBNAIL_DIR,
    reviewThumbnailGenerator = createVideoReviewThumbnail,
    reviewThumbnailSheetPath = null,
    reviewThumbnailSheetJsonPath = null
} = {}) {
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedJsonPath = path.resolve(jsonPath);
    const resolvedHtmlPath = path.resolve(htmlPath);
    const summary = await enrichDecisionPreviews(createVideoAcceptanceQuickstartSummary({
        bundleReport: bundleReport || await readJson(bundlePath),
        dashboardReport: dashboardReport || await readJson(dashboardPath)
    }), {
        generateReviewThumbnails,
        reviewThumbnailDir,
        reviewThumbnailGenerator
    });
    if (reviewThumbnailSheetPath) {
        summary.reviewThumbnailSheetPath = path.resolve(reviewThumbnailSheetPath);
        summary.reviewThumbnailSheetUrl = toFileUrl(reviewThumbnailSheetPath);
    }
    if (reviewThumbnailSheetJsonPath) {
        summary.reviewThumbnailSheetJsonPath = path.resolve(reviewThumbnailSheetJsonPath);
    }
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, renderVideoAcceptanceQuickstartMarkdown(summary), 'utf8');
    await mkdir(path.dirname(resolvedJsonPath), { recursive: true });
    await writeFile(resolvedJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(resolvedHtmlPath), { recursive: true });
    await writeFile(resolvedHtmlPath, renderVideoAcceptanceQuickstartHtml(summary), 'utf8');
    return {
        ...summary,
        outputPath: resolvedOutputPath,
        jsonPath: resolvedJsonPath,
        htmlPath: resolvedHtmlPath
    };
}

function parseArgs(argv) {
    const parsed = {
        bundlePath: DEFAULT_BUNDLE_PATH,
        dashboardPath: DEFAULT_DASHBOARD_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        jsonPath: DEFAULT_JSON_PATH,
        htmlPath: DEFAULT_HTML_PATH,
        generateReviewThumbnails: false,
        reviewThumbnailDir: DEFAULT_REVIEW_THUMBNAIL_DIR,
        reviewThumbnailSheetPath: null,
        reviewThumbnailSheetJsonPath: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--bundle') {
            parsed.bundlePath = path.resolve(argv[++i] || DEFAULT_BUNDLE_PATH);
        } else if (arg === '--dashboard') {
            parsed.dashboardPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--json') {
            parsed.jsonPath = path.resolve(argv[++i] || DEFAULT_JSON_PATH);
        } else if (arg === '--html') {
            parsed.htmlPath = path.resolve(argv[++i] || DEFAULT_HTML_PATH);
        } else if (arg === '--generate-review-thumbnails') {
            parsed.generateReviewThumbnails = true;
        } else if (arg === '--review-thumbnail-dir') {
            parsed.reviewThumbnailDir = path.resolve(argv[++i] || DEFAULT_REVIEW_THUMBNAIL_DIR);
        } else if (arg === '--review-thumbnail-sheet') {
            parsed.reviewThumbnailSheetPath = path.resolve(argv[++i] || '');
        } else if (arg === '--review-thumbnail-sheet-json') {
            parsed.reviewThumbnailSheetJsonPath = path.resolve(argv[++i] || '');
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
  node scripts/create-video-acceptance-quickstart.js [--bundle <json>] [--dashboard <json>] [--output <md>] [--json <json>] [--html <html>]

Default output:
  .artifacts/video-delivery-bundle/latest-acceptance-quickstart.md
  .artifacts/video-delivery-bundle/latest-acceptance-quickstart.json
  .artifacts/video-delivery-bundle/latest-acceptance-quickstart.html

Optional:
  --generate-review-thumbnails
  --review-thumbnail-dir <dir>
  --review-thumbnail-sheet <png>
  --review-thumbnail-sheet-json <json>
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoAcceptanceQuickstart(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`acceptance: ${report.acceptanceStatus || '-'}`);
            console.log(`markdown: ${report.outputPath}`);
            console.log(`json: ${report.jsonPath}`);
            console.log(`html: ${report.htmlPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
