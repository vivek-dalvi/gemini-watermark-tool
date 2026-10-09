import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/release-goal-audit/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/release-goal-audit/latest-report.md');

const EXPECTED_SCRIPTS = Object.freeze({
    'compare:allenk-v2': 'node scripts/create-allenk-v2-comparison-report.js',
    'release:readiness': 'node scripts/create-release-readiness-report.js',
    'release:image-validation': 'node scripts/run-image-release-validation.js',
    'release:image-evidence': 'node scripts/create-image-release-evidence.js',
    'release:image-quality-gate': 'node scripts/check-image-release-evidence.js',
    'release:quality-gate': 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready',
    'release:goal-audit': 'node scripts/create-release-goal-audit-report.js',
    'release:ci-check': 'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed',
    'release:preflight': 'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check'
});

const DEFAULT_INPUTS = Object.freeze({
    packageJson: 'package.json',
    readinessReport: '.artifacts/release-readiness/latest-report.json',
    allenkComparisonReport: '.artifacts/allenk-v2-comparison/latest-report.json'
});

function normalizePath(inputPath) {
    return path.resolve(inputPath);
}

async function readJsonArtifact(inputPath) {
    const resolved = normalizePath(inputPath);
    try {
        return {
            path: resolved,
            exists: true,
            json: JSON.parse(await readFile(resolved, 'utf8')),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            json: null,
            error: error?.message || String(error)
        };
    }
}

function unique(values = []) {
    return [...new Set(values.filter((value) => value !== null && value !== undefined).map(String))];
}

function includesAll(values = [], required = []) {
    const set = new Set(values);
    return required.every((item) => set.has(item));
}

function requirement(id, description, satisfied, evidence = {}, blockers = []) {
    return {
        id,
        description,
        status: satisfied ? 'satisfied' : 'unsatisfied',
        satisfied,
        blockers: satisfied ? [] : blockers,
        evidence
    };
}

function scriptReadiness(pkg) {
    const scripts = pkg?.scripts || {};
    return Object.fromEntries(Object.entries(EXPECTED_SCRIPTS).map(([name, command]) => [
        name,
        {
            expected: command,
            actual: scripts[name] || null,
            ready: scripts[name] === command
        }
    ]));
}

