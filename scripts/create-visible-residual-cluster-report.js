import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import sharp from 'sharp';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-clusters.json');
const DEFAULT_WORKSHEET_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/cluster-review-worksheet.md');
const DEFAULT_CLUSTER_SHEET_DIR = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/by-cluster');
const BACKGROUND = '#171717';
const ROW_GAP = 14;

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        validationPath: DEFAULT_VALIDATION_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        worksheetOutputPath: DEFAULT_WORKSHEET_OUTPUT_PATH,
        clusterSheetDir: DEFAULT_CLUSTER_SHEET_DIR,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--validation') {
            parsed.validationPath = path.resolve(args.shift() || parsed.validationPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--worksheet-output') {
            parsed.worksheetOutputPath = path.resolve(args.shift() || parsed.worksheetOutputPath);
            continue;
        }
        if (arg === '--cluster-sheet-dir') {
            parsed.clusterSheetDir = path.resolve(args.shift() || parsed.clusterSheetDir);
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

function assessValidationReportManifestIntegrity({ validation, reviewManifestSha256 }) {
    const problems = [];
    if (typeof validation?.reviewManifestSha256 !== 'string') {
        problems.push('validation-report-missing-review-manifest-hash');
    } else if (validation.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('validation-report-review-manifest-hash-mismatch');
    }
    return problems;
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

function sanitizeFileName(value) {
    return String(value)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 140);
}

function normalizeReasons(reasons) {
    const out = [...new Set((reasons ?? []).filter(Boolean))].sort();
    return out.length > 0 ? out : ['no-visible-reason'];
}

function clusterIdFor(record) {
    const sourceSet = record.sourceSet;
    const profileLine = record.profileLine;
    const reasonKey = record.visibleReasons.join('+');
    return `${sourceSet}::${profileLine}::${reasonKey}`;
}

function collectReviewRecords(manifest) {
    const out = [];
    for (const sourceSet of ['visibleTopPending', 'metricPassVisible']) {
        for (const record of manifest.groups?.[sourceSet] ?? []) {
            const visibleReasons = normalizeReasons(record.metrics?.visibleReasons);
            const profileLine = record.review?.profileLine ?? 'unknown';
            out.push({
                sourceSet,
                file: record.file,
                profileLine,
                visibleReasons,
                cropPath: record.cropPath,
                suggestedVerdict: record.review?.verdict ?? 'pending',
                suggestedConfidence: record.review?.confidence ?? 'unknown',
                suggestedNextStep: record.review?.suggestedNextStep ?? 'human-review',
                metrics: record.metrics ?? {}
            });
        }
    }
    return out;
}

function validationStatusByFile(validation) {
    const out = new Map();
    for (const entry of validation.incompleteDecisions ?? []) {
        out.set(entry.file, {
            status: 'incomplete',
            problems: entry.problems ?? []
        });
    }
    for (const entry of validation.readyDecisions ?? []) {
        out.set(entry.file, {
            status: 'ready',
            humanVerdict: entry.humanVerdict,
            humanConfidence: entry.humanConfidence
        });
    }
    for (const entry of validation.structuralErrors ?? []) {
        if (!entry.file) continue;
        out.set(entry.file, {
            status: 'structural-error',
            problems: [entry.type ?? 'structural-error']
        });
    }
    return out;
}

function buildClusters({ manifest, validation }) {
    const statusByFile = validationStatusByFile(validation);
    const records = collectReviewRecords(manifest).map((record) => {
        const validationStatus = statusByFile.get(record.file) ?? {
            status: 'missing-validation-entry',
            problems: ['missing-validation-entry']
        };
        return {
            ...record,
            clusterId: clusterIdFor(record),
            validationStatus
        };
    });

    const clusterMap = new Map();
    for (const record of records) {
        if (!clusterMap.has(record.clusterId)) {
            clusterMap.set(record.clusterId, {
                clusterId: record.clusterId,
                sourceSet: record.sourceSet,
                profileLine: record.profileLine,
                visibleReasons: record.visibleReasons,
                count: 0,
                readyCount: 0,
                incompleteCount: 0,
                structuralErrorCount: 0,
                suggestedVerdictCounts: {},
                files: []
            });
        }
        const cluster = clusterMap.get(record.clusterId);
        cluster.count += 1;
        if (record.validationStatus.status === 'ready') cluster.readyCount += 1;
        if (record.validationStatus.status === 'incomplete') cluster.incompleteCount += 1;
        if (record.validationStatus.status === 'structural-error') cluster.structuralErrorCount += 1;
        cluster.suggestedVerdictCounts[record.suggestedVerdict] =
            (cluster.suggestedVerdictCounts[record.suggestedVerdict] ?? 0) + 1;
        cluster.files.push({
            file: record.file,
            cropPath: record.cropPath,
            suggestedVerdict: record.suggestedVerdict,
            suggestedConfidence: record.suggestedConfidence,
            suggestedNextStep: record.suggestedNextStep,
            validationStatus: record.validationStatus,
            metrics: record.metrics
        });
    }

    return [...clusterMap.values()].sort((left, right) => (
        right.count - left.count ||
        left.sourceSet.localeCompare(right.sourceSet) ||
        left.profileLine.localeCompare(right.profileLine) ||
        left.visibleReasons.join('+').localeCompare(right.visibleReasons.join('+'))
    ));
}

function buildReport({ manifest, validation, paths, reviewManifestSha256, validationReportSha256 }) {
    const records = collectReviewRecords(manifest);
    const clusters = buildClusters({ manifest, validation });
    return {
        generatedAt: new Date().toISOString(),
        inputs: {
            reviewManifestPath: paths.reviewManifestPath,
            reviewManifestSha256,
            validationPath: paths.validationPath,
            validationReportSha256
        },
        policy: {
            readOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            groupingKey: 'sourceSet + profileLine + sorted visibleReasons',
            writesClusterSheets: true
        },
        summary: {
            totalRecords: records.length,
            clusterTotal: clusters.length,
            sourceSetCounts: countBy(records, (record) => record.sourceSet),
            profileCounts: countBy(records, (record) => record.profileLine),
            reasonCounts: countBy(records.flatMap((record) => record.visibleReasons), (reason) => reason),
            readyForGoldMigration: validation.readyForGoldMigration === true,
            unconfirmedCount: validation.unconfirmedCount ?? 0,
            structuralErrorCount: validation.structuralErrorCount ?? 0
        },
        clusters
    };
}

async function renderSheet({ files, outputPath }) {
    const rows = [];
    for (const file of files ?? []) {
        if (!file.cropPath || !existsSync(file.cropPath)) continue;
        const metadata = await sharp(file.cropPath).metadata();
        rows.push({
            input: file.cropPath,
            width: metadata.width,
            height: metadata.height
        });
    }
    if (rows.length === 0) return null;

    const width = Math.max(...rows.map((row) => row.width));
    const height = rows.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.input, left: 0, top });
        top += row.height + ROW_GAP;
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return {
        outputPath,
        count: rows.length,
        width,
        height
    };
}

