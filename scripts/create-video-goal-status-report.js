import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_DASHBOARD_REPORT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-goal-status/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-goal-status/latest-report.md');
const DEFAULT_VERIFICATION_REPORT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-verification-report.json');

function requirement(id, description, satisfied, evidence = {}, blockers = []) {
    return {
        id,
        description,
        status: satisfied ? 'satisfied' : 'unsatisfied',
        satisfied,
        evidence,
        blockers: satisfied ? [] : blockers
    };
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

function summarizeDashboard(dashboard = {}) {
    const lanes = Array.isArray(dashboard.lanes) ? dashboard.lanes : [];
    const laneById = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));
    const acceptedLanes = lanes.filter((lane) => {
        const status = lane.reviewStatus || '';
        return (status === 'accepted-for-default-review' ||
            status === 'prefer-current-default-candidate' ||
            status === 'prefer-light-polish-candidate' ||
            status === 'prefer-strength018-polish-candidate' ||
            status === 'prefer-strength022-polish-candidate' ||
            status === 'prefer-alpha-policy035-candidate') &&
            lane.checklist?.allChecked === true;
    });

    return {
        lanes,
        laneById,
        acceptedLanes,
        missingAssets: Array.isArray(dashboard.missingAssets) ? dashboard.missingAssets : [],
        currentLane: laneById.current025 || null
    };
}

