import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import {
    createReleaseReadinessReport,
    isCurrentImageCapabilityReady,
    renderReleaseReadinessMarkdown,
    summarizeImageReleaseEvidenceLane,
    summarizeReleaseInvariantChecks,
    summarizeReleaseReadinessGate
} from '../../scripts/create-release-readiness-report.js';

test('image-defaults scope depends on pinned image evidence instead of historical research lanes', () => {
    const lanes = [
        { id: 'release-claims', releaseEligible: true },
        { id: 'userscript-artifact', releaseEligible: true },
        { id: 'release-version-docs', releaseEligible: true },
        { id: 'image-release-evidence', releaseEligible: true },
        { id: 'video-production-defaults', releaseEligible: true },
        { id: 'image-visible-residual', releaseEligible: false },
        { id: 'image-v2-36', releaseEligible: false },
        { id: 'allenk-reference', releaseEligible: false },
        { id: 'allenk-v2-comparison', releaseEligible: false }
    ];

    assert.equal(isCurrentImageCapabilityReady(lanes, 'image-defaults'), true);
    assert.equal(isCurrentImageCapabilityReady(lanes, null), false);
});

test('summarizeImageReleaseEvidenceLane exposes current and stale gate results', () => {
    assert.deepEqual(summarizeImageReleaseEvidenceLane({ ok: true, blockers: [] }, 'evidence.json'), {
        id: 'image-release-evidence',
        title: 'Image release evidence',
        status: 'current',
        releaseEligible: true,
        blockers: [],
        evidence: { path: 'evidence.json', gateOk: true }
    });
    assert.deepEqual(
        summarizeImageReleaseEvidenceLane({ ok: false, blockers: ['image-evidence-source-hash-mismatch:x'] }, 'bad.json').blockers,
        ['image-evidence-source-hash-mismatch:x']
    );
});

async function writeJson(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createProjectTempDir(prefix) {
    const root = path.join(process.cwd(), '.artifacts', 'test-tmp');
    await mkdir(root, { recursive: true });
    return mkdtemp(path.join(root, prefix));
}

async function writeFailingGitShim(tempDir) {
    const binDir = path.join(tempDir, 'bin');
    await mkdir(binDir, { recursive: true });
    if (process.platform === 'win32') {
        const gitCmd = path.join(binDir, 'git.cmd');
        await writeFile(gitCmd, '@echo off\r\nexit /b 1\r\n', 'utf8');
        return binDir;
    }
    const gitPath = path.join(binDir, 'git');
    await writeFile(gitPath, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(gitPath, 0o755);
    return binDir;
}

function releaseGateScripts(overrides = {}) {
    return {
        'compare:allenk-v2': 'node scripts/create-allenk-v2-comparison-report.js',
        'release:image-validation': 'node scripts/run-image-release-validation.js',
        'release:image-evidence': 'node scripts/create-image-release-evidence.js',
        'release:image-quality-gate': 'node scripts/check-image-release-evidence.js',
        'release:readiness': 'node scripts/create-release-readiness-report.js',
        'release:quality-gate': 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready',
        'release:goal-audit': 'node scripts/create-release-goal-audit-report.js',
        'release:ci-check': 'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed',
        'release:preflight': 'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check',
        ...overrides
    };
}

async function createSourceArtifactProvenance(id, filePath) {
    try {
        const text = await readFile(filePath, 'utf8');
        return {
            id,
            path: filePath,
            exists: true,
            sha256: createHash('sha256').update(text).digest('hex'),
            mtimeUtc: '2026-06-11T00:00:00.000Z',
            error: null
        };
    } catch (error) {
        return {
            id,
            path: filePath,
            exists: false,
            sha256: null,
            mtimeUtc: null,
            error: error?.message || String(error)
        };
    }
}

async function writeReleaseArtifact(releaseDir, extensionFile, content = 'zip') {
    await mkdir(releaseDir, { recursive: true });
    const buffer = Buffer.from(content);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    await writeFile(path.join(releaseDir, extensionFile), buffer);
    await writeFile(path.join(releaseDir, `${extensionFile}.sha256.txt`), `${sha256}  ${extensionFile}\n`, 'utf8');
    await writeJson(path.join(releaseDir, 'latest-extension.json'), {
        version: '1.2.3',
        file: extensionFile,
        sha256,
        size: buffer.length
    });
    return { sha256, size: buffer.length };
}

async function writeSafeReleaseClaimFile(tempDir) {
    const claimFile = path.join(tempDir, 'README.md');
    await writeFile(claimFile, 'Gemini image watermark removal for supported image outputs.\n', 'utf8');
    return [claimFile];
}

async function writeUserscriptArtifact(tempDir, version = '1.2.3') {
    const userscriptPath = path.join(tempDir, 'dist', 'userscript', 'gemini-watermark-remover.user.js');
    await mkdir(path.dirname(userscriptPath), { recursive: true });
    await writeFile(userscriptPath, `// ==UserScript==
// @name         Gemini NanoBanana Watermark Remover
// @version      ${version}
// @downloadURL  https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js
// @updateURL    https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js
// ==/UserScript==
const DEFAULT_DOWNLOAD_STICKY_WINDOW_MS = 30000;
let downloadStickyUntil = 0;
function getActionContextFromIntentGate(intentGate = null, candidate = null) {
  return intentGate || candidate;
}
`, 'utf8');
    return userscriptPath;
}

async function writeVideoProductionSourceFiles(tempDir, {
    defaultDenoiseBackend = 'none',
    defaultTextureRepair = false,
    defaultHighQualityCleanup = false,
    markReviewPreset = true
} = {}) {
    const sourceDir = path.join(tempDir, 'src');
    const videoDir = path.join(sourceDir, 'video');
    const cleanupPath = path.join(videoDir, 'videoCleanupBackends.js');
    const appPath = path.join(sourceDir, 'video-app.js');
    const presetPath = path.join(videoDir, 'videoPresetPolicy.js');
    await mkdir(videoDir, { recursive: true });
    await writeFile(cleanupPath, `
const DEFAULT_HIGH_QUALITY_CLEANUP = ${defaultHighQualityCleanup};
const DEFAULT_TEXTURE_REPAIR = ${defaultTextureRepair};
const DEFAULT_DENOISE_BACKEND = '${defaultDenoiseBackend}';
const VIDEO_DENOISE_BACKENDS = Object.freeze({
  NONE: 'none',
  CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE: 'canvas-temporal-match-delta-stabilize'
});
`, 'utf8');
    await writeFile(appPath, `
function init() {
  els.denoiseBackend.value = Object.values(VIDEO_DENOISE_BACKENDS).includes(DEFAULT_DENOISE_BACKEND)
    ? DEFAULT_DENOISE_BACKEND
    : VIDEO_DENOISE_BACKENDS.NONE;
}
async function runExport() {
  return removeGeminiVideoWatermark(state.file, {
    denoiseBackend: els.denoiseBackend.value || DEFAULT_DENOISE_BACKEND
  });
}
function maybeApplyRelocatedReviewPreset() {
  setStatus('${markReviewPreset ? '已应用迁移锚点复核预设。此预设用于人工复核，不是默认策略。' : '已应用迁移锚点预设。'}');
}
`, 'utf8');
    await writeFile(presetPath, `
function getRelocatedReviewPresetConfig() {
  return {
    denoiseBackend: VIDEO_DENOISE_BACKENDS.CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE
  };
}
`, 'utf8');
    return {
        videoCleanupBackendsSource: cleanupPath,
        videoAppSource: appPath,
        videoPresetPolicySource: presetPath
    };
}

async function writeVideoDeliveryArtifacts(tempDir, {
    ready = true,
    comparisonCount = 4
} = {}) {
    const deliveryPath = path.join(tempDir, 'video-delivery', 'latest-delivery-report.json');
    const reviewPackPath = path.join(tempDir, 'video-review-pack', 'latest-review-pack.json');
    await writeJson(deliveryPath, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        status: ready ? 'ready-for-visual-review' : 'blocked',
        ready,
        blockers: ready ? [] : ['video-gate-missing-promote-default-candidate'],
        benchmark: { total: 4, rendered: 4, renderedComparison: 4, failed: 0 },
        gate: {
            bestCandidate: {
                profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                decision: ready ? 'promote-default-candidate' : 'human-review',
                improvedCases: 2,
                materialFailureLayers: 0,
                warningLayers: ready ? 0 : 1
            }
        },
        temporal: {
            status: ready ? 'pass' : 'blocked',
            blockers: ready ? [] : ['case-a:same-jitter-regression'],
            warnings: [],
            comparisons: [
                {
                    baselineId: 'deaee69b',
                    candidateId: 'deaee69b-auto-relocated',
                    delta: {
                        meanSameJitter: 0.1581,
                        meanMatchedJitter: 0.0789,
                        worsenedRatio: -0.0235
                    }
                }
            ]
        }
    });
    await writeJson(reviewPackPath, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        delivery: {
            status: ready ? 'ready-for-visual-review' : 'blocked',
            ready
        },
        comparisons: comparisonCount > 0
            ? [
                { caseId: 'deaee69b', kind: 'full', outputPath: 'deaee69b-full-4up.mp4' },
                { caseId: 'deaee69b', kind: 'roi', outputPath: 'deaee69b-roi-4up.mp4' },
                { caseId: 'e1997e6e', kind: 'full', outputPath: 'e1997e6e-full-4up.mp4' },
                { caseId: 'e1997e6e', kind: 'roi', outputPath: 'e1997e6e-roi-4up.mp4' }
            ].slice(0, comparisonCount)
            : []
    });
    return {
        videoDeliveryGate: deliveryPath,
        videoReviewPack: reviewPackPath
    };
}

