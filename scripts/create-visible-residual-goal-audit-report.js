import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_ARTIFACT_DIR = path.resolve('.artifacts/visible-residual-crops/latest');
const PRODUCTION_DIRS = Object.freeze([
    'src/core',
    'src/sdk',
    'src/runtime',
    'src/shared',
    'src/userscript',
    'dist'
]);
const PRODUCTION_SCAN_FILE_PATTERN = /\.(js|mjs|ts|d\.ts|html|json)$/;
const EXPERIMENTAL_PROFILE_PATTERNS = Object.freeze([
    /mid-boost-1\.24/,
    /mid-boost-1\.16/,
    /mid-boost-1\.08/,
    /power-0\.94/,
    /blur-mix-0\.25/
]);
const FORBIDDEN_VISIBLE_RESIDUAL_ARTIFACT_PATTERNS = Object.freeze([
    /visible-residual/i,
    /gold-proposal\.json/i,
    /review-manifest\.json/i,
    /review-clusters\.json/i,
    /human-review/i,
    /algorithm-admission-report\.json/i,
    /goal-audit-report\.json/i,
    /alpha-profile\/large-margin-48-profile-candidate/i
]);
const REQUIRED_PRODUCTION_CHANGE_GATE_MARKERS = Object.freeze([
    'human-confirmed-gold-manifest'
]);
const APPROVED_PRODUCTION_CHANGE_GATE_MARKERS = Object.freeze([
    'accepted-alpha-profile-decision',
    'accepted-alpha-gain-sweep-decision'
]);
const REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS = Object.freeze({
    'visible-residual:loop': 'node scripts/run-visible-residual-loop.js',
    'visible-residual:verify': 'node scripts/verify-visible-residual-loop.js',
    'visible-residual:validate-human-review': 'node scripts/validate-visible-residual-human-review.js',
    'visible-residual:create-gold-manifest': 'node scripts/create-visible-residual-gold-manifest.js',
    'visible-residual:review-status': 'node scripts/report-visible-residual-review-progress.js',
    'visible-residual:apply-focused-batch': 'node scripts/apply-visible-residual-focused-review-batch.js',
    'visible-residual:review-worksheet': 'node scripts/create-visible-residual-review-worksheet.js',
    'visible-residual:admission-report': 'node scripts/create-visible-residual-admission-report.js',
    'visible-residual:goal-audit': 'node scripts/create-visible-residual-goal-audit-report.js',
    'visible-residual:cluster-report': 'node scripts/create-visible-residual-cluster-report.js',
    'visible-residual:geometry-audit': 'node scripts/audit-visible-residual-geometry.js'
});
const FORBIDDEN_VISIBLE_RESIDUAL_PACKAGE_SCRIPT_PATTERNS = Object.freeze([
    /productionize/i,
    /promote/i,
    /write-production/i,
    /apply-alpha-profile/i,
    /accepted-alpha-profile-decision/i,
    /accepted-alpha-gain-sweep-decision/i,
    /mid-boost-1\.24/i
]);

function parseArgs(argv) {
    const parsed = {
        root: path.resolve('.'),
        artifactDir: DEFAULT_ARTIFACT_DIR,
        outputPath: null,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--') {
            continue;
        }
        if (arg === '--root') {
            parsed.root = path.resolve(args.shift() || parsed.root);
            continue;
        }
        if (arg === '--artifact-dir') {
            parsed.artifactDir = path.resolve(args.shift() || parsed.artifactDir);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--allow-active-loop-state') {
            parsed.allowActiveLoopState = true;
        }
    }

    parsed.outputPath ??= path.join(parsed.artifactDir, 'goal-audit-report.json');
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

async function sha256File(filePath) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function readJson(filePath) {
    return JSON.parse(stripBom(await readFile(filePath, 'utf8')));
}

async function readActiveLoopRunState(statePath) {
    if (!existsSync(statePath)) return null;
    try {
        const state = await readJson(statePath);
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

async function listFilesRecursive(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...await listFilesRecursive(fullPath));
            continue;
        }
        if (entry.isFile()) out.push(fullPath);
    }
    return out;
}

async function findExperimentalProfileInProduction(root) {
    const hits = [];
    for (const dir of PRODUCTION_DIRS) {
        const files = await listFilesRecursive(path.join(root, dir));
        for (const filePath of files) {
            if (!PRODUCTION_SCAN_FILE_PATTERN.test(filePath)) continue;
            const text = await readFile(filePath, 'utf8');
            for (const pattern of EXPERIMENTAL_PROFILE_PATTERNS) {
                if (pattern.test(text)) {
                    hits.push({
                        filePath,
                        pattern: pattern.source
                    });
                }
            }
        }
    }
    return hits;
}

async function findForbiddenVisibleResidualArtifactReferences(root) {
    const hits = [];
    for (const dir of PRODUCTION_DIRS) {
        const files = await listFilesRecursive(path.join(root, dir));
        for (const filePath of files) {
            if (!PRODUCTION_SCAN_FILE_PATTERN.test(filePath)) continue;
            const text = await readFile(filePath, 'utf8');
            for (const pattern of FORBIDDEN_VISIBLE_RESIDUAL_ARTIFACT_PATTERNS) {
                if (pattern.test(text)) {
                    hits.push({
                        filePath,
                        pattern: pattern.source
                    });
                    break;
                }
            }
        }
    }
    return hits;
}

function assessVisibleResidualPackageScripts(packageJson) {
    const scripts = packageJson?.scripts ?? {};
    const visibleResidualScripts = Object.entries(scripts)
        .filter(([name]) => name.startsWith('visible-residual:'))
        .sort(([left], [right]) => left.localeCompare(right));
    const allowedScriptNames = Object.keys(REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS).sort();
    const missingOrMismatchedRequiredScripts = Object.entries(REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS)
        .filter(([name, command]) => scripts[name] !== command)
        .map(([name, command]) => ({
            name,
            expected: command,
            actual: scripts[name] ?? null
        }));
    const unclassifiedVisibleResidualScripts = visibleResidualScripts
        .filter(([name]) => !Object.hasOwn(REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS, name))
        .map(([name, command]) => ({ name, command }));
    const forbiddenVisibleResidualPackageScripts = visibleResidualScripts.flatMap(([name, command]) => (
        FORBIDDEN_VISIBLE_RESIDUAL_PACKAGE_SCRIPT_PATTERNS
            .filter((pattern) => pattern.test(name) || pattern.test(command))
            .map((pattern) => ({
                name,
                command,
                pattern: pattern.source
            }))
    ));

    return {
        ready:
            missingOrMismatchedRequiredScripts.length === 0 &&
            unclassifiedVisibleResidualScripts.length === 0 &&
            forbiddenVisibleResidualPackageScripts.length === 0,
        visibleResidualScriptCount: visibleResidualScripts.length,
        allowedScriptNames,
        scripts: Object.fromEntries(visibleResidualScripts),
        missingOrMismatchedRequiredScripts,
        unclassifiedVisibleResidualScripts,
        forbiddenVisibleResidualPackageScripts,
        forbiddenPatternSources: FORBIDDEN_VISIBLE_RESIDUAL_PACKAGE_SCRIPT_PATTERNS.map((pattern) => pattern.source)
    };
}

function requirement(id, status, evidence, blockers = []) {
    return {
        id,
        status,
        satisfied: status === 'satisfied',
        evidence,
        blockers
    };
}

function sumBatchIncomplete(batches = []) {
    return (batches ?? []).reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0);
}

