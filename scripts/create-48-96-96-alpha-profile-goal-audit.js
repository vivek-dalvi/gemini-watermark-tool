import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_ARTIFACT_DIR = path.resolve('.artifacts/visible-residual-crops/latest');
const DEFAULT_OUTPUT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-goal-audit.json'
);

function parseArgs(argv) {
    const parsed = {
        artifactDir: DEFAULT_ARTIFACT_DIR,
        outputPath: DEFAULT_OUTPUT_PATH
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--artifact-dir') {
            parsed.artifactDir = path.resolve(args.shift() || parsed.artifactDir);
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

async function readJson(filePath) {
    return JSON.parse(stripBom(await readFile(filePath, 'utf8')));
}

function requirement(id, description, satisfied, evidence, blockers = []) {
    return {
        id,
        description,
        status: satisfied ? 'satisfied' : 'unsatisfied',
        satisfied,
        evidence,
        blockers
    };
}

function policyIsDiagnosticOnly(policy) {
    return policy?.diagnosticOnly === true &&
        policy?.writesFormalGoldManifest === false &&
        policy?.writesProductionAlgorithm === false &&
        policy?.allowsAlphaProfileProduction === false;
}

function pathEvidence(label, filePath) {
    return {
        label,
        path: filePath,
        exists: existsSync(filePath)
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const geometryFamilyPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-alpha-profile.json');
    const geometryFamilySheetPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-alpha-profile.png');
    const geometryFamilySheetJsonPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-alpha-profile-sheet.json');
    const referenceBoundaryPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-reference-boundary.json');
    const referenceBoundarySheetPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-reference-boundary.png');
    const referenceBoundarySheetJsonPath = path.join(args.artifactDir, 'alpha-profile/geometry-family-48-96-96-reference-boundary-sheet.json');
    const fixedCandidateGatePath = path.join(args.artifactDir, 'alpha-profile/large-margin-48-power088-gate.json');
    const fixedCandidateGateSheetPath = path.join(args.artifactDir, 'alpha-profile/large-margin-48-power088-gate.png');
    const loopSummaryPath = path.join(args.artifactDir, 'loop-summary.json');
    const goldManifestPath = path.join(args.artifactDir, 'gold-manifest.json');

    const geometryFamily = await readJson(geometryFamilyPath);
    const referenceBoundary = await readJson(referenceBoundaryPath);
    const fixedCandidateGate = await readJson(fixedCandidateGatePath);
    const loopSummary = await readJson(loopSummaryPath);
    const reference = geometryFamily.summary?.reference?.familyApplicable ?? {};
    const fixedGate = fixedCandidateGate.gate ?? {};
    const loop = loopSummary.summary ?? {};

    const diagnosticsReady = [
        geometryFamilyPath,
        geometryFamilySheetPath,
        geometryFamilySheetJsonPath,
        referenceBoundaryPath,
        referenceBoundarySheetPath,
        referenceBoundarySheetJsonPath,
        fixedCandidateGatePath,
        fixedCandidateGateSheetPath
    ].every((filePath) => existsSync(filePath));
    const diagnosticPoliciesReady =
        policyIsDiagnosticOnly(geometryFamily.policy) &&
        policyIsDiagnosticOnly(referenceBoundary.policy) &&
        fixedCandidateGate.policy?.diagnosticOnly === true &&
        fixedCandidateGate.policy?.writesFormalGoldManifest === false &&
        fixedCandidateGate.policy?.writesProductionAlgorithm === false &&
        fixedCandidateGate.policy?.allowsAlphaProfileProduction === false;
    const notOnlyLargeMargin =
        reference.clearedByProfileLine?.['45px-other'] === 1 &&
        reference.clearedByProfileLine?.['46px-other'] === 1 &&
        (reference.clearedByProfileLine?.['48px-large-margin'] ?? 0) === 0;
    const rejectedProductionCandidate =
        geometryFamily.summary?.conclusion === 'reference-candidate-rejected-unsafe-within-family' &&
        reference.clearedVisible === 2 &&
        reference.unsafe === 6 &&
        reference.visibleAfter === 15 &&
        geometryFamily.summary?.bestHumanReviewOnly === null &&
        fixedGate.decision === 'reject-production-candidate' &&
        referenceBoundary.summary?.conclusion === 'reference-candidate-has-no-clean-evidence-boundary' &&
        referenceBoundary.summary?.cleanIsolationRuleCount === 0;
    const noForbiddenWrites =
        loop.readyForGoldMigration === false &&
        loop.goldManifestWriteAllowed === false &&
        loop.goldManifestExists === false &&
        existsSync(goldManifestPath) === false &&
        loop.productionProfileAllowed === false &&
        loop.productionHitCount === 0 &&
        loop.productionArtifactHitCount === 0;

    const requirements = [
        requirement(
            'reproducible-diagnostics',
            '48/96/96 family, fixed candidate, and reference boundary diagnostics exist and are read-only.',
            diagnosticsReady && diagnosticPoliciesReady,
            [
                pathEvidence('geometry family report', geometryFamilyPath),
                pathEvidence('geometry family sheet', geometryFamilySheetPath),
                pathEvidence('reference boundary report', referenceBoundaryPath),
                pathEvidence('reference boundary sheet', referenceBoundarySheetPath),
                pathEvidence('fixed candidate gate report', fixedCandidateGatePath),
                pathEvidence('fixed candidate gate sheet', fixedCandidateGateSheetPath)
            ],
            diagnosticsReady ? [] : ['missing-diagnostic-artifact']
        ),
        requirement(
            'not-profileline-exclusive',
            'The power-0.88 + alphaGain=0.55 clears non-target 45/46px profileLine records, not current 48px-large-margin records.',
            notOnlyLargeMargin,
            {
                clearedByProfileLine: reference.clearedByProfileLine,
                applicableByProfileLine: geometryFamily.summary?.applicableByProfileLine,
                fixedCandidateTarget: fixedCandidateGate.summary?.target,
                fixedCandidateNonTarget: fixedCandidateGate.summary?.nonTarget
            },
            notOnlyLargeMargin ? [] : ['reference-clear-profile-boundary-not-proven']
        ),
        requirement(
            'rejected-as-production-candidate',
            'The candidate is converged to diagnostic-only rejection, with no clean evidence gate and no safe human-review-only grid alternative.',
            rejectedProductionCandidate,
            {
                geometryFamilyConclusion: geometryFamily.summary?.conclusion,
                referenceFamilyApplicable: reference,
                bestHumanReviewOnly: geometryFamily.summary?.bestHumanReviewOnly,
                fixedCandidateGate: fixedGate,
                boundarySummary: referenceBoundary.summary
            },
            rejectedProductionCandidate ? [] : ['candidate-rejection-not-fully-proven']
        ),
        requirement(
            'no-forbidden-gold-or-production-writes',
            'Formal gold manifest, alpha/profile productionization, and 45/46px local geometry loosening remain blocked before human review.',
            noForbiddenWrites,
            {
                loopSummary: loop,
                goldManifestPath,
                goldManifestExistsOnDisk: existsSync(goldManifestPath)
            },
            noForbiddenWrites ? [] : ['forbidden-write-or-production-signal-present']
        )
    ];
    const unsatisfiedRequirements = requirements.filter((item) => !item.satisfied);
    const report = {
        generatedAt: new Date().toISOString(),
        objective:
            '验证并收敛 48/96/96 大边距水印的窄口径 alpha/profile 候选：围绕 power-0.88 + alphaGain=0.55 建立可复现诊断、可视化对比和准入证据，确认其是否只适用于 48px large-margin 样本；在人工审阅完成前不得写正式 gold manifest、不得生产化 alpha/profile、不得放宽 45/46px local geometry。',
        artifactDir: args.artifactDir,
        goalAchieved: unsatisfiedRequirements.length === 0,
        conclusion: unsatisfiedRequirements.length === 0
            ? 'achieved-as-diagnostic-rejection'
            : 'incomplete',
        requirements,
        unsatisfiedRequirementIds: unsatisfiedRequirements.map((item) => item.id),
        finalFindings: {
            candidate: '48/96/96 + power-0.88 + alphaGain=0.55',
            productionDecision: 'reject-production-candidate',
            profileLineExclusive: false,
            profileLineExclusiveReason:
                'Cleared records are 45px-other and 46px-other; current 48px-large-margin records have zero clears and multiple unsafe/visible-after outcomes.',
            nextAllowedWork:
                'Continue alpha edge / antialiasing / render-model investigation only as diagnostic work until human review confirms gold data.'
        }
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        goalAchieved: report.goalAchieved,
        conclusion: report.conclusion,
        unsatisfiedRequirementIds: report.unsatisfiedRequirementIds
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