async function writeReleaseVersionDocs(tempDir, version = '1.2.3') {
    const changelogEn = path.join(tempDir, 'CHANGELOG.md');
    const changelogZh = path.join(tempDir, 'CHANGELOG_zh.md');
    const releaseEn = path.join(tempDir, 'RELEASE.md');
    const releaseZh = path.join(tempDir, 'RELEASE_zh.md');
    await writeFile(changelogEn, `# Changelog\n\n## ${version} - 2026-06-11\n\n- Ready.\n`, 'utf8');
    await writeFile(changelogZh, `# 更新日志\n\n## ${version} - 2026-06-11\n\n- Ready.\n`, 'utf8');
    await writeFile(
        releaseEn,
        'Update CHANGELOG.md and CHANGELOG_zh.md. Run pnpm release:preflight, which runs pnpm package:extension, pnpm release:quality-gate, pnpm release:goal-audit -- --fail-on-incomplete, and pnpm release:ci-check; the quality gate runs pnpm release:image-quality-gate and the internal comparison gate before pnpm release:readiness -- --scope image-defaults --fail-on-not-ready, then the CI check verifies GitHub Actions CI for the current HEAD before upload latest-extension.json. Follow the Release Claim Matrix: publish allowed, allowed-scoped, and allowed-safety-only rows; keep review-only, experiment-only, and forbidden rows out of public capability claims.\n',
        'utf8'
    );
    await writeFile(
        releaseZh,
        '更新 CHANGELOG.md 和 CHANGELOG_zh.md。运行 pnpm release:preflight；它会运行 pnpm package:extension、pnpm release:quality-gate、pnpm release:goal-audit -- --fail-on-incomplete 和 pnpm release:ci-check；该 quality gate 会先运行 pnpm release:image-quality-gate 和内部对比 gate，再运行 pnpm release:readiness -- --scope image-defaults --fail-on-not-ready；随后 CI 检查会确认当前 HEAD 的 GitHub Actions CI 已通过，再上传 latest-extension.json。遵循 Release Claim Matrix：只发布 allowed、allowed-scoped 和 allowed-safety-only 行；review-only、experiment-only 和 forbidden 行不能写成公开能力声明。\n',
        'utf8'
    );
    return {
        changelogEn,
        changelogZh,
        releaseEn,
        releaseZh
    };
}

async function writeAllenkV2Comparison(tempDir, {
    comparisonEvidenceReady = true,
    canClaimVideoAllenkParity = false,
    imageV2Evidence = {},
    videoEvidence = {},
    allenkLocalHead = '632348868da0653d5c1e99680d2c448f4d8505eb',
    allenkRemoteHead = '632348868da0653d5c1e99680d2c448f4d8505eb'
} = {}) {
    const comparisonPath = path.join(tempDir, 'allenk-v2-comparison.json');
    const imageV2Summary = path.join(tempDir, 'v2-summary.json');
    const videoCropBenchmark = path.join(tempDir, 'allenk-v2-video-crop-benchmark.json');
    const videoDenoiseGate = path.join(tempDir, 'video-denoise.json');
    const videoAlphaShapeGate = path.join(tempDir, 'alpha-gates', 'candidate-a', 'latest-report.json');
    const comparisonScript = path.join(tempDir, 'create-allenk-v2-comparison-report.js');
    await writeFile(comparisonScript, 'export {};\n', 'utf8');
    await writeJson(imageV2Summary, {
        summary: {
            total: 189,
            applied: 152,
            pass: 66,
            residual: 86,
            v2Selected: imageV2Evidence.v2Selected ?? 1,
            v2Cleanup: imageV2Evidence.v2Cleanup ?? 1
        },
        v2Records: [
            {
                file: '2026-06-09/sample.png',
                bucket: 'pass',
                applied: true,
                config: { logoSize: 36, marginRight: 71, marginBottom: 71, alphaVariant: 'v2' }
            }
        ]
    });
    await writeJson(videoCropBenchmark, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        results: []
    });
    await writeJson(videoDenoiseGate, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        candidates: []
    });
    await writeJson(videoAlphaShapeGate, {
        result: {
            promotedCount: 0,
            rejectedByVideoCount: 1,
            topCandidates: []
        }
    });
    const sourceArtifacts = await Promise.all([
        createSourceArtifactProvenance('allenk-v2-comparison-script', comparisonScript),
        createSourceArtifactProvenance('image-v2-summary', imageV2Summary),
        createSourceArtifactProvenance('video-crop-benchmark', videoCropBenchmark),
        createSourceArtifactProvenance('video-denoise-gate', videoDenoiseGate),
        createSourceArtifactProvenance('video-alpha-shape:candidate-a', videoAlphaShapeGate)
    ]);
    await writeJson(comparisonPath, {
        generatedAt: '2026-06-11T00:00:00.000Z',
        inputs: {
            videoCropBenchmark
        },
        provenance: {
            sourceArtifacts: sourceArtifacts.filter((item) => item.exists)
        },
        allenkReference: {
            status: allenkLocalHead === allenkRemoteHead ? 'current' : 'needs-refresh',
            blockers: [],
            repoPath: path.join(tempDir, 'GeminiWatermarkTool'),
            localHead: allenkLocalHead,
            remoteHead: allenkRemoteHead
        },
        overall: {
            status: comparisonEvidenceReady ? 'current-gap-known' : 'missing-evidence',
            comparisonEvidenceReady,
            canClaimImageV2SmallGuarded: true,
            canClaimBroadImageV2Coverage: false,
            canClaimVideoAllenkParity,
            blockedClaims: canClaimVideoAllenkParity
                ? ['broad-image-v2-coverage']
                : ['video-v2-allenk-parity', 'broad-image-v2-coverage']
        },
        imageV2: {
            status: 'guarded-release',
            knownGaps: ['v2-36-core-gray-shadow-needs-render-composite-model'],
            evidence: {
                v2Selected: imageV2Evidence.v2Selected ?? 1,
                v2Cleanup: imageV2Evidence.v2Cleanup ?? 1,
                v2RecordCount: imageV2Evidence.v2RecordCount ?? 1,
                passingCleanupRecordCount: imageV2Evidence.passingCleanupRecordCount ?? 1
            }
        },
        videoBenchmark: {
            status: comparisonEvidenceReady ? 'compared' : 'incomplete',
            evidence: {
                allenkCaseCount: comparisonEvidenceReady ? 3 : 0,
                renderedComparisonCount: comparisonEvidenceReady ? 3 : 0,
                missingOutputArtifactCount: videoEvidence.missingOutputArtifactCount ?? 0,
                cases: videoEvidence.cases || (comparisonEvidenceReady
                    ? [{ id: 'case-a' }, { id: 'case-b' }, { id: 'case-c' }]
                    : []),
                meanCurrentVsAllenkMeanAbs: comparisonEvidenceReady ? 2.9 : null,
                meanOriginalVsAllenkMeanAbs: comparisonEvidenceReady ? 5.2 : null
            }
        }
    });
    return comparisonPath;
}