function decisionTargetsMatchItems(targets = [], items = []) {
    if (!Array.isArray(targets) || !Array.isArray(items)) return false;
    if (targets.length !== items.length) return false;

    return targets.every((target, index) => {
        const item = items[index];
        return (
            target.sourceSet === item.sourceSet &&
            target.clusterId === item.clusterId &&
            target.file === item.file &&
            target.decisionInputPath === item.decisionInputPath &&
            target.decisionJsonPath === item.decisionJsonPath &&
            target.decisionArrayIndex === item.decisionArrayIndex &&
            target.cropPath === item.cropPath &&
            target.profileLine === item.profileLine &&
            JSON.stringify(target.visibleReasons ?? []) === JSON.stringify(item.visibleReasons ?? []) &&
            target.suggestedVerdict === item.suggestedVerdict &&
            target.suggestedConfidence === item.suggestedConfidence
        );
    });
}

function markdownImagePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return '';
    return filePath.replace(/\\/g, '/');
}

function handoffIncludesDecisionCropPreviews(handoffText, decisions = []) {
    return (decisions ?? []).every((decision) => (
        handoffText.includes(`${decision.decisionJsonPath}: ${decision.file}`) &&
        handoffText.includes(markdownImagePath(decision.cropPath))
    ));
}

function incompleteClusterCount(reviewClusters) {
    return (reviewClusters.clusters ?? []).filter((cluster) => (
        (cluster.incompleteCount ?? Math.max(0, (cluster.count ?? 0) - (cluster.readyCount ?? 0))) > 0
    )).length;
}

function assessGoldManifestIntegrity({
    goldManifest,
    validation,
    reviewManifestSha256,
    validationReportSha256,
    goldProposalSha256,
    alphaSweepSha256,
    profileReportSha256,
    profileGeneralizationSha256
}) {
    if (!goldManifest) {
        return {
            ready: false,
            problems: ['gold-manifest-missing']
        };
    }

    const readyDecisions = validation.readyDecisions ?? [];
    const samples = goldManifest.samples ?? {};
    const sampleFiles = Object.keys(samples);
    const readyFiles = readyDecisions.map((decision) => decision.file);
    const problems = [];

    if (goldManifest.policy?.generatedOnlyAfterHumanConfirmation !== true) {
        problems.push('gold-manifest-policy-not-human-confirmed');
    }
    if (goldManifest.policy?.writesProductionAlgorithm !== false) {
        problems.push('gold-manifest-policy-writes-production');
    }
    if (goldManifest.policy?.containsAlphaProfileVariants !== false) {
        problems.push('gold-manifest-policy-allows-alpha-profile-variants');
    }
    if (goldManifest.inputs?.validationReportSha256 !== validationReportSha256) {
        problems.push('gold-manifest-validation-hash-mismatch');
    }
    if (goldManifest.inputs?.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('gold-manifest-review-manifest-hash-mismatch');
    }
    if (goldManifest.inputs?.goldProposalSha256 !== goldProposalSha256) {
        problems.push('gold-manifest-proposal-hash-mismatch');
    }
    if (goldManifest.inputs?.alphaSweepSha256 !== alphaSweepSha256) {
        problems.push('gold-manifest-alpha-sweep-hash-mismatch');
    }
    if (goldManifest.inputs?.profileReportSha256 !== profileReportSha256) {
        problems.push('gold-manifest-profile-report-hash-mismatch');
    }
    if (goldManifest.inputs?.profileGeneralizationSha256 !== profileGeneralizationSha256) {
        problems.push('gold-manifest-profile-generalization-hash-mismatch');
    }
    if (goldManifest.summary?.total !== readyDecisions.length || sampleFiles.length !== readyDecisions.length) {
        problems.push('gold-manifest-sample-count-mismatch');
    }
    for (const decision of readyDecisions) {
        if (!samples[decision.file]) {
            problems.push('gold-manifest-missing-ready-sample');
            break;
        }
        if (samples[decision.file]?.clusterId !== decision.clusterId) {
            problems.push('gold-manifest-cluster-id-mismatch');
            break;
        }
    }
    if (sampleFiles.some((file) => !readyFiles.includes(file))) {
        problems.push('gold-manifest-extra-sample');
    }

    return {
        ready: problems.length === 0,
        problems,
        sampleCount: sampleFiles.length,
        readyDecisionCount: readyDecisions.length
    };
}

