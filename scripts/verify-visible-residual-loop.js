import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = path.resolve('.');
const DEFAULT_ARTIFACT_DIR = path.resolve('.artifacts/visible-residual-crops/latest');
const REQUIRED_ARTIFACTS = Object.freeze([
    'summary.json',
    'metricPassVisible.png',
    'visibleTop.png',
    'positiveHalo.png',
    'gradientResidual.png',
    'spatialResidual.png',
    'review-manifest.json',
    'review-clusters.json',
    'review-queues/modelInvestigation.png',
    'review-queues/goldToleranceDiscussion.png',
    'review-queues/humanReviewNext.png',
    'alpha-sweep/model-investigation-alpha-sweep.json',
    'alpha-profile/model-investigation-alpha-profile.json',
    'alpha-profile/model-investigation-alpha-profile.png',
    'alpha-profile/large-margin-48-profile-candidate.json',
    'alpha-profile/large-margin-48-profile-candidate.png',
    'alpha-profile/geometry-family-48-96-96-alpha-profile.json',
    'alpha-profile/geometry-family-48-96-96-alpha-profile.png',
    'alpha-profile/geometry-family-48-96-96-alpha-profile-sheet.json',
    'alpha-profile/geometry-family-48-96-96-reference-boundary.json',
    'alpha-profile/geometry-family-48-96-96-reference-boundary.png',
    'alpha-profile/geometry-family-48-96-96-reference-boundary-sheet.json',
    'alpha-profile/geometry-family-48-96-96-goal-audit.json',
    'gold-proposal.json',
    'algorithm-admission-report.json',
    'goal-audit-report.json',
    'loop-summary.json',
    'human-review-pack/summary.json',
    'human-review-pack/README.md',
    'human-review-pack/all-pending.png',
    'human-review-pack/gold-candidates.png',
    'human-review-pack/review-decisions.template.json',
    'human-review-pack/review-decisions.json',
    'human-review-pack/gold-candidate-confirmations.template.json',
    'human-review-pack/gold-candidate-confirmations.json',
    'human-review-pack/review-input-contract.json',
    'human-review-pack/validation-report.json',
    'human-review-pack/review-worksheet.md',
    'human-review-pack/review-table.csv',
    'human-review-pack/review-progress-report.json',
    'human-review-pack/review-checkpoint.json',
    'human-review-pack/review-focused-batch.json',
    'human-review-pack/review-handoff.md',
    'human-review-pack/cluster-review-worksheet.md',
    'human-review-pack/by-cluster',
    'human-review-pack/by-profile/48px-large-margin.png',
    'human-review-pack/by-profile/45px-other.png',
    'human-review-pack/by-profile/48px-standard-margin.png',
    'human-review-pack/by-profile/46px-other.png',
    'human-review-pack/by-profile/96px-large-margin.png',
    'human-review-pack/by-profile/47px-other.png'
]);
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
        root: DEFAULT_ROOT,
        artifactDir: DEFAULT_ARTIFACT_DIR,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--root') {
            parsed.root = path.resolve(args.shift() || parsed.root);
            continue;
        }
        if (arg === '--artifact-dir') {
            parsed.artifactDir = path.resolve(args.shift() || parsed.artifactDir);
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

function assertCondition(checks, condition, name, details = {}) {
    checks.push({
        name,
        ok: Boolean(condition),
        details
    });
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
            target.suggestedConfidence === item.suggestedConfidence &&
            JSON.stringify(target.problems ?? []) === JSON.stringify(item.problems ?? []) &&
            existsSync(target.cropPath ?? '')
        );
    });
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

async function runReviewProgressReport({ scriptPath, manifestPath, validationPath, clusterPath }) {
    const { stdout } = await execFileAsync(process.execPath, [
        scriptPath,
        '--manifest', manifestPath,
        '--validation', validationPath,
        '--clusters', clusterPath,
        '--limit', '8',
        '--allow-active-loop-state'
    ], {
        maxBuffer: 5 * 1024 * 1024
    });
    return JSON.parse(stripBom(stdout));
}

function expectedIncompleteByCluster(clusterReport) {
    return Object.fromEntries(
        sortedIncompleteClusters(clusterReport)
            .map((cluster) => [cluster.clusterId, cluster.incompleteCount])
    );
}

function sortedIncompleteClusters(clusterReport) {
    return (clusterReport.clusters ?? [])
        .map((cluster) => ({
            clusterId: cluster.clusterId,
            sourceSet: cluster.sourceSet,
            count: cluster.count ?? 0,
            incompleteCount: cluster.incompleteCount ?? Math.max(0, (cluster.count ?? 0) - (cluster.readyCount ?? 0))
        }))
        .filter((cluster) => cluster.incompleteCount > 0)
        .sort((left, right) => (
            right.incompleteCount - left.incompleteCount ||
            right.count - left.count ||
            left.clusterId.localeCompare(right.clusterId)
        ));
}

function firstCsvRecord(csvText) {
    const lines = csvText.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length < 2) return {};
    const headers = lines[0].split(',');
    const values = lines[1].split(',');
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
}

function markdownEscapedText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ');
}

function flattenReviewManifestRecords(reviewManifest) {
    return Object.values(reviewManifest?.groups ?? {})
        .filter(Array.isArray)
        .flat();
}

