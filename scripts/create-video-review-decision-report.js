import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_DECISION_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md');

const DECISION_STATUS = Object.freeze({
    ACCEPT: 'accepted-for-default-review',
    PREFER_CURRENT: 'prefer-current-default-candidate',
    PREFER_LIGHT: 'prefer-light-polish-candidate',
    PREFER_STRENGTH018: 'prefer-strength018-polish-candidate',
    PREFER_STRENGTH022: 'prefer-strength022-polish-candidate',
    PREFER_ALPHA_POLICY035: 'prefer-alpha-policy035-candidate',
    NEEDS_POLISH: 'needs-polish',
    REJECT: 'rejected',
    PENDING: 'pending',
    INVALID: 'invalid'
});

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDecisionValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'accept') return 'accept';
    if (['prefer-current', 'keep-current', 'prefer-strength025'].includes(normalized)) return 'prefer-current';
    if (['prefer-light', 'prefer-lighter', 'prefer-strength020'].includes(normalized)) return 'prefer-light';
    if (normalized === 'prefer-strength018') return 'prefer-strength018';
    if (normalized === 'prefer-strength022') return 'prefer-strength022';
    if (['prefer-alpha-policy035', 'prefer-policy035', 'prefer-alpha035'].includes(normalized)) return 'prefer-alpha-policy035';
    if (normalized === 'needs-polish') return 'needs-polish';
    if (normalized === 'needs-more-polish') return 'needs-more-polish';
    if (normalized === 'reject') return 'reject';
    if (normalized === 'reject-both') return 'reject-both';
    return 'pending';
}

function summarizeChecklist(checklist = []) {
    const items = Array.isArray(checklist) ? checklist : [];
    const checked = items.filter((item) => item?.checked === true).length;
    return {
        total: items.length,
        checked,
        unchecked: Math.max(0, items.length - checked),
        allChecked: items.length > 0 && checked === items.length
    };
}

function summarizeVideoCoverage(videos = []) {
    const items = Array.isArray(videos) ? videos : [];
    const cases = [...new Set(items.map((item) => item?.caseId).filter(Boolean))].sort();
    const views = [...new Set(items.map((item) => item?.kind).filter(Boolean))].sort();
    return {
        total: items.length,
        cases,
        views,
        hasRoi: views.includes('roi'),
        hasFull: views.includes('full'),
        allHaveTime: items.length > 0 && items.every((item) => Number.isFinite(Number(item.currentTime)))
    };
}