function buildRequirements({
    paths,
    reviewManifest,
    reviewClusters,
    goldProposal,
    validationReportSha256,
    goldProposalSha256,
    alphaSweepSha256,
    profileReportSha256,
    profileGeneralizationSha256,
    alphaSweep,
    profileReport,
    profileGeneralization,
    validation,
    humanReviewPackSummary,
    reviewInputContract,
    reviewInputContractSha256,
    humanReviewTemplate,
    humanReviewInput,
    goldCandidateTemplate,
    goldCandidateInput,
    humanReviewPackArtifactHashesReady,
    reviewProgressReport,
    focusedReviewBatch,
    focusedReviewBatchSha256,
    reviewHandoffText,
    reviewHandoffSha256,
    humanReviewReadmeText,
    humanReviewReadmeSha256,
    humanReviewWorksheetText,
    humanReviewTableText,
    clusterReviewWorksheetText,
    reviewManifestSha256,
    reviewClusterSha256,
    admission,
    goldManifest,
    goldManifestExists,
    productionHits,
    productionArtifactHits,
    packageScriptGate
}) {
    const totalReviewDecisions = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    const reviewWorksheetProvenanceReady = humanReviewWorksheetText.includes(`validationReportSha256: \`${validationReportSha256}\``) &&
        humanReviewWorksheetText.includes(`reviewManifestSha256: \`${reviewManifestSha256}\``) &&
        humanReviewWorksheetText.includes(`reviewClusterSha256: \`${reviewClusterSha256}\``);
    const reviewTableProvenanceReady = validation.unconfirmedCount === 0 ||
        (
            humanReviewTableText.includes(validationReportSha256) &&
            humanReviewTableText.includes(reviewManifestSha256) &&
            humanReviewTableText.includes(reviewClusterSha256)
        );
    const humanReviewReadmeReady = humanReviewReadmeText.includes('review-handoff.md') &&
        humanReviewReadmeText.includes('review-focused-batch.json') &&
        humanReviewReadmeText.includes('humanVerdict') &&
        humanReviewReadmeText.includes('humanConfidence') &&
        humanReviewReadmeText.includes('humanNotes') &&
        humanReviewReadmeText.includes('rtk pnpm visible-residual:apply-focused-batch --dry-run') &&
        humanReviewReadmeText.includes('gold-manifest.json') &&
        humanReviewReadmeText.includes('alphaGain') &&
        humanReviewReadmeText.includes('profileVariant');
    const proposalCandidates = [
        ...goldProposal.goldCandidates?.readyForHumanConfirmation ?? [],
        ...goldProposal.goldCandidates?.pendingHumanReview ?? []
    ];
    const proposalCandidateProvenanceReady = proposalCandidates.length === totalReviewDecisions &&
        proposalCandidates.every((candidate) => typeof candidate.sourceSet === 'string' && candidate.sourceSet.length > 0) &&
        proposalCandidates.every((candidate) => typeof candidate.clusterId === 'string' && candidate.clusterId.length > 0) &&
        proposalCandidates.every((candidate) => Array.isArray(candidate.visibleReasons));
    const admissionProposalCandidateProvenanceReady = admission.proposalCandidateProvenance?.ok === true &&
        admission.proposalCandidateProvenance?.candidateCount === proposalCandidates.length &&
        admission.proposalCandidateProvenance?.expectedCandidateCount === totalReviewDecisions &&
        admission.proposalCandidateProvenance?.hashes?.reviewManifestSha256 === reviewManifestSha256;
    const admissionProposalValidationCoverageReady = admission.proposalValidationCoverage?.ok === true &&
        admission.proposalValidationCoverage?.expectedTotal === totalReviewDecisions &&
        admission.proposalValidationCoverage?.candidateCount === proposalCandidates.length &&
        admission.proposalValidationCoverage?.expectedCandidateCount === totalReviewDecisions;
    const productionGateContractReady =
        REQUIRED_PRODUCTION_CHANGE_GATE_MARKERS.every((marker) => (
            admission.algorithmAdmissionIntegrity?.requiredProductionChangeGateMarkers?.includes(marker)
        )) &&
        APPROVED_PRODUCTION_CHANGE_GATE_MARKERS.every((marker) => (
            admission.algorithmAdmissionIntegrity?.approvedProductionChangeGateMarkers?.includes(marker)
        )) &&
        (
            admission.algorithmAdmissionIntegrity?.productionChangeAllowed === true ||
            (
                admission.algorithmAdmissionIntegrity?.hasHumanConfirmedGoldManifestGate === false &&
                admission.algorithmAdmissionIntegrity?.hasApprovedProductionDecisionGate === false
            )
        );
    const admissionValidationReadinessIntegrityReady = admission.validationReadinessIntegrity?.ok === true &&
        admission.validationReadinessIntegrity?.expectedTotal === totalReviewDecisions;
    const reproducibleReviewReady = existsSync(path.join(paths.artifactDir, 'summary.json')) &&
        existsSync(path.join(paths.artifactDir, 'metricPassVisible.png')) &&
        existsSync(path.join(paths.artifactDir, 'visibleTop.png')) &&
        existsSync(path.join(paths.artifactDir, 'human-review-pack/README.md')) &&
        existsSync(path.join(paths.artifactDir, 'human-review-pack/review-worksheet.md')) &&
        existsSync(path.join(paths.artifactDir, 'human-review-pack/review-table.csv')) &&
        humanReviewReadmeReady &&
        humanReviewPackArtifactHashesReady &&
        reviewWorksheetProvenanceReady &&
        reviewTableProvenanceReady &&
        reviewManifest.summary?.visibleTopPending === validation.pendingTotal &&
        reviewManifest.summary?.metricPassVisibleReviewed === validation.goldCandidateTotal &&
        validation.policy?.writesFormalGoldManifest === false &&
        validation.policy?.writesProductionAlgorithm === false &&
        validation.decisionSchemaGate?.armed === true &&
        validation.decisionSchemaGate?.appliesToHumanReviewDecisionInputs === true &&
        validation.decisionSchemaGate?.rejectsAlphaProfileVariantFields === true &&
        validation.decisionSchemaGate?.rejectsUnknownDecisionFields === true &&
        validation.decisionSchemaGate?.rejectsUnknownDecisionInputRootFields === true &&
        validation.decisionSchemaGate?.ok === true;
    const groupingReady = reviewClusters.policy?.readOnly === true &&
        reviewClusters.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        reviewClusters.inputs?.validationReportSha256 === validationReportSha256 &&
        clusterReviewWorksheetText.includes(`reviewManifestSha256: \`${reviewManifestSha256}\``) &&
        clusterReviewWorksheetText.includes(`validationReportSha256: \`${validationReportSha256}\``) &&
        clusterReviewWorksheetText.includes(`reviewClusterSha256: \`${reviewClusterSha256}\``) &&
        reviewClusters.summary?.clusterTotal > 0 &&
        reviewClusters.summary?.clusterSheetCount === reviewClusters.summary?.clusterTotal &&
        reviewClusters.summary?.totalRecords === totalReviewDecisions;
    const goldCandidatesReady = goldProposal.policy?.writesFormalGoldManifest === false &&
        goldProposal.policy?.writesProductionAlgorithm === false &&
        goldProposal.policy?.requiresHumanConfirmationBeforeGoldMigration === true &&
        goldProposal.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        goldProposal.inputs?.alphaSweepSha256 === alphaSweepSha256 &&
        goldProposal.inputs?.profileReportSha256 === profileReportSha256 &&
        goldProposal.inputs?.profileGeneralizationSha256 === profileGeneralizationSha256 &&
        goldProposal.inputs?.alphaSweepReviewManifestSha256 === reviewManifestSha256 &&
        goldProposal.inputs?.profileReportReviewManifestSha256 === reviewManifestSha256 &&
        goldProposal.inputs?.profileGeneralizationReviewManifestSha256 === reviewManifestSha256 &&
        alphaSweep.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        profileReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        profileGeneralization.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        goldProposal.summary?.readyForHumanConfirmation === validation.goldCandidateTotal &&
        goldProposal.summary?.pendingHumanReview === validation.pendingTotal &&
        goldProposal.proposedGoldSchemaGate?.armed === true &&
        goldProposal.proposedGoldSchemaGate?.appliesToProposedGoldFields === true &&
        goldProposal.proposedGoldSchemaGate?.rejectsAlphaProfileVariantFields === true &&
        goldProposal.proposedGoldSchemaGate?.rejectsUnknownProposedGoldFields === true &&
        goldProposal.proposedGoldSchemaGate?.ok === true &&
        proposalCandidateProvenanceReady &&
        admissionProposalCandidateProvenanceReady &&
        admissionProposalValidationCoverageReady;
    const admissionReady = admission.policy?.reportOnly === true &&
        admission.policy?.writesFormalGoldManifest === false &&
        admission.policy?.writesProductionAlgorithm === false &&
        admission.inputs?.validationReportSha256 === validationReportSha256 &&
        admission.inputs?.reviewInputContractSha256 === reviewInputContractSha256 &&
        admission.inputs?.goldProposalSha256 === goldProposalSha256 &&
        admission.validationInputContractIntegrity?.ok === true &&
        admission.validationInputContractIntegrity?.hashes?.reviewInputContractSha256 === reviewInputContractSha256 &&
        admission.validationInputContractIntegrity?.hashes?.reviewInputContractReviewManifestSha256 === reviewManifestSha256 &&
        admissionValidationReadinessIntegrityReady &&
        admission.validationDecisionSchemaGateIntegrity?.ok === true &&
        admission.proposalInputIntegrity?.ok === true &&
        admission.proposalInputIntegrity?.hashes?.alphaSweepSha256 === alphaSweepSha256 &&
        admission.proposalInputIntegrity?.hashes?.profileReportSha256 === profileReportSha256 &&
        admission.proposalInputIntegrity?.hashes?.profileGeneralizationSha256 === profileGeneralizationSha256 &&
        admission.proposalInputIntegrity?.hashes?.alphaSweepReviewManifestSha256 === reviewManifestSha256 &&
        admission.proposalInputIntegrity?.hashes?.profileReportReviewManifestSha256 === reviewManifestSha256 &&
        admission.proposalInputIntegrity?.hashes?.profileGeneralizationReviewManifestSha256 === reviewManifestSha256 &&
        admissionProposalValidationCoverageReady &&
        admission.goldSchemaGate?.armed === true &&
        admission.goldSchemaGate?.appliesToFormalGoldManifest === true &&
        admission.goldSchemaGate?.rejectsAlphaProfileVariantFields === true &&
        admission.goldSchemaGate?.rejectsUnknownFormalVisibleResidualFields === true &&
        admission.goldSchemaGate?.ok === true &&
        admission.algorithmAdmissionIntegrity?.ok === true &&
        productionGateContractReady &&
        admission.goldManifestIntegrity?.ok === true &&
        admission.goldManifestIntegrity?.exists === goldManifestExists &&
        admission.goldManifestGate?.integrityReady === true &&
        admission.productionProfileAdmission?.allowed === false &&
        (
            validation.readyForGoldMigration === true ||
            (
                admission.productionProfileAdmission?.blockedReasons?.includes('human-review-not-ready-for-gold-migration') &&
                admission.productionProfileAdmission?.blockedReasons?.includes('human-review-unconfirmed-decisions')
            )
        );
    const reviewGuidanceReady = validation.unconfirmedCount === reviewClusters.summary?.unconfirmedCount &&
        reviewProgressReport.inputs?.validationReportSha256 === validationReportSha256 &&
        reviewProgressReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
        reviewProgressReport.inputs?.reviewClusterSha256 === reviewClusterSha256 &&
        reviewProgressReport.summary?.unconfirmedCount === validation.unconfirmedCount &&
        reviewProgressReport.clusterSummary?.clusterTotal === reviewClusters.summary?.clusterTotal &&
        reviewProgressReport.nextReviewClusters?.[0]?.clusterId === topIncompleteCluster(reviewClusters)?.clusterId &&
        reviewProgressReport.reviewBatches?.length === incompleteClusterCount(reviewClusters) &&
        sumBatchIncomplete(reviewProgressReport.reviewBatches) === validation.unconfirmedCount &&
        sumBatchIncomplete(reviewProgressReport.goldCandidateReviewBatches) === validation.goldCandidateUnconfirmedCount &&
        (
            (validation.goldCandidateUnconfirmedCount ?? 0) === 0 ||
            (
                reviewProgressReport.goldCandidateReviewBatches?.length > 0 &&
                reviewProgressReport.nextGoldCandidateReviewBatch?.clusterId === reviewProgressReport.goldCandidateReviewBatches?.[0]?.clusterId
            )
        ) &&
        reviewClusters.summary?.clusterTotal > 0 &&
        (
            validation.readyForGoldMigration === true
                ? validation.unconfirmedCount === 0
                : topIncompleteCluster(reviewClusters) !== null
        );
    const focusedVisibleDecisions = (focusedReviewBatch.decisions ?? [])
        .filter((decision) => decision.sourceSet === 'visibleTopPending');
    const focusedGoldCandidateDecisions = (focusedReviewBatch.decisions ?? [])
        .filter((decision) => decision.sourceSet === 'metricPassVisible');
    const focusedBatchReady = focusedReviewBatch.provenance?.validationReportSha256 === validationReportSha256 &&
        focusedReviewBatch.provenance?.reviewManifestSha256 === reviewManifestSha256 &&
        focusedReviewBatch.provenance?.reviewClusterSha256 === reviewClusterSha256 &&
        focusedReviewBatch.policy?.dryRunCommand === 'pnpm visible-residual:apply-focused-batch --dry-run' &&
        focusedReviewBatch.policy?.applyCommand === 'pnpm visible-residual:apply-focused-batch' &&
        focusedReviewBatch.policy?.validateCommandAfterApply === 'pnpm visible-residual:validate-human-review' &&
        focusedReviewBatch.policy?.writesFormalGoldManifest === false &&
        focusedReviewBatch.policy?.writesProductionAlgorithm === false &&
        focusedReviewBatch.policy?.allowsAlphaProfileProduction === false &&
        focusedReviewBatch.policy?.humanEditableFields?.join('|') === 'humanVerdict|humanConfidence|humanNotes' &&
        focusedReviewBatch.policy?.validHumanVerdicts?.includes('trueVisibleResidual') &&
        focusedReviewBatch.policy?.validHumanVerdicts?.includes('needsModelInvestigation') &&
        focusedReviewBatch.policy?.validHumanConfidence?.join('|') === 'high|medium|low' &&
        focusedReviewBatch.policy?.notesRequiredForVerdicts?.includes('trueVisibleResidual') &&
        focusedReviewBatch.policy?.notesRequiredForVerdicts?.includes('needsModelInvestigation') &&
        focusedReviewBatch.sourceBatches?.visibleResidualBatch?.clusterId ===
            reviewProgressReport.nextReviewBatch?.cluster?.clusterId &&
        focusedReviewBatch.sourceBatches?.goldCandidateBatch?.clusterId ===
            reviewProgressReport.nextGoldCandidateReviewBatch?.clusterId &&
        decisionTargetsMatchItems(focusedVisibleDecisions, reviewProgressReport.nextReviewBatch?.items ?? []) &&
        decisionTargetsMatchItems(focusedGoldCandidateDecisions, reviewProgressReport.nextGoldCandidateReviewBatch?.items ?? []) &&
        (focusedReviewBatch.decisions ?? []).every((decision) => (
            Object.hasOwn(decision, 'humanVerdict') &&
            Object.hasOwn(decision, 'humanConfidence') &&
            Object.hasOwn(decision, 'humanNotes')
        )) &&
        focusedReviewBatch.blockedActions?.some((item) => (
            item.id === 'write-formal-gold-manifest' &&
            item.blocked === true
        )) &&
        focusedReviewBatch.blockedActions?.some((item) => (
            item.id === 'productionize-alpha-profile-variant' &&
            item.blocked === true
        ));
    const reviewHandoffReady = reviewHandoffText.includes(validationReportSha256) &&
        reviewHandoffText.includes(reviewManifestSha256) &&
        reviewHandoffText.includes(reviewClusterSha256) &&
        reviewHandoffText.includes(reviewProgressReport.outputs?.focusedReviewBatchPath ?? 'review-focused-batch.json') &&
        reviewHandoffText.includes('Focused Batch Editing Checklist') &&
        reviewHandoffText.includes('Edit only: humanVerdict, humanConfidence, humanNotes') &&
        reviewHandoffText.includes('humanVerdict allowed values: trueVisibleResidual') &&
        reviewHandoffText.includes('humanConfidence allowed values: high, medium, low') &&
        reviewHandoffText.includes('humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation') &&
        reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch --dry-run') &&
        reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch') &&
        reviewHandoffText.includes('rtk pnpm visible-residual:validate-human-review') &&
        (
            !reviewProgressReport.nextReviewBatch?.cluster?.sheetPath ||
            (
                reviewHandoffText.includes('![Visible residual cluster sheet](') &&
                reviewHandoffText.includes(reviewProgressReport.nextReviewBatch.cluster.sheetPath.replace(/\\/g, '/'))
            )
        ) &&
        (
            !reviewProgressReport.nextGoldCandidateReviewBatch?.sheetPath ||
            (
                reviewHandoffText.includes('![Gold candidate cluster sheet](') &&
                reviewHandoffText.includes(reviewProgressReport.nextGoldCandidateReviewBatch.sheetPath.replace(/\\/g, '/'))
            )
        ) &&
        handoffIncludesDecisionCropPreviews(reviewHandoffText, focusedReviewBatch.decisions ?? []) &&
        reviewHandoffText.includes('writesFormalGoldManifest: false') &&
        reviewHandoffText.includes('writesProductionAlgorithm: false') &&
        reviewHandoffText.includes('allowsAlphaProfileProduction: false');
    const reviewManifestProvenanceReady = humanReviewPackSummary.reviewManifestSha256 === reviewManifestSha256 &&
        humanReviewPackSummary.reviewInputContractSha256 === reviewInputContractSha256 &&
        reviewInputContract.reviewManifestSha256 === reviewManifestSha256 &&
        validation.reviewInputContractSha256 === reviewInputContractSha256 &&
        validation.reviewManifestSha256 === reviewManifestSha256 &&
        humanReviewTemplate.reviewManifestSha256 === reviewManifestSha256 &&
        humanReviewInput.reviewManifestSha256 === reviewManifestSha256 &&
        goldCandidateTemplate.reviewManifestSha256 === reviewManifestSha256 &&
        goldCandidateInput.reviewManifestSha256 === reviewManifestSha256;
    const goldManifestIntegrity = assessGoldManifestIntegrity({
        goldManifest,
        validation,
        reviewManifestSha256,
        validationReportSha256,
        goldProposalSha256,
        alphaSweepSha256,
        profileReportSha256,
        profileGeneralizationSha256
    });
    const noProductionizationReady = productionHits.length === 0 &&
        productionArtifactHits.length === 0 &&
        packageScriptGate.ready === true &&
        (!goldManifestExists || validation.readyForGoldMigration === true) &&
        admission.productionProfileAdmission?.allowed === false;
    const formalGoldReady = validation.readyForGoldMigration === true &&
        goldManifestExists &&
        goldManifestIntegrity.ready;

    return [
        requirement(
            'reproducible-review-artifacts',
            reproducibleReviewReady ? 'satisfied' : 'missing-evidence',
            {
                summaryPath: path.join(paths.artifactDir, 'summary.json'),
                reviewWorksheetPath: path.join(paths.artifactDir, 'human-review-pack/review-worksheet.md'),
                reviewTablePath: path.join(paths.artifactDir, 'human-review-pack/review-table.csv'),
                humanReviewReadmePath: path.join(paths.artifactDir, 'human-review-pack/README.md'),
                humanReviewReadmeSha256,
                humanReviewReadmeReady,
                humanReviewPackArtifactHashesReady,
                reviewWorksheetProvenanceReady,
                reviewTableProvenanceReady,
                expectedValidationReportSha256: validationReportSha256,
                expectedReviewManifestSha256: reviewManifestSha256,
                expectedReviewClusterSha256: reviewClusterSha256,
                manifestSummary: reviewManifest.summary,
                validationPolicy: validation.policy,
                decisionSchemaGate: validation.decisionSchemaGate ?? null
            }
        ),
        requirement(
            'clustered-review-queue',
            groupingReady ? 'satisfied' : 'missing-evidence',
            {
                clusterTotal: reviewClusters.summary?.clusterTotal,
                clusterSheetCount: reviewClusters.summary?.clusterSheetCount,
                totalRecords: reviewClusters.summary?.totalRecords,
                totalReviewDecisions,
                clusterReviewManifestSha256: reviewClusters.inputs?.reviewManifestSha256 ?? null,
                expectedReviewManifestSha256: reviewManifestSha256,
                clusterValidationReportSha256: reviewClusters.inputs?.validationReportSha256 ?? null,
                expectedValidationReportSha256: validationReportSha256,
                clusterWorksheetHasCurrentReviewManifestSha256: clusterReviewWorksheetText.includes(`reviewManifestSha256: \`${reviewManifestSha256}\``),
                clusterWorksheetHasCurrentValidationReportSha256: clusterReviewWorksheetText.includes(`validationReportSha256: \`${validationReportSha256}\``),
                clusterWorksheetHasCurrentReviewClusterSha256: clusterReviewWorksheetText.includes(`reviewClusterSha256: \`${reviewClusterSha256}\``),
                expectedReviewClusterSha256: reviewClusterSha256
            }
        ),
        requirement(
            'proposal-only-gold-candidates',
            goldCandidatesReady ? 'satisfied' : 'missing-evidence',
            {
                readyForHumanConfirmation: goldProposal.summary?.readyForHumanConfirmation,
                pendingHumanReview: goldProposal.summary?.pendingHumanReview,
                pendingTotal: validation.pendingTotal,
                goldCandidateTotal: validation.goldCandidateTotal,
                proposalReviewManifestSha256: goldProposal.inputs?.reviewManifestSha256 ?? null,
                expectedReviewManifestSha256: reviewManifestSha256,
                proposalAlphaSweepSha256: goldProposal.inputs?.alphaSweepSha256 ?? null,
                expectedAlphaSweepSha256: alphaSweepSha256,
                proposalProfileReportSha256: goldProposal.inputs?.profileReportSha256 ?? null,
                expectedProfileReportSha256: profileReportSha256,
                proposalProfileGeneralizationSha256: goldProposal.inputs?.profileGeneralizationSha256 ?? null,
                expectedProfileGeneralizationSha256: profileGeneralizationSha256,
                proposalAlphaSweepReviewManifestSha256:
                    goldProposal.inputs?.alphaSweepReviewManifestSha256 ?? null,
                alphaSweepReviewManifestSha256: alphaSweep.inputs?.reviewManifestSha256 ?? null,
                proposalProfileReportReviewManifestSha256:
                    goldProposal.inputs?.profileReportReviewManifestSha256 ?? null,
                profileReportReviewManifestSha256: profileReport.inputs?.reviewManifestSha256 ?? null,
                proposalProfileGeneralizationReviewManifestSha256:
                    goldProposal.inputs?.profileGeneralizationReviewManifestSha256 ?? null,
                profileGeneralizationReviewManifestSha256: profileGeneralization.inputs?.reviewManifestSha256 ?? null,
                proposalCandidateCount: proposalCandidates.length,
                proposedGoldSchemaGate: goldProposal.proposedGoldSchemaGate ?? null,
                proposalCandidateProvenanceReady,
                admissionProposalCandidateProvenanceReady,
                admissionProposalCandidateProvenance: admission.proposalCandidateProvenance ?? null,
                admissionProposalValidationCoverageReady,
                admissionProposalValidationCoverage: admission.proposalValidationCoverage ?? null,
                missingProposalCandidateClusterId:
                    proposalCandidates.filter((candidate) => typeof candidate.clusterId !== 'string').length,
                missingProposalCandidateSourceSet:
                    proposalCandidates.filter((candidate) => typeof candidate.sourceSet !== 'string').length,
                policy: goldProposal.policy
            }
        ),
        requirement(
            'algorithm-admission-human-gated',
            admissionReady ? 'satisfied' : 'missing-evidence',
            {
                policy: admission.policy,
                productionProfileAdmission: admission.productionProfileAdmission,
                admissionValidationReportSha256: admission.inputs?.validationReportSha256 ?? null,
                expectedValidationReportSha256: validationReportSha256,
                admissionGoldProposalSha256: admission.inputs?.goldProposalSha256 ?? null,
                expectedGoldProposalSha256: goldProposalSha256,
                admissionReviewInputContractSha256: admission.inputs?.reviewInputContractSha256 ?? null,
                expectedReviewInputContractSha256: reviewInputContractSha256,
                validationInputContractIntegrity: admission.validationInputContractIntegrity ?? null,
                validationReadinessIntegrity: admission.validationReadinessIntegrity ?? null,
                validationDecisionSchemaGateIntegrity: admission.validationDecisionSchemaGateIntegrity ?? null,
                proposalInputIntegrity: admission.proposalInputIntegrity ?? null,
                goldSchemaGate: admission.goldSchemaGate ?? null,
                algorithmAdmissionIntegrity: admission.algorithmAdmissionIntegrity ?? null,
                productionGateContractReady,
                goldManifestGate: admission.goldManifestGate ?? null,
                goldManifestIntegrity: admission.goldManifestIntegrity ?? null,
                expectedAlphaSweepSha256: alphaSweepSha256,
                expectedProfileReportSha256: profileReportSha256,
                expectedProfileGeneralizationSha256: profileGeneralizationSha256,
                expectedReviewManifestSha256: reviewManifestSha256
            }
        ),
        requirement(
            'next-review-guidance-is-reproducible',
            reviewGuidanceReady && focusedBatchReady && reviewHandoffReady ? 'satisfied' : 'missing-evidence',
            {
                unconfirmedCount: validation.unconfirmedCount,
                clusterTotal: reviewClusters.summary?.clusterTotal,
                topCluster: topIncompleteCluster(reviewClusters)?.clusterId ?? null,
                progressValidationReportSha256: reviewProgressReport.inputs?.validationReportSha256 ?? null,
                expectedValidationReportSha256: validationReportSha256,
                progressReviewManifestSha256: reviewProgressReport.inputs?.reviewManifestSha256 ?? null,
                expectedReviewManifestSha256: reviewManifestSha256,
                progressReviewClusterSha256: reviewProgressReport.inputs?.reviewClusterSha256 ?? null,
                expectedReviewClusterSha256: reviewClusterSha256,
                progressTopCluster: reviewProgressReport.nextReviewClusters?.[0]?.clusterId ?? null,
                reviewBatchCount: reviewProgressReport.reviewBatches?.length ?? 0,
                reviewBatchTotal: sumBatchIncomplete(reviewProgressReport.reviewBatches),
                goldCandidateReviewBatchCount: reviewProgressReport.goldCandidateReviewBatches?.length ?? 0,
                goldCandidateReviewBatchTotal: sumBatchIncomplete(reviewProgressReport.goldCandidateReviewBatches),
                goldCandidateUnconfirmedCount: validation.goldCandidateUnconfirmedCount ?? 0,
                nextGoldCandidateReviewCluster:
                    reviewProgressReport.nextGoldCandidateReviewBatch?.clusterId ?? null,
                nextGoldCandidateDecisionJsonPath:
                    reviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionJsonPath ?? null,
                focusedReviewBatchSha256,
                focusedBatchReady,
                focusedBatchPolicy: focusedReviewBatch.policy ?? null,
                focusedBatchValidationReportSha256:
                    focusedReviewBatch.provenance?.validationReportSha256 ?? null,
                focusedBatchReviewManifestSha256:
                    focusedReviewBatch.provenance?.reviewManifestSha256 ?? null,
                focusedBatchReviewClusterSha256:
                    focusedReviewBatch.provenance?.reviewClusterSha256 ?? null,
                focusedBatchDecisionCount: focusedReviewBatch.decisions?.length ?? 0,
                focusedVisibleDecisionCount: focusedVisibleDecisions.length,
                focusedGoldCandidateDecisionCount: focusedGoldCandidateDecisions.length,
                focusedVisibleBatchMatchesProgress:
                    decisionTargetsMatchItems(focusedVisibleDecisions, reviewProgressReport.nextReviewBatch?.items ?? []),
                focusedGoldCandidateBatchMatchesProgress:
                    decisionTargetsMatchItems(focusedGoldCandidateDecisions, reviewProgressReport.nextGoldCandidateReviewBatch?.items ?? []),
                focusedBatchBlockedActions: focusedReviewBatch.blockedActions ?? [],
                reviewHandoffSha256,
                reviewHandoffReady,
                humanReviewReadmeSha256,
                humanReviewReadmeReady,
                handoffHasCurrentValidationReportSha256: reviewHandoffText.includes(validationReportSha256),
                handoffHasCurrentReviewManifestSha256: reviewHandoffText.includes(reviewManifestSha256),
                handoffHasCurrentReviewClusterSha256: reviewHandoffText.includes(reviewClusterSha256),
                handoffHasFocusedBatchPath:
                    reviewHandoffText.includes(reviewProgressReport.outputs?.focusedReviewBatchPath ?? 'review-focused-batch.json'),
                handoffHasFocusedBatchChecklist:
                    reviewHandoffText.includes('Focused Batch Editing Checklist'),
                handoffHasEditableFieldGuidance:
                    reviewHandoffText.includes('Edit only: humanVerdict, humanConfidence, humanNotes'),
                handoffHasAllowedVerdictGuidance:
                    reviewHandoffText.includes('humanVerdict allowed values: trueVisibleResidual'),
                handoffHasAllowedConfidenceGuidance:
                    reviewHandoffText.includes('humanConfidence allowed values: high, medium, low'),
                handoffHasRequiredNotesGuidance:
                    reviewHandoffText.includes('humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation'),
                handoffHasDryRunCommand:
                    reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch --dry-run'),
                handoffHasVisibleBatchSheetPreview:
                    !reviewProgressReport.nextReviewBatch?.cluster?.sheetPath ||
                    (
                        reviewHandoffText.includes('![Visible residual cluster sheet](') &&
                        reviewHandoffText.includes(reviewProgressReport.nextReviewBatch.cluster.sheetPath.replace(/\\/g, '/'))
                    ),
                handoffHasGoldCandidateSheetPreview:
                    !reviewProgressReport.nextGoldCandidateReviewBatch?.sheetPath ||
                    (
                        reviewHandoffText.includes('![Gold candidate cluster sheet](') &&
                        reviewHandoffText.includes(reviewProgressReport.nextGoldCandidateReviewBatch.sheetPath.replace(/\\/g, '/'))
                    ),
                handoffHasAllFocusedDecisionCropPreviews:
                    handoffIncludesDecisionCropPreviews(reviewHandoffText, focusedReviewBatch.decisions ?? []),
                handoffHasApplyCommand:
                    reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch'),
                handoffHasValidateCommand:
                    reviewHandoffText.includes('rtk pnpm visible-residual:validate-human-review'),
                handoffHasNoGoldPolicy:
                    reviewHandoffText.includes('writesFormalGoldManifest: false'),
                handoffHasNoProductionPolicy:
                    reviewHandoffText.includes('writesProductionAlgorithm: false') &&
                    reviewHandoffText.includes('allowsAlphaProfileProduction: false')
            }
        ),
        requirement(
            'review-manifest-provenance-is-stable',
            reviewManifestProvenanceReady ? 'satisfied' : 'missing-evidence',
            {
                expectedReviewManifestSha256: reviewManifestSha256,
                summaryReviewManifestSha256: humanReviewPackSummary.reviewManifestSha256,
                summaryReviewInputContractSha256: humanReviewPackSummary.reviewInputContractSha256,
                validationReviewInputContractSha256: validation.reviewInputContractSha256,
                expectedReviewInputContractSha256: reviewInputContractSha256,
                contractReviewManifestSha256: reviewInputContract.reviewManifestSha256,
                validationReviewManifestSha256: validation.reviewManifestSha256,
                templateReviewManifestSha256: humanReviewTemplate.reviewManifestSha256,
                inputReviewManifestSha256: humanReviewInput.reviewManifestSha256,
                goldCandidateTemplateReviewManifestSha256: goldCandidateTemplate.reviewManifestSha256,
                goldCandidateInputReviewManifestSha256: goldCandidateInput.reviewManifestSha256
            }
        ),
        requirement(
            'no-alpha-profile-production-before-human-confirmation',
            noProductionizationReady ? 'satisfied' : 'failed',
            {
                goldManifestPath: path.join(paths.artifactDir, 'gold-manifest.json'),
                goldManifestExists,
                readyForGoldMigration: validation.readyForGoldMigration === true,
                productionProfileAllowed: admission.productionProfileAdmission?.allowed === true,
                productionScanDirs: [...PRODUCTION_DIRS],
                productionScanFilePattern: PRODUCTION_SCAN_FILE_PATTERN.source,
                productionHits,
                productionArtifactHits,
                packageScriptGate
            },
            noProductionizationReady ? [] : ['productionization-gate-violated']
        ),
        requirement(
            'formal-gold-migration',
            validation.readyForGoldMigration === true
                ? (formalGoldReady ? 'satisfied' : 'missing-evidence')
                : 'blocked-by-human-review',
            {
                readyForGoldMigration: validation.readyForGoldMigration === true,
                readyDecisionCount: validation.readyDecisionCount ?? 0,
                totalReviewDecisions,
                unconfirmedCount: validation.unconfirmedCount ?? 0,
                structuralErrorCount: validation.structuralErrorCount ?? 0,
                goldManifestExists,
                goldManifestIntegrity
            },
            formalGoldReady
                ? []
                : (validation.readyForGoldMigration === true
                    ? ['gold-manifest-integrity-not-proven']
                    : ['human-review-not-complete'])
        )
    ];
}

