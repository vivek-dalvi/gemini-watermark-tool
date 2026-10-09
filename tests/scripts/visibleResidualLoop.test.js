import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TINY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/></svg>';
const ALLOWED_HUMAN_REVIEW_DECISION_FIELDS = [
    'clusterId',
    'cropPath',
    'decisionArrayIndex',
    'file',
    'humanConfidence',
    'humanNotes',
    'humanVerdict',
    'index',
    'metrics',
    'profileLine',
    'reviewStatus',
    'sourceSet',
    'suggestedConfidence',
    'suggestedNotes',
    'suggestedVerdict',
    'visibleReasons'
];
const ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS = [
    'decisions',
    'instructions',
    'reviewManifestSha256',
    'schemaVersion'
];
const FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS = [
    'alphagain',
    'alphagainsweep',
    'alphamap',
    'alphamappath',
    'alphaprofile',
    'alphaprofilemidboost124',
    'midboost',
    'productionprofile',
    'profileadjustment',
    'profilecandidate',
    'profileoverride',
    'profilevariant',
    'renderprofile',
    'watermarkprofile'
];

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

async function sha256File(filePath) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function readJson(filePath) {
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeHumanReviewPackSummaryWithHashes(humanReviewPackDir, {
    reviewManifestSha256,
    reviewInputContractSha256
}) {
    const allPendingSheetPath = path.join(humanReviewPackDir, 'all-pending.png');
    const goldCandidateSheetPath = path.join(humanReviewPackDir, 'gold-candidates.png');
    if (!existsSync(allPendingSheetPath)) await writeFile(allPendingSheetPath, TINY_SVG, 'utf8');
    if (!existsSync(goldCandidateSheetPath)) await writeFile(goldCandidateSheetPath, TINY_SVG, 'utf8');
    const summary = {
        reviewManifestSha256,
        reviewInputContractSha256,
        allPendingSheet: {
            outputPath: allPendingSheetPath
        },
        goldCandidateSheet: {
            outputPath: goldCandidateSheetPath
        },
        groupedSheets: {},
        artifactHashes: {
            readmeSha256: await sha256File(path.join(humanReviewPackDir, 'README.md')),
            decisionsTemplateSha256: await sha256File(path.join(humanReviewPackDir, 'review-decisions.template.json')),
            decisionsSha256: await sha256File(path.join(humanReviewPackDir, 'review-decisions.json')),
            goldCandidateConfirmationsTemplateSha256:
                await sha256File(path.join(humanReviewPackDir, 'gold-candidate-confirmations.template.json')),
            goldCandidateConfirmationsSha256:
                await sha256File(path.join(humanReviewPackDir, 'gold-candidate-confirmations.json')),
            reviewInputContractSha256: await sha256File(path.join(humanReviewPackDir, 'review-input-contract.json')),
            allPendingSheetSha256: await sha256File(allPendingSheetPath),
            goldCandidateSheetSha256: await sha256File(goldCandidateSheetPath),
            groupedSheets: {}
        }
    };
    await writeFile(path.join(humanReviewPackDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

async function writeVisibleResidualPackageJson(root) {
    const packageJson = {
        scripts: {
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
        }
    };
    await writeFile(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    return packageJson;
}

function createDecisionSchemaGate(overrides = {}) {
    return {
        armed: true,
        appliesToHumanReviewDecisionInputs: true,
        rejectsAlphaProfileVariantFields: true,
        rejectsUnknownDecisionFields: true,
        rejectsUnknownDecisionInputRootFields: true,
        allowedDecisionFields: ALLOWED_HUMAN_REVIEW_DECISION_FIELDS,
        allowedDecisionInputRootFields: ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS,
        forbiddenAlphaProfileFieldKeys: FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS,
        failClosedProblemCodes: [
            'decision-input-alpha-profile-variant-fields-present',
            'decision-input-unknown-root-fields-present',
            'decision-alpha-profile-variant-fields-present',
            'decision-unknown-fields-present'
        ],
        forbiddenAlphaProfileFieldPaths: [],
        unknownDecisionFieldPaths: [],
        unknownDecisionInputRootFieldPaths: [],
        ok: true,
        ...overrides
    };
}

function createMinimalReviewManifest({ includeGoldCandidate = false } = {}) {
    return {
        groups: {
            metricPassVisible: includeGoldCandidate
                ? [
                    {
                        file: 'candidate-a.png',
                        cropPath: 'artifacts/candidate-a.png',
                        review: {
                            verdict: 'trueVisibleResidual',
                            confidence: 'high',
                            profileLine: '48px-large-margin',
                            notes: 'Codex pre-review only.'
                        },
                        metrics: {
                            positiveHaloLum: 6.5,
                            gradientResidual: 0.1,
                            spatialResidual: 0.08,
                            visibleReasons: ['positiveHalo']
                        }
                    }
                ]
                : [],
            visibleTopPending: [
                {
                    file: 'pending-a.png',
                    cropPath: 'artifacts/pending-a.png',
                    review: {
                        profileLine: '48px-large-margin'
                    },
                    metrics: {
                        positiveHaloLum: 8.5,
                        gradientResidual: 0.12,
                        spatialResidual: 0.08,
                        visibleReasons: ['positiveHalo']
                    }
                },
                {
                    file: 'pending-b.png',
                    cropPath: 'artifacts/pending-b.png',
                    review: {
                        profileLine: '45px-other'
                    },
                    metrics: {
                        positiveHaloLum: 0,
                        gradientResidual: 0.28,
                        spatialResidual: 0.22,
                        visibleReasons: ['gradientResidual', 'spatialResidual']
                    }
                }
            ]
        }
    };
}

function createDecisionPayload(overrides = []) {
    const base = [
        {
            index: 0,
            file: 'pending-a.png',
            profileLine: '48px-large-margin',
            visibleReasons: ['positiveHalo'],
            metrics: {},
            cropPath: 'artifacts/pending-a.png',
            suggestedVerdict: null,
            humanVerdict: null,
            humanConfidence: null,
            humanNotes: ''
        },
        {
            index: 1,
            file: 'pending-b.png',
            profileLine: '45px-other',
            visibleReasons: ['gradientResidual', 'spatialResidual'],
            metrics: {},
            cropPath: 'artifacts/pending-b.png',
            suggestedVerdict: null,
            humanVerdict: null,
            humanConfidence: null,
            humanNotes: ''
        }
    ];

    for (const override of overrides) {
        Object.assign(base[override.index], override.patch);
    }

    return {
        schemaVersion: 1,
        decisions: base
    };
}

function createGoldCandidateDecisionPayload(overrides = []) {
    const base = [
        {
            index: 0,
            file: 'candidate-a.png',
            profileLine: '48px-large-margin',
            visibleReasons: ['positiveHalo'],
            metrics: {},
            cropPath: 'artifacts/candidate-a.png',
            suggestedVerdict: 'trueVisibleResidual',
            suggestedConfidence: 'high',
            suggestedNotes: 'Codex pre-review only.',
            humanVerdict: null,
            humanConfidence: null,
            humanNotes: ''
        }
    ];

    for (const override of overrides) {
        Object.assign(base[override.index], override.patch);
    }

    return {
        schemaVersion: 1,
        decisions: base
    };
}

async function writeValidationInputs(tempDir, decisions, options = {}) {
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const decisionsPath = path.join(tempDir, 'review-decisions.json');
    const candidateDecisionsPath = path.join(tempDir, 'gold-candidate-confirmations.json');
    const outputPath = path.join(tempDir, 'validation-report.json');

    await writeFile(manifestPath, `${JSON.stringify(createMinimalReviewManifest({
        includeGoldCandidate: options.includeGoldCandidate === true
    }), null, 2)}\n`, 'utf8');
    await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    if (options.candidateDecisions) {
        await writeFile(candidateDecisionsPath, `${JSON.stringify(options.candidateDecisions, null, 2)}\n`, 'utf8');
    }

    return { manifestPath, decisionsPath, candidateDecisionsPath, outputPath };
}

async function writeTinySvg(filePath) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, TINY_SVG, 'utf8');
}

async function writeReviewPackInputs(tempDir) {
    const cropDir = path.join(tempDir, 'crops');
    const pendingACrop = path.join(cropDir, 'pending-a.svg');
    const pendingBCrop = path.join(cropDir, 'pending-b.svg');
    const candidateCrop = path.join(cropDir, 'candidate-a.svg');
    await writeTinySvg(pendingACrop);
    await writeTinySvg(pendingBCrop);
    await writeTinySvg(candidateCrop);

    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    manifest.sourceRenderSummaryPath = path.join(tempDir, 'summary.json');
    manifest.groups.visibleTopPending[0].cropPath = pendingACrop;
    manifest.groups.visibleTopPending[1].cropPath = pendingBCrop;
    manifest.groups.metricPassVisible[0].cropPath = candidateCrop;

    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const outputDir = path.join(tempDir, 'human-review-pack');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { manifestPath, outputDir };
}

test('package scripts should expose visible residual loop entrypoints', async () => {
    const packageJson = await readJson(path.resolve('package.json'));
    const goalAuditSource = await readFile(path.resolve('scripts/create-visible-residual-goal-audit-report.js'), 'utf8');

    assert.equal(packageJson.scripts['visible-residual:loop'], 'node scripts/run-visible-residual-loop.js');
    assert.equal(packageJson.scripts['visible-residual:verify'], 'node scripts/verify-visible-residual-loop.js');
    assert.equal(
        packageJson.scripts['visible-residual:validate-human-review'],
        'node scripts/validate-visible-residual-human-review.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:create-gold-manifest'],
        'node scripts/create-visible-residual-gold-manifest.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:review-status'],
        'node scripts/report-visible-residual-review-progress.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:apply-focused-batch'],
        'node scripts/apply-visible-residual-focused-review-batch.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:review-worksheet'],
        'node scripts/create-visible-residual-review-worksheet.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:admission-report'],
        'node scripts/create-visible-residual-admission-report.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:goal-audit'],
        'node scripts/create-visible-residual-goal-audit-report.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:cluster-report'],
        'node scripts/create-visible-residual-cluster-report.js'
    );
    assert.equal(
        packageJson.scripts['visible-residual:geometry-audit'],
        'node scripts/audit-visible-residual-geometry.js'
    );
    assert.match(goalAuditSource, /'dist'/);
    assert.match(goalAuditSource, /PRODUCTION_SCAN_FILE_PATTERN/);
});

test('run-visible-residual-loop should end with the verifier and preserve the human gate', async () => {
    const source = await readFile(path.resolve('scripts/run-visible-residual-loop.js'), 'utf8');

    assert.match(source, /scripts\/validate-visible-residual-human-review\.js/);
    assert.match(source, /scripts\/create-visible-residual-cluster-report\.js/);
    assert.match(source, /--worksheet-output/);
    assert.match(source, /--cluster-sheet-dir/);
    assert.match(source, /scripts\/create-visible-residual-admission-report\.js/);
    assert.match(source, /scripts\/create-visible-residual-review-worksheet\.js/);
    assert.match(source, /--csv-output/);
    assert.match(source, /scripts\/report-visible-residual-review-progress\.js/);
    assert.match(source, /--clusters/);
    assert.match(source, /--output/);
    assert.match(source, /review-progress-report\.json/);
    assert.match(source, /scripts\/create-visible-residual-goal-audit-report\.js/);
    assert.match(source, /create goal audit report/);
    assert.match(source, /--allow-active-loop-state/);
    assert.match(source, /scripts\/verify-visible-residual-loop\.js/);
    assert.match(source, /loop-run-state\.json/);
    assert.match(source, /writeLoopRunState/);
    assert.match(source, /clearLoopRunState/);
    assert.match(source, /--allow-active-loop-state/);
    assert.match(source, /review-decisions\.json/);
    assert.match(source, /gold-candidate-confirmations\.json/);
    assert.match(source, /review-input-contract\.json/);
    assert.match(source, /loop-summary\.json/);
    assert.match(source, /writeJson/);
    assert.match(source, /verifiedByFinalStep/);
    assert.match(source, /inputHashes/);
    assert.match(source, /sha256File/);
    assert.match(source, /sourceSummarySha256/);
    assert.match(source, /validationReportSha256/);
    assert.match(source, /humanReviewPackSummarySha256/);
    assert.match(source, /reviewWorksheetSha256/);
    assert.match(source, /reviewTableSha256/);
    assert.match(source, /clusterReviewWorksheetSha256/);
    assert.match(source, /reviewProgressReportSha256/);
    assert.match(source, /reviewCheckpointSha256/);
    assert.match(source, /focusedReviewBatchSha256/);
    assert.match(source, /reviewHandoffSha256/);
    assert.match(source, /humanReviewReadmeSha256/);
    assert.match(source, /goalAuditReportSha256/);
    assert.match(source, /--contract/);
    assert.match(source, /verify loop/);
    assert.match(source, /report human review progress/);
    assert.match(source, /validate human review decisions/);
    assert.match(source, /summary/);
    assert.match(source, /readyForGoldMigration/);
    assert.match(source, /unconfirmedCount/);
    assert.match(source, /completionAudit/);
    assert.match(source, /buildCompletionAudit/);
    assert.match(source, /goalAchieved/);
    assert.match(source, /unsatisfiedRequirementIds/);
    assert.match(source, /formal-gold-migration/);
    assert.match(source, /productionProfileAllowed/);
    assert.match(source, /productionGateContractReady/);
    assert.match(source, /productionHitCount/);
    assert.match(source, /productionArtifactHitCount/);
    assert.match(source, /packageScriptGateReady/);
    assert.match(source, /packageJsonSha256/);
    assert.match(source, /visibleResidualPackageScriptCount/);
    assert.match(source, /forbiddenVisibleResidualPackageScriptCount/);
    assert.match(source, /unclassifiedVisibleResidualPackageScriptCount/);
    assert.match(source, /goldManifestWriteAllowed/);
    assert.match(source, /goalAuditStatus/);
    assert.match(source, /blockers/);
    assert.match(source, /humanReviewGuidance/);
    assert.match(source, /humanReviewPackSummaryPath/);
    assert.match(source, /reviewWorksheetPath/);
    assert.match(source, /reviewTablePath/);
    assert.match(source, /clusterReviewWorksheetPath/);
    assert.match(source, /reviewCheckpointPath/);
    assert.match(source, /focusedReviewBatchPath/);
    assert.match(source, /reviewHandoffPath/);
    assert.match(source, /humanReviewReadmePath/);
    assert.match(source, /nextActions/);
    assert.match(source, /blockedActions/);
    assert.match(source, /complete-visible-residual-review-batches/);
    assert.match(source, /complete-gold-candidate-confirmations/);
    assert.match(source, /firstCropPath/);
    assert.match(source, /sheetPath/);
    assert.match(source, /decisionTargets/);
    assert.match(source, /buildDecisionTargets/);
    assert.match(source, /requiresHumanJudgement/);
    assert.match(source, /reviewCheckpointPath/);
    assert.match(source, /focusedReviewBatchPath/);
    assert.match(source, /allowsAlphaProfileProduction/);
    assert.match(source, /validationCommandAfterEdit/);
    assert.match(source, /gateEvidence/);
    assert.match(source, /requiresHumanConfirmationBeforeWrite/);
    assert.match(source, /rerun-human-review-validation-after-edits/);
    assert.match(source, /write-formal-gold-manifest/);
    assert.match(source, /productionize-alpha-profile-variant/);
    assert.match(source, /reviewBatchCount/);
    assert.match(source, /reviewBatchTotal/);
    assert.match(source, /remainingClusterCount/);
    assert.match(source, /goldCandidateUnconfirmedCount/);
    assert.match(source, /goldCandidateReviewBatchCount/);
    assert.match(source, /goldCandidateReviewBatchTotal/);
    assert.match(source, /nextGoldCandidateReviewBatch/);
    assert.match(source, /nextReviewCluster/);
    assert.match(source, /nextReviewBatch/);
    assert.match(source, /firstDecisionJsonPath/);
    assert.match(source, /algorithm-admission-human-gated/);
    assert.match(source, /--checkpoint-output/);
    assert.match(source, /--focused-batch-output/);
    assert.match(source, /--handoff-output/);
    assert.match(source, /review-checkpoint\.json/);
    assert.match(source, /review-focused-batch\.json/);
    assert.match(source, /review-handoff\.md/);
    const order = {
        validateHumanReview: source.indexOf('scripts/validate-visible-residual-human-review.js'),
        createClusterReport: source.indexOf('scripts/create-visible-residual-cluster-report.js'),
        createAdmissionReport: source.indexOf('scripts/create-visible-residual-admission-report.js'),
        createReviewWorksheet: source.indexOf('scripts/create-visible-residual-review-worksheet.js'),
        reportReviewProgress: source.indexOf('scripts/report-visible-residual-review-progress.js'),
        createGoalAudit: source.indexOf('scripts/create-visible-residual-goal-audit-report.js'),
        finalVerifier: source.indexOf('scripts/verify-visible-residual-loop.js')
    };
    assert.ok(Object.values(order).every((index) => index >= 0));
    assert.ok(order.validateHumanReview < order.createClusterReport);
    assert.ok(order.createClusterReport < order.createAdmissionReport);
    assert.ok(order.createClusterReport < order.createReviewWorksheet);
    assert.ok(order.createClusterReport < order.reportReviewProgress);
    assert.ok(order.createAdmissionReport < order.createGoalAudit);
    assert.ok(order.createReviewWorksheet < order.createGoalAudit);
    assert.ok(order.reportReviewProgress < order.createGoalAudit);
    assert.ok(order.createGoalAudit < order.finalVerifier);
});

test('verify-visible-residual-loop should validate review status output against artifacts', async () => {
    const source = await readFile(path.resolve('scripts/verify-visible-residual-loop.js'), 'utf8');

    assert.match(source, /runReviewProgressReport/);
    assert.match(source, /loop-summary\.json/);
    assert.match(source, /loop-run-state\.json/);
    assert.match(source, /readActiveLoopRunState/);
    assert.match(source, /allowActiveLoopState/);
    assert.match(source, /active-visible-residual-loop/);
    assert.match(source, /visible residual loop is not actively rewriting artifacts/);
    assert.match(source, /loop summary artifact exposes current human and production gate metrics/);
    assert.match(source, /inputHashes/);
    assert.match(source, /sourceSummarySha256/);
    assert.match(source, /humanReviewPackSummarySha256/);
    assert.match(source, /reviewWorksheetSha256/);
    assert.match(source, /reviewTableSha256/);
    assert.match(source, /clusterReviewWorksheetSha256/);
    assert.match(source, /reviewProgressReportSha256/);
    assert.match(source, /reviewCheckpointSha256/);
    assert.match(source, /focusedReviewBatchSha256/);
    assert.match(source, /reviewHandoffSha256/);
    assert.match(source, /humanReviewReadmeSha256/);
    assert.match(source, /artifactHashes/);
    assert.match(source, /goalAuditReportSha256/);
    assert.match(source, /goldManifestWriteAllowed/);
    assert.match(source, /productionHitCount/);
    assert.match(source, /productionArtifactHitCount/);
    assert.match(source, /packageScriptGateReady/);
    assert.match(source, /packageJsonSha256/);
    assert.match(source, /visibleResidualPackageScriptCount/);
    assert.match(source, /forbiddenVisibleResidualPackageScriptCount/);
    assert.match(source, /unclassifiedVisibleResidualPackageScriptCount/);
    assert.match(source, /humanReviewGuidance/);
    assert.match(source, /humanReviewPackSummaryPath/);
    assert.match(source, /reviewWorksheetPath/);
    assert.match(source, /reviewTablePath/);
    assert.match(source, /clusterReviewWorksheetPath/);
    assert.match(source, /humanReviewCheckpoint/);
    assert.match(source, /focusedReviewBatch/);
    assert.match(source, /reviewCheckpointPath/);
    assert.match(source, /focusedReviewBatchPath/);
    assert.match(source, /reviewHandoffPath/);
    assert.match(source, /humanReviewReadmePath/);
    assert.match(source, /completionAudit/);
    assert.match(source, /goalAchieved/);
    assert.match(source, /unsatisfiedRequirementIds/);
    assert.match(source, /completionRequiredState/);
    assert.match(source, /nextActions/);
    assert.match(source, /blockedActions/);
    assert.match(source, /complete-visible-residual-review-batches/);
    assert.match(source, /complete-gold-candidate-confirmations/);
    assert.match(source, /firstCropPath/);
    assert.match(source, /sheetPath/);
    assert.match(source, /existsSync/);
    assert.match(source, /decisionTargets/);
    assert.match(source, /decisionTargetsMatchItems/);
    assert.match(source, /requiresHumanJudgement/);
    assert.match(source, /allowsAlphaProfileProduction/);
    assert.match(source, /validationCommandAfterEdit/);
    assert.match(source, /gateEvidence/);
    assert.match(source, /requiresHumanConfirmationBeforeWrite/);
    assert.match(source, /productionize-alpha-profile-variant/);
    assert.match(source, /firstDecisionInputPath/);
    assert.match(source, /firstDecisionJsonPath/);
    assert.match(source, /execFileAsync/);
    assert.match(source, /report-visible-residual-review-progress\.js/);
    assert.match(source, /nextReviewClusters/);
    assert.match(source, /reviewBatches/);
    assert.match(source, /goldCandidateReviewBatches/);
    assert.match(source, /nextGoldCandidateReviewBatch/);
    assert.match(source, /buildReviewBatches/);
    assert.match(source, /totalIncompleteInCluster/);
    assert.match(source, /reviewBatchCount/);
    assert.match(source, /reviewBatchTotal/);
    assert.match(source, /goldCandidateReviewBatchCount/);
    assert.match(source, /goldCandidateReviewBatchTotal/);
    assert.match(source, /incompleteByCluster/);
    assert.match(source, /human-review-pack\/review-progress-report\.json/);
    assert.match(source, /human-review-pack\/review-checkpoint\.json/);
    assert.match(source, /human-review-pack\/review-focused-batch\.json/);
    assert.match(source, /human-review-pack\/review-handoff\.md/);
    assert.match(source, /review checkpoint gives a current human-executable batch while keeping gold and production blocked/);
    assert.match(source, /focused review batch narrows current human edits without gold or production writes/);
    assert.match(source, /review handoff markdown is current and human-executable without gold or production writes/);
    assert.match(source, /focused review batch apply script validates provenance, audits before\/after hashes, and stays limited to human review inputs/);
    assert.match(source, /batchSha256/);
    assert.match(source, /decisionsBeforeSha256/);
    assert.match(source, /decisionsAfterSha256/);
    assert.match(source, /changedTargets/);
    assert.match(source, /focused-batch-duplicate-target/);
    assert.match(source, /focused-batch-decision-json-path-mismatch/);
    assert.match(source, /writesReviewCheckpoint/);
    assert.match(source, /writesFocusedReviewBatch/);
    assert.match(source, /review status output mirrors validation and cluster artifacts/);
    assert.match(source, /persisted review progress report mirrors validation and cluster artifacts/);
    assert.match(source, /Next Review Batch/);
    assert.match(source, /Review Batches/);
    assert.match(source, /Gold Candidate Review Batches/);
    assert.match(source, /buildReviewBatches/);
    assert.match(source, /totalIncompleteDecisions/);
    assert.match(source, /goldCandidateIncompleteDecisions/);
    assert.match(source, /human review worksheet is generated with edit, next-batch, and policy guidance/);
    assert.match(source, /goal audit report summarizes objective status/);
    assert.match(source, /goal audit report keeps formal gold migration blocked on human review/);
    assert.match(source, /human review artifacts share the current review manifest hash/);
    assert.match(source, /formal gold manifest migration preserves stable cluster ids/);
    assert.match(source, /visible residual review artifacts are not referenced in production source/);
    assert.match(source, /'dist'/);
    assert.match(source, /PRODUCTION_SCAN_FILE_PATTERN/);
    assert.match(source, /human review validation rejects stale cluster\/source\/index ids, stale input contracts, and emits decision locators/);
    assert.match(source, /human review input contract and package hash manifest match current artifacts/);
    assert.match(source, /validationInputContractIntegrity/);
    assert.match(source, /validation-review-input-contract-hash-mismatch/);
    assert.match(source, /human review README is readable and explains edit fields plus contract gates/);
    assert.match(source, /review cluster report generation rejects stale validation reports before writing artifacts/);
    assert.match(source, /alpha\/profile observation reports are generated from the current review manifest/);
    assert.match(source, /geometry-family-48-96-96-alpha-profile\.json/);
    assert.match(source, /geometry-family-48-96-96-reference-boundary\.json/);
    assert.match(source, /48\/96\/96 geometry-family alpha\/profile report remains diagnostic and rejects production candidate/);
    assert.match(source, /48\/96\/96 geometry-family visual sheet mirrors diagnostic report and policy/);
    assert.match(source, /48\/96\/96 reference boundary scan proves there is no clean evidence gate/);
    assert.match(source, /48\/96\/96 reference boundary scatter sheet mirrors diagnostic report and policy/);
    assert.match(source, /geometry-family-48-96-96-goal-audit\.json/);
    assert.match(source, /48\/96\/96 alpha\/profile goal audit is achieved as diagnostic rejection/);
    assert.match(source, /achieved-as-diagnostic-rejection/);
    assert.match(source, /reference-candidate-has-no-clean-evidence-boundary/);
    assert.match(source, /review manifest records current render summary provenance/);
    assert.match(source, /review queue summary records current review manifest provenance/);
    assert.match(source, /collectReviewVisualPathRefs/);
    assert.match(source, /reference existing visual crops and sheets/);
});

