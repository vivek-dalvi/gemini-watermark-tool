import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createReleaseGoalAuditReport,
    renderReleaseGoalAuditMarkdown
} from '../../scripts/create-release-goal-audit-report.js';

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return filePath;
}

function releaseScripts() {
    return {
        'compare:allenk-v2': 'node scripts/create-allenk-v2-comparison-report.js',
        'release:image-validation': 'node scripts/run-image-release-validation.js',
        'release:image-evidence': 'node scripts/create-image-release-evidence.js',
        'release:image-quality-gate': 'node scripts/check-image-release-evidence.js',
        'release:readiness': 'node scripts/create-release-readiness-report.js',
        'release:quality-gate': 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready',
        'release:goal-audit': 'node scripts/create-release-goal-audit-report.js',
        'release:ci-check': 'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed',
        'release:preflight': 'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check'
    };
}

function capabilityRows() {
    return [
        { id: 'current-image-defaults', claimStatus: 'allowed' },
        { id: 'image-v2-36-small-profile', claimStatus: 'allowed-scoped' },
        { id: 'video-production-defaults', claimStatus: 'allowed-safety-only' },
        { id: 'video-review-delivery', claimStatus: 'review-only' },
        { id: 'video-denoise-default', claimStatus: 'experiment-only', forbiddenClaimActive: true, forbiddenClaim: 'new-video-denoise-default' },
        { id: 'video-alpha-shape-default', claimStatus: 'experiment-only', forbiddenClaimActive: true, forbiddenClaim: 'new-video-alpha-shape-default' },
        { id: 'broad-image-v2-coverage', claimStatus: 'forbidden', forbiddenClaimActive: true, forbiddenClaim: 'broad-image-v2-coverage' },
        { id: 'visible-residual-alpha-profile-productionization', claimStatus: 'forbidden', forbiddenClaimActive: true, forbiddenClaim: 'new-visible-residual-alpha-profile-productionization' },
        { id: 'video-v2-allenk-parity', claimStatus: 'forbidden', forbiddenClaimActive: true, forbiddenClaim: 'video-v2-allenk-parity' }
    ];
}

function readinessReport() {
    const activeForbiddenClaims = [
        'broad-image-v2-coverage',
        'new-visible-residual-alpha-profile-productionization',
        'video-v2-allenk-parity',
        'new-video-denoise-default',
        'new-video-alpha-shape-default'
    ];
    return {
        overall: {
            recommendation: 'rc-current-image-defaults-with-scoped-claims',
            releaseReadinessGate: { ok: true },
            releaseInvariantChecks: { ok: true },
            releaseDecisionSummary: { releaseClaimGuardsOk: true },
            releaseClaimMatrix: capabilityRows(),
            releaseEvidenceIndexIntegrity: { ok: true, blockers: [] },
            releaseEvidenceIndex: {
                requestedScope: 'image-defaults',
                imageQuality: {
                    status: 'current',
                    gateOk: true,
                    evidencePath: 'release/evidence/v1.2.3-image-quality.json',
                    blockers: []
                },
                releasePackage: {
                    version: '1.2.3',
                    zipPath: 'release/gemini-watermark-remover-extension-v1.2.3.zip',
                    sha256Path: 'release/gemini-watermark-remover-extension-v1.2.3.zip.sha256.txt',
                    latestExtensionPath: 'release/latest-extension.json',
                    sha256: 'a'.repeat(64),
                    hashMatchesMetadata: true,
                    hashMatchesShaFile: true,
                    sizeMatchesMetadata: true
                },
                claimPolicy: {
                    publicClaimScanStatus: 'clean',
                    publicClaimViolationCount: 0,
                    releaseDocsStatus: 'ready',
                    allowedCapabilityIds: ['current-image-defaults', 'image-v2-36-small-profile', 'video-production-defaults'],
                    reviewOnlyCapabilityIds: ['video-review-delivery'],
                    experimentOnlyCapabilityIds: ['video-denoise-default', 'video-alpha-shape-default'],
                    forbiddenCapabilityIds: ['broad-image-v2-coverage', 'visible-residual-alpha-profile-productionization', 'video-v2-allenk-parity'],
                    activeForbiddenClaims
                },
                allenkComparison: {
                    referenceStatus: 'current',
                    comparisonStatus: 'current-gap-known',
                    comparisonPath: '.artifacts/allenk-v2-comparison/latest-report.json',
                    canClaimImageV2SmallGuarded: true,
                    canClaimBroadImageV2Coverage: false,
                    canClaimVideoAllenkParity: false,
                    videoAllenkCaseCount: 15,
                    videoRenderedComparisonCount: 15,
                    videoMissingOutputArtifactCount: 0
                },
                imageScope: {
                    visibleResidualStatus: 'safe-to-release-current-defaults',
                    visibleResidualProductionAllowed: false,
                    readyForGoldMigration: false,
                    v2Status: 'guarded-release',
                    v2ReleaseEligible: true
                },
                videoScope: {
                    productionDefaultsStatus: 'safe-current-defaults',
                    defaultDenoiseBackend: 'none',
                    denoiseStatus: 'experiment-only',
                    denoisePromotedCount: 0,
                    alphaShapeStatus: 'experiment-only',
                    alphaShapePromotedCount: 0,
                    reviewDeliveryStatus: 'ready-for-visual-review',
                    reviewComparisonCount: 4
                }
            }
        },
        lanes: [
            { id: 'release-artifact', status: 'ready' },
            { id: 'userscript-artifact', status: 'ready' }
        ]
    };
}