test('createReleaseReadinessReport should allow scoped image RC while blocking video parity claims', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-'));
    const releaseDir = path.join(tempDir, 'release');
    const latestExtensionPath = path.join(releaseDir, 'latest-extension.json');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir);
    const videoProductionSources = await writeVideoProductionSourceFiles(tempDir);
    const videoDeliveryArtifacts = await writeVideoDeliveryArtifacts(tempDir);

    const visibleDir = path.join(tempDir, 'visible');
    await writeJson(path.join(visibleDir, 'loop-summary.json'), {
        summary: {
            readyForGoldMigration: false,
            unconfirmedCount: 30,
            structuralErrorCount: 0,
            productionProfileAllowed: false,
            productionGateContractReady: true,
            packageScriptGateReady: true,
            productionHitCount: 0,
            productionArtifactHitCount: 0
        }
    });
    await writeJson(path.join(visibleDir, 'goal-audit-report.json'), {
        summary: {
            readyForGoldMigration: false,
            productionProfileAllowed: false
        }
    });
    await writeJson(path.join(visibleDir, 'algorithm-admission-report.json'), {
        humanGate: { readyForGoldMigration: false },
        productionProfileAdmission: {
            allowed: false,
            blockedReasons: ['human-review-not-ready-for-gold-migration']
        },
        summary: { currentState: 'human-gated-blocked' }
    });

    await writeJson(path.join(tempDir, 'v2-summary.json'), {
        summary: {
            total: 189,
            applied: 152,
            skipped: 37,
            pass: 66,
            residual: 86,
            v2Selected: 1,
            v2Cleanup: 1
        },
        v2Records: [
            {
                file: '2026-06-09/sample.png',
                bucket: 'pass',
                config: { logoSize: 36, marginRight: 71, marginBottom: 71, alphaVariant: 'v2' },
                detection: { processedSpatialScore: 0.058, processedGradientScore: -0.051 },
                source: 'standard+catalog+validated+v2-small-edge-cleanup'
            }
        ]
    });

    await writeJson(path.join(tempDir, 'video-denoise.json'), {
        generatedAt: '2026-06-11T00:00:00.000Z',
        requiredLayerCount: 3,
        layers: [{ id: 'video-benchmark:standard/latest-summary' }],
        candidates: [
            { profileLabel: 'canvas-edge-denoise, strength=0.65', decision: 'reject' },
            { profileLabel: 'none, alphaEdgePolicy=standard045-inset035', decision: 'insufficient-evidence' }
        ]
    });

    const alphaRoot = path.join(tempDir, 'alpha-gates');
    await writeJson(path.join(alphaRoot, 'candidate-a', 'latest-report.json'), {
        result: {
            totalCommonCandidates: 10,
            promotedCount: 0,
            rejectedByVideoCount: 1,
            topCandidates: [
                {
                    name: 'candidate-a',
                    fitGate: { verdict: 'fit-pass' },
                    videoGate: {
                        verdict: 'rejected-video-regression',
                        regressions: [{ bucket: 'active' }]
                    }
                }
            ]
        }
    });
    const allenkRepo = path.join(tempDir, 'GeminiWatermarkTool');
    await mkdir(allenkRepo, { recursive: true });

    const report = await createReleaseReadinessReport({
        scope: 'image-defaults',
        inputs: {
            imageReleaseEvidence: path.join(tempDir, 'image-evidence.json'),
            imageEvidenceGate: { ok: true, blockers: [] },
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: latestExtensionPath,
            userscript,
            visibleResidualLoopSummary: path.join(visibleDir, 'loop-summary.json'),
            visibleResidualGoalAudit: path.join(visibleDir, 'goal-audit-report.json'),
            visibleResidualAdmission: path.join(visibleDir, 'algorithm-admission-report.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo,
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles,
            releaseVersionDocs,
            ...videoDeliveryArtifacts,
            ...videoProductionSources
        }
    });

    assert.equal(report.overall.recommendation, 'rc-current-image-defaults-with-scoped-claims');
    assert.equal(report.overall.currentImageCapabilityReady, true);
    assert.equal(report.overall.canReleaseCurrentImageDefaults, true);
    assert.equal(report.overall.canClaimVideoV2Parity, false);
    assert.equal(report.overall.releaseInvariantChecks.ok, true);
    assert.deepEqual(report.overall.releaseInvariantChecks.missingBlockedClaims, []);
    assert.deepEqual(report.overall.releaseInvariantChecks.missingReleaseClaimGuards, []);
    assert.ok(report.overall.blockedClaims.includes('video-v2-allenk-parity'));
    assert.equal(report.releaseScope, 'image-defaults');
    assert.equal(report.lanes.find((lane) => lane.id === 'image-release-evidence').releaseEligible, true);

    const visibleLane = report.lanes.find((lane) => lane.id === 'image-visible-residual');
    assert.equal(visibleLane.releaseEligible, true);
    assert.ok(visibleLane.blockers.includes('visible-residual-human-review-incomplete'));
    assert.equal(visibleLane.evidence.readyForGoldMigration, false);
    assert.equal(visibleLane.evidence.unconfirmedCount, 30);
    assert.equal(visibleLane.evidence.productionHitCount, 0);
    assert.equal(visibleLane.evidence.productionArtifactHitCount, 0);
    assert.deepEqual(visibleLane.evidence.admissionBlockedReasons, [
        'human-review-not-ready-for-gold-migration'
    ]);

    const denoiseLane = report.lanes.find((lane) => lane.id === 'video-denoise-v2');
    assert.equal(denoiseLane.releaseEligible, false);
    assert.ok(denoiseLane.blockers.includes('video-denoise-no-promoted-default-candidate'));

    const videoProductionLane = report.lanes.find((lane) => lane.id === 'video-production-defaults');
    assert.equal(videoProductionLane.status, 'safe-current-defaults');
    assert.equal(videoProductionLane.releaseEligible, true);
    assert.equal(videoProductionLane.evidence.defaultDenoiseBackend, 'none');
    assert.equal(videoProductionLane.evidence.reviewPresetMarkedReviewOnly, true);

    const videoReviewLane = report.lanes.find((lane) => lane.id === 'video-review-delivery');
    assert.equal(videoReviewLane.status, 'ready-for-visual-review');
    assert.equal(videoReviewLane.releaseEligible, true);
    assert.equal(videoReviewLane.evidence.reviewComparisonCount, 4);
    assert.equal(videoReviewLane.evidence.temporalStatus, 'pass');
    assert.equal(videoReviewLane.evidence.temporalComparisons.length, 1);
    assert.equal(videoReviewLane.evidence.temporalComparisons[0].candidateId, 'deaee69b-auto-relocated');
    assert.deepEqual(videoReviewLane.evidence.reviewViews.sort(), ['full', 'roi']);

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'current-gap-known');
    assert.equal(allenkV2Lane.releaseEligible, true);
    assert.equal(allenkV2Lane.evidence.canClaimVideoAllenkParity, false);

    const releaseLane = report.lanes.find((lane) => lane.id === 'release-artifact');
    assert.equal(releaseLane.evidence.releaseGoalAuditScriptReady, true);
    assert.equal(releaseLane.evidence.releasePreflightScriptReady, true);

    const decisions = Object.fromEntries(
        report.overall.capabilityDecisions.map((decision) => [decision.id, decision])
    );
    assert.equal(decisions['current-image-defaults'].decision, 'release');
    assert.equal(decisions['image-v2-36-small-profile'].decision, 'guarded-release');
    assert.equal(decisions['broad-image-v2-coverage'].decision, 'blocked');
    assert.equal(decisions['visible-residual-alpha-profile-productionization'].decision, 'blocked');
    assert.equal(decisions['video-production-defaults'].decision, 'safe-current-defaults');
    assert.equal(decisions['video-review-delivery'].decision, 'ready-for-visual-review');
    assert.equal(decisions['video-v2-allenk-parity'].decision, 'blocked');
    assert.equal(decisions['video-denoise-default'].decision, 'experiment-only');
    assert.equal(decisions['video-alpha-shape-default'].decision, 'experiment-only');
    assert.equal(decisions['visible-residual-alpha-profile-productionization'].evidence.productionChangeAllowed, false);

    assert.equal(
        report.overall.releaseDecisionSummary.currentReleaseScope,
        'current-image-defaults-and-guarded-v2-36-only'
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.releaseNow.map((decision) => decision.id),
        ['current-image-defaults']
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.guardedRelease.map((decision) => decision.id),
        ['image-v2-36-small-profile']
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.safeCurrentDefaults.map((decision) => decision.id),
        ['video-production-defaults']
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.visualReviewOnly.map((decision) => decision.id),
        ['video-review-delivery']
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.experimentOnly.map((decision) => decision.id),
        ['video-denoise-default', 'video-alpha-shape-default']
    );
    assert.deepEqual(
        report.overall.releaseDecisionSummary.blocked.map((decision) => decision.id),
        [
            'broad-image-v2-coverage',
            'visible-residual-alpha-profile-productionization',
            'video-v2-allenk-parity'
        ]
    );
    assert.equal(report.overall.releaseDecisionSummary.releaseClaimGuardsOk, true);
    assert.ok(report.overall.releaseDecisionSummary.forbiddenClaims.includes('video-v2-allenk-parity'));
    const claimMatrix = Object.fromEntries(report.overall.releaseClaimMatrix.map((item) => [item.id, item]));
    assert.equal(claimMatrix['current-image-defaults'].claimStatus, 'allowed');
    assert.equal(claimMatrix['image-v2-36-small-profile'].claimStatus, 'allowed-scoped');
    assert.equal(claimMatrix['video-production-defaults'].claimStatus, 'allowed-safety-only');
    assert.equal(claimMatrix['video-review-delivery'].claimStatus, 'review-only');
    assert.equal(claimMatrix['video-denoise-default'].claimStatus, 'experiment-only');
    assert.equal(claimMatrix['video-denoise-default'].forbiddenClaimActive, true);
    assert.equal(claimMatrix['video-alpha-shape-default'].forbiddenClaimActive, true);
    assert.equal(claimMatrix['broad-image-v2-coverage'].forbiddenClaimActive, true);
    assert.equal(claimMatrix['visible-residual-alpha-profile-productionization'].forbiddenClaimActive, true);
    assert.equal(claimMatrix['video-v2-allenk-parity'].forbiddenClaimActive, true);

    assert.equal(report.overall.releaseEvidenceIndex.recommendation, 'rc-current-image-defaults-with-scoped-claims');
    assert.equal(report.overall.releaseEvidenceIndex.gateOk, true);
    assert.equal(
        report.overall.releaseEvidenceIndex.releaseScope,
        'current-image-defaults-and-guarded-v2-36-only'
    );
    assert.equal(report.overall.releaseEvidenceIndex.releasePackage.version, '1.2.3');
    assert.match(report.overall.releaseEvidenceIndex.releasePackage.zipPath, /gemini-watermark-remover-extension-v1\.2\.3\.zip$/);
    assert.equal(report.overall.releaseEvidenceIndex.releasePackage.hashMatchesMetadata, true);
    assert.equal(report.overall.releaseEvidenceIndex.releasePackage.hashMatchesShaFile, true);
    assert.equal(report.overall.releaseEvidenceIndex.claimPolicy.publicClaimScanStatus, 'clean');
    assert.equal(report.overall.releaseEvidenceIndex.claimPolicy.publicClaimViolationCount, 0);
    assert.deepEqual(report.overall.releaseEvidenceIndex.claimPolicy.allowedCapabilityIds, [
        'current-image-defaults',
        'image-v2-36-small-profile',
        'video-production-defaults'
    ]);
    assert.deepEqual(report.overall.releaseEvidenceIndex.claimPolicy.reviewOnlyCapabilityIds, [
        'video-review-delivery'
    ]);
    assert.deepEqual(report.overall.releaseEvidenceIndex.claimPolicy.experimentOnlyCapabilityIds, [
        'video-denoise-default',
        'video-alpha-shape-default'
    ]);
    assert.deepEqual(report.overall.releaseEvidenceIndex.claimPolicy.forbiddenCapabilityIds, [
        'broad-image-v2-coverage',
        'visible-residual-alpha-profile-productionization',
        'video-v2-allenk-parity'
    ]);
    assert.equal(report.overall.releaseEvidenceIndex.allenkComparison.videoAllenkCaseCount, 3);
    assert.equal(report.overall.releaseEvidenceIndex.allenkComparison.videoRenderedComparisonCount, 3);
    assert.equal(report.overall.releaseEvidenceIndex.imageScope.readyForGoldMigration, false);
    assert.equal(report.overall.releaseEvidenceIndex.videoScope.defaultDenoiseBackend, 'none');
    assert.equal(report.overall.releaseEvidenceIndex.videoScope.reviewComparisonCount, 4);
    assert.equal(report.overall.releaseEvidenceIndexIntegrity.ok, true);
    assert.deepEqual(report.overall.releaseEvidenceIndexIntegrity.blockers, []);
    assert.equal(report.overall.releaseEvidenceIndexIntegrity.matrixRowCount, report.overall.releaseClaimMatrix.length);
    assert.equal(report.overall.releaseEvidenceIndexIntegrity.indexedCapabilityCount, report.overall.releaseClaimMatrix.length);
    assert.deepEqual(report.overall.releaseEvidenceIndexIntegrity.missingIndexedCapabilityIds, []);
    assert.deepEqual(report.overall.releaseEvidenceIndexIntegrity.extraIndexedCapabilityIds, []);
    assert.deepEqual(report.overall.releaseEvidenceIndexIntegrity.missingActiveForbiddenClaims, []);
    assert.deepEqual(report.overall.releaseEvidenceIndexIntegrity.extraActiveForbiddenClaims, []);

    assert.deepEqual(
        report.provenance.sourceArtifacts.map((item) => item.id),
        ['release-readiness-script']
    );
    assert.equal(report.provenance.sourceArtifacts[0].exists, true);
    assert.match(report.provenance.sourceArtifacts[0].sha256, /^[a-f0-9]{64}$/);

    const releaseGate = summarizeReleaseReadinessGate(report);
    assert.equal(releaseGate.ok, true);
    assert.deepEqual(releaseGate.blockers, []);
    assert.deepEqual(report.overall.releaseReadinessGate, releaseGate);
});