test('verify-visible-residual-loop should fail fast while loop artifacts are being rewritten', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-loop-active-state-'));
    await writeFile(path.join(tempDir, 'loop-run-state.json'), `${JSON.stringify({
        schemaVersion: 1,
        status: 'running',
        runId: 'test-run',
        pid: 12345,
        currentStepName: 'render visible residual crops',
        currentStepIndex: 1,
        totalSteps: 17,
        updatedAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/verify-visible-residual-loop.js'),
            '--artifact-dir',
            tempDir
        ]),
        (error) => {
            const report = JSON.parse(error.stdout);
            assert.equal(report.ok, false);
            assert.equal(report.failedChecks, 1);
            assert.equal(report.checks[0].name, 'visible residual loop is not actively rewriting artifacts');
            assert.equal(report.checks[0].details.activeLoopRunState.runId, 'test-run');
            assert.match(report.checks[0].details.remediation, /visible-residual:loop/);
            return true;
        }
    );
});

test('admission, goal audit, and formal gold migration should fail fast while loop artifacts are being rewritten', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-loop-active-write-gates-'));
    const humanReviewPackDir = path.join(tempDir, 'human-review-pack');
    await mkdir(humanReviewPackDir, { recursive: true });
    const loopState = {
        schemaVersion: 1,
        status: 'running',
        runId: 'test-run',
        pid: 12345,
        currentStepName: 'create goal audit report',
        currentStepIndex: 16,
        totalSteps: 17,
        updatedAt: new Date().toISOString()
    };
    await writeFile(path.join(tempDir, 'loop-run-state.json'), `${JSON.stringify(loopState, null, 2)}\n`, 'utf8');

    const assertActiveLoopRejects = async ({ script, args, expect }) => {
        await assert.rejects(
            execFileAsync(process.execPath, [
                path.resolve(script),
                ...args
            ]),
            (error) => {
                const report = JSON.parse(error.stderr);
                assert.equal(report.ok, false);
                assert.equal(report.skippedWrite, true);
                assert.deepEqual(report.problems, ['active-visible-residual-loop']);
                assert.equal(report.activeLoopRunState.runId, 'test-run');
                if (expect) expect(report);
                return true;
            }
        );
    };

    const validationOutputPath = path.join(humanReviewPackDir, 'validation-report.json');
    await writeFile(validationOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/validate-visible-residual-human-review.js',
        args: [
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--decisions',
            path.join(humanReviewPackDir, 'missing-decisions.json'),
            '--candidate-decisions',
            path.join(humanReviewPackDir, 'missing-candidate-decisions.json'),
            '--contract',
            path.join(humanReviewPackDir, 'missing-contract.json'),
            '--output',
            validationOutputPath
        ]
    });
    assert.equal(await readFile(validationOutputPath, 'utf8'), '{"sentinel":true}\n');

    const clusterReportOutputPath = path.join(tempDir, 'review-clusters.json');
    await writeFile(clusterReportOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/create-visible-residual-cluster-report.js',
        args: [
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--validation',
            path.join(humanReviewPackDir, 'missing-validation.json'),
            '--output',
            clusterReportOutputPath,
            '--worksheet-output',
            path.join(humanReviewPackDir, 'cluster-review-worksheet.md'),
            '--cluster-sheet-dir',
            path.join(humanReviewPackDir, 'by-cluster')
        ]
    });
    assert.equal(await readFile(clusterReportOutputPath, 'utf8'), '{"sentinel":true}\n');

    const reviewWorksheetOutputPath = path.join(humanReviewPackDir, 'review-worksheet.md');
    await writeFile(reviewWorksheetOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/create-visible-residual-review-worksheet.js',
        args: [
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--validation',
            path.join(humanReviewPackDir, 'missing-validation.json'),
            '--clusters',
            path.join(tempDir, 'missing-review-clusters.json'),
            '--output',
            reviewWorksheetOutputPath,
            '--csv-output',
            path.join(humanReviewPackDir, 'review-table.csv')
        ]
    });
    assert.equal(await readFile(reviewWorksheetOutputPath, 'utf8'), '{"sentinel":true}\n');

    const reviewProgressOutputPath = path.join(humanReviewPackDir, 'review-progress-report.json');
    await writeFile(reviewProgressOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/report-visible-residual-review-progress.js',
        args: [
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--validation',
            path.join(humanReviewPackDir, 'missing-validation.json'),
            '--clusters',
            path.join(tempDir, 'missing-review-clusters.json'),
            '--output',
            reviewProgressOutputPath,
            '--checkpoint-output',
            path.join(humanReviewPackDir, 'review-checkpoint.json'),
            '--focused-batch-output',
            path.join(humanReviewPackDir, 'review-focused-batch.json'),
            '--handoff-output',
            path.join(humanReviewPackDir, 'review-handoff.md')
        ]
    });
    assert.equal(await readFile(reviewProgressOutputPath, 'utf8'), '{"sentinel":true}\n');

    const focusedBatchDecisionsPath = path.join(humanReviewPackDir, 'review-decisions.json');
    const focusedBatchCandidateDecisionsPath = path.join(humanReviewPackDir, 'gold-candidate-confirmations.json');
    await writeFile(focusedBatchDecisionsPath, '{"sentinel":true}\n', 'utf8');
    await writeFile(focusedBatchCandidateDecisionsPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/apply-visible-residual-focused-review-batch.js',
        args: [
            '--batch',
            path.join(humanReviewPackDir, 'missing-focused-batch.json'),
            '--validation',
            path.join(humanReviewPackDir, 'missing-validation.json'),
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--clusters',
            path.join(tempDir, 'missing-review-clusters.json'),
            '--decisions',
            focusedBatchDecisionsPath,
            '--candidate-decisions',
            focusedBatchCandidateDecisionsPath,
            '--dry-run'
        ],
        expect: (report) => {
            assert.equal(report.dryRun, true);
        }
    });
    assert.equal(await readFile(focusedBatchDecisionsPath, 'utf8'), '{"sentinel":true}\n');
    assert.equal(await readFile(focusedBatchCandidateDecisionsPath, 'utf8'), '{"sentinel":true}\n');

    const admissionOutputPath = path.join(tempDir, 'algorithm-admission-report.json');
    await writeFile(admissionOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/create-visible-residual-admission-report.js',
        args: [
            '--proposal',
            path.join(tempDir, 'missing-proposal.json'),
            '--validation',
            path.join(tempDir, 'missing-validation.json'),
            '--output',
            admissionOutputPath,
            '--gold-manifest',
            path.join(tempDir, 'gold-manifest.json')
        ]
    });
    assert.equal(await readFile(admissionOutputPath, 'utf8'), '{"sentinel":true}\n');

    const goalAuditOutputPath = path.join(tempDir, 'goal-audit-report.json');
    await writeFile(goalAuditOutputPath, '{"sentinel":true}\n', 'utf8');
    await assertActiveLoopRejects({
        script: 'scripts/create-visible-residual-goal-audit-report.js',
        args: [
            '--artifact-dir',
            tempDir,
            '--output',
            goalAuditOutputPath
        ]
    });
    assert.equal(await readFile(goalAuditOutputPath, 'utf8'), '{"sentinel":true}\n');

    const goldManifestOutputPath = path.join(tempDir, 'gold-manifest.json');
    await assertActiveLoopRejects({
        script: 'scripts/create-visible-residual-gold-manifest.js',
        args: [
            '--validation',
            path.join(tempDir, 'missing-validation.json'),
            '--proposal',
            path.join(tempDir, 'missing-proposal.json'),
            '--manifest',
            path.join(tempDir, 'missing-review-manifest.json'),
            '--output',
            goldManifestOutputPath
        ]
    });
    assert.equal(existsSync(goldManifestOutputPath), false);
});

test('create-visible-residual-review-manifest should record render summary provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-manifest-provenance-'));
    const summaryPath = path.join(tempDir, 'summary.json');
    const outputPath = path.join(tempDir, 'review-manifest.json');
    const summary = {
        summaryPath: path.join(tempDir, 'source-summary.json'),
        sampleRoot: tempDir,
        groups: {
            metricPassVisible: {
                records: [
                    {
                        file: 'candidate-a.png',
                        bucket: 'metricPassVisible',
                        source: 'test',
                        cropPath: 'candidate-a.png',
                        config: {
                            logoSize: 48,
                            marginRight: 96,
                            marginBottom: 96
                        },
                        residualVisibility: {
                            visible: true,
                            visiblePositiveHalo: true,
                            positiveHaloLum: 6.5,
                            haloVisibility: 0.2,
                            gradientResidual: 0.1,
                            spatialResidual: 0.08
                        }
                    }
                ]
            },
            visibleTop: {
                records: [
                    {
                        file: 'pending-a.png',
                        bucket: 'visibleTop',
                        source: 'test',
                        cropPath: 'pending-a.png',
                        config: {
                            logoSize: 48,
                            marginRight: 96,
                            marginBottom: 96
                        },
                        residualVisibility: {
                            visible: true,
                            visiblePositiveHalo: true,
                            visibleSpatialResidual: true,
                            positiveHaloLum: 8.5,
                            haloVisibility: 0.3,
                            gradientResidual: 0.12,
                            spatialResidual: 0.2
                        }
                    }
                ]
            }
        }
    };
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    await writeFile(summaryPath, summaryText, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-review-manifest.js'),
        '--summary', summaryPath,
        '--output', outputPath
    ]);

    const manifest = await readJson(outputPath);
    assert.equal(manifest.inputs.renderSummaryPath, summaryPath);
    assert.equal(manifest.inputs.renderSummarySha256, sha256Text(summaryText));
    assert.equal(manifest.sourceRenderSummaryPath, summary.summaryPath);
    assert.equal(manifest.summary.metricPassVisibleReviewed, 1);
    assert.equal(manifest.summary.visibleTopPending, 1);
});

test('render-visible-residual-review-queues should record review manifest provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-queues-provenance-'));
    const cropPath = path.join(tempDir, 'crop.svg');
    await writeTinySvg(cropPath);
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const outputDir = path.join(tempDir, 'review-queues');
    const manifestText = `${JSON.stringify({
        workQueues: {
            modelInvestigation: [
                {
                    file: 'candidate-a.png',
                    cropPath
                }
            ],
            goldToleranceDiscussion: [],
            humanReviewNext: []
        }
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/render-visible-residual-review-queues.js'),
        '--manifest', manifestPath,
        '--out-dir', outputDir
    ]);

    const summary = await readJson(path.join(outputDir, 'summary.json'));
    assert.equal(summary.inputs.reviewManifestPath, manifestPath);
    assert.equal(summary.inputs.reviewManifestSha256, sha256Text(manifestText));
    assert.equal(summary.queues.modelInvestigation.count, 1);
});

test('create-visible-residual-human-review-pack should preserve human input files across regeneration', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-pack-preserve-'));
    const { manifestPath, outputDir } = await writeReviewPackInputs(tempDir);

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-human-review-pack.js'),
        '--manifest', manifestPath,
        '--out-dir', outputDir
    ]);

    const firstSummary = await readJson(path.join(outputDir, 'summary.json'));
    assert.equal(firstSummary.decisionsInputPreservedExisting, false);
    assert.equal(firstSummary.goldCandidateConfirmationsInputPreservedExisting, false);

    const decisionsPath = path.join(outputDir, 'review-decisions.json');
    const candidatePath = path.join(outputDir, 'gold-candidate-confirmations.json');
    const decisions = await readJson(decisionsPath);
    const candidateDecisions = await readJson(candidatePath);
    decisions.decisions[0].humanVerdict = 'acceptableResidual';
    decisions.decisions[0].humanConfidence = 'medium';
    decisions.decisions[0].humanNotes = 'Manual review in progress.';
    delete decisions.reviewManifestSha256;
    candidateDecisions.decisions[0].humanVerdict = 'trueVisibleResidual';
    candidateDecisions.decisions[0].humanConfidence = 'high';
    candidateDecisions.decisions[0].humanNotes = 'Confirmed by human.';
    delete candidateDecisions.reviewManifestSha256;
    await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    await writeFile(candidatePath, `${JSON.stringify(candidateDecisions, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-human-review-pack.js'),
        '--manifest', manifestPath,
        '--out-dir', outputDir
    ]);

    const secondSummary = await readJson(path.join(outputDir, 'summary.json'));
    assert.equal(secondSummary.decisionsInputPreservedExisting, true);
    assert.equal(secondSummary.goldCandidateConfirmationsInputPreservedExisting, true);
    assert.equal(secondSummary.decisionsInputReviewManifestSha256Added, true);
    assert.equal(secondSummary.goldCandidateConfirmationsInputReviewManifestSha256Added, true);
    assert.match(secondSummary.reviewManifestSha256, /^[0-9a-f]{64}$/);
    assert.match(secondSummary.reviewInputContractSha256, /^[0-9a-f]{64}$/);
    assert.equal(
        secondSummary.artifactHashes.readmeSha256,
        await sha256File(path.join(outputDir, 'README.md'))
    );
    assert.equal(
        secondSummary.artifactHashes.decisionsTemplateSha256,
        await sha256File(path.join(outputDir, 'review-decisions.template.json'))
    );
    assert.equal(
        secondSummary.artifactHashes.decisionsSha256,
        await sha256File(path.join(outputDir, 'review-decisions.json'))
    );
    assert.equal(
        secondSummary.artifactHashes.goldCandidateConfirmationsTemplateSha256,
        await sha256File(path.join(outputDir, 'gold-candidate-confirmations.template.json'))
    );
    assert.equal(
        secondSummary.artifactHashes.goldCandidateConfirmationsSha256,
        await sha256File(path.join(outputDir, 'gold-candidate-confirmations.json'))
    );
    assert.equal(
        secondSummary.artifactHashes.reviewInputContractSha256,
        await sha256File(path.join(outputDir, 'review-input-contract.json'))
    );
    assert.equal(
        secondSummary.artifactHashes.allPendingSheetSha256,
        await sha256File(secondSummary.allPendingSheet.outputPath)
    );
    assert.equal(
        secondSummary.artifactHashes.goldCandidateSheetSha256,
        await sha256File(secondSummary.goldCandidateSheet.outputPath)
    );
    assert.equal(
        secondSummary.artifactHashes.groupedSheets['48px-large-margin'].sha256,
        await sha256File(secondSummary.groupedSheets['48px-large-margin'].outputPath)
    );

    const preservedDecisions = await readJson(decisionsPath);
    const preservedCandidateDecisions = await readJson(candidatePath);
    const reviewInputContract = await readJson(path.join(outputDir, 'review-input-contract.json'));
    const readme = await readFile(path.join(outputDir, 'README.md'), 'utf8');
    assert.equal(reviewInputContract.reviewManifestSha256, secondSummary.reviewManifestSha256);
    assert.deepEqual(reviewInputContract.allowedHumanConfidence, ['high', 'medium', 'low']);
    assert.deepEqual(
        reviewInputContract.allowedDecisionInputRootFields,
        ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS
    );
    assert.deepEqual(reviewInputContract.allowedDecisionFields, ALLOWED_HUMAN_REVIEW_DECISION_FIELDS);
    assert.deepEqual(reviewInputContract.blockingVerdictsRequireHumanNotes, [
        'trueVisibleResidual',
        'needsModelInvestigation'
    ]);
    assert.equal(reviewInputContract.policy.writesFormalGoldManifest, false);
    assert.equal(reviewInputContract.policy.writesProductionAlgorithm, false);
    assert.equal(
        reviewInputContract.decisionSets.find((set) => set.name === 'visibleTopPending').expectedCount,
        2
    );
    assert.equal(
        reviewInputContract.decisionSets.find((set) => set.name === 'metricPassVisible').expectedCount,
        1
    );
    assert.match(readme, /人工只编辑 `review-decisions\.json`/);
    assert.match(readme, /## Review Workflow/);
    assert.match(readme, /visible-residual:review-status/);
    assert.match(readme, /review-handoff\.md/);
    assert.match(readme, /cluster sheets and per-decision crop previews/);
    assert.match(readme, /review-focused-batch\.json/);
    assert.match(readme, /Edit only `humanVerdict` \/ `humanConfidence` \/ `humanNotes`/);
    assert.match(readme, /Allowed `humanVerdict` values/);
    assert.match(readme, /Allowed `humanConfidence` values/);
    assert.match(readme, /visible-residual:apply-focused-batch --dry-run/);
    assert.match(readme, /reviewBatches/);
    assert.match(readme, /goldCandidateReviewBatches/);
    assert.match(readme, /Fill `gold-candidate-confirmations\.json`/);
    assert.match(readme, /validation、admission 和正式 gold 迁移都会校验 contract provenance/);
    assert.match(readme, /所有确认项完成前，`gold-manifest\.json` 必须保持不生成/);
    assert.doesNotMatch(readme, /杩|鑲|纭|锛|€/);
    assert.equal(preservedDecisions.decisions[0].humanVerdict, 'acceptableResidual');
    assert.equal(preservedDecisions.decisions[0].humanConfidence, 'medium');
    assert.equal(preservedDecisions.decisions[0].humanNotes, 'Manual review in progress.');
    assert.equal(preservedDecisions.reviewManifestSha256, secondSummary.reviewManifestSha256);
    assert.equal(preservedCandidateDecisions.decisions[0].humanVerdict, 'trueVisibleResidual');
    assert.equal(preservedCandidateDecisions.decisions[0].humanConfidence, 'high');
    assert.equal(preservedCandidateDecisions.decisions[0].humanNotes, 'Confirmed by human.');
    assert.equal(preservedCandidateDecisions.reviewManifestSha256, secondSummary.reviewManifestSha256);

    const regeneratedTemplate = await readJson(path.join(outputDir, 'review-decisions.template.json'));
    assert.equal(regeneratedTemplate.decisions[0].humanVerdict, null);
    assert.equal(regeneratedTemplate.decisions[0].humanConfidence, null);
    assert.equal(regeneratedTemplate.reviewManifestSha256, secondSummary.reviewManifestSha256);
    assert.equal(regeneratedTemplate.decisions[0].clusterId, 'visibleTopPending::48px-large-margin::positiveHalo');
});

test('create-visible-residual-human-review-pack should replace stale empty human inputs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-pack-stale-empty-'));
    const { manifestPath, outputDir } = await writeReviewPackInputs(tempDir);

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-human-review-pack.js'),
        '--manifest', manifestPath,
        '--out-dir', outputDir
    ]);
    const firstSummary = await readJson(path.join(outputDir, 'summary.json'));
    const decisionsPath = path.join(outputDir, 'review-decisions.json');
    const candidatePath = path.join(outputDir, 'gold-candidate-confirmations.json');
    const decisions = await readJson(decisionsPath);
    const candidateDecisions = await readJson(candidatePath);
    decisions.reviewManifestSha256 = '0'.repeat(64);
    candidateDecisions.reviewManifestSha256 = '1'.repeat(64);
    await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    await writeFile(candidatePath, `${JSON.stringify(candidateDecisions, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-human-review-pack.js'),
        '--manifest', manifestPath,
        '--out-dir', outputDir
    ]);

    const secondSummary = await readJson(path.join(outputDir, 'summary.json'));
    const replacedDecisions = await readJson(decisionsPath);
    const replacedCandidateDecisions = await readJson(candidatePath);
    assert.equal(secondSummary.decisionsInputPreservedExisting, false);
    assert.equal(secondSummary.goldCandidateConfirmationsInputPreservedExisting, false);
    assert.equal(secondSummary.decisionsInputStaleEmptyReplaced, true);
    assert.equal(secondSummary.goldCandidateConfirmationsInputStaleEmptyReplaced, true);
    assert.equal(replacedDecisions.reviewManifestSha256, firstSummary.reviewManifestSha256);
    assert.equal(replacedCandidateDecisions.reviewManifestSha256, firstSummary.reviewManifestSha256);
    assert.equal(replacedDecisions.decisions[0].humanVerdict, null);
    assert.equal(replacedCandidateDecisions.decisions[0].humanVerdict, null);
});

test('validate-visible-residual-human-review should block gold migration until decisions are filled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-unfilled-'));
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload()
    );

    await execFileAsync(process.execPath, [
        path.resolve('scripts/validate-visible-residual-human-review.js'),
        '--manifest', manifestPath,
        '--decisions', decisionsPath,
        '--output', outputPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.pendingTotal, 2);
    assert.equal(report.decisionTotal, 2);
    assert.equal(report.unconfirmedCount, 2);
    assert.equal(report.structuralErrorCount, 0);
    assert.equal(report.readyDecisionCount, 0);
    assert.equal(report.decisionSchemaGate.armed, true);
    assert.equal(report.decisionSchemaGate.rejectsUnknownDecisionFields, true);
    assert.equal(report.decisionSchemaGate.rejectsAlphaProfileVariantFields, true);
    assert.equal(report.decisionSchemaGate.ok, true);
    assert.equal(report.incompleteDecisions[0].decisionInputPath, decisionsPath);
    assert.equal(report.incompleteDecisions[0].decisionArrayIndex, 0);
    assert.equal(report.incompleteDecisions[0].decisionIndex, 0);
    assert.equal(report.incompleteDecisions[0].decisionJsonPath, 'decisions[0]');
    assert.equal(report.policy.writesFormalGoldManifest, false);
    assert.equal(report.policy.writesProductionAlgorithm, false);
});

test('validate-visible-residual-human-review should reject alpha profile and unknown decision fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-decision-schema-gate-'));
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    humanVerdict: 'acceptableResidual',
                    humanConfidence: 'medium',
                    humanNotes: '',
                    profileVariant: 'mid-boost-1.24',
                    cleanupMode: 'smooth'
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'contentCollision',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            }
        ])
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.readyDecisionCount, 1);
    assert.equal(report.decisionSchemaGate.ok, false);
    assert.equal(report.decisionSchemaGate.rejectsUnknownDecisionInputRootFields, true);
    assert.deepEqual(report.decisionSchemaGate.forbiddenAlphaProfileFieldPaths, ['pending-a.png.profileVariant']);
    assert.deepEqual(report.decisionSchemaGate.unknownDecisionFieldPaths, [
        'pending-a.png.profileVariant',
        'pending-a.png.cleanupMode'
    ]);
    assert.deepEqual(report.structuralErrors[0].problems, [
        'decision-alpha-profile-variant-fields-present',
        'decision-unknown-fields-present'
    ]);
});

