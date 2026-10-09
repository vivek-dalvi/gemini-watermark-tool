import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_REVIEW_CLUSTER_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-clusters.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-worksheet.md');
const DEFAULT_CSV_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-table.csv');

function parseArgs(argv) {
    const parsed = {
        validationPath: DEFAULT_VALIDATION_PATH,
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        reviewClusterPath: DEFAULT_REVIEW_CLUSTER_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        csvOutputPath: DEFAULT_CSV_OUTPUT_PATH,
        limit: 0,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--validation') {
            parsed.validationPath = path.resolve(args.shift() || parsed.validationPath);
            continue;
        }
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--clusters') {
            parsed.reviewClusterPath = path.resolve(args.shift() || parsed.reviewClusterPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--csv-output') {
            parsed.csvOutputPath = path.resolve(args.shift() || parsed.csvOutputPath);
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit >= 0) parsed.limit = Math.floor(limit);
            continue;
        }
        if (arg === '--allow-active-loop-state') {
            parsed.allowActiveLoopState = true;
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

async function readActiveLoopRunState(statePath) {
    if (!existsSync(statePath)) return null;
    try {
        const state = JSON.parse(stripBom(await readFile(statePath, 'utf8')));
        if (state?.status !== 'running') return null;
        return state;
    } catch (error) {
        return {
            status: 'running',
            unreadable: true,
            error: error.message
        };
    }
}

function assessClusterReportIntegrity({ clusterReport, reviewManifestSha256, validationReportSha256 }) {
    const problems = [];
    if (!clusterReport) {
        problems.push('review-cluster-report-missing');
        return problems;
    }
    if (clusterReport.inputs?.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('review-cluster-report-manifest-hash-mismatch');
    }
    if (clusterReport.inputs?.validationReportSha256 !== validationReportSha256) {
        problems.push('review-cluster-report-validation-hash-mismatch');
    }
    return problems;
}

async function readOptionalText(filePath) {
    try {
        return stripBom(await readFile(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function readOptionalJson(filePath) {
    const text = await readOptionalText(filePath);
    return text ? JSON.parse(text) : null;
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

function markdownEscape(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ');
}

function csvEscape(value) {
    const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
    if (!/[",\r\n]/.test(text)) return text;
    return `"${text.replace(/"/g, '""')}"`;
}

function manifestRecordsByFile(manifest) {
    const out = new Map();
    for (const sourceSet of ['visibleTopPending', 'metricPassVisible']) {
        for (const record of manifest.groups?.[sourceSet] ?? []) {
            out.set(record.file, {
                sourceSet,
                file: record.file,
                profileLine: record.review?.profileLine ?? 'unknown',
                cropPath: record.cropPath,
                visibleReasons: record.metrics?.visibleReasons ?? [],
                suggestedVerdict: record.review?.verdict ?? null,
                suggestedConfidence: record.review?.confidence ?? null,
                notes: record.review?.notes ?? ''
            });
        }
    }
    return out;
}

function normalizeReasons(reasons) {
    return [...new Set(reasons ?? [])].sort((left, right) => left.localeCompare(right));
}

function clusterIdFor({ sourceSet, profileLine, visibleReasons }) {
    return `${sourceSet}::${profileLine}::${normalizeReasons(visibleReasons).join('+')}`;
}

function inferredDecisionInputPath(entry, validation) {
    if (typeof entry.decisionInputPath === 'string') return entry.decisionInputPath;
    if (entry.sourceSet === 'metricPassVisible') return validation.candidateDecisionsPath ?? null;
    if (entry.sourceSet === 'visibleTopPending') return validation.decisionsPath ?? null;
    return null;
}

function enrichDecision(entry, recordsByFile, validation) {
    const record = recordsByFile.get(entry.file) ?? {};
    const sourceSet = entry.sourceSet ?? record.sourceSet ?? 'unknown';
    const profileLine = record.profileLine ?? 'unknown';
    const visibleReasons = record.visibleReasons ?? [];
    return {
        sourceSet,
        file: entry.file,
        decisionInputPath: inferredDecisionInputPath({ ...entry, sourceSet }, validation),
        decisionArrayIndex: Number.isInteger(entry.decisionArrayIndex) ? entry.decisionArrayIndex : null,
        decisionIndex: Number.isInteger(entry.decisionIndex) ? entry.decisionIndex : null,
        decisionJsonPath: typeof entry.decisionJsonPath === 'string' ? entry.decisionJsonPath : null,
        profileLine,
        clusterId: entry.clusterId ?? clusterIdFor({ sourceSet, profileLine, visibleReasons }),
        cropPath: record.cropPath ?? '',
        visibleReasons,
        suggestedVerdict: record.suggestedVerdict ?? null,
        suggestedConfidence: record.suggestedConfidence ?? null,
        notes: record.notes ?? '',
        problems: entry.problems ?? []
    };
}

function tableFromCounts(counts) {
    const lines = ['| key | count |', '|---|---:|'];
    for (const [key, count] of Object.entries(counts)) {
        lines.push(`| ${markdownEscape(key)} | ${count} |`);
    }
    return lines.join('\n');
}

function summarizeIncompleteCluster(cluster) {
    const count = cluster.count ?? cluster.files?.length ?? 0;
    const readyCount = cluster.readyCount ?? 0;
    const first = cluster.files?.[0] ?? cluster.records?.[0] ?? null;
    return {
        clusterId: cluster.clusterId ?? 'unknown',
        sourceSet: cluster.sourceSet ?? 'unknown',
        profileLine: cluster.profileLine ?? 'unknown',
        visibleReasons: cluster.visibleReasons ?? [],
        count,
        incompleteCount: cluster.incompleteCount ?? Math.max(0, count - readyCount),
        sheetPath: cluster.sheet?.outputPath ?? cluster.sheetPath ?? null,
        firstFile: first?.file ?? null,
        firstCropPath: first?.cropPath ?? null
    };
}

function sortedIncompleteClusters(clusterReport) {
    return (clusterReport?.clusters ?? [])
        .map(summarizeIncompleteCluster)
        .filter((cluster) => cluster.incompleteCount > 0)
        .sort((left, right) => (
            right.incompleteCount - left.incompleteCount ||
            right.count - left.count ||
            left.clusterId.localeCompare(right.clusterId)
        ));
}

function sortByClusterPriority(items, clusterReport) {
    const priorities = new Map(sortedIncompleteClusters(clusterReport).map((cluster, index) => [cluster.clusterId, index]));
    return [...items].sort((left, right) => (
        (priorities.get(left.clusterId) ?? Number.MAX_SAFE_INTEGER) -
            (priorities.get(right.clusterId) ?? Number.MAX_SAFE_INTEGER) ||
        left.sourceSet.localeCompare(right.sourceSet) ||
        left.file.localeCompare(right.file)
    ));
}

function getReviewItems({ validation, manifest, clusterReport, limit }) {
    const recordsByFile = manifestRecordsByFile(manifest);
    const incomplete = (validation.incompleteDecisions ?? []).map((entry) => enrichDecision(entry, recordsByFile, validation));
    const sorted = sortByClusterPriority(incomplete, clusterReport);
    return limit > 0 ? sorted.slice(0, limit) : sorted;
}

function buildNextReviewBatch({ incomplete, clusterReport, limit }) {
    const topCluster = sortedIncompleteClusters(clusterReport)[0] ?? null;
    if (!topCluster) {
        return {
            cluster: null,
            itemCount: 0,
            remainingInCluster: 0,
            items: []
        };
    }
    const batchLimit = limit > 0 ? limit : 8;
    const clusterItems = incomplete.filter((item) => item.clusterId === topCluster.clusterId);
    const items = clusterItems.slice(0, batchLimit);
    return {
        cluster: topCluster,
        itemCount: items.length,
        remainingInCluster: Math.max(0, clusterItems.length - items.length),
        items
    };
}

function buildReviewBatches({ incomplete, clusterReport, limit }) {
    const batchLimit = limit > 0 ? limit : 8;
    return sortedIncompleteClusters(clusterReport).map((cluster, index) => {
        const clusterItems = incomplete.filter((item) => item.clusterId === cluster.clusterId);
        const items = clusterItems.slice(0, batchLimit);
        const firstItem = items[0] ?? null;
        return {
            batchIndex: index + 1,
            clusterId: cluster.clusterId,
            sourceSet: cluster.sourceSet,
            profileLine: cluster.profileLine,
            visibleReasons: cluster.visibleReasons,
            sheetPath: cluster.sheetPath,
            totalIncompleteInCluster: clusterItems.length,
            itemCount: items.length,
            remainingAfterBatch: Math.max(0, clusterItems.length - items.length),
            firstDecisionInputPath: firstItem?.decisionInputPath ?? null,
            firstDecisionJsonPath: firstItem?.decisionJsonPath ?? null,
            firstFile: firstItem?.file ?? null,
            firstCropPath: firstItem?.cropPath ?? null
        };
    });
}

function buildCsv({ validation, manifest, clusterReport, limit, provenance }) {
    const items = getReviewItems({ validation, manifest, clusterReport, limit });
    const headers = [
        'index',
        'sourceSet',
        'clusterId',
        'decisionInputPath',
        'decisionJsonPath',
        'decisionArrayIndex',
        'decisionIndex',
        'profileLine',
        'file',
        'cropPath',
        'suggestedVerdict',
        'suggestedConfidence',
        'visibleReasons',
        'missingProblems',
        'humanVerdict',
        'humanConfidence',
        'humanNotes',
        'validationReportSha256',
        'reviewManifestSha256',
        'reviewClusterSha256'
    ];
    const lines = [headers.join(',')];
    items.forEach((item, index) => {
        lines.push([
            index + 1,
            item.sourceSet,
            item.clusterId,
            item.decisionInputPath ?? '',
            item.decisionJsonPath ?? '',
            item.decisionArrayIndex ?? '',
            item.decisionIndex ?? '',
            item.profileLine,
            item.file,
            item.cropPath,
            item.suggestedVerdict ?? 'pending',
            item.suggestedConfidence ?? 'unknown',
            item.visibleReasons,
            item.problems,
            '',
            '',
            '',
            provenance.validationReportSha256,
            provenance.reviewManifestSha256,
            provenance.reviewClusterSha256 ?? ''
        ].map(csvEscape).join(','));
    });
    return `${lines.join('\n')}\n`;
}

function buildWorksheet({ validation, manifest, clusterReport, limit, provenance }) {
    const incomplete = getReviewItems({ validation, manifest, clusterReport, limit: 0 });
    const shownItems = limit > 0 ? incomplete.slice(0, limit) : incomplete;
    const nextReviewBatch = buildNextReviewBatch({ incomplete, clusterReport, limit });
    const reviewBatches = buildReviewBatches({ incomplete, clusterReport, limit });
    const goldCandidateReviewBatches = reviewBatches.filter((batch) => batch.sourceSet === 'metricPassVisible');
    const totalReviewDecisions = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    const totalIncompleteDecisions = reviewBatches.reduce((sum, batch) => sum + batch.totalIncompleteInCluster, 0);
    const goldCandidateIncompleteDecisions = goldCandidateReviewBatches
        .reduce((sum, batch) => sum + batch.totalIncompleteInCluster, 0);
    const completionRatio = totalReviewDecisions > 0
        ? Number(((validation.readyDecisionCount ?? 0) / totalReviewDecisions).toFixed(4))
        : 0;

    const lines = [];
    lines.push('# Visible Residual Review Worksheet');
    lines.push('');
    lines.push('This worksheet is generated from the visible residual review loop. Edit `review-decisions.json` and `gold-candidate-confirmations.json`, not this file.');
    lines.push('');
    lines.push('## Commands');
    lines.push('');
    lines.push('```powershell');
    lines.push('rtk pnpm visible-residual:review-status');
    lines.push('rtk pnpm visible-residual:validate-human-review');
    lines.push('rtk pnpm visible-residual:create-gold-manifest');
    lines.push('```');
    lines.push('');
    lines.push('## Progress');
    lines.push('');
    lines.push(`- readyForGoldMigration: \`${validation.readyForGoldMigration === true}\``);
    lines.push(`- totalReviewDecisions: \`${totalReviewDecisions}\``);
    lines.push(`- readyDecisionCount: \`${validation.readyDecisionCount ?? 0}\``);
    lines.push(`- unconfirmedCount: \`${validation.unconfirmedCount ?? 0}\``);
    lines.push(`- structuralErrorCount: \`${validation.structuralErrorCount ?? 0}\``);
    lines.push(`- completionRatio: \`${completionRatio}\``);
    lines.push('');
    lines.push('## Provenance');
    lines.push('');
    lines.push(`- validationReportSha256: \`${provenance.validationReportSha256}\``);
    lines.push(`- reviewManifestSha256: \`${provenance.reviewManifestSha256}\``);
    lines.push(`- reviewClusterSha256: \`${provenance.reviewClusterSha256 ?? ''}\``);
    lines.push('');
    lines.push('## Incomplete By Source');
    lines.push('');
    lines.push(tableFromCounts(countBy(incomplete, (item) => item.sourceSet)));
    lines.push('');
    lines.push('## Incomplete By Profile');
    lines.push('');
    lines.push(tableFromCounts(countBy(incomplete, (item) => item.profileLine)));
    lines.push('');
    lines.push('## Next Review Batch');
    lines.push('');
    if (nextReviewBatch.cluster) {
        lines.push(`- clusterId: \`${markdownEscape(nextReviewBatch.cluster.clusterId)}\``);
        lines.push(`- sourceSet: \`${markdownEscape(nextReviewBatch.cluster.sourceSet)}\``);
        lines.push(`- profileLine: \`${markdownEscape(nextReviewBatch.cluster.profileLine)}\``);
        lines.push(`- visibleReasons: \`${markdownEscape(nextReviewBatch.cluster.visibleReasons.join(', '))}\``);
        lines.push(`- sheetPath: \`${markdownEscape(nextReviewBatch.cluster.sheetPath ?? '')}\``);
        lines.push(`- itemCount: \`${nextReviewBatch.itemCount}\``);
        lines.push(`- remainingInClusterAfterBatch: \`${nextReviewBatch.remainingInCluster}\``);
        lines.push('');
        lines.push('| # | decision | file | cropPath | missing |');
        lines.push('|---:|---|---|---|---|');
        nextReviewBatch.items.forEach((item, index) => {
            lines.push([
                index + 1,
                markdownEscape(`${item.decisionInputPath ?? ''} ${item.decisionJsonPath ?? ''}`.trim()),
                markdownEscape(item.file),
                markdownEscape(item.cropPath),
                markdownEscape(item.problems.join(', '))
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        });
    } else {
        lines.push('All review items are complete.');
    }
    lines.push('');
    lines.push('## Review Batches');
    lines.push('');
    lines.push(`- reviewBatchCount: \`${reviewBatches.length}\``);
    lines.push(`- totalIncompleteDecisions: \`${totalIncompleteDecisions}\``);
    lines.push('');
    lines.push('| batch | clusterId | sheetPath | incomplete | first decision | first file |');
    lines.push('|---:|---|---|---:|---|---|');
    reviewBatches.forEach((batch) => {
        lines.push([
            batch.batchIndex,
            markdownEscape(batch.clusterId),
            markdownEscape(batch.sheetPath ?? ''),
            batch.totalIncompleteInCluster,
            markdownEscape(`${batch.firstDecisionInputPath ?? ''} ${batch.firstDecisionJsonPath ?? ''}`.trim()),
            markdownEscape(batch.firstFile ?? '')
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
    if (reviewBatches.length === 0) {
        lines.push('|  | all review batches are complete |  |  |  |  |');
    }
    lines.push('');
    lines.push('## Gold Candidate Review Batches');
    lines.push('');
    lines.push(`- goldCandidateReviewBatchCount: \`${goldCandidateReviewBatches.length}\``);
    lines.push(`- goldCandidateIncompleteDecisions: \`${goldCandidateIncompleteDecisions}\``);
    lines.push('');
    lines.push('| batch | clusterId | sheetPath | incomplete | first decision | first file |');
    lines.push('|---:|---|---|---:|---|---|');
    goldCandidateReviewBatches.forEach((batch) => {
        lines.push([
            batch.batchIndex,
            markdownEscape(batch.clusterId),
            markdownEscape(batch.sheetPath ?? ''),
            batch.totalIncompleteInCluster,
            markdownEscape(`${batch.firstDecisionInputPath ?? ''} ${batch.firstDecisionJsonPath ?? ''}`.trim()),
            markdownEscape(batch.firstFile ?? '')
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
    if (goldCandidateReviewBatches.length === 0) {
        lines.push('|  | all gold candidate confirmations are complete |  |  |  |  |');
    }
    lines.push('');
    lines.push('## Verdict Guide');
    lines.push('');
    lines.push('- `trueVisibleResidual`: visible residual is an algorithm failure.');
    lines.push('- `backgroundStructure`: metric hit is mainly background structure.');
    lines.push('- `contentCollision`: residual overlaps content edges/text; use gold tolerance discussion.');
    lines.push('- `acceptableResidual`: visible but acceptable.');
    lines.push('- `needsModelInvestigation`: clear model/profile issue; not simple threshold tuning.');
    lines.push('');
    lines.push('## Review Items');
    lines.push('');
    lines.push('For spreadsheet sorting/filtering, see `review-table.csv`. It is generated output too; keep editing the JSON decision files.');
    lines.push('');
    lines.push('| # | sourceSet | clusterId | decision | profileLine | file | cropPath | suggested | visibleReasons | missing |');
    lines.push('|---:|---|---|---|---|---|---|---|---|---|');
    shownItems.forEach((item, index) => {
        lines.push([
            index + 1,
            markdownEscape(item.sourceSet),
            markdownEscape(item.clusterId),
            markdownEscape(`${item.decisionInputPath ?? ''} ${item.decisionJsonPath ?? ''}`.trim()),
            markdownEscape(item.profileLine),
            markdownEscape(item.file),
            markdownEscape(item.cropPath),
            markdownEscape(`${item.suggestedVerdict ?? 'pending'} / ${item.suggestedConfidence ?? 'unknown'}`),
            markdownEscape(item.visibleReasons.join(', ')),
            markdownEscape(item.problems.join(', '))
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
    if (shownItems.length === 0) {
        lines.push('|  |  |  | all review items are complete |  |  |  |  |  |  |');
    }
    lines.push('');
    lines.push('## Policy');
    lines.push('');
    lines.push('- This worksheet does not write `gold-manifest.json`.');
    lines.push('- This worksheet does not change production algorithm code.');
    lines.push('- Alpha/profile variants still require human-confirmed gold evidence before production use.');
    lines.push('');

    return `${lines.join('\n')}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.resolve(path.dirname(args.outputPath), '..', 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath,
            skippedWrite: true,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:review-worksheet.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const validationText = stripBom(await readFile(args.validationPath, 'utf8'));
    const manifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const clusterReportText = await readOptionalText(args.reviewClusterPath);
    const validation = JSON.parse(validationText);
    const manifest = JSON.parse(manifestText);
    const clusterReport = clusterReportText ? JSON.parse(clusterReportText) : null;
    const validationReportSha256 = sha256Text(validationText);
    const reviewManifestSha256 = sha256Text(manifestText);
    const clusterReportProblems = assessClusterReportIntegrity({
        clusterReport,
        reviewManifestSha256,
        validationReportSha256
    });
    if (clusterReportProblems.length > 0) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            outputPath: args.outputPath,
            csvOutputPath: args.csvOutputPath,
            problems: clusterReportProblems,
            expectedReviewManifestSha256: reviewManifestSha256,
            actualReviewManifestSha256: clusterReport?.inputs?.reviewManifestSha256 ?? null,
            expectedValidationReportSha256: validationReportSha256,
            actualValidationReportSha256: clusterReport?.inputs?.validationReportSha256 ?? null
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const provenance = {
        validationReportSha256,
        reviewManifestSha256,
        reviewClusterSha256: clusterReportText ? sha256Text(clusterReportText) : null
    };
    const worksheet = buildWorksheet({
        validation,
        manifest,
        clusterReport,
        limit: args.limit,
        provenance
    });
    const csv = buildCsv({
        validation,
        manifest,
        clusterReport,
        limit: args.limit,
        provenance
    });

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, worksheet, 'utf8');
    await mkdir(path.dirname(args.csvOutputPath), { recursive: true });
    await writeFile(args.csvOutputPath, csv, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        csvOutputPath: args.csvOutputPath,
        readyForGoldMigration: validation.readyForGoldMigration === true,
        unconfirmedCount: validation.unconfirmedCount ?? 0,
        itemCount: validation.incompleteDecisions?.length ?? 0
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
