import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_REVIEW_CLUSTER_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-clusters.json');
const DEFAULT_REVIEW_CHECKPOINT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json');
const DEFAULT_FOCUSED_BATCH_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-focused-batch.json');
const DEFAULT_HANDOFF_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-handoff.md');
const HUMAN_EDITABLE_FIELDS = Object.freeze(['humanVerdict', 'humanConfidence', 'humanNotes']);
const VALID_HUMAN_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'backgroundStructure',
    'contentCollision',
    'acceptableResidual',
    'needsModelInvestigation'
]);
const VALID_HUMAN_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
const NOTES_REQUIRED_FOR_VERDICTS = Object.freeze(['trueVisibleResidual', 'needsModelInvestigation']);

function parseArgs(argv) {
    const parsed = {
        validationPath: DEFAULT_VALIDATION_PATH,
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        reviewClusterPath: DEFAULT_REVIEW_CLUSTER_PATH,
        outputPath: null,
        checkpointOutputPath: null,
        focusedBatchOutputPath: null,
        handoffOutputPath: null,
        limit: 12,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--') {
            continue;
        }
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
        if (arg === '--checkpoint-output') {
            parsed.checkpointOutputPath = path.resolve(args.shift() || DEFAULT_REVIEW_CHECKPOINT_PATH);
            continue;
        }
        if (arg === '--focused-batch-output') {
            parsed.focusedBatchOutputPath = path.resolve(args.shift() || DEFAULT_FOCUSED_BATCH_PATH);
            continue;
        }
        if (arg === '--handoff-output') {
            parsed.handoffOutputPath = path.resolve(args.shift() || DEFAULT_HANDOFF_PATH);
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
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
                suggestedConfidence: record.review?.confidence ?? null
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
        cropPath: record.cropPath ?? null,
        visibleReasons,
        suggestedVerdict: record.suggestedVerdict ?? null,
        suggestedConfidence: record.suggestedConfidence ?? null,
        problems: entry.problems ?? []
    };
}

function firstClusterFile(cluster) {
    const first = cluster.files?.[0] ?? cluster.records?.[0] ?? null;
    return first?.file ?? null;
}

function firstClusterCropPath(cluster) {
    const first = cluster.files?.[0] ?? cluster.records?.[0] ?? null;
    return first?.cropPath ?? null;
}

function clusterSheetPath(cluster) {
    return cluster.sheet?.outputPath ?? cluster.sheetPath ?? null;
}

function summarizeIncompleteCluster(cluster) {
    const count = cluster.count ?? cluster.files?.length ?? 0;
    const readyCount = cluster.readyCount ?? 0;
    const incompleteCount = cluster.incompleteCount ?? Math.max(0, count - readyCount);
    return {
        clusterId: cluster.clusterId ?? 'unknown',
        sourceSet: cluster.sourceSet ?? 'unknown',
        profileLine: cluster.profileLine ?? 'unknown',
        visibleReasons: cluster.visibleReasons ?? [],
        count,
        incompleteCount,
        readyCount,
        sheetPath: clusterSheetPath(cluster),
        firstFile: firstClusterFile(cluster),
        firstCropPath: firstClusterCropPath(cluster)
    };
}

function incompleteClusters(clusterReport) {
    return (clusterReport?.clusters ?? [])
        .map(summarizeIncompleteCluster)
        .filter((cluster) => cluster.incompleteCount > 0)
        .sort((left, right) => (
            right.incompleteCount - left.incompleteCount ||
            right.count - left.count ||
            left.clusterId.localeCompare(right.clusterId)
        ));
}

function incompleteCountByCluster(clusters) {
    return Object.fromEntries(
        clusters.map((cluster) => [cluster.clusterId, cluster.incompleteCount])
    );
}

function clusterPriorityMap(clusters) {
    return new Map(clusters.map((cluster, index) => [cluster.clusterId, index]));
}