function topIncompleteCluster(reviewClusters) {
    return (reviewClusters.clusters ?? [])
        .map((cluster) => ({
            clusterId: cluster.clusterId,
            count: cluster.count ?? 0,
            incompleteCount: cluster.incompleteCount ?? Math.max(0, (cluster.count ?? 0) - (cluster.readyCount ?? 0))
        }))
        .filter((cluster) => cluster.incompleteCount > 0)
        .sort((left, right) => (
            right.incompleteCount - left.incompleteCount ||
            right.count - left.count ||
            left.clusterId.localeCompare(right.clusterId)
        ))[0] ?? null;
}

function overallStatus(requirements) {
    if (requirements.some((item) => item.status === 'failed')) return 'failed';
    if (requirements.every((item) => item.satisfied)) return 'complete';
    return 'human-gated-incomplete';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.join(args.artifactDir, 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            outputPath: args.outputPath,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:goal-audit.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const paths = {
        root: args.root,
        artifactDir: args.artifactDir,
        outputPath: args.outputPath
    };
    const reviewManifestPath = path.join(args.artifactDir, 'review-manifest.json');
    const reviewClustersPath = path.join(args.artifactDir, 'review-clusters.json');
    const goldProposalPath = path.join(args.artifactDir, 'gold-proposal.json');
    const validationPath = path.join(args.artifactDir, 'human-review-pack/validation-report.json');
    const reviewProgressReportPath = path.join(args.artifactDir, 'human-review-pack/review-progress-report.json');
    const focusedReviewBatchPath = path.join(args.artifactDir, 'human-review-pack/review-focused-batch.json');
    const reviewHandoffPath = path.join(args.artifactDir, 'human-review-pack/review-handoff.md');
    const humanReviewReadmePath = path.join(args.artifactDir, 'human-review-pack/README.md');
    const humanReviewWorksheetPath = path.join(args.artifactDir, 'human-review-pack/review-worksheet.md');
    const humanReviewTablePath = path.join(args.artifactDir, 'human-review-pack/review-table.csv');
    const clusterReviewWorksheetPath = path.join(args.artifactDir, 'human-review-pack/cluster-review-worksheet.md');
    const humanReviewPackSummaryPath = path.join(args.artifactDir, 'human-review-pack/summary.json');
    const reviewInputContractPath = path.join(args.artifactDir, 'human-review-pack/review-input-contract.json');
    const humanReviewTemplatePath = path.join(args.artifactDir, 'human-review-pack/review-decisions.template.json');
    const humanReviewInputPath = path.join(args.artifactDir, 'human-review-pack/review-decisions.json');
    const goldCandidateTemplatePath = path.join(args.artifactDir, 'human-review-pack/gold-candidate-confirmations.template.json');
    const goldCandidateInputPath = path.join(args.artifactDir, 'human-review-pack/gold-candidate-confirmations.json');
    const admissionPath = path.join(args.artifactDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(args.artifactDir, 'gold-manifest.json');
    const alphaSweepPath = path.join(args.artifactDir, 'alpha-sweep/model-investigation-alpha-sweep.json');
    const profileReportPath = path.join(args.artifactDir, 'alpha-profile/model-investigation-alpha-profile.json');
    const profileGeneralizationPath = path.join(args.artifactDir, 'alpha-profile/large-margin-48-profile-candidate.json');
    const packageJsonPath = path.join(args.root, 'package.json');

    const reviewManifestText = stripBom(await readFile(reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const reviewManifest = JSON.parse(reviewManifestText);
    const goldProposalText = stripBom(await readFile(goldProposalPath, 'utf8'));
    const goldProposalSha256 = sha256Text(goldProposalText);
    const validationText = stripBom(await readFile(validationPath, 'utf8'));
    const validationReportSha256 = sha256Text(validationText);
    const reviewClustersText = stripBom(await readFile(reviewClustersPath, 'utf8'));
    const reviewClusterSha256 = sha256Text(reviewClustersText);
    const alphaSweepText = stripBom(await readFile(alphaSweepPath, 'utf8'));
    const alphaSweepSha256 = sha256Text(alphaSweepText);
    const alphaSweep = JSON.parse(alphaSweepText);
    const profileReportText = stripBom(await readFile(profileReportPath, 'utf8'));
    const profileReportSha256 = sha256Text(profileReportText);
    const profileReport = JSON.parse(profileReportText);
    const profileGeneralizationText = stripBom(await readFile(profileGeneralizationPath, 'utf8'));
    const profileGeneralizationSha256 = sha256Text(profileGeneralizationText);
    const profileGeneralization = JSON.parse(profileGeneralizationText);
    const reviewClusters = JSON.parse(reviewClustersText);
    const goldProposal = JSON.parse(goldProposalText);
    const validation = JSON.parse(validationText);
    const reviewProgressReport = await readJson(reviewProgressReportPath);
    const focusedReviewBatchExists = existsSync(focusedReviewBatchPath);
    const focusedReviewBatchText = focusedReviewBatchExists
        ? stripBom(await readFile(focusedReviewBatchPath, 'utf8'))
        : null;
    const focusedReviewBatchSha256 = focusedReviewBatchText ? sha256Text(focusedReviewBatchText) : null;
    const focusedReviewBatch = focusedReviewBatchText ? JSON.parse(focusedReviewBatchText) : {};
    const reviewHandoffExists = existsSync(reviewHandoffPath);
    const reviewHandoffText = reviewHandoffExists
        ? stripBom(await readFile(reviewHandoffPath, 'utf8'))
        : '';
    const reviewHandoffSha256 = reviewHandoffExists ? sha256Text(reviewHandoffText) : null;
    const humanReviewReadmeText = stripBom(await readFile(humanReviewReadmePath, 'utf8'));
    const humanReviewReadmeSha256 = sha256Text(humanReviewReadmeText);
    const humanReviewWorksheetText = stripBom(await readFile(humanReviewWorksheetPath, 'utf8'));
    const humanReviewTableText = stripBom(await readFile(humanReviewTablePath, 'utf8'));
    const clusterReviewWorksheetText = stripBom(await readFile(clusterReviewWorksheetPath, 'utf8'));
    const humanReviewPackSummary = await readJson(humanReviewPackSummaryPath);
    const reviewInputContractText = stripBom(await readFile(reviewInputContractPath, 'utf8'));
    const reviewInputContractSha256 = sha256Text(reviewInputContractText);
    const reviewInputContract = JSON.parse(reviewInputContractText);
    const humanReviewTemplateText = stripBom(await readFile(humanReviewTemplatePath, 'utf8'));
    const humanReviewTemplateSha256 = sha256Text(humanReviewTemplateText);
    const humanReviewTemplate = JSON.parse(humanReviewTemplateText);
    const humanReviewInputText = stripBom(await readFile(humanReviewInputPath, 'utf8'));
    const humanReviewInputSha256 = sha256Text(humanReviewInputText);
    const humanReviewInput = JSON.parse(humanReviewInputText);
    const goldCandidateTemplateText = stripBom(await readFile(goldCandidateTemplatePath, 'utf8'));
    const goldCandidateTemplateSha256 = sha256Text(goldCandidateTemplateText);
    const goldCandidateTemplate = JSON.parse(goldCandidateTemplateText);
    const goldCandidateInputText = stripBom(await readFile(goldCandidateInputPath, 'utf8'));
    const goldCandidateInputSha256 = sha256Text(goldCandidateInputText);
    const goldCandidateInput = JSON.parse(goldCandidateInputText);
    const admission = await readJson(admissionPath);
    const packageJsonText = stripBom(await readFile(packageJsonPath, 'utf8'));
    const packageJsonSha256 = sha256Text(packageJsonText);
    const packageJson = JSON.parse(packageJsonText);
    const packageScriptGate = {
        ...assessVisibleResidualPackageScripts(packageJson),
        packageJsonPath,
        packageJsonSha256
    };
    const goldManifestExists = existsSync(goldManifestPath);
    const goldManifest = goldManifestExists ? await readJson(goldManifestPath) : null;
    const productionHits = await findExperimentalProfileInProduction(args.root);
    const productionArtifactHits = await findForbiddenVisibleResidualArtifactReferences(args.root);
    const groupedSheetArtifactHashesReady = (await Promise.all(
        Object.entries(humanReviewPackSummary.groupedSheets ?? {}).map(async ([profile, sheet]) => (
            humanReviewPackSummary.artifactHashes?.groupedSheets?.[profile]?.outputPath === sheet.outputPath &&
            humanReviewPackSummary.artifactHashes?.groupedSheets?.[profile]?.sha256 === await sha256File(sheet.outputPath)
        ))
    )).every(Boolean);
    const humanReviewPackArtifactHashesReady =
        humanReviewPackSummary.artifactHashes?.readmeSha256 === humanReviewReadmeSha256 &&
        humanReviewPackSummary.artifactHashes?.decisionsTemplateSha256 === humanReviewTemplateSha256 &&
        humanReviewPackSummary.artifactHashes?.decisionsSha256 === humanReviewInputSha256 &&
        humanReviewPackSummary.artifactHashes?.goldCandidateConfirmationsTemplateSha256 === goldCandidateTemplateSha256 &&
        humanReviewPackSummary.artifactHashes?.goldCandidateConfirmationsSha256 === goldCandidateInputSha256 &&
        humanReviewPackSummary.artifactHashes?.reviewInputContractSha256 === reviewInputContractSha256 &&
        humanReviewPackSummary.artifactHashes?.allPendingSheetSha256 === await sha256File(humanReviewPackSummary.allPendingSheet?.outputPath ?? '') &&
        humanReviewPackSummary.artifactHashes?.goldCandidateSheetSha256 === await sha256File(humanReviewPackSummary.goldCandidateSheet?.outputPath ?? '') &&
        groupedSheetArtifactHashesReady;
    const requirements = buildRequirements({
        paths,
        reviewManifest,
        reviewClusters,
        goldProposal,
        validationReportSha256,
        goldProposalSha256,
        alphaSweepSha256,
        profileReportSha256,
        profileGeneralizationSha256,
        alphaSweep,
        profileReport,
        profileGeneralization,
        validation,
        humanReviewPackSummary,
        reviewInputContract,
        reviewInputContractSha256,
        humanReviewTemplate,
        humanReviewInput,
        goldCandidateTemplate,
        goldCandidateInput,
        humanReviewPackArtifactHashesReady,
        reviewProgressReport,
        focusedReviewBatch,
        focusedReviewBatchSha256,
        reviewHandoffText,
        reviewHandoffSha256,
        humanReviewReadmeText,
        humanReviewReadmeSha256,
        humanReviewWorksheetText,
        humanReviewTableText,
        clusterReviewWorksheetText,
        reviewManifestSha256,
        reviewClusterSha256,
        admission,
        goldManifest,
        goldManifestExists,
        productionHits,
        productionArtifactHits,
        packageScriptGate
    });
    const report = {
        generatedAt: new Date().toISOString(),
        objective: '建立 visible residual 的可复现审阅、分组、gold 候选和算法准入闭环；在没有人工确认前，不把任何 alpha/profile 变体生产化。',
        status: overallStatus(requirements),
        policy: {
            reportOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            requiresHumanConfirmationBeforeGoldMigration: true,
            requiresHumanConfirmationBeforeProductionProfile: true
        },
        inputs: {
            reviewManifestPath,
            reviewClustersPath,
            goldProposalPath,
            validationPath,
            reviewProgressReportPath,
            focusedReviewBatchPath,
            reviewHandoffPath,
            humanReviewReadmePath,
            humanReviewWorksheetPath,
            humanReviewTablePath,
            clusterReviewWorksheetPath,
            admissionPath,
            alphaSweepPath,
            profileReportPath,
            profileGeneralizationPath,
            packageJsonPath,
            packageJsonSha256
        },
        summary: {
            readyForGoldMigration: validation.readyForGoldMigration === true,
            totalReviewDecisions: (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0),
            readyDecisionCount: validation.readyDecisionCount ?? 0,
            unconfirmedCount: validation.unconfirmedCount ?? 0,
            structuralErrorCount: validation.structuralErrorCount ?? 0,
            reviewManifestSha256,
            clusterTotal: reviewClusters.summary?.clusterTotal ?? 0,
            topReviewCluster: topIncompleteCluster(reviewClusters)?.clusterId ?? null,
            reviewBatchCount: reviewProgressReport.reviewBatches?.length ?? 0,
            reviewBatchTotal: sumBatchIncomplete(reviewProgressReport.reviewBatches),
            focusedReviewBatchSha256,
            focusedReviewBatchDecisionCount: focusedReviewBatch.decisions?.length ?? 0,
            reviewHandoffSha256,
            humanReviewReadmeSha256,
            humanReviewPackArtifactHashesReady,
            goldCandidateUnconfirmedCount: validation.goldCandidateUnconfirmedCount ?? 0,
            goldCandidateReviewBatchCount: reviewProgressReport.goldCandidateReviewBatches?.length ?? 0,
            goldCandidateReviewBatchTotal: sumBatchIncomplete(reviewProgressReport.goldCandidateReviewBatches),
            nextGoldCandidateReviewCluster:
                reviewProgressReport.nextGoldCandidateReviewBatch?.clusterId ?? null,
            goldManifestExists,
            goldManifestIntegrityReady: assessGoldManifestIntegrity({
                goldManifest,
                validation,
                reviewManifestSha256,
                validationReportSha256,
                goldProposalSha256,
                alphaSweepSha256,
                profileReportSha256,
                profileGeneralizationSha256
            }).ready,
            productionProfileAllowed: admission.productionProfileAdmission?.allowed === true,
            productionHitCount: productionHits.length,
            productionArtifactHitCount: productionArtifactHits.length,
            packageScriptGateReady: packageScriptGate.ready === true,
            visibleResidualPackageScriptCount: packageScriptGate.visibleResidualScriptCount,
            forbiddenVisibleResidualPackageScriptCount:
                packageScriptGate.forbiddenVisibleResidualPackageScripts.length,
            unclassifiedVisibleResidualPackageScriptCount:
                packageScriptGate.unclassifiedVisibleResidualScripts.length,
            packageJsonSha256
        },
        requirements,
        blockers: requirements.flatMap((item) => item.blockers)
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        status: report.status,
        summary: report.summary,
        blockers: report.blockers
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
