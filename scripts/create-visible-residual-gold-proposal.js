import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_ALPHA_SWEEP_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-sweep/model-investigation-alpha-sweep.json');
const DEFAULT_PROFILE_REPORT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/model-investigation-alpha-profile.json');
const DEFAULT_PROFILE_GENERALIZATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-profile-candidate.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/gold-proposal.json');
const FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS = new Set([
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
]);
const ALLOWED_PROPOSED_GOLD_FIELD_KEYS = new Set([
    'allowVisibleResidual',
    'maxGradientResidual',
    'maxPositiveHaloLum',
    'maxSpatialResidual',
    'notes',
    'visibleResidualVerdict'
]);
const PROPOSAL_SCHEMA_GATE_PROBLEM_CODES = Object.freeze([
    'gold-proposal-alpha-profile-variant-fields-present',
    'gold-proposal-unknown-gold-field-present'
]);

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        alphaSweepPath: DEFAULT_ALPHA_SWEEP_PATH,
        profileReportPath: DEFAULT_PROFILE_REPORT_PATH,
        profileGeneralizationPath: DEFAULT_PROFILE_GENERALIZATION_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--review') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--alpha-sweep') {
            parsed.alphaSweepPath = path.resolve(args.shift() || parsed.alphaSweepPath);
            continue;
        }
        if (arg === '--profile') {
            parsed.profileReportPath = path.resolve(args.shift() || parsed.profileReportPath);
            continue;
        }
        if (arg === '--profile-generalization') {
            parsed.profileGeneralizationPath = path.resolve(args.shift() || parsed.profileGeneralizationPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
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

function normalizeFieldKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectForbiddenAlphaProfileFieldPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const paths = [];
    for (const [key, nested] of Object.entries(value)) {
        const currentPath = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(key))) {
            paths.push(currentPath);
        }
        paths.push(...collectForbiddenAlphaProfileFieldPaths(nested, currentPath));
    }
    return paths;
}

function collectUnknownTopLevelFieldPaths(value, allowedKeys, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    return Object.keys(value)
        .filter((key) => !allowedKeys.has(key))
        .map((key) => (prefix ? `${prefix}.${key}` : key));
}

function assessAlphaReportManifestIntegrity({ alphaSweep, profileReport, profileGeneralization, reviewManifestSha256 }) {
    const checks = [
        {
            name: 'alpha-sweep',
            report: alphaSweep,
            problem: 'alpha-sweep-review-manifest-hash-mismatch'
        },
        {
            name: 'profile-report',
            report: profileReport,
            problem: 'profile-report-review-manifest-hash-mismatch'
        },
        {
            name: 'profile-generalization',
            report: profileGeneralization,
            problem: 'profile-generalization-review-manifest-hash-mismatch'
        }
    ];
    const problems = [];
    const hashes = {};
    for (const check of checks) {
        const hash = check.report?.inputs?.reviewManifestSha256 ?? null;
        hashes[`${check.name}ReviewManifestSha256`] = hash;
        if (hash !== reviewManifestSha256) {
            problems.push(check.problem);
        }
    }
    return { ok: problems.length === 0, problems, hashes };
}