function sortIncompleteByClusterPriority(incomplete, clusters) {
    const priorities = clusterPriorityMap(clusters);
    return [...incomplete].sort((left, right) => (
        (priorities.get(left.clusterId) ?? Number.MAX_SAFE_INTEGER) -
            (priorities.get(right.clusterId) ?? Number.MAX_SAFE_INTEGER) ||
        left.sourceSet.localeCompare(right.sourceSet) ||
        left.file.localeCompare(right.file)
    ));
}

function buildNextReviewBatch({ sortedIncomplete, topCluster, limit }) {
    if (!topCluster) {
        return {
            cluster: null,
            itemCount: 0,
            remainingInCluster: 0,
            items: []
        };
    }
    const clusterItems = sortedIncomplete.filter((item) => item.clusterId === topCluster.clusterId);
    const items = clusterItems.slice(0, limit);
    return {
        cluster: topCluster,
        itemCount: items.length,
        remainingInCluster: Math.max(0, clusterItems.length - items.length),
        items
    };
}

function buildReviewBatches({ sortedIncomplete, clusters, limit }) {
    return clusters.map((cluster, index) => {
        const clusterItems = sortedIncomplete.filter((item) => item.clusterId === cluster.clusterId);
        const items = clusterItems.slice(0, limit);
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
            firstCropPath: firstItem?.cropPath ?? null,
            items
        };
    });
}

function buildDecisionTargets(items = []) {
    return items.map((item) => ({
        sourceSet: item.sourceSet,
        clusterId: item.clusterId,
        file: item.file,
        decisionInputPath: item.decisionInputPath,
        decisionJsonPath: item.decisionJsonPath,
        decisionArrayIndex: item.decisionArrayIndex,
        cropPath: item.cropPath,
        profileLine: item.profileLine,
        visibleReasons: item.visibleReasons,
        suggestedVerdict: item.suggestedVerdict,
        suggestedConfidence: item.suggestedConfidence,
        problems: item.problems
    }));
}

function buildBatchCheckpoint(batch) {
    if (!batch) return null;
    const items = batch.items ?? [];
    const firstItem = items[0] ?? null;
    return {
        clusterId: batch.clusterId ?? batch.cluster?.clusterId ?? null,
        sourceSet: batch.sourceSet ?? batch.cluster?.sourceSet ?? null,
        profileLine: batch.profileLine ?? batch.cluster?.profileLine ?? null,
        visibleReasons: batch.visibleReasons ?? batch.cluster?.visibleReasons ?? [],
        sheetPath: batch.sheetPath ?? batch.cluster?.sheetPath ?? null,
        itemCount: batch.itemCount ?? items.length,
        totalIncompleteInCluster: batch.totalIncompleteInCluster ?? batch.cluster?.incompleteCount ?? items.length,
        remainingAfterBatch: batch.remainingAfterBatch ?? batch.remainingInCluster ?? 0,
        firstDecisionInputPath: batch.firstDecisionInputPath ?? firstItem?.decisionInputPath ?? null,
        firstDecisionJsonPath: batch.firstDecisionJsonPath ?? firstItem?.decisionJsonPath ?? null,
        firstFile: batch.firstFile ?? firstItem?.file ?? null,
        firstCropPath: batch.firstCropPath ?? firstItem?.cropPath ?? null,
        decisionTargets: buildDecisionTargets(items)
    };
}