test('validate-visible-residual-human-review should reject alpha profile and unknown input root fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-root-schema-gate-'));
    const decisions = createDecisionPayload([
        {
            index: 0,
            patch: {
                humanVerdict: 'acceptableResidual',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        },
        {
            index: 1,
            patch: {
                humanVerdict: 'contentCollision',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        }
    ]);
    decisions.profileVariant = 'mid-boost-1.24';
    decisions.cleanupMode = 'smooth';
    decisions.instructions = {
        ...(decisions.instructions ?? {}),
        renderProfile: 'experimental'
    };
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(tempDir, decisions);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 2);
    assert.equal(report.readyDecisionCount, 2);
    assert.equal(report.decisionSchemaGate.ok, false);
    assert.deepEqual(report.decisionSchemaGate.forbiddenAlphaProfileFieldPaths, [
        'review-decisions.json.profileVariant',
        'review-decisions.json.instructions.renderProfile'
    ]);
    assert.deepEqual(report.decisionSchemaGate.unknownDecisionInputRootFieldPaths, [
        'review-decisions.json.profileVariant',
        'review-decisions.json.cleanupMode'
    ]);
    assert.deepEqual(report.structuralErrors.map((entry) => entry.type), [
        'decision-input-alpha-profile-variant-fields-present',
        'decision-input-unknown-root-fields-present'
    ]);
});

test('validate-visible-residual-human-review should allow gold migration proposal after complete human decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-filled-'));
    const { manifestPath, decisionsPath, candidateDecisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    humanVerdict: 'trueVisibleResidual',
                    humanConfidence: 'high',
                    humanNotes: 'Visible star-shaped residual remains in the ROI.'
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'contentCollision',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            }
        ])
    );
    await writeFile(candidateDecisionsPath, `${JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/validate-visible-residual-human-review.js'),
        '--manifest', manifestPath,
        '--decisions', decisionsPath,
        '--output', outputPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, true);
    assert.match(report.reviewManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.unconfirmedCount, 0);
    assert.equal(report.structuralErrorCount, 0);
    assert.equal(report.readyDecisionCount, 2);
    assert.deepEqual(report.verdictCounts, {
        contentCollision: 1,
        trueVisibleResidual: 1
    });
});

test('validate-visible-residual-human-review should also require gold candidate confirmations', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-candidate-unfilled-'));
    const { manifestPath, decisionsPath, candidateDecisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    humanVerdict: 'acceptableResidual',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'contentCollision',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            }
        ]),
        {
            includeGoldCandidate: true,
            candidateDecisions: createGoldCandidateDecisionPayload()
        }
    );

    await execFileAsync(process.execPath, [
        path.resolve('scripts/validate-visible-residual-human-review.js'),
        '--manifest', manifestPath,
        '--decisions', decisionsPath,
        '--candidate-decisions', candidateDecisionsPath,
        '--output', outputPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.pendingReadyDecisionCount, 2);
    assert.equal(report.goldCandidateReadyDecisionCount, 0);
    assert.equal(report.pendingUnconfirmedCount, 0);
    assert.equal(report.goldCandidateUnconfirmedCount, 1);

    await writeFile(candidateDecisionsPath, `${JSON.stringify(createGoldCandidateDecisionPayload([
        {
            index: 0,
            patch: {
                humanVerdict: 'trueVisibleResidual',
                humanConfidence: 'high',
                humanNotes: 'Confirmed visible residual.'
            }
        }
    ]), null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/validate-visible-residual-human-review.js'),
        '--manifest', manifestPath,
        '--decisions', decisionsPath,
        '--candidate-decisions', candidateDecisionsPath,
        '--output', outputPath
    ]);

    const readyReport = await readJson(outputPath);
    assert.equal(readyReport.readyForGoldMigration, true);
    assert.equal(readyReport.readyDecisionCount, 3);
    assert.equal(readyReport.goldCandidateReadyDecisionCount, 1);
});

test('validate-visible-residual-human-review should reject blocking verdicts without notes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-invalid-'));
    const { manifestPath, decisionsPath, candidateDecisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    humanVerdict: 'needsModelInvestigation',
                    humanConfidence: 'high',
                    humanNotes: ''
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'acceptableResidual',
                    humanConfidence: 'low',
                    humanNotes: ''
                }
            }
        ])
    );
    await writeFile(candidateDecisionsPath, `${JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2)}\n`, 'utf8');

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.readyDecisionCount, 1);
    assert.equal(report.structuralErrors[0].type, 'invalid-decision');
    assert.deepEqual(report.structuralErrors[0].problems, ['blocking-verdict-requires-humanNotes']);
});

test('validate-visible-residual-human-review should reject stale cluster and source ids', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-stale-cluster-'));
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::wrong-profile::positiveHalo',
                    humanVerdict: 'acceptableResidual',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'contentCollision',
                    humanConfidence: 'medium',
                    humanNotes: ''
                }
            }
        ])
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.readyDecisionCount, 1);
    assert.equal(report.structuralErrors[0].type, 'invalid-decision');
    assert.deepEqual(report.structuralErrors[0].problems, ['sourceSet-mismatch', 'clusterId-mismatch']);
    assert.equal(report.structuralErrors[0].expectedSourceSet, 'visibleTopPending');
    assert.equal(report.structuralErrors[0].expectedClusterId, 'visibleTopPending::48px-large-margin::positiveHalo');
});

test('validate-visible-residual-human-review should reject stale decision indexes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-stale-index-'));
    const decisions = createDecisionPayload([
        {
            index: 0,
            patch: {
                index: 99,
                humanVerdict: 'acceptableResidual',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        },
        {
            index: 1,
            patch: {
                humanVerdict: 'contentCollision',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        }
    ]);
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(tempDir, decisions);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.readyDecisionCount, 1);
    assert.equal(report.structuralErrors[0].type, 'invalid-decision');
    assert.equal(report.structuralErrors[0].file, 'pending-a.png');
    assert.deepEqual(report.structuralErrors[0].problems, ['decision-index-mismatch']);
    assert.equal(report.structuralErrors[0].decisionArrayIndex, 0);
    assert.equal(report.structuralErrors[0].decisionIndex, 99);
    assert.equal(report.structuralErrors[0].decisionJsonPath, 'decisions[0]');
});

test('validate-visible-residual-human-review should reject stale manifest hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-stale-manifest-hash-'));
    const decisions = createDecisionPayload([
        {
            index: 0,
            patch: {
                humanVerdict: 'acceptableResidual',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        },
        {
            index: 1,
            patch: {
                humanVerdict: 'contentCollision',
                humanConfidence: 'medium',
                humanNotes: ''
            }
        }
    ]);
    decisions.reviewManifestSha256 = '0'.repeat(64);
    const { manifestPath, decisionsPath, outputPath } = await writeValidationInputs(tempDir, decisions);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.readyDecisionCount, 2);
    assert.equal(report.structuralErrors[0].type, 'review-manifest-sha256-mismatch');
    assert.match(report.structuralErrors[0].expectedReviewManifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.structuralErrors[0].actualReviewManifestSha256, '0'.repeat(64));
});

test('validate-visible-residual-human-review should reject stale review input contracts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-stale-contract-'));
    const contractPath = path.join(tempDir, 'review-input-contract.json');
    const {
        manifestPath,
        decisionsPath,
        candidateDecisionsPath,
        outputPath
    } = await writeValidationInputs(
        tempDir,
        createDecisionPayload([
            {
                index: 0,
                patch: {
                    humanVerdict: 'acceptableResidual',
                    humanConfidence: 'medium'
                }
            },
            {
                index: 1,
                patch: {
                    humanVerdict: 'contentCollision',
                    humanConfidence: 'low'
                }
            }
        ])
    );
    await writeFile(candidateDecisionsPath, `${JSON.stringify({ schemaVersion: 1, decisions: [] }, null, 2)}\n`, 'utf8');
    await writeFile(contractPath, `${JSON.stringify({
        schemaVersion: 1,
        reviewManifestSha256: '0'.repeat(64),
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        allowedHumanVerdicts: [
            'trueVisibleResidual',
            'backgroundStructure',
            'contentCollision',
            'acceptableResidual',
            'needsModelInvestigation'
        ],
        allowedHumanConfidence: ['high', 'medium', 'low'],
        allowedDecisionInputRootFields: ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS,
        allowedDecisionFields: ALLOWED_HUMAN_REVIEW_DECISION_FIELDS,
        forbiddenAlphaProfileFieldKeys: FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS,
        blockingVerdictsRequireHumanNotes: [
            'trueVisibleResidual',
            'needsModelInvestigation'
        ],
        decisionSets: [
            {
                name: 'visibleTopPending',
                inputPath: decisionsPath,
                expectedCount: 2
            },
            {
                name: 'metricPassVisible',
                inputPath: candidateDecisionsPath,
                expectedCount: 0
            }
        ]
    }, null, 2)}\n`, 'utf8');

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/validate-visible-residual-human-review.js'),
            '--manifest', manifestPath,
            '--decisions', decisionsPath,
            '--candidate-decisions', candidateDecisionsPath,
            '--contract', contractPath,
            '--output', outputPath
        ])
    );

    const report = await readJson(outputPath);
    assert.equal(report.readyForGoldMigration, false);
    assert.equal(report.unconfirmedCount, 0);
    assert.equal(report.structuralErrorCount, 1);
    assert.equal(report.reviewInputContractPath, contractPath);
    assert.match(report.reviewInputContractSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.structuralErrors[0].sourceSet, 'reviewInputContract');
    assert.equal(report.structuralErrors[0].type, 'review-input-contract-manifest-hash-mismatch');
});

test('report-visible-residual-review-progress should summarize blockers and optionally write a report artifact', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-status-'));
    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const clusterPath = path.join(tempDir, 'review-clusters.json');
    const outputPath = path.join(tempDir, 'review-progress-report.json');
    const checkpointPath = path.join(tempDir, 'review-checkpoint.json');
    const focusedBatchPath = path.join(tempDir, 'review-focused-batch.json');
    const handoffPath = path.join(tempDir, 'review-handoff.md');
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const validationText = `${JSON.stringify({
        outputPath: validationPath,
        reviewManifestPath: manifestPath,
        decisionsPath: path.join(tempDir, 'review-decisions.json'),
        candidateDecisionsPath: path.join(tempDir, 'gold-candidate-confirmations.json'),
        readyForGoldMigration: false,
        pendingTotal: 2,
        goldCandidateTotal: 1,
        readyDecisionCount: 0,
        pendingReadyDecisionCount: 0,
        goldCandidateReadyDecisionCount: 0,
        unconfirmedCount: 3,
        pendingUnconfirmedCount: 2,
        goldCandidateUnconfirmedCount: 1,
        structuralErrorCount: 0,
        verdictCounts: {},
        confidenceCounts: {},
        incompleteDecisions: [
            {
                sourceSet: 'visibleTopPending',
                file: 'pending-a.png',
                decisionInputPath: path.join(tempDir, 'review-decisions.json'),
                decisionArrayIndex: 0,
                decisionIndex: 0,
                decisionJsonPath: 'decisions[0]',
                problems: ['invalid-or-missing-humanVerdict', 'invalid-or-missing-humanConfidence']
            },
            {
                sourceSet: 'metricPassVisible',
                file: 'candidate-a.png',
                decisionInputPath: path.join(tempDir, 'gold-candidate-confirmations.json'),
                decisionArrayIndex: 0,
                decisionIndex: 0,
                decisionJsonPath: 'decisions[0]',
                problems: ['invalid-or-missing-humanVerdict', 'invalid-or-missing-humanConfidence']
            },
            {
                sourceSet: 'visibleTopPending',
                file: 'pending-b.png',
                decisionInputPath: path.join(tempDir, 'review-decisions.json'),
                decisionArrayIndex: 1,
                decisionIndex: 1,
                decisionJsonPath: 'decisions[1]',
                problems: ['invalid-or-missing-humanVerdict', 'invalid-or-missing-humanConfidence']
            }
        ],
        structuralErrors: [],
        readyDecisions: []
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(validationPath, validationText, 'utf8');
    await writeFile(clusterPath, `${JSON.stringify({
        outputPath: clusterPath,
        inputs: {
            reviewManifestSha256: sha256Text(manifestText),
            validationReportSha256: sha256Text(validationText)
        },
        policy: {
            readOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        summary: {
            totalRecords: 3,
            clusterTotal: 2,
            clusterSheetCount: 2,
            unconfirmedCount: 3,
            structuralErrorCount: 0
        },
        clusters: [
            {
                clusterId: 'visibleTopPending::45px-other::gradientResidual+spatialResidual',
                sourceSet: 'visibleTopPending',
                profileLine: '45px-other',
                visibleReasons: ['gradientResidual', 'spatialResidual'],
                count: 4,
                incompleteCount: 4,
                readyCount: 0,
                sheet: {
                    outputPath: path.join(tempDir, 'cluster-top.png'),
                    count: 4
                },
                files: [
                    {
                        file: 'pending-b.png',
                        cropPath: path.join(tempDir, 'pending-b-crop.png')
                    }
                ]
            },
            {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                sourceSet: 'visibleTopPending',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                count: 3,
                incompleteCount: 3,
                readyCount: 0,
                sheet: {
                    outputPath: path.join(tempDir, 'cluster.png'),
                    count: 3
                },
                files: [
                    {
                        file: 'pending-a.png',
                        cropPath: path.join(tempDir, 'pending-a-crop.png')
                    }
                ]
            },
            {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                sourceSet: 'metricPassVisible',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                count: 1,
                incompleteCount: 1,
                readyCount: 0,
                sheet: {
                    outputPath: path.join(tempDir, 'candidate-cluster.png'),
                    count: 1
                },
                files: [
                    {
                        file: 'candidate-a.png',
                        cropPath: path.join(tempDir, 'candidate-a-crop.png')
                    }
                ]
            }
        ]
    }, null, 2)}\n`, 'utf8');

    const { stdout } = await execFileAsync(process.execPath, [
        path.resolve('scripts/report-visible-residual-review-progress.js'),
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--clusters', clusterPath,
        '--limit', '2'
    ]);
    const report = JSON.parse(stdout);

    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(checkpointPath), false);
    assert.equal(existsSync(focusedBatchPath), false);
    assert.equal(existsSync(handoffPath), false);
    assert.equal(report.policy.readOnly, true);
    assert.equal(report.policy.writesReviewProgressReport, false);
    assert.equal(report.policy.writesReviewCheckpoint, false);
    assert.equal(report.policy.writesFocusedReviewBatch, false);
    assert.equal(report.policy.writesReviewHandoff, false);
    assert.equal(report.policy.writesFormalGoldManifest, false);
    assert.equal(report.reviewCheckpoint.status, 'human-review-required');
    assert.equal(report.reviewCheckpoint.policy.writesFormalGoldManifest, false);
    assert.equal(report.reviewCheckpoint.policy.writesProductionAlgorithm, false);
    assert.equal(report.reviewCheckpoint.policy.allowsAlphaProfileProduction, false);
    assert.equal(report.reviewCheckpoint.provenance.validationReportSha256, sha256Text(await readFile(validationPath, 'utf8')));
    assert.equal(report.reviewCheckpoint.nextReviewRound.visibleResidualBatch.firstDecisionJsonPath, 'decisions[1]');
    assert.equal(report.reviewCheckpoint.nextReviewRound.goldCandidateBatch.firstDecisionInputPath, path.join(tempDir, 'gold-candidate-confirmations.json'));
    assert.equal(report.focusedReviewBatch.policy.dryRunCommand, 'pnpm visible-residual:apply-focused-batch --dry-run');
    assert.equal(report.focusedReviewBatch.policy.applyCommand, 'pnpm visible-residual:apply-focused-batch');
    assert.deepEqual(report.focusedReviewBatch.policy.humanEditableFields, ['humanVerdict', 'humanConfidence', 'humanNotes']);
    assert.deepEqual(report.focusedReviewBatch.policy.validHumanConfidence, ['high', 'medium', 'low']);
    assert.ok(report.focusedReviewBatch.policy.validHumanVerdicts.includes('trueVisibleResidual'));
    assert.ok(report.focusedReviewBatch.policy.notesRequiredForVerdicts.includes('needsModelInvestigation'));
    assert.equal(report.focusedReviewBatch.policy.writesFormalGoldManifest, false);
    assert.equal(report.focusedReviewBatch.policy.writesProductionAlgorithm, false);
    assert.equal(report.focusedReviewBatch.decisions.length, 2);
    assert.equal(report.focusedReviewBatch.decisions[0].humanVerdict, null);
    assert.match(report.reviewHandoffMarkdown, /# Visible Residual Review Handoff/);
    assert.match(report.reviewHandoffMarkdown, /Focused Batch Editing Checklist/);
    assert.match(report.reviewHandoffMarkdown, /Edit only: humanVerdict, humanConfidence, humanNotes/);
    assert.match(report.reviewHandoffMarkdown, /humanVerdict allowed values: trueVisibleResidual/);
    assert.match(report.reviewHandoffMarkdown, /humanConfidence allowed values: high, medium, low/);
    assert.match(report.reviewHandoffMarkdown, /humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation/);
    assert.match(report.reviewHandoffMarkdown, /rtk pnpm visible-residual:apply-focused-batch --dry-run/);
    assert.match(report.reviewHandoffMarkdown, /!\[Visible residual cluster sheet\]\(/);
    assert.match(report.reviewHandoffMarkdown, /!\[Gold candidate cluster sheet\]\(/);
    assert.match(report.reviewHandoffMarkdown, /### Visible residual Decision Crop Previews/);
    assert.match(report.reviewHandoffMarkdown, /### Gold candidate Decision Crop Previews/);
    assert.match(report.reviewHandoffMarkdown, /!\[Visible residual decisions\[1\] crop\]\(/);
    assert.match(report.reviewHandoffMarkdown, /!\[Gold candidate decisions\[0\] crop\]\(/);
    assert.match(report.reviewHandoffMarkdown, /rtk pnpm visible-residual:apply-focused-batch/);
    assert.match(report.reviewHandoffMarkdown, /writesFormalGoldManifest: false/);
    assert.equal(report.summary.readyForGoldMigration, false);
    assert.equal(report.summary.totalReviewDecisions, 3);
    assert.equal(report.summary.unconfirmedCount, 3);
    assert.equal(report.inputs.validationReportSha256, sha256Text(await readFile(validationPath, 'utf8')));
    assert.equal(report.inputs.reviewManifestSha256, sha256Text(await readFile(manifestPath, 'utf8')));
    assert.equal(report.inputs.reviewClusterSha256, sha256Text(await readFile(clusterPath, 'utf8')));
    assert.deepEqual(report.counts.incompleteBySourceSet, {
        metricPassVisible: 1,
        visibleTopPending: 2
    });
    assert.deepEqual(report.counts.incompleteByProfile, {
        '45px-other': 1,
        '48px-large-margin': 2
    });
    assert.equal(report.clusterSummary.available, true);
    assert.equal(report.clusterSummary.clusterTotal, 2);
    assert.deepEqual(report.counts.incompleteByCluster, {
        'metricPassVisible::48px-large-margin::positiveHalo': 1,
        'visibleTopPending::45px-other::gradientResidual+spatialResidual': 4,
        'visibleTopPending::48px-large-margin::positiveHalo': 3
    });
    assert.equal(report.nextReviewClusters.length, 2);
    assert.equal(report.nextReviewClusters[0].clusterId, 'visibleTopPending::45px-other::gradientResidual+spatialResidual');
    assert.equal(report.nextReviewClusters[0].incompleteCount, 4);
    assert.equal(report.nextReviewClusters[0].firstFile, 'pending-b.png');
    assert.equal(report.nextReviewItems.length, 2);
    assert.equal(report.nextReviewItems[0].file, 'pending-b.png');
    assert.equal(report.nextReviewItems[0].clusterId, 'visibleTopPending::45px-other::gradientResidual+spatialResidual');
    assert.equal(report.nextReviewItems[0].decisionInputPath, path.join(tempDir, 'review-decisions.json'));
    assert.equal(report.nextReviewItems[0].decisionArrayIndex, 1);
    assert.equal(report.nextReviewItems[0].decisionIndex, 1);
    assert.equal(report.nextReviewItems[0].decisionJsonPath, 'decisions[1]');
    assert.equal(report.nextReviewBatch.cluster.clusterId, 'visibleTopPending::45px-other::gradientResidual+spatialResidual');
    assert.equal(report.nextReviewBatch.items[0].file, 'pending-b.png');
    assert.deepEqual(report.blockers, ['human-review-not-complete']);

    const { stdout: outputStdout } = await execFileAsync(process.execPath, [
        path.resolve('scripts/report-visible-residual-review-progress.js'),
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--clusters', clusterPath,
        '--output', outputPath,
        '--checkpoint-output', checkpointPath,
        '--focused-batch-output', focusedBatchPath,
        '--handoff-output', handoffPath,
        '--limit', '2'
    ]);
    const outputReport = JSON.parse(outputStdout);
    const persistedReport = await readJson(outputPath);
    const persistedCheckpoint = await readJson(checkpointPath);
    const persistedFocusedBatch = await readJson(focusedBatchPath);
    const persistedHandoff = await readFile(handoffPath, 'utf8');

    assert.equal(outputReport.policy.writesReviewProgressReport, true);
    assert.equal(outputReport.policy.writesReviewCheckpoint, true);
    assert.equal(outputReport.policy.writesFocusedReviewBatch, true);
    assert.equal(outputReport.policy.writesReviewHandoff, true);
    assert.equal(persistedReport.policy.writesReviewProgressReport, true);
    assert.equal(persistedReport.policy.writesReviewCheckpoint, true);
    assert.equal(persistedReport.policy.writesFocusedReviewBatch, true);
    assert.equal(persistedReport.policy.writesReviewHandoff, true);
    assert.equal(persistedReport.outputs.reviewProgressReportPath, outputPath);
    assert.equal(persistedReport.outputs.reviewCheckpointPath, checkpointPath);
    assert.equal(persistedReport.outputs.focusedReviewBatchPath, focusedBatchPath);
    assert.equal(persistedReport.outputs.reviewHandoffPath, handoffPath);
    assert.equal(persistedReport.inputs.validationReportSha256, sha256Text(await readFile(validationPath, 'utf8')));
    assert.equal(persistedReport.inputs.reviewManifestSha256, sha256Text(await readFile(manifestPath, 'utf8')));
    assert.equal(persistedReport.inputs.reviewClusterSha256, sha256Text(await readFile(clusterPath, 'utf8')));
    assert.equal(persistedReport.summary.unconfirmedCount, 3);
    assert.equal(persistedReport.nextReviewClusters[0].clusterId, 'visibleTopPending::45px-other::gradientResidual+spatialResidual');
    assert.equal(persistedReport.nextReviewBatch.cluster.clusterId, 'visibleTopPending::45px-other::gradientResidual+spatialResidual');
    assert.deepEqual(persistedReport.reviewCheckpoint, persistedCheckpoint);
    assert.deepEqual(persistedReport.focusedReviewBatch, persistedFocusedBatch);
    assert.equal(persistedCheckpoint.status, 'human-review-required');
    assert.equal(persistedCheckpoint.policy.writesReviewProgressReport, true);
    assert.equal(persistedCheckpoint.nextReviewRound.visibleResidualBatch.decisionTargets.length, 1);
    assert.equal(persistedCheckpoint.nextReviewRound.goldCandidateBatch.decisionTargets.length, 1);
    assert.equal(persistedCheckpoint.blockedActions[0].id, 'write-formal-gold-manifest');
    assert.equal(persistedCheckpoint.blockedActions[0].blocked, true);
    assert.equal(persistedFocusedBatch.policy.dryRunCommand, 'pnpm visible-residual:apply-focused-batch --dry-run');
    assert.equal(persistedFocusedBatch.policy.applyCommand, 'pnpm visible-residual:apply-focused-batch');
    assert.deepEqual(persistedFocusedBatch.policy.humanEditableFields, ['humanVerdict', 'humanConfidence', 'humanNotes']);
    assert.deepEqual(persistedFocusedBatch.policy.validHumanConfidence, ['high', 'medium', 'low']);
    assert.ok(persistedFocusedBatch.policy.validHumanVerdicts.includes('trueVisibleResidual'));
    assert.ok(persistedFocusedBatch.policy.notesRequiredForVerdicts.includes('needsModelInvestigation'));
    assert.equal(persistedFocusedBatch.decisions.length, 2);
    assert.equal(persistedFocusedBatch.decisions[0].decisionJsonPath, 'decisions[1]');
    assert.equal(persistedFocusedBatch.decisions[1].sourceSet, 'metricPassVisible');
    assert.equal(persistedReport.reviewHandoffMarkdown, persistedHandoff);
    assert.match(persistedHandoff, /# Visible Residual Review Handoff/);
    assert.match(persistedHandoff, new RegExp(sha256Text(await readFile(validationPath, 'utf8'))));
    assert.match(persistedHandoff, /review-focused-batch\.json/);
    assert.match(persistedHandoff, /Focused Batch Editing Checklist/);
    assert.match(persistedHandoff, /Edit only: humanVerdict, humanConfidence, humanNotes/);
    assert.match(persistedHandoff, /humanVerdict allowed values: trueVisibleResidual/);
    assert.match(persistedHandoff, /humanConfidence allowed values: high, medium, low/);
    assert.match(persistedHandoff, /humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation/);
    assert.match(persistedHandoff, /rtk pnpm visible-residual:apply-focused-batch --dry-run/);
    assert.match(persistedHandoff, /!\[Visible residual cluster sheet\]\(/);
    assert.match(persistedHandoff, /!\[Gold candidate cluster sheet\]\(/);
    assert.match(persistedHandoff, /### Visible residual Decision Crop Previews/);
    assert.match(persistedHandoff, /### Gold candidate Decision Crop Previews/);
    assert.match(persistedHandoff, /!\[Visible residual decisions\[1\] crop\]\(/);
    assert.match(persistedHandoff, /!\[Gold candidate decisions\[0\] crop\]\(/);
    assert.match(persistedHandoff, /rtk pnpm visible-residual:validate-human-review/);
    assert.match(persistedHandoff, /writesProductionAlgorithm: false/);
    assert.match(persistedHandoff, /allowsAlphaProfileProduction: false/);
    assert.match(persistedHandoff, /decisions\[1\]/);
});

test('report-visible-residual-review-progress should reject stale cluster reports', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-status-stale-cluster-'));
    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const clusterPath = path.join(tempDir, 'review-clusters.json');
    const outputPath = path.join(tempDir, 'review-progress-report.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(validationPath, `${JSON.stringify(createValidationReport({ ready: false }), null, 2)}\n`, 'utf8');
    await writeFile(clusterPath, `${JSON.stringify({
        inputs: {
            reviewManifestSha256: '0'.repeat(64),
            validationReportSha256: '1'.repeat(64)
        },
        summary: {
            clusterTotal: 1,
            clusterSheetCount: 1
        },
        clusters: []
    }, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/report-visible-residual-review-progress.js'),
            '--validation', validationPath,
            '--manifest', manifestPath,
            '--clusters', clusterPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /review-cluster-report-manifest-hash-mismatch/);
    assert.match(error.stderr, /review-cluster-report-validation-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('apply-visible-residual-focused-review-batch should merge complete human decisions and fail closed on incomplete input', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-focused-batch-'));
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const clusterPath = path.join(tempDir, 'review-clusters.json');
    const decisionsPath = path.join(tempDir, 'review-decisions.json');
    const candidateDecisionsPath = path.join(tempDir, 'gold-candidate-confirmations.json');
    const batchPath = path.join(tempDir, 'review-focused-batch.json');
    const incompleteBatchPath = path.join(tempDir, 'review-focused-batch-incomplete.json');
    const duplicateBatchPath = path.join(tempDir, 'review-focused-batch-duplicate.json');
    const badLocatorBatchPath = path.join(tempDir, 'review-focused-batch-bad-locator.json');
    const manifestText = `${JSON.stringify(createMinimalReviewManifest({ includeGoldCandidate: true }), null, 2)}\n`;
    const validationText = `${JSON.stringify({
        readyForGoldMigration: false,
        unconfirmedCount: 2
    }, null, 2)}\n`;
    const clusterText = `${JSON.stringify({
        inputs: {
            reviewManifestSha256: sha256Text(manifestText),
            validationReportSha256: sha256Text(validationText)
        },
        clusters: []
    }, null, 2)}\n`;
    const decisions = {
        schemaVersion: 1,
        reviewManifestSha256: sha256Text(manifestText),
        decisions: [
            {
                index: 0,
                sourceSet: 'visibleTopPending',
                file: 'pending-a.png',
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                cropPath: 'artifacts/pending-a.png',
                suggestedVerdict: null,
                suggestedConfidence: null,
                humanVerdict: null,
                humanConfidence: null,
                humanNotes: ''
            }
        ]
    };
    const candidateDecisions = {
        schemaVersion: 1,
        reviewManifestSha256: sha256Text(manifestText),
        decisions: [
            {
                index: 0,
                sourceSet: 'metricPassVisible',
                file: 'candidate-a.png',
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                cropPath: 'artifacts/candidate-a.png',
                suggestedVerdict: 'trueVisibleResidual',
                suggestedConfidence: 'high',
                humanVerdict: null,
                humanConfidence: null,
                humanNotes: ''
            }
        ]
    };
    const focusedBatch = {
        schemaVersion: 1,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        provenance: {
            validationReportSha256: sha256Text(validationText),
            reviewManifestSha256: sha256Text(manifestText),
            reviewClusterSha256: sha256Text(clusterText)
        },
        decisions: [
            {
                sourceSet: 'visibleTopPending',
                file: 'pending-a.png',
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                decisionInputPath: decisionsPath,
                decisionJsonPath: 'decisions[0]',
                decisionArrayIndex: 0,
                cropPath: 'artifacts/pending-a.png',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                suggestedVerdict: null,
                suggestedConfidence: null,
                problems: ['invalid-or-missing-humanVerdict'],
                humanVerdict: 'acceptableResidual',
                humanConfidence: 'high',
                humanNotes: ''
            },
            {
                sourceSet: 'metricPassVisible',
                file: 'candidate-a.png',
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                decisionInputPath: candidateDecisionsPath,
                decisionJsonPath: 'decisions[0]',
                decisionArrayIndex: 0,
                cropPath: 'artifacts/candidate-a.png',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                suggestedVerdict: 'trueVisibleResidual',
                suggestedConfidence: 'high',
                problems: ['invalid-or-missing-humanVerdict'],
                humanVerdict: 'trueVisibleResidual',
                humanConfidence: 'high',
                humanNotes: 'human confirmed visible residual'
            }
        ]
    };
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(validationPath, validationText, 'utf8');
    await writeFile(clusterPath, clusterText, 'utf8');
    await writeFile(decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8');
    await writeFile(candidateDecisionsPath, `${JSON.stringify(candidateDecisions, null, 2)}\n`, 'utf8');
    const focusedBatchText = `${JSON.stringify(focusedBatch, null, 2)}\n`;
    await writeFile(batchPath, focusedBatchText, 'utf8');

    const dryRun = await execFileAsync(process.execPath, [
        path.resolve('scripts/apply-visible-residual-focused-review-batch.js'),
        '--batch', batchPath,
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--clusters', clusterPath,
        '--decisions', decisionsPath,
        '--candidate-decisions', candidateDecisionsPath,
        '--dry-run'
    ]);
    const dryRunReport = JSON.parse(dryRun.stdout);
    assert.equal(dryRunReport.ok, true);
    assert.equal(dryRunReport.skippedWrite, true);
    assert.equal(dryRunReport.hashes.batchSha256, sha256Text(focusedBatchText));
    assert.equal(dryRunReport.hashes.decisionsBeforeSha256, sha256Text(`${JSON.stringify(decisions, null, 2)}\n`));
    assert.notEqual(dryRunReport.hashes.decisionsAfterSha256, dryRunReport.hashes.decisionsBeforeSha256);
    assert.equal(dryRunReport.changedTargets.length, 2);
    assert.equal(dryRunReport.changedTargets[0].previousHumanVerdict, null);
    assert.equal(dryRunReport.changedTargets[0].nextHumanVerdict, 'acceptableResidual');
    assert.equal((await readJson(decisionsPath)).decisions[0].humanVerdict, null);

    const applied = await execFileAsync(process.execPath, [
        path.resolve('scripts/apply-visible-residual-focused-review-batch.js'),
        '--batch', batchPath,
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--clusters', clusterPath,
        '--decisions', decisionsPath,
        '--candidate-decisions', candidateDecisionsPath
    ]);
    const appliedReport = JSON.parse(applied.stdout);
    assert.equal(appliedReport.ok, true);
    assert.equal(appliedReport.policy.writesHumanReviewInputs, true);
    assert.equal(appliedReport.policy.writesFormalGoldManifest, false);
    assert.equal(appliedReport.changed.visibleTopPending, 1);
    assert.equal(appliedReport.changed.metricPassVisible, 1);
    const decisionsAfterApplyText = await readFile(decisionsPath, 'utf8');
    const candidateDecisionsAfterApplyText = await readFile(candidateDecisionsPath, 'utf8');
    assert.equal(appliedReport.hashes.decisionsAfterSha256, sha256Text(decisionsAfterApplyText));
    assert.equal(appliedReport.hashes.candidateDecisionsAfterSha256, sha256Text(candidateDecisionsAfterApplyText));
    assert.equal(JSON.parse(decisionsAfterApplyText).decisions[0].humanVerdict, 'acceptableResidual');
    assert.equal(JSON.parse(candidateDecisionsAfterApplyText).decisions[0].humanVerdict, 'trueVisibleResidual');

    focusedBatch.decisions[0].humanVerdict = null;
    await writeFile(incompleteBatchPath, `${JSON.stringify(focusedBatch, null, 2)}\n`, 'utf8');
    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/apply-visible-residual-focused-review-batch.js'),
            '--batch', incompleteBatchPath,
            '--validation', validationPath,
            '--manifest', manifestPath,
            '--clusters', clusterPath,
            '--decisions', decisionsPath,
            '--candidate-decisions', candidateDecisionsPath
        ]);
    } catch (caught) {
        error = caught;
    }
    assert.ok(error);
    const failedReport = JSON.parse(error.stderr);
    assert.equal(failedReport.ok, false);
    assert.equal(failedReport.skippedWrite, true);
    assert.ok(failedReport.problems.some((problem) => problem.type === 'focused-batch-invalid-or-missing-humanVerdict'));

    focusedBatch.decisions[0].humanVerdict = 'acceptableResidual';
    focusedBatch.decisions = [
        focusedBatch.decisions[0],
        {
            ...focusedBatch.decisions[0],
            humanConfidence: 'medium',
            humanNotes: 'duplicate target should be rejected'
        }
    ];
    await writeFile(duplicateBatchPath, `${JSON.stringify(focusedBatch, null, 2)}\n`, 'utf8');
    error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/apply-visible-residual-focused-review-batch.js'),
            '--batch', duplicateBatchPath,
            '--validation', validationPath,
            '--manifest', manifestPath,
            '--clusters', clusterPath,
            '--decisions', decisionsPath,
            '--candidate-decisions', candidateDecisionsPath
        ]);
    } catch (caught) {
        error = caught;
    }
    assert.ok(error);
    const duplicateReport = JSON.parse(error.stderr);
    assert.equal(duplicateReport.ok, false);
    assert.equal(duplicateReport.skippedWrite, true);
    assert.ok(duplicateReport.problems.some((problem) => problem.type === 'focused-batch-duplicate-target'));

    focusedBatch.decisions = [
        {
            ...focusedBatch.decisions[0],
            decisionJsonPath: 'decisions[99]'
        }
    ];
    await writeFile(badLocatorBatchPath, `${JSON.stringify(focusedBatch, null, 2)}\n`, 'utf8');
    error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/apply-visible-residual-focused-review-batch.js'),
            '--batch', badLocatorBatchPath,
            '--validation', validationPath,
            '--manifest', manifestPath,
            '--clusters', clusterPath,
            '--decisions', decisionsPath,
            '--candidate-decisions', candidateDecisionsPath
        ]);
    } catch (caught) {
        error = caught;
    }
    assert.ok(error);
    const badLocatorReport = JSON.parse(error.stderr);
    assert.equal(badLocatorReport.ok, false);
    assert.equal(badLocatorReport.skippedWrite, true);
    assert.ok(badLocatorReport.problems.some((problem) => problem.type === 'focused-batch-decision-json-path-mismatch'));
});

