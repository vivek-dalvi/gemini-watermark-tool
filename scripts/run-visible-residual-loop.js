import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const DEFAULT_SOURCE_SUMMARY_PATH = path.resolve('.artifacts/sample-files-gemini-watermark-residual-visibility-20260610/summary.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest');

function parseArgs(argv) {
    const parsed = {
        sourceSummaryPath: DEFAULT_SOURCE_SUMMARY_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: 30,
        sampleRoot: null
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--summary') {
            parsed.sourceSummaryPath = path.resolve(args.shift() || parsed.sourceSummaryPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
            continue;
        }
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || '.');
        }
    }

    return parsed;
}

function runNodeScript(scriptPath, args) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: process.cwd(),
            stdio: 'inherit'
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            const elapsedMs = Date.now() - startedAt;
            if (code === 0) {
                resolve({ scriptPath, elapsedMs });
                return;
            }
            reject(new Error(`${scriptPath} failed with code=${code} signal=${signal ?? 'null'}`));
        });
    });
}

function maybeSampleRootArgs(sampleRoot) {
    return sampleRoot ? ['--sample-root', sampleRoot] : [];
}

function sumBatchIncomplete(batches = []) {
    return (batches ?? []).reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0);
}

function buildDecisionTargets(items = []) {
    return (items ?? []).map((item) => ({
        sourceSet: item.sourceSet ?? null,
        clusterId: item.clusterId ?? null,
        file: item.file ?? null,
        decisionInputPath: item.decisionInputPath ?? null,
        decisionJsonPath: item.decisionJsonPath ?? null,
        decisionArrayIndex: Number.isInteger(item.decisionArrayIndex) ? item.decisionArrayIndex : null,
        cropPath: item.cropPath ?? null,
        profileLine: item.profileLine ?? null,
        visibleReasons: item.visibleReasons ?? [],
        suggestedVerdict: item.suggestedVerdict ?? null,
        suggestedConfidence: item.suggestedConfidence ?? null,
        problems: item.problems ?? []
    }));
}