function allenkReport(overrides = {}) {
    return {
        overall: {
            status: 'current-gap-known',
            ...overrides.overall
        },
        imageV2: {
            status: 'guarded-release'
        },
        videoBenchmark: {
            status: 'compared'
        }
    };
}

test('createReleaseGoalAuditReport should mark scoped RC objective achieved with current evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-goal-audit-'));
    const packageJson = await writeJson(path.join(tempDir, 'package.json'), { scripts: releaseScripts() });
    const readiness = await writeJson(path.join(tempDir, 'readiness.json'), readinessReport());
    const allenk = await writeJson(path.join(tempDir, 'allenk.json'), allenkReport());

    const report = await createReleaseGoalAuditReport({
        inputs: {
            packageJson,
            readinessReport: readiness,
            allenkComparisonReport: allenk
        }
    });

    assert.equal(report.goalAchieved, true);
    assert.equal(report.status, 'achieved-scoped-rc-ready');
    assert.equal(report.requirementCounts.total, 6);
    assert.equal(report.requirementCounts.satisfied, 6);
    assert.deepEqual(report.unsatisfiedRequirementIds, []);
    assert.deepEqual(report.requirements.map((item) => item.status), Array(6).fill('satisfied'));

    const markdown = renderReleaseGoalAuditMarkdown(report);
    assert.match(markdown, /Release Goal Audit/);
    assert.match(markdown, /Goal achieved: yes/);
    assert.match(markdown, /image-release-evidence-current \| satisfied/);
});

test('release goal audit CLI should fail when image evidence is stale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-goal-audit-fail-'));
    const packageJson = await writeJson(path.join(tempDir, 'package.json'), { scripts: releaseScripts() });
    const readinessValue = readinessReport();
    readinessValue.overall.releaseEvidenceIndex.imageQuality = {
        status: 'blocked',
        gateOk: false,
        evidencePath: 'release/evidence/v1.2.3-image-quality.json',
        blockers: ['image-evidence-source-hash-mismatch:x']
    };
    const readiness = await writeJson(path.join(tempDir, 'readiness.json'), readinessValue);
    const allenk = await writeJson(path.join(tempDir, 'allenk.json'), allenkReport({
        overall: { status: 'missing-evidence' }
    }));
    const output = path.join(tempDir, 'goal-audit.json');
    const markdown = path.join(tempDir, 'goal-audit.md');
    const result = spawnSync(process.execPath, [
        path.resolve('scripts/create-release-goal-audit-report.js'),
        '--output',
        output,
        '--markdown',
        markdown,
        '--package-json',
        packageJson,
        '--readiness-report',
        readiness,
        '--allenk-comparison-report',
        allenk,
        '--fail-on-incomplete'
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
            ...process.env,
            GWR_UNUSED: '1'
        }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /goal achieved: no/);

    const failedReport = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(failedReport.goalAchieved, false);
    assert.ok(failedReport.unsatisfiedRequirementIds.includes('image-release-evidence-current'));
});