test('create-visible-residual-review-worksheet should write a human-readable review checklist', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-worksheet-'));
    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const clusterPath = path.join(tempDir, 'review-clusters.json');
    const outputPath = path.join(tempDir, 'review-worksheet.md');
    const csvOutputPath = path.join(tempDir, 'review-table.csv');
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const validationText = `${JSON.stringify({
        outputPath: validationPath,
        reviewManifestPath: manifestPath,
        decisionsPath: path.join(tempDir, 'review-decisions.json'),
        candidateDecisionsPath: path.join(tempDir, 'gold-candidate-confirmations.json'),
        readyForGoldMigration: false,
        pendingTotal: 2,
        goldCandidateTotal: 1,
        readyDecisionCount: 0,
        pendingReadyDecisionCount: 0,
        goldCandidateReadyDecisionCount: 0,
        unconfirmedCount: 3,
        pendingUnconfirmedCount: 2,
        goldCandidateUnconfirmedCount: 1,
        structuralErrorCount: 0,
        incompleteDecisions: [
            {
                sourceSet: 'visibleTopPending',
                file: 'pending-a.png',
                decisionInputPath: path.join(tempDir, 'review-decisions.json'),
                decisionArrayIndex: 0,
                decisionIndex: 0,
                decisionJsonPath: 'decisions[0]',
                problems: ['invalid-or-missing-humanVerdict', 'invalid-or-missing-humanConfidence']
            },
            {
                sourceSet: 'metricPassVisible',
                file: 'candidate-a.png',
                decisionInputPath: path.join(tempDir, 'gold-candidate-confirmations.json'),
                decisionArrayIndex: 0,
                decisionIndex: 0,
                decisionJsonPath: 'decisions[0]',
                problems: ['invalid-or-missing-humanVerdict', 'invalid-or-missing-humanConfidence']
            }
        ],
        structuralErrors: [],
        readyDecisions: []
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(validationPath, validationText, 'utf8');
    await writeFile(clusterPath, `${JSON.stringify({
        inputs: {
            reviewManifestSha256: sha256Text(manifestText),
            validationReportSha256: sha256Text(validationText)
        },
        summary: {
            clusterTotal: 2,
            clusterSheetCount: 2
        },
        clusters: [
            {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                sourceSet: 'metricPassVisible',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                count: 4,
                incompleteCount: 4,
                readyCount: 0,
                sheet: {
                    outputPath: path.join(tempDir, 'metric-cluster.png')
                },
                files: [
                    {
                        file: 'candidate-a.png',
                        cropPath: 'candidate-crop.png'
                    }
                ]
            },
            {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                sourceSet: 'visibleTopPending',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                count: 2,
                incompleteCount: 2,
                readyCount: 0,
                sheet: {
                    outputPath: path.join(tempDir, 'pending-cluster.png')
                },
                files: [
                    {
                        file: 'pending-a.png',
                        cropPath: 'pending-crop.png'
                    }
                ]
            }
        ]
    }, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-review-worksheet.js'),
        '--validation', validationPath,
        '--manifest', manifestPath,
        '--clusters', clusterPath,
        '--output', outputPath,
        '--csv-output', csvOutputPath,
        '--limit', '2'
    ]);

    const worksheet = await readFile(outputPath, 'utf8');
    const csv = await readFile(csvOutputPath, 'utf8');
    assert.match(worksheet, /# Visible Residual Review Worksheet/);
    assert.match(worksheet, /Edit `review-decisions\.json` and `gold-candidate-confirmations\.json`, not this file\./);
    assert.match(worksheet, /For spreadsheet sorting\/filtering, see `review-table\.csv`\./);
    assert.match(worksheet, /## Next Review Batch/);
    assert.match(worksheet, /clusterId: `metricPassVisible::48px-large-margin::positiveHalo`/);
    assert.match(worksheet, /sheetPath: `.*metric-cluster\.png`/);
    assert.match(worksheet, /remainingInClusterAfterBatch: `0`/);
    assert.match(worksheet, /## Review Batches/);
    assert.match(worksheet, /reviewBatchCount: `2`/);
    assert.match(worksheet, /totalIncompleteDecisions: `2`/);
    assert.match(worksheet, /\| 1 \| metricPassVisible::48px-large-margin::positiveHalo \| .*metric-cluster\.png .*gold-candidate-confirmations\.json decisions\[0\]/);
    assert.match(worksheet, /\| 2 \| visibleTopPending::48px-large-margin::positiveHalo \| .*pending-cluster\.png .*review-decisions\.json decisions\[0\]/);
    assert.match(worksheet, /## Gold Candidate Review Batches/);
    assert.match(worksheet, /goldCandidateReviewBatchCount: `1`/);
    assert.match(worksheet, /goldCandidateIncompleteDecisions: `1`/);
    assert.match(worksheet, /\| 1 \| metricPassVisible::48px-large-margin::positiveHalo \| .*gold-candidate-confirmations\.json decisions\[0\]/);
    assert.match(worksheet, /gold-candidate-confirmations\.json decisions\[0\]/);
    assert.match(worksheet, /pending-a\.png/);
    assert.match(worksheet, /candidate-a\.png/);
    assert.match(worksheet, /validationReportSha256: `[0-9a-f]{64}`/);
    assert.match(worksheet, /reviewManifestSha256: `[0-9a-f]{64}`/);
    assert.match(worksheet, /reviewClusterSha256: `[0-9a-f]{64}`/);
    assert.match(worksheet, /review-decisions\.json decisions\[0\]/);
    assert.match(worksheet, /This worksheet does not write `gold-manifest\.json`\./);
    assert.match(csv, /^index,sourceSet,clusterId,decisionInputPath,decisionJsonPath,decisionArrayIndex,decisionIndex,profileLine,file,cropPath,suggestedVerdict,suggestedConfidence,visibleReasons,missingProblems,humanVerdict,humanConfidence,humanNotes,validationReportSha256,reviewManifestSha256,reviewClusterSha256\n/);
    assert.match(csv, /review-decisions\.json,decisions\[0\],0,0/);
    assert.match(csv, /,[0-9a-f]{64},[0-9a-f]{64},[0-9a-f]{64}/);
    assert.match(csv.split(/\r?\n/)[1], /metricPassVisible::48px-large-margin::positiveHalo/);
    assert.match(csv.split(/\r?\n/)[1], /gold-candidate-confirmations\.json,decisions\[0\],0,0/);
    assert.match(csv, /visibleTopPending::48px-large-margin::positiveHalo/);
    assert.match(csv, /visibleTopPending/);
    assert.match(csv, /metricPassVisible/);
});

test('create-visible-residual-review-worksheet should reject stale cluster reports', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-review-worksheet-stale-cluster-'));
    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const clusterPath = path.join(tempDir, 'review-clusters.json');
    const outputPath = path.join(tempDir, 'review-worksheet.md');
    const csvOutputPath = path.join(tempDir, 'review-table.csv');
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const validationText = `${JSON.stringify(createValidationReport({ ready: false }), null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(validationPath, validationText, 'utf8');
    await writeFile(clusterPath, `${JSON.stringify({
        inputs: {
            reviewManifestSha256: '0'.repeat(64),
            validationReportSha256: '1'.repeat(64)
        },
        summary: {
            clusterTotal: 1,
            clusterSheetCount: 1
        },
        clusters: []
    }, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-review-worksheet.js'),
            '--validation', validationPath,
            '--manifest', manifestPath,
            '--clusters', clusterPath,
            '--output', outputPath,
            '--csv-output', csvOutputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /review-cluster-report-manifest-hash-mismatch/);
    assert.match(error.stderr, /review-cluster-report-validation-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(csvOutputPath), false);
});

test('create-visible-residual-gold-proposal should record alpha profile manifest provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-proposal-provenance-'));
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const alphaSweepPath = path.join(tempDir, 'alpha-sweep.json');
    const profileReportPath = path.join(tempDir, 'alpha-profile.json');
    const profileGeneralizationPath = path.join(tempDir, 'profile-generalization.json');
    const outputPath = path.join(tempDir, 'gold-proposal.json');
    const manifestText = `${JSON.stringify(createMinimalReviewManifest({ includeGoldCandidate: true }), null, 2)}\n`;
    const reviewManifestSha256 = sha256Text(manifestText);
    const alphaSweepText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { directAlphaGainCouldClearVisible: 0, total: 3 }
    }, null, 2)}\n`;
    const profileReportText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { profileCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileGeneralizationText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: {
            total: 13,
            improvedSeverity: 7,
            clearedVisible: 4
        }
    }, null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(alphaSweepPath, alphaSweepText, 'utf8');
    await writeFile(profileReportPath, profileReportText, 'utf8');
    await writeFile(profileGeneralizationPath, profileGeneralizationText, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-gold-proposal.js'),
        '--review', manifestPath,
        '--alpha-sweep', alphaSweepPath,
        '--profile', profileReportPath,
        '--profile-generalization', profileGeneralizationPath,
        '--output', outputPath
    ]);

    const proposal = await readJson(outputPath);
    assert.equal(proposal.policy.writesFormalGoldManifest, false);
    assert.equal(proposal.policy.writesProductionAlgorithm, false);
    assert.equal(proposal.inputs.reviewManifestSha256, reviewManifestSha256);
    assert.equal(proposal.inputs.alphaSweepSha256, sha256Text(alphaSweepText));
    assert.equal(proposal.inputs.profileReportSha256, sha256Text(profileReportText));
    assert.equal(proposal.inputs.profileGeneralizationSha256, sha256Text(profileGeneralizationText));
    assert.equal(proposal.inputs.alphaSweepReviewManifestSha256, reviewManifestSha256);
    assert.equal(proposal.inputs.profileReportReviewManifestSha256, reviewManifestSha256);
    assert.equal(proposal.inputs.profileGeneralizationReviewManifestSha256, reviewManifestSha256);
    assert.equal(proposal.summary.readyForHumanConfirmation, 1);
    assert.equal(proposal.summary.pendingHumanReview, 2);
    assert.equal(proposal.proposedGoldSchemaGate.armed, true);
    assert.equal(proposal.proposedGoldSchemaGate.appliesToProposedGoldFields, true);
    assert.equal(proposal.proposedGoldSchemaGate.rejectsAlphaProfileVariantFields, true);
    assert.equal(proposal.proposedGoldSchemaGate.rejectsUnknownProposedGoldFields, true);
    assert.equal(proposal.proposedGoldSchemaGate.ok, true);
    assert.ok(proposal.proposedGoldSchemaGate.allowedProposedGoldFields.includes('visibleResidualVerdict'));
    assert.ok(proposal.proposedGoldSchemaGate.failClosedProblemCodes.includes('gold-proposal-unknown-gold-field-present'));
    assert.equal(
        proposal.goldCandidates.readyForHumanConfirmation[0].clusterId,
        'metricPassVisible::48px-large-margin::positiveHalo'
    );
    assert.equal(proposal.goldCandidates.readyForHumanConfirmation[0].sourceSet, 'metricPassVisible');
    assert.equal(
        proposal.goldCandidates.pendingHumanReview[0].clusterId,
        'visibleTopPending::48px-large-margin::positiveHalo'
    );
    assert.equal(proposal.goldCandidates.pendingHumanReview[0].sourceSet, 'visibleTopPending');
    assert.equal(proposal.algorithmAdmission.productionChangeAllowed, false);
});

test('create-visible-residual-gold-proposal should reject stale alpha profile manifest provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-proposal-stale-profile-'));
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const alphaSweepPath = path.join(tempDir, 'alpha-sweep.json');
    const profileReportPath = path.join(tempDir, 'alpha-profile.json');
    const profileGeneralizationPath = path.join(tempDir, 'profile-generalization.json');
    const outputPath = path.join(tempDir, 'gold-proposal.json');
    const manifestText = `${JSON.stringify(createMinimalReviewManifest({ includeGoldCandidate: true }), null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    for (const filePath of [alphaSweepPath, profileReportPath, profileGeneralizationPath]) {
        await writeFile(filePath, `${JSON.stringify({
            inputs: { reviewManifestSha256: '0'.repeat(64) },
            summary: {
                total: 1,
                directAlphaGainCouldClearVisible: 0,
                profileCouldClearVisible: 0,
                improvedSeverity: 0,
                clearedVisible: 0
            }
        }, null, 2)}\n`, 'utf8');
    }

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-proposal.js'),
            '--review', manifestPath,
            '--alpha-sweep', alphaSweepPath,
            '--profile', profileReportPath,
            '--profile-generalization', profileGeneralizationPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /alpha-sweep-review-manifest-hash-mismatch/);
    assert.match(error.stderr, /profile-report-review-manifest-hash-mismatch/);
    assert.match(error.stderr, /profile-generalization-review-manifest-hash-mismatch/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

function createMinimalGoldProposal() {
    return {
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            requiresHumanConfirmationBeforeGoldMigration: true,
            requiresHumanConfirmationBeforeProductionProfile: true
        },
        goldCandidates: {
            readyForHumanConfirmation: [
                {
                    file: 'candidate-a.png',
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    profileLine: '48px-large-margin',
                    visibleReasons: ['positiveHalo'],
                    proposedGoldFields: {
                        allowVisibleResidual: false,
                        visibleResidualVerdict: 'trueVisibleResidual',
                        maxPositiveHaloLum: 4,
                        maxGradientResidual: 0.1,
                        maxSpatialResidual: 0.08
                    }
                }
            ],
            pendingHumanReview: []
        },
        summary: {
            readyForHumanConfirmation: 1,
            pendingHumanReview: 0
        },
        proposedGoldSchemaGate: {
            armed: true,
            appliesToProposedGoldFields: true,
            rejectsAlphaProfileVariantFields: true,
            rejectsUnknownProposedGoldFields: true,
            allowedProposedGoldFields: [
                'allowVisibleResidual',
                'maxGradientResidual',
                'maxPositiveHaloLum',
                'maxSpatialResidual',
                'notes',
                'visibleResidualVerdict'
            ],
            forbiddenAlphaProfileFieldKeys: ['alphagain'],
            failClosedProblemCodes: [
                'gold-proposal-alpha-profile-variant-fields-present',
                'gold-proposal-unknown-gold-field-present'
            ],
            forbiddenAlphaProfileFieldPaths: [],
            unknownGoldFieldPaths: [],
            ok: true
        },
        algorithmAdmission: {
            productionChangeAllowed: false
        }
    };
}

function createValidationReport({ ready }) {
    return {
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            readyForGoldMigrationRequiresAllPendingHumanConfirmed: true,
            readyForGoldMigrationRequiresGoldCandidatesHumanConfirmed: true
        },
        readyForGoldMigration: ready,
        decisionSchemaGate: createDecisionSchemaGate(),
        pendingTotal: 0,
        goldCandidateTotal: 1,
        unconfirmedCount: ready ? 0 : 1,
        goldCandidateUnconfirmedCount: ready ? 0 : 1,
        structuralErrorCount: 0,
        readyDecisionCount: ready ? 1 : 0,
        readyDecisions: ready
            ? [
                {
                    file: 'candidate-a.png',
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    profileLine: '48px-large-margin',
                    visibleReasons: ['positiveHalo'],
                    suggestedVerdict: 'trueVisibleResidual',
                    suggestedConfidence: 'high',
                    humanVerdict: 'trueVisibleResidual',
                    humanConfidence: 'high',
                    humanNotes: 'Confirmed visible residual.',
                    cropPath: 'artifacts/candidate-a.png',
                    metrics: {
                        positiveHaloLum: 6.5,
                        gradientResidual: 0.12,
                        spatialResidual: 0.09
                    }
                }
            ]
            : []
    };
}