test('summarizeReleaseInvariantChecks should catch blocked capabilities without matching claims', () => {
    const invariantChecks = summarizeReleaseInvariantChecks({
        blockedClaims: ['video-v2-allenk-parity'],
        capabilityDecisions: [
            {
                id: 'broad-image-v2-coverage',
                decision: 'blocked'
            },
            {
                id: 'video-v2-allenk-parity',
                decision: 'blocked'
            },
            {
                id: 'unknown-default-capability',
                decision: 'experiment-only'
            }
        ]
    });

    assert.equal(invariantChecks.ok, false);
    assert.deepEqual(invariantChecks.missingBlockedClaims, [
        {
            capability: 'broad-image-v2-coverage',
            blockedClaim: 'broad-image-v2-coverage'
        }
    ]);
    assert.deepEqual(invariantChecks.unregisteredBlockedCapabilities, ['unknown-default-capability']);
});

test('summarizeReleaseReadinessGate should fail reports that still require rebuild or cleanup', () => {
    const gate = summarizeReleaseReadinessGate({
        overall: {
            recommendation: 'rc-current-image-defaults-after-rebuild',
            canReleaseCurrentImageDefaults: false,
            releaseInvariantChecks: { ok: true },
            releaseDecisionSummary: {
                releaseClaimGuardsOk: true
            }
        }
    });

    assert.equal(gate.ok, false);
    assert.equal(gate.actualRecommendation, 'rc-current-image-defaults-after-rebuild');
    assert.ok(gate.blockers.includes('release-recommendation-not-immediately-releasable'));
    assert.ok(gate.blockers.includes('current-image-defaults-not-releasable'));
});

test('summarizeReleaseReadinessGate should fail when release evidence index integrity fails', () => {
    const gate = summarizeReleaseReadinessGate({
        overall: {
            recommendation: 'rc-current-image-defaults-with-scoped-claims',
            canReleaseCurrentImageDefaults: true,
            releaseInvariantChecks: { ok: true },
            releaseDecisionSummary: {
                releaseClaimGuardsOk: true
            },
            releaseEvidenceIndexIntegrity: {
                ok: false,
                blockers: ['release-evidence-index-capability-missing']
            }
        }
    });

    assert.equal(gate.ok, false);
    assert.deepEqual(gate.blockers, ['release-evidence-index-integrity-failed']);
});