function round(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function normalizeReasons(reasons) {
    return [...new Set(reasons ?? [])].sort((left, right) => left.localeCompare(right));
}

function clusterIdFor({ sourceSet, profileLine, visibleReasons }) {
    return `${sourceSet}::${profileLine}::${normalizeReasons(visibleReasons).join('+')}`;
}

function defaultThresholds(metrics, multiplier = 1.25) {
    return {
        maxPositiveHaloLum: round(Math.max(0, metrics?.positiveHaloLum ?? 0) * multiplier, 3),
        maxGradientResidual: round(Math.max(0, metrics?.gradientResidual ?? 0) * multiplier, 3),
        maxSpatialResidual: round(Math.max(0, metrics?.spatialResidual ?? 0) * multiplier, 3)
    };
}

function buildGoldCandidate(record, { sourceSet }) {
    const verdict = record.review?.verdict ?? 'pending';
    const profileLine = record.review?.profileLine ?? 'unknown';
    const visibleReasons = record.metrics?.visibleReasons ?? [];
    const clusterId = clusterIdFor({ sourceSet, profileLine, visibleReasons });
    const base = {
        file: record.file,
        reviewStatus: 'proposal-only-needs-human-confirmation',
        visibleResidualVerdict: verdict,
        visibleResidualConfidence: record.review?.confidence ?? 'unknown',
        sourceSet,
        clusterId,
        profileLine,
        visibleReasons,
        residualClasses: record.review?.residualClasses ?? [],
        sourceGroup: record.group,
        cropPath: record.cropPath,
        notes: record.review?.notes ?? '',
        currentMetrics: record.metrics
    };

    if (verdict === 'trueVisibleResidual' || verdict === 'needsModelInvestigation') {
        return {
            ...base,
            allowVisibleResidual: false,
            proposedGoldFields: {
                allowVisibleResidual: false,
                visibleResidualVerdict: verdict,
                maxPositiveHaloLum: Math.max(0, Math.min(6, round((record.metrics?.positiveHaloLum ?? 0) * 0.75, 3))),
                maxGradientResidual: Math.max(0, Math.min(0.22, round((record.metrics?.gradientResidual ?? 0) * 0.9, 3))),
                maxSpatialResidual: Math.max(0, Math.min(0.18, round((record.metrics?.spatialResidual ?? 0) * 0.9, 3))),
                notes: record.review?.notes ?? ''
            },
            migrationGate: 'requires-human-confirmation-and-stable-fixture'
        };
    }

    if (verdict === 'contentCollision' || verdict === 'acceptableResidual' || verdict === 'backgroundStructure') {
        return {
            ...base,
            allowVisibleResidual: true,
            proposedGoldFields: {
                allowVisibleResidual: true,
                visibleResidualVerdict: verdict,
                ...defaultThresholds(record.metrics, verdict === 'backgroundStructure' ? 1.5 : 1.25),
                notes: record.review?.notes ?? ''
            },
            migrationGate: 'requires-human-confirmation'
        };
    }

    return {
        ...base,
        allowVisibleResidual: null,
        proposedGoldFields: null,
        migrationGate: 'pending-human-review'
    };
}

function summarizeAdmission({
    alphaSweep,
    profileReport,
    profileGeneralization
}) {
    const alphaSweepCleared = alphaSweep.summary?.directAlphaGainCouldClearVisible ?? null;
    const profileCleared = profileReport.summary?.profileCouldClearVisible ?? null;
    const generalized = profileGeneralization.summary ?? {};
    const totalGeneralization = generalized.total ?? 0;
    const improved = generalized.improvedSeverity ?? 0;
    const cleared = generalized.clearedVisible ?? 0;
    const improvedRatio = totalGeneralization > 0 ? improved / totalGeneralization : 0;
    const clearedRatio = totalGeneralization > 0 ? cleared / totalGeneralization : 0;

    return {
        alphaGainSweep: {
            decision: alphaSweepCleared === 0 ? 'reject-production-wide-alpha-sweep' : 'needs-review',
            evidence: {
                directAlphaGainCouldClearVisible: alphaSweepCleared,
                total: alphaSweep.summary?.total ?? null
            },
            reason: '固定几何下单纯 alphaGain 不能清除模型队列可见残留。'
        },
        alphaProfileMidBoost124: {
            decision: improvedRatio >= 0.8 && clearedRatio >= 0.6
                ? 'candidate-needs-human-review'
                : 'reject-production-default-profile',
            evidence: {
                modelQueueProfileCouldClearVisible: profileCleared,
                generalizedTotal: totalGeneralization,
                generalizedImprovedSeverity: improved,
                generalizedClearedVisible: cleared,
                improvedRatio: round(improvedRatio, 4),
                clearedRatio: round(clearedRatio, 4),
                hardRejectBest: generalized.hardRejectBest ?? null
            },
            reason: 'mid-boost-1.24 有诊断信号，但泛化不足且会在部分样本放大 shape/texture 风险。'
        },
        productionChangeAllowed: false,
        productionChangeGate: [
            '必须先完成人工确认 review manifest',
            '必须有正式 gold manifest 字段',
            '必须在目标 cluster 上改善且不恶化 contentCollision/backgroundStructure',
            '必须保留 before/after/contrast sheet 证据',
            '必须通过测试和 benchmark'
        ]
    };
}

function collectGoldCandidates(reviewManifest) {
    return {
        readyForHumanConfirmation: (reviewManifest.groups?.metricPassVisible ?? [])
            .map((record) => buildGoldCandidate(record, { sourceSet: 'metricPassVisible' })),
        pendingHumanReview: (reviewManifest.groups?.visibleTopPending ?? [])
            .map((record) => buildGoldCandidate(record, { sourceSet: 'visibleTopPending' }))
    };
}

function flattenGoldCandidates(goldCandidates) {
    return [
        ...goldCandidates.readyForHumanConfirmation ?? [],
        ...goldCandidates.pendingHumanReview ?? []
    ];
}

function buildProposedGoldSchemaGate(goldCandidates) {
    const candidates = flattenGoldCandidates(goldCandidates);
    const forbiddenAlphaProfileFieldPaths = candidates.flatMap((candidate) => (
        collectForbiddenAlphaProfileFieldPaths(candidate.proposedGoldFields, candidate.file)
    ));
    const unknownGoldFieldPaths = candidates.flatMap((candidate) => (
        collectUnknownTopLevelFieldPaths(candidate.proposedGoldFields, ALLOWED_PROPOSED_GOLD_FIELD_KEYS, candidate.file)
    ));
    return {
        armed: true,
        appliesToProposedGoldFields: true,
        rejectsAlphaProfileVariantFields: true,
        rejectsUnknownProposedGoldFields: true,
        allowedProposedGoldFields: [...ALLOWED_PROPOSED_GOLD_FIELD_KEYS].sort(),
        forbiddenAlphaProfileFieldKeys: [...FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS].sort(),
        failClosedProblemCodes: PROPOSAL_SCHEMA_GATE_PROBLEM_CODES,
        forbiddenAlphaProfileFieldPaths,
        unknownGoldFieldPaths,
        ok: forbiddenAlphaProfileFieldPaths.length === 0 && unknownGoldFieldPaths.length === 0
    };
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const reviewManifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const alphaSweepText = stripBom(await readFile(args.alphaSweepPath, 'utf8'));
    const profileReportText = stripBom(await readFile(args.profileReportPath, 'utf8'));
    const profileGeneralizationText = stripBom(await readFile(args.profileGeneralizationPath, 'utf8'));
    const reviewManifest = JSON.parse(reviewManifestText);
    const alphaSweep = JSON.parse(alphaSweepText);
    const profileReport = JSON.parse(profileReportText);
    const profileGeneralization = JSON.parse(profileGeneralizationText);
    const alphaReportInputIntegrity = assessAlphaReportManifestIntegrity({
        alphaSweep,
        profileReport,
        profileGeneralization,
        reviewManifestSha256
    });
    if (!alphaReportInputIntegrity.ok) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            outputPath: args.outputPath,
            problems: alphaReportInputIntegrity.problems,
            expectedReviewManifestSha256: reviewManifestSha256,
            actualAlphaSweepReviewManifestSha256: alphaReportInputIntegrity.hashes['alpha-sweepReviewManifestSha256'],
            actualProfileReportReviewManifestSha256: alphaReportInputIntegrity.hashes['profile-reportReviewManifestSha256'],
            actualProfileGeneralizationReviewManifestSha256:
                alphaReportInputIntegrity.hashes['profile-generalizationReviewManifestSha256']
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const goldCandidates = collectGoldCandidates(reviewManifest);
    const proposedGoldSchemaGate = buildProposedGoldSchemaGate(goldCandidates);
    if (!proposedGoldSchemaGate.ok) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            outputPath: args.outputPath,
            problems: PROPOSAL_SCHEMA_GATE_PROBLEM_CODES.filter((code) => (
                code === 'gold-proposal-alpha-profile-variant-fields-present'
                    ? proposedGoldSchemaGate.forbiddenAlphaProfileFieldPaths.length > 0
                    : proposedGoldSchemaGate.unknownGoldFieldPaths.length > 0
            )),
            proposedGoldSchemaGate
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const ready = goldCandidates.readyForHumanConfirmation;
    const pending = goldCandidates.pendingHumanReview;

    const report = {
        generatedAt: new Date().toISOString(),
        inputs: {
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256,
            alphaSweepPath: args.alphaSweepPath,
            alphaSweepSha256: sha256Text(alphaSweepText),
            alphaSweepReviewManifestSha256: alphaSweep.inputs.reviewManifestSha256,
            profileReportPath: args.profileReportPath,
            profileReportSha256: sha256Text(profileReportText),
            profileReportReviewManifestSha256: profileReport.inputs.reviewManifestSha256,
            profileGeneralizationPath: args.profileGeneralizationPath,
            profileGeneralizationSha256: sha256Text(profileGeneralizationText),
            profileGeneralizationReviewManifestSha256: profileGeneralization.inputs.reviewManifestSha256
        },
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            requiresHumanConfirmationBeforeGoldMigration: true,
            requiresHumanConfirmationBeforeProductionProfile: true
        },
        summary: {
            readyForHumanConfirmation: ready.length,
            pendingHumanReview: pending.length,
            readyVerdictCounts: countBy(ready, (item) => item.visibleResidualVerdict),
            pendingProfileCounts: countBy(pending, (item) => item.profileLine)
        },
        proposedGoldSchemaGate,
        goldCandidates,
        algorithmAdmission: summarizeAdmission({
            alphaSweep,
            profileReport,
            profileGeneralization
        })
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        algorithmAdmission: report.algorithmAdmission
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