function allowProductionProfileChange(proposal) {
    proposal.algorithmAdmission = {
        ...proposal.algorithmAdmission,
        alphaGainSweep: {
            decision: 'not-applicable'
        },
        alphaProfileMidBoost124: {
            decision: 'accept-production-default-profile'
        },
        productionChangeAllowed: true,
        productionChangeGate: [
            'human-confirmed-gold-manifest',
            'accepted-alpha-profile-decision'
        ]
    };
}

function reviewManifestRecordFromDecision(decision) {
    return {
        file: decision.file,
        cropPath: decision.cropPath,
        metrics: {
            ...decision.metrics,
            visibleReasons: decision.visibleReasons ?? []
        },
        review: {
            profileLine: decision.profileLine ?? 'unknown'
        }
    };
}

async function writeGoldManifestInputs(tempDir, validation, proposal = createMinimalGoldProposal()) {
    const reviewManifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const reviewInputContractPath = path.join(tempDir, 'review-input-contract.json');
    const proposalPath = path.join(tempDir, 'gold-proposal.json');
    const outputPath = path.join(tempDir, 'gold-manifest.json');
    const decisionsPath = path.join(tempDir, 'review-decisions.json');
    const candidateDecisionsPath = path.join(tempDir, 'gold-candidate-confirmations.json');
    const alphaSweepDir = path.join(tempDir, 'alpha-sweep');
    const alphaProfileDir = path.join(tempDir, 'alpha-profile');
    const alphaSweepPath = path.join(alphaSweepDir, 'model-investigation-alpha-sweep.json');
    const profileReportPath = path.join(alphaProfileDir, 'model-investigation-alpha-profile.json');
    const profileGeneralizationPath = path.join(alphaProfileDir, 'large-margin-48-profile-candidate.json');
    const readyManifestGroups = {
        visibleTopPending: [],
        metricPassVisible: []
    };
    for (const decision of validation.readyDecisions ?? []) {
        const sourceSet = decision.sourceSet === 'visibleTopPending' ? 'visibleTopPending' : 'metricPassVisible';
        readyManifestGroups[sourceSet].push(reviewManifestRecordFromDecision(decision));
    }
    const reviewManifestText = `${JSON.stringify({
        summary: {
            visibleTopPending: validation.pendingTotal ?? 0,
            metricPassVisibleReviewed: validation.goldCandidateTotal ?? 0
        },
        groups: readyManifestGroups
    }, null, 2)}\n`;
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const alphaSweepText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { directAlphaGainCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileReportText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { profileCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileGeneralizationText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: {
            total: 13,
            improvedSeverity: 7,
            clearedVisible: 4
        }
    }, null, 2)}\n`;
    await mkdir(alphaSweepDir, { recursive: true });
    await mkdir(alphaProfileDir, { recursive: true });
    await writeFile(reviewManifestPath, reviewManifestText, 'utf8');
    await writeFile(alphaSweepPath, alphaSweepText, 'utf8');
    await writeFile(profileReportPath, profileReportText, 'utf8');
    await writeFile(profileGeneralizationPath, profileGeneralizationText, 'utf8');
    const validationPayload = {
        ...validation,
        reviewManifestSha256: validation.reviewManifestSha256 ?? reviewManifestSha256,
        decisionsPath: validation.decisionsPath ?? decisionsPath,
        candidateDecisionsPath: validation.candidateDecisionsPath ?? candidateDecisionsPath
    };
    const reviewInputContractText = `${JSON.stringify({
        schemaVersion: 1,
        reviewManifestPath,
        reviewManifestSha256: validationPayload.reviewManifestSha256,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            alphaProfileProductionRequiresHumanConfirmedGold: true
        },
        allowedHumanVerdicts: [
            'trueVisibleResidual',
            'backgroundStructure',
            'contentCollision',
            'acceptableResidual',
            'needsModelInvestigation'
        ],
        allowedHumanConfidence: ['high', 'medium', 'low'],
        allowedDecisionInputRootFields: ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS,
        allowedDecisionFields: ALLOWED_HUMAN_REVIEW_DECISION_FIELDS,
        forbiddenAlphaProfileFieldKeys: FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS,
        blockingVerdictsRequireHumanNotes: [
            'trueVisibleResidual',
            'needsModelInvestigation'
        ],
        decisionSets: [
            {
                name: 'visibleTopPending',
                templatePath: path.join(tempDir, 'review-decisions.template.json'),
                inputPath: validationPayload.decisionsPath,
                expectedCount: validationPayload.pendingTotal ?? 0,
                requiresHumanConfirmation: true
            },
            {
                name: 'metricPassVisible',
                templatePath: path.join(tempDir, 'gold-candidate-confirmations.template.json'),
                inputPath: validationPayload.candidateDecisionsPath,
                expectedCount: validationPayload.goldCandidateTotal ?? 0,
                requiresHumanConfirmation: true
            }
        ]
    }, null, 2)}\n`;
    await writeFile(reviewInputContractPath, reviewInputContractText, 'utf8');
    Object.assign(validationPayload, {
        reviewInputContractPath: validation.reviewInputContractPath ?? reviewInputContractPath,
        reviewInputContractSha256: validation.reviewInputContractSha256 ?? sha256Text(reviewInputContractText)
    });
    const proposalPayload = {
        ...proposal,
        inputs: {
            ...proposal.inputs,
            reviewManifestPath,
            reviewManifestSha256: proposal.inputs?.reviewManifestSha256 ?? reviewManifestSha256,
            alphaSweepPath,
            alphaSweepSha256: proposal.inputs?.alphaSweepSha256 ?? sha256Text(alphaSweepText),
            alphaSweepReviewManifestSha256:
                proposal.inputs?.alphaSweepReviewManifestSha256 ?? reviewManifestSha256,
            profileReportPath,
            profileReportSha256: proposal.inputs?.profileReportSha256 ?? sha256Text(profileReportText),
            profileReportReviewManifestSha256:
                proposal.inputs?.profileReportReviewManifestSha256 ?? reviewManifestSha256,
            profileGeneralizationPath,
            profileGeneralizationSha256:
                proposal.inputs?.profileGeneralizationSha256 ?? sha256Text(profileGeneralizationText),
            profileGeneralizationReviewManifestSha256:
                proposal.inputs?.profileGeneralizationReviewManifestSha256 ?? reviewManifestSha256
        }
    };
    await writeFile(validationPath, `${JSON.stringify(validationPayload, null, 2)}\n`, 'utf8');
    await writeFile(proposalPath, `${JSON.stringify(proposalPayload, null, 2)}\n`, 'utf8');
    return {
        reviewManifestPath,
        reviewManifestSha256,
        validationPath,
        reviewInputContractPath,
        proposalPath,
        outputPath,
        alphaSweepPath,
        profileReportPath,
        profileGeneralizationPath
    };
}

async function writeAdmissionGoldManifest({ outputPath, validationPath, proposalPath, reviewManifestPath, overrides = {} }) {
    const validationText = await readFile(validationPath, 'utf8');
    const proposalText = await readFile(proposalPath, 'utf8');
    const reviewManifestText = await readFile(reviewManifestPath, 'utf8');
    const validation = JSON.parse(validationText);
    const proposal = JSON.parse(proposalText);
    const samples = {};
    for (const decision of validation.readyDecisions ?? []) {
        samples[decision.file] = {
            shouldProcess: true,
            sourceSet: decision.sourceSet,
            clusterId: decision.clusterId,
            profileLine: decision.profileLine,
            cropPath: decision.cropPath,
            visibleReasons: decision.visibleReasons ?? []
        };
    }
    const manifest = {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        inputs: {
            validationPath,
            reviewManifestPath,
            reviewManifestSha256: sha256Text(reviewManifestText),
            validationReportSha256: sha256Text(validationText),
            reviewInputContractPath: validation.reviewInputContractPath,
            reviewInputContractSha256: validation.reviewInputContractSha256,
            goldProposalPath: proposalPath,
            goldProposalSha256: sha256Text(proposalText),
            alphaSweepPath: proposal.inputs.alphaSweepPath,
            alphaSweepSha256: proposal.inputs.alphaSweepSha256,
            alphaSweepReviewManifestSha256: proposal.inputs.alphaSweepReviewManifestSha256,
            profileReportPath: proposal.inputs.profileReportPath,
            profileReportSha256: proposal.inputs.profileReportSha256,
            profileReportReviewManifestSha256: proposal.inputs.profileReportReviewManifestSha256,
            profileGeneralizationPath: proposal.inputs.profileGeneralizationPath,
            profileGeneralizationSha256: proposal.inputs.profileGeneralizationSha256,
            profileGeneralizationReviewManifestSha256: proposal.inputs.profileGeneralizationReviewManifestSha256
        },
        policy: {
            generatedOnlyAfterHumanConfirmation: true,
            writesProductionAlgorithm: false,
            containsAlphaProfileVariants: false
        },
        summary: {
            total: Object.keys(samples).length,
            pendingTotal: validation.pendingTotal,
            goldCandidateTotal: validation.goldCandidateTotal
        },
        samples
    };
    await writeFile(outputPath, `${JSON.stringify({
        ...manifest,
        ...overrides,
        inputs: {
            ...manifest.inputs,
            ...overrides.inputs
        },
        policy: {
            ...manifest.policy,
            ...overrides.policy
        },
        summary: {
            ...manifest.summary,
            ...overrides.summary
        },
        samples: overrides.samples ?? manifest.samples
    }, null, 2)}\n`, 'utf8');
}

test('create-visible-residual-admission-report should summarize human and algorithm gates without production writes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-report-'));
    const validationPath = path.join(tempDir, 'validation-report.json');
    const proposalPath = path.join(tempDir, 'gold-proposal.json');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    const validationText = `${JSON.stringify(createValidationReport({ ready: false }), null, 2)}\n`;
    const proposalText = `${JSON.stringify(createMinimalGoldProposal(), null, 2)}\n`;
    await writeFile(validationPath, validationText, 'utf8');
    await writeFile(proposalPath, proposalText, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.policy.reportOnly, true);
    assert.equal(report.policy.writesFormalGoldManifest, false);
    assert.equal(report.policy.writesProductionAlgorithm, false);
    assert.equal(report.inputs.validationReportSha256, sha256Text(validationText));
    assert.equal(report.inputs.goldProposalSha256, sha256Text(proposalText));
    assert.equal(report.humanGate.readyForGoldMigration, false);
    assert.equal(report.humanGate.unconfirmedCount, 1);
    assert.equal(report.goldManifestGate.exists, false);
    assert.equal(report.goldSchemaGate.armed, true);
    assert.equal(report.goldSchemaGate.appliesToFormalGoldManifest, true);
    assert.equal(report.goldSchemaGate.rejectsAlphaProfileVariantFields, true);
    assert.equal(report.goldSchemaGate.rejectsUnknownFormalVisibleResidualFields, true);
    assert.equal(report.goldSchemaGate.ok, true);
    assert.ok(report.goldSchemaGate.allowedFormalVisibleResidualFields.includes('visibleResidualVerdict'));
    assert.ok(report.goldSchemaGate.failClosedProblemCodes.includes('gold-manifest-unknown-visible-residual-field-present'));
    assert.equal(report.proposalInputIntegrity.ok, false);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.match(report.productionProfileAdmission.blockedReasons.join(','), /human-review-not-ready-for-gold-migration/);
    assert.match(report.productionProfileAdmission.blockedReasons.join(','), /algorithm-admission-production-change-blocked/);
    assert.match(report.productionProfileAdmission.blockedReasons.join(','), /algorithm-admission-stale-proposal-inputs/);
    assert.equal(report.summary.currentState, 'human-gated-blocked');
});

test('create-visible-residual-admission-report should block stale proposal alpha profile inputs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-stale-profile-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    proposal.inputs = {
        alphaSweepSha256: '0'.repeat(64),
        profileReportSha256: '1'.repeat(64),
        profileGeneralizationSha256: '2'.repeat(64)
    };
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalInputIntegrity.ok, false);
    assert.match(report.proposalInputIntegrity.problems.join(','), /gold-proposal-alpha-sweep-hash-mismatch/);
    assert.match(report.proposalInputIntegrity.problems.join(','), /gold-proposal-profile-report-hash-mismatch/);
    assert.match(report.proposalInputIntegrity.problems.join(','), /gold-proposal-profile-generalization-hash-mismatch/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['algorithm-admission-stale-proposal-inputs']);
    assert.equal(report.summary.currentState, 'human-gated-blocked');
});

test('create-visible-residual-admission-report should block stale proposal alpha profile manifest provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-stale-profile-provenance-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    proposal.inputs = {
        alphaSweepReviewManifestSha256: '0'.repeat(64),
        profileReportReviewManifestSha256: '1'.repeat(64),
        profileGeneralizationReviewManifestSha256: '2'.repeat(64)
    };
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalInputIntegrity.ok, false);
    assert.match(report.proposalInputIntegrity.problems.join(','), /gold-proposal-alpha-sweep-review-manifest-hash-mismatch/);
    assert.match(report.proposalInputIntegrity.problems.join(','), /gold-proposal-profile-report-review-manifest-hash-mismatch/);
    assert.match(
        report.proposalInputIntegrity.problems.join(','),
        /gold-proposal-profile-generalization-review-manifest-hash-mismatch/
    );
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['algorithm-admission-stale-proposal-inputs']);
});

test('create-visible-residual-admission-report should block stale validation input contracts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-stale-contract-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const validation = await readJson(validationPath);
    validation.reviewInputContractSha256 = '0'.repeat(64);
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalInputIntegrity.ok, true);
    assert.equal(report.validationInputContractIntegrity.ok, false);
    assert.match(report.validationInputContractIntegrity.problems.join(','), /validation-review-input-contract-hash-mismatch/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['human-review-stale-input-contract']);
});

test('create-visible-residual-admission-report should block incomplete validation input contract fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-incomplete-contract-fields-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { validationPath, proposalPath, reviewInputContractPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const contract = await readJson(reviewInputContractPath);
    contract.allowedDecisionInputRootFields = [
        ...ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS,
        'renderProfile'
    ];
    contract.allowedDecisionFields = ['file', 'humanVerdict', 'alpha_gain'];
    contract.forbiddenAlphaProfileFieldKeys = ['alphagain'];
    await writeFile(reviewInputContractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
    const validation = await readJson(validationPath);
    validation.reviewInputContractSha256 = sha256Text(await readFile(reviewInputContractPath, 'utf8'));
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.validationInputContractIntegrity.ok, false);
    assert.match(
        report.validationInputContractIntegrity.problems.join(','),
        /validation-review-input-contract-decision-fields-missing/
    );
    assert.match(
        report.validationInputContractIntegrity.problems.join(','),
        /validation-review-input-contract-forbidden-alpha-profile-fields-missing/
    );
    assert.match(
        report.validationInputContractIntegrity.problems.join(','),
        /validation-review-input-contract-allows-alpha-profile-decision-fields/
    );
    assert.match(
        report.validationInputContractIntegrity.problems.join(','),
        /validation-review-input-contract-allows-alpha-profile-root-fields/
    );
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['human-review-stale-input-contract']);
});

test('create-visible-residual-admission-report should require validation decision schema gate', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-missing-decision-schema-gate-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const validation = await readJson(validationPath);
    delete validation.decisionSchemaGate;
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.validationDecisionSchemaGateIntegrity.ok, false);
    assert.match(report.validationDecisionSchemaGateIntegrity.problems.join(','), /validation-decision-schema-gate-missing/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['human-review-decision-schema-gate-incomplete']);
});

test('create-visible-residual-admission-report should block forged ready validation without ready decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-forged-ready-validation-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const validation = await readJson(validationPath);
    validation.readyDecisionCount = 0;
    validation.readyDecisions = [];
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.validationInputContractIntegrity.ok, true);
    assert.equal(report.proposalCandidateProvenance.ok, true);
    assert.equal(report.proposalValidationCoverage.ok, true);
    assert.equal(report.validationReadinessIntegrity.ok, false);
    assert.match(
        report.validationReadinessIntegrity.problems.join(','),
        /validation-ready-decision-count-does-not-cover-review-set/
    );
    assert.match(report.validationReadinessIntegrity.problems.join(','), /validation-ready-decisions-empty/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, [
        'human-review-readiness-integrity-incomplete'
    ]);
});

test('create-visible-residual-admission-report should require formal gold manifest before production admission', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-missing-formal-gold-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.goldManifestGate.exists, false);
    assert.equal(report.proposalInputIntegrity.ok, true);
    assert.equal(report.validationInputContractIntegrity.ok, true);
    assert.equal(report.validationReadinessIntegrity.ok, true);
    assert.equal(report.proposalCandidateProvenance.ok, true);
    assert.equal(report.proposalValidationCoverage.ok, true);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['formal-gold-manifest-missing']);
});

test('create-visible-residual-admission-report should reject stale formal gold manifest before production admission', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-stale-formal-gold-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath,
        overrides: {
            inputs: {
                validationReportSha256: '0'.repeat(64)
            }
        }
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.goldManifestGate.exists, true);
    assert.equal(report.goldManifestGate.integrityReady, false);
    assert.equal(report.goldManifestIntegrity.ok, false);
    assert.match(report.goldManifestIntegrity.problems.join(','), /gold-manifest-validation-hash-mismatch/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['formal-gold-manifest-integrity-incomplete']);
});

test('create-visible-residual-admission-report should reject formal gold manifest with stale review manifest hash', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-stale-formal-gold-review-manifest-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath,
        overrides: {
            inputs: {
                reviewManifestSha256: '1'.repeat(64)
            }
        }
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.goldManifestGate.exists, true);
    assert.equal(report.goldManifestGate.integrityReady, false);
    assert.equal(report.goldManifestIntegrity.ok, false);
    assert.match(report.goldManifestIntegrity.problems.join(','), /gold-manifest-review-manifest-hash-mismatch/);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['formal-gold-manifest-integrity-incomplete']);
});

test('create-visible-residual-admission-report should reject formal gold manifest with alpha profile variant fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-formal-gold-variant-fields-'));
    const proposal = createMinimalGoldProposal();
    allowProductionProfileChange(proposal);
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath,
        overrides: {
            samples: {
                'candidate-a.png': {
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    visibleResidual: {
                        allowVisibleResidual: false,
                        visibleResidualVerdict: 'trueVisibleResidual',
                        profile_variant: 'mid-boost-1.24'
                    }
                }
            }
        }
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.goldManifestIntegrity.ok, false);
    assert.match(
        report.goldManifestIntegrity.problems.join(','),
        /gold-manifest-alpha-profile-variant-fields-present/
    );
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['formal-gold-manifest-integrity-incomplete']);
});

test('create-visible-residual-admission-report should reject formal gold manifest with unknown visible residual fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-formal-gold-unknown-fields-'));
    const proposal = createMinimalGoldProposal();
    allowProductionProfileChange(proposal);
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath,
        overrides: {
            samples: {
                'candidate-a.png': {
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    visibleResidual: {
                        allowVisibleResidual: false,
                        visibleResidualVerdict: 'trueVisibleResidual',
                        cleanupMode: 'smooth'
                    }
                }
            }
        }
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.goldManifestIntegrity.ok, false);
    assert.match(
        report.goldManifestIntegrity.problems.join(','),
        /gold-manifest-unknown-visible-residual-field-present/
    );
    assert.deepEqual(report.goldManifestIntegrity.unknownVisibleResidualFieldPaths, [
        'candidate-a.png.cleanupMode'
    ]);
    assert.equal(report.goldSchemaGate.ok, false);
    assert.deepEqual(report.goldSchemaGate.unknownVisibleResidualFieldPaths, [
        'candidate-a.png.cleanupMode'
    ]);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, ['formal-gold-manifest-integrity-incomplete']);
});

test('create-visible-residual-admission-report should allow production review only with verified formal gold manifest', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-verified-formal-gold-'));
    const proposal = createMinimalGoldProposal();
    allowProductionProfileChange(proposal);
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.goldManifestGate.exists, true);
    assert.equal(report.goldManifestGate.integrityReady, true);
    assert.equal(report.goldManifestIntegrity.ok, true);
    assert.equal(report.algorithmAdmissionIntegrity.ok, true);
    assert.deepEqual(report.algorithmAdmissionIntegrity.requiredProductionChangeGateMarkers, [
        'human-confirmed-gold-manifest'
    ]);
    assert.deepEqual(report.algorithmAdmissionIntegrity.approvedProductionChangeGateMarkers, [
        'accepted-alpha-profile-decision',
        'accepted-alpha-gain-sweep-decision'
    ]);
    assert.equal(report.algorithmAdmissionIntegrity.hasHumanConfirmedGoldManifestGate, true);
    assert.equal(report.algorithmAdmissionIntegrity.hasApprovedProductionDecisionGate, true);
    assert.deepEqual(report.goldManifestIntegrity.problems, []);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, true);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, []);
    assert.equal(report.summary.currentState, 'ready-for-production-review');
});

test('create-visible-residual-admission-report should reject production allowance with rejected alpha profile decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-rejected-production-decision-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission = {
        ...proposal.algorithmAdmission,
        alphaGainSweep: {
            decision: 'reject-production-wide-alpha-sweep'
        },
        alphaProfileMidBoost124: {
            decision: 'reject-production-default-profile'
        },
        productionChangeAllowed: true,
        productionChangeGate: ['manual-override-attempt']
    };
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.goldManifestIntegrity.ok, true);
    assert.equal(report.algorithmAdmissionIntegrity.ok, false);
    assert.deepEqual(report.algorithmAdmissionIntegrity.productionChangeGate, ['manual-override-attempt']);
    assert.equal(report.algorithmAdmissionIntegrity.hasHumanConfirmedGoldManifestGate, false);
    assert.equal(report.algorithmAdmissionIntegrity.hasApprovedProductionDecisionGate, false);
    assert.match(
        report.algorithmAdmissionIntegrity.problems.join(','),
        /algorithm-admission-rejected-production-decision-present/
    );
    assert.match(
        report.algorithmAdmissionIntegrity.problems.join(','),
        /algorithm-admission-no-approved-production-decision/
    );
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, [
        'algorithm-admission-production-decision-incomplete'
    ]);
});

test('create-visible-residual-admission-report should require explicit production gate markers', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-missing-production-gate-markers-'));
    const proposal = createMinimalGoldProposal();
    allowProductionProfileChange(proposal);
    proposal.algorithmAdmission.productionChangeGate = ['manual-override-attempt'];
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');
    await writeAdmissionGoldManifest({
        outputPath: goldManifestPath,
        validationPath,
        proposalPath,
        reviewManifestPath
    });

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.goldManifestIntegrity.ok, true);
    assert.equal(report.algorithmAdmissionIntegrity.ok, false);
    assert.deepEqual(report.algorithmAdmissionIntegrity.productionChangeGate, ['manual-override-attempt']);
    assert.deepEqual(report.algorithmAdmissionIntegrity.requiredProductionChangeGateMarkers, [
        'human-confirmed-gold-manifest'
    ]);
    assert.deepEqual(report.algorithmAdmissionIntegrity.approvedProductionChangeGateMarkers, [
        'accepted-alpha-profile-decision',
        'accepted-alpha-gain-sweep-decision'
    ]);
    assert.equal(report.algorithmAdmissionIntegrity.hasHumanConfirmedGoldManifestGate, false);
    assert.equal(report.algorithmAdmissionIntegrity.hasApprovedProductionDecisionGate, false);
    assert.match(
        report.algorithmAdmissionIntegrity.problems.join(','),
        /algorithm-admission-human-confirmed-gold-gate-missing/
    );
    assert.match(
        report.algorithmAdmissionIntegrity.problems.join(','),
        /algorithm-admission-approved-decision-gate-missing/
    );
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, [
        'algorithm-admission-production-decision-incomplete'
    ]);
});

test('create-visible-residual-admission-report should block proposal candidate provenance mismatches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-proposal-provenance-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    proposal.goldCandidates.readyForHumanConfirmation[0].clusterId = 'metricPassVisible::wrong-profile::positiveHalo';
    const { validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalInputIntegrity.ok, true);
    assert.equal(report.validationInputContractIntegrity.ok, true);
    assert.equal(report.proposalCandidateProvenance.ok, false);
    assert.match(report.proposalCandidateProvenance.problems.join(','), /gold-proposal-candidate-clusterId-mismatch/);
    assert.equal(report.productionProfileAdmission.productionChangeAllowed, true);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.deepEqual(report.productionProfileAdmission.blockedReasons, [
        'gold-proposal-candidate-provenance-incomplete'
    ]);
});

test('create-visible-residual-admission-report should block proposal manifests without candidate groups', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-proposal-empty-manifest-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    const { reviewManifestPath, validationPath, proposalPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const staleShapeReviewManifestText = `${JSON.stringify({
        summary: {
            visibleTopPending: 0,
            metricPassVisibleReviewed: 1
        }
    }, null, 2)}\n`;
    const staleShapeReviewManifestSha256 = sha256Text(staleShapeReviewManifestText);
    await writeFile(reviewManifestPath, staleShapeReviewManifestText, 'utf8');
    const proposalPayload = await readJson(proposalPath);
    proposalPayload.inputs.reviewManifestSha256 = staleShapeReviewManifestSha256;
    await writeFile(proposalPath, `${JSON.stringify(proposalPayload, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalCandidateProvenance.ok, false);
    assert.equal(report.proposalCandidateProvenance.candidateCount, 1);
    assert.equal(report.proposalCandidateProvenance.expectedCandidateCount, 0);
    assert.match(report.proposalCandidateProvenance.problems.join(','), /gold-proposal-candidate-count-mismatch/);
    assert.equal(report.productionProfileAdmission.allowed, false);
    assert.match(
        report.productionProfileAdmission.blockedReasons.join(','),
        /gold-proposal-candidate-provenance-incomplete/
    );
});