export function createVideoReviewDecisionSummary(decision = {}) {
    const blockers = [];
    const warnings = [];
    const normalizedDecision = normalizeDecisionValue(decision.decision);
    const checklist = summarizeChecklist(decision.checklist);
    const videoCoverage = summarizeVideoCoverage(decision.videos);
    const polishReviewDecisions = new Set([
        'prefer-current',
        'prefer-light',
        'prefer-strength018',
        'prefer-strength022',
        'prefer-alpha-policy035',
        'needs-more-polish',
        'reject-both'
    ]);
    const reviewMode = decision.deliveryStatus === 'review-only' || polishReviewDecisions.has(normalizedDecision)
        ? 'polish-comparison'
        : 'default-candidate';
    const deliveryReady = decision.deliveryStatus === 'ready-for-visual-review'
        || (reviewMode === 'polish-comparison' && decision.deliveryStatus === 'review-only');
    const temporalReady = decision.temporalStatus === 'pass'
        || (reviewMode === 'polish-comparison' && decision.temporalStatus === 'available');

    if (!isObject(decision)) blockers.push('decision-json-invalid');
    if (!normalizedDecision || normalizedDecision === 'pending') warnings.push('decision-pending');
    if (!deliveryReady) blockers.push('delivery-not-ready-for-visual-review');
    if (!temporalReady) blockers.push('temporal-gate-not-pass');
    if (reviewMode === 'polish-comparison') warnings.push('review-only-polish-comparison');
    if (videoCoverage.total <= 0) blockers.push('decision-videos-missing');
    if (videoCoverage.total > 0 && (!videoCoverage.hasRoi || !videoCoverage.hasFull)) {
        warnings.push('decision-missing-roi-or-full-view');
    }
    if (checklist.total <= 0) warnings.push('decision-checklist-missing');
    if (checklist.total > 0 && !checklist.allChecked) warnings.push('decision-checklist-incomplete');

    let status = DECISION_STATUS.PENDING;
    if (blockers.length) {
        status = DECISION_STATUS.INVALID;
    } else if (normalizedDecision === 'accept') {
        status = checklist.allChecked ? DECISION_STATUS.ACCEPT : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('accept-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'needs-polish') {
        status = DECISION_STATUS.NEEDS_POLISH;
    } else if (normalizedDecision === 'prefer-current') {
        status = checklist.allChecked ? DECISION_STATUS.PREFER_CURRENT : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('prefer-current-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'prefer-light') {
        status = checklist.allChecked ? DECISION_STATUS.PREFER_LIGHT : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('prefer-light-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'prefer-strength018') {
        status = checklist.allChecked ? DECISION_STATUS.PREFER_STRENGTH018 : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('prefer-strength018-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'prefer-strength022') {
        status = checklist.allChecked ? DECISION_STATUS.PREFER_STRENGTH022 : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('prefer-strength022-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'prefer-alpha-policy035') {
        status = checklist.allChecked ? DECISION_STATUS.PREFER_ALPHA_POLICY035 : DECISION_STATUS.NEEDS_POLISH;
        if (!checklist.allChecked) warnings.push('prefer-alpha-policy035-decision-with-incomplete-checklist');
    } else if (normalizedDecision === 'needs-more-polish') {
        status = DECISION_STATUS.NEEDS_POLISH;
    } else if (normalizedDecision === 'reject') {
        status = DECISION_STATUS.REJECT;
    } else if (normalizedDecision === 'reject-both') {
        status = DECISION_STATUS.REJECT;
    }

    const nextAction = (() => {
        if (status === DECISION_STATUS.ACCEPT) return 'promote-to-default-strategy-review';
        if (status === DECISION_STATUS.PREFER_CURRENT) return 'keep-current-strength025-and-continue-default-review';
        if (status === DECISION_STATUS.PREFER_LIGHT) return 'run-narrow-strength020-sweep-or-promote-light-polish-review';
        if (status === DECISION_STATUS.PREFER_STRENGTH018) return 'promote-strength018-to-polish-review';
        if (status === DECISION_STATUS.PREFER_STRENGTH022) return 'promote-strength022-to-polish-review';
        if (status === DECISION_STATUS.PREFER_ALPHA_POLICY035) return 'promote-alpha-policy035-to-default-candidate-review';
        if (status === DECISION_STATUS.NEEDS_POLISH) {
            return normalizedDecision === 'needs-more-polish'
                || normalizedDecision === 'prefer-light'
                || normalizedDecision === 'prefer-strength018'
                || normalizedDecision === 'prefer-strength022'
                || normalizedDecision === 'prefer-alpha-policy035'
                ? 'run-narrow-polish-sweep-before-default-review'
                : 'run-light-polish-pass-before-default-review';
        }
        if (status === DECISION_STATUS.REJECT) {
            return normalizedDecision === 'reject-both'
                ? 'reject-current-and-light-polish-candidates'
                : 'reject-current-boundary-gradient-candidate';
        }
        return 'collect-human-review-decision';
    })();

    return {
        generatedAt: new Date().toISOString(),
        status,
        decision: normalizedDecision,
        reviewMode,
        candidate: decision.candidate || null,
        exportedAt: decision.exportedAt || null,
        page: decision.page || null,
        deliveryStatus: decision.deliveryStatus || null,
        temporalStatus: decision.temporalStatus || null,
        notes: decision.notes || '',
        checklist,
        videoCoverage,
        blockers,
        warnings,
        nextAction
    };
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

export function renderVideoReviewDecisionMarkdown(report) {
    const lines = [];
    lines.push('# Video Review Decision Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.status}`);
    lines.push(`Decision: ${report.decision}`);
    lines.push(`Review mode: ${report.reviewMode}`);
    lines.push(`Next action: ${report.nextAction}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Candidate | ${escapeCell(report.candidate)} |`);
    lines.push(`| Delivery | ${escapeCell(report.deliveryStatus)} |`);
    lines.push(`| Temporal | ${escapeCell(report.temporalStatus)} |`);
    lines.push(`| Checklist | ${report.checklist.checked}/${report.checklist.total} checked |`);
    lines.push(`| Videos | ${report.videoCoverage.total} (${escapeCell(report.videoCoverage.views.join(', ') || '-')}) |`);
    lines.push(`| Blockers | ${escapeCell(report.blockers.length ? report.blockers.join(', ') : '-')} |`);
    lines.push(`| Warnings | ${escapeCell(report.warnings.length ? report.warnings.join(', ') : '-')} |`);
    lines.push('');
    if (report.notes) {
        lines.push('## Notes');
        lines.push('');
        lines.push(report.notes);
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

function applyDecisionOverrides(decision = {}, { setDecision = null, checkAll = false, notes = null } = {}) {
    const checklist = Array.isArray(decision.checklist)
        ? decision.checklist.map((item) => ({ ...item, checked: checkAll ? true : item.checked }))
        : [];
    return {
        ...decision,
        decision: setDecision || decision.decision,
        notes: notes ?? decision.notes,
        checklist
    };
}

export async function createVideoReviewDecisionReport({
    decisionPath = DEFAULT_DECISION_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    setDecision = null,
    checkAll = false,
    notes = null
} = {}) {
    const decision = applyDecisionOverrides(await readJson(decisionPath), { setDecision, checkAll, notes });
    const report = {
        decisionPath: path.resolve(decisionPath),
        appliedOverrides: {
            setDecision: setDecision || null,
            checkAll: checkAll === true,
            notes: notes !== null
        },
        ...createVideoReviewDecisionSummary(decision)
    };
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(path.resolve(markdownPath)), { recursive: true });
    await writeFile(path.resolve(markdownPath), renderVideoReviewDecisionMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: path.resolve(outputPath),
        markdownPath: path.resolve(markdownPath)
    };
}

function parseArgs(argv) {
    const parsed = {
        decisionPath: DEFAULT_DECISION_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        setDecision: null,
        checkAll: false,
        notes: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--decision') {
            parsed.decisionPath = path.resolve(argv[++i] || DEFAULT_DECISION_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
        } else if (arg === '--set-decision') {
            parsed.setDecision = argv[++i] || null;
        } else if (arg === '--check-all') {
            parsed.checkAll = true;
        } else if (arg === '--notes') {
            parsed.notes = argv[++i] || '';
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
  node scripts/create-video-review-decision-report.js --decision <decision.json> [--output <json>] [--markdown <md>]
  node scripts/create-video-review-decision-report.js --decision <decision.json> --set-decision <value> --check-all [--notes <text>]
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoReviewDecisionReport(args)
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
