import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createVideoReviewDecisionReport } from './create-video-review-decision-report.js';

const DEFAULT_REVIEW_PACK_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json');
const DEFAULT_REVIEW_HTML_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html');
const DEFAULT_DECISION_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision.pending.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md');

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export function createPendingReviewDecision({
    reviewPack = {},
    reviewHtmlPath = DEFAULT_REVIEW_HTML_PATH,
    decisionPath = DEFAULT_DECISION_PATH,
    deliveryStatus = null,
    temporalStatus = null
} = {}) {
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
        templateInstructions: 'Pending report seed. Edit decision, notes, and checklist checked values after human review, then rerun pnpm report:video-review-decision with this file.',
        templatePath: path.resolve(decisionPath),
        page: reviewHtmlPath ? pathToFileURL(path.resolve(reviewHtmlPath)).href : null,
        deliveryStatus: deliveryStatus || reviewPack.delivery?.status || null,
        temporalStatus: temporalStatus || (reviewPack.temporal?.cases?.length ? 'available' : null),
        candidate: reviewPack.delivery?.bestCandidate?.profileLabel || null,
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

export async function createVideoPendingReviewDecision({
    reviewPackPath = DEFAULT_REVIEW_PACK_PATH,
    reviewHtmlPath = DEFAULT_REVIEW_HTML_PATH,
    decisionPath = DEFAULT_DECISION_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    deliveryStatus = null,
    temporalStatus = null
} = {}) {
    const reviewPack = await readJson(reviewPackPath);
    const decision = createPendingReviewDecision({
        reviewPack,
        reviewHtmlPath,
        decisionPath,
        deliveryStatus,
        temporalStatus
    });
    const resolvedDecisionPath = path.resolve(decisionPath);
    await mkdir(path.dirname(resolvedDecisionPath), { recursive: true });
    await writeFile(resolvedDecisionPath, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
    const report = await createVideoReviewDecisionReport({
        decisionPath: resolvedDecisionPath,
        outputPath,
        markdownPath
    });
    return {
        decisionPath: resolvedDecisionPath,
        outputPath: report.outputPath,
        markdownPath: report.markdownPath,
        status: report.status,
        warnings: report.warnings,
        blockers: report.blockers
    };
}

function parseArgs(argv) {
    const parsed = {
        reviewPackPath: DEFAULT_REVIEW_PACK_PATH,
        reviewHtmlPath: DEFAULT_REVIEW_HTML_PATH,
        decisionPath: DEFAULT_DECISION_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        deliveryStatus: null,
        temporalStatus: null
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--review-pack') {
            parsed.reviewPackPath = path.resolve(argv[++i] || DEFAULT_REVIEW_PACK_PATH);
        } else if (arg === '--review-html') {
            parsed.reviewHtmlPath = path.resolve(argv[++i] || DEFAULT_REVIEW_HTML_PATH);
        } else if (arg === '--decision') {
            parsed.decisionPath = path.resolve(argv[++i] || DEFAULT_DECISION_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
        } else if (arg === '--delivery-status') {
            parsed.deliveryStatus = argv[++i] || null;
        } else if (arg === '--temporal-status') {
            parsed.temporalStatus = argv[++i] || null;
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
  node scripts/create-video-pending-review-decision.js [--review-pack <json>] [--review-html <html>] [--decision <json>] [--output <json>] [--markdown <md>]

Default output:
  .artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision.pending.json
  .artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json
  .artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoPendingReviewDecision(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`decision: ${report.decisionPath}`);
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            if (report.warnings?.length) console.log(`warnings: ${report.warnings.join(', ')}`);
            if (report.blockers?.length) console.log(`blockers: ${report.blockers.join(', ')}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