test('create-visible-residual-admission-report should block proposal candidates that do not cover validation totals', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-admission-proposal-validation-coverage-'));
    const proposal = createMinimalGoldProposal();
    proposal.algorithmAdmission.productionChangeAllowed = true;
    proposal.summary = {
        readyForHumanConfirmation: 0,
        pendingHumanReview: 0
    };
    proposal.goldCandidates.readyForHumanConfirmation = [];
    proposal.goldCandidates.pendingHumanReview = [];
    const {
        reviewManifestPath,
        validationPath,
        proposalPath,
        alphaSweepPath,
        profileReportPath,
        profileGeneralizationPath
    } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );
    const emptyReviewManifestText = `${JSON.stringify({
        summary: {
            visibleTopPending: 0,
            metricPassVisibleReviewed: 0
        },
        groups: {
            visibleTopPending: [],
            metricPassVisible: []
        }
    }, null, 2)}\n`;
    const emptyReviewManifestSha256 = sha256Text(emptyReviewManifestText);
    const alphaSweepText = `${JSON.stringify({
        inputs: { reviewManifestSha256: emptyReviewManifestSha256 },
        summary: { directAlphaGainCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileReportText = `${JSON.stringify({
        inputs: { reviewManifestSha256: emptyReviewManifestSha256 },
        summary: { profileCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileGeneralizationText = `${JSON.stringify({
        inputs: { reviewManifestSha256: emptyReviewManifestSha256 },
        summary: { total: 13, improvedSeverity: 7, clearedVisible: 4 }
    }, null, 2)}\n`;
    await writeFile(reviewManifestPath, emptyReviewManifestText, 'utf8');
    await writeFile(alphaSweepPath, alphaSweepText, 'utf8');
    await writeFile(profileReportPath, profileReportText, 'utf8');
    await writeFile(profileGeneralizationPath, profileGeneralizationText, 'utf8');
    const proposalPayload = await readJson(proposalPath);
    Object.assign(proposalPayload.inputs, {
        reviewManifestSha256: emptyReviewManifestSha256,
        alphaSweepSha256: sha256Text(alphaSweepText),
        alphaSweepReviewManifestSha256: emptyReviewManifestSha256,
        profileReportSha256: sha256Text(profileReportText),
        profileReportReviewManifestSha256: emptyReviewManifestSha256,
        profileGeneralizationSha256: sha256Text(profileGeneralizationText),
        profileGeneralizationReviewManifestSha256: emptyReviewManifestSha256
    });
    await writeFile(proposalPath, `${JSON.stringify(proposalPayload, null, 2)}\n`, 'utf8');
    const outputPath = path.join(tempDir, 'algorithm-admission-report.json');
    const goldManifestPath = path.join(tempDir, 'gold-manifest.json');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-admission-report.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--output', outputPath,
        '--gold-manifest', goldManifestPath
    ]);

    const report = await readJson(outputPath);
    assert.equal(report.humanGate.readyForGoldMigration, true);
    assert.equal(report.proposalInputIntegrity.ok, true);
    assert.equal(report.proposalCandidateProvenance.ok, true);
    assert.equal(report.proposalCandidateProvenance.candidateCount, 0);
    assert.equal(report.proposalCandidateProvenance.expectedCandidateCount, 0);
    assert.equal(report.proposalValidationCoverage.ok, false);
    assert.match(
        report.proposalValidationCoverage.problems.join(','),
        /gold-proposal-candidate-count-validation-mismatch/
    );
    assert.match(
        report.productionProfileAdmission.blockedReasons.join(','),
        /gold-proposal-candidates-do-not-cover-validation-set/
    );
    assert.equal(report.productionProfileAdmission.allowed, false);
});