export function createVideoGoalStatusSummary(dashboard = {}, { verification = null } = {}) {
    const summary = summarizeDashboard(dashboard);
    const lanes = summary.lanes;
    const currentLane = summary.currentLane;
    const allAssetsPresent = summary.missingAssets.length === 0 &&
        lanes.length > 0 &&
        lanes.every((lane) => Array.isArray(lane.assets) && lane.assets.length > 0 && lane.missingAssets?.length === 0);
    const currentReady = Boolean(
        currentLane &&
        currentLane.status === 'ready-for-visual-review' &&
        currentLane.temporalStatus === 'pass' &&
        currentLane.ready === true &&
        Number(currentLane.comparisons) >= 4 &&
        Number(currentLane.temporalCases) >= 4
    );
    const alternativesReady = lanes
        .filter((lane) => lane.id !== 'current025')
        .every((lane) => lane.ready === true && Number(lane.comparisons) >= 4 && Number(lane.temporalCases) > 0);
    const humanAccepted = summary.acceptedLanes.length > 0;
    const docsSynced = Boolean(
        dashboard.outputPath &&
        lanes.length >= 3 &&
        lanes.every((lane) => lane.bestCandidate)
    );

    const requirements = [
        requirement(
            'viewable-review-artifacts',
            'All review lanes expose viewable HTML, screenshots, reports, and decision JSON without missing assets.',
            allAssetsPresent,
            {
                laneCount: lanes.length,
                missingAssets: summary.missingAssets.length,
                laneAssets: lanes.map((lane) => ({
                    id: lane.id,
                    assets: lane.assets?.length || 0,
                    missingAssets: lane.missingAssets?.length || 0
                }))
            },
            ['video-review-artifact-missing']
        ),
        requirement(
            'current-candidate-ready-for-visual-review',
            'The current 0.25 candidate has delivery gate pass, temporal pass, and enough review videos.',
            currentReady,
            {
                status: currentLane?.status || null,
                temporalStatus: currentLane?.temporalStatus || null,
                ready: currentLane?.ready === true,
                comparisons: currentLane?.comparisons ?? null,
                temporalCases: currentLane?.temporalCases ?? null,
                bestCandidate: currentLane?.bestCandidate || null
            },
            ['current-candidate-not-ready-for-visual-review']
        ),
        requirement(
            'alternatives-available-for-human-review',
            'The 0.20 backup and narrow strength sweep are available as review-only alternatives with comparison videos and temporal evidence.',
            alternativesReady,
            {
                alternatives: lanes.filter((lane) => lane.id !== 'current025').map((lane) => ({
                    id: lane.id,
                    status: lane.status,
                    ready: lane.ready,
                    comparisons: lane.comparisons,
                    temporalCases: lane.temporalCases
                }))
            },
            ['alternative-review-lanes-not-ready']
        ),
        requirement(
            'human-acceptance-recorded',
            'At least one lane has a human acceptance decision with checklist fully checked.',
            humanAccepted,
            {
                acceptedLanes: summary.acceptedLanes.map((lane) => ({
                    id: lane.id,
                    reviewStatus: lane.reviewStatus,
                    checklist: lane.checklist
                })),
                currentReviewStatus: currentLane?.reviewStatus || null,
                currentChecklist: currentLane?.checklist || null
            },
            ['human-review-acceptance-missing']
        ),
        requirement(
            'progress-documentation-synced',
            'Dashboard report contains enough stable paths and candidate metadata for the progress document to point to current artifacts.',
            docsSynced,
            {
                dashboardPath: dashboard.outputPath || null,
                laneCandidates: lanes.map((lane) => ({ id: lane.id, bestCandidate: lane.bestCandidate || null }))
            },
            ['dashboard-metadata-incomplete']
        )
    ];
    if (verification) {
        const verificationSatisfied = verification.status === 'ready-for-human-review' || verification.status === 'complete';
        requirements.splice(4, 0, requirement(
            'delivery-bundle-verified',
            'The delivery bundle, dashboard, quickstart, review pages, decision templates, screenshots, and lane commands pass the bundle integrity verifier.',
            verificationSatisfied,
            {
                status: verification.status || null,
                checks: verification.summary?.checks ?? null,
                passed: verification.summary?.passed ?? null,
                failed: verification.summary?.failed ?? null,
                outputPath: verification.outputPath || null,
                markdownPath: verification.markdownPath || null
            },
            ['video-delivery-bundle-verification-failed']
        ));
    }

    const blockers = requirements.flatMap((item) => item.blockers);
    const complete = requirements.every((item) => item.satisfied);
    return {
        generatedAt: new Date().toISOString(),
        status: complete ? 'complete' : 'incomplete',
        complete,
        nextAction: complete ? 'mark-goal-complete' : 'collect-human-review-acceptance',
        dashboardGeneratedAt: dashboard.generatedAt || null,
        dashboardPath: dashboard.outputPath || null,
        verificationPath: verification?.outputPath || null,
        requirements,
        blockers,
        lanes: lanes.map((lane) => ({
            id: lane.id,
            title: lane.title,
            status: lane.status,
            temporalStatus: lane.temporalStatus,
            reviewStatus: lane.reviewStatus,
            nextAction: lane.nextAction,
            checklist: lane.checklist,
            ready: lane.ready,
            bestCandidate: lane.bestCandidate,
            comparisons: lane.comparisons,
            temporalCases: lane.temporalCases,
            missingAssets: lane.missingAssets?.length || 0
        }))
    };
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

export function renderVideoGoalStatusMarkdown(report) {
    const lines = [];
    lines.push('# Video Goal Status Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.status}`);
    lines.push(`Next action: ${report.nextAction}`);
    lines.push('');
    lines.push('## Requirements');
    lines.push('');
    lines.push('| Requirement | Status | Blockers |');
    lines.push('|---|---|---|');
    for (const item of report.requirements) {
        lines.push(`| ${escapeCell(item.id)} | ${item.status} | ${escapeCell(item.blockers.length ? item.blockers.join(', ') : '-')} |`);
    }
    lines.push('');
    lines.push('## Lanes');
    lines.push('');
    lines.push('| Lane | Status | Temporal | Review | Checklist | Next |');
    lines.push('|---|---|---|---|---:|---|');
    for (const lane of report.lanes) {
        const checklist = lane.checklist ? `${lane.checklist.checked}/${lane.checklist.total}` : '-';
        lines.push(`| ${escapeCell(lane.id)} | ${escapeCell(lane.status)} | ${escapeCell(lane.temporalStatus)} | ${escapeCell(lane.reviewStatus)} | ${escapeCell(checklist)} | ${escapeCell(lane.nextAction)} |`);
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

export async function createVideoGoalStatusReport({
    dashboardReportPath = DEFAULT_DASHBOARD_REPORT_PATH,
    verificationReportPath = null,
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH
} = {}) {
    const dashboard = await readJson(dashboardReportPath);
    const verification = verificationReportPath ? await readJson(verificationReportPath) : null;
    const report = {
        dashboardReportPath: path.resolve(dashboardReportPath),
        verificationReportPath: verificationReportPath ? path.resolve(verificationReportPath) : null,
        ...createVideoGoalStatusSummary(dashboard, { verification })
    };
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
    await writeFile(path.resolve(markdownPath), renderVideoGoalStatusMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: path.resolve(outputPath),
        markdownPath: path.resolve(markdownPath)
    };
}

function parseArgs(argv) {
    const parsed = {
        dashboardReportPath: DEFAULT_DASHBOARD_REPORT_PATH,
        verificationReportPath: null,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--dashboard-report') {
            parsed.dashboardReportPath = path.resolve(argv[++i] || DEFAULT_DASHBOARD_REPORT_PATH);
        } else if (arg === '--verification-report') {
            parsed.verificationReportPath = path.resolve(argv[++i] || DEFAULT_VERIFICATION_REPORT_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
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
  node scripts/create-video-goal-status-report.js [--dashboard-report <json>] [--output <json>] [--markdown <md>]
  node scripts/create-video-goal-status-report.js --verification-report .artifacts/video-delivery-bundle/latest-verification-report.json

Default output:
  .artifacts/video-goal-status/latest-report.json
  .artifacts/video-goal-status/latest-report.md
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoGoalStatusReport(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`next: ${report.nextAction}`);
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