function countProfileLineRecords(reviewManifest, profileLine) {
    return flattenReviewManifestRecords(reviewManifest)
        .filter((record) => record.review?.profileLine === profileLine)
        .length;
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

function resolveArtifactPath(root, filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    return path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
}

function addVisualPathRef(refs, { source, file = null, pathKind, filePath }, root) {
    const resolvedPath = resolveArtifactPath(root, filePath);
    if (!resolvedPath) return;
    refs.push({
        source,
        file,
        pathKind,
        filePath,
        resolvedPath
    });
}

function collectReviewVisualPathRefs({
    root,
    reviewManifest,
    reviewClusterReport,
    humanReviewTemplate,
    humanReviewInput,
    goldCandidateConfirmationTemplate,
    goldCandidateConfirmationInput,
    reviewProgressReport,
    humanReviewProgressReport,
    humanReviewCheckpoint,
    focusedReviewBatch
}) {
    const refs = [];
    for (const sourceSet of ['visibleTopPending', 'metricPassVisible']) {
        for (const record of reviewManifest.groups?.[sourceSet] ?? []) {
            addVisualPathRef(refs, {
                source: `reviewManifest.groups.${sourceSet}`,
                file: record.file,
                pathKind: 'cropPath',
                filePath: record.cropPath
            }, root);
        }
    }
    for (const [source, decisions] of [
        ['humanReviewTemplate.decisions', humanReviewTemplate.decisions],
        ['humanReviewInput.decisions', humanReviewInput.decisions],
        ['goldCandidateConfirmationTemplate.decisions', goldCandidateConfirmationTemplate.decisions],
        ['goldCandidateConfirmationInput.decisions', goldCandidateConfirmationInput.decisions]
    ]) {
        for (const decision of decisions ?? []) {
            addVisualPathRef(refs, {
                source,
                file: decision.file,
                pathKind: 'cropPath',
                filePath: decision.cropPath
            }, root);
        }
    }
    for (const cluster of reviewClusterReport.clusters ?? []) {
        addVisualPathRef(refs, {
            source: `reviewClusterReport.clusters.${cluster.clusterId}`,
            pathKind: 'sheetPath',
            filePath: cluster.sheet?.outputPath ?? cluster.sheetPath
        }, root);
        for (const file of cluster.files ?? []) {
            addVisualPathRef(refs, {
                source: `reviewClusterReport.clusters.${cluster.clusterId}.files`,
                file: file.file,
                pathKind: 'cropPath',
                filePath: file.cropPath
            }, root);
        }
    }
    for (const [source, report] of [
        ['reviewProgressReport', reviewProgressReport],
        ['humanReviewProgressReport', humanReviewProgressReport]
    ]) {
        for (const cluster of report.nextReviewClusters ?? []) {
            addVisualPathRef(refs, {
                source: `${source}.nextReviewClusters`,
                file: cluster.firstFile,
                pathKind: 'sheetPath',
                filePath: cluster.sheetPath
            }, root);
            addVisualPathRef(refs, {
                source: `${source}.nextReviewClusters`,
                file: cluster.firstFile,
                pathKind: 'firstCropPath',
                filePath: cluster.firstCropPath
            }, root);
        }
        for (const item of [
            ...(report.nextReviewItems ?? []),
            ...(report.nextReviewBatch?.items ?? []),
            ...(report.reviewBatches ?? []).flatMap((batch) => batch.items ?? [])
        ]) {
            addVisualPathRef(refs, {
                source,
                file: item.file,
                pathKind: 'cropPath',
                filePath: item.cropPath
            }, root);
        }
    }
    for (const [source, batch] of [
        ['humanReviewCheckpoint.nextReviewRound.visibleResidualBatch', humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch],
        ['humanReviewCheckpoint.nextReviewRound.goldCandidateBatch', humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch],
        ['focusedReviewBatch.sourceBatches.visibleResidualBatch', focusedReviewBatch.sourceBatches?.visibleResidualBatch],
        ['focusedReviewBatch.sourceBatches.goldCandidateBatch', focusedReviewBatch.sourceBatches?.goldCandidateBatch]
    ]) {
        if (!batch) continue;
        addVisualPathRef(refs, {
            source,
            file: batch.firstFile,
            pathKind: 'sheetPath',
            filePath: batch.sheetPath
        }, root);
        addVisualPathRef(refs, {
            source,
            file: batch.firstFile,
            pathKind: 'firstCropPath',
            filePath: batch.firstCropPath
        }, root);
        for (const item of batch.decisionTargets ?? []) {
            addVisualPathRef(refs, {
                source,
                file: item.file,
                pathKind: 'cropPath',
                filePath: item.cropPath
            }, root);
        }
    }
    for (const item of focusedReviewBatch.decisions ?? []) {
        addVisualPathRef(refs, {
            source: 'focusedReviewBatch.decisions',
            file: item.file,
            pathKind: 'cropPath',
            filePath: item.cropPath
        }, root);
    }
    return refs;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.join(args.artifactDir, 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        const report = {
            generatedAt: new Date().toISOString(),
            artifactDir: args.artifactDir,
            ok: false,
            totalChecks: 1,
            failedChecks: 1,
            checks: [
                {
                    name: 'visible residual loop is not actively rewriting artifacts',
                    ok: false,
                    details: {
                        loopRunStatePath,
                        activeLoopRunState,
                        remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:verify.'
                    }
                }
            ]
        };
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = 1;
        return;
    }
    const checks = [];
    for (const relativePath of REQUIRED_ARTIFACTS) {
        const artifactPath = path.join(args.artifactDir, relativePath);
        assertCondition(checks, existsSync(artifactPath), `artifact exists: ${relativePath}`, { artifactPath });
    }

    const renderSummaryPath = path.join(args.artifactDir, 'summary.json');
    const reviewQueueSummaryPath = path.join(args.artifactDir, 'review-queues/summary.json');
    const reviewManifestPath = path.join(args.artifactDir, 'review-manifest.json');
    const reviewClusterReportPath = path.join(args.artifactDir, 'review-clusters.json');
    const goldProposalPath = path.join(args.artifactDir, 'gold-proposal.json');
    const admissionReportPath = path.join(args.artifactDir, 'algorithm-admission-report.json');
    const goalAuditReportPath = path.join(args.artifactDir, 'goal-audit-report.json');
    const loopSummaryPath = path.join(args.artifactDir, 'loop-summary.json');
    const alphaSweepPath = path.join(args.artifactDir, 'alpha-sweep/model-investigation-alpha-sweep.json');
    const profileReportPath = path.join(args.artifactDir, 'alpha-profile/model-investigation-alpha-profile.json');
    const profileGeneralizationPath = path.join(args.artifactDir, 'alpha-profile/large-margin-48-profile-candidate.json');
    const geometryFamilyProfilePath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-alpha-profile.json');
    const geometryFamilyProfileSheetPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-alpha-profile-sheet.json');
    const referenceBoundaryPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-reference-boundary.json');
    const referenceBoundarySheetPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-reference-boundary-sheet.json');
    const geometryFamilyGoalAuditPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-goal-audit.json');
    const humanReviewPackSummaryPath = path.join(args.artifactDir, 'human-review-pack/summary.json');
    const humanReviewReadmePath = path.join(args.artifactDir, 'human-review-pack/README.md');
    const humanReviewTemplatePath = path.join(args.artifactDir, 'human-review-pack/review-decisions.template.json');
    const humanReviewInputPath = path.join(args.artifactDir, 'human-review-pack/review-decisions.json');
    const goldCandidateConfirmationTemplatePath = path.join(args.artifactDir, 'human-review-pack/gold-candidate-confirmations.template.json');
    const goldCandidateConfirmationInputPath = path.join(args.artifactDir, 'human-review-pack/gold-candidate-confirmations.json');
    const reviewInputContractPath = path.join(args.artifactDir, 'human-review-pack/review-input-contract.json');
    const humanReviewValidationPath = path.join(args.artifactDir, 'human-review-pack/validation-report.json');
    const humanReviewWorksheetPath = path.join(args.artifactDir, 'human-review-pack/review-worksheet.md');
    const humanReviewTablePath = path.join(args.artifactDir, 'human-review-pack/review-table.csv');
    const humanReviewProgressReportPath = path.join(args.artifactDir, 'human-review-pack/review-progress-report.json');
    const humanReviewCheckpointPath = path.join(args.artifactDir, 'human-review-pack/review-checkpoint.json');
    const focusedReviewBatchPath = path.join(args.artifactDir, 'human-review-pack/review-focused-batch.json');
    const reviewHandoffPath = path.join(args.artifactDir, 'human-review-pack/review-handoff.md');
    const clusterReviewWorksheetPath = path.join(args.artifactDir, 'human-review-pack/cluster-review-worksheet.md');
    const runVisibleResidualLoopScriptPath = path.join(args.root, 'scripts/run-visible-residual-loop.js');
    const reviewProgressScriptPath = path.join(args.root, 'scripts/report-visible-residual-review-progress.js');
    const applyFocusedBatchScriptPath = path.join(args.root, 'scripts/apply-visible-residual-focused-review-batch.js');
    const reviewWorksheetScriptPath = path.join(args.root, 'scripts/create-visible-residual-review-worksheet.js');
    const clusterReportScriptPath = path.join(args.root, 'scripts/create-visible-residual-cluster-report.js');
    const validateHumanReviewScriptPath = path.join(args.root, 'scripts/validate-visible-residual-human-review.js');
    const goldProposalScriptPath = path.join(args.root, 'scripts/create-visible-residual-gold-proposal.js');
    const admissionReportScriptPath = path.join(args.root, 'scripts/create-visible-residual-admission-report.js');
    const goalAuditScriptPath = path.join(args.root, 'scripts/create-visible-residual-goal-audit-report.js');
    const goldManifestScriptPath = path.join(args.root, 'scripts/create-visible-residual-gold-manifest.js');
    const visibleResidualGoldManifestPath = path.join(args.artifactDir, 'gold-manifest.json');
    const renderSummaryText = stripBom(await readFile(renderSummaryPath, 'utf8'));
    const renderSummarySha256 = sha256Text(renderSummaryText);
    const reviewManifestText = stripBom(await readFile(reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const reviewManifest = JSON.parse(reviewManifestText);
    const reviewQueueSummary = await readJson(reviewQueueSummaryPath);
    const reviewClusterReportText = stripBom(await readFile(reviewClusterReportPath, 'utf8'));
    const reviewClusterReportSha256 = sha256Text(reviewClusterReportText);
    const reviewClusterReport = JSON.parse(reviewClusterReportText);
    const goldProposalText = stripBom(await readFile(goldProposalPath, 'utf8'));
    const goldProposalSha256 = sha256Text(goldProposalText);
    const goldProposal = JSON.parse(goldProposalText);
    const admissionReportText = stripBom(await readFile(admissionReportPath, 'utf8'));
    const admissionReportSha256 = sha256Text(admissionReportText);
    const admissionReport = JSON.parse(admissionReportText);
    const admissionReportScript = await readFile(admissionReportScriptPath, 'utf8');
    const goalAuditReportText = stripBom(await readFile(goalAuditReportPath, 'utf8'));
    const goalAuditReportSha256 = sha256Text(goalAuditReportText);
    const goalAuditReport = JSON.parse(goalAuditReportText);
    const loopSummary = await readJson(loopSummaryPath);
    const loopSourceSummaryText = stripBom(await readFile(loopSummary.sourceSummaryPath, 'utf8'));
    const loopSourceSummarySha256 = sha256Text(loopSourceSummaryText);
    const alphaSweepText = stripBom(await readFile(alphaSweepPath, 'utf8'));
    const alphaSweep = JSON.parse(alphaSweepText);
    const profileReportText = stripBom(await readFile(profileReportPath, 'utf8'));
    const profileReport = JSON.parse(profileReportText);
    const profileGeneralizationText = stripBom(await readFile(profileGeneralizationPath, 'utf8'));
    const profileGeneralization = JSON.parse(profileGeneralizationText);
    const geometryFamilyProfileText = stripBom(await readFile(geometryFamilyProfilePath, 'utf8'));
    const geometryFamilyProfileSha256 = sha256Text(geometryFamilyProfileText);
    const geometryFamilyProfile = JSON.parse(geometryFamilyProfileText);
    const geometryFamilyProfileSheet = await readJson(geometryFamilyProfileSheetPath);
    const referenceBoundaryText = stripBom(await readFile(referenceBoundaryPath, 'utf8'));
    const referenceBoundarySha256 = sha256Text(referenceBoundaryText);
    const referenceBoundary = JSON.parse(referenceBoundaryText);
    const referenceBoundarySheet = await readJson(referenceBoundarySheetPath);
    const geometryFamilyGoalAudit = await readJson(geometryFamilyGoalAuditPath);
    const humanReviewPackSummary = await readJson(humanReviewPackSummaryPath);
    const humanReviewPackSummaryText = stripBom(await readFile(humanReviewPackSummaryPath, 'utf8'));
    const humanReviewPackSummarySha256 = sha256Text(humanReviewPackSummaryText);
    const humanReviewReadmeText = stripBom(await readFile(humanReviewReadmePath, 'utf8'));
    const humanReviewReadmeSha256 = sha256Text(humanReviewReadmeText);
    const humanReviewTemplateText = stripBom(await readFile(humanReviewTemplatePath, 'utf8'));
    const humanReviewTemplateSha256 = sha256Text(humanReviewTemplateText);
    const humanReviewTemplate = JSON.parse(humanReviewTemplateText);
    const humanReviewInputText = stripBom(await readFile(humanReviewInputPath, 'utf8'));
    const humanReviewInputSha256 = sha256Text(humanReviewInputText);
    const humanReviewInput = JSON.parse(humanReviewInputText);
    const goldCandidateConfirmationTemplateText = stripBom(await readFile(goldCandidateConfirmationTemplatePath, 'utf8'));
    const goldCandidateConfirmationTemplateSha256 = sha256Text(goldCandidateConfirmationTemplateText);
    const goldCandidateConfirmationTemplate = JSON.parse(goldCandidateConfirmationTemplateText);
    const goldCandidateConfirmationInputText = stripBom(await readFile(goldCandidateConfirmationInputPath, 'utf8'));
    const goldCandidateConfirmationInputSha256 = sha256Text(goldCandidateConfirmationInputText);
    const goldCandidateConfirmationInput = JSON.parse(goldCandidateConfirmationInputText);
    const reviewInputContractText = stripBom(await readFile(reviewInputContractPath, 'utf8'));
    const reviewInputContractSha256 = sha256Text(reviewInputContractText);
    const reviewInputContract = JSON.parse(reviewInputContractText);
    const humanReviewValidationText = stripBom(await readFile(humanReviewValidationPath, 'utf8'));
    const humanReviewValidationSha256 = sha256Text(humanReviewValidationText);
    const humanReviewValidation = JSON.parse(humanReviewValidationText);
    const humanReviewProgressReportText = stripBom(await readFile(humanReviewProgressReportPath, 'utf8'));
    const humanReviewProgressReportSha256 = sha256Text(humanReviewProgressReportText);
    const humanReviewProgressReport = JSON.parse(humanReviewProgressReportText);
    const humanReviewCheckpointText = stripBom(await readFile(humanReviewCheckpointPath, 'utf8'));
    const humanReviewCheckpointSha256 = sha256Text(humanReviewCheckpointText);
    const humanReviewCheckpoint = JSON.parse(humanReviewCheckpointText);
    const focusedReviewBatchText = stripBom(await readFile(focusedReviewBatchPath, 'utf8'));
    const focusedReviewBatchSha256 = sha256Text(focusedReviewBatchText);
    const focusedReviewBatch = JSON.parse(focusedReviewBatchText);
    const reviewHandoffText = stripBom(await readFile(reviewHandoffPath, 'utf8'));
    const reviewHandoffSha256 = sha256Text(reviewHandoffText);
    const humanReviewWorksheet = await readFile(humanReviewWorksheetPath, 'utf8');
    const humanReviewWorksheetSha256 = sha256Text(stripBom(humanReviewWorksheet));
    const humanReviewTable = await readFile(humanReviewTablePath, 'utf8');
    const humanReviewTableSha256 = sha256Text(stripBom(humanReviewTable));
    const clusterReviewWorksheet = await readFile(clusterReviewWorksheetPath, 'utf8');
    const clusterReviewWorksheetSha256 = sha256Text(stripBom(clusterReviewWorksheet));
    const firstHumanReviewTableRecord = firstCsvRecord(humanReviewTable);
    const runVisibleResidualLoopScript = await readFile(runVisibleResidualLoopScriptPath, 'utf8');
    const reviewProgressScript = await readFile(reviewProgressScriptPath, 'utf8');
    const applyFocusedBatchScript = await readFile(applyFocusedBatchScriptPath, 'utf8');
    const reviewWorksheetScript = await readFile(reviewWorksheetScriptPath, 'utf8');
    const clusterReportScript = await readFile(clusterReportScriptPath, 'utf8');
    const validateHumanReviewScript = await readFile(validateHumanReviewScriptPath, 'utf8');
    const goldProposalScript = await readFile(goldProposalScriptPath, 'utf8');
    const goalAuditScript = await readFile(goalAuditScriptPath, 'utf8');
    const goldManifestScript = await readFile(goldManifestScriptPath, 'utf8');
    const packageJsonPath = path.join(args.root, 'package.json');
    const packageJsonText = stripBom(await readFile(packageJsonPath, 'utf8'));
    const packageJsonSha256 = sha256Text(packageJsonText);
    const packageJson = JSON.parse(packageJsonText);
    const packageScriptGate = {
        ...assessVisibleResidualPackageScripts(packageJson),
        packageJsonPath,
        packageJsonSha256
    };
    const reviewProgressReport = await runReviewProgressReport({
        scriptPath: reviewProgressScriptPath,
        manifestPath: reviewManifestPath,
        validationPath: humanReviewValidationPath,
        clusterPath: reviewClusterReportPath
    });
    const reviewVisualPathRefs = collectReviewVisualPathRefs({
        root: args.root,
        reviewManifest,
        reviewClusterReport,
        humanReviewTemplate,
        humanReviewInput,
        goldCandidateConfirmationTemplate,
        goldCandidateConfirmationInput,
        reviewProgressReport,
        humanReviewProgressReport,
        humanReviewCheckpoint,
        focusedReviewBatch
    });
    const missingReviewVisualPathRefs = reviewVisualPathRefs.filter((ref) => !existsSync(ref.resolvedPath));
    const expectedSortedIncompleteClusters = sortedIncompleteClusters(reviewClusterReport);
    const expectedIncompleteDecisionTotal = Object.values(expectedIncompleteByCluster(reviewClusterReport))
        .reduce((sum, count) => sum + count, 0);
    const expectedGoldCandidateClusters = expectedSortedIncompleteClusters
        .filter((cluster) => cluster.sourceSet === 'metricPassVisible');
    const expectedGoldCandidateDecisionTotal = expectedGoldCandidateClusters
        .reduce((sum, cluster) => sum + cluster.incompleteCount, 0);
    const topReviewClusterId = sortedIncompleteClusters(reviewClusterReport)[0]?.clusterId ?? null;
    const topReviewCluster = (reviewClusterReport.clusters ?? []).find((cluster) => cluster.clusterId === topReviewClusterId) ?? null;
    const topReviewBatchItem = humanReviewProgressReport.nextReviewBatch?.items?.[0] ?? null;

    assertCondition(
        checks,
        reviewManifest.inputs?.renderSummarySha256 === renderSummarySha256 &&
            reviewManifest.inputs?.renderSummaryPath === renderSummaryPath,
        'review manifest records current render summary provenance',
        {
            manifestInputs: reviewManifest.inputs,
            expectedRenderSummaryPath: renderSummaryPath,
            expectedRenderSummarySha256: renderSummarySha256
        }
    );
    assertCondition(
        checks,
        reviewQueueSummary.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            reviewQueueSummary.inputs?.reviewManifestPath === reviewManifestPath,
        'review queue summary records current review manifest provenance',
        {
            queueInputs: reviewQueueSummary.inputs,
            expectedReviewManifestPath: reviewManifestPath,
            expectedReviewManifestSha256: reviewManifestSha256
        }
    );
    assertCondition(
        checks,
        reviewManifest.summary?.metricPassVisibleReviewed === 6,
        'review manifest has 6 metricPassVisible reviews',
        { actual: reviewManifest.summary?.metricPassVisibleReviewed }
    );
    assertCondition(
        checks,
        reviewManifest.summary?.visibleTopPending === reviewManifest.groups?.visibleTopPending?.length &&
            reviewManifest.summary?.visibleTopPending > 0,
        'review manifest visibleTop pending count matches current filtered records',
        {
            actual: reviewManifest.summary?.visibleTopPending,
            records: reviewManifest.groups?.visibleTopPending?.length
        }
    );
    assertCondition(
        checks,
        reviewManifest.workQueues?.modelInvestigation?.length === 3,
        'model investigation queue has 3 records',
        { actual: reviewManifest.workQueues?.modelInvestigation?.length }
    );
    assertCondition(
        checks,
        reviewManifest.workQueues?.goldToleranceDiscussion?.length === 3,
        'gold tolerance queue has 3 records',
        { actual: reviewManifest.workQueues?.goldToleranceDiscussion?.length }
    );
    assertCondition(
        checks,
        reviewClusterReport.policy?.readOnly === true &&
            reviewClusterReport.policy?.writesFormalGoldManifest === false &&
            reviewClusterReport.policy?.writesProductionAlgorithm === false &&
            reviewClusterReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            reviewClusterReport.inputs?.validationReportSha256 === humanReviewValidationSha256,
        'review cluster report is read-only',
        {
            policy: reviewClusterReport.policy,
            clusterInputs: reviewClusterReport.inputs,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedValidationReportSha256: humanReviewValidationSha256
        }
    );
    assertCondition(
        checks,
        reviewClusterReport.summary?.totalRecords ===
            (reviewManifest.summary?.visibleTopPending ?? 0) + (reviewManifest.summary?.metricPassVisibleReviewed ?? 0) &&
            reviewClusterReport.summary?.sourceSetCounts?.visibleTopPending === reviewManifest.summary?.visibleTopPending &&
            reviewClusterReport.summary?.sourceSetCounts?.metricPassVisible === reviewManifest.summary?.metricPassVisibleReviewed,
        'review cluster report covers all pending and gold candidate records',
        {
            clusterSummary: reviewClusterReport.summary,
            manifestSummary: reviewManifest.summary
        }
    );
    assertCondition(
        checks,
        reviewClusterReport.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            reviewClusterReport.summary?.structuralErrorCount === humanReviewValidation.structuralErrorCount &&
            (reviewClusterReport.clusters ?? []).every((cluster) => (
                typeof cluster.clusterId === 'string' &&
                typeof cluster.profileLine === 'string' &&
                Array.isArray(cluster.visibleReasons) &&
                Array.isArray(cluster.files)
            )),
        'review cluster report mirrors human validation and has stable cluster records',
        {
            clusterTotal: reviewClusterReport.summary?.clusterTotal,
            unconfirmedCount: reviewClusterReport.summary?.unconfirmedCount,
            validationUnconfirmedCount: humanReviewValidation.unconfirmedCount
        }
    );
    assertCondition(
        checks,
        reviewClusterReport.summary?.clusterSheetCount === reviewClusterReport.summary?.clusterTotal &&
            (reviewClusterReport.clusters ?? []).every((cluster) => (
                cluster.sheet?.outputPath &&
                existsSync(cluster.sheet.outputPath) &&
                cluster.sheet.count === cluster.count
            )),
        'review cluster report has one visual sheet per cluster',
        {
            clusterSheetCount: reviewClusterReport.summary?.clusterSheetCount,
            clusterTotal: reviewClusterReport.summary?.clusterTotal,
            clusterSheetDir: reviewClusterReport.summary?.clusterSheetDir
        }
    );
    assertCondition(
        checks,
        reviewVisualPathRefs.length > 0 && missingReviewVisualPathRefs.length === 0,
        'review manifest, decisions, clusters, and progress reports reference existing visual crops and sheets',
        {
            totalVisualPathRefs: reviewVisualPathRefs.length,
            missingVisualPathCount: missingReviewVisualPathRefs.length,
            missingVisualPathExamples: missingReviewVisualPathRefs.slice(0, 8)
        }
    );
    assertCondition(
        checks,
            clusterReviewWorksheet.includes('Visible Residual Cluster Review Worksheet') &&
            clusterReviewWorksheet.includes('Edit `review-decisions.json` and `gold-candidate-confirmations.json`, not this file.') &&
            clusterReviewWorksheet.includes(`reviewManifestSha256: \`${reviewManifestSha256}\``) &&
            clusterReviewWorksheet.includes(`validationReportSha256: \`${humanReviewValidationSha256}\``) &&
            clusterReviewWorksheet.includes(`reviewClusterSha256: \`${reviewClusterReportSha256}\``) &&
            clusterReviewWorksheet.includes('This worksheet does not write `gold-manifest.json`.') &&
            clusterReviewWorksheet.includes('Review one cluster at a time before changing any alpha/profile candidate.') &&
            clusterReviewWorksheet.includes('Use `by-cluster/*.png` sheets for grouped visual inspection.'),
        'cluster review worksheet is generated with cluster guidance and policy',
        {
            worksheetPath: clusterReviewWorksheetPath,
            length: clusterReviewWorksheet.length,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedValidationReportSha256: humanReviewValidationSha256,
            expectedReviewClusterSha256: reviewClusterReportSha256
        }
    );
    assertCondition(
        checks,
        goldProposal.policy?.writesFormalGoldManifest === false &&
            goldProposal.policy?.writesProductionAlgorithm === false &&
            goldProposal.policy?.requiresHumanConfirmationBeforeGoldMigration === true,
        'gold proposal is proposal-only and human-gated',
        { policy: goldProposal.policy }
    );
    assertCondition(
        checks,
        goldProposal.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            goldProposal.inputs?.alphaSweepSha256 === sha256Text(alphaSweepText) &&
            goldProposal.inputs?.profileReportSha256 === sha256Text(profileReportText) &&
            goldProposal.inputs?.profileGeneralizationSha256 === sha256Text(profileGeneralizationText) &&
            goldProposal.inputs?.alphaSweepReviewManifestSha256 === reviewManifestSha256 &&
            goldProposal.inputs?.profileReportReviewManifestSha256 === reviewManifestSha256 &&
            goldProposal.inputs?.profileGeneralizationReviewManifestSha256 === reviewManifestSha256,
        'gold proposal records current review, alpha/profile input hashes, and alpha/profile manifest provenance',
        {
            proposalInputs: goldProposal.inputs,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedAlphaSweepSha256: sha256Text(alphaSweepText),
            expectedProfileReportSha256: sha256Text(profileReportText),
            expectedProfileGeneralizationSha256: sha256Text(profileGeneralizationText)
        }
    );
    assertCondition(
        checks,
        goldProposal.proposedGoldSchemaGate?.armed === true &&
            goldProposal.proposedGoldSchemaGate?.appliesToProposedGoldFields === true &&
            goldProposal.proposedGoldSchemaGate?.rejectsAlphaProfileVariantFields === true &&
            goldProposal.proposedGoldSchemaGate?.rejectsUnknownProposedGoldFields === true &&
            goldProposal.proposedGoldSchemaGate?.ok === true &&
            goldProposal.proposedGoldSchemaGate?.failClosedProblemCodes?.includes('gold-proposal-alpha-profile-variant-fields-present') &&
            goldProposal.proposedGoldSchemaGate?.failClosedProblemCodes?.includes('gold-proposal-unknown-gold-field-present'),
        'gold proposal declares a proposedGoldFields schema gate',
        { proposedGoldSchemaGate: goldProposal.proposedGoldSchemaGate }
    );
    const proposalCandidates = [
        ...goldProposal.goldCandidates?.readyForHumanConfirmation ?? [],
        ...goldProposal.goldCandidates?.pendingHumanReview ?? []
    ];
    assertCondition(
        checks,
        proposalCandidates.length ===
            (reviewManifest.summary?.metricPassVisibleReviewed ?? 0) + (reviewManifest.summary?.visibleTopPending ?? 0) &&
            proposalCandidates.every((candidate) => typeof candidate.sourceSet === 'string' && candidate.sourceSet.length > 0) &&
            proposalCandidates.every((candidate) => typeof candidate.clusterId === 'string' && candidate.clusterId.length > 0) &&
            proposalCandidates.every((candidate) => Array.isArray(candidate.visibleReasons)),
        'gold proposal candidates preserve sourceSet, clusterId, and visible reason provenance',
        {
            proposalCandidateCount: proposalCandidates.length,
            expectedCandidateCount:
                (reviewManifest.summary?.metricPassVisibleReviewed ?? 0) + (reviewManifest.summary?.visibleTopPending ?? 0),
            missingSourceSet: proposalCandidates.filter((candidate) => typeof candidate.sourceSet !== 'string').length,
            missingClusterId: proposalCandidates.filter((candidate) => typeof candidate.clusterId !== 'string').length
        }
    );
    assertCondition(
        checks,
        alphaSweep.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            profileReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            profileGeneralization.inputs?.reviewManifestSha256 === reviewManifestSha256,
        'alpha/profile observation reports are generated from the current review manifest',
        {
            expectedReviewManifestSha256: reviewManifestSha256,
            alphaSweepReviewManifestSha256: alphaSweep.inputs?.reviewManifestSha256,
            profileReportReviewManifestSha256: profileReport.inputs?.reviewManifestSha256,
            profileGeneralizationReviewManifestSha256: profileGeneralization.inputs?.reviewManifestSha256
        }
    );
    assertCondition(
        checks,
        geometryFamilyProfile.policy?.diagnosticOnly === true &&
            geometryFamilyProfile.policy?.writesFormalGoldManifest === false &&
            geometryFamilyProfile.policy?.writesProductionAlgorithm === false &&
            geometryFamilyProfile.policy?.allowsAlphaProfileProduction === false &&
            geometryFamilyProfile.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            geometryFamilyProfile.summary?.geometryFamilyApplicable === 18 &&
            geometryFamilyProfile.summary?.reference?.familyApplicable?.clearedVisible === 2 &&
            geometryFamilyProfile.summary?.reference?.familyApplicable?.unsafe === 6 &&
            geometryFamilyProfile.summary?.bestHumanReviewOnly === null &&
            geometryFamilyProfile.summary?.conclusion === 'reference-candidate-rejected-unsafe-within-family',
        '48/96/96 geometry-family alpha/profile report remains diagnostic and rejects production candidate',
        {
            policy: geometryFamilyProfile.policy,
            expectedReviewManifestSha256: reviewManifestSha256,
            reportReviewManifestSha256: geometryFamilyProfile.inputs?.reviewManifestSha256,
            summary: geometryFamilyProfile.summary
        }
    );
    assertCondition(
        checks,
        geometryFamilyProfileSheet.reportPath === geometryFamilyProfilePath &&
            geometryFamilyProfileSheet.rowCount === geometryFamilyProfile.summary?.geometryFamilyApplicable &&
            existsSync(geometryFamilyProfileSheet.imagePath) &&
            geometryFamilyProfileSheet.policy?.diagnosticOnly === true &&
            geometryFamilyProfileSheet.policy?.writesFormalGoldManifest === false &&
            geometryFamilyProfileSheet.policy?.writesProductionAlgorithm === false &&
            geometryFamilyProfileSheet.policy?.allowsAlphaProfileProduction === false,
        '48/96/96 geometry-family visual sheet mirrors diagnostic report and policy',
        {
            sheetReportPath: geometryFamilyProfileSheet.reportPath,
            expectedReportPath: geometryFamilyProfilePath,
            rowCount: geometryFamilyProfileSheet.rowCount,
            expectedRowCount: geometryFamilyProfile.summary?.geometryFamilyApplicable,
            imagePath: geometryFamilyProfileSheet.imagePath,
            policy: geometryFamilyProfileSheet.policy
        }
    );
    assertCondition(
        checks,
        referenceBoundary.policy?.diagnosticOnly === true &&
            referenceBoundary.policy?.writesFormalGoldManifest === false &&
            referenceBoundary.policy?.writesProductionAlgorithm === false &&
            referenceBoundary.policy?.allowsAlphaProfileProduction === false &&
            referenceBoundary.sourceInputs?.reviewManifestSha256 === reviewManifestSha256 &&
            referenceBoundary.summary?.total === geometryFamilyProfile.summary?.geometryFamilyApplicable &&
            referenceBoundary.summary?.totalCleared === 2 &&
            referenceBoundary.summary?.cleanIsolationRuleCount === 0 &&
            referenceBoundary.summary?.bestRuleKeepingAllCleared?.falsePositive === 1 &&
            referenceBoundary.summary?.conclusion === 'reference-candidate-has-no-clean-evidence-boundary',
        '48/96/96 reference boundary scan proves there is no clean evidence gate',
        {
            policy: referenceBoundary.policy,
            expectedReviewManifestSha256: reviewManifestSha256,
            reportReviewManifestSha256: referenceBoundary.sourceInputs?.reviewManifestSha256,
            summary: referenceBoundary.summary
        }
    );
    assertCondition(
        checks,
        referenceBoundarySheet.reportPath === referenceBoundaryPath &&
            existsSync(referenceBoundarySheet.imagePath) &&
            referenceBoundarySheet.summary?.cleanIsolationRuleCount === referenceBoundary.summary?.cleanIsolationRuleCount &&
            referenceBoundarySheet.policy?.diagnosticOnly === true &&
            referenceBoundarySheet.policy?.writesFormalGoldManifest === false &&
            referenceBoundarySheet.policy?.writesProductionAlgorithm === false &&
            referenceBoundarySheet.policy?.allowsAlphaProfileProduction === false,
        '48/96/96 reference boundary scatter sheet mirrors diagnostic report and policy',
        {
            sheetReportPath: referenceBoundarySheet.reportPath,
            expectedReportPath: referenceBoundaryPath,
            imagePath: referenceBoundarySheet.imagePath,
            sheetSummary: referenceBoundarySheet.summary,
            expectedSummary: referenceBoundary.summary,
            policy: referenceBoundarySheet.policy
        }
    );
    assertCondition(
        checks,
        geometryFamilyGoalAudit.goalAchieved === true &&
            geometryFamilyGoalAudit.conclusion === 'achieved-as-diagnostic-rejection' &&
            Array.isArray(geometryFamilyGoalAudit.unsatisfiedRequirementIds) &&
            geometryFamilyGoalAudit.unsatisfiedRequirementIds.length === 0 &&
            (geometryFamilyGoalAudit.requirements ?? []).length === 4 &&
            (geometryFamilyGoalAudit.requirements ?? []).every((item) => item.status === 'satisfied') &&
            geometryFamilyGoalAudit.finalFindings?.candidate === '48/96/96 + power-0.88 + alphaGain=0.55' &&
            geometryFamilyGoalAudit.finalFindings?.productionDecision === 'reject-production-candidate' &&
            geometryFamilyGoalAudit.finalFindings?.profileLineExclusive === false,
        '48/96/96 alpha/profile goal audit is achieved as diagnostic rejection',
        {
            goalAchieved: geometryFamilyGoalAudit.goalAchieved,
            conclusion: geometryFamilyGoalAudit.conclusion,
            unsatisfiedRequirementIds: geometryFamilyGoalAudit.unsatisfiedRequirementIds,
            requirements: geometryFamilyGoalAudit.requirements,
            finalFindings: geometryFamilyGoalAudit.finalFindings
        }
    );
    assertCondition(
        checks,
        goldProposal.algorithmAdmission?.productionChangeAllowed === false,
        'algorithm admission blocks production change',
        { productionChangeAllowed: goldProposal.algorithmAdmission?.productionChangeAllowed }
    );
    assertCondition(
        checks,
        admissionReport.policy?.reportOnly === true &&
            admissionReport.policy?.writesFormalGoldManifest === false &&
            admissionReport.policy?.writesProductionAlgorithm === false &&
            admissionReport.inputs?.validationReportSha256 === humanReviewValidationSha256 &&
            admissionReport.inputs?.reviewInputContractSha256 === reviewInputContractSha256 &&
            admissionReport.inputs?.goldProposalSha256 === goldProposalSha256 &&
            admissionReport.validationInputContractIntegrity?.ok === true &&
            admissionReport.validationInputContractIntegrity?.hashes?.reviewInputContractSha256 === reviewInputContractSha256 &&
            admissionReport.validationInputContractIntegrity?.hashes?.reviewInputContractReviewManifestSha256 === reviewManifestSha256 &&
            admissionReport.validationReadinessIntegrity?.ok === true &&
            admissionReport.validationReadinessIntegrity?.expectedTotal === proposalCandidates.length &&
            admissionReport.validationDecisionSchemaGateIntegrity?.ok === true &&
            admissionReport.validationDecisionSchemaGateIntegrity?.gate?.rejectsUnknownDecisionInputRootFields === true &&
            admissionReport.validationDecisionSchemaGateIntegrity?.gate?.failClosedProblemCodes?.includes('decision-input-unknown-root-fields-present') &&
            admissionReport.proposalCandidateProvenance?.ok === true &&
            admissionReport.proposalCandidateProvenance?.candidateCount === proposalCandidates.length &&
            admissionReport.proposalCandidateProvenance?.expectedCandidateCount === proposalCandidates.length &&
            admissionReport.proposalValidationCoverage?.ok === true &&
            admissionReport.proposalValidationCoverage?.expectedTotal === proposalCandidates.length &&
            admissionReport.proposalValidationCoverage?.candidateCount === proposalCandidates.length &&
            admissionReport.proposalValidationCoverage?.expectedCandidateCount === proposalCandidates.length &&
            admissionReport.proposalInputIntegrity?.ok === true &&
            admissionReport.proposalInputIntegrity?.hashes?.alphaSweepSha256 === sha256Text(alphaSweepText) &&
            admissionReport.proposalInputIntegrity?.hashes?.profileReportSha256 === sha256Text(profileReportText) &&
            admissionReport.proposalInputIntegrity?.hashes?.profileGeneralizationSha256 === sha256Text(profileGeneralizationText) &&
            admissionReport.proposalInputIntegrity?.hashes?.alphaSweepReviewManifestSha256 === reviewManifestSha256 &&
            admissionReport.proposalInputIntegrity?.hashes?.profileReportReviewManifestSha256 === reviewManifestSha256 &&
            admissionReport.proposalInputIntegrity?.hashes?.profileGeneralizationReviewManifestSha256 === reviewManifestSha256 &&
            admissionReport.goldSchemaGate?.armed === true &&
            admissionReport.goldSchemaGate?.appliesToFormalGoldManifest === true &&
            admissionReport.goldSchemaGate?.rejectsAlphaProfileVariantFields === true &&
            admissionReport.goldSchemaGate?.rejectsUnknownFormalVisibleResidualFields === true &&
            admissionReport.goldSchemaGate?.ok === true &&
            admissionReport.goldSchemaGate?.failClosedProblemCodes?.includes('gold-manifest-alpha-profile-variant-fields-present') &&
            admissionReport.goldSchemaGate?.failClosedProblemCodes?.includes('gold-manifest-unknown-visible-residual-field-present') &&
            admissionReport.algorithmAdmissionIntegrity?.ok === true &&
            admissionReport.algorithmAdmissionIntegrity?.productionChangeAllowed === false &&
            admissionReport.algorithmAdmissionIntegrity?.requiredProductionChangeGateMarkers?.includes('human-confirmed-gold-manifest') &&
            admissionReport.algorithmAdmissionIntegrity?.approvedProductionChangeGateMarkers?.includes('accepted-alpha-profile-decision') &&
            admissionReport.algorithmAdmissionIntegrity?.approvedProductionChangeGateMarkers?.includes('accepted-alpha-gain-sweep-decision') &&
            admissionReport.algorithmAdmissionIntegrity?.hasHumanConfirmedGoldManifestGate === false &&
            admissionReport.algorithmAdmissionIntegrity?.hasApprovedProductionDecisionGate === false &&
            admissionReport.goldManifestIntegrity?.ok === true &&
            admissionReport.goldManifestIntegrity?.exists === false &&
            admissionReport.goldManifestGate?.integrityReady === true,
        'algorithm admission report is report-only',
        {
            policy: admissionReport.policy,
            admissionInputs: admissionReport.inputs,
            expectedValidationReportSha256: humanReviewValidationSha256,
            expectedReviewInputContractSha256: reviewInputContractSha256,
            expectedGoldProposalSha256: goldProposalSha256,
            validationInputContractIntegrity: admissionReport.validationInputContractIntegrity,
            validationReadinessIntegrity: admissionReport.validationReadinessIntegrity,
            validationDecisionSchemaGateIntegrity: admissionReport.validationDecisionSchemaGateIntegrity,
            proposalCandidateProvenance: admissionReport.proposalCandidateProvenance,
            proposalValidationCoverage: admissionReport.proposalValidationCoverage,
            proposalInputIntegrity: admissionReport.proposalInputIntegrity,
            goldSchemaGate: admissionReport.goldSchemaGate,
            algorithmAdmissionIntegrity: admissionReport.algorithmAdmissionIntegrity,
            goldManifestGate: admissionReport.goldManifestGate,
            goldManifestIntegrity: admissionReport.goldManifestIntegrity,
            expectedAlphaSweepSha256: sha256Text(alphaSweepText),
            expectedProfileReportSha256: sha256Text(profileReportText),
            expectedProfileGeneralizationSha256: sha256Text(profileGeneralizationText),
            expectedReviewManifestSha256: reviewManifestSha256
        }
    );
    assertCondition(
        checks,
        admissionReport.humanGate?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            admissionReport.humanGate?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            admissionReport.humanGate?.structuralErrorCount === humanReviewValidation.structuralErrorCount,
        'algorithm admission report mirrors human gate validation',
        {
            reportHumanGate: admissionReport.humanGate,
            validation: {
                readyForGoldMigration: humanReviewValidation.readyForGoldMigration,
                unconfirmedCount: humanReviewValidation.unconfirmedCount,
                structuralErrorCount: humanReviewValidation.structuralErrorCount
            }
        }
    );
    assertCondition(
        checks,
        admissionReport.productionProfileAdmission?.allowed === false &&
            admissionReport.productionProfileAdmission?.blockedReasons?.includes('human-review-not-ready-for-gold-migration') &&
            admissionReport.productionProfileAdmission?.blockedReasons?.includes('algorithm-admission-production-change-blocked'),
        'algorithm admission report blocks production profile before human gate',
        { productionProfileAdmission: admissionReport.productionProfileAdmission }
    );
    assertCondition(
        checks,
        goalAuditReport.policy?.reportOnly === true &&
            goalAuditReport.policy?.writesFormalGoldManifest === false &&
            goalAuditReport.policy?.writesProductionAlgorithm === false &&
            goalAuditReport.status === 'human-gated-incomplete' &&
            goalAuditReport.summary?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            goalAuditReport.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            goalAuditReport.summary?.reviewManifestSha256 === reviewManifestSha256 &&
            goalAuditReport.summary?.clusterTotal === reviewClusterReport.summary?.clusterTotal &&
            goalAuditReport.summary?.reviewBatchCount === humanReviewProgressReport.reviewBatches?.length &&
            goalAuditReport.summary?.reviewBatchTotal === humanReviewValidation.unconfirmedCount &&
            goalAuditReport.summary?.goldCandidateUnconfirmedCount === humanReviewValidation.goldCandidateUnconfirmedCount &&
            goalAuditReport.summary?.goldCandidateReviewBatchCount === humanReviewProgressReport.goldCandidateReviewBatches?.length &&
            goalAuditReport.summary?.goldCandidateReviewBatchTotal === humanReviewValidation.goldCandidateUnconfirmedCount &&
            goalAuditReport.summary?.nextGoldCandidateReviewCluster === humanReviewProgressReport.nextGoldCandidateReviewBatch?.clusterId &&
            goalAuditReport.summary?.goldManifestExists === false &&
            goalAuditReport.summary?.productionProfileAllowed === false &&
            goalAuditReport.summary?.packageScriptGateReady === packageScriptGate.ready &&
            goalAuditReport.summary?.visibleResidualPackageScriptCount === packageScriptGate.visibleResidualScriptCount &&
            goalAuditReport.summary?.forbiddenVisibleResidualPackageScriptCount ===
                packageScriptGate.forbiddenVisibleResidualPackageScripts.length &&
            goalAuditReport.summary?.unclassifiedVisibleResidualPackageScriptCount ===
                packageScriptGate.unclassifiedVisibleResidualScripts.length &&
            goalAuditReport.summary?.packageJsonSha256 === packageJsonSha256 &&
            goalAuditReport.inputs?.packageJsonPath === packageJsonPath &&
            goalAuditReport.inputs?.packageJsonSha256 === packageJsonSha256,
        'goal audit report summarizes objective status and keeps production gate closed',
        {
            status: goalAuditReport.status,
            summary: goalAuditReport.summary,
            packageScriptGate
        }
    );
    const goalAuditAlgorithmAdmissionRequirement = (goalAuditReport.requirements ?? []).find((item) => (
        item.id === 'algorithm-admission-human-gated'
    ));
    const goalAuditReviewGuidanceRequirement = (goalAuditReport.requirements ?? []).find((item) => (
        item.id === 'next-review-guidance-is-reproducible'
    ));
    const goalAuditNoProductionRequirement = (goalAuditReport.requirements ?? []).find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    const loopVisibleReviewAction = (loopSummary.nextActions ?? []).find((item) => (
        item.id === 'complete-visible-residual-review-batches'
    ));
    const loopGoldCandidateAction = (loopSummary.nextActions ?? []).find((item) => (
        item.id === 'complete-gold-candidate-confirmations'
    ));
    const loopValidationAction = (loopSummary.nextActions ?? []).find((item) => (
        item.id === 'rerun-human-review-validation-after-edits'
    ));
    const loopGoldManifestBlockedAction = (loopSummary.blockedActions ?? []).find((item) => (
        item.id === 'write-formal-gold-manifest'
    ));
    const loopProductionBlockedAction = (loopSummary.blockedActions ?? []).find((item) => (
        item.id === 'productionize-alpha-profile-variant'
    ));
    const goalAuditRequirements = goalAuditReport.requirements ?? [];
    const goalAuditUnsatisfiedRequirementIds = goalAuditRequirements
        .filter((item) => item.satisfied !== true)
        .map((item) => item.id);
    const goalAuditRequirementCounts = {
        total: goalAuditRequirements.length,
        satisfied: goalAuditRequirements.filter((item) => item.satisfied === true).length,
        blockedByHumanReview: goalAuditRequirements.filter((item) => item.status === 'blocked-by-human-review').length,
        missingEvidence: goalAuditRequirements.filter((item) => item.status === 'missing-evidence').length,
        failed: goalAuditRequirements.filter((item) => item.status === 'failed').length,
        otherIncomplete: goalAuditRequirements.filter((item) => (
            item.satisfied !== true &&
            item.status !== 'blocked-by-human-review' &&
            item.status !== 'missing-evidence' &&
            item.status !== 'failed'
        )).length
    };
    assertCondition(
        checks,
        loopSummary.ok === true &&
            typeof loopSummary.verifiedByFinalStep === 'boolean' &&
            loopSummary.sourceSummaryPath &&
            loopSummary.outputDir &&
            loopSummary.inputHashes?.sourceSummarySha256 === loopSourceSummarySha256 &&
            loopSummary.inputHashes?.renderSummarySha256 === renderSummarySha256 &&
            loopSummary.inputHashes?.reviewManifestSha256 === reviewManifestSha256 &&
            loopSummary.inputHashes?.validationReportSha256 === humanReviewValidationSha256 &&
            loopSummary.inputHashes?.reviewClusterSha256 === reviewClusterReportSha256 &&
            loopSummary.inputHashes?.humanReviewPackSummarySha256 === humanReviewPackSummarySha256 &&
            loopSummary.inputHashes?.reviewWorksheetSha256 === humanReviewWorksheetSha256 &&
            loopSummary.inputHashes?.reviewTableSha256 === humanReviewTableSha256 &&
            loopSummary.inputHashes?.clusterReviewWorksheetSha256 === clusterReviewWorksheetSha256 &&
            loopSummary.inputHashes?.reviewProgressReportSha256 === humanReviewProgressReportSha256 &&
            loopSummary.inputHashes?.reviewCheckpointSha256 === humanReviewCheckpointSha256 &&
            loopSummary.inputHashes?.focusedReviewBatchSha256 === focusedReviewBatchSha256 &&
            loopSummary.inputHashes?.reviewHandoffSha256 === reviewHandoffSha256 &&
            loopSummary.inputHashes?.humanReviewReadmeSha256 === humanReviewReadmeSha256 &&
            loopSummary.inputHashes?.reviewInputContractSha256 === reviewInputContractSha256 &&
            loopSummary.inputHashes?.reviewDecisionsSha256 === humanReviewInputSha256 &&
            loopSummary.inputHashes?.goldCandidateConfirmationsSha256 === goldCandidateConfirmationInputSha256 &&
            loopSummary.inputHashes?.packageJsonSha256 === packageJsonSha256 &&
            loopSummary.inputHashes?.admissionReportSha256 === admissionReportSha256 &&
            loopSummary.inputHashes?.goalAuditReportSha256 === goalAuditReportSha256 &&
            loopSummary.summary?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            loopSummary.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            loopSummary.summary?.structuralErrorCount === humanReviewValidation.structuralErrorCount &&
            loopSummary.summary?.reviewManifestSha256 === reviewManifestSha256 &&
            loopSummary.summary?.productionProfileAllowed === false &&
            loopSummary.summary?.productionGateContractReady === (
                goalAuditAlgorithmAdmissionRequirement?.evidence?.productionGateContractReady === true
            ) &&
            loopSummary.summary?.goldManifestWriteAllowed === false &&
            loopSummary.summary?.goldManifestExists === false &&
            loopSummary.summary?.productionHitCount === goalAuditReport.summary?.productionHitCount &&
            loopSummary.summary?.productionArtifactHitCount === goalAuditReport.summary?.productionArtifactHitCount &&
            loopSummary.summary?.packageScriptGateReady ===
                (goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.ready === true) &&
            loopSummary.summary?.visibleResidualPackageScriptCount ===
                goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.visibleResidualScriptCount &&
            loopSummary.summary?.forbiddenVisibleResidualPackageScriptCount ===
                goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.forbiddenVisibleResidualPackageScripts?.length &&
            loopSummary.summary?.unclassifiedVisibleResidualPackageScriptCount ===
                goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.unclassifiedVisibleResidualScripts?.length &&
            loopSummary.summary?.goalAuditStatus === goalAuditReport.status &&
            Array.isArray(loopSummary.summary?.blockers) &&
            loopSummary.summary.blockers.includes('human-review-not-complete') &&
            loopSummary.humanReviewGuidance?.humanReviewPackSummaryPath === humanReviewPackSummaryPath &&
            loopSummary.humanReviewGuidance?.reviewWorksheetPath === humanReviewWorksheetPath &&
            loopSummary.humanReviewGuidance?.reviewTablePath === humanReviewTablePath &&
            loopSummary.humanReviewGuidance?.clusterReviewWorksheetPath === clusterReviewWorksheetPath &&
            loopSummary.humanReviewGuidance?.reviewProgressReportPath === humanReviewProgressReportPath &&
            loopSummary.humanReviewGuidance?.reviewCheckpointPath === humanReviewCheckpointPath &&
            loopSummary.humanReviewGuidance?.focusedReviewBatchPath === focusedReviewBatchPath &&
            loopSummary.humanReviewGuidance?.reviewHandoffPath === reviewHandoffPath &&
            loopSummary.humanReviewGuidance?.humanReviewReadmePath === humanReviewReadmePath &&
            loopSummary.humanReviewGuidance?.reviewDecisionsPath === humanReviewInputPath &&
            loopSummary.humanReviewGuidance?.goldCandidateConfirmationsPath === goldCandidateConfirmationInputPath &&
            loopSummary.humanReviewGuidance?.reviewBatchCount === humanReviewProgressReport.reviewBatches?.length &&
            loopSummary.humanReviewGuidance?.reviewBatchTotal === expectedIncompleteDecisionTotal &&
            loopSummary.humanReviewGuidance?.remainingClusterCount === expectedSortedIncompleteClusters.length &&
            loopSummary.humanReviewGuidance?.goldCandidateUnconfirmedCount === humanReviewValidation.goldCandidateUnconfirmedCount &&
            loopSummary.humanReviewGuidance?.goldCandidateReviewBatchCount === humanReviewProgressReport.goldCandidateReviewBatches?.length &&
            loopSummary.humanReviewGuidance?.goldCandidateReviewBatchTotal === expectedGoldCandidateDecisionTotal &&
            loopSummary.humanReviewGuidance?.nextGoldCandidateReviewBatch?.clusterId === humanReviewProgressReport.nextGoldCandidateReviewBatch?.clusterId &&
            loopSummary.humanReviewGuidance?.nextGoldCandidateReviewBatch?.firstDecisionInputPath === humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionInputPath &&
            loopSummary.humanReviewGuidance?.nextGoldCandidateReviewBatch?.firstDecisionJsonPath === humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionJsonPath &&
            loopSummary.humanReviewGuidance?.nextReviewCluster?.clusterId === humanReviewProgressReport.nextReviewClusters?.[0]?.clusterId &&
            loopSummary.humanReviewGuidance?.nextReviewCluster?.sheetPath === humanReviewProgressReport.nextReviewClusters?.[0]?.sheetPath &&
            loopSummary.humanReviewGuidance?.nextReviewBatch?.clusterId === humanReviewProgressReport.nextReviewBatch?.cluster?.clusterId &&
            loopSummary.humanReviewGuidance?.nextReviewBatch?.itemCount === humanReviewProgressReport.nextReviewBatch?.itemCount &&
            loopSummary.humanReviewGuidance?.nextReviewBatch?.firstDecisionInputPath === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.decisionInputPath &&
            loopSummary.humanReviewGuidance?.nextReviewBatch?.firstDecisionJsonPath === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.decisionJsonPath &&
            decisionTargetsMatchItems(
                loopSummary.humanReviewGuidance?.nextReviewBatch?.decisionTargets,
                humanReviewProgressReport.nextReviewBatch?.items
            ) &&
            loopSummary.completionAudit?.goalAchieved === false &&
            loopSummary.completionAudit?.goalAuditStatus === goalAuditReport.status &&
            loopSummary.completionAudit?.humanReviewBlocked === true &&
            JSON.stringify(loopSummary.completionAudit?.blockers ?? []) === JSON.stringify(goalAuditReport.blockers ?? []) &&
            JSON.stringify(loopSummary.completionAudit?.unsatisfiedRequirementIds ?? []) ===
                JSON.stringify(goalAuditUnsatisfiedRequirementIds) &&
            loopSummary.completionAudit?.requirementCounts?.total === goalAuditRequirementCounts.total &&
            loopSummary.completionAudit?.requirementCounts?.satisfied === goalAuditRequirementCounts.satisfied &&
            loopSummary.completionAudit?.requirementCounts?.blockedByHumanReview === goalAuditRequirementCounts.blockedByHumanReview &&
            loopSummary.completionAudit?.requirementCounts?.missingEvidence === goalAuditRequirementCounts.missingEvidence &&
            loopSummary.completionAudit?.requirementCounts?.failed === goalAuditRequirementCounts.failed &&
            loopSummary.completionAudit?.requirementCounts?.otherIncomplete === goalAuditRequirementCounts.otherIncomplete &&
            loopSummary.completionAudit?.requirements?.length === goalAuditRequirements.length &&
            loopSummary.completionAudit?.requirements?.some((item) => (
                item.id === 'formal-gold-migration' &&
                item.status === 'blocked-by-human-review' &&
                item.satisfied === false &&
                item.blockers?.includes('human-review-not-complete')
            )) &&
            loopSummary.completionAudit?.requirements?.some((item) => (
                item.id === 'no-alpha-profile-production-before-human-confirmation' &&
                item.status === 'satisfied' &&
                item.satisfied === true
            )) &&
            loopSummary.completionAudit?.completionRequiredState?.allRequirementsSatisfied === true &&
            loopSummary.completionAudit?.completionRequiredState?.blockersEmpty === true &&
            loopSummary.completionAudit?.completionRequiredState?.formalGoldMigrationSatisfied === true &&
            loopSummary.completionAudit?.completionRequiredState?.noAlphaProfileProductionBeforeHumanConfirmationSatisfied === true &&
            loopSummary.completionAudit?.completionRequiredState?.requiredRequirementIds?.includes('formal-gold-migration') &&
            loopSummary.completionAudit?.completionRequiredState?.requiredRequirementIds?.includes('no-alpha-profile-production-before-human-confirmation') &&
            loopVisibleReviewAction?.status === 'required' &&
            loopVisibleReviewAction?.remainingDecisionCount === expectedIncompleteDecisionTotal &&
            loopVisibleReviewAction?.batchCount === humanReviewProgressReport.reviewBatches?.length &&
            loopVisibleReviewAction?.inputPath === humanReviewInputPath &&
            loopVisibleReviewAction?.firstDecisionJsonPath === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.decisionJsonPath &&
            loopVisibleReviewAction?.firstFile === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.file &&
            loopVisibleReviewAction?.firstCropPath === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.cropPath &&
            loopVisibleReviewAction?.sheetPath === (
                humanReviewProgressReport.nextReviewBatch?.cluster?.sheetPath ??
                humanReviewProgressReport.nextReviewClusters?.[0]?.sheetPath
            ) &&
            existsSync(loopVisibleReviewAction?.firstCropPath ?? '') &&
            existsSync(loopVisibleReviewAction?.sheetPath ?? '') &&
            decisionTargetsMatchItems(
                loopVisibleReviewAction?.decisionTargets,
                humanReviewProgressReport.nextReviewBatch?.items
            ) &&
            loopVisibleReviewAction?.policy?.actionType === 'human-review' &&
            loopVisibleReviewAction?.policy?.requiresHumanJudgement === true &&
            loopVisibleReviewAction?.policy?.reviewCheckpointPath === humanReviewCheckpointPath &&
            loopVisibleReviewAction?.policy?.focusedReviewBatchPath === focusedReviewBatchPath &&
            loopVisibleReviewAction?.policy?.writesFormalGoldManifest === false &&
            loopVisibleReviewAction?.policy?.writesProductionAlgorithm === false &&
            loopVisibleReviewAction?.policy?.allowsAlphaProfileProduction === false &&
            loopVisibleReviewAction?.policy?.validationCommandAfterEdit === 'pnpm visible-residual:validate-human-review' &&
            loopGoldCandidateAction?.status === 'required' &&
            loopGoldCandidateAction?.remainingDecisionCount === expectedGoldCandidateDecisionTotal &&
            loopGoldCandidateAction?.batchCount === humanReviewProgressReport.goldCandidateReviewBatches?.length &&
            loopGoldCandidateAction?.inputPath === goldCandidateConfirmationInputPath &&
            loopGoldCandidateAction?.firstDecisionJsonPath === humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionJsonPath &&
            loopGoldCandidateAction?.firstFile === humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstFile &&
            loopGoldCandidateAction?.firstCropPath === humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstCropPath &&
            loopGoldCandidateAction?.sheetPath === humanReviewProgressReport.nextGoldCandidateReviewBatch?.sheetPath &&
            existsSync(loopGoldCandidateAction?.firstCropPath ?? '') &&
            existsSync(loopGoldCandidateAction?.sheetPath ?? '') &&
            decisionTargetsMatchItems(
                loopGoldCandidateAction?.decisionTargets,
                humanReviewProgressReport.nextGoldCandidateReviewBatch?.items
            ) &&
            loopGoldCandidateAction?.policy?.actionType === 'human-review' &&
            loopGoldCandidateAction?.policy?.requiresHumanJudgement === true &&
            loopGoldCandidateAction?.policy?.reviewCheckpointPath === humanReviewCheckpointPath &&
            loopGoldCandidateAction?.policy?.focusedReviewBatchPath === focusedReviewBatchPath &&
            loopGoldCandidateAction?.policy?.writesFormalGoldManifest === false &&
            loopGoldCandidateAction?.policy?.writesProductionAlgorithm === false &&
            loopGoldCandidateAction?.policy?.allowsAlphaProfileProduction === false &&
            loopGoldCandidateAction?.policy?.validationCommandAfterEdit === 'pnpm visible-residual:validate-human-review' &&
            loopValidationAction?.status === 'required-after-human-edits' &&
            loopValidationAction?.command === 'pnpm visible-residual:validate-human-review' &&
            loopValidationAction?.policy?.actionType === 'validation' &&
            loopValidationAction?.policy?.requiresHumanJudgement === false &&
            loopValidationAction?.policy?.writesFormalGoldManifest === false &&
            loopValidationAction?.policy?.writesProductionAlgorithm === false &&
            loopValidationAction?.policy?.allowsAlphaProfileProduction === false &&
            loopGoldManifestBlockedAction?.blocked === true &&
            loopGoldManifestBlockedAction?.reason === 'human-review-not-complete' &&
            loopGoldManifestBlockedAction?.gateEvidence?.readyForGoldMigration === false &&
            loopGoldManifestBlockedAction?.gateEvidence?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            loopGoldManifestBlockedAction?.gateEvidence?.structuralErrorCount === humanReviewValidation.structuralErrorCount &&
            loopGoldManifestBlockedAction?.gateEvidence?.goldManifestWriteAllowed === false &&
            loopGoldManifestBlockedAction?.policy?.writesFormalGoldManifest === true &&
            loopGoldManifestBlockedAction?.policy?.writesProductionAlgorithm === false &&
            loopGoldManifestBlockedAction?.policy?.requiresHumanConfirmationBeforeWrite === true &&
            loopProductionBlockedAction?.blocked === true &&
            loopProductionBlockedAction?.reason === 'production-profile-admission-not-allowed' &&
            loopProductionBlockedAction?.gateEvidence?.productionProfileAllowed === false &&
            loopProductionBlockedAction?.gateEvidence?.productionGateContractReady === (
                goalAuditAlgorithmAdmissionRequirement?.evidence?.productionGateContractReady === true
            ) &&
            loopProductionBlockedAction?.gateEvidence?.productionHitCount === goalAuditReport.summary?.productionHitCount &&
            loopProductionBlockedAction?.gateEvidence?.productionArtifactHitCount === goalAuditReport.summary?.productionArtifactHitCount &&
            loopProductionBlockedAction?.gateEvidence?.goldManifestExists === false &&
            loopProductionBlockedAction?.gateEvidence?.readyForGoldMigration === false &&
            loopProductionBlockedAction?.gateEvidence?.packageScriptGateReady === true &&
            loopProductionBlockedAction?.gateEvidence?.forbiddenVisibleResidualPackageScriptCount ===
                goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.forbiddenVisibleResidualPackageScripts?.length &&
            loopProductionBlockedAction?.gateEvidence?.unclassifiedVisibleResidualPackageScriptCount ===
                goalAuditNoProductionRequirement?.evidence?.packageScriptGate?.unclassifiedVisibleResidualScripts?.length &&
            loopProductionBlockedAction?.policy?.writesFormalGoldManifest === false &&
            loopProductionBlockedAction?.policy?.writesProductionAlgorithm === true &&
            loopProductionBlockedAction?.policy?.requiresHumanConfirmationBeforeWrite === true &&
            (loopSummary.steps ?? []).some((step) => step.script === 'scripts/create-visible-residual-goal-audit-report.js') &&
            (
                loopSummary.verifiedByFinalStep === false ||
                (loopSummary.steps ?? []).some((step) => step.script === 'scripts/verify-visible-residual-loop.js')
            ),
        'loop summary artifact exposes current human and production gate metrics',
        {
            loopSummaryPath,
            inputHashes: loopSummary.inputHashes,
            summary: loopSummary.summary,
            humanReviewGuidance: loopSummary.humanReviewGuidance,
            completionAudit: loopSummary.completionAudit,
            nextActions: loopSummary.nextActions,
            blockedActions: loopSummary.blockedActions,
            verifiedByFinalStep: loopSummary.verifiedByFinalStep
        }
    );
    assertCondition(
        checks,
        (goalAuditReport.requirements ?? []).some((item) => (
            item.id === 'formal-gold-migration' &&
            item.status === 'blocked-by-human-review' &&
            item.blockers?.includes('human-review-not-complete')
        )) &&
            (goalAuditReport.requirements ?? []).some((item) => (
                item.id === 'no-alpha-profile-production-before-human-confirmation' &&
                item.status === 'satisfied' &&
                item.evidence?.productionScanDirs?.includes('dist') &&
                /html/.test(item.evidence?.productionScanFilePattern ?? '') &&
                /json/.test(item.evidence?.productionScanFilePattern ?? '') &&
                Array.isArray(item.evidence?.productionHits) &&
                item.evidence.productionHits.length === 0 &&
                Array.isArray(item.evidence?.productionArtifactHits) &&
                item.evidence.productionArtifactHits.length === 0 &&
                item.evidence?.packageScriptGate?.ready === true &&
                item.evidence.packageScriptGate.packageJsonPath === packageJsonPath &&
                item.evidence.packageScriptGate.packageJsonSha256 === packageJsonSha256 &&
                item.evidence.packageScriptGate.visibleResidualScriptCount === packageScriptGate.visibleResidualScriptCount &&
                JSON.stringify(item.evidence.packageScriptGate.allowedScriptNames) ===
                    JSON.stringify(packageScriptGate.allowedScriptNames) &&
                JSON.stringify(item.evidence.packageScriptGate.scripts) === JSON.stringify(packageScriptGate.scripts) &&
                item.evidence.packageScriptGate.missingOrMismatchedRequiredScripts?.length === 0 &&
                item.evidence.packageScriptGate.unclassifiedVisibleResidualScripts?.length === 0 &&
                item.evidence.packageScriptGate.forbiddenVisibleResidualPackageScripts?.length === 0
            )) &&
            (goalAuditReport.requirements ?? []).some((item) => (
                item.id === 'review-manifest-provenance-is-stable' &&
                item.status === 'satisfied'
            )) &&
            (goalAuditReport.requirements ?? []).some((item) => (
                item.id === 'algorithm-admission-human-gated' &&
                item.status === 'satisfied' &&
                item.evidence?.productionGateContractReady === true
            )) &&
            goalAuditReviewGuidanceRequirement?.status === 'satisfied' &&
            goalAuditReviewGuidanceRequirement?.evidence?.reviewBatchCount === humanReviewProgressReport.reviewBatches?.length &&
            goalAuditReviewGuidanceRequirement?.evidence?.reviewBatchTotal === humanReviewValidation.unconfirmedCount &&
            goalAuditReviewGuidanceRequirement?.evidence?.goldCandidateReviewBatchCount === humanReviewProgressReport.goldCandidateReviewBatches?.length &&
            goalAuditReviewGuidanceRequirement?.evidence?.goldCandidateReviewBatchTotal === humanReviewValidation.goldCandidateUnconfirmedCount &&
            goalAuditReviewGuidanceRequirement?.evidence?.nextGoldCandidateReviewCluster === humanReviewProgressReport.nextGoldCandidateReviewBatch?.clusterId &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedReviewBatchSha256 === focusedReviewBatchSha256 &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchReady === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchValidationReportSha256 === humanReviewValidationSha256 &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchReviewClusterSha256 === reviewClusterReportSha256 &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchDecisionCount === focusedReviewBatch.decisions?.length &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedVisibleDecisionCount ===
                focusedReviewBatch.decisions?.filter((decision) => decision.sourceSet === 'visibleTopPending').length &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedGoldCandidateDecisionCount ===
                focusedReviewBatch.decisions?.filter((decision) => decision.sourceSet === 'metricPassVisible').length &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedVisibleBatchMatchesProgress === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedGoldCandidateBatchMatchesProgress === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchPolicy?.writesFormalGoldManifest === false &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchPolicy?.writesProductionAlgorithm === false &&
            goalAuditReviewGuidanceRequirement?.evidence?.focusedBatchPolicy?.allowsAlphaProfileProduction === false &&
            goalAuditReviewGuidanceRequirement?.evidence?.reviewHandoffSha256 === reviewHandoffSha256 &&
            goalAuditReviewGuidanceRequirement?.evidence?.reviewHandoffReady === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasVisibleBatchSheetPreview === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasGoldCandidateSheetPreview === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasAllFocusedDecisionCropPreviews === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasApplyCommand === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasValidateCommand === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasNoGoldPolicy === true &&
            goalAuditReviewGuidanceRequirement?.evidence?.handoffHasNoProductionPolicy === true,
        'goal audit report keeps formal gold migration blocked on human review',
        {
            requirements: (goalAuditReport.requirements ?? []).map((item) => ({
                id: item.id,
                status: item.status,
                satisfied: item.satisfied,
                blockers: item.blockers
            })),
            reviewGuidanceEvidence: goalAuditReviewGuidanceRequirement?.evidence,
            noProductionEvidence: goalAuditNoProductionRequirement?.evidence
        }
    );
    const goalAuditReviewArtifactsRequirement = (goalAuditReport.requirements ?? [])
        .find((item) => item.id === 'reproducible-review-artifacts');
    const goalAuditReviewArtifactsEvidence = goalAuditReviewArtifactsRequirement?.evidence ?? {};
    assertCondition(
        checks,
        goalAuditReviewArtifactsRequirement?.status === 'satisfied' &&
            goalAuditReviewArtifactsEvidence.reviewWorksheetProvenanceReady === true &&
            goalAuditReviewArtifactsEvidence.reviewTableProvenanceReady === true &&
            goalAuditReviewArtifactsEvidence.expectedValidationReportSha256 === humanReviewValidationSha256 &&
            goalAuditReviewArtifactsEvidence.expectedReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditReviewArtifactsEvidence.expectedReviewClusterSha256 === reviewClusterReportSha256,
        'goal audit verifies review worksheet and CSV provenance against current artifacts',
        {
            requirement: goalAuditReviewArtifactsRequirement,
            expectedValidationReportSha256: humanReviewValidationSha256,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedReviewClusterSha256: reviewClusterReportSha256
        }
    );
    const goalAuditClusterRequirement = (goalAuditReport.requirements ?? [])
        .find((item) => item.id === 'clustered-review-queue');
    const goalAuditClusterEvidence = goalAuditClusterRequirement?.evidence ?? {};
    assertCondition(
        checks,
        goalAuditClusterRequirement?.status === 'satisfied' &&
            goalAuditClusterEvidence.clusterWorksheetHasCurrentReviewManifestSha256 === true &&
            goalAuditClusterEvidence.clusterWorksheetHasCurrentValidationReportSha256 === true &&
            goalAuditClusterEvidence.clusterWorksheetHasCurrentReviewClusterSha256 === true &&
            goalAuditClusterEvidence.expectedReviewClusterSha256 === reviewClusterReportSha256,
        'goal audit verifies cluster worksheet provenance against current cluster report',
        {
            requirement: goalAuditClusterRequirement,
            expectedReviewClusterSha256: reviewClusterReportSha256
        }
    );
    const goalAuditGoldProposalRequirement = (goalAuditReport.requirements ?? [])
        .find((item) => item.id === 'proposal-only-gold-candidates');
    const goalAuditGoldProposalEvidence = goalAuditGoldProposalRequirement?.evidence ?? {};
    assertCondition(
        checks,
        goalAuditGoldProposalRequirement?.status === 'satisfied' &&
            goalAuditGoldProposalEvidence.proposalReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.expectedReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.proposalAlphaSweepSha256 === sha256Text(alphaSweepText) &&
            goalAuditGoldProposalEvidence.expectedAlphaSweepSha256 === sha256Text(alphaSweepText) &&
            goalAuditGoldProposalEvidence.proposalProfileReportSha256 === sha256Text(profileReportText) &&
            goalAuditGoldProposalEvidence.expectedProfileReportSha256 === sha256Text(profileReportText) &&
            goalAuditGoldProposalEvidence.proposalProfileGeneralizationSha256 === sha256Text(profileGeneralizationText) &&
            goalAuditGoldProposalEvidence.expectedProfileGeneralizationSha256 === sha256Text(profileGeneralizationText) &&
            goalAuditGoldProposalEvidence.proposalAlphaSweepReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.alphaSweepReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.proposalProfileReportReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.profileReportReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.proposalProfileGeneralizationReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.profileGeneralizationReviewManifestSha256 === reviewManifestSha256 &&
            goalAuditGoldProposalEvidence.admissionProposalCandidateProvenanceReady === true &&
            goalAuditGoldProposalEvidence.admissionProposalCandidateProvenance?.ok === true &&
            goalAuditGoldProposalEvidence.admissionProposalCandidateProvenance?.expectedCandidateCount ===
                proposalCandidates.length &&
            goalAuditGoldProposalEvidence.admissionProposalValidationCoverageReady === true &&
            goalAuditGoldProposalEvidence.admissionProposalValidationCoverage?.ok === true &&
            goalAuditGoldProposalEvidence.admissionProposalValidationCoverage?.expectedTotal === proposalCandidates.length,
        'goal audit verifies gold proposal input hashes against current alpha/profile artifacts',
        {
            requirement: goalAuditGoldProposalRequirement,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedAlphaSweepSha256: sha256Text(alphaSweepText),
            expectedProfileReportSha256: sha256Text(profileReportText),
            expectedProfileGeneralizationSha256: sha256Text(profileGeneralizationText)
        }
    );
    assertCondition(
        checks,
        goldProposal.algorithmAdmission?.alphaGainSweep?.decision === 'reject-production-wide-alpha-sweep',
        'alphaGain sweep rejected for production',
        { decision: goldProposal.algorithmAdmission?.alphaGainSweep?.decision }
    );
    assertCondition(
        checks,
        goldProposal.algorithmAdmission?.alphaProfileMidBoost124?.decision === 'reject-production-default-profile',
        'mid-boost profile rejected as default production profile',
        { decision: goldProposal.algorithmAdmission?.alphaProfileMidBoost124?.decision }
    );
    assertCondition(
        checks,
        alphaSweep.summary?.directAlphaGainCouldClearVisible === 0,
        'alpha sweep cannot directly clear visible residuals',
        { actual: alphaSweep.summary?.directAlphaGainCouldClearVisible }
    );
    assertCondition(
        checks,
        profileGeneralization.summary?.total === countProfileLineRecords(reviewManifest, '48px-large-margin') &&
            profileGeneralization.summary?.improvedSeverity > 0 &&
            profileGeneralization.summary?.clearedVisible > 0 &&
            profileGeneralization.summary?.hardRejectBest === 0,
        '48px large-margin profile generalization summary matches expected probe evidence',
        {
            summary: profileGeneralization.summary,
            expectedTotal: countProfileLineRecords(reviewManifest, '48px-large-margin')
        }
    );
    assertCondition(
        checks,
        humanReviewPackSummary.pendingTotal === reviewManifest.summary?.visibleTopPending,
        'human review pack covers all pending visibleTop records',
        {
            pendingTotal: humanReviewPackSummary.pendingTotal,
            visibleTopPending: reviewManifest.summary?.visibleTopPending
        }
    );
    assertCondition(
        checks,
        humanReviewPackSummary.goldCandidateTotal === reviewManifest.summary?.metricPassVisibleReviewed,
        'human review pack covers all metricPassVisible gold candidates',
        {
            goldCandidateTotal: humanReviewPackSummary.goldCandidateTotal,
            metricPassVisibleReviewed: reviewManifest.summary?.metricPassVisibleReviewed
        }
    );
    assertCondition(
        checks,
        humanReviewReadmeText.includes('人工只编辑 `review-decisions.json`') &&
            humanReviewReadmeText.includes('review-input-contract.json') &&
            humanReviewReadmeText.includes('## Review Workflow') &&
            humanReviewReadmeText.includes('visible-residual:review-status') &&
            humanReviewReadmeText.includes('review-handoff.md') &&
            humanReviewReadmeText.includes('cluster sheets and per-decision crop previews') &&
            humanReviewReadmeText.includes('review-focused-batch.json') &&
            humanReviewReadmeText.includes('Edit only `humanVerdict` / `humanConfidence` / `humanNotes`') &&
            humanReviewReadmeText.includes('Allowed `humanVerdict` values') &&
            humanReviewReadmeText.includes('Allowed `humanConfidence` values') &&
            humanReviewReadmeText.includes('visible-residual:apply-focused-batch --dry-run') &&
            humanReviewReadmeText.includes('visible-residual:apply-focused-batch') &&
            humanReviewReadmeText.includes('reviewBatches') &&
            humanReviewReadmeText.includes('goldCandidateReviewBatches') &&
            humanReviewReadmeText.includes('Fill `gold-candidate-confirmations.json`') &&
            humanReviewReadmeText.includes('Do not add decision fields') &&
            humanReviewReadmeText.includes('alphaGain') &&
            humanReviewReadmeText.includes('profileVariant') &&
            humanReviewReadmeText.includes('validation、admission 和正式 gold 迁移都会校验 contract provenance') &&
            humanReviewReadmeText.includes('所有确认项完成前，`gold-manifest.json` 必须保持不生成') &&
            !/[杩鑲纭锛€]/.test(humanReviewReadmeText),
        'human review README is readable and explains edit fields plus contract gates',
        {
            readmePath: humanReviewReadmePath,
            length: humanReviewReadmeText.length
        }
    );
    assertCondition(
        checks,
        humanReviewPackSummary.reviewManifestSha256 === reviewManifestSha256 &&
            humanReviewValidation.reviewManifestSha256 === reviewManifestSha256 &&
            humanReviewTemplate.reviewManifestSha256 === reviewManifestSha256 &&
            humanReviewInput.reviewManifestSha256 === reviewManifestSha256 &&
            goldCandidateConfirmationTemplate.reviewManifestSha256 === reviewManifestSha256 &&
            goldCandidateConfirmationInput.reviewManifestSha256 === reviewManifestSha256,
        'human review artifacts share the current review manifest hash',
        {
            expectedReviewManifestSha256: reviewManifestSha256,
            summaryReviewManifestSha256: humanReviewPackSummary.reviewManifestSha256,
            validationReviewManifestSha256: humanReviewValidation.reviewManifestSha256,
            templateReviewManifestSha256: humanReviewTemplate.reviewManifestSha256,
            inputReviewManifestSha256: humanReviewInput.reviewManifestSha256,
            goldCandidateTemplateReviewManifestSha256: goldCandidateConfirmationTemplate.reviewManifestSha256,
            goldCandidateInputReviewManifestSha256: goldCandidateConfirmationInput.reviewManifestSha256
        }
    );
    assertCondition(
        checks,
        humanReviewTemplate.decisions?.length === reviewManifest.summary?.visibleTopPending,
        'human review decision template has one entry per pending record',
        {
            decisions: humanReviewTemplate.decisions?.length,
            visibleTopPending: reviewManifest.summary?.visibleTopPending
        }
    );
    assertCondition(
        checks,
        goldCandidateConfirmationTemplate.decisions?.length === reviewManifest.summary?.metricPassVisibleReviewed,
        'gold candidate confirmation template has one entry per metricPassVisible record',
        {
            decisions: goldCandidateConfirmationTemplate.decisions?.length,
            metricPassVisibleReviewed: reviewManifest.summary?.metricPassVisibleReviewed
        }
    );
    assertCondition(
        checks,
        humanReviewInput.decisions?.length === reviewManifest.summary?.visibleTopPending,
        'human review input has one entry per pending record',
        {
            decisions: humanReviewInput.decisions?.length,
            visibleTopPending: reviewManifest.summary?.visibleTopPending
        }
    );
    assertCondition(
        checks,
        goldCandidateConfirmationInput.decisions?.length === reviewManifest.summary?.metricPassVisibleReviewed,
        'gold candidate confirmation input has one entry per metricPassVisible record',
        {
            decisions: goldCandidateConfirmationInput.decisions?.length,
            metricPassVisibleReviewed: reviewManifest.summary?.metricPassVisibleReviewed
        }
    );
    assertCondition(
        checks,
        (humanReviewTemplate.decisions ?? []).every((decision) => (
            decision.humanVerdict === null &&
            decision.humanConfidence === null &&
            typeof decision.file === 'string' &&
            typeof decision.clusterId === 'string' &&
            typeof decision.cropPath === 'string'
        )),
        'human review decision template is unconfirmed and cluster/file/crop-addressable',
        {
            invalidDecisionCount: (humanReviewTemplate.decisions ?? []).filter((decision) => !(
                decision.humanVerdict === null &&
                decision.humanConfidence === null &&
                typeof decision.file === 'string' &&
                typeof decision.clusterId === 'string' &&
                typeof decision.cropPath === 'string'
            )).length
        }
    );
    assertCondition(
        checks,
        (goldCandidateConfirmationTemplate.decisions ?? []).every((decision) => (
            decision.humanVerdict === null &&
            decision.humanConfidence === null &&
            typeof decision.suggestedVerdict === 'string' &&
            typeof decision.file === 'string' &&
            typeof decision.clusterId === 'string' &&
            typeof decision.cropPath === 'string'
        )),
        'gold candidate confirmation template is unconfirmed with suggested verdicts and cluster ids',
        {
            invalidDecisionCount: (goldCandidateConfirmationTemplate.decisions ?? []).filter((decision) => !(
                decision.humanVerdict === null &&
                decision.humanConfidence === null &&
                typeof decision.suggestedVerdict === 'string' &&
                typeof decision.file === 'string' &&
                typeof decision.clusterId === 'string' &&
                typeof decision.cropPath === 'string'
            )).length
        }
    );
    assertCondition(
        checks,
        (humanReviewInput.decisions ?? []).every((decision) => (
            Object.hasOwn(decision, 'humanVerdict') &&
            Object.hasOwn(decision, 'humanConfidence') &&
            Object.hasOwn(decision, 'humanNotes') &&
            typeof decision.file === 'string' &&
            typeof decision.cropPath === 'string'
        )),
        'human review input is file/crop-addressable with human decision fields',
        {
            invalidDecisionCount: (humanReviewInput.decisions ?? []).filter((decision) => !(
                Object.hasOwn(decision, 'humanVerdict') &&
                Object.hasOwn(decision, 'humanConfidence') &&
                Object.hasOwn(decision, 'humanNotes') &&
                typeof decision.file === 'string' &&
                typeof decision.cropPath === 'string'
            )).length,
            filledDecisionCount: (humanReviewInput.decisions ?? []).filter((decision) => (
                decision.humanVerdict !== null || decision.humanConfidence !== null
            )).length
        }
    );
    assertCondition(
        checks,
        (goldCandidateConfirmationInput.decisions ?? []).every((decision) => (
            Object.hasOwn(decision, 'humanVerdict') &&
            Object.hasOwn(decision, 'humanConfidence') &&
            Object.hasOwn(decision, 'humanNotes') &&
            typeof decision.suggestedVerdict === 'string' &&
            typeof decision.file === 'string' &&
            typeof decision.cropPath === 'string'
        )),
        'gold candidate confirmation input is file/crop-addressable with suggested verdicts',
        {
            invalidDecisionCount: (goldCandidateConfirmationInput.decisions ?? []).filter((decision) => !(
                Object.hasOwn(decision, 'humanVerdict') &&
                Object.hasOwn(decision, 'humanConfidence') &&
                Object.hasOwn(decision, 'humanNotes') &&
                typeof decision.suggestedVerdict === 'string' &&
                typeof decision.file === 'string' &&
                typeof decision.cropPath === 'string'
            )).length,
            filledDecisionCount: (goldCandidateConfirmationInput.decisions ?? []).filter((decision) => (
                decision.humanVerdict !== null || decision.humanConfidence !== null
            )).length
        }
    );
    assertCondition(
        checks,
        JSON.stringify(humanReviewPackSummary.profileCounts) === JSON.stringify(reviewManifest.summary?.pendingProfileCounts),
        'human review pack profile counts match review manifest pending profiles',
        {
            pack: humanReviewPackSummary.profileCounts,
            manifest: reviewManifest.summary?.pendingProfileCounts
        }
    );
    const totalReviewDecisions = (reviewManifest.summary?.visibleTopPending ?? 0) +
        (reviewManifest.summary?.metricPassVisibleReviewed ?? 0);
    const validationProgressIsConsistent = humanReviewValidation.readyForGoldMigration === true
        ? humanReviewValidation.unconfirmedCount === 0 &&
            humanReviewValidation.readyDecisionCount === totalReviewDecisions
        : humanReviewValidation.unconfirmedCount > 0 &&
            humanReviewValidation.readyDecisionCount < totalReviewDecisions;
    assertCondition(
        checks,
        humanReviewValidation.pendingTotal === reviewManifest.summary?.visibleTopPending &&
            humanReviewValidation.goldCandidateTotal === reviewManifest.summary?.metricPassVisibleReviewed &&
            humanReviewValidation.decisionTotal === reviewManifest.summary?.visibleTopPending &&
            humanReviewValidation.candidateDecisionTotal === reviewManifest.summary?.metricPassVisibleReviewed &&
            humanReviewValidation.structuralErrorCount === 0 &&
            humanReviewValidation.decisionSchemaGate?.armed === true &&
            humanReviewValidation.decisionSchemaGate?.appliesToHumanReviewDecisionInputs === true &&
            humanReviewValidation.decisionSchemaGate?.rejectsAlphaProfileVariantFields === true &&
            humanReviewValidation.decisionSchemaGate?.rejectsUnknownDecisionFields === true &&
            humanReviewValidation.decisionSchemaGate?.rejectsUnknownDecisionInputRootFields === true &&
            humanReviewValidation.decisionSchemaGate?.ok === true &&
            validationProgressIsConsistent,
        'human review validation progress is consistent and human-gated',
        {
            readyForGoldMigration: humanReviewValidation.readyForGoldMigration,
            pendingTotal: humanReviewValidation.pendingTotal,
            goldCandidateTotal: humanReviewValidation.goldCandidateTotal,
            decisionTotal: humanReviewValidation.decisionTotal,
            candidateDecisionTotal: humanReviewValidation.candidateDecisionTotal,
            unconfirmedCount: humanReviewValidation.unconfirmedCount,
            pendingUnconfirmedCount: humanReviewValidation.pendingUnconfirmedCount,
            goldCandidateUnconfirmedCount: humanReviewValidation.goldCandidateUnconfirmedCount,
            structuralErrorCount: humanReviewValidation.structuralErrorCount,
            decisionSchemaGate: humanReviewValidation.decisionSchemaGate,
            readyDecisionCount: humanReviewValidation.readyDecisionCount,
            totalReviewDecisions
        }
    );
    assertCondition(
        checks,
        (humanReviewValidation.incompleteDecisions ?? []).every((decision) => typeof decision.clusterId === 'string') &&
            (humanReviewValidation.readyDecisions ?? []).every((decision) => typeof decision.clusterId === 'string') &&
            (humanReviewValidation.incompleteDecisions ?? []).every((decision) => (
                typeof decision.decisionInputPath === 'string' &&
                Number.isInteger(decision.decisionArrayIndex) &&
                typeof decision.decisionJsonPath === 'string'
            )) &&
            (humanReviewValidation.readyDecisions ?? []).every((decision) => (
                typeof decision.decisionInputPath === 'string' &&
                Number.isInteger(decision.decisionArrayIndex) &&
                typeof decision.decisionJsonPath === 'string'
            )),
        'human review validation exposes stable cluster ids and JSON decision locators',
        {
            incompleteWithoutClusterId: (humanReviewValidation.incompleteDecisions ?? []).filter((decision) => (
                typeof decision.clusterId !== 'string'
            )).length,
            readyWithoutClusterId: (humanReviewValidation.readyDecisions ?? []).filter((decision) => (
                typeof decision.clusterId !== 'string'
            )).length,
            incompleteWithoutDecisionLocator: (humanReviewValidation.incompleteDecisions ?? []).filter((decision) => !(
                typeof decision.decisionInputPath === 'string' &&
                Number.isInteger(decision.decisionArrayIndex) &&
                typeof decision.decisionJsonPath === 'string'
            )).length,
            readyWithoutDecisionLocator: (humanReviewValidation.readyDecisions ?? []).filter((decision) => !(
                typeof decision.decisionInputPath === 'string' &&
                Number.isInteger(decision.decisionArrayIndex) &&
                typeof decision.decisionJsonPath === 'string'
            )).length
        }
    );
    assertCondition(
        checks,
        validateHumanReviewScript.includes('sourceSet-mismatch') &&
            validateHumanReviewScript.includes('clusterId-mismatch') &&
            validateHumanReviewScript.includes('review-manifest-sha256-mismatch') &&
            validateHumanReviewScript.includes('expectedClusterId') &&
            validateHumanReviewScript.includes('actualClusterId') &&
            validateHumanReviewScript.includes('decisionJsonPath') &&
            validateHumanReviewScript.includes('decisionArrayIndex') &&
            validateHumanReviewScript.includes('decision-index-mismatch') &&
            validateHumanReviewScript.includes('decision-input-alpha-profile-variant-fields-present') &&
            validateHumanReviewScript.includes('decision-input-unknown-root-fields-present') &&
            validateHumanReviewScript.includes('decision-alpha-profile-variant-fields-present') &&
            validateHumanReviewScript.includes('decision-unknown-fields-present') &&
            validateHumanReviewScript.includes('ALLOWED_DECISION_FIELD_KEYS') &&
            validateHumanReviewScript.includes('ALLOWED_DECISION_INPUT_ROOT_KEYS') &&
            validateHumanReviewScript.includes('FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS') &&
            validateHumanReviewScript.includes('decisionSchemaGate') &&
            validateHumanReviewScript.includes('review-input-contract-manifest-hash-mismatch') &&
            validateHumanReviewScript.includes('review-input-contract-visibleTopPending-count-mismatch'),
        'human review validation rejects stale cluster/source/index ids, stale input contracts, and emits decision locators',
        { scriptPath: validateHumanReviewScriptPath }
    );
    assertCondition(
        checks,
        humanReviewValidation.policy?.writesFormalGoldManifest === false &&
            humanReviewValidation.policy?.writesProductionAlgorithm === false,
        'human review validation is read-only for gold and production algorithm',
        { policy: humanReviewValidation.policy }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:create-gold-manifest'] === 'node scripts/create-visible-residual-gold-manifest.js',
        'package script exposes fail-closed visible residual gold manifest migration entrypoint',
        { script: packageJson.scripts?.['visible-residual:create-gold-manifest'] }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:review-status'] === 'node scripts/report-visible-residual-review-progress.js',
        'package script exposes read-only visible residual human review progress entrypoint',
        { script: packageJson.scripts?.['visible-residual:review-status'] }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:apply-focused-batch'] === 'node scripts/apply-visible-residual-focused-review-batch.js',
        'package script exposes fail-closed focused visible residual review batch apply entrypoint',
        { script: packageJson.scripts?.['visible-residual:apply-focused-batch'] }
    );
    assertCondition(
        checks,
        applyFocusedBatchScript.includes('DEFAULT_BATCH_PATH') &&
            applyFocusedBatchScript.includes('review-focused-batch.json') &&
            applyFocusedBatchScript.includes('focused-batch-validation-hash-mismatch') &&
            applyFocusedBatchScript.includes('focused-batch-review-manifest-hash-mismatch') &&
            applyFocusedBatchScript.includes('focused-batch-review-cluster-hash-mismatch') &&
            applyFocusedBatchScript.includes('focused-batch-invalid-or-missing-humanVerdict') &&
            applyFocusedBatchScript.includes('focused-batch-invalid-or-missing-humanConfidence') &&
            applyFocusedBatchScript.includes('focused-batch-humanNotes-required') &&
            applyFocusedBatchScript.includes('focused-batch-duplicate-target') &&
            applyFocusedBatchScript.includes('focused-batch-decision-json-path-mismatch') &&
            applyFocusedBatchScript.includes('writesFormalGoldManifest: false') &&
            applyFocusedBatchScript.includes('writesProductionAlgorithm: false') &&
            applyFocusedBatchScript.includes('allowsAlphaProfileProduction: false') &&
            applyFocusedBatchScript.includes('skippedWrite') &&
            applyFocusedBatchScript.includes('dryRun') &&
            applyFocusedBatchScript.includes('batchSha256') &&
            applyFocusedBatchScript.includes('decisionsBeforeSha256') &&
            applyFocusedBatchScript.includes('decisionsAfterSha256') &&
            applyFocusedBatchScript.includes('candidateDecisionsBeforeSha256') &&
            applyFocusedBatchScript.includes('candidateDecisionsAfterSha256') &&
            applyFocusedBatchScript.includes('changedTargets'),
        'focused review batch apply script validates provenance, audits before/after hashes, and stays limited to human review inputs',
        { scriptPath: applyFocusedBatchScriptPath }
    );
    assertCondition(
        checks,
        reviewProgressScript.includes('DEFAULT_REVIEW_CLUSTER_PATH') &&
            reviewProgressScript.includes('--clusters') &&
            reviewProgressScript.includes('--output') &&
            reviewProgressScript.includes('--checkpoint-output') &&
            reviewProgressScript.includes('--focused-batch-output') &&
            reviewProgressScript.includes('validationReportSha256') &&
            reviewProgressScript.includes('reviewManifestSha256') &&
            reviewProgressScript.includes('reviewClusterSha256') &&
            reviewProgressScript.includes('writesReviewProgressReport') &&
            reviewProgressScript.includes('writesReviewCheckpoint') &&
            reviewProgressScript.includes('writesFocusedReviewBatch') &&
            reviewProgressScript.includes('buildReviewCheckpoint') &&
            reviewProgressScript.includes('buildFocusedReviewBatch') &&
            reviewProgressScript.includes('reviewCheckpoint') &&
            reviewProgressScript.includes('focusedReviewBatch') &&
            reviewProgressScript.includes('nextReviewClusters') &&
            reviewProgressScript.includes('nextReviewBatch') &&
            reviewProgressScript.includes('reviewBatches') &&
            reviewProgressScript.includes('goldCandidateReviewBatches') &&
            reviewProgressScript.includes('nextGoldCandidateReviewBatch') &&
            reviewProgressScript.includes('buildReviewBatches') &&
            reviewProgressScript.includes('sortIncompleteByClusterPriority') &&
            reviewProgressScript.includes('incompleteByCluster') &&
            reviewProgressScript.includes('review-cluster-report-manifest-hash-mismatch') &&
            reviewProgressScript.includes('review-cluster-report-validation-hash-mismatch') &&
            reviewProgressScript.includes('skippedWrite'),
        'review status exposes cluster-aware guidance and rejects stale cluster reports',
        { scriptPath: reviewProgressScriptPath }
    );
    assertCondition(
        checks,
        reviewProgressReport.policy?.readOnly === true &&
            reviewProgressReport.policy?.writesFormalGoldManifest === false &&
            reviewProgressReport.policy?.writesProductionAlgorithm === false &&
            reviewProgressReport.inputs?.validationReportSha256 === humanReviewValidationSha256 &&
            reviewProgressReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            reviewProgressReport.inputs?.reviewClusterSha256 === reviewClusterReportSha256 &&
            reviewProgressReport.summary?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            reviewProgressReport.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            reviewProgressReport.summary?.totalReviewDecisions ===
                (humanReviewValidation.pendingTotal ?? 0) + (humanReviewValidation.goldCandidateTotal ?? 0) &&
            reviewProgressReport.clusterSummary?.clusterTotal === reviewClusterReport.summary?.clusterTotal &&
            reviewProgressReport.clusterSummary?.clusterSheetCount === reviewClusterReport.summary?.clusterSheetCount &&
            JSON.stringify(reviewProgressReport.counts?.incompleteByCluster) === JSON.stringify(expectedIncompleteByCluster(reviewClusterReport)) &&
            reviewProgressReport.nextReviewClusters?.[0]?.clusterId === sortedIncompleteClusters(reviewClusterReport)[0]?.clusterId &&
            reviewProgressReport.nextReviewBatch?.cluster?.clusterId === reviewProgressReport.nextReviewClusters?.[0]?.clusterId &&
            reviewProgressReport.nextReviewItems?.[0]?.clusterId === reviewProgressReport.nextReviewClusters?.[0]?.clusterId &&
            typeof reviewProgressReport.nextReviewItems?.[0]?.decisionInputPath === 'string' &&
            typeof reviewProgressReport.nextReviewItems?.[0]?.decisionJsonPath === 'string' &&
            reviewProgressReport.reviewBatches?.length === expectedSortedIncompleteClusters.length &&
            reviewProgressReport.reviewBatches?.[0]?.clusterId === reviewProgressReport.nextReviewBatch?.cluster?.clusterId &&
            reviewProgressReport.reviewBatches?.[0]?.firstDecisionJsonPath === reviewProgressReport.nextReviewBatch?.items?.[0]?.decisionJsonPath &&
            reviewProgressReport.reviewBatches?.every((batch) => (
                typeof batch.firstDecisionInputPath === 'string' &&
                typeof batch.firstDecisionJsonPath === 'string' &&
                Array.isArray(batch.items) &&
                batch.items.length === batch.itemCount
            )) &&
            reviewProgressReport.reviewBatches
                .reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0) === expectedIncompleteDecisionTotal &&
            reviewProgressReport.goldCandidateReviewBatches?.length === expectedGoldCandidateClusters.length &&
            reviewProgressReport.goldCandidateReviewBatches
                .reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0) === expectedGoldCandidateDecisionTotal &&
            reviewProgressReport.nextGoldCandidateReviewBatch?.clusterId === reviewProgressReport.goldCandidateReviewBatches?.[0]?.clusterId &&
            reviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionInputPath === goldCandidateConfirmationInputPath &&
            reviewProgressReport.reviewCheckpoint?.status === 'human-review-required' &&
            reviewProgressReport.reviewCheckpoint?.policy?.writesFormalGoldManifest === false &&
            reviewProgressReport.reviewCheckpoint?.policy?.writesProductionAlgorithm === false &&
            reviewProgressReport.reviewCheckpoint?.policy?.allowsAlphaProfileProduction === false &&
            reviewProgressReport.reviewCheckpoint?.provenance?.validationReportSha256 === humanReviewValidationSha256 &&
            reviewProgressReport.reviewCheckpoint?.provenance?.reviewManifestSha256 === reviewManifestSha256 &&
            reviewProgressReport.reviewCheckpoint?.provenance?.reviewClusterSha256 === reviewClusterReportSha256 &&
            reviewProgressReport.focusedReviewBatch?.policy?.writesFormalGoldManifest === false &&
            reviewProgressReport.focusedReviewBatch?.policy?.writesProductionAlgorithm === false &&
            reviewProgressReport.focusedReviewBatch?.policy?.allowsAlphaProfileProduction === false &&
            reviewProgressReport.focusedReviewBatch?.policy?.applyCommand === 'pnpm visible-residual:apply-focused-batch' &&
            reviewProgressReport.focusedReviewBatch?.provenance?.validationReportSha256 === humanReviewValidationSha256 &&
            reviewProgressReport.focusedReviewBatch?.provenance?.reviewManifestSha256 === reviewManifestSha256 &&
            reviewProgressReport.focusedReviewBatch?.provenance?.reviewClusterSha256 === reviewClusterReportSha256 &&
            decisionTargetsMatchItems(
                reviewProgressReport.reviewCheckpoint?.nextReviewRound?.visibleResidualBatch?.decisionTargets,
                reviewProgressReport.nextReviewBatch?.items
            ) &&
            decisionTargetsMatchItems(
                reviewProgressReport.reviewCheckpoint?.nextReviewRound?.goldCandidateBatch?.decisionTargets,
                reviewProgressReport.nextGoldCandidateReviewBatch?.items
            ) &&
            decisionTargetsMatchItems(
                reviewProgressReport.focusedReviewBatch?.decisions?.filter((item) => item.sourceSet === 'visibleTopPending'),
                reviewProgressReport.nextReviewBatch?.items
            ) &&
            decisionTargetsMatchItems(
                reviewProgressReport.focusedReviewBatch?.decisions?.filter((item) => item.sourceSet === 'metricPassVisible'),
                reviewProgressReport.nextGoldCandidateReviewBatch?.items
            ),
        'review status output mirrors validation and cluster artifacts',
        {
            readyForGoldMigration: reviewProgressReport.summary?.readyForGoldMigration,
            unconfirmedCount: reviewProgressReport.summary?.unconfirmedCount,
            clusterTotal: reviewProgressReport.clusterSummary?.clusterTotal,
            validationReportSha256: reviewProgressReport.inputs?.validationReportSha256,
            reviewManifestSha256: reviewProgressReport.inputs?.reviewManifestSha256,
            reviewClusterSha256: reviewProgressReport.inputs?.reviewClusterSha256,
            topCluster: reviewProgressReport.nextReviewClusters?.[0]?.clusterId,
            firstItemCluster: reviewProgressReport.nextReviewItems?.[0]?.clusterId,
            firstItemDecisionJsonPath: reviewProgressReport.nextReviewItems?.[0]?.decisionJsonPath,
            reviewBatchCount: reviewProgressReport.reviewBatches?.length,
            goldCandidateReviewBatchCount: reviewProgressReport.goldCandidateReviewBatches?.length,
            reviewCheckpoint: reviewProgressReport.reviewCheckpoint
        }
    );
    assertCondition(
        checks,
        humanReviewProgressReport.policy?.readOnly === true &&
            humanReviewProgressReport.policy?.writesReviewProgressReport === true &&
            humanReviewProgressReport.policy?.writesReviewCheckpoint === true &&
            humanReviewProgressReport.policy?.writesFocusedReviewBatch === true &&
            humanReviewProgressReport.policy?.writesFormalGoldManifest === false &&
            humanReviewProgressReport.policy?.writesProductionAlgorithm === false &&
            humanReviewProgressReport.outputs?.reviewProgressReportPath === humanReviewProgressReportPath &&
            humanReviewProgressReport.outputs?.reviewCheckpointPath === humanReviewCheckpointPath &&
            humanReviewProgressReport.outputs?.focusedReviewBatchPath === focusedReviewBatchPath &&
            humanReviewProgressReport.inputs?.validationReportSha256 === humanReviewValidationSha256 &&
            humanReviewProgressReport.inputs?.reviewManifestSha256 === reviewManifestSha256 &&
            humanReviewProgressReport.inputs?.reviewClusterSha256 === reviewClusterReportSha256 &&
            humanReviewProgressReport.summary?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            humanReviewProgressReport.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            humanReviewProgressReport.clusterSummary?.clusterTotal === reviewClusterReport.summary?.clusterTotal &&
            JSON.stringify(humanReviewProgressReport.counts?.incompleteByCluster) === JSON.stringify(expectedIncompleteByCluster(reviewClusterReport)) &&
            humanReviewProgressReport.nextReviewClusters?.[0]?.clusterId === sortedIncompleteClusters(reviewClusterReport)[0]?.clusterId &&
            humanReviewProgressReport.nextReviewBatch?.cluster?.clusterId === humanReviewProgressReport.nextReviewClusters?.[0]?.clusterId &&
            humanReviewProgressReport.nextReviewItems?.[0]?.clusterId === humanReviewProgressReport.nextReviewClusters?.[0]?.clusterId &&
            typeof humanReviewProgressReport.nextReviewItems?.[0]?.decisionInputPath === 'string' &&
            typeof humanReviewProgressReport.nextReviewItems?.[0]?.decisionJsonPath === 'string' &&
            humanReviewProgressReport.reviewBatches?.length === expectedSortedIncompleteClusters.length &&
            humanReviewProgressReport.reviewBatches?.[0]?.clusterId === humanReviewProgressReport.nextReviewBatch?.cluster?.clusterId &&
            humanReviewProgressReport.reviewBatches?.[0]?.firstDecisionJsonPath === humanReviewProgressReport.nextReviewBatch?.items?.[0]?.decisionJsonPath &&
            humanReviewProgressReport.reviewBatches?.every((batch) => (
                typeof batch.firstDecisionInputPath === 'string' &&
                typeof batch.firstDecisionJsonPath === 'string' &&
                Array.isArray(batch.items) &&
                batch.items.length === batch.itemCount
            )) &&
            humanReviewProgressReport.reviewBatches
                .reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0) === expectedIncompleteDecisionTotal &&
            humanReviewProgressReport.goldCandidateReviewBatches?.length === expectedGoldCandidateClusters.length &&
            humanReviewProgressReport.goldCandidateReviewBatches
                .reduce((sum, batch) => sum + (batch.totalIncompleteInCluster ?? 0), 0) === expectedGoldCandidateDecisionTotal &&
            humanReviewProgressReport.nextGoldCandidateReviewBatch?.clusterId === humanReviewProgressReport.goldCandidateReviewBatches?.[0]?.clusterId &&
            humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionInputPath === goldCandidateConfirmationInputPath &&
            humanReviewProgressReport.reviewCheckpoint?.status === humanReviewCheckpoint.status &&
            JSON.stringify(humanReviewProgressReport.reviewCheckpoint) === JSON.stringify(humanReviewCheckpoint) &&
            JSON.stringify(humanReviewProgressReport.focusedReviewBatch) === JSON.stringify(focusedReviewBatch),
        'persisted review progress report mirrors validation and cluster artifacts',
        {
            reportPath: humanReviewProgressReportPath,
            unconfirmedCount: humanReviewProgressReport.summary?.unconfirmedCount,
            validationReportSha256: humanReviewProgressReport.inputs?.validationReportSha256,
            reviewManifestSha256: humanReviewProgressReport.inputs?.reviewManifestSha256,
            reviewClusterSha256: humanReviewProgressReport.inputs?.reviewClusterSha256,
            topCluster: humanReviewProgressReport.nextReviewClusters?.[0]?.clusterId,
            firstItemCluster: humanReviewProgressReport.nextReviewItems?.[0]?.clusterId,
            firstItemDecisionJsonPath: humanReviewProgressReport.nextReviewItems?.[0]?.decisionJsonPath,
            reviewBatchCount: humanReviewProgressReport.reviewBatches?.length,
            goldCandidateReviewBatchCount: humanReviewProgressReport.goldCandidateReviewBatches?.length,
            checkpointPath: humanReviewCheckpointPath
        }
    );
    assertCondition(
        checks,
        humanReviewCheckpoint.status === 'human-review-required' &&
            humanReviewCheckpoint.policy?.requiresHumanJudgement === true &&
            humanReviewCheckpoint.policy?.writesFormalGoldManifest === false &&
            humanReviewCheckpoint.policy?.writesProductionAlgorithm === false &&
            humanReviewCheckpoint.policy?.allowsAlphaProfileProduction === false &&
            humanReviewCheckpoint.provenance?.validationReportSha256 === humanReviewValidationSha256 &&
            humanReviewCheckpoint.provenance?.reviewManifestSha256 === reviewManifestSha256 &&
            humanReviewCheckpoint.provenance?.reviewClusterSha256 === reviewClusterReportSha256 &&
            humanReviewCheckpoint.summary?.readyForGoldMigration === humanReviewValidation.readyForGoldMigration &&
            humanReviewCheckpoint.summary?.unconfirmedCount === humanReviewValidation.unconfirmedCount &&
            humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch?.firstDecisionInputPath === humanReviewInputPath &&
            humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch?.firstDecisionInputPath === goldCandidateConfirmationInputPath &&
            humanReviewCheckpoint.nextReviewRound?.editInputs?.includes(humanReviewInputPath) &&
            humanReviewCheckpoint.nextReviewRound?.editInputs?.includes(goldCandidateConfirmationInputPath) &&
            humanReviewCheckpoint.nextReviewRound?.afterEditCommands?.includes('pnpm visible-residual:validate-human-review') &&
            decisionTargetsMatchItems(
                humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch?.decisionTargets,
                humanReviewProgressReport.nextReviewBatch?.items
            ) &&
            decisionTargetsMatchItems(
                humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch?.decisionTargets,
                humanReviewProgressReport.nextGoldCandidateReviewBatch?.items
            ) &&
            humanReviewCheckpoint.completionRequiredState?.readyForGoldMigration === true &&
            humanReviewCheckpoint.completionRequiredState?.unconfirmedCount === 0 &&
            humanReviewCheckpoint.completionRequiredState?.structuralErrorCount === 0 &&
            humanReviewCheckpoint.blockedActions?.some((item) => (
                item.id === 'write-formal-gold-manifest' &&
                item.blocked === true &&
                item.reason === 'human-review-not-complete'
            )) &&
            humanReviewCheckpoint.blockedActions?.some((item) => (
                item.id === 'productionize-alpha-profile-variant' &&
                item.blocked === true
            )),
        'review checkpoint gives a current human-executable batch while keeping gold and production blocked',
        {
            checkpointPath: humanReviewCheckpointPath,
            summary: humanReviewCheckpoint.summary,
            visibleResidualBatch: humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch,
            goldCandidateBatch: humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch,
            blockedActions: humanReviewCheckpoint.blockedActions
        }
    );
    assertCondition(
        checks,
        focusedReviewBatch.schemaVersion === 1 &&
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
            focusedReviewBatch.provenance?.validationReportSha256 === humanReviewValidationSha256 &&
            focusedReviewBatch.provenance?.reviewManifestSha256 === reviewManifestSha256 &&
            focusedReviewBatch.provenance?.reviewClusterSha256 === reviewClusterReportSha256 &&
            focusedReviewBatch.sourceBatches?.visibleResidualBatch?.clusterId === humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch?.clusterId &&
            focusedReviewBatch.sourceBatches?.goldCandidateBatch?.clusterId === humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch?.clusterId &&
            focusedReviewBatch.decisions?.length === (
                (humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch?.decisionTargets?.length ?? 0) +
                (humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch?.decisionTargets?.length ?? 0)
            ) &&
            focusedReviewBatch.decisions?.every((decision) => (
                decision.humanVerdict === null &&
                decision.humanConfidence === null &&
                decision.humanNotes === '' &&
                typeof decision.decisionInputPath === 'string' &&
                typeof decision.decisionJsonPath === 'string' &&
                typeof decision.cropPath === 'string' &&
                existsSync(decision.cropPath)
            )) &&
            focusedReviewBatch.blockedActions?.some((item) => (
                item.id === 'write-formal-gold-manifest' &&
                item.blocked === true
            )) &&
            focusedReviewBatch.blockedActions?.some((item) => (
                item.id === 'productionize-alpha-profile-variant' &&
                item.blocked === true
            )),
        'focused review batch narrows current human edits without gold or production writes',
        {
            focusedReviewBatchPath,
            decisionCount: focusedReviewBatch.decisions?.length,
            sourceBatches: focusedReviewBatch.sourceBatches,
            policy: focusedReviewBatch.policy
        }
    );
    assertCondition(
        checks,
        reviewHandoffText.includes('# Visible Residual Review Handoff') &&
            reviewHandoffText.includes(humanReviewValidationSha256) &&
            reviewHandoffText.includes(reviewManifestSha256) &&
            reviewHandoffText.includes(reviewClusterReportSha256) &&
            reviewHandoffText.includes(focusedReviewBatchPath) &&
            reviewHandoffText.includes('Focused Batch Editing Checklist') &&
            reviewHandoffText.includes('Edit only: humanVerdict, humanConfidence, humanNotes') &&
            reviewHandoffText.includes('humanVerdict allowed values: trueVisibleResidual') &&
            reviewHandoffText.includes('humanConfidence allowed values: high, medium, low') &&
            reviewHandoffText.includes('humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation') &&
            reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch --dry-run') &&
            reviewHandoffText.includes('rtk pnpm visible-residual:apply-focused-batch') &&
            reviewHandoffText.includes('rtk pnpm visible-residual:validate-human-review') &&
            (
                !humanReviewCheckpoint.nextReviewRound?.visibleResidualBatch?.sheetPath ||
                (
                    reviewHandoffText.includes('![Visible residual cluster sheet](') &&
                    reviewHandoffText.includes(humanReviewCheckpoint.nextReviewRound.visibleResidualBatch.sheetPath.replace(/\\/g, '/'))
                )
            ) &&
            (
                !humanReviewCheckpoint.nextReviewRound?.goldCandidateBatch?.sheetPath ||
                (
                    reviewHandoffText.includes('![Gold candidate cluster sheet](') &&
                    reviewHandoffText.includes(humanReviewCheckpoint.nextReviewRound.goldCandidateBatch.sheetPath.replace(/\\/g, '/'))
                )
            ) &&
            handoffIncludesDecisionCropPreviews(reviewHandoffText, focusedReviewBatch.decisions ?? []) &&
            reviewHandoffText.includes('writesFormalGoldManifest: false') &&
            reviewHandoffText.includes('writesProductionAlgorithm: false') &&
            reviewHandoffText.includes('allowsAlphaProfileProduction: false') &&
            reviewHandoffText.includes(humanReviewProgressReport.nextReviewBatch?.items?.[0]?.decisionJsonPath ?? '') &&
            reviewHandoffText.includes(humanReviewProgressReport.nextGoldCandidateReviewBatch?.firstDecisionJsonPath ?? ''),
        'review handoff markdown is current and human-executable without gold or production writes',
        {
            reviewHandoffPath,
            reviewHandoffSha256,
            validationReportSha256: humanReviewValidationSha256,
            reviewManifestSha256,
            reviewClusterReportSha256,
            focusedReviewBatchPath
        }
    );
    const loopStepOrder = {
        validateHumanReview: runVisibleResidualLoopScript.indexOf('scripts/validate-visible-residual-human-review.js'),
        createClusterReport: runVisibleResidualLoopScript.indexOf('scripts/create-visible-residual-cluster-report.js'),
        createAdmissionReport: runVisibleResidualLoopScript.indexOf('scripts/create-visible-residual-admission-report.js'),
        createReviewWorksheet: runVisibleResidualLoopScript.indexOf('scripts/create-visible-residual-review-worksheet.js'),
        reportReviewProgress: runVisibleResidualLoopScript.indexOf('scripts/report-visible-residual-review-progress.js'),
        createGoalAudit: runVisibleResidualLoopScript.indexOf('scripts/create-visible-residual-goal-audit-report.js'),
        finalVerifier: runVisibleResidualLoopScript.indexOf('scripts/verify-visible-residual-loop.js')
    };
    const loopStepOrderReady = Object.values(loopStepOrder).every((index) => index >= 0) &&
        loopStepOrder.validateHumanReview < loopStepOrder.createClusterReport &&
        loopStepOrder.createClusterReport < loopStepOrder.createAdmissionReport &&
        loopStepOrder.createClusterReport < loopStepOrder.createReviewWorksheet &&
        loopStepOrder.createClusterReport < loopStepOrder.reportReviewProgress &&
        loopStepOrder.createAdmissionReport < loopStepOrder.createGoalAudit &&
        loopStepOrder.createReviewWorksheet < loopStepOrder.createGoalAudit &&
        loopStepOrder.reportReviewProgress < loopStepOrder.createGoalAudit &&
        loopStepOrder.createGoalAudit < loopStepOrder.finalVerifier;
    const activeLoopAllowStateCount = (runVisibleResidualLoopScript.match(/--allow-active-loop-state/g) ?? []).length;
    assertCondition(
        checks,
            runVisibleResidualLoopScript.includes('scripts/report-visible-residual-review-progress.js') &&
            runVisibleResidualLoopScript.includes('report human review progress') &&
            runVisibleResidualLoopScript.includes('--clusters') &&
            runVisibleResidualLoopScript.includes('--output') &&
            runVisibleResidualLoopScript.includes('--checkpoint-output') &&
            runVisibleResidualLoopScript.includes('--focused-batch-output') &&
            runVisibleResidualLoopScript.includes('review-progress-report.json') &&
            runVisibleResidualLoopScript.includes('review-checkpoint.json') &&
            runVisibleResidualLoopScript.includes('review-focused-batch.json') &&
            runVisibleResidualLoopScript.includes('loop-run-state.json') &&
            runVisibleResidualLoopScript.includes('writeLoopRunState') &&
            runVisibleResidualLoopScript.includes('clearLoopRunState') &&
            runVisibleResidualLoopScript.includes('--allow-active-loop-state') &&
            activeLoopAllowStateCount >= 7 &&
            runVisibleResidualLoopScript.includes('scripts/create-visible-residual-review-worksheet.js') &&
            runVisibleResidualLoopScript.includes('review-table.csv') &&
            runVisibleResidualLoopScript.includes('scripts/create-visible-residual-goal-audit-report.js') &&
            runVisibleResidualLoopScript.includes('create goal audit report') &&
            runVisibleResidualLoopScript.includes('scripts/verify-visible-residual-loop.js') &&
            runVisibleResidualLoopScript.includes('readyForGoldMigration') &&
            runVisibleResidualLoopScript.includes('unconfirmedCount') &&
            runVisibleResidualLoopScript.includes('productionProfileAllowed') &&
            runVisibleResidualLoopScript.includes('productionGateContractReady') &&
            runVisibleResidualLoopScript.includes('productionHitCount') &&
            runVisibleResidualLoopScript.includes('productionArtifactHitCount') &&
            runVisibleResidualLoopScript.includes('packageScriptGateReady') &&
            runVisibleResidualLoopScript.includes('packageJsonSha256') &&
            runVisibleResidualLoopScript.includes('visibleResidualPackageScriptCount') &&
            runVisibleResidualLoopScript.includes('forbiddenVisibleResidualPackageScriptCount') &&
            runVisibleResidualLoopScript.includes('unclassifiedVisibleResidualPackageScriptCount') &&
            runVisibleResidualLoopScript.includes('goalAuditStatus') &&
            runVisibleResidualLoopScript.includes('algorithm-admission-human-gated') &&
            loopStepOrderReady,
        'visible residual loop refreshes review guidance and goal audit before final verifier',
        { scriptPath: runVisibleResidualLoopScriptPath, loopStepOrder, activeLoopAllowStateCount }
    );
    const activeLoopGuardedScripts = [
        {
            name: 'validate-human-review',
            script: validateHumanReviewScript,
            path: validateHumanReviewScriptPath,
            command: 'visible-residual:validate-human-review'
        },
        {
            name: 'cluster-report',
            script: clusterReportScript,
            path: clusterReportScriptPath,
            command: 'visible-residual:cluster-report'
        },
        {
            name: 'review-worksheet',
            script: reviewWorksheetScript,
            path: reviewWorksheetScriptPath,
            command: 'visible-residual:review-worksheet'
        },
        {
            name: 'review-status',
            script: reviewProgressScript,
            path: reviewProgressScriptPath,
            command: 'visible-residual:review-status'
        },
        {
            name: 'apply-focused-batch',
            script: applyFocusedBatchScript,
            path: applyFocusedBatchScriptPath,
            command: 'visible-residual:apply-focused-batch'
        },
        {
            name: 'admission-report',
            script: admissionReportScript,
            path: admissionReportScriptPath,
            command: 'visible-residual:admission-report'
        },
        {
            name: 'goal-audit',
            script: goalAuditScript,
            path: goalAuditScriptPath,
            command: 'visible-residual:goal-audit'
        },
        {
            name: 'create-gold-manifest',
            script: goldManifestScript,
            path: goldManifestScriptPath,
            command: 'visible-residual:create-gold-manifest'
        }
    ];
    assertCondition(
        checks,
        activeLoopGuardedScripts.every(({ script }) => (
            script.includes('readActiveLoopRunState') &&
            script.includes('active-visible-residual-loop') &&
            script.includes('skippedWrite') &&
            script.includes('--allow-active-loop-state')
        )),
        'external visible residual write entrypoints fail fast during active loop artifact refresh',
        {
            guardedScripts: activeLoopGuardedScripts.map(({ name, path: scriptPath, command, script }) => ({
                name,
                scriptPath,
                command,
                hasReader: script.includes('readActiveLoopRunState'),
                hasProblemCode: script.includes('active-visible-residual-loop'),
                hasSkippedWrite: script.includes('skippedWrite'),
                hasAllowFlag: script.includes('--allow-active-loop-state')
            }))
        }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:review-worksheet'] === 'node scripts/create-visible-residual-review-worksheet.js',
        'package script exposes visible residual human review worksheet entrypoint',
        { script: packageJson.scripts?.['visible-residual:review-worksheet'] }
    );
    const humanReviewPackGroupedSheetHashesReady = (await Promise.all(
        Object.entries(humanReviewPackSummary.groupedSheets ?? {}).map(async ([profile, sheet]) => (
            humanReviewPackSummary.artifactHashes?.groupedSheets?.[profile]?.outputPath === sheet.outputPath &&
            humanReviewPackSummary.artifactHashes?.groupedSheets?.[profile]?.sha256 === await sha256File(sheet.outputPath)
        ))
    )).every(Boolean);
    assertCondition(
        checks,
        reviewInputContract.reviewManifestSha256 === reviewManifestSha256 &&
            JSON.stringify(reviewInputContract.allowedHumanVerdicts) === JSON.stringify(humanReviewTemplate.instructions?.verdicts) &&
            JSON.stringify(reviewInputContract.allowedHumanConfidence) === JSON.stringify(humanReviewTemplate.instructions?.confidence) &&
            Array.isArray(reviewInputContract.allowedDecisionInputRootFields) &&
            reviewInputContract.allowedDecisionInputRootFields.includes('schemaVersion') &&
            reviewInputContract.allowedDecisionInputRootFields.includes('reviewManifestSha256') &&
            reviewInputContract.allowedDecisionInputRootFields.includes('instructions') &&
            reviewInputContract.allowedDecisionInputRootFields.includes('decisions') &&
            Array.isArray(reviewInputContract.allowedDecisionFields) &&
            reviewInputContract.allowedDecisionFields.includes('humanVerdict') &&
            reviewInputContract.allowedDecisionFields.includes('humanConfidence') &&
            reviewInputContract.allowedDecisionFields.includes('humanNotes') &&
            Array.isArray(reviewInputContract.forbiddenAlphaProfileFieldKeys) &&
            reviewInputContract.forbiddenAlphaProfileFieldKeys.includes('alphagain') &&
            reviewInputContract.forbiddenAlphaProfileFieldKeys.includes('profilevariant') &&
            reviewInputContract.policy?.writesFormalGoldManifest === false &&
            reviewInputContract.policy?.writesProductionAlgorithm === false &&
            reviewInputContract.decisionSets?.find((set) => set.name === 'visibleTopPending')?.expectedCount === humanReviewValidation.pendingTotal &&
            reviewInputContract.decisionSets?.find((set) => set.name === 'metricPassVisible')?.expectedCount === humanReviewValidation.goldCandidateTotal &&
            path.resolve(reviewInputContract.decisionSets?.find((set) => set.name === 'visibleTopPending')?.inputPath ?? '') === path.resolve(humanReviewInputPath) &&
            path.resolve(reviewInputContract.decisionSets?.find((set) => set.name === 'metricPassVisible')?.inputPath ?? '') === path.resolve(goldCandidateConfirmationInputPath) &&
            humanReviewPackSummary.reviewInputContractSha256 === reviewInputContractSha256 &&
            humanReviewValidation.reviewInputContractSha256 === reviewInputContractSha256 &&
            humanReviewPackSummary.artifactHashes?.readmeSha256 === humanReviewReadmeSha256 &&
            humanReviewPackSummary.artifactHashes?.decisionsTemplateSha256 === humanReviewTemplateSha256 &&
            humanReviewPackSummary.artifactHashes?.decisionsSha256 === humanReviewInputSha256 &&
            humanReviewPackSummary.artifactHashes?.goldCandidateConfirmationsTemplateSha256 === goldCandidateConfirmationTemplateSha256 &&
            humanReviewPackSummary.artifactHashes?.goldCandidateConfirmationsSha256 === goldCandidateConfirmationInputSha256 &&
            humanReviewPackSummary.artifactHashes?.reviewInputContractSha256 === reviewInputContractSha256 &&
            humanReviewPackSummary.artifactHashes?.allPendingSheetSha256 === await sha256File(humanReviewPackSummary.allPendingSheet?.outputPath ?? '') &&
            humanReviewPackSummary.artifactHashes?.goldCandidateSheetSha256 === await sha256File(humanReviewPackSummary.goldCandidateSheet?.outputPath ?? '') &&
            humanReviewPackGroupedSheetHashesReady,
        'human review input contract and package hash manifest match current artifacts',
        {
            contractPath: reviewInputContractPath,
            reviewInputContractSha256,
            expectedReviewManifestSha256: reviewManifestSha256,
            validationContractSha256: humanReviewValidation.reviewInputContractSha256,
            summaryContractSha256: humanReviewPackSummary.reviewInputContractSha256,
            artifactHashes: humanReviewPackSummary.artifactHashes,
            groupedSheetHashesReady: humanReviewPackGroupedSheetHashesReady
        }
    );
    assertCondition(
        checks,
        reviewWorksheetScript.includes('review-cluster-report-manifest-hash-mismatch') &&
            reviewWorksheetScript.includes('review-cluster-report-validation-hash-mismatch') &&
            reviewWorksheetScript.includes('buildNextReviewBatch') &&
            reviewWorksheetScript.includes('buildReviewBatches') &&
            reviewWorksheetScript.includes('Next Review Batch') &&
            reviewWorksheetScript.includes('Review Batches') &&
            reviewWorksheetScript.includes('Gold Candidate Review Batches') &&
            reviewWorksheetScript.includes('skippedWrite'),
        'human review worksheet generation rejects stale cluster reports and emits a top-cluster next batch',
        { scriptPath: reviewWorksheetScriptPath }
    );
    assertCondition(
        checks,
        packageScriptGate.ready === true &&
            packageScriptGate.visibleResidualScriptCount ===
                Object.keys(REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS).length &&
            packageScriptGate.missingOrMismatchedRequiredScripts.length === 0 &&
            packageScriptGate.unclassifiedVisibleResidualScripts.length === 0 &&
            packageScriptGate.forbiddenVisibleResidualPackageScripts.length === 0 &&
            packageScriptGate.allowedScriptNames.includes('visible-residual:create-gold-manifest') &&
            packageScriptGate.allowedScriptNames.includes('visible-residual:admission-report') &&
            packageScriptGate.allowedScriptNames.includes('visible-residual:goal-audit'),
        'package visible residual entrypoints are allowlisted and cannot productionize alpha/profile variants',
        packageScriptGate
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:admission-report'] === 'node scripts/create-visible-residual-admission-report.js',
        'package script exposes visible residual algorithm admission report entrypoint',
        { script: packageJson.scripts?.['visible-residual:admission-report'] }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:goal-audit'] === 'node scripts/create-visible-residual-goal-audit-report.js',
        'package script exposes visible residual objective audit entrypoint',
        { script: packageJson.scripts?.['visible-residual:goal-audit'] }
    );
    assertCondition(
        checks,
        packageJson.scripts?.['visible-residual:cluster-report'] === 'node scripts/create-visible-residual-cluster-report.js',
        'package script exposes visible residual review cluster report entrypoint',
        { script: packageJson.scripts?.['visible-residual:cluster-report'] }
    );
    assertCondition(
        checks,
        clusterReportScript.includes('validation-report-missing-review-manifest-hash') &&
            clusterReportScript.includes('validation-report-review-manifest-hash-mismatch') &&
            clusterReportScript.includes('skippedWrite'),
        'review cluster report generation rejects stale validation reports before writing artifacts',
        { scriptPath: clusterReportScriptPath }
    );
    assertCondition(
        checks,
        humanReviewWorksheet.includes('Visible Residual Review Worksheet') &&
            humanReviewWorksheet.includes('Edit `review-decisions.json` and `gold-candidate-confirmations.json`, not this file.') &&
            humanReviewWorksheet.includes('For spreadsheet sorting/filtering, see `review-table.csv`.') &&
            humanReviewWorksheet.includes(`validationReportSha256: \`${humanReviewValidationSha256}\``) &&
            humanReviewWorksheet.includes(`reviewManifestSha256: \`${reviewManifestSha256}\``) &&
            humanReviewWorksheet.includes(`reviewClusterSha256: \`${reviewClusterReportSha256}\``) &&
            humanReviewWorksheet.includes('## Next Review Batch') &&
            humanReviewWorksheet.includes('## Review Batches') &&
            humanReviewWorksheet.includes(`reviewBatchCount: \`${expectedSortedIncompleteClusters.length}\``) &&
            humanReviewWorksheet.includes(`totalIncompleteDecisions: \`${expectedIncompleteDecisionTotal}\``) &&
            humanReviewWorksheet.includes('## Gold Candidate Review Batches') &&
            humanReviewWorksheet.includes(`goldCandidateReviewBatchCount: \`${expectedGoldCandidateClusters.length}\``) &&
            humanReviewWorksheet.includes(`goldCandidateIncompleteDecisions: \`${expectedGoldCandidateDecisionTotal}\``) &&
            (topReviewClusterId === null || humanReviewWorksheet.includes(`clusterId: \`${topReviewClusterId}\``)) &&
            (topReviewClusterId === null || humanReviewWorksheet.includes(`| 1 | ${markdownEscapedText(topReviewClusterId)} |`)) &&
            (expectedSortedIncompleteClusters.at(-1)?.clusterId
                ? humanReviewWorksheet.includes(markdownEscapedText(expectedSortedIncompleteClusters.at(-1).clusterId))
                : true) &&
            (topReviewCluster?.sheet?.outputPath
                ? humanReviewWorksheet.includes(markdownEscapedText(topReviewCluster.sheet.outputPath))
                : true) &&
            (topReviewBatchItem?.decisionJsonPath ? humanReviewWorksheet.includes(topReviewBatchItem.decisionJsonPath) : true) &&
            humanReviewWorksheet.includes('This worksheet does not write `gold-manifest.json`.'),
        'human review worksheet is generated with edit, next-batch, and policy guidance',
        {
            worksheetPath: humanReviewWorksheetPath,
            length: humanReviewWorksheet.length,
            topReviewClusterId,
            topReviewBatchDecisionJsonPath: topReviewBatchItem?.decisionJsonPath ?? null,
            expectedValidationReportSha256: humanReviewValidationSha256,
            expectedReviewManifestSha256: reviewManifestSha256,
            expectedReviewClusterSha256: reviewClusterReportSha256
        }
    );
    assertCondition(
        checks,
        humanReviewTable.startsWith('index,sourceSet,clusterId,decisionInputPath,decisionJsonPath,decisionArrayIndex,decisionIndex,profileLine,file,cropPath,suggestedVerdict,suggestedConfidence,visibleReasons,missingProblems,humanVerdict,humanConfidence,humanNotes,validationReportSha256,reviewManifestSha256,reviewClusterSha256\n') &&
            humanReviewTable.includes('visibleTopPending') &&
            humanReviewTable.includes('metricPassVisible') &&
            humanReviewTable.includes('decisions[') &&
            firstHumanReviewTableRecord.clusterId === sortedIncompleteClusters(reviewClusterReport)[0]?.clusterId &&
            firstHumanReviewTableRecord.decisionJsonPath?.startsWith('decisions[') &&
            firstHumanReviewTableRecord.validationReportSha256 === humanReviewValidationSha256 &&
            firstHumanReviewTableRecord.reviewManifestSha256 === reviewManifestSha256 &&
            firstHumanReviewTableRecord.reviewClusterSha256 === reviewClusterReportSha256,
        'human review CSV table is generated with sortable review, JSON locator, and top-cluster priority fields',
        {
            tablePath: humanReviewTablePath,
            length: humanReviewTable.length,
            firstRowClusterId: firstHumanReviewTableRecord.clusterId,
            expectedTopClusterId: sortedIncompleteClusters(reviewClusterReport)[0]?.clusterId,
            firstRowValidationReportSha256: firstHumanReviewTableRecord.validationReportSha256,
            firstRowReviewManifestSha256: firstHumanReviewTableRecord.reviewManifestSha256,
            firstRowReviewClusterSha256: firstHumanReviewTableRecord.reviewClusterSha256
        }
    );
    assertCondition(
        checks,
        humanReviewValidation.readyForGoldMigration === true || !existsSync(visibleResidualGoldManifestPath),
        'visible residual gold manifest is not written before human validation is ready',
        {
            readyForGoldMigration: humanReviewValidation.readyForGoldMigration,
            goldManifestPath: visibleResidualGoldManifestPath,
            exists: existsSync(visibleResidualGoldManifestPath)
        }
    );
    assertCondition(
        checks,
        goldProposalScript.includes('sha256Text') &&
            goldProposalScript.includes('reviewManifestSha256') &&
            goldProposalScript.includes('alphaSweepSha256') &&
            goldProposalScript.includes('profileReportSha256') &&
            goldProposalScript.includes('profileGeneralizationSha256') &&
            goldProposalScript.includes('alpha-sweep-review-manifest-hash-mismatch') &&
            goldProposalScript.includes('profile-report-review-manifest-hash-mismatch') &&
            goldProposalScript.includes('profile-generalization-review-manifest-hash-mismatch') &&
            goldProposalScript.includes('PROPOSAL_SCHEMA_GATE_PROBLEM_CODES') &&
            goldProposalScript.includes('proposedGoldSchemaGate') &&
            goldProposalScript.includes('rejectsUnknownProposedGoldFields') &&
            goldProposalScript.includes('gold-proposal-unknown-gold-field-present') &&
            goldProposalScript.includes('skippedWrite'),
        'gold proposal generation records provenance hashes for all inputs and rejects stale alpha/profile reports',
        { scriptPath: goldProposalScriptPath }
    );
    assertCondition(
        checks,
        admissionReportScript.includes('formal-gold-manifest-missing') &&
            admissionReportScript.includes('formal-gold-manifest-integrity-incomplete') &&
            admissionReportScript.includes('algorithm-admission-production-decision-incomplete') &&
            admissionReportScript.includes('algorithm-admission-rejected-production-decision-present') &&
            admissionReportScript.includes('algorithm-admission-no-approved-production-decision') &&
            admissionReportScript.includes('gold-manifest-review-manifest-hash-mismatch') &&
            admissionReportScript.includes('gold-manifest-alpha-profile-variant-fields-present') &&
            admissionReportScript.includes('gold-manifest-unknown-visible-residual-field-present') &&
            admissionReportScript.includes('ALLOWED_FORMAL_VISIBLE_RESIDUAL_FIELD_KEYS') &&
            admissionReportScript.includes('GOLD_SCHEMA_GATE_PROBLEM_CODES') &&
            admissionReportScript.includes('rejectsUnknownFormalVisibleResidualFields') &&
            admissionReportScript.includes('validation-decision-schema-gate-missing') &&
            admissionReportScript.includes('human-review-decision-schema-gate-incomplete') &&
            admissionReportScript.includes('validation-review-input-contract-decision-fields-missing') &&
            admissionReportScript.includes('validation-review-input-contract-forbidden-alpha-profile-fields-missing') &&
            admissionReportScript.includes('validation-review-input-contract-allows-alpha-profile-decision-fields') &&
            admissionReportScript.includes('validation-review-input-contract-allows-alpha-profile-root-fields') &&
            admissionReportScript.includes('unknownVisibleResidualFieldPaths') &&
            admissionReportScript.includes('normalizeFieldKey') &&
            admissionReportScript.includes('readActiveLoopRunState') &&
            admissionReportScript.includes('active-visible-residual-loop') &&
            admissionReportScript.includes('skippedWrite') &&
            admissionReportScript.includes('gold-manifest-validation-hash-mismatch') &&
            admissionReportScript.includes('gold-manifest-sample-count-mismatch') &&
            admissionReportScript.includes('goldManifestExists') &&
            admissionReportScript.includes('algorithm-admission-human-confirmed-gold-gate-missing') &&
            admissionReportScript.includes('algorithm-admission-approved-decision-gate-missing') &&
            admissionReportScript.includes('validation.readyForGoldMigration === true') &&
            admissionReportScript.includes('blockedReasons.length === 0'),
        'algorithm admission requires a verified formal gold manifest before production review',
        { scriptPath: admissionReportScriptPath }
    );
    assertCondition(
        checks,
        goalAuditScript.includes('productionGateContractReady') &&
            goalAuditScript.includes('REQUIRED_PRODUCTION_CHANGE_GATE_MARKERS') &&
            goalAuditScript.includes('APPROVED_PRODUCTION_CHANGE_GATE_MARKERS') &&
            goalAuditScript.includes('REQUIRED_VISIBLE_RESIDUAL_PACKAGE_SCRIPTS') &&
            goalAuditScript.includes('FORBIDDEN_VISIBLE_RESIDUAL_PACKAGE_SCRIPT_PATTERNS') &&
            goalAuditScript.includes('assessVisibleResidualPackageScripts') &&
            goalAuditScript.includes('packageScriptGate') &&
            goalAuditScript.includes('packageJsonSha256') &&
            goalAuditScript.includes('unclassifiedVisibleResidualScripts') &&
            goalAuditScript.includes('forbiddenVisibleResidualPackageScripts') &&
            goalAuditScript.includes('readActiveLoopRunState') &&
            goalAuditScript.includes('active-visible-residual-loop') &&
            goalAuditScript.includes('skippedWrite') &&
            goalAuditScript.includes('human-confirmed-gold-manifest') &&
            goalAuditScript.includes('accepted-alpha-profile-decision') &&
            goalAuditScript.includes('accepted-alpha-gain-sweep-decision') &&
            goalAuditScript.includes('missing-evidence'),
        'goal audit requires explicit production gate contract evidence',
        { scriptPath: goalAuditScriptPath }
    );
    assertCondition(
        checks,
        goldManifestScript.includes('validation-ready-decisions-missing-cluster-id') &&
            goldManifestScript.includes('validation-structural-errors-present') &&
            goldManifestScript.includes('validation-unconfirmed-decisions-present') &&
            goldManifestScript.includes('validation-ready-decision-count-mismatch') &&
            goldManifestScript.includes('validation-ready-decisions-do-not-cover-review-set') &&
            goldManifestScript.includes('validation-ready-decisions-duplicate-files') &&
            goldManifestScript.includes('gold-proposal-duplicate-candidate-files') &&
            goldManifestScript.includes('gold-proposal-candidates-without-ready-decision') &&
            goldManifestScript.includes('validation-ready-decisions-missing-gold-proposal-candidate') &&
            goldManifestScript.includes('gold-proposal-candidate-clusterId-missing') &&
            goldManifestScript.includes('validation-ready-decisions-proposal-cluster-mismatch') &&
            goldManifestScript.includes('validation-ready-decisions-proposal-sourceSet-mismatch') &&
            goldManifestScript.includes('DEFAULT_REVIEW_MANIFEST_PATH') &&
            goldManifestScript.includes('--manifest') &&
            goldManifestScript.includes('readActiveLoopRunState') &&
            goldManifestScript.includes('active-visible-residual-loop') &&
            goldManifestScript.includes('skippedWrite') &&
            goldManifestScript.includes('validation-review-manifest-hash-mismatch') &&
            goldManifestScript.includes('validation-review-input-contract-hash-mismatch') &&
            goldManifestScript.includes('validation-review-input-contract-visibleTopPending-count-mismatch') &&
            goldManifestScript.includes('validation-decision-schema-gate-missing') &&
            goldManifestScript.includes('validation-decision-schema-gate-root-fields-missing') &&
            goldManifestScript.includes('validation-review-input-contract-decision-fields-missing') &&
            goldManifestScript.includes('validation-review-input-contract-forbidden-alpha-profile-fields-missing') &&
            goldManifestScript.includes('validation-review-input-contract-allows-alpha-profile-decision-fields') &&
            goldManifestScript.includes('validation-review-input-contract-allows-alpha-profile-root-fields') &&
            goldManifestScript.includes('gold-proposal-review-manifest-hash-mismatch') &&
            goldManifestScript.includes('gold-proposal-policy-must-remain-proposal-only') &&
            goldManifestScript.includes('gold-proposal-policy-must-not-write-production-algorithm') &&
            goldManifestScript.includes('gold-proposal-alpha-profile-variant-fields-present') &&
            goldManifestScript.includes('gold-proposal-unknown-gold-field-present') &&
            goldManifestScript.includes('gold-proposal-schema-gate-missing') &&
            goldManifestScript.includes('gold-proposal-schema-gate-not-ready') &&
            goldManifestScript.includes('ALLOWED_PROPOSED_GOLD_FIELD_KEYS') &&
            goldManifestScript.includes('proposalRejectedFieldPaths') &&
            goldManifestScript.includes('normalizeFieldKey') &&
            goldManifestScript.includes('gold-proposal-alpha-sweep-hash-mismatch') &&
            goldManifestScript.includes('gold-proposal-profile-report-hash-mismatch') &&
            goldManifestScript.includes('gold-proposal-profile-generalization-hash-mismatch') &&
            goldManifestScript.includes('clusterId: decision.clusterId ?? null') &&
            goldManifestScript.includes('decision.clusterId') &&
            goldManifestScript.includes('reviewManifestSha256') &&
            goldManifestScript.includes('validationReportSha256') &&
            goldManifestScript.includes('reviewInputContractSha256') &&
            goldManifestScript.includes('goldProposalSha256') &&
            goldManifestScript.includes('alphaSweepPath: proposal.inputs?.alphaSweepPath') &&
            goldManifestScript.includes('alphaSweepSha256: proposalInputIntegrity.hashes.alphaSweepSha256') &&
            goldManifestScript.includes('alphaSweepReviewManifestSha256: proposalInputIntegrity.hashes.alphaSweepReviewManifestSha256') &&
            goldManifestScript.includes('profileReportPath: proposal.inputs?.profileReportPath') &&
            goldManifestScript.includes('profileReportSha256: proposalInputIntegrity.hashes.profileReportSha256') &&
            goldManifestScript.includes('profileReportReviewManifestSha256: proposalInputIntegrity.hashes.profileReportReviewManifestSha256') &&
            goldManifestScript.includes('profileGeneralizationPath: proposal.inputs?.profileGeneralizationPath') &&
            goldManifestScript.includes('profileGeneralizationSha256: proposalInputIntegrity.hashes.profileGeneralizationSha256') &&
            goldManifestScript.includes('profileGeneralizationReviewManifestSha256') &&
            goldManifestScript.includes('gold-proposal-alpha-sweep-review-manifest-hash-mismatch') &&
            goldManifestScript.includes('gold-proposal-profile-report-review-manifest-hash-mismatch') &&
            goldManifestScript.includes('gold-proposal-profile-generalization-review-manifest-hash-mismatch'),
        'formal gold manifest migration preserves stable cluster ids and rejects stale proposal inputs',
        { scriptPath: goldManifestScriptPath }
    );

    const productionHits = await findExperimentalProfileInProduction(args.root);
    assertCondition(
        checks,
        productionHits.length === 0 &&
            PRODUCTION_DIRS.includes('dist') &&
            PRODUCTION_SCAN_FILE_PATTERN.test('dist/index.html') &&
            PRODUCTION_SCAN_FILE_PATTERN.test('dist/extension/manifest.json'),
        'experimental alpha/profile variants are not referenced in production source',
        {
            productionScanDirs: [...PRODUCTION_DIRS],
            productionScanFilePattern: PRODUCTION_SCAN_FILE_PATTERN.source,
            productionHits
        }
    );
    const productionArtifactHits = await findForbiddenVisibleResidualArtifactReferences(args.root);
    assertCondition(
        checks,
        productionArtifactHits.length === 0 &&
            PRODUCTION_DIRS.includes('dist') &&
            PRODUCTION_SCAN_FILE_PATTERN.test('dist/index.html') &&
            PRODUCTION_SCAN_FILE_PATTERN.test('dist/extension/manifest.json'),
        'visible residual review artifacts are not referenced in production source',
        {
            productionScanDirs: [...PRODUCTION_DIRS],
            productionScanFilePattern: PRODUCTION_SCAN_FILE_PATTERN.source,
            productionArtifactHits
        }
    );

    const failed = checks.filter((check) => !check.ok);
    const report = {
        generatedAt: new Date().toISOString(),
        artifactDir: args.artifactDir,
        ok: failed.length === 0,
        totalChecks: checks.length,
        failedChecks: failed.length,
        checks
    };

    console.log(JSON.stringify(report, null, 2));
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