test('release readiness CLI should exit non-zero with --fail-on-not-ready when evidence is missing', async () => {
    const tempDir = await createProjectTempDir('release-readiness-cli-');
    const fakeGitBin = await writeFailingGitShim(tempDir);
    const reportPath = path.join(tempDir, 'report.json');
    const markdownPath = path.join(tempDir, 'report.md');
    const scriptPath = path.resolve('scripts/create-release-readiness-report.js');

    const result = spawnSync(process.execPath, [
        scriptPath,
        '--output',
        reportPath,
        '--markdown',
        markdownPath,
        '--fail-on-not-ready'
    ], {
        cwd: tempDir,
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${fakeGitBin}${path.delimiter}${process.env.PATH || ''}`
        }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /recommendation: not-ready-for-release/);
    assert.match(result.stdout, /release quality gate: fail/);
    assert.match(result.stderr, /release quality gate blockers:/);

    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.overall.recommendation, 'not-ready-for-release');
    assert.equal(report.overall.releaseDecisionSummary.currentReleaseScope, 'not-ready');
});

test('createReleaseReadinessReport should block unsafe video production defaults', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-video-defaults-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir);
    const videoProductionSources = await writeVideoProductionSourceFiles(tempDir, {
        defaultDenoiseBackend: 'canvas-edge-denoise'
    });

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript,
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles,
            releaseVersionDocs,
            ...videoProductionSources
        }
    });

    const videoProductionLane = report.lanes.find((lane) => lane.id === 'video-production-defaults');
    assert.equal(videoProductionLane.status, 'blocked');
    assert.equal(videoProductionLane.releaseEligible, false);
    assert.equal(videoProductionLane.evidence.defaultDenoiseBackend, 'canvas-edge-denoise');
    assert.ok(videoProductionLane.blockers.includes('video-default-denoise-backend-not-none'));
    assert.ok(report.overall.blockedClaims.includes('video-production-defaults-unsafe'));

    const decisions = Object.fromEntries(
        report.overall.capabilityDecisions.map((decision) => [decision.id, decision])
    );
    assert.equal(decisions['video-production-defaults'].decision, 'blocked');
    assert.equal(decisions['video-denoise-default'].decision, 'blocked');
});

test('createReleaseReadinessReport should block an incorrect release quality gate script', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-quality-gate-script-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts({
            'release:quality-gate': 'pnpm release:readiness && pnpm compare:allenk-v2'
        })
    });
    await writeReleaseArtifact(releaseDir, extensionFile);

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: path.join(tempDir, 'missing-comparison.json'),
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const releaseLane = report.lanes.find((lane) => lane.id === 'release-artifact');
    assert.equal(releaseLane.evidence.releaseQualityGateScriptReady, false);
    assert.ok(releaseLane.blockers.includes('release-quality-gate-script-missing'));
});

test('createReleaseReadinessReport should block stale allenk V2 comparison evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-stale-allenk-v2-'));
    const comparisonPath = await writeAllenkV2Comparison(tempDir);
    const comparisonScriptPath = path.join(tempDir, 'create-allenk-v2-comparison-report.js');
    const v2SummaryPath = path.join(tempDir, 'v2-summary.json');
    const videoCropBenchmarkPath = path.join(tempDir, 'allenk-v2-video-crop-benchmark.json');
    const videoDenoisePath = path.join(tempDir, 'video-denoise.json');
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    const alphaReportPath = path.join(alphaRoot, 'candidate-a', 'latest-report.json');
    await writeJson(v2SummaryPath, {
        summary: { total: 1, v2Selected: 1, v2Cleanup: 1 }
    });
    await writeFile(comparisonScriptPath, 'export {};\n', 'utf8');
    await writeJson(videoDenoisePath, {
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    await writeJson(alphaReportPath, {
        result: {
            promotedCount: 0,
            rejectedByVideoCount: 0,
            topCandidates: []
        }
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: v2SummaryPath,
            videoDenoiseGate: videoDenoisePath,
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: comparisonScriptPath,
            allenkV2MtimeOverrides: {
                [comparisonPath]: Date.parse('2026-06-11T00:00:00.000Z'),
                [comparisonScriptPath]: Date.parse('2026-06-11T00:06:00.000Z'),
                [v2SummaryPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [videoDenoisePath]: Date.parse('2026-06-11T00:01:00.000Z'),
                [alphaReportPath]: Date.parse('2026-06-11T00:01:00.000Z')
            },
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.equal(allenkV2Lane.releaseEligible, false);
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-comparison-stale'));
    assert.equal(allenkV2Lane.evidence.freshness.stale, true);
    assert.deepEqual(
        allenkV2Lane.evidence.freshness.staleSourceInputs.map((item) => path.basename(item.path)),
        ['create-allenk-v2-comparison-report.js', 'v2-summary.json', 'allenk-v2-video-crop-benchmark.json', 'video-denoise.json', 'latest-report.json']
    );
});

test('createReleaseReadinessReport should block allenk V2 comparison source hash mismatches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-hash-allenk-v2-'));
    const comparisonScriptPath = path.join(tempDir, 'create-allenk-v2-comparison-report.js');
    const v2SummaryPath = path.join(tempDir, 'v2-summary.json');
    const videoCropBenchmarkPath = path.join(tempDir, 'allenk-v2-video-crop-benchmark.json');
    const videoDenoisePath = path.join(tempDir, 'video-denoise.json');
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    const alphaReportPath = path.join(alphaRoot, 'candidate-a', 'latest-report.json');
    await writeJson(v2SummaryPath, {
        summary: { total: 1, v2Selected: 1, v2Cleanup: 1 }
    });
    await writeFile(comparisonScriptPath, 'export {};\n', 'utf8');
    await writeJson(videoDenoisePath, {
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    await writeJson(alphaReportPath, {
        result: {
            promotedCount: 0,
            rejectedByVideoCount: 0,
            topCandidates: []
        }
    });
    const comparisonPath = await writeAllenkV2Comparison(tempDir);
    await writeJson(v2SummaryPath, {
        summary: { total: 2, v2Selected: 1, v2Cleanup: 1 }
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: v2SummaryPath,
            videoDenoiseGate: videoDenoisePath,
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: comparisonScriptPath,
            allenkV2MtimeOverrides: {
                [comparisonPath]: Date.parse('2026-06-11T00:10:00.000Z'),
                [comparisonScriptPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [v2SummaryPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [videoCropBenchmarkPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [videoDenoisePath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [alphaReportPath]: Date.parse('2026-06-11T00:05:00.000Z')
            },
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.equal(allenkV2Lane.evidence.freshness.stale, false);
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-comparison-provenance-mismatch'));
    assert.equal(allenkV2Lane.evidence.provenance.ok, false);
    assert.equal(allenkV2Lane.evidence.provenance.mismatchCount, 1);
    assert.equal(allenkV2Lane.evidence.provenance.mismatched[0].id, 'image-v2-summary');
});

test('createReleaseReadinessReport should block allenk V2 comparison reports without generator provenance', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-missing-script-provenance-'));
    await writeJson(path.join(tempDir, 'v2-summary.json'), {
        summary: { total: 1, v2Selected: 1, v2Cleanup: 1 }
    });
    await writeJson(path.join(tempDir, 'video-denoise.json'), {
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    await writeJson(path.join(tempDir, 'alpha-gates', 'candidate-a', 'latest-report.json'), {
        result: {
            promotedCount: 0,
            rejectedByVideoCount: 0,
            topCandidates: []
        }
    });
    const comparisonPath = await writeAllenkV2Comparison(tempDir);
    const comparison = JSON.parse(await readFile(comparisonPath, 'utf8'));
    comparison.provenance.sourceArtifacts = comparison.provenance.sourceArtifacts
        .filter((item) => item.id !== 'allenk-v2-comparison-script');
    await writeJson(comparisonPath, comparison);

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: path.join(tempDir, 'create-allenk-v2-comparison-report.js'),
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-comparison-provenance-mismatch'));
    assert.deepEqual(allenkV2Lane.evidence.provenance.missingProvenanceIds, ['allenk-v2-comparison-script']);
});

test('createReleaseReadinessReport should block allenk V2 comparison reference head mismatches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-head-allenk-v2-'));
    const currentHead = '632348868da0653d5c1e99680d2c448f4d8505eb';
    const staleHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const comparisonScriptPath = path.join(tempDir, 'create-allenk-v2-comparison-report.js');
    const v2SummaryPath = path.join(tempDir, 'v2-summary.json');
    const videoDenoisePath = path.join(tempDir, 'video-denoise.json');
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    const alphaReportPath = path.join(alphaRoot, 'candidate-a', 'latest-report.json');
    await writeJson(v2SummaryPath, {
        summary: { total: 1, v2Selected: 1, v2Cleanup: 1 }
    });
    await writeFile(comparisonScriptPath, 'export {};\n', 'utf8');
    await writeJson(videoDenoisePath, {
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    await writeJson(alphaReportPath, {
        result: {
            promotedCount: 0,
            rejectedByVideoCount: 0,
            topCandidates: []
        }
    });
    const comparisonPath = await writeAllenkV2Comparison(tempDir, {
        allenkLocalHead: staleHead,
        allenkRemoteHead: staleHead
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: v2SummaryPath,
            videoDenoiseGate: videoDenoisePath,
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: currentHead,
            allenkRemoteHead: currentHead,
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: comparisonScriptPath,
            allenkV2MtimeOverrides: {
                [comparisonPath]: Date.parse('2026-06-11T00:10:00.000Z'),
                [comparisonScriptPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [v2SummaryPath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [path.join(tempDir, 'allenk-v2-video-crop-benchmark.json')]: Date.parse('2026-06-11T00:05:00.000Z'),
                [videoDenoisePath]: Date.parse('2026-06-11T00:05:00.000Z'),
                [alphaReportPath]: Date.parse('2026-06-11T00:05:00.000Z')
            },
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-comparison-reference-head-mismatch'));
    assert.equal(allenkV2Lane.evidence.referenceHeadCheck.localHeadMatches, false);
    assert.equal(allenkV2Lane.evidence.referenceHeadCheck.remoteHeadMatches, false);
});

test('createReleaseReadinessReport should block forged allenk V2 image evidence fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-forged-image-v2-'));
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';
    await mkdir(path.join(tempDir, 'GeminiWatermarkTool'), { recursive: true });
    const comparisonPath = await writeAllenkV2Comparison(tempDir, {
        imageV2Evidence: {
            v2Selected: 1,
            v2Cleanup: 1,
            v2RecordCount: 2,
            passingCleanupRecordCount: 0
        }
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: path.join(tempDir, 'create-allenk-v2-comparison-report.js'),
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-image-record-count-mismatch'));
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-image-passing-cleanup-record-missing'));
    assert.equal(allenkV2Lane.evidence.imageV2RecordCount, 2);
    assert.equal(allenkV2Lane.evidence.imageV2PassingCleanupRecordCount, 0);
});

test('createReleaseReadinessReport should block forged allenk V2 video artifact evidence fields', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-forged-video-v2-'));
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';
    await mkdir(path.join(tempDir, 'GeminiWatermarkTool'), { recursive: true });
    const comparisonPath = await writeAllenkV2Comparison(tempDir, {
        videoEvidence: {
            missingOutputArtifactCount: 1,
            cases: [{ id: 'case-a' }]
        }
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'missing-package.json'),
            latestExtension: path.join(tempDir, 'missing-latest-extension.json'),
            userscript: path.join(tempDir, 'missing-userscript.js'),
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: comparisonPath,
            allenkV2ComparisonScript: path.join(tempDir, 'create-allenk-v2-comparison-report.js'),
            gitStatusText: '',
            releaseClaimFiles: [],
            releaseVersionDocs: {}
        }
    });

    const allenkV2Lane = report.lanes.find((lane) => lane.id === 'allenk-v2-comparison');
    assert.equal(allenkV2Lane.status, 'missing-evidence');
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-video-rendered-artifacts-missing'));
    assert.ok(allenkV2Lane.blockers.includes('allenk-v2-video-case-summary-incomplete'));
    assert.equal(allenkV2Lane.evidence.videoMissingOutputArtifactCount, 1);
    assert.equal(allenkV2Lane.evidence.videoCaseSummaryCount, 1);
});

test('createReleaseReadinessReport should require rebuild when release build inputs are dirty', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-dirty-'));
    const releaseDir = path.join(tempDir, 'release');
    const latestExtensionPath = path.join(releaseDir, 'latest-extension.json');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir);
    const videoProductionSources = await writeVideoProductionSourceFiles(tempDir);
    const videoDeliveryArtifacts = await writeVideoDeliveryArtifacts(tempDir);

    const visibleDir = path.join(tempDir, 'visible');
    await writeJson(path.join(visibleDir, 'loop-summary.json'), {
        summary: {
            readyForGoldMigration: false,
            unconfirmedCount: 30,
            structuralErrorCount: 0,
            productionProfileAllowed: false,
            productionGateContractReady: true,
            packageScriptGateReady: true,
            productionHitCount: 0,
            productionArtifactHitCount: 0
        }
    });
    await writeJson(path.join(visibleDir, 'goal-audit-report.json'), {
        summary: { readyForGoldMigration: false, productionProfileAllowed: false }
    });
    await writeJson(path.join(visibleDir, 'algorithm-admission-report.json'), {
        humanGate: { readyForGoldMigration: false },
        productionProfileAdmission: { allowed: false },
        summary: { currentState: 'human-gated-blocked' }
    });
    await writeJson(path.join(tempDir, 'v2-summary.json'), {
        summary: { total: 189, applied: 152, skipped: 37, pass: 66, residual: 86, v2Selected: 1, v2Cleanup: 1 },
        v2Records: [{ file: 'sample.png', bucket: 'pass', config: { logoSize: 36 } }]
    });
    await writeJson(path.join(tempDir, 'video-denoise.json'), {
        requiredLayerCount: 3,
        layers: [],
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    await writeJson(path.join(alphaRoot, 'candidate-a', 'latest-report.json'), {
        result: {
            totalCommonCandidates: 1,
            promotedCount: 0,
            rejectedByVideoCount: 1,
            topCandidates: [{ name: 'candidate-a', videoGate: { verdict: 'rejected-video-regression', regressions: [] } }]
        }
    });
    const allenkRepo = path.join(tempDir, 'GeminiWatermarkTool');
    await mkdir(allenkRepo, { recursive: true });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: latestExtensionPath,
            userscript,
            visibleResidualLoopSummary: path.join(visibleDir, 'loop-summary.json'),
            visibleResidualGoalAudit: path.join(visibleDir, 'goal-audit-report.json'),
            visibleResidualAdmission: path.join(visibleDir, 'algorithm-admission-report.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo,
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: ' M src/core/watermarkProcessor.js\n',
            releaseClaimFiles,
            releaseMtimeOverrides: {
                [path.join(releaseDir, extensionFile)]: Date.parse('2026-06-11T00:00:00.000Z'),
                'src/core/watermarkProcessor.js': Date.parse('2026-06-11T00:01:00.000Z')
            },
            releaseVersionDocs,
            ...videoDeliveryArtifacts,
            ...videoProductionSources
        }
    });

    assert.equal(report.overall.currentImageCapabilityReady, true);
    assert.equal(report.overall.canReleaseCurrentImageDefaults, false);
    assert.equal(report.overall.recommendation, 'rc-current-image-defaults-after-rebuild');
    assert.equal(report.overall.releaseReadinessGate.ok, false);
    assert.ok(report.overall.releaseReadinessGate.blockers.includes('release-recommendation-not-immediately-releasable'));
    assert.ok(report.overall.releaseReadinessGate.blockers.includes('current-image-defaults-not-releasable'));
    const releaseLane = report.lanes.find((lane) => lane.id === 'release-artifact');
    assert.equal(releaseLane.status, 'needs-rebuild');
    assert.ok(releaseLane.blockers.includes('release-build-inputs-dirty-rebuild-required'));
    assert.deepEqual(
        releaseLane.evidence.releaseFreshness.buildInputDirtyPaths,
        ['src/core/watermarkProcessor.js']
    );
});

test('createReleaseReadinessReport should allow dirty build inputs when zip is newer than them', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-fresh-dirty-'));
    const releaseDir = path.join(tempDir, 'release');
    const latestExtensionPath = path.join(releaseDir, 'latest-extension.json');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir);
    const videoProductionSources = await writeVideoProductionSourceFiles(tempDir);
    const videoDeliveryArtifacts = await writeVideoDeliveryArtifacts(tempDir);

    const visibleDir = path.join(tempDir, 'visible');
    await writeJson(path.join(visibleDir, 'loop-summary.json'), {
        summary: {
            readyForGoldMigration: false,
            unconfirmedCount: 30,
            structuralErrorCount: 0,
            productionProfileAllowed: false,
            productionGateContractReady: true,
            packageScriptGateReady: true,
            productionHitCount: 0,
            productionArtifactHitCount: 0
        }
    });
    await writeJson(path.join(visibleDir, 'goal-audit-report.json'), {
        summary: { readyForGoldMigration: false, productionProfileAllowed: false }
    });
    await writeJson(path.join(visibleDir, 'algorithm-admission-report.json'), {
        humanGate: { readyForGoldMigration: false },
        productionProfileAdmission: { allowed: false },
        summary: { currentState: 'human-gated-blocked' }
    });
    await writeJson(path.join(tempDir, 'v2-summary.json'), {
        summary: { total: 189, applied: 152, skipped: 37, pass: 66, residual: 86, v2Selected: 1, v2Cleanup: 1 },
        v2Records: [{ file: 'sample.png', bucket: 'pass', config: { logoSize: 36 } }]
    });
    await writeJson(path.join(tempDir, 'video-denoise.json'), {
        requiredLayerCount: 3,
        layers: [],
        candidates: [{ profileLabel: 'canvas-edge-denoise', decision: 'reject' }]
    });
    const alphaRoot = path.join(tempDir, 'alpha-gates');
    await writeJson(path.join(alphaRoot, 'candidate-a', 'latest-report.json'), {
        result: {
            totalCommonCandidates: 1,
            promotedCount: 0,
            rejectedByVideoCount: 1,
            topCandidates: [{ name: 'candidate-a', videoGate: { verdict: 'rejected-video-regression', regressions: [] } }]
        }
    });
    const allenkRepo = path.join(tempDir, 'GeminiWatermarkTool');
    await mkdir(allenkRepo, { recursive: true });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: latestExtensionPath,
            userscript,
            visibleResidualLoopSummary: path.join(visibleDir, 'loop-summary.json'),
            visibleResidualGoalAudit: path.join(visibleDir, 'goal-audit-report.json'),
            visibleResidualAdmission: path.join(visibleDir, 'algorithm-admission-report.json'),
            v2CleanupSummary: path.join(tempDir, 'v2-summary.json'),
            videoDenoiseGate: path.join(tempDir, 'video-denoise.json'),
            videoAlphaShapeGateRoot: alphaRoot,
            allenkRepo,
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: ' M src/core/watermarkProcessor.js\n',
            releaseClaimFiles,
            releaseMtimeOverrides: {
                [path.join(releaseDir, extensionFile)]: Date.parse('2026-06-11T00:02:00.000Z'),
                'src/core/watermarkProcessor.js': Date.parse('2026-06-11T00:01:00.000Z')
            },
            releaseVersionDocs,
            ...videoDeliveryArtifacts,
            ...videoProductionSources
        }
    });

    const releaseLane = report.lanes.find((lane) => lane.id === 'release-artifact');
    assert.equal(releaseLane.status, 'ready');
    assert.equal(releaseLane.releaseEligible, true);
    assert.equal(releaseLane.evidence.releaseFreshness.dirtyBuildInputsNewerThanZip, false);
    assert.deepEqual(
        releaseLane.evidence.releaseFreshness.buildInputDirtyPaths,
        ['src/core/watermarkProcessor.js']
    );
    assert.equal(report.overall.recommendation, 'rc-current-image-defaults-with-scoped-claims');
});

test('createReleaseReadinessReport should block release artifact when zip metadata hash is stale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-hash-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const allenkHead = '632348868da0653d5c1e99680d2c448f4d8505eb';

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir);
    await writeJson(path.join(releaseDir, 'latest-extension.json'), {
        version: '1.2.3',
        file: extensionFile,
        sha256: '0'.repeat(64),
        size: Buffer.from('zip').length
    });

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript,
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: allenkHead,
            allenkRemoteHead: allenkHead,
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles,
            releaseVersionDocs
        }
    });

    const releaseLane = report.lanes.find((lane) => lane.id === 'release-artifact');
    assert.equal(releaseLane.releaseEligible, false);
    assert.ok(releaseLane.blockers.includes('extension-sha256-metadata-mismatch'));
    assert.equal(releaseLane.evidence.zipIntegrity.shaMatchesMetadata, false);
    assert.equal(releaseLane.evidence.zipIntegrity.shaFileMatchesZip, true);
});

test('createReleaseReadinessReport should block forbidden public release claims', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-claims-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const claimFile = path.join(tempDir, 'README.md');

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);
    const userscript = await writeUserscriptArtifact(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    await writeFile(
        claimFile,
        [
            'Video V2 now reaches allenk parity and the video denoise backend is enabled by default.',
            'Image V2 now provides broad coverage for all Gemini images and is production ready.',
            'Visible residual alpha profile productionization is ready by default.'
        ].join('\n'),
        'utf8'
    );

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript,
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles: [claimFile],
            releaseVersionDocs
        }
    });

    const claimLane = report.lanes.find((lane) => lane.id === 'release-claims');
    assert.equal(claimLane.status, 'blocked');
    assert.ok(claimLane.blockers.includes('release-claim-scan-violations'));
    assert.equal(claimLane.evidence.violationCount, 4);
    assert.deepEqual(
        claimLane.evidence.violations.map((item) => item.blockedClaim).sort(),
        [
            'broad-image-v2-coverage',
            'new-video-denoise-default',
            'new-visible-residual-alpha-profile-productionization',
            'video-v2-allenk-parity'
        ]
    );
    assert.ok(report.overall.blockedClaims.includes('release-claim-scan-violations'));
    assert.ok(report.overall.blockedClaims.includes('broad-image-v2-coverage'));
    assert.ok(report.overall.blockedClaims.includes('new-visible-residual-alpha-profile-productionization'));
});

test('createReleaseReadinessReport should block stale userscript artifacts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-userscript-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir);
    const userscript = await writeUserscriptArtifact(tempDir, '1.2.2');

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript,
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles,
            releaseVersionDocs
        }
    });

    const userscriptLane = report.lanes.find((lane) => lane.id === 'userscript-artifact');
    assert.equal(userscriptLane.status, 'blocked');
    assert.ok(userscriptLane.blockers.includes('userscript-version-mismatch'));
    assert.equal(userscriptLane.evidence.packageVersion, '1.2.3');
    assert.equal(userscriptLane.evidence.userscriptVersion, '1.2.2');
});

test('createReleaseReadinessReport should block missing current-version changelog entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-release-readiness-version-docs-'));
    const releaseDir = path.join(tempDir, 'release');
    const extensionFile = 'gemini-watermark-remover-extension-v1.2.3.zip';
    const releaseClaimFiles = await writeSafeReleaseClaimFile(tempDir);
    const releaseVersionDocs = await writeReleaseVersionDocs(tempDir, '1.2.2');
    const userscript = await writeUserscriptArtifact(tempDir);

    await writeJson(path.join(tempDir, 'package.json'), {
        version: '1.2.3',
        scripts: releaseGateScripts()
    });
    await writeReleaseArtifact(releaseDir, extensionFile);

    const report = await createReleaseReadinessReport({
        inputs: {
            packageJson: path.join(tempDir, 'package.json'),
            latestExtension: path.join(releaseDir, 'latest-extension.json'),
            userscript,
            visibleResidualLoopSummary: path.join(tempDir, 'missing-loop.json'),
            visibleResidualGoalAudit: path.join(tempDir, 'missing-audit.json'),
            visibleResidualAdmission: path.join(tempDir, 'missing-admission.json'),
            v2CleanupSummary: path.join(tempDir, 'missing-v2.json'),
            videoDenoiseGate: path.join(tempDir, 'missing-denoise.json'),
            videoAlphaShapeGateRoot: path.join(tempDir, 'missing-alpha-gates'),
            allenkRepo: path.join(tempDir, 'GeminiWatermarkTool'),
            allenkLocalHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkRemoteHead: '632348868da0653d5c1e99680d2c448f4d8505eb',
            allenkV2Comparison: await writeAllenkV2Comparison(tempDir),
            gitStatusText: '',
            releaseClaimFiles,
            releaseVersionDocs
        }
    });

    const docsLane = report.lanes.find((lane) => lane.id === 'release-version-docs');
    assert.equal(docsLane.status, 'blocked');
    assert.ok(docsLane.blockers.includes('changelogEnHasVersion-missing'));
    assert.ok(docsLane.blockers.includes('changelogZhHasVersion-missing'));
    assert.equal(docsLane.evidence.packageVersion, '1.2.3');
});

test('renderReleaseReadinessMarkdown should expose recommendation and blocked claims', () => {
    const markdown = renderReleaseReadinessMarkdown({
        generatedAt: '2026-06-11T00:00:00.000Z',
        overall: {
            recommendation: 'rc-current-image-defaults-with-scoped-claims',
            currentImageCapabilityReady: true,
            canReleaseCurrentImageDefaults: true,
            canClaimVideoV2Parity: false,
            blockedClaims: [
                'video-v2-allenk-parity',
                'broad-image-v2-coverage',
                'new-visible-residual-alpha-profile-productionization',
                'new-video-denoise-default',
                'new-video-alpha-shape-default'
            ],
            releaseInvariantChecks: {
                ok: true,
                missingBlockedClaims: [],
                missingReleaseClaimGuards: [],
                unregisteredBlockedCapabilities: [],
                guardedBlockedClaims: ['video-v2-allenk-parity']
            },
            releaseReadinessGate: {
                ok: true,
                requiredRecommendation: 'rc-current-image-defaults-with-scoped-claims',
                actualRecommendation: 'rc-current-image-defaults-with-scoped-claims',
                blockers: []
            }
        },
        provenance: {
            sourceArtifacts: [
                {
                    id: 'release-readiness-script',
                    sha256: 'a'.repeat(64),
                    mtimeUtc: '2026-06-11T00:00:00.000Z'
                }
            ]
        },
        lanes: [
            {
                id: 'image-visible-residual',
                title: 'Image visible residual / alpha profile admission',
                status: 'safe-to-release-current-defaults',
                releaseEligible: true,
                productionChangeAllowed: false,
                blockers: ['visible-residual-human-review-incomplete'],
                evidence: {
                    readyForGoldMigration: false,
                    unconfirmedCount: 30,
                    readyDecisionCount: 0,
                    pendingHumanReview: 24,
                    goldCandidateTotal: 6,
                    goldCandidateUnconfirmedCount: 6,
                    topReviewCluster: 'visibleTopPending::45px-other::gradientResidual+positiveHalo+spatialResidual',
                    nextGoldCandidateReviewCluster: 'metricPassVisible::48px-large-margin::positiveHalo',
                    reviewBatchCount: 17,
                    reviewBatchTotal: 30,
                    focusedReviewBatchDecisionCount: 6,
                    reviewManifestSha256: 'b'.repeat(64),
                    focusedReviewBatchSha256: 'c'.repeat(64),
                    humanReviewPackArtifactHashesReady: true,
                    goldManifestExists: false,
                    goldManifestIntegrityReady: false,
                    productionProfileAllowed: false,
                    productionGateContractReady: true,
                    productionHitCount: 0,
                    productionArtifactHitCount: 0,
                    admissionCurrentState: 'human-gated-blocked',
                    admissionBlockedReasons: [
                        'human-review-not-ready-for-gold-migration',
                        'human-review-unconfirmed-decisions'
                    ]
                },
                releaseNotes: ['Human review remains incomplete.']
            },
            {
                id: 'image-v2-36',
                title: 'Image V2 36px cleanup',
                status: 'guarded-release',
                releaseEligible: true,
                blockers: [],
                releaseNotes: ['Keep scoped.']
            },
            {
                id: 'video-denoise-v2',
                title: 'Video V2 denoise parity',
                status: 'experiment-only',
                releaseEligible: false,
                blockers: ['video-denoise-no-promoted-default-candidate'],
                evidence: {
                    requiredLayerCount: 3,
                    totalCandidates: 5,
                    promotedCandidates: [],
                    humanReviewCandidates: [],
                    insufficientEvidenceCandidates: ['none, alphaEdgePolicy=standard045-inset035'],
                    rejectedCandidates: [
                        'canvas-edge-band-denoise, strength=0.5',
                        'canvas-edge-denoise, strength=0.65'
                    ],
                    layerIds: [
                        'frame-lab:latest-report',
                        'video-benchmark:latest-summary'
                    ]
                },
                releaseNotes: ['Keep as experiment.']
            },
            {
                id: 'video-alpha-shape',
                title: 'Video alpha shape/profile candidates',
                status: 'experiment-only',
                releaseEligible: false,
                blockers: [
                    'video-alpha-shape-no-promoted-candidate',
                    'video-alpha-shape-video-regressions-present'
                ],
                evidence: {
                    reportCount: 2,
                    promotedCount: 0,
                    rejectedByVideoCount: 3,
                    noBenchmarkCount: 1,
                    reports: [
                        {
                            name: 'candidate-a',
                            topCandidate: 'local-right-edge0045-low0.92',
                            topVideoRegressionCount: 8
                        },
                        {
                            name: 'candidate-b',
                            topCandidate: 'local-bottom-edge0045-low0.92',
                            topVideoRegressionCount: 3
                        }
                    ]
                },
                releaseNotes: ['Keep alpha shape experimental.']
            },
            {
                id: 'video-review-delivery',
                title: 'Video review delivery pack',
                status: 'ready-for-visual-review',
                releaseEligible: true,
                blockers: [],
                evidence: {
                    deliveryReady: true,
                    reviewComparisonCount: 4,
                    reviewCases: ['deaee69b', 'e1997e6e'],
                    reviewViews: ['full', 'roi'],
                    bestCandidate: {
                        profileLabel: 'canvas-temporal-match-delta-stabilize, strength=0.25',
                        decision: 'promote-default-candidate'
                    },
                    temporalStatus: 'pass'
                },
                releaseNotes: ['Ready for visual review only.']
            },
            {
                id: 'video-production-defaults',
                title: 'Video production defaults',
                status: 'safe-current-defaults',
                releaseEligible: true,
                blockers: [],
                evidence: {
                    defaultDenoiseBackend: 'none',
                    reviewPresetMarkedReviewOnly: true
                },
                releaseNotes: ['Defaults stay safe.']
            },
            {
                id: 'allenk-v2-comparison',
                title: 'allenk V2 comparison',
                status: 'current-gap-known',
                releaseEligible: true,
                blockers: [],
                evidence: {
                    canClaimImageV2SmallGuarded: true,
                    canClaimBroadImageV2Coverage: false
                },
                releaseNotes: ['Current gap is known.']
            }
        ]
    });

    assert.match(markdown, /Release Readiness Report/);
    assert.match(markdown, /Gate Summary/);
    assert.match(markdown, /Gate: pass/);
    assert.match(markdown, /Required recommendation: rc-current-image-defaults-with-scoped-claims/);
    assert.match(markdown, /Actual recommendation: rc-current-image-defaults-with-scoped-claims/);
    assert.match(markdown, /Capability Decisions/);
    assert.match(markdown, /Release Decision Summary/);
    assert.match(markdown, /Release Claim Matrix/);
    assert.match(markdown, /Current image defaults \| allowed \| release/);
    assert.match(markdown, /Image V2 36px small profile \| allowed-scoped \| guarded-release/);
    assert.match(markdown, /Broad image V2 coverage \| forbidden \| blocked \| broad-image-v2-coverage \(active\)/);
    assert.match(markdown, /Video denoise default \| experiment-only \| experiment-only \| new-video-denoise-default \(active\)/);
    assert.match(markdown, /Video review delivery \| review-only \| ready-for-visual-review/);
    assert.match(markdown, /Release Evidence Index/);
    assert.match(markdown, /Recommendation \| rc-current-image-defaults-with-scoped-claims/);
    assert.match(markdown, /Evidence index integrity \| release-evidence-index-/);
    assert.match(markdown, /Allowed public capability rows \| current-image-defaults, image-v2-36-small-profile, video-production-defaults/);
    assert.match(markdown, /Active forbidden claims \| .*video-v2-allenk-parity/);
    assert.match(markdown, /allenk comparison \| current-gap-known, cases=-, rendered=-, missingArtifacts=-/);
    assert.match(markdown, /Video experimental gates \| denoise=experiment-only/);
    assert.match(markdown, /Current release scope: current-image-defaults-and-guarded-v2-36-only/);
    assert.match(markdown, /Release now: current-image-defaults/);
    assert.match(markdown, /Guarded release: image-v2-36-small-profile/);
    assert.match(markdown, /Experiment only: video-denoise-default/);
    assert.match(markdown, /Blocked: broad-image-v2-coverage/);
    assert.match(markdown, /Current image defaults/);
    assert.match(markdown, /Image V2 36px small profile/);
    assert.match(markdown, /Broad image V2 coverage/);
    assert.match(markdown, /Video V2 allenk parity/);
    assert.match(markdown, /experiment-only/);
    assert.match(markdown, /Release Invariant Checks/);
    assert.match(markdown, /Invariant coverage: ok/);
    assert.match(markdown, /Source Provenance/);
    assert.match(markdown, /release-readiness-script: [a-f0-9]{64}/);
    assert.match(markdown, /Visible Residual Gate/);
    assert.match(markdown, /Ready for gold migration \| no/);
    assert.match(markdown, /Unconfirmed decisions \| 30/);
    assert.match(markdown, /Gold candidate total \| 6/);
    assert.match(markdown, /Production profile allowed \| no/);
    assert.match(markdown, /Admission blockers \| human-review-not-ready-for-gold-migration, human-review-unconfirmed-decisions/);
    assert.match(markdown, /Video Experimental Gates/);
    assert.match(markdown, /Denoise required layers \| 3/);
    assert.match(markdown, /Denoise rejected candidates \| canvas-edge-band-denoise, strength=0.5, canvas-edge-denoise, strength=0.65/);
    assert.match(markdown, /Alpha-shape promoted count \| 0/);
    assert.match(markdown, /Alpha-shape rejected by video count \| 3/);
    assert.match(markdown, /Worst alpha-shape regression report \| candidate-a \/ local-right-edge0045-low0.92 \/ regressions=8/);
    assert.match(markdown, /Review delivery status \| ready-for-visual-review/);
    assert.match(markdown, /Review best candidate decision \| promote-default-candidate/);
    assert.match(markdown, /rc-current-image-defaults-with-scoped-claims/);
    assert.match(markdown, /video-v2-allenk-parity/);
});