async function attachClusterSheets(report, clusterSheetDir) {
    await mkdir(clusterSheetDir, { recursive: true });
    for (const [index, cluster] of report.clusters.entries()) {
        const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(cluster.clusterId)}.png`;
        cluster.sheet = await renderSheet({
            files: cluster.files,
            outputPath: path.join(clusterSheetDir, fileName)
        });
    }
    report.summary.clusterSheetCount = report.clusters.filter((cluster) => cluster.sheet).length;
    report.summary.clusterSheetDir = clusterSheetDir;
    return report;
}

function buildWorksheet(report, reviewClusterSha256) {
    const lines = [];
    lines.push('# Visible Residual Cluster Review Worksheet');
    lines.push('');
    lines.push('This worksheet is generated from `review-clusters.json`. Edit `review-decisions.json` and `gold-candidate-confirmations.json`, not this file.');
    lines.push('');
    lines.push('## Progress');
    lines.push('');
    lines.push(`- totalRecords: \`${report.summary.totalRecords}\``);
    lines.push(`- clusterTotal: \`${report.summary.clusterTotal}\``);
    lines.push(`- unconfirmedCount: \`${report.summary.unconfirmedCount}\``);
    lines.push(`- readyForGoldMigration: \`${report.summary.readyForGoldMigration === true}\``);
    lines.push('');
    lines.push('## Provenance');
    lines.push('');
    lines.push(`- reviewManifestSha256: \`${report.inputs.reviewManifestSha256}\``);
    lines.push(`- validationReportSha256: \`${report.inputs.validationReportSha256}\``);
    lines.push(`- reviewClusterSha256: \`${reviewClusterSha256}\``);
    lines.push('');
    lines.push('## Cluster Summary');
    lines.push('');
    lines.push('| # | clusterId | count | ready | incomplete | structural | sheet | firstFile | firstCrop |');
    lines.push('|---:|---|---:|---:|---:|---:|---|---|---|');
    report.clusters.forEach((cluster, index) => {
        const first = cluster.files[0] ?? {};
        lines.push([
            index + 1,
            markdownEscape(cluster.clusterId),
            cluster.count,
            cluster.readyCount,
            cluster.incompleteCount,
            cluster.structuralErrorCount,
            markdownEscape(cluster.sheet?.outputPath ?? ''),
            markdownEscape(first.file ?? ''),
            markdownEscape(first.cropPath ?? '')
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
    lines.push('');
    lines.push('## Review Guidance');
    lines.push('');
    lines.push('- Review one cluster at a time before changing any alpha/profile candidate.');
    lines.push('- Use `by-cluster/*.png` sheets for grouped visual inspection.');
    lines.push('- For `metricPassVisible` clusters, confirm or reject the suggested gold candidate fields in `gold-candidate-confirmations.json`.');
    lines.push('- For `visibleTopPending` clusters, fill `review-decisions.json` with a human verdict, confidence, and notes when needed.');
    lines.push('- This worksheet does not write `gold-manifest.json`.');
    lines.push('- This worksheet does not change production algorithm code.');
    lines.push('');
    return `${lines.join('\n')}`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.join(path.dirname(args.outputPath), 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath,
            skippedWrite: true,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:cluster-report.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const reviewManifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const validationText = stripBom(await readFile(args.validationPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const validationReportSha256 = sha256Text(validationText);
    const manifest = JSON.parse(reviewManifestText);
    const validation = JSON.parse(validationText);
    const validationReportProblems = assessValidationReportManifestIntegrity({
        validation,
        reviewManifestSha256
    });
    if (validationReportProblems.length > 0) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            outputPath: args.outputPath,
            worksheetOutputPath: args.worksheetOutputPath,
            clusterSheetDir: args.clusterSheetDir,
            problems: validationReportProblems,
            expectedReviewManifestSha256: reviewManifestSha256,
            actualReviewManifestSha256: validation.reviewManifestSha256 ?? null,
            validationReportSha256
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const report = buildReport({
        manifest,
        validation,
        paths: args,
        reviewManifestSha256,
        validationReportSha256
    });
    await attachClusterSheets(report, args.clusterSheetDir);

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    const reviewClusterSha256 = sha256Text(reportText);
    await writeFile(args.outputPath, reportText, 'utf8');
    await mkdir(path.dirname(args.worksheetOutputPath), { recursive: true });
    await writeFile(args.worksheetOutputPath, buildWorksheet(report, reviewClusterSha256), 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        worksheetOutputPath: args.worksheetOutputPath,
        clusterSheetDir: args.clusterSheetDir,
        summary: report.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