function buildCompletionAudit(goalAuditReport) {
    const requirements = (goalAuditReport.requirements ?? []).map((item) => ({
        id: item.id,
        status: item.status ?? 'unknown',
        satisfied: item.satisfied === true,
        blockers: item.blockers ?? []
    }));
    const requirementCounts = requirements.reduce((counts, item) => {
        counts.total += 1;
        if (item.satisfied) counts.satisfied += 1;
        else if (item.status === 'blocked-by-human-review') counts.blockedByHumanReview += 1;
        else if (item.status === 'failed') counts.failed += 1;
        else if (item.status === 'missing-evidence') counts.missingEvidence += 1;
        else counts.otherIncomplete += 1;
        return counts;
    }, {
        total: 0,
        satisfied: 0,
        blockedByHumanReview: 0,
        missingEvidence: 0,
        failed: 0,
        otherIncomplete: 0
    });
    const unsatisfiedRequirementIds = requirements
        .filter((item) => !item.satisfied)
        .map((item) => item.id);
    const blockers = goalAuditReport.blockers ?? [];

    return {
        goalAchieved: requirements.length > 0 &&
            unsatisfiedRequirementIds.length === 0 &&
            blockers.length === 0 &&
            goalAuditReport.status === 'complete',
        goalAuditStatus: goalAuditReport.status ?? 'unknown',
        requirementCounts,
        requirements,
        unsatisfiedRequirementIds,
        blockers,
        humanReviewBlocked:
            blockers.includes('human-review-not-complete') ||
            requirements.some((item) => item.status === 'blocked-by-human-review'),
        completionRequiredState: {
            allRequirementsSatisfied: true,
            blockersEmpty: true,
            formalGoldMigrationSatisfied: true,
            noAlphaProfileProductionBeforeHumanConfirmationSatisfied: true,
            requiredRequirementIds: [
                'formal-gold-migration',
                'no-alpha-profile-production-before-human-confirmation'
            ]
        }
    };
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

async function sha256File(filePath) {
    return sha256Text(stripBom(await readFile(filePath, 'utf8')));
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeLoopRunState(statePath, state) {
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeJson(statePath, {
        schemaVersion: 1,
        status: 'running',
        updatedAt: new Date().toISOString(),
        ...state
    });
}

async function clearLoopRunState(statePath) {
    await rm(statePath, { force: true });
}

async function createLoopSummary({
    options,
    results,
    paths,
    verifiedByFinalStep
}) {
    const validationReport = await readJson(paths.validationReportPath);
    const admissionReport = await readJson(paths.admissionReportPath);
    const goalAuditReport = await readJson(paths.goalAuditReportPath);
    const reviewProgressReport = await readJson(paths.reviewProgressReportPath);
    const algorithmAdmissionRequirement = (goalAuditReport.requirements ?? []).find((item) => (
        item.id === 'algorithm-admission-human-gated'
    ));
    const noProductionRequirement = (goalAuditReport.requirements ?? []).find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    const packageScriptGate = noProductionRequirement?.evidence?.packageScriptGate ?? null;
    const nextReviewCluster = reviewProgressReport.nextReviewClusters?.[0] ?? null;
    const nextReviewBatch = reviewProgressReport.nextReviewBatch ?? null;
    const reviewBatches = reviewProgressReport.reviewBatches ?? [];
    const goldCandidateReviewBatches = reviewProgressReport.goldCandidateReviewBatches ?? [];
    const reviewBatchTotal = sumBatchIncomplete(reviewBatches);
    const goldCandidateReviewBatchTotal = sumBatchIncomplete(goldCandidateReviewBatches);
    const nextGoldCandidateReviewBatch = reviewProgressReport.nextGoldCandidateReviewBatch ?? null;
    const firstBatchItem = nextReviewBatch?.items?.[0] ?? null;
    const nextReviewDecisionTargets = buildDecisionTargets(nextReviewBatch?.items ?? []);
    const nextGoldCandidateDecisionTargets = buildDecisionTargets(nextGoldCandidateReviewBatch?.items ?? []);
    const readyForGoldMigration = validationReport.readyForGoldMigration === true;
    const unconfirmedCount = validationReport.unconfirmedCount ?? null;
    const structuralErrorCount = validationReport.structuralErrorCount ?? null;
    const productionProfileAllowed = admissionReport.productionProfileAdmission?.allowed === true;

    return {
        ok: true,
        sourceSummaryPath: options.sourceSummaryPath,
        outputDir: options.outputDir,
        generatedAt: new Date().toISOString(),
        verifiedByFinalStep,
        inputHashes: {
            sourceSummarySha256: await sha256File(options.sourceSummaryPath),
            renderSummarySha256: await sha256File(paths.renderSummaryPath),
            reviewManifestSha256: await sha256File(paths.reviewManifestPath),
            validationReportSha256: await sha256File(paths.validationReportPath),
            reviewClusterSha256: await sha256File(paths.clusterReportPath),
            humanReviewPackSummarySha256: await sha256File(paths.humanReviewPackSummaryPath),
            reviewWorksheetSha256: await sha256File(paths.reviewWorksheetPath),
            reviewTableSha256: await sha256File(paths.reviewTablePath),
            clusterReviewWorksheetSha256: await sha256File(paths.clusterReviewWorksheetPath),
            reviewProgressReportSha256: await sha256File(paths.reviewProgressReportPath),
            reviewCheckpointSha256: await sha256File(paths.reviewCheckpointPath),
            focusedReviewBatchSha256: await sha256File(paths.focusedReviewBatchPath),
            reviewHandoffSha256: await sha256File(paths.reviewHandoffPath),
            humanReviewReadmeSha256: await sha256File(paths.humanReviewReadmePath),
            reviewInputContractSha256: await sha256File(paths.reviewInputContractPath),
            reviewDecisionsSha256: await sha256File(paths.humanDecisionsPath),
            goldCandidateConfirmationsSha256: await sha256File(paths.humanGoldCandidateConfirmationsPath),
            packageJsonSha256: packageScriptGate?.packageJsonSha256 ?? null,
            admissionReportSha256: await sha256File(paths.admissionReportPath),
            goalAuditReportSha256: await sha256File(paths.goalAuditReportPath)
        },
        summary: {
            readyForGoldMigration,
            unconfirmedCount,
            structuralErrorCount,
            reviewManifestSha256: validationReport.reviewManifestSha256 ?? null,
            productionProfileAllowed,
            productionGateContractReady:
                algorithmAdmissionRequirement?.evidence?.productionGateContractReady === true,
            goldManifestWriteAllowed:
                readyForGoldMigration &&
                unconfirmedCount === 0 &&
                structuralErrorCount === 0,
            goldManifestExists: goalAuditReport.summary?.goldManifestExists === true,
            productionHitCount: goalAuditReport.summary?.productionHitCount ?? null,
            productionArtifactHitCount: goalAuditReport.summary?.productionArtifactHitCount ?? null,
            packageScriptGateReady: packageScriptGate?.ready === true,
            visibleResidualPackageScriptCount:
                goalAuditReport.summary?.visibleResidualPackageScriptCount ?? packageScriptGate?.visibleResidualScriptCount ?? null,
            forbiddenVisibleResidualPackageScriptCount:
                goalAuditReport.summary?.forbiddenVisibleResidualPackageScriptCount ??
                packageScriptGate?.forbiddenVisibleResidualPackageScripts?.length ??
                null,
            unclassifiedVisibleResidualPackageScriptCount:
                goalAuditReport.summary?.unclassifiedVisibleResidualPackageScriptCount ??
                packageScriptGate?.unclassifiedVisibleResidualScripts?.length ??
                null,
            goalAuditStatus: goalAuditReport.status ?? 'unknown',
            blockers: goalAuditReport.blockers ?? []
        },
        humanReviewGuidance: {
            humanReviewPackSummaryPath: paths.humanReviewPackSummaryPath,
            reviewWorksheetPath: paths.reviewWorksheetPath,
            reviewTablePath: paths.reviewTablePath,
            clusterReviewWorksheetPath: paths.clusterReviewWorksheetPath,
            reviewProgressReportPath: paths.reviewProgressReportPath,
            reviewCheckpointPath: paths.reviewCheckpointPath,
            focusedReviewBatchPath: paths.focusedReviewBatchPath,
            reviewHandoffPath: paths.reviewHandoffPath,
            humanReviewReadmePath: paths.humanReviewReadmePath,
            reviewDecisionsPath: paths.humanDecisionsPath,
            goldCandidateConfirmationsPath: paths.humanGoldCandidateConfirmationsPath,
            reviewBatchCount: reviewBatches.length,
            reviewBatchTotal,
            remainingClusterCount: reviewBatches.filter((batch) => (batch.totalIncompleteInCluster ?? 0) > 0).length,
            goldCandidateUnconfirmedCount: validationReport.goldCandidateUnconfirmedCount ?? null,
            goldCandidateReviewBatchCount: goldCandidateReviewBatches.length,
            goldCandidateReviewBatchTotal,
            nextReviewCluster: nextReviewCluster
                ? {
                    clusterId: nextReviewCluster.clusterId,
                    sourceSet: nextReviewCluster.sourceSet,
                    profileLine: nextReviewCluster.profileLine,
                    visibleReasons: nextReviewCluster.visibleReasons ?? [],
                    incompleteCount: nextReviewCluster.incompleteCount ?? null,
                    sheetPath: nextReviewCluster.sheetPath ?? null
                }
                : null,
            nextGoldCandidateReviewBatch: nextGoldCandidateReviewBatch
                ? {
                    clusterId: nextGoldCandidateReviewBatch.clusterId,
                    itemCount: nextGoldCandidateReviewBatch.itemCount ?? null,
                    totalIncompleteInCluster: nextGoldCandidateReviewBatch.totalIncompleteInCluster ?? null,
                    firstDecisionInputPath: nextGoldCandidateReviewBatch.firstDecisionInputPath ?? null,
                    firstDecisionJsonPath: nextGoldCandidateReviewBatch.firstDecisionJsonPath ?? null,
                    firstFile: nextGoldCandidateReviewBatch.firstFile ?? null,
                    firstCropPath: nextGoldCandidateReviewBatch.firstCropPath ?? null,
                    sheetPath: nextGoldCandidateReviewBatch.sheetPath ?? null
                }
                : null,
            nextReviewBatch: nextReviewBatch?.cluster
                ? {
                    clusterId: nextReviewBatch.cluster.clusterId,
                    itemCount: nextReviewBatch.itemCount ?? null,
                    remainingInCluster: nextReviewBatch.remainingInCluster ?? null,
                    firstDecisionInputPath: firstBatchItem?.decisionInputPath ?? null,
                    firstDecisionJsonPath: firstBatchItem?.decisionJsonPath ?? null,
                    firstFile: firstBatchItem?.file ?? null,
                    firstCropPath: firstBatchItem?.cropPath ?? null,
                    decisionTargets: nextReviewDecisionTargets
                }
                : null
        },
        completionAudit: buildCompletionAudit(goalAuditReport),
        nextActions: [
            ...(reviewBatchTotal > 0
                ? [{
                    id: 'complete-visible-residual-review-batches',
                    status: 'required',
                    remainingDecisionCount: reviewBatchTotal,
                    batchCount: reviewBatches.length,
                    inputPath: paths.humanDecisionsPath,
                    firstDecisionJsonPath: firstBatchItem?.decisionJsonPath ?? null,
                    firstFile: firstBatchItem?.file ?? null,
                    firstCropPath: firstBatchItem?.cropPath ?? null,
                    sheetPath: nextReviewBatch.cluster?.sheetPath ?? nextReviewCluster?.sheetPath ?? null,
                    decisionTargets: nextReviewDecisionTargets,
                    policy: {
                        actionType: 'human-review',
                        requiresHumanJudgement: true,
                        reviewCheckpointPath: paths.reviewCheckpointPath,
                        focusedReviewBatchPath: paths.focusedReviewBatchPath,
                        writesFormalGoldManifest: false,
                        writesProductionAlgorithm: false,
                        allowsAlphaProfileProduction: false,
                        validationCommandAfterEdit: 'pnpm visible-residual:validate-human-review'
                    }
                }]
                : []),
            ...(goldCandidateReviewBatchTotal > 0
                ? [{
                    id: 'complete-gold-candidate-confirmations',
                    status: 'required',
                    remainingDecisionCount: goldCandidateReviewBatchTotal,
                    batchCount: goldCandidateReviewBatches.length,
                    inputPath: paths.humanGoldCandidateConfirmationsPath,
                    firstDecisionJsonPath: nextGoldCandidateReviewBatch?.firstDecisionJsonPath ?? null,
                    firstFile: nextGoldCandidateReviewBatch?.firstFile ?? null,
                    firstCropPath: nextGoldCandidateReviewBatch?.firstCropPath ?? null,
                    sheetPath: nextGoldCandidateReviewBatch?.sheetPath ?? null,
                    decisionTargets: nextGoldCandidateDecisionTargets,
                    policy: {
                        actionType: 'human-review',
                        requiresHumanJudgement: true,
                        reviewCheckpointPath: paths.reviewCheckpointPath,
                        focusedReviewBatchPath: paths.focusedReviewBatchPath,
                        writesFormalGoldManifest: false,
                        writesProductionAlgorithm: false,
                        allowsAlphaProfileProduction: false,
                        validationCommandAfterEdit: 'pnpm visible-residual:validate-human-review'
                    }
                }]
                : []),
            ...(!readyForGoldMigration
                ? [{
                    id: 'rerun-human-review-validation-after-edits',
                    status: 'required-after-human-edits',
                    command: 'pnpm visible-residual:validate-human-review',
                    policy: {
                        actionType: 'validation',
                        requiresHumanJudgement: false,
                        writesFormalGoldManifest: false,
                        writesProductionAlgorithm: false,
                        allowsAlphaProfileProduction: false
                    }
                }]
                : [])
        ],
        blockedActions: [
            {
                id: 'write-formal-gold-manifest',
                blocked: !(readyForGoldMigration && unconfirmedCount === 0 && structuralErrorCount === 0),
                reason: readyForGoldMigration
                    ? null
                    : 'human-review-not-complete',
                requiredState: 'readyForGoldMigration=true, unconfirmedCount=0, structuralErrorCount=0',
                gateEvidence: {
                    readyForGoldMigration,
                    unconfirmedCount,
                    structuralErrorCount,
                    goldManifestWriteAllowed:
                        readyForGoldMigration &&
                        unconfirmedCount === 0 &&
                        structuralErrorCount === 0
                },
                policy: {
                    writesFormalGoldManifest: true,
                    writesProductionAlgorithm: false,
                    requiresHumanConfirmationBeforeWrite: true
                }
            },
            {
                id: 'productionize-alpha-profile-variant',
                blocked: !productionProfileAllowed,
                reason: productionProfileAllowed
                    ? null
                    : 'production-profile-admission-not-allowed',
                requiredState: 'verified formal gold manifest plus accepted production decision gates',
                gateEvidence: {
                    productionProfileAllowed,
                    productionGateContractReady:
                        algorithmAdmissionRequirement?.evidence?.productionGateContractReady === true,
                    productionHitCount: goalAuditReport.summary?.productionHitCount ?? null,
                    productionArtifactHitCount: goalAuditReport.summary?.productionArtifactHitCount ?? null,
                    goldManifestExists: goalAuditReport.summary?.goldManifestExists === true,
                    readyForGoldMigration,
                    packageScriptGateReady: packageScriptGate?.ready === true,
                    forbiddenVisibleResidualPackageScriptCount:
                        packageScriptGate?.forbiddenVisibleResidualPackageScripts?.length ?? null,
                    unclassifiedVisibleResidualPackageScriptCount:
                        packageScriptGate?.unclassifiedVisibleResidualScripts?.length ?? null
                },
                policy: {
                    writesFormalGoldManifest: false,
                    writesProductionAlgorithm: true,
                    requiresHumanConfirmationBeforeWrite: true
                }
            }
        ],
        steps: results
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const reviewManifestPath = path.join(options.outputDir, 'review-manifest.json');
    const alphaSweepPath = path.join(options.outputDir, 'alpha-sweep', 'model-investigation-alpha-sweep.json');
    const alphaProfilePath = path.join(options.outputDir, 'alpha-profile', 'model-investigation-alpha-profile.json');
    const alphaProfileGeneralizationPath = path.join(options.outputDir, 'alpha-profile', 'large-margin-48-profile-candidate.json');
    const goldProposalPath = path.join(options.outputDir, 'gold-proposal.json');
    const clusterReportPath = path.join(options.outputDir, 'review-clusters.json');
    const admissionReportPath = path.join(options.outputDir, 'algorithm-admission-report.json');
    const goalAuditReportPath = path.join(options.outputDir, 'goal-audit-report.json');
    const humanReviewPackDir = path.join(options.outputDir, 'human-review-pack');
    const validationReportPath = path.join(humanReviewPackDir, 'validation-report.json');
    const reviewInputContractPath = path.join(humanReviewPackDir, 'review-input-contract.json');
    const reviewWorksheetPath = path.join(humanReviewPackDir, 'review-worksheet.md');
    const reviewTablePath = path.join(humanReviewPackDir, 'review-table.csv');
    const clusterReviewWorksheetPath = path.join(humanReviewPackDir, 'cluster-review-worksheet.md');
    const reviewProgressReportPath = path.join(humanReviewPackDir, 'review-progress-report.json');
    const reviewCheckpointPath = path.join(humanReviewPackDir, 'review-checkpoint.json');
    const focusedReviewBatchPath = path.join(humanReviewPackDir, 'review-focused-batch.json');
    const reviewHandoffPath = path.join(humanReviewPackDir, 'review-handoff.md');
    const humanReviewReadmePath = path.join(humanReviewPackDir, 'README.md');
    const loopSummaryPath = path.join(options.outputDir, 'loop-summary.json');
    const loopRunStatePath = path.join(options.outputDir, 'loop-run-state.json');
    const humanDecisionsPath = path.join(humanReviewPackDir, 'review-decisions.json');
    const humanGoldCandidateConfirmationsPath = path.join(humanReviewPackDir, 'gold-candidate-confirmations.json');
    const steps = [
        {
            name: 'render visible residual crops',
            script: 'scripts/render-visible-residual-crops.js',
            args: [
                '--summary', options.sourceSummaryPath,
                '--out-dir', options.outputDir,
                '--limit', String(options.limit),
                ...maybeSampleRootArgs(options.sampleRoot)
            ]
        },
        {
            name: 'create review manifest',
            script: 'scripts/create-visible-residual-review-manifest.js',
            args: [
                '--summary', path.join(options.outputDir, 'summary.json'),
                '--output', reviewManifestPath
            ]
        },
        {
            name: 'render review queues',
            script: 'scripts/render-visible-residual-review-queues.js',
            args: [
                '--manifest', reviewManifestPath,
                '--out-dir', path.join(options.outputDir, 'review-queues')
            ]
        },
        {
            name: 'probe alpha gain sweep',
            script: 'scripts/probe-visible-residual-alpha-sweep.js',
            args: [
                '--manifest', reviewManifestPath,
                '--output', alphaSweepPath,
                ...maybeSampleRootArgs(options.sampleRoot)
            ]
        },
        {
            name: 'probe alpha profile variants',
            script: 'scripts/probe-visible-residual-alpha-profile.js',
            args: [
                '--manifest', reviewManifestPath,
                '--output', alphaProfilePath,
                ...maybeSampleRootArgs(options.sampleRoot)
            ]
        },
        {
            name: 'render alpha profile sheet',
            script: 'scripts/render-visible-residual-alpha-profile-sheet.js',
            args: [
                '--report', alphaProfilePath,
                '--out-dir', path.dirname(alphaProfilePath)
            ]
        },
        {
            name: 'probe 48 large-margin profile candidate',
            script: 'scripts/probe-48-large-margin-profile-candidate.js',
            args: [
                '--manifest', reviewManifestPath,
                '--output', alphaProfileGeneralizationPath,
                ...maybeSampleRootArgs(options.sampleRoot)
            ]
        },
        {
            name: 'render 48 large-margin profile sheet',
            script: 'scripts/render-48-large-margin-profile-candidate-sheet.js',
            args: [
                '--report', alphaProfileGeneralizationPath,
                '--out-dir', path.dirname(alphaProfileGeneralizationPath)
            ]
        },
        {
            name: 'create gold proposal',
            script: 'scripts/create-visible-residual-gold-proposal.js',
            args: [
                '--review', reviewManifestPath,
                '--alpha-sweep', alphaSweepPath,
                '--profile', alphaProfilePath,
                '--profile-generalization', alphaProfileGeneralizationPath,
                '--output', goldProposalPath
            ]
        },
        {
            name: 'create human review pack',
            script: 'scripts/create-visible-residual-human-review-pack.js',
            args: [
                '--manifest', reviewManifestPath,
                '--out-dir', humanReviewPackDir
            ]
        },
        {
            name: 'validate human review decisions',
            script: 'scripts/validate-visible-residual-human-review.js',
            args: [
                '--manifest', reviewManifestPath,
                '--decisions', humanDecisionsPath,
                '--candidate-decisions', humanGoldCandidateConfirmationsPath,
                '--contract', reviewInputContractPath,
                '--output', validationReportPath,
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'create review cluster report',
            script: 'scripts/create-visible-residual-cluster-report.js',
            args: [
                '--manifest', reviewManifestPath,
                '--validation', validationReportPath,
                '--output', clusterReportPath,
                '--worksheet-output', clusterReviewWorksheetPath,
                '--cluster-sheet-dir', path.join(humanReviewPackDir, 'by-cluster'),
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'create algorithm admission report',
            script: 'scripts/create-visible-residual-admission-report.js',
            args: [
                '--proposal', goldProposalPath,
                '--validation', validationReportPath,
                '--output', admissionReportPath,
                '--gold-manifest', path.join(options.outputDir, 'gold-manifest.json'),
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'create human review worksheet',
            script: 'scripts/create-visible-residual-review-worksheet.js',
            args: [
                '--manifest', reviewManifestPath,
                '--validation', validationReportPath,
                '--clusters', clusterReportPath,
                '--output', reviewWorksheetPath,
                '--csv-output', reviewTablePath,
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'report human review progress',
            script: 'scripts/report-visible-residual-review-progress.js',
            args: [
                '--manifest', reviewManifestPath,
                '--validation', validationReportPath,
                '--clusters', clusterReportPath,
                '--output', reviewProgressReportPath,
                '--checkpoint-output', reviewCheckpointPath,
                '--focused-batch-output', focusedReviewBatchPath,
                '--handoff-output', reviewHandoffPath,
                '--limit', '8',
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'create goal audit report',
            script: 'scripts/create-visible-residual-goal-audit-report.js',
            args: [
                '--artifact-dir', options.outputDir,
                '--output', goalAuditReportPath,
                '--allow-active-loop-state'
            ]
        },
        {
            name: 'verify loop',
            script: 'scripts/verify-visible-residual-loop.js',
            args: [
                '--artifact-dir', options.outputDir,
                '--allow-active-loop-state'
            ]
        }
    ];

    const summaryPaths = {
        renderSummaryPath: path.join(options.outputDir, 'summary.json'),
        reviewManifestPath,
        clusterReportPath,
        humanReviewPackSummaryPath: path.join(humanReviewPackDir, 'summary.json'),
        reviewWorksheetPath,
        reviewTablePath,
        clusterReviewWorksheetPath,
        validationReportPath,
        reviewInputContractPath,
        admissionReportPath,
        goalAuditReportPath,
        reviewProgressReportPath,
        reviewCheckpointPath,
        focusedReviewBatchPath,
        reviewHandoffPath,
        humanReviewReadmePath,
        humanDecisionsPath,
        humanGoldCandidateConfirmationsPath
    };
    const results = [];
    const runId = `${Date.now()}-${process.pid}`;
    const startedAt = new Date().toISOString();
    await writeLoopRunState(loopRunStatePath, {
        runId,
        pid: process.pid,
        artifactDir: options.outputDir,
        sourceSummaryPath: options.sourceSummaryPath,
        startedAt,
        currentStepName: null,
        currentStepIndex: 0,
        totalSteps: steps.length
    });
    try {
        for (const [index, step] of steps.entries()) {
            await writeLoopRunState(loopRunStatePath, {
                runId,
                pid: process.pid,
                artifactDir: options.outputDir,
                sourceSummaryPath: options.sourceSummaryPath,
                startedAt,
                currentStepName: step.name,
                currentStepIndex: index + 1,
                totalSteps: steps.length
            });
            if (step.name === 'verify loop') {
                await writeJson(loopSummaryPath, await createLoopSummary({
                    options,
                    results,
                    paths: summaryPaths,
                    verifiedByFinalStep: false
                }));
            }
            console.log(`\n[visible-residual-loop] ${step.name}`);
            const result = await runNodeScript(step.script, step.args);
            results.push({
                name: step.name,
                script: step.script,
                elapsedMs: result.elapsedMs
            });
        }

        const loopSummary = await createLoopSummary({
            options,
            results,
            paths: summaryPaths,
            verifiedByFinalStep: true
        });
        await writeJson(loopSummaryPath, loopSummary);
        console.log(JSON.stringify(loopSummary, null, 2));
    } finally {
        await clearLoopRunState(loopRunStatePath);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