function summarizeRequirements({ packageArtifact, readinessArtifact, allenkArtifact }) {
    const pkg = packageArtifact.json || {};
    const readiness = readinessArtifact.json || {};
    const allenk = allenkArtifact.json || {};
    const overall = readiness.overall || {};
    const index = overall.releaseEvidenceIndex || {};
    const claimPolicy = index.claimPolicy || {};
    const releasePackage = index.releasePackage || {};
    const imageQuality = index.imageQuality || {};
    const imageScope = index.imageScope || {};
    const videoScope = index.videoScope || {};
    const readinessLanes = Array.isArray(readiness.lanes) ? readiness.lanes : [];
    const laneById = Object.fromEntries(readinessLanes.map((lane) => [lane.id, lane]));
    const scripts = scriptReadiness(pkg);
    const allowed = unique(claimPolicy.allowedCapabilityIds || []);
    const reviewOnly = unique(claimPolicy.reviewOnlyCapabilityIds || []);
    const experimentOnly = unique(claimPolicy.experimentOnlyCapabilityIds || []);
    const forbidden = unique(claimPolicy.forbiddenCapabilityIds || []);
    const activeForbiddenClaims = unique(claimPolicy.activeForbiddenClaims || []);
    const scriptReady = Object.values(scripts).every((item) => item.ready);
    const qualityGateReady = overall.releaseReadinessGate?.ok === true &&
        overall.recommendation === 'rc-current-image-defaults-with-scoped-claims' &&
        overall.releaseEvidenceIndexIntegrity?.ok === true;

    const releasePackageReady = Boolean(
        releasePackage.zipPath &&
        releasePackage.sha256Path &&
        releasePackage.latestExtensionPath &&
        releasePackage.sha256 &&
        releasePackage.hashMatchesMetadata === true &&
        releasePackage.hashMatchesShaFile === true &&
        releasePackage.sizeMatchesMetadata === true
    );

    const imageEvidenceCurrent = Boolean(
        index.requestedScope === 'image-defaults' &&
        imageQuality.status === 'current' &&
        imageQuality.gateOk === true &&
        imageQuality.evidencePath
    );

    const imageScopeDecided = Boolean(
        includesAll(allowed, ['current-image-defaults']) &&
        includesAll(forbidden, ['broad-image-v2-coverage', 'visible-residual-alpha-profile-productionization']) &&
        imageQuality.status === 'current' &&
        imageQuality.gateOk === true
    );

    const videoScopeDecided = Boolean(
        includesAll(allowed, ['video-production-defaults']) &&
        includesAll(experimentOnly, ['video-denoise-default', 'video-alpha-shape-default']) &&
        includesAll(forbidden, ['video-v2-allenk-parity']) &&
        videoScope.productionDefaultsStatus === 'safe-current-defaults' &&
        videoScope.defaultDenoiseBackend === 'none' &&
        videoScope.denoiseStatus === 'experiment-only' &&
        Number(videoScope.denoisePromotedCount) === 0 &&
        videoScope.alphaShapeStatus === 'experiment-only' &&
        Number(videoScope.alphaShapePromotedCount) === 0
    );

    const defaultPathProtected = Boolean(
        claimPolicy.publicClaimScanStatus === 'clean' &&
        Number(claimPolicy.publicClaimViolationCount) === 0 &&
        claimPolicy.releaseDocsStatus === 'ready' &&
        includesAll(activeForbiddenClaims, [
            'broad-image-v2-coverage',
            'new-visible-residual-alpha-profile-productionization',
            'video-v2-allenk-parity',
            'new-video-denoise-default',
            'new-video-alpha-shape-default'
        ]) &&
        overall.releaseInvariantChecks?.ok === true &&
        overall.releaseDecisionSummary?.releaseClaimGuardsOk === true &&
        overall.releaseEvidenceIndexIntegrity?.ok === true
    );

    return [
        requirement(
            'reproducible-release-preflight',
            'Release preflight and quality gates are fixed, exact, and passing on the current artifacts.',
            scriptReady && qualityGateReady,
            {
                scripts,
                recommendation: overall.recommendation || null,
                releaseReadinessGateOk: overall.releaseReadinessGate?.ok === true,
                releaseEvidenceIndexIntegrityOk: overall.releaseEvidenceIndexIntegrity?.ok === true
            },
            [
                ...(!scriptReady ? ['release-script-entrypoint-mismatch'] : []),
                ...(!qualityGateReady ? ['release-quality-gate-not-passing'] : [])
            ]
        ),
        requirement(
            'release-package-ready',
            'The scoped RC package is freshly built, hashed, and matched by latest-extension metadata and sha256 file.',
            releasePackageReady,
            {
                version: releasePackage.version || null,
                zipPath: releasePackage.zipPath || null,
                sha256Path: releasePackage.sha256Path || null,
                latestExtensionPath: releasePackage.latestExtensionPath || null,
                sha256: releasePackage.sha256 || null,
                hashMatchesMetadata: releasePackage.hashMatchesMetadata === true,
                hashMatchesShaFile: releasePackage.hashMatchesShaFile === true,
                sizeMatchesMetadata: releasePackage.sizeMatchesMetadata === true,
                releaseArtifactStatus: laneById['release-artifact']?.status || null,
                userscriptArtifactStatus: laneById['userscript-artifact']?.status || null
            },
            ['release-package-integrity-not-ready']
        ),
        requirement(
            'image-release-evidence-current',
            'The pinned image evidence is current for the image-defaults release scope.',
            imageEvidenceCurrent,
            {
                requestedScope: index.requestedScope || null,
                imageQuality
            },
            ['image-release-evidence-not-current']
        ),
        requirement(
            'image-release-scope-decided',
            'Image defaults and V2 36 small profile are scoped for release while broad V2 and visible-residual productionization remain blocked.',
            imageScopeDecided,
            {
                allowed,
                forbidden,
                imageScope
            },
            ['image-release-scope-not-settled']
        ),
        requirement(
            'video-release-scope-decided',
            'Video defaults remain conservative, review pack is review-only, and denoise/alpha-shape candidates remain experiment-only.',
            videoScopeDecided,
            {
                allowed,
                reviewOnly,
                experimentOnly,
                forbidden,
                videoScope
            },
            ['video-release-scope-not-settled']
        ),
        requirement(
            'default-path-and-public-claim-protection',
            'Forbidden capabilities are actively blocked from public claims and cannot silently enter the release/default path.',
            defaultPathProtected,
            {
                activeForbiddenClaims,
                publicClaimScanStatus: claimPolicy.publicClaimScanStatus || null,
                publicClaimViolationCount: claimPolicy.publicClaimViolationCount ?? null,
                releaseDocsStatus: claimPolicy.releaseDocsStatus || null,
                releaseInvariantChecksOk: overall.releaseInvariantChecks?.ok === true,
                releaseClaimGuardsOk: overall.releaseDecisionSummary?.releaseClaimGuardsOk === true,
                releaseEvidenceIndexIntegrityOk: overall.releaseEvidenceIndexIntegrity?.ok === true
            },
            ['default-path-or-public-claim-protection-incomplete']
        )
    ];
}