test('create-visible-residual-goal-audit-report should summarize objective state without production writes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-goal-audit-'));
    const artifactDir = path.join(tempDir, 'artifacts');
    const humanReviewPackDir = path.join(artifactDir, 'human-review-pack');
    const alphaSweepDir = path.join(artifactDir, 'alpha-sweep');
    const alphaProfileDir = path.join(artifactDir, 'alpha-profile');
    const sourceRoot = path.join(tempDir, 'source-root');
    const outputPath = path.join(artifactDir, 'goal-audit-report.json');
    const goldManifestPath = path.join(artifactDir, 'gold-manifest.json');
    await mkdir(humanReviewPackDir, { recursive: true });
    await mkdir(alphaSweepDir, { recursive: true });
    await mkdir(alphaProfileDir, { recursive: true });
    for (const dir of ['src/core', 'src/sdk', 'src/runtime', 'src/shared', 'src/userscript', 'dist']) {
        await mkdir(path.join(sourceRoot, dir), { recursive: true });
    }
    await writeVisibleResidualPackageJson(sourceRoot);
    for (const file of [
        'summary.json',
        'metricPassVisible.png',
        'visibleTop.png',
        'human-review-pack/review-worksheet.md',
        'human-review-pack/review-table.csv'
    ]) {
        await writeFile(path.join(artifactDir, file), '{}\n', 'utf8');
    }

    const reviewManifestText = `${JSON.stringify({
        summary: {
            visibleTopPending: 2,
            metricPassVisibleReviewed: 1
        }
    }, null, 2)}\n`;
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    await writeFile(path.join(artifactDir, 'review-manifest.json'), reviewManifestText, 'utf8');
    const reviewInputContractText = `${JSON.stringify({
        reviewManifestSha256,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        decisionSets: [
            {
                name: 'visibleTopPending',
                inputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                expectedCount: 2
            },
            {
                name: 'metricPassVisible',
                inputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                expectedCount: 1
            }
        ]
    }, null, 2)}\n`;
    const reviewInputContractSha256 = sha256Text(reviewInputContractText);
    await writeFile(path.join(humanReviewPackDir, 'review-input-contract.json'), reviewInputContractText, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'summary.json'), `${JSON.stringify({
        reviewManifestSha256,
        reviewInputContractSha256
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-decisions.template.json'), `${JSON.stringify({
        reviewManifestSha256,
        decisions: []
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-decisions.json'), `${JSON.stringify({
        reviewManifestSha256,
        decisions: []
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'gold-candidate-confirmations.template.json'), `${JSON.stringify({
        reviewManifestSha256,
        decisions: []
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'), `${JSON.stringify({
        reviewManifestSha256,
        decisions: []
    }, null, 2)}\n`, 'utf8');
    const validationReportText = `${JSON.stringify({
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        readyForGoldMigration: false,
        reviewManifestSha256,
        reviewInputContractPath: path.join(humanReviewPackDir, 'review-input-contract.json'),
        reviewInputContractSha256,
        decisionsPath: path.join(humanReviewPackDir, 'review-decisions.json'),
        candidateDecisionsPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
        pendingTotal: 2,
        goldCandidateTotal: 1,
        readyDecisionCount: 0,
        unconfirmedCount: 3,
        goldCandidateUnconfirmedCount: 1,
        structuralErrorCount: 0,
        decisionSchemaGate: createDecisionSchemaGate()
    }, null, 2)}\n`;
    await writeFile(path.join(humanReviewPackDir, 'validation-report.json'), validationReportText, 'utf8');
    await writeFile(path.join(artifactDir, 'review-clusters.json'), `${JSON.stringify({
        inputs: {
            reviewManifestSha256,
            validationReportSha256: sha256Text(validationReportText)
        },
        policy: {
            readOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        summary: {
            totalRecords: 3,
            clusterTotal: 2,
            clusterSheetCount: 2,
            unconfirmedCount: 3,
            structuralErrorCount: 0
        },
        clusters: [
            {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                sourceSet: 'visibleTopPending',
                count: 2,
                incompleteCount: 2,
                readyCount: 0
            },
            {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                sourceSet: 'metricPassVisible',
                count: 1,
                incompleteCount: 1,
                readyCount: 0
            }
        ]
    }, null, 2)}\n`, 'utf8');
    const alphaSweepText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { directAlphaGainCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileReportText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { profileCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileGeneralizationText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: {
            total: 13,
            improvedSeverity: 7,
            clearedVisible: 4
        }
    }, null, 2)}\n`;
    await writeFile(path.join(alphaSweepDir, 'model-investigation-alpha-sweep.json'), alphaSweepText, 'utf8');
    await writeFile(path.join(alphaProfileDir, 'model-investigation-alpha-profile.json'), profileReportText, 'utf8');
    await writeFile(path.join(alphaProfileDir, 'large-margin-48-profile-candidate.json'), profileGeneralizationText, 'utf8');
    const goldProposalText = `${JSON.stringify({
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            requiresHumanConfirmationBeforeGoldMigration: true,
            requiresHumanConfirmationBeforeProductionProfile: true
        },
        inputs: {
            reviewManifestSha256,
            alphaSweepSha256: sha256Text(alphaSweepText),
            alphaSweepReviewManifestSha256: reviewManifestSha256,
            profileReportSha256: sha256Text(profileReportText),
            profileReportReviewManifestSha256: reviewManifestSha256,
            profileGeneralizationSha256: sha256Text(profileGeneralizationText),
            profileGeneralizationReviewManifestSha256: reviewManifestSha256
        },
        summary: {
            readyForHumanConfirmation: 1,
            pendingHumanReview: 2
        },
        proposedGoldSchemaGate: {
            armed: true,
            appliesToProposedGoldFields: true,
            rejectsAlphaProfileVariantFields: true,
            rejectsUnknownProposedGoldFields: true,
            allowedProposedGoldFields: [
                'visibleResidualVerdict'
            ],
            forbiddenAlphaProfileFieldKeys: ['alphagain'],
            failClosedProblemCodes: [
                'gold-proposal-alpha-profile-variant-fields-present',
                'gold-proposal-unknown-gold-field-present'
            ],
            forbiddenAlphaProfileFieldPaths: [],
            unknownGoldFieldPaths: [],
            ok: true
        },
        goldCandidates: {
            readyForHumanConfirmation: [
                {
                    file: 'candidate-a.png',
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    visibleReasons: ['positiveHalo']
                }
            ],
            pendingHumanReview: [
                {
                    file: 'candidate-b.png',
                    sourceSet: 'visibleTopPending',
                    clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                    visibleReasons: ['positiveHalo']
                },
                {
                    file: 'candidate-c.png',
                    sourceSet: 'visibleTopPending',
                    clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                    visibleReasons: ['positiveHalo']
                }
            ]
        }
    }, null, 2)}\n`;
    await writeFile(path.join(artifactDir, 'gold-proposal.json'), goldProposalText, 'utf8');
    const reviewClusterReportText = await readFile(path.join(artifactDir, 'review-clusters.json'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-worksheet.md'), [
        '# Visible Residual Review Worksheet',
        '',
        '## Provenance',
        '',
        `- validationReportSha256: \`${sha256Text(validationReportText)}\``,
        `- reviewManifestSha256: \`${reviewManifestSha256}\``,
        `- reviewClusterSha256: \`${sha256Text(reviewClusterReportText)}\``,
        ''
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-table.csv'), [
        'index,validationReportSha256,reviewManifestSha256,reviewClusterSha256',
        `1,${sha256Text(validationReportText)},${reviewManifestSha256},${sha256Text(reviewClusterReportText)}`
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'cluster-review-worksheet.md'), [
        '# Visible Residual Cluster Review Worksheet',
        '',
        '## Provenance',
        '',
        `- reviewManifestSha256: \`${reviewManifestSha256}\``,
        `- validationReportSha256: \`${sha256Text(validationReportText)}\``,
        `- reviewClusterSha256: \`${sha256Text(reviewClusterReportText)}\``,
        ''
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-progress-report.json'), `${JSON.stringify({
        policy: {
            readOnly: true,
            writesReviewProgressReport: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        inputs: {
            validationReportSha256: sha256Text(validationReportText),
            reviewManifestSha256,
            reviewClusterSha256: sha256Text(reviewClusterReportText)
        },
        summary: {
            readyForGoldMigration: false,
            unconfirmedCount: 3,
            goldCandidateUnconfirmedCount: 1
        },
        clusterSummary: {
            clusterTotal: 2
        },
        nextReviewClusters: [
            {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo'
            }
        ],
        nextReviewBatch: {
            cluster: {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                sourceSet: 'visibleTopPending',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo']
            },
            itemCount: 2,
            remainingInCluster: 0,
            items: [
                {
                    file: 'candidate-b.png',
                    sourceSet: 'visibleTopPending',
                    clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                    decisionInputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                    decisionJsonPath: 'decisions[0]',
                    decisionArrayIndex: 0,
                    cropPath: path.join(artifactDir, 'visibleTop/rows/candidate-b-visible-residual.png'),
                    profileLine: '48px-large-margin',
                    visibleReasons: ['positiveHalo'],
                    suggestedVerdict: 'pending',
                    suggestedConfidence: 'unknown'
                },
                {
                    file: 'candidate-c.png',
                    sourceSet: 'visibleTopPending',
                    clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                    decisionInputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                    decisionJsonPath: 'decisions[1]',
                    decisionArrayIndex: 1,
                    cropPath: path.join(artifactDir, 'visibleTop/rows/candidate-c-visible-residual.png'),
                    profileLine: '48px-large-margin',
                    visibleReasons: ['positiveHalo'],
                    suggestedVerdict: 'pending',
                    suggestedConfidence: 'unknown'
                }
            ]
        },
        reviewBatches: [
            {
                batchIndex: 1,
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                sourceSet: 'visibleTopPending',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                totalIncompleteInCluster: 2,
                itemCount: 2,
                remainingAfterBatch: 0,
                firstDecisionInputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                firstDecisionJsonPath: 'decisions[0]',
                firstFile: 'candidate-b.png',
                items: [
                    {
                        file: 'candidate-b.png',
                        sourceSet: 'visibleTopPending',
                        decisionJsonPath: 'decisions[0]'
                    },
                    {
                        file: 'candidate-c.png',
                        sourceSet: 'visibleTopPending',
                        decisionJsonPath: 'decisions[1]'
                    }
                ]
            },
            {
                batchIndex: 2,
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                sourceSet: 'metricPassVisible',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                totalIncompleteInCluster: 1,
                itemCount: 1,
                remainingAfterBatch: 0,
                firstDecisionInputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                firstDecisionJsonPath: 'decisions[0]',
                firstFile: 'candidate-a.png',
                items: [
                    {
                        file: 'candidate-a.png',
                        sourceSet: 'metricPassVisible',
                        decisionJsonPath: 'decisions[0]'
                    }
                ]
            }
        ],
        goldCandidateReviewBatches: [
            {
                batchIndex: 2,
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                sourceSet: 'metricPassVisible',
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                totalIncompleteInCluster: 1,
                itemCount: 1,
                remainingAfterBatch: 0,
                firstDecisionInputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                firstDecisionJsonPath: 'decisions[0]',
                firstFile: 'candidate-a.png',
                items: [
                    {
                        file: 'candidate-a.png',
                        sourceSet: 'metricPassVisible',
                        decisionJsonPath: 'decisions[0]'
                    }
                ]
            }
        ],
        nextGoldCandidateReviewBatch: {
            batchIndex: 2,
            clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
            sourceSet: 'metricPassVisible',
            profileLine: '48px-large-margin',
            visibleReasons: ['positiveHalo'],
            totalIncompleteInCluster: 1,
            itemCount: 1,
            remainingAfterBatch: 0,
            firstDecisionInputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
            firstDecisionJsonPath: 'decisions[0]',
            firstFile: 'candidate-a.png',
            items: [
                {
                    file: 'candidate-a.png',
                    sourceSet: 'metricPassVisible',
                    clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                    decisionInputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                    decisionJsonPath: 'decisions[0]',
                    decisionArrayIndex: 0,
                    cropPath: path.join(artifactDir, 'metricPassVisible/rows/candidate-a-visible-residual.png'),
                    profileLine: '48px-large-margin',
                    visibleReasons: ['positiveHalo'],
                    suggestedVerdict: 'trueVisibleResidual',
                    suggestedConfidence: 'high'
                }
            ]
        }
    }, null, 2)}\n`, 'utf8');
    const focusedReviewBatchText = `${JSON.stringify({
        schemaVersion: 1,
        policy: {
            humanEditableFields: ['humanVerdict', 'humanConfidence', 'humanNotes'],
            validHumanVerdicts: [
                'trueVisibleResidual',
                'backgroundStructure',
                'contentCollision',
                'acceptableResidual',
                'needsModelInvestigation'
            ],
            validHumanConfidence: ['high', 'medium', 'low'],
            notesRequiredForVerdicts: ['trueVisibleResidual', 'needsModelInvestigation'],
            dryRunCommand: 'pnpm visible-residual:apply-focused-batch --dry-run',
            applyCommand: 'pnpm visible-residual:apply-focused-batch',
            validateCommandAfterApply: 'pnpm visible-residual:validate-human-review',
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        provenance: {
            validationReportSha256: sha256Text(validationReportText),
            reviewManifestSha256,
            reviewClusterSha256: sha256Text(reviewClusterReportText)
        },
        sourceBatches: {
            visibleResidualBatch: {
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo'
            },
            goldCandidateBatch: {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo'
            }
        },
        decisions: [
            {
                file: 'candidate-b.png',
                sourceSet: 'visibleTopPending',
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                decisionInputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                decisionJsonPath: 'decisions[0]',
                decisionArrayIndex: 0,
                cropPath: path.join(artifactDir, 'visibleTop/rows/candidate-b-visible-residual.png'),
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                suggestedVerdict: 'pending',
                suggestedConfidence: 'unknown',
                humanVerdict: null,
                humanConfidence: null,
                humanNotes: ''
            },
            {
                file: 'candidate-c.png',
                sourceSet: 'visibleTopPending',
                clusterId: 'visibleTopPending::48px-large-margin::positiveHalo',
                decisionInputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                decisionJsonPath: 'decisions[1]',
                decisionArrayIndex: 1,
                cropPath: path.join(artifactDir, 'visibleTop/rows/candidate-c-visible-residual.png'),
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                suggestedVerdict: 'pending',
                suggestedConfidence: 'unknown',
                humanVerdict: null,
                humanConfidence: null,
                humanNotes: ''
            },
            {
                file: 'candidate-a.png',
                sourceSet: 'metricPassVisible',
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                decisionInputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                decisionJsonPath: 'decisions[0]',
                decisionArrayIndex: 0,
                cropPath: path.join(artifactDir, 'metricPassVisible/rows/candidate-a-visible-residual.png'),
                profileLine: '48px-large-margin',
                visibleReasons: ['positiveHalo'],
                suggestedVerdict: 'trueVisibleResidual',
                suggestedConfidence: 'high',
                humanVerdict: null,
                humanConfidence: null,
                humanNotes: ''
            }
        ],
        blockedActions: [
            {
                id: 'write-formal-gold-manifest',
                blocked: true
            },
            {
                id: 'productionize-alpha-profile-variant',
                blocked: true
            }
        ]
    }, null, 2)}\n`;
    await writeFile(path.join(humanReviewPackDir, 'review-focused-batch.json'), focusedReviewBatchText, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-handoff.md'), [
        '# Visible Residual Review Handoff',
        '',
        `validationReportSha256: ${sha256Text(validationReportText)}`,
        `reviewManifestSha256: ${reviewManifestSha256}`,
        `reviewClusterSha256: ${sha256Text(reviewClusterReportText)}`,
        'focusedReviewBatchPath: review-focused-batch.json',
        'writesFormalGoldManifest: false',
        'writesProductionAlgorithm: false',
        'allowsAlphaProfileProduction: false',
        'Focused Batch Editing Checklist',
        'Edit only: humanVerdict, humanConfidence, humanNotes',
        'humanVerdict allowed values: trueVisibleResidual, backgroundStructure, contentCollision, acceptableResidual, needsModelInvestigation',
        'humanConfidence allowed values: high, medium, low',
        'humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation',
        'rtk pnpm visible-residual:apply-focused-batch --dry-run',
        'rtk pnpm visible-residual:apply-focused-batch',
        'rtk pnpm visible-residual:validate-human-review',
        '### Visible residual Decision Crop Previews',
        `- decisions[0]: candidate-b.png`,
        `![Visible residual decisions[0] crop](${path.join(artifactDir, 'visibleTop/rows/candidate-b-visible-residual.png').replace(/\\/g, '/')})`,
        `- decisions[1]: candidate-c.png`,
        `![Visible residual decisions[1] crop](${path.join(artifactDir, 'visibleTop/rows/candidate-c-visible-residual.png').replace(/\\/g, '/')})`,
        '### Gold candidate Decision Crop Previews',
        `- decisions[0]: candidate-a.png`,
        `![Gold candidate decisions[0] crop](${path.join(artifactDir, 'metricPassVisible/rows/candidate-a-visible-residual.png').replace(/\\/g, '/')})`,
        ''
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'README.md'), [
        '# Visible Residual Human Review Pack',
        '',
        'Open review-handoff.md first for the current cluster sheets and crop previews.',
        'Use review-focused-batch.json to edit humanVerdict, humanConfidence, humanNotes only.',
        'Run rtk pnpm visible-residual:apply-focused-batch --dry-run before applying.',
        'Do not generate gold-manifest.json until human review is complete.',
        'Do not add alphaGain, profileVariant, renderProfile, or cleanupMode to decision inputs.',
        ''
    ].join('\n'), 'utf8');
    await writeHumanReviewPackSummaryWithHashes(humanReviewPackDir, {
        reviewManifestSha256,
        reviewInputContractSha256
    });
    await writeFile(path.join(artifactDir, 'algorithm-admission-report.json'), `${JSON.stringify({
        policy: {
            reportOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        inputs: {
            validationReportSha256: sha256Text(validationReportText),
            reviewInputContractSha256,
            goldProposalSha256: sha256Text(goldProposalText)
        },
        validationInputContractIntegrity: {
            ok: true,
            problems: [],
            hashes: {
                reviewInputContractSha256,
                reviewInputContractReviewManifestSha256: reviewManifestSha256
            }
        },
        validationReadinessIntegrity: {
            ok: true,
            problems: [],
            readyForGoldMigration: false,
            expectedTotal: 3,
            readyDecisionCount: 0,
            readyDecisionsLength: 0,
            unconfirmedCount: 3,
            structuralErrorCount: 0
        },
        proposalCandidateProvenance: {
            ok: true,
            problems: [],
            candidateCount: 3,
            expectedCandidateCount: 3,
            hashes: {
                reviewManifestSha256
            }
        },
        proposalValidationCoverage: {
            ok: true,
            problems: [],
            expectedTotal: 3,
            candidateCount: 3,
            expectedCandidateCount: 3,
            readyForHumanConfirmation: 1,
            pendingHumanReview: 2
        },
        proposalInputIntegrity: {
            ok: true,
            problems: [],
            hashes: {
                alphaSweepSha256: sha256Text(alphaSweepText),
                alphaSweepReviewManifestSha256: reviewManifestSha256,
                profileReportSha256: sha256Text(profileReportText),
                profileReportReviewManifestSha256: reviewManifestSha256,
                profileGeneralizationSha256: sha256Text(profileGeneralizationText),
                profileGeneralizationReviewManifestSha256: reviewManifestSha256
            }
        },
        goldSchemaGate: {
            armed: true,
            appliesToFormalGoldManifest: true,
            rejectsAlphaProfileVariantFields: true,
            rejectsUnknownFormalVisibleResidualFields: true,
            allowedFormalVisibleResidualFields: [
                'visibleResidualVerdict'
            ],
            forbiddenAlphaProfileFieldKeys: ['alphagain'],
            failClosedProblemCodes: [
                'gold-manifest-alpha-profile-variant-fields-present',
                'gold-manifest-unknown-visible-residual-field-present'
            ],
            forbiddenAlphaProfileFieldPaths: [],
            unknownVisibleResidualFieldPaths: [],
            ok: true
        },
        algorithmAdmissionIntegrity: {
            ok: true,
            problems: [],
            productionChangeAllowed: false,
            productionChangeGate: [],
            requiredProductionChangeGateMarkers: [
                'human-confirmed-gold-manifest'
            ],
            approvedProductionChangeGateMarkers: [
                'accepted-alpha-profile-decision',
                'accepted-alpha-gain-sweep-decision'
            ],
            hasHumanConfirmedGoldManifestGate: false,
            hasApprovedProductionDecisionGate: false,
            alphaGainSweepDecision: 'reject-production-wide-alpha-sweep',
            alphaProfileDecision: 'reject-production-default-profile',
            approvedProductionDecisionCount: 0
        },
        productionProfileAdmission: {
            allowed: false,
            blockedReasons: [
                'human-review-not-ready-for-gold-migration',
                'human-review-unconfirmed-decisions'
            ]
        }
    }, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const report = await readJson(outputPath);
    const sourcePackagePath = path.join(sourceRoot, 'package.json');
    const sourcePackageText = await readFile(sourcePackagePath, 'utf8');
    const sourcePackageSha256 = sha256Text(sourcePackageText);
    const reviewHandoffText = await readFile(path.join(humanReviewPackDir, 'review-handoff.md'), 'utf8');
    const humanReviewReadmeText = await readFile(path.join(humanReviewPackDir, 'README.md'), 'utf8');

    assert.equal(report.policy.reportOnly, true);
    assert.equal(report.policy.writesFormalGoldManifest, false);
    assert.equal(report.policy.writesProductionAlgorithm, false);
    assert.equal(report.status, 'human-gated-incomplete');
    assert.match(report.objective, /建立 visible residual 的可复现审阅/);
    assert.equal(report.summary.unconfirmedCount, 3);
    assert.equal(report.summary.goldCandidateUnconfirmedCount, 1);
    assert.equal(report.summary.reviewManifestSha256, reviewManifestSha256);
    assert.equal(report.summary.clusterTotal, 2);
    assert.equal(report.summary.reviewBatchCount, 2);
    assert.equal(report.summary.reviewBatchTotal, 3);
    assert.equal(report.summary.goldCandidateReviewBatchCount, 1);
    assert.equal(report.summary.goldCandidateReviewBatchTotal, 1);
    assert.equal(report.summary.reviewHandoffSha256, sha256Text(reviewHandoffText));
    assert.equal(report.summary.humanReviewReadmeSha256, sha256Text(humanReviewReadmeText));
    assert.equal(
        report.summary.nextGoldCandidateReviewCluster,
        'metricPassVisible::48px-large-margin::positiveHalo'
    );
    assert.equal(report.summary.goldManifestExists, false);
    assert.equal(report.summary.productionProfileAllowed, false);
    assert.equal(report.summary.productionHitCount, 0);
    assert.equal(report.summary.productionArtifactHitCount, 0);
    assert.equal(report.summary.packageScriptGateReady, true);
    assert.equal(report.summary.packageJsonSha256, sourcePackageSha256);
    assert.equal(report.inputs.packageJsonPath, sourcePackagePath);
    assert.equal(report.inputs.packageJsonSha256, sourcePackageSha256);
    assert.equal(report.summary.visibleResidualPackageScriptCount, 11);
    assert.equal(report.summary.forbiddenVisibleResidualPackageScriptCount, 0);
    assert.equal(report.summary.unclassifiedVisibleResidualPackageScriptCount, 0);
    assert.equal(
        report.requirements.find((item) => item.id === 'formal-gold-migration').status,
        'blocked-by-human-review'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation').status,
        'satisfied'
    );
    assert.deepEqual(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.productionScanDirs,
        ['src/core', 'src/sdk', 'src/runtime', 'src/shared', 'src/userscript', 'dist']
    );
    assert.match(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.productionScanFilePattern,
        /html/
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.ready,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.packageJsonPath,
        sourcePackagePath
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.packageJsonSha256,
        sourcePackageSha256
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.missingOrMismatchedRequiredScripts.length,
        0
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.unclassifiedVisibleResidualScripts.length,
        0
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.forbiddenVisibleResidualPackageScripts.length,
        0
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation')
            .evidence.packageScriptGate.scripts['visible-residual:create-gold-manifest'],
        'node scripts/create-visible-residual-gold-manifest.js'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'review-manifest-provenance-is-stable').status,
        'satisfied'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible').status,
        'satisfied'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.reviewBatchTotal,
        3
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.goldCandidateReviewBatchTotal,
        1
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.nextGoldCandidateReviewCluster,
        'metricPassVisible::48px-large-margin::positiveHalo'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.focusedReviewBatchSha256,
        sha256Text(focusedReviewBatchText)
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.focusedBatchReady,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.focusedBatchDecisionCount,
        3
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.focusedVisibleBatchMatchesProgress,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.focusedBatchPolicy.writesFormalGoldManifest,
        false
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.reviewHandoffSha256,
        sha256Text(reviewHandoffText)
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.reviewHandoffReady,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.humanReviewReadmeSha256,
        sha256Text(humanReviewReadmeText)
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.humanReviewReadmeReady,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.handoffHasVisibleBatchSheetPreview,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.handoffHasAllFocusedDecisionCropPreviews,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'next-review-guidance-is-reproducible')
            .evidence.handoffHasNoProductionPolicy,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'proposal-only-gold-candidates').status,
        'satisfied'
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'proposal-only-gold-candidates')
            .evidence.proposedGoldSchemaGate.rejectsUnknownProposedGoldFields,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'proposal-only-gold-candidates')
            .evidence.admissionProposalCandidateProvenanceReady,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'algorithm-admission-human-gated')
            .evidence.goldSchemaGate.rejectsUnknownFormalVisibleResidualFields,
        true
    );
    assert.equal(
        report.requirements.find((item) => item.id === 'algorithm-admission-human-gated')
            .evidence.productionGateContractReady,
        true
    );
    assert.deepEqual(report.blockers, ['human-review-not-complete']);

    const admissionReportPath = path.join(artifactDir, 'algorithm-admission-report.json');
    const admissionReport = await readJson(admissionReportPath);
    const legacyAdmissionReport = structuredClone(admissionReport);
    delete legacyAdmissionReport.algorithmAdmissionIntegrity.requiredProductionChangeGateMarkers;
    delete legacyAdmissionReport.algorithmAdmissionIntegrity.approvedProductionChangeGateMarkers;
    await writeFile(admissionReportPath, `${JSON.stringify(legacyAdmissionReport, null, 2)}\n`, 'utf8');
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const legacyGateReport = await readJson(outputPath);
    assert.equal(
        legacyGateReport.requirements.find((item) => item.id === 'algorithm-admission-human-gated').status,
        'missing-evidence'
    );
    assert.equal(
        legacyGateReport.requirements.find((item) => item.id === 'algorithm-admission-human-gated')
            .evidence.productionGateContractReady,
        false
    );
    await writeFile(admissionReportPath, `${JSON.stringify(admissionReport, null, 2)}\n`, 'utf8');

    await writeFile(path.join(sourceRoot, 'dist/experimental-profile-leak.html'), '<script>const profile = "mid-boost-1.24";</script>\n', 'utf8');
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const distProductionLeakReport = await readJson(outputPath);
    const distNoProductionRequirement = distProductionLeakReport.requirements.find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    assert.equal(distProductionLeakReport.status, 'failed');
    assert.equal(distProductionLeakReport.summary.productionHitCount, 1);
    assert.equal(distNoProductionRequirement.evidence.productionHits.length, 1);
    assert.match(distNoProductionRequirement.evidence.productionHits[0].filePath, /dist[\\/]experimental-profile-leak\.html$/);
    await writeFile(path.join(sourceRoot, 'dist/experimental-profile-leak.html'), '<script>const profile = "default";</script>\n', 'utf8');

    const sourcePackageJson = await readJson(sourcePackagePath);
    const packageScriptLeakJson = structuredClone(sourcePackageJson);
    packageScriptLeakJson.scripts['visible-residual:productionize-alpha-profile'] =
        'node scripts/apply-alpha-profile.js --profile mid-boost-1.24';
    await writeFile(sourcePackagePath, `${JSON.stringify(packageScriptLeakJson, null, 2)}\n`, 'utf8');
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const packageScriptLeakReport = await readJson(outputPath);
    const packageScriptNoProductionRequirement = packageScriptLeakReport.requirements.find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    assert.equal(packageScriptLeakReport.status, 'failed');
    assert.equal(packageScriptLeakReport.summary.packageScriptGateReady, false);
    assert.equal(packageScriptLeakReport.summary.forbiddenVisibleResidualPackageScriptCount > 0, true);
    assert.equal(
        packageScriptNoProductionRequirement.evidence.packageScriptGate.forbiddenVisibleResidualPackageScripts
            .some((hit) => hit.name === 'visible-residual:productionize-alpha-profile'),
        true
    );
    await writeFile(sourcePackagePath, `${JSON.stringify(sourcePackageJson, null, 2)}\n`, 'utf8');

    await writeFile(
        path.join(alphaProfileDir, 'large-margin-48-profile-candidate.json'),
        `${JSON.stringify({ summary: { total: 99 } }, null, 2)}\n`,
        'utf8'
    );
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const staleProposalReport = await readJson(outputPath);
    assert.equal(staleProposalReport.status, 'human-gated-incomplete');
    assert.equal(
        staleProposalReport.requirements.find((item) => item.id === 'proposal-only-gold-candidates').status,
        'missing-evidence'
    );
    await writeFile(
        path.join(alphaProfileDir, 'large-margin-48-profile-candidate.json'),
        profileGeneralizationText,
        'utf8'
    );

    await writeFile(goldManifestPath, '{}\n', 'utf8');
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const failedReport = await readJson(outputPath);
    assert.equal(failedReport.status, 'failed');
    assert.equal(failedReport.summary.goldManifestExists, true);
    assert.equal(
        failedReport.requirements.find((item) => item.id === 'no-alpha-profile-production-before-human-confirmation').status,
        'failed'
    );
    assert.match(failedReport.blockers.join(','), /productionization-gate-violated/);

    await writeFile(path.join(sourceRoot, 'src/core/experimental-profile-leak.js'), "export const profile = 'mid-boost-1.24';\n", 'utf8');
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const productionLeakReport = await readJson(outputPath);
    const noProductionRequirement = productionLeakReport.requirements.find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    assert.equal(productionLeakReport.status, 'failed');
    assert.equal(productionLeakReport.summary.productionHitCount, 1);
    assert.equal(noProductionRequirement.status, 'failed');
    assert.equal(noProductionRequirement.evidence.productionHits.length, 1);
    assert.match(noProductionRequirement.evidence.productionHits[0].filePath, /experimental-profile-leak\.js$/);

    await writeFile(
        path.join(sourceRoot, 'src/core/visible-residual-artifact-leak.js'),
        "export const proposalPath = '.artifacts/visible-residual-crops/latest/gold-proposal.json';\n",
        'utf8'
    );
    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir
    ]);
    const artifactLeakReport = await readJson(outputPath);
    const artifactLeakRequirement = artifactLeakReport.requirements.find((item) => (
        item.id === 'no-alpha-profile-production-before-human-confirmation'
    ));
    assert.equal(artifactLeakReport.status, 'failed');
    assert.equal(artifactLeakReport.summary.productionArtifactHitCount, 1);
    assert.equal(artifactLeakRequirement.evidence.productionArtifactHits.length, 1);
    assert.match(artifactLeakRequirement.evidence.productionArtifactHits[0].filePath, /visible-residual-artifact-leak\.js$/);
});