function buildReviewCheckpoint(report) {
    const visibleResidualBatch = buildBatchCheckpoint(report.nextReviewBatch);
    const goldCandidateBatch = buildBatchCheckpoint(report.nextGoldCandidateReviewBatch);
    const requiredDecisionTargets = [
        ...buildDecisionTargets(report.nextReviewBatch?.items ?? []),
        ...buildDecisionTargets(report.nextGoldCandidateReviewBatch?.items ?? [])
    ];

    return {
        generatedAt: report.generatedAt,
        status: report.summary.readyForGoldMigration ? 'ready-for-gold-migration' : 'human-review-required',
        policy: {
            requiresHumanJudgement: report.summary.readyForGoldMigration !== true,
            writesReviewProgressReport: false,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        provenance: {
            validationPath: report.inputs.validationPath,
            validationReportSha256: report.inputs.validationReportSha256,
            reviewManifestPath: report.inputs.reviewManifestPath,
            reviewManifestSha256: report.inputs.reviewManifestSha256,
            reviewClusterPath: report.inputs.reviewClusterPath,
            reviewClusterSha256: report.inputs.reviewClusterSha256
        },
        summary: {
            readyForGoldMigration: report.summary.readyForGoldMigration,
            totalReviewDecisions: report.summary.totalReviewDecisions,
            readyDecisionCount: report.summary.readyDecisionCount,
            unconfirmedCount: report.summary.unconfirmedCount,
            structuralErrorCount: report.summary.structuralErrorCount,
            completionRatio: report.summary.completionRatio,
            pendingUnconfirmedCount: report.summary.pendingUnconfirmedCount,
            goldCandidateUnconfirmedCount: report.summary.goldCandidateUnconfirmedCount
        },
        nextReviewRound: {
            visibleResidualBatch,
            goldCandidateBatch,
            requiredDecisionTargets,
            editInputs: [
                report.inputs.decisionsPath,
                report.inputs.candidateDecisionsPath
            ].filter(Boolean),
            afterEditCommands: [
                'pnpm visible-residual:validate-human-review',
                'pnpm visible-residual:review-status --output .artifacts/visible-residual-crops/latest/human-review-pack/review-progress-report.json --checkpoint-output .artifacts/visible-residual-crops/latest/human-review-pack/review-checkpoint.json'
            ]
        },
        completionRequiredState: {
            readyForGoldMigration: true,
            unconfirmedCount: 0,
            structuralErrorCount: 0
        },
        blockedActions: [
            {
                id: 'write-formal-gold-manifest',
                blocked: report.summary.readyForGoldMigration !== true,
                reason: report.summary.readyForGoldMigration === true ? null : 'human-review-not-complete',
                requiredState: 'readyForGoldMigration=true, unconfirmedCount=0, structuralErrorCount=0'
            },
            {
                id: 'productionize-alpha-profile-variant',
                blocked: true,
                reason: 'production-profile-admission-not-allowed-before-formal-gold-migration',
                requiredState: 'verified formal gold manifest plus accepted production decision gates'
            }
        ]
    };
}

function buildFocusedReviewBatch(report) {
    const checkpoint = buildReviewCheckpoint(report);
    return {
        schemaVersion: 1,
        generatedAt: report.generatedAt,
        policy: {
            humanEditableFields: HUMAN_EDITABLE_FIELDS,
            validHumanVerdicts: VALID_HUMAN_VERDICTS,
            validHumanConfidence: VALID_HUMAN_CONFIDENCE,
            notesRequiredForVerdicts: NOTES_REQUIRED_FOR_VERDICTS,
            requiresHumanJudgement: true,
            dryRunCommand: 'pnpm visible-residual:apply-focused-batch --dry-run',
            applyCommand: 'pnpm visible-residual:apply-focused-batch',
            validateCommandAfterApply: 'pnpm visible-residual:validate-human-review',
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        provenance: checkpoint.provenance,
        sourceBatches: {
            visibleResidualBatch: checkpoint.nextReviewRound.visibleResidualBatch,
            goldCandidateBatch: checkpoint.nextReviewRound.goldCandidateBatch
        },
        decisions: checkpoint.nextReviewRound.requiredDecisionTargets.map((target) => ({
            sourceSet: target.sourceSet,
            file: target.file,
            clusterId: target.clusterId,
            decisionInputPath: target.decisionInputPath,
            decisionJsonPath: target.decisionJsonPath,
            decisionArrayIndex: target.decisionArrayIndex,
            cropPath: target.cropPath,
            profileLine: target.profileLine,
            visibleReasons: target.visibleReasons,
            suggestedVerdict: target.suggestedVerdict,
            suggestedConfidence: target.suggestedConfidence,
            problems: target.problems,
            humanVerdict: null,
            humanConfidence: null,
            humanNotes: ''
        })),
        blockedActions: checkpoint.blockedActions
    };
}

function escapeTableCell(value) {
    return String(value ?? '')
        .replace(/\r?\n/g, ' ')
        .replace(/\|/g, '\\|');
}

function formatDecisionTable(decisions = []) {
    if (decisions.length === 0) return '_No decisions in this batch._';
    const lines = [
        '| sourceSet | clusterId | file | decisionJsonPath | cropPath | suggested | current problems |',
        '|---|---|---|---|---|---|---|'
    ];
    for (const decision of decisions) {
        lines.push([
            decision.sourceSet,
            decision.clusterId,
            decision.file,
            decision.decisionJsonPath,
            decision.cropPath,
            [decision.suggestedVerdict, decision.suggestedConfidence].filter(Boolean).join(' / '),
            (decision.problems ?? []).join(', ')
        ].map(escapeTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    return lines.join('\n');
}

function markdownImagePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return '';
    return filePath.replace(/\\/g, '/');
}

function formatSheetPreview(label, sheetPath) {
    if (typeof sheetPath !== 'string' || sheetPath.length === 0) {
        return '_No cluster sheet available._';
    }
    return `![${label}](${markdownImagePath(sheetPath)})`;
}

function formatDecisionCropPreviews(label, decisions = []) {
    if (decisions.length === 0) return [`### ${label} Decision Crop Previews`, '', '_No decision crops in this batch._'].join('\n');
    const lines = [
        `### ${label} Decision Crop Previews`,
        ''
    ];
    for (const decision of decisions) {
        lines.push(
            `- ${decision.decisionJsonPath}: ${decision.file}`,
            `![${label} ${decision.decisionJsonPath} crop](${markdownImagePath(decision.cropPath)})`,
            ''
        );
    }
    return lines.join('\n').trimEnd();
}

function buildReviewHandoffMarkdown(report) {
    const focusedBatch = report.focusedReviewBatch ?? {};
    const visibleDecisions = (focusedBatch.decisions ?? []).filter((decision) => decision.sourceSet === 'visibleTopPending');
    const goldCandidateDecisions = (focusedBatch.decisions ?? []).filter((decision) => decision.sourceSet === 'metricPassVisible');
    const checkpoint = report.reviewCheckpoint ?? {};
    const visibleBatch = checkpoint.nextReviewRound?.visibleResidualBatch ?? {};
    const goldCandidateBatch = checkpoint.nextReviewRound?.goldCandidateBatch ?? {};
    const lines = [
        '# Visible Residual Review Handoff',
        '',
        `Generated at: ${report.generatedAt}`,
        '',
        '## Current Gate',
        '',
        `- readyForGoldMigration: ${report.summary.readyForGoldMigration}`,
        `- unconfirmedCount: ${report.summary.unconfirmedCount}`,
        `- structuralErrorCount: ${report.summary.structuralErrorCount}`,
        `- focusedBatchDecisionCount: ${(focusedBatch.decisions ?? []).length}`,
        `- visibleResidualBatchCount: ${visibleDecisions.length}`,
        `- goldCandidateBatchCount: ${goldCandidateDecisions.length}`,
        '',
        '## Provenance',
        '',
        `- validationReportSha256: ${report.inputs.validationReportSha256}`,
        `- reviewManifestSha256: ${report.inputs.reviewManifestSha256}`,
        `- reviewClusterSha256: ${report.inputs.reviewClusterSha256}`,
        `- reviewProgressReportPath: ${report.outputs.reviewProgressReportPath ?? ''}`,
        `- reviewCheckpointPath: ${report.outputs.reviewCheckpointPath ?? ''}`,
        `- focusedReviewBatchPath: ${report.outputs.focusedReviewBatchPath ?? ''}`,
        `- reviewHandoffPath: ${report.outputs.reviewHandoffPath ?? ''}`,
        '',
        '## Policy',
        '',
        `- requiresHumanJudgement: ${focusedBatch.policy?.requiresHumanJudgement === true}`,
        `- writesFormalGoldManifest: ${focusedBatch.policy?.writesFormalGoldManifest === true}`,
        `- writesProductionAlgorithm: ${focusedBatch.policy?.writesProductionAlgorithm === true}`,
        `- allowsAlphaProfileProduction: ${focusedBatch.policy?.allowsAlphaProfileProduction === true}`,
        `- humanEditableFields: ${(focusedBatch.policy?.humanEditableFields ?? []).join(', ')}`,
        `- validHumanVerdicts: ${(focusedBatch.policy?.validHumanVerdicts ?? []).join(', ')}`,
        `- validHumanConfidence: ${(focusedBatch.policy?.validHumanConfidence ?? []).join(', ')}`,
        `- notesRequiredForVerdicts: ${(focusedBatch.policy?.notesRequiredForVerdicts ?? []).join(', ')}`,
        `- dryRunCommand: ${focusedBatch.policy?.dryRunCommand ?? ''}`,
        `- applyCommand: ${focusedBatch.policy?.applyCommand ?? ''}`,
        `- validateCommandAfterApply: ${focusedBatch.policy?.validateCommandAfterApply ?? ''}`,
        '',
        '## Focused Batch Editing Checklist',
        '',
        `- Edit only: ${(focusedBatch.policy?.humanEditableFields ?? []).join(', ')}`,
        `- humanVerdict allowed values: ${(focusedBatch.policy?.validHumanVerdicts ?? []).join(', ')}`,
        `- humanConfidence allowed values: ${(focusedBatch.policy?.validHumanConfidence ?? []).join(', ')}`,
        `- humanNotes is required when humanVerdict is: ${(focusedBatch.policy?.notesRequiredForVerdicts ?? []).join(', ')}`,
        '- Run the dry-run command first; it validates hashes, allowed fields, required notes, and target locators without writing review inputs.',
        '',
        '## Commands After Editing Focused Batch',
        '',
        '```powershell',
        'rtk pnpm visible-residual:apply-focused-batch --dry-run',
        'rtk pnpm visible-residual:apply-focused-batch',
        'rtk pnpm visible-residual:validate-human-review',
        'rtk pnpm visible-residual:loop',
        '```',
        '',
        '## Visible Residual Batch',
        '',
        `- clusterId: ${visibleBatch.clusterId ?? ''}`,
        `- sheetPath: ${visibleBatch.sheetPath ?? ''}`,
        '',
        formatSheetPreview('Visible residual cluster sheet', visibleBatch.sheetPath),
        '',
        formatDecisionCropPreviews('Visible residual', visibleDecisions),
        '',
        formatDecisionTable(visibleDecisions),
        '',
        '## Gold Candidate Batch',
        '',
        `- clusterId: ${goldCandidateBatch.clusterId ?? ''}`,
        `- sheetPath: ${goldCandidateBatch.sheetPath ?? ''}`,
        '',
        formatSheetPreview('Gold candidate cluster sheet', goldCandidateBatch.sheetPath),
        '',
        formatDecisionCropPreviews('Gold candidate', goldCandidateDecisions),
        '',
        formatDecisionTable(goldCandidateDecisions),
        '',
        '## Blocked Actions',
        '',
        ...(checkpoint.blockedActions ?? []).map((action) => (
            `- ${action.id}: blocked=${action.blocked}; reason=${action.reason ?? ''}; requiredState=${action.requiredState ?? ''}`
        )),
        ''
    ];
    return `${lines.join('\n')}\n`;
}

function buildReport({
    validation,
    manifest,
    clusterReport,
    reviewClusterPath,
    outputPath,
    limit,
    validationReportSha256,
    reviewManifestSha256,
    reviewClusterSha256
}) {
    const recordsByFile = manifestRecordsByFile(manifest);
    const incomplete = (validation.incompleteDecisions ?? []).map((entry) => enrichDecision(entry, recordsByFile, validation));
    const structuralErrors = validation.structuralErrors ?? [];
    const readyDecisions = validation.readyDecisions ?? [];
    const allIncompleteClusters = incompleteClusters(clusterReport);
    const nextReviewClusters = allIncompleteClusters.slice(0, limit);
    const sortedIncomplete = sortIncompleteByClusterPriority(incomplete, allIncompleteClusters);
    const nextReviewBatch = buildNextReviewBatch({
        sortedIncomplete,
        topCluster: allIncompleteClusters[0] ?? null,
        limit
    });
    const reviewBatches = buildReviewBatches({
        sortedIncomplete,
        clusters: allIncompleteClusters,
        limit
    });
    const goldCandidateReviewBatches = reviewBatches.filter((batch) => batch.sourceSet === 'metricPassVisible');
    const totalReviewDecisions = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    const completionRatio = totalReviewDecisions > 0
        ? Number(((validation.readyDecisionCount ?? 0) / totalReviewDecisions).toFixed(4))
        : 0;

    const report = {
        generatedAt: new Date().toISOString(),
        policy: {
            readOnly: true,
            writesReviewProgressReport: Boolean(outputPath),
            writesReviewCheckpoint: false,
            writesFocusedReviewBatch: false,
            writesReviewHandoff: false,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        inputs: {
            validationPath: validation.outputPath ?? null,
            validationReportSha256,
            reviewManifestPath: validation.reviewManifestPath ?? null,
            reviewManifestSha256,
            reviewClusterPath,
            reviewClusterSha256,
            decisionsPath: validation.decisionsPath ?? null,
            candidateDecisionsPath: validation.candidateDecisionsPath ?? null
        },
        outputs: {
            reviewProgressReportPath: outputPath ?? null,
            reviewCheckpointPath: null,
            focusedReviewBatchPath: null,
            reviewHandoffPath: null
        },
        summary: {
            readyForGoldMigration: validation.readyForGoldMigration === true,
            totalReviewDecisions,
            readyDecisionCount: validation.readyDecisionCount ?? 0,
            unconfirmedCount: validation.unconfirmedCount ?? 0,
            structuralErrorCount: validation.structuralErrorCount ?? 0,
            completionRatio,
            pendingTotal: validation.pendingTotal ?? 0,
            pendingReadyDecisionCount: validation.pendingReadyDecisionCount ?? 0,
            pendingUnconfirmedCount: validation.pendingUnconfirmedCount ?? 0,
            goldCandidateTotal: validation.goldCandidateTotal ?? 0,
            goldCandidateReadyDecisionCount: validation.goldCandidateReadyDecisionCount ?? 0,
            goldCandidateUnconfirmedCount: validation.goldCandidateUnconfirmedCount ?? 0
        },
        clusterSummary: {
            available: Boolean(clusterReport),
            totalRecords: clusterReport?.summary?.totalRecords ?? 0,
            clusterTotal: clusterReport?.summary?.clusterTotal ?? 0,
            clusterSheetCount: clusterReport?.summary?.clusterSheetCount ?? 0,
            unconfirmedCount: clusterReport?.summary?.unconfirmedCount ?? 0,
            structuralErrorCount: clusterReport?.summary?.structuralErrorCount ?? 0
        },
        counts: {
            incompleteBySourceSet: countBy(incomplete, (entry) => entry.sourceSet),
            incompleteByProfile: countBy(incomplete, (entry) => entry.profileLine),
            incompleteByCluster: incompleteCountByCluster(allIncompleteClusters),
            incompleteByProblem: countBy(
                incomplete.flatMap((entry) => entry.problems.length > 0 ? entry.problems : ['unknown']),
                (problem) => problem
            ),
            readyByVerdict: validation.verdictCounts ?? countBy(readyDecisions, (entry) => entry.humanVerdict),
            readyByConfidence: validation.confidenceCounts ?? countBy(readyDecisions, (entry) => entry.humanConfidence)
        },
        nextReviewClusters,
        nextReviewBatch,
        reviewBatches,
        goldCandidateReviewBatches,
        nextGoldCandidateReviewBatch: goldCandidateReviewBatches[0] ?? null,
        nextReviewItems: sortedIncomplete.slice(0, limit),
        structuralErrors,
        blockers: [
            validation.readyForGoldMigration === true ? null : 'human-review-not-complete',
            structuralErrors.length > 0 ? 'structural-errors-present' : null,
            clusterReport ? null : 'cluster-report-unavailable'
        ].filter(Boolean)
    };
    report.reviewCheckpoint = buildReviewCheckpoint(report);
    report.focusedReviewBatch = buildFocusedReviewBatch(report);
    report.reviewHandoffMarkdown = buildReviewHandoffMarkdown(report);
    return report;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const guardOutputPath =
        args.outputPath ??
        args.checkpointOutputPath ??
        args.focusedBatchOutputPath ??
        args.handoffOutputPath ??
        DEFAULT_REVIEW_CHECKPOINT_PATH;
    const loopRunStatePath = path.resolve(path.dirname(guardOutputPath), '..', 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath ?? null,
            checkpointOutputPath: args.checkpointOutputPath ?? null,
            focusedBatchOutputPath: args.focusedBatchOutputPath ?? null,
            handoffOutputPath: args.handoffOutputPath ?? null,
            skippedWrite: true,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:review-status.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const validationText = stripBom(await readFile(args.validationPath, 'utf8'));
    const manifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const clusterText = await readOptionalText(args.reviewClusterPath);
    const validation = JSON.parse(validationText);
    const manifest = JSON.parse(manifestText);
    const clusterReport = clusterText ? JSON.parse(clusterText) : null;
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
            problems: clusterReportProblems,
            expectedReviewManifestSha256: reviewManifestSha256,
            actualReviewManifestSha256: clusterReport?.inputs?.reviewManifestSha256 ?? null,
            expectedValidationReportSha256: validationReportSha256,
            actualValidationReportSha256: clusterReport?.inputs?.validationReportSha256 ?? null
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const report = buildReport({
        validation,
        manifest,
        clusterReport,
        reviewClusterPath: args.reviewClusterPath,
        outputPath: args.outputPath,
        limit: args.limit,
        validationReportSha256,
        reviewManifestSha256,
        reviewClusterSha256: clusterText ? sha256Text(clusterText) : null
    });

    if (args.outputPath) {
        await mkdir(path.dirname(args.outputPath), { recursive: true });
        await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    if (args.checkpointOutputPath) {
        report.outputs.reviewCheckpointPath = args.checkpointOutputPath;
        report.policy.writesReviewCheckpoint = true;
        report.reviewCheckpoint.policy.writesReviewProgressReport = Boolean(args.outputPath);
        await mkdir(path.dirname(args.checkpointOutputPath), { recursive: true });
        await writeFile(args.checkpointOutputPath, `${JSON.stringify(report.reviewCheckpoint, null, 2)}\n`, 'utf8');
        if (args.outputPath) {
            await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
    }
    if (args.focusedBatchOutputPath) {
        report.outputs.focusedReviewBatchPath = args.focusedBatchOutputPath;
        report.policy.writesFocusedReviewBatch = true;
        await mkdir(path.dirname(args.focusedBatchOutputPath), { recursive: true });
        await writeFile(args.focusedBatchOutputPath, `${JSON.stringify(report.focusedReviewBatch, null, 2)}\n`, 'utf8');
        if (args.outputPath) {
            await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
    }
    if (args.handoffOutputPath) {
        report.outputs.reviewHandoffPath = args.handoffOutputPath;
        report.policy.writesReviewHandoff = true;
        report.reviewHandoffMarkdown = buildReviewHandoffMarkdown(report);
        await mkdir(path.dirname(args.handoffOutputPath), { recursive: true });
        await writeFile(args.handoffOutputPath, report.reviewHandoffMarkdown, 'utf8');
        if (args.outputPath) {
            await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        }
    } else {
        report.reviewHandoffMarkdown = buildReviewHandoffMarkdown(report);
    }
    console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