export async function createReleaseGoalAuditReport({ inputs = DEFAULT_INPUTS } = {}) {
    const packageArtifact = await readJsonArtifact(inputs.packageJson || DEFAULT_INPUTS.packageJson);
    const readinessArtifact = await readJsonArtifact(inputs.readinessReport || DEFAULT_INPUTS.readinessReport);
    const allenkArtifact = await readJsonArtifact(inputs.allenkComparisonReport || DEFAULT_INPUTS.allenkComparisonReport);
    const artifacts = {
        packageJson: {
            path: packageArtifact.path,
            exists: packageArtifact.exists,
            error: packageArtifact.error
        },
        readinessReport: {
            path: readinessArtifact.path,
            exists: readinessArtifact.exists,
            error: readinessArtifact.error
        },
        allenkComparisonReport: {
            path: allenkArtifact.path,
            exists: allenkArtifact.exists,
            error: allenkArtifact.error
        }
    };
    const missingArtifacts = Object.entries(artifacts)
        .filter(([, artifact]) => !artifact.exists)
        .map(([id]) => id);
    const requirements = missingArtifacts.length === 0
        ? summarizeRequirements({ packageArtifact, readinessArtifact, allenkArtifact })
        : [];
    const unsatisfiedRequirementIds = requirements
        .filter((item) => item.satisfied !== true)
        .map((item) => item.id);
    const goalAchieved = missingArtifacts.length === 0 &&
        requirements.length > 0 &&
        unsatisfiedRequirementIds.length === 0;

    return {
        generatedAt: new Date().toISOString(),
        status: goalAchieved ? 'achieved-scoped-rc-ready' : 'incomplete',
        goalAchieved,
        conclusion: goalAchieved
            ? 'Scoped RC readiness is complete: current image defaults and guarded V2 36 are releasable, while broad V2/video parity/new video defaults remain blocked or experimental.'
            : 'Release goal audit is incomplete; inspect missing artifacts or unsatisfied requirements.',
        artifacts,
        requirementCounts: {
            total: requirements.length,
            satisfied: requirements.filter((item) => item.satisfied === true).length,
            unsatisfied: unsatisfiedRequirementIds.length
        },
        unsatisfiedRequirementIds,
        requirements
    };
}

function renderBlockers(blockers = []) {
    return blockers.length ? blockers.join(', ') : '-';
}

export function renderReleaseGoalAuditMarkdown(report) {
    const lines = [];
    lines.push('# Release Goal Audit');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.status}`);
    lines.push(`Goal achieved: ${report.goalAchieved ? 'yes' : 'no'}`);
    lines.push(`Conclusion: ${report.conclusion}`);
    lines.push('');
    lines.push('## Artifacts');
    lines.push('');
    lines.push('| Artifact | Exists | Path | Error |');
    lines.push('|---|---:|---|---|');
    for (const [id, artifact] of Object.entries(report.artifacts || {})) {
        lines.push(`| ${id} | ${artifact.exists ? 'yes' : 'no'} | ${artifact.path || '-'} | ${artifact.error || '-'} |`);
    }
    lines.push('');
    lines.push('## Requirements');
    lines.push('');
    lines.push('| Requirement | Status | Blockers |');
    lines.push('|---|---|---|');
    for (const item of report.requirements || []) {
        lines.push(`| ${item.id} | ${item.status} | ${renderBlockers(item.blockers)} |`);
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

export async function writeReleaseGoalAuditReport({
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    inputs = DEFAULT_INPUTS
} = {}) {
    const report = await createReleaseGoalAuditReport({ inputs });
    const resolvedOutputPath = normalizePath(outputPath);
    const resolvedMarkdownPath = normalizePath(markdownPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(resolvedMarkdownPath, renderReleaseGoalAuditMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: resolvedOutputPath,
        markdownPath: resolvedMarkdownPath
    };
}

function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        inputs: { ...DEFAULT_INPUTS },
        failOnIncomplete: false
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--output') {
            parsed.outputPath = argv[++index] || parsed.outputPath;
        } else if (arg === '--markdown') {
            parsed.markdownPath = argv[++index] || parsed.markdownPath;
        } else if (arg === '--package-json') {
            parsed.inputs.packageJson = argv[++index] || parsed.inputs.packageJson;
        } else if (arg === '--readiness-report') {
            parsed.inputs.readinessReport = argv[++index] || parsed.inputs.readinessReport;
        } else if (arg === '--allenk-comparison-report') {
            parsed.inputs.allenkComparisonReport = argv[++index] || parsed.inputs.allenkComparisonReport;
        } else if (arg === '--fail-on-incomplete') {
            parsed.failOnIncomplete = true;
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
  node scripts/create-release-goal-audit-report.js [--output path] [--markdown path] [--fail-on-incomplete]
  node scripts/create-release-goal-audit-report.js --package-json package.json --readiness-report readiness.json --allenk-comparison-report allenk.json

Reads latest release readiness and allenk V2 comparison artifacts, then writes a goal-level audit report.
`);
}

async function main() {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }
    const report = await writeReleaseGoalAuditReport({
        outputPath: args.outputPath,
        markdownPath: args.markdownPath,
        inputs: args.inputs
    });
    console.log(`json: ${report.outputPath}`);
    console.log(`markdown: ${report.markdownPath}`);
    console.log(`status: ${report.status}`);
    console.log(`goal achieved: ${report.goalAchieved ? 'yes' : 'no'}`);
    if (args.failOnIncomplete && !report.goalAchieved) {
        console.error(`release goal audit blockers: ${renderBlockers(report.unsatisfiedRequirementIds)}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