test('create-visible-residual-goal-audit-report should validate completed gold manifest integrity', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-goal-audit-complete-'));
    const artifactDir = path.join(tempDir, 'artifacts');
    const humanReviewPackDir = path.join(artifactDir, 'human-review-pack');
    const alphaSweepDir = path.join(artifactDir, 'alpha-sweep');
    const alphaProfileDir = path.join(artifactDir, 'alpha-profile');
    const sourceRoot = path.join(tempDir, 'source-root');
    const outputPath = path.join(artifactDir, 'goal-audit-report.json');
    await mkdir(humanReviewPackDir, { recursive: true });
    await mkdir(alphaSweepDir, { recursive: true });
    await mkdir(alphaProfileDir, { recursive: true });
    for (const dir of ['src/core', 'src/sdk', 'src/runtime', 'src/shared', 'src/userscript', 'dist']) {
        await mkdir(path.join(sourceRoot, dir), { recursive: true });
    }
    await writeVisibleResidualPackageJson(sourceRoot);
    for (const file of [
        'summary.json',
        'metricPassVisible.png',
        'visibleTop.png',
        'human-review-pack/review-worksheet.md',
        'human-review-pack/review-table.csv'
    ]) {
        await writeFile(path.join(artifactDir, file), '{}\n', 'utf8');
    }

    const reviewManifestText = `${JSON.stringify({
        summary: {
            visibleTopPending: 0,
            metricPassVisibleReviewed: 1
        }
    }, null, 2)}\n`;
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    await writeFile(path.join(artifactDir, 'review-manifest.json'), reviewManifestText, 'utf8');
    const reviewInputContractText = `${JSON.stringify({
        reviewManifestSha256,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        decisionSets: [
            {
                name: 'visibleTopPending',
                inputPath: path.join(humanReviewPackDir, 'review-decisions.json'),
                expectedCount: 0
            },
            {
                name: 'metricPassVisible',
                inputPath: path.join(humanReviewPackDir, 'gold-candidate-confirmations.json'),
                expectedCount: 1
            }
        ]
    }, null, 2)}\n`;
    const reviewInputContractSha256 = sha256Text(reviewInputContractText);
    await writeFile(path.join(humanReviewPackDir, 'review-input-contract.json'), reviewInputContractText, 'utf8');
    for (const file of [
        'summary.json',
        'review-decisions.template.json',
        'review-decisions.json',
        'gold-candidate-confirmations.template.json',
        'gold-candidate-confirmations.json'
    ]) {
        await writeFile(path.join(humanReviewPackDir, file), `${JSON.stringify({
            reviewManifestSha256,
            ...(file === 'summary.json' ? { reviewInputContractSha256 } : {}),
            decisions: []
        }, null, 2)}\n`, 'utf8');
    }
    const validation = createValidationReport({ ready: true });
    validation.readyDecisionCount = 1;
    validation.reviewManifestSha256 = reviewManifestSha256;
    validation.reviewInputContractPath = path.join(humanReviewPackDir, 'review-input-contract.json');
    validation.reviewInputContractSha256 = reviewInputContractSha256;
    validation.decisionsPath = path.join(humanReviewPackDir, 'review-decisions.json');
    validation.candidateDecisionsPath = path.join(humanReviewPackDir, 'gold-candidate-confirmations.json');
    const validationText = `${JSON.stringify(validation, null, 2)}\n`;
    const validationReportSha256 = sha256Text(validationText);
    await writeFile(path.join(humanReviewPackDir, 'validation-report.json'), validationText, 'utf8');
    await writeFile(path.join(artifactDir, 'review-clusters.json'), `${JSON.stringify({
        inputs: {
            reviewManifestSha256,
            validationReportSha256
        },
        policy: {
            readOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        summary: {
            totalRecords: 1,
            clusterTotal: 1,
            clusterSheetCount: 1,
            unconfirmedCount: 0,
            structuralErrorCount: 0
        },
        clusters: [
            {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo',
                count: 1,
                incompleteCount: 0,
                readyCount: 1
            }
        ]
    }, null, 2)}\n`, 'utf8');
    const proposal = createMinimalGoldProposal();
    const alphaSweepText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { directAlphaGainCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileReportText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: { profileCouldClearVisible: 0 }
    }, null, 2)}\n`;
    const profileGeneralizationText = `${JSON.stringify({
        inputs: { reviewManifestSha256 },
        summary: {
            total: 13,
            improvedSeverity: 7,
            clearedVisible: 4
        }
    }, null, 2)}\n`;
    await writeFile(path.join(alphaSweepDir, 'model-investigation-alpha-sweep.json'), alphaSweepText, 'utf8');
    await writeFile(path.join(alphaProfileDir, 'model-investigation-alpha-profile.json'), profileReportText, 'utf8');
    await writeFile(path.join(alphaProfileDir, 'large-margin-48-profile-candidate.json'), profileGeneralizationText, 'utf8');
    proposal.inputs = {
        ...proposal.inputs,
        reviewManifestSha256,
        alphaSweepSha256: sha256Text(alphaSweepText),
        alphaSweepReviewManifestSha256: reviewManifestSha256,
        profileReportSha256: sha256Text(profileReportText),
        profileReportReviewManifestSha256: reviewManifestSha256,
        profileGeneralizationSha256: sha256Text(profileGeneralizationText),
        profileGeneralizationReviewManifestSha256: reviewManifestSha256
    };
    proposal.summary = {
        readyForHumanConfirmation: 1,
        pendingHumanReview: 0
    };
    const proposalText = `${JSON.stringify(proposal, null, 2)}\n`;
    const goldProposalSha256 = sha256Text(proposalText);
    await writeFile(path.join(artifactDir, 'gold-proposal.json'), proposalText, 'utf8');
    const reviewClusterReportText = await readFile(path.join(artifactDir, 'review-clusters.json'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-worksheet.md'), [
        '# Visible Residual Review Worksheet',
        '',
        '## Provenance',
        '',
        `- validationReportSha256: \`${validationReportSha256}\``,
        `- reviewManifestSha256: \`${reviewManifestSha256}\``,
        `- reviewClusterSha256: \`${sha256Text(reviewClusterReportText)}\``,
        ''
    ].join('\n'), 'utf8');
    await writeFile(
        path.join(humanReviewPackDir, 'review-table.csv'),
        'index,validationReportSha256,reviewManifestSha256,reviewClusterSha256\n',
        'utf8'
    );
    await writeFile(path.join(humanReviewPackDir, 'cluster-review-worksheet.md'), [
        '# Visible Residual Cluster Review Worksheet',
        '',
        '## Provenance',
        '',
        `- reviewManifestSha256: \`${reviewManifestSha256}\``,
        `- validationReportSha256: \`${validationReportSha256}\``,
        `- reviewClusterSha256: \`${sha256Text(reviewClusterReportText)}\``,
        ''
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-progress-report.json'), `${JSON.stringify({
        policy: {
            readOnly: true,
            writesReviewProgressReport: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        inputs: {
            validationReportSha256,
            reviewManifestSha256,
            reviewClusterSha256: sha256Text(reviewClusterReportText)
        },
        summary: {
            readyForGoldMigration: true,
            unconfirmedCount: 0,
            goldCandidateUnconfirmedCount: 0
        },
        clusterSummary: {
            clusterTotal: 1
        },
        nextReviewClusters: [],
        reviewBatches: [],
        goldCandidateReviewBatches: [],
        nextGoldCandidateReviewBatch: null
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-focused-batch.json'), `${JSON.stringify({
        schemaVersion: 1,
        policy: {
            humanEditableFields: ['humanVerdict', 'humanConfidence', 'humanNotes'],
            validHumanVerdicts: [
                'trueVisibleResidual',
                'backgroundStructure',
                'contentCollision',
                'acceptableResidual',
                'needsModelInvestigation'
            ],
            validHumanConfidence: ['high', 'medium', 'low'],
            notesRequiredForVerdicts: ['trueVisibleResidual', 'needsModelInvestigation'],
            dryRunCommand: 'pnpm visible-residual:apply-focused-batch --dry-run',
            applyCommand: 'pnpm visible-residual:apply-focused-batch',
            validateCommandAfterApply: 'pnpm visible-residual:validate-human-review',
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        provenance: {
            validationReportSha256,
            reviewManifestSha256,
            reviewClusterSha256: sha256Text(reviewClusterReportText)
        },
        sourceBatches: {
            visibleResidualBatch: null,
            goldCandidateBatch: null
        },
        decisions: [],
        blockedActions: [
            {
                id: 'write-formal-gold-manifest',
                blocked: true
            },
            {
                id: 'productionize-alpha-profile-variant',
                blocked: true
            }
        ]
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'review-handoff.md'), [
        '# Visible Residual Review Handoff',
        '',
        `validationReportSha256: ${validationReportSha256}`,
        `reviewManifestSha256: ${reviewManifestSha256}`,
        `reviewClusterSha256: ${sha256Text(reviewClusterReportText)}`,
        'focusedReviewBatchPath: review-focused-batch.json',
        'writesFormalGoldManifest: false',
        'writesProductionAlgorithm: false',
        'allowsAlphaProfileProduction: false',
        'Focused Batch Editing Checklist',
        'Edit only: humanVerdict, humanConfidence, humanNotes',
        'humanVerdict allowed values: trueVisibleResidual, backgroundStructure, contentCollision, acceptableResidual, needsModelInvestigation',
        'humanConfidence allowed values: high, medium, low',
        'humanNotes is required when humanVerdict is: trueVisibleResidual, needsModelInvestigation',
        'rtk pnpm visible-residual:apply-focused-batch --dry-run',
        'rtk pnpm visible-residual:apply-focused-batch',
        'rtk pnpm visible-residual:validate-human-review',
        ''
    ].join('\n'), 'utf8');
    await writeFile(path.join(humanReviewPackDir, 'README.md'), [
        '# Visible Residual Human Review Pack',
        '',
        'Open review-handoff.md first for the current cluster sheets and crop previews.',
        'Use review-focused-batch.json to edit humanVerdict, humanConfidence, humanNotes only.',
        'Run rtk pnpm visible-residual:apply-focused-batch --dry-run before applying.',
        'Do not generate gold-manifest.json until human review is complete.',
        'Do not add alphaGain, profileVariant, renderProfile, or cleanupMode to decision inputs.',
        ''
    ].join('\n'), 'utf8');
    await writeHumanReviewPackSummaryWithHashes(humanReviewPackDir, {
        reviewManifestSha256,
        reviewInputContractSha256
    });
    await writeFile(path.join(artifactDir, 'algorithm-admission-report.json'), `${JSON.stringify({
        policy: {
            reportOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false
        },
        inputs: {
            validationReportSha256,
            reviewInputContractSha256,
            goldProposalSha256
        },
        validationInputContractIntegrity: {
            ok: true,
            problems: [],
            hashes: {
                reviewInputContractSha256,
                reviewInputContractReviewManifestSha256: reviewManifestSha256
            }
        },
        validationReadinessIntegrity: {
            ok: true,
            problems: [],
            readyForGoldMigration: true,
            expectedTotal: 1,
            readyDecisionCount: 1,
            readyDecisionsLength: 1,
            unconfirmedCount: 0,
            structuralErrorCount: 0
        },
        validationDecisionSchemaGateIntegrity: {
            ok: true,
            problems: [],
            gate: createDecisionSchemaGate()
        },
        proposalCandidateProvenance: {
            ok: true,
            problems: [],
            candidateCount: 1,
            expectedCandidateCount: 1,
            hashes: {
                reviewManifestSha256
            }
        },
        proposalValidationCoverage: {
            ok: true,
            problems: [],
            expectedTotal: 1,
            candidateCount: 1,
            expectedCandidateCount: 1,
            readyForHumanConfirmation: 1,
            pendingHumanReview: 0
        },
        proposalInputIntegrity: {
            ok: true,
            problems: [],
            hashes: {
                alphaSweepSha256: sha256Text(alphaSweepText),
                alphaSweepReviewManifestSha256: reviewManifestSha256,
                profileReportSha256: sha256Text(profileReportText),
                profileReportReviewManifestSha256: reviewManifestSha256,
                profileGeneralizationSha256: sha256Text(profileGeneralizationText),
                profileGeneralizationReviewManifestSha256: reviewManifestSha256
            }
        },
        algorithmAdmissionIntegrity: {
            ok: true,
            problems: [],
            productionChangeAllowed: false,
            productionChangeGate: [],
            requiredProductionChangeGateMarkers: [
                'human-confirmed-gold-manifest'
            ],
            approvedProductionChangeGateMarkers: [
                'accepted-alpha-profile-decision',
                'accepted-alpha-gain-sweep-decision'
            ],
            hasHumanConfirmedGoldManifestGate: false,
            hasApprovedProductionDecisionGate: false,
            alphaGainSweepDecision: 'reject-production-wide-alpha-sweep',
            alphaProfileDecision: 'reject-production-default-profile',
            approvedProductionDecisionCount: 0
        },
        goldSchemaGate: {
            armed: true,
            appliesToFormalGoldManifest: true,
            rejectsAlphaProfileVariantFields: true,
            rejectsUnknownFormalVisibleResidualFields: true,
            allowedFormalVisibleResidualFields: [
                'allowVisibleResidual',
                'humanConfidence',
                'humanNotes',
                'maxGradientResidual',
                'maxPositiveHaloLum',
                'maxSpatialResidual',
                'metrics',
                'notes',
                'suggestedConfidence',
                'suggestedVerdict',
                'visibleResidualVerdict'
            ],
            forbiddenAlphaProfileFieldKeys: ['alphagain'],
            failClosedProblemCodes: [
                'gold-manifest-alpha-profile-variant-fields-present',
                'gold-manifest-unknown-visible-residual-field-present'
            ],
            forbiddenAlphaProfileFieldPaths: [],
            unknownVisibleResidualFieldPaths: [],
            ok: true
        },
        goldManifestGate: {
            outputPath: path.join(artifactDir, 'gold-manifest.json'),
            exists: true,
            integrityReady: true,
            writeAllowed: true,
            blockedBeforeHumanConfirmation: false
        },
        goldManifestIntegrity: {
            ok: true,
            required: true,
            exists: true,
            problems: [],
            sampleCount: 1,
            readyDecisionCount: 1
        },
        productionProfileAdmission: {
            allowed: false,
            blockedReasons: []
        }
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(artifactDir, 'gold-manifest.json'), `${JSON.stringify({
        version: 1,
        inputs: {
            reviewManifestSha256,
            validationReportSha256,
            reviewInputContractSha256,
            goldProposalSha256,
            alphaSweepSha256: sha256Text(alphaSweepText),
            alphaSweepReviewManifestSha256: reviewManifestSha256,
            profileReportSha256: sha256Text(profileReportText),
            profileReportReviewManifestSha256: reviewManifestSha256,
            profileGeneralizationSha256: sha256Text(profileGeneralizationText),
            profileGeneralizationReviewManifestSha256: reviewManifestSha256
        },
        policy: {
            generatedOnlyAfterHumanConfirmation: true,
            writesProductionAlgorithm: false,
            containsAlphaProfileVariants: false
        },
        summary: {
            total: 1
        },
        samples: {
            'candidate-a.png': {
                clusterId: 'metricPassVisible::48px-large-margin::positiveHalo'
            }
        }
    }, null, 2)}\n`, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-goal-audit-report.js'),
        '--root', sourceRoot,
        '--artifact-dir', artifactDir,
        '--output', outputPath
    ]);
    const report = await readJson(outputPath);
    const formalGold = report.requirements.find((item) => item.id === 'formal-gold-migration');

    assert.equal(report.status, 'complete');
    assert.equal(report.summary.goldManifestExists, true);
    assert.equal(report.summary.goldManifestIntegrityReady, true);
    assert.equal(formalGold.status, 'satisfied');
    assert.equal(formalGold.evidence.goldManifestIntegrity.ready, true);
});

test('create-visible-residual-cluster-report should group review records by source profile and visible reasons', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-cluster-report-'));
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const outputPath = path.join(tempDir, 'review-clusters.json');
    const worksheetOutputPath = path.join(tempDir, 'cluster-review-worksheet.md');
    const clusterSheetDir = path.join(tempDir, 'by-cluster');
    const cropDir = path.join(tempDir, 'crops');
    const pendingACrop = path.join(cropDir, 'pending-a.svg');
    const pendingBCrop = path.join(cropDir, 'pending-b.svg');
    const candidateCrop = path.join(cropDir, 'candidate-a.svg');
    await writeTinySvg(pendingACrop);
    await writeTinySvg(pendingBCrop);
    await writeTinySvg(candidateCrop);
    const manifest = createMinimalReviewManifest({ includeGoldCandidate: true });
    manifest.groups.visibleTopPending[0].cropPath = pendingACrop;
    manifest.groups.visibleTopPending[1].cropPath = pendingBCrop;
    manifest.groups.metricPassVisible[0].cropPath = candidateCrop;
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(
        manifestPath,
        manifestText,
        'utf8'
    );
    const validationText = `${JSON.stringify({
        readyForGoldMigration: false,
        reviewManifestSha256: sha256Text(manifestText),
        pendingTotal: 2,
        goldCandidateTotal: 1,
        unconfirmedCount: 3,
        structuralErrorCount: 0,
        readyDecisionCount: 0,
        incompleteDecisions: [
            { sourceSet: 'visibleTopPending', file: 'pending-a.png', problems: ['invalid-or-missing-humanVerdict'] },
            { sourceSet: 'visibleTopPending', file: 'pending-b.png', problems: ['invalid-or-missing-humanVerdict'] },
            { sourceSet: 'metricPassVisible', file: 'candidate-a.png', problems: ['invalid-or-missing-humanVerdict'] }
        ],
        readyDecisions: [],
        structuralErrors: []
    }, null, 2)}\n`;
    await writeFile(validationPath, validationText, 'utf8');

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-cluster-report.js'),
        '--manifest', manifestPath,
        '--validation', validationPath,
        '--output', outputPath,
        '--worksheet-output', worksheetOutputPath,
        '--cluster-sheet-dir', clusterSheetDir
    ]);

    const report = await readJson(outputPath);
    const reportText = await readFile(outputPath, 'utf8');
    const worksheet = await readFile(worksheetOutputPath, 'utf8');
    assert.equal(report.policy.readOnly, true);
    assert.equal(report.policy.writesFormalGoldManifest, false);
    assert.equal(report.policy.writesProductionAlgorithm, false);
    assert.equal(report.inputs.reviewManifestSha256, sha256Text(manifestText));
    assert.equal(report.inputs.validationReportSha256, sha256Text(validationText));
    assert.equal(report.summary.totalRecords, 3);
    assert.equal(report.summary.clusterSheetCount, 3);
    assert.equal(report.summary.sourceSetCounts.visibleTopPending, 2);
    assert.equal(report.summary.sourceSetCounts.metricPassVisible, 1);
    assert.equal(report.summary.unconfirmedCount, 3);
    assert.ok(report.clusters.some((cluster) => (
        cluster.clusterId === 'visibleTopPending::48px-large-margin::positiveHalo' &&
        cluster.count === 1 &&
        cluster.incompleteCount === 1 &&
        existsSync(cluster.sheet.outputPath)
    )));
    assert.ok(report.clusters.some((cluster) => (
        cluster.clusterId === 'metricPassVisible::48px-large-margin::positiveHalo' &&
        cluster.files[0].file === 'candidate-a.png'
    )));
    assert.match(worksheet, /# Visible Residual Cluster Review Worksheet/);
    assert.match(worksheet, /reviewManifestSha256: `[0-9a-f]{64}`/);
    assert.match(worksheet, /validationReportSha256: `[0-9a-f]{64}`/);
    assert.match(worksheet, new RegExp(`reviewClusterSha256: \`${sha256Text(reportText)}\``));
    assert.match(worksheet, /Review one cluster at a time before changing any alpha\/profile candidate\./);
    assert.match(worksheet, /Use `by-cluster\/\*\.png` sheets for grouped visual inspection\./);
    assert.match(worksheet, /visibleTopPending::48px-large-margin::positiveHalo/);
    assert.match(worksheet, /This worksheet does not write `gold-manifest\.json`\./);
});

test('create-visible-residual-cluster-report should reject stale validation manifest hashes before writing artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-cluster-report-stale-validation-'));
    const manifestPath = path.join(tempDir, 'review-manifest.json');
    const validationPath = path.join(tempDir, 'validation-report.json');
    const outputPath = path.join(tempDir, 'review-clusters.json');
    const worksheetOutputPath = path.join(tempDir, 'cluster-review-worksheet.md');
    const clusterSheetDir = path.join(tempDir, 'by-cluster');
    const manifestText = `${JSON.stringify(createMinimalReviewManifest({ includeGoldCandidate: true }), null, 2)}\n`;
    await writeFile(manifestPath, manifestText, 'utf8');
    await writeFile(validationPath, `${JSON.stringify({
        readyForGoldMigration: false,
        reviewManifestSha256: '0'.repeat(64),
        pendingTotal: 2,
        goldCandidateTotal: 1,
        unconfirmedCount: 3,
        structuralErrorCount: 0,
        readyDecisionCount: 0,
        incompleteDecisions: [],
        readyDecisions: [],
        structuralErrors: []
    }, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-cluster-report.js'),
            '--manifest', manifestPath,
            '--validation', validationPath,
            '--output', outputPath,
            '--worksheet-output', worksheetOutputPath,
            '--cluster-sheet-dir', clusterSheetDir
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-report-review-manifest-hash-mismatch/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
    assert.equal(existsSync(worksheetOutputPath), false);
    assert.equal(existsSync(clusterSheetDir), false);
});

test('create-visible-residual-gold-manifest should fail closed while human validation is incomplete', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-blocked-'));
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: false })
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject writable gold proposal policies', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-writable-proposal-policy-'));
    const proposal = createMinimalGoldProposal();
    proposal.policy.writesFormalGoldManifest = true;
    proposal.policy.writesProductionAlgorithm = true;
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-policy-must-remain-proposal-only/);
    assert.match(error.stderr, /gold-proposal-policy-must-not-write-production-algorithm/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should require proposal schema gate', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-missing-proposal-schema-gate-'));
    const proposal = createMinimalGoldProposal();
    delete proposal.proposedGoldSchemaGate;
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-schema-gate-missing/);
    assert.match(error.stderr, /gold-proposal-schema-gate-not-ready/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should require validation decision schema gate', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-missing-validation-schema-gate-'));
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true })
    );
    const validation = await readJson(validationPath);
    delete validation.decisionSchemaGate;
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-decision-schema-gate-missing/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject alpha profile variant fields in proposal candidates', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-proposal-variant-fields-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.readyForHumanConfirmation[0].proposedGoldFields.cleanup = {
        'alpha-gain': 1.12
    };
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-alpha-profile-variant-fields-present/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject unknown proposed gold fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-proposal-unknown-fields-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.readyForHumanConfirmation[0].proposedGoldFields.cleanupMode = 'smooth';
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-unknown-gold-field-present/);
    assert.match(error.stderr, /unknownGoldFieldPaths/);
    assert.match(error.stderr, /candidate-a\.png\.cleanupMode/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should require cluster ids for ready decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-missing-cluster-'));
    const validation = createValidationReport({ ready: true });
    delete validation.readyDecisions[0].clusterId;
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(tempDir, validation);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject inconsistent ready validation counts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-inconsistent-validation-'));
    const validation = createValidationReport({ ready: true });
    validation.unconfirmedCount = 1;
    validation.structuralErrorCount = 1;
    validation.readyDecisionCount = 2;
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(tempDir, validation);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should require proposal coverage for ready decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-missing-proposal-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.readyForHumanConfirmation = [];
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject duplicate proposal candidate files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-duplicate-proposal-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.pendingHumanReview.push({
        ...proposal.goldCandidates.readyForHumanConfirmation[0]
    });
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject proposal candidates without ready decisions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-extra-proposal-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.pendingHumanReview.push({
        file: 'candidate-b.png',
        sourceSet: 'metricPassVisible',
        clusterId: 'metricPassVisible::48px-large-margin::positiveHalo-extra',
        profileLine: '48px-large-margin',
        visibleReasons: ['positiveHalo'],
        proposedGoldFields: {
            allowVisibleResidual: true,
            visibleResidualVerdict: 'acceptableResidual',
            maxPositiveHaloLum: 2,
            maxGradientResidual: 0.05,
            maxSpatialResidual: 0.04
        }
    });
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject ready decisions with mismatched proposal clusters', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-proposal-cluster-mismatch-'));
    const proposal = createMinimalGoldProposal();
    proposal.goldCandidates.readyForHumanConfirmation[0].clusterId = 'metricPassVisible::wrong-profile::positiveHalo';
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-ready-decisions-proposal-cluster-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject duplicate ready decision files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-duplicate-file-'));
    const validation = createValidationReport({ ready: true });
    validation.readyDecisions.push({
        ...validation.readyDecisions[0],
        clusterId: 'metricPassVisible::48px-large-margin::positiveHalo-duplicate',
        humanNotes: 'Duplicate entry should not overwrite the first sample.'
    });
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(tempDir, validation);

    await assert.rejects(
        execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ])
    );

    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject stale ready validation manifest hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-stale-validation-'));
    const validation = createValidationReport({ ready: true });
    validation.reviewManifestSha256 = '0'.repeat(64);
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(tempDir, validation);

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-review-manifest-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject stale gold proposal manifest hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-stale-proposal-'));
    const proposal = createMinimalGoldProposal();
    proposal.inputs = {
        reviewManifestSha256: '0'.repeat(64)
    };
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-review-manifest-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject stale gold proposal alpha profile hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-stale-profile-'));
    const proposal = createMinimalGoldProposal();
    proposal.inputs = {
        alphaSweepSha256: '0'.repeat(64),
        profileReportSha256: '1'.repeat(64),
        profileGeneralizationSha256: '2'.repeat(64)
    };
    const { reviewManifestPath, validationPath, proposalPath, outputPath } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true }),
        proposal
    );

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /gold-proposal-alpha-sweep-hash-mismatch/);
    assert.match(error.stderr, /gold-proposal-profile-report-hash-mismatch/);
    assert.match(error.stderr, /gold-proposal-profile-generalization-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject stale validation input contract hashes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-stale-contract-'));
    const {
        reviewManifestPath,
        validationPath,
        reviewInputContractPath,
        proposalPath,
        outputPath
    } = await writeGoldManifestInputs(
        tempDir,
        createValidationReport({ ready: true })
    );
    const validation = await readJson(validationPath);
    validation.reviewInputContractSha256 = '0'.repeat(64);
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-review-input-contract-hash-mismatch/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should reject incomplete validation input contract fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-incomplete-contract-fields-'));
    const { reviewManifestPath, validationPath, proposalPath, outputPath, reviewInputContractPath } =
        await writeGoldManifestInputs(tempDir, createValidationReport({ ready: true }));
    const contract = await readJson(reviewInputContractPath);
    contract.allowedDecisionInputRootFields = [
        ...ALLOWED_HUMAN_REVIEW_DECISION_INPUT_ROOT_FIELDS,
        'renderProfile'
    ];
    contract.allowedDecisionFields = ['file', 'humanVerdict', 'alpha_gain'];
    contract.forbiddenAlphaProfileFieldKeys = ['alphagain'];
    await writeFile(reviewInputContractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
    const validation = await readJson(validationPath);
    validation.reviewInputContractSha256 = sha256Text(await readFile(reviewInputContractPath, 'utf8'));
    await writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');

    let error = null;
    try {
        await execFileAsync(process.execPath, [
            path.resolve('scripts/create-visible-residual-gold-manifest.js'),
            '--validation', validationPath,
            '--proposal', proposalPath,
            '--manifest', reviewManifestPath,
            '--output', outputPath
        ]);
    } catch (caught) {
        error = caught;
    }

    assert.ok(error);
    assert.match(error.stderr, /validation-review-input-contract-decision-fields-missing/);
    assert.match(error.stderr, /validation-review-input-contract-forbidden-alpha-profile-fields-missing/);
    assert.match(error.stderr, /validation-review-input-contract-allows-alpha-profile-decision-fields/);
    assert.match(error.stderr, /validation-review-input-contract-allows-alpha-profile-root-fields/);
    assert.match(error.stderr, /skippedWrite/);
    assert.equal(existsSync(outputPath), false);
});

test('create-visible-residual-gold-manifest should write artifact manifest after human validation is ready', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'visible-gold-ready-'));
    const validation = createValidationReport({ ready: true });
    const {
        reviewManifestPath,
        reviewManifestSha256,
        validationPath,
        reviewInputContractPath,
        proposalPath,
        outputPath,
        alphaSweepPath,
        profileReportPath,
        profileGeneralizationPath
    } = await writeGoldManifestInputs(
        tempDir,
        validation
    );

    await execFileAsync(process.execPath, [
        path.resolve('scripts/create-visible-residual-gold-manifest.js'),
        '--validation', validationPath,
        '--proposal', proposalPath,
        '--manifest', reviewManifestPath,
        '--output', outputPath
    ]);

    const manifest = await readJson(outputPath);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.policy.generatedOnlyAfterHumanConfirmation, true);
    assert.equal(manifest.policy.writesProductionAlgorithm, false);
    assert.equal(manifest.inputs.validationPath, validationPath);
    assert.equal(manifest.inputs.reviewInputContractPath, reviewInputContractPath);
    assert.match(manifest.inputs.reviewInputContractSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.inputs.reviewManifestPath, reviewManifestPath);
    assert.equal(manifest.inputs.reviewManifestSha256, reviewManifestSha256);
    assert.match(manifest.inputs.validationReportSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.inputs.goldProposalPath, proposalPath);
    assert.match(manifest.inputs.goldProposalSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.inputs.alphaSweepPath, alphaSweepPath);
    assert.match(manifest.inputs.alphaSweepSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.inputs.profileReportPath, profileReportPath);
    assert.match(manifest.inputs.profileReportSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.inputs.profileGeneralizationPath, profileGeneralizationPath);
    assert.match(manifest.inputs.profileGeneralizationSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.summary.total, 1);
    assert.equal(
        manifest.samples['candidate-a.png'].clusterId,
        'metricPassVisible::48px-large-margin::positiveHalo'
    );
    assert.equal(manifest.samples['candidate-a.png'].visibleResidual.visibleResidualVerdict, 'trueVisibleResidual');
    assert.equal(manifest.samples['candidate-a.png'].visibleResidual.humanConfidence, 'high');
    assert.deepEqual(manifest.samples['candidate-a.png'].tags, [
        'visible-residual-gold',
        'metricPassVisible',
        'metricPassVisible::48px-large-margin::positiveHalo',
        '48px-large-margin',
        'trueVisibleResidual'
    ]);
});
