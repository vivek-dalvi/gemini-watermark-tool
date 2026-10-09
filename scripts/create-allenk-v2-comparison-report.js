import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/allenk-v2-comparison/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/allenk-v2-comparison/latest-report.md');

const DEFAULT_INPUTS = Object.freeze({
    imageV2Summary: '.artifacts/sample-files-gemini-watermark-v2-36-cleanup-20260610/summary.json',
    videoCropBenchmark: '.artifacts/video-crop-benchmark/latest-summary.json',
    videoDenoiseGate: '.artifacts/video-denoise-candidate-gate/latest-report.json',
    videoAlphaShapeGateRoot: '.artifacts/video-alpha-shape-candidate-gate',
    allenkRepo: '.artifacts/external-repos/GeminiWatermarkTool'
});

const VIDEO_BUCKETS = Object.freeze(['active', 'edge', 'lowBody', 'highBody']);
const COMPARISON_READY_STATUS = 'current-gap-known';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function round4(value) {
    return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function average(values) {
    const finite = values.filter(Number.isFinite);
    if (!finite.length) return null;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

async function readJsonArtifact(inputPath) {
    const resolved = path.resolve(inputPath);
    try {
        const text = await readFile(resolved, 'utf8');
        const stats = await stat(resolved);
        return {
            path: resolved,
            exists: true,
            json: JSON.parse(text),
            sha256: createHash('sha256').update(text).digest('hex'),
            mtimeUtc: stats.mtime.toISOString(),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            json: null,
            sha256: null,
            mtimeUtc: null,
            error: error?.message || String(error)
        };
    }
}

async function readFileArtifact(inputPath) {
    const resolved = path.resolve(inputPath);
    try {
        const text = await readFile(resolved, 'utf8');
        const stats = await stat(resolved);
        return {
            path: resolved,
            exists: true,
            sha256: createHash('sha256').update(text).digest('hex'),
            mtimeUtc: stats.mtime.toISOString(),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            sha256: null,
            mtimeUtc: null,
            error: error?.message || String(error)
        };
    }
}

function createArtifactProvenance(id, artifact) {
    return {
        id,
        path: artifact.path,
        exists: artifact.exists,
        sha256: artifact.sha256 || null,
        mtimeUtc: artifact.mtimeUtc || null,
        error: artifact.error || null
    };
}

function runGit(args, cwd) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        return null;
    }
}

function uniqueStrings(values) {
    return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function summarizeAllenkReference(allenkRepoPath, { localHeadOverride = null, remoteHeadOverride = null } = {}) {
    const repoPath = path.resolve(allenkRepoPath);
    const exists = existsSync(repoPath);
    const localHead = localHeadOverride || (exists ? runGit(['rev-parse', 'HEAD'], repoPath) : null);
    const remoteHead = remoteHeadOverride || runGit(['ls-remote', 'https://github.com/allenk/GeminiWatermarkTool.git', 'HEAD'], process.cwd())
        ?.split(/\s+/)[0] || null;
    const blockers = [];
    if (!exists) blockers.push('allenk-reference-repo-missing');
    if (!remoteHead) blockers.push('allenk-reference-remote-head-unverified');
    if (localHead && remoteHead && localHead !== remoteHead) blockers.push('allenk-reference-remote-head-changed');
    return {
        status: blockers.length === 0 ? 'current' : 'needs-refresh',
        blockers,
        repoPath,
        localHead,
        remoteHead,
        referenceVideoDir: path.resolve('.artifacts/allenk-video')
    };
}

function summarizeImageV2(imageArtifact) {
    const summary = imageArtifact.json?.summary || {};
    const records = Array.isArray(imageArtifact.json?.v2Records) ? imageArtifact.json.v2Records : [];
    const v2Selected = Number(summary.v2Selected || 0);
    const v2Cleanup = Number(summary.v2Cleanup || 0);
    const v2CleanupRecords = records.filter((record) =>
        record?.applied === true &&
        record?.bucket === 'pass' &&
        Number(record?.config?.logoSize) === 36 &&
        record?.config?.alphaVariant === 'v2'
    );
    const blockers = [];
    if (!imageArtifact.exists) blockers.push('image-v2-summary-missing');
    if (Number(summary.total || 0) <= 0) blockers.push('image-v2-sample-total-missing');
    if (v2Selected <= 0) blockers.push('image-v2-36-no-selected-sample');
    if (v2Cleanup <= 0) blockers.push('image-v2-36-cleanup-not-observed');
    if (records.length !== v2Selected) blockers.push('image-v2-36-record-count-mismatch');
    if (v2Cleanup > v2Selected) blockers.push('image-v2-36-cleanup-count-invalid');
    if (v2CleanupRecords.length <= 0) blockers.push('image-v2-36-no-passing-cleanup-record');

    return {
        status: blockers.length === 0 ? 'guarded-release' : 'missing-evidence',
        releaseScope: blockers.length === 0 ? 'evidence-gated-v2-36-only' : 'blocked',
        canClaimBroadImageV2Coverage: false,
        blockers,
        knownGaps: blockers.length === 0
            ? ['v2-36-core-gray-shadow-needs-render-composite-model']
            : [],
        evidence: {
            summaryPath: imageArtifact.path,
            total: summary.total ?? null,
            applied: summary.applied ?? null,
            pass: summary.pass ?? null,
            residual: summary.residual ?? null,
            v2Selected,
            v2Cleanup,
            v2RecordCount: records.length,
            passingCleanupRecordCount: v2CleanupRecords.length,
            firstV2Record: records[0]
                ? {
                    file: records[0].file || null,
                    bucket: records[0].bucket || null,
                    config: records[0].config || null,
                    source: records[0].source || null,
                    processedSpatialScore: records[0].detection?.processedSpatialScore ?? null,
                    processedGradientScore: records[0].detection?.processedGradientScore ?? null
                }
                : null
        }
    };
}

function isAllenkReferenceResult(result) {
    return result?.referenceProfile?.algorithm === 'allenk' ||
        String(result?.paths?.reference || '').toLowerCase().includes('allenk');
}

function summarizeAllenkVideoBenchmark(benchmarkArtifact) {
    const benchmark = benchmarkArtifact.json || {};
    const results = Array.isArray(benchmark.results) ? benchmark.results : [];
    const allenkResults = results.filter(isAllenkReferenceResult);
    const renderedComparisons = allenkResults.filter((item) => item.status === 'rendered-comparison');
    const missingReference = allenkResults.filter((item) => Array.isArray(item.missing) && item.missing.includes('reference'));
    const caseSummaries = allenkResults.map((item) => {
        const currentVsReference = item.metrics?.currentVsReference?.meanAbsDeltaPerChannel;
        const originalVsReference = item.metrics?.originalVsReference?.meanAbsDeltaPerChannel;
        const residual = item.residualMetrics?.aggregate || {};
        const outputPath = item.outputPath ? path.resolve(item.outputPath) : null;
        const outputArtifactExists = item.status === 'rendered-comparison'
            ? Boolean(outputPath && existsSync(outputPath))
            : null;
        return {
            id: item.id || null,
            label: item.label || null,
            status: item.status || null,
            outputPath,
            outputArtifactExists,
            currentProfile: item.currentProfile || null,
            referenceProfile: item.referenceProfile || null,
            currentVsAllenkMeanAbs: round4(Number(currentVsReference)),
            originalVsAllenkMeanAbs: round4(Number(originalVsReference)),
            currentCloserThanOriginal: Number.isFinite(Number(currentVsReference)) &&
                Number.isFinite(Number(originalVsReference))
                ? Number(currentVsReference) < Number(originalVsReference)
                : null,
            buckets: Object.fromEntries(VIDEO_BUCKETS.map((bucket) => [
                bucket,
                {
                    mean: round4(Number(residual[bucket]?.mean)),
                    meanAbs: round4(Number(residual[bucket]?.meanAbs)),
                    rms: round4(Number(residual[bucket]?.rms))
                }
            ]))
        };
    });

    const referenceProfiles = uniqueStrings(allenkResults.map((item) => {
        const profile = item.referenceProfile || {};
        if (!profile.algorithm) return null;
        const version = profile.version ? `@${profile.version}` : '';
        const denoise = profile.denoiseBackend ? `/${profile.denoiseBackend}` : '';
        return `${profile.algorithm}${version}${denoise}`;
    }));
    const currentProfiles = uniqueStrings(allenkResults.map((item) => {
        const profile = item.currentProfile || {};
        if (!profile.algorithm) return null;
        const alpha = profile.alphaProfile ? `/${profile.alphaProfile}` : '';
        const denoise = profile.denoiseBackend ? `/denoise=${profile.denoiseBackend}` : '';
        return `${profile.algorithm}${alpha}${denoise}`;
    }));
    const currentVsAllenkValues = caseSummaries
        .map((item) => item.currentVsAllenkMeanAbs)
        .filter(Number.isFinite);
    const originalVsAllenkValues = caseSummaries
        .map((item) => item.originalVsAllenkMeanAbs)
        .filter(Number.isFinite);
    const blockers = [];
    if (!benchmarkArtifact.exists) blockers.push('video-crop-benchmark-missing');
    if (allenkResults.length === 0) blockers.push('video-allenk-reference-cases-missing');
    if (renderedComparisons.length === 0) blockers.push('video-allenk-rendered-comparisons-missing');
    if (missingReference.length > 0) blockers.push('video-allenk-reference-missing-for-some-cases');
    const missingOutputArtifacts = caseSummaries.filter((item) =>
        item.status === 'rendered-comparison' && item.outputArtifactExists !== true
    );
    if (missingOutputArtifacts.length > 0) blockers.push('video-allenk-rendered-artifacts-missing');

    return {
        status: blockers.length === 0 ? 'compared' : 'incomplete',
        blockers,
        evidence: {
            summaryPath: benchmarkArtifact.path,
            generatedAt: benchmark.generatedAt || null,
            totalResults: results.length,
            allenkCaseCount: allenkResults.length,
            renderedComparisonCount: renderedComparisons.length,
            missingReferenceCount: missingReference.length,
            missingOutputArtifactCount: missingOutputArtifacts.length,
            missingOutputArtifactCases: missingOutputArtifacts.map((item) => item.id || item.label || 'unknown'),
            referenceProfiles,
            currentProfiles,
            meanCurrentVsAllenkMeanAbs: round4(average(currentVsAllenkValues)),
            meanOriginalVsAllenkMeanAbs: round4(average(originalVsAllenkValues)),
            currentCloserThanOriginalCount: caseSummaries.filter((item) => item.currentCloserThanOriginal === true).length,
            cases: caseSummaries
        }
    };
}

function summarizeVideoDenoiseGate(gateArtifact) {
    const gate = gateArtifact.json || {};
    const candidates = Array.isArray(gate.candidates) ? gate.candidates : [];
    const byDecision = candidates.reduce((acc, item) => {
        const decision = item.decision || 'unknown';
        acc[decision] = (acc[decision] || 0) + 1;
        return acc;
    }, {});
    const promoted = candidates.filter((item) => item.decision === 'promote-default-candidate');
    const blockers = [];
    if (!gateArtifact.exists) blockers.push('video-denoise-gate-missing');
    if (promoted.length === 0) blockers.push('video-denoise-no-promoted-default-candidate');

    return {
        status: promoted.length > 0 ? 'candidate-ready' : 'experiment-only',
        blockers,
        evidence: {
            gatePath: gateArtifact.path,
            generatedAt: gate.generatedAt || null,
            requiredLayerCount: gate.requiredLayerCount ?? null,
            layerIds: Array.isArray(gate.layers) ? gate.layers.map((item) => item.id) : [],
            totalCandidates: candidates.length,
            decisions: byDecision,
            promotedCandidates: promoted.map((item) => item.profileLabel)
        }
    };
}

async function readVideoAlphaShapeReports(rootPath) {
    const root = path.resolve(rootPath);
    if (!existsSync(root)) return { root, reports: [], missing: true };
    const entries = await readdir(root, { withFileTypes: true });
    const reports = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const reportPath = path.join(root, entry.name, 'latest-report.json');
        if (!existsSync(reportPath)) continue;
        reports.push({ name: entry.name, artifact: await readJsonArtifact(reportPath) });
    }
    reports.sort((a, b) => a.name.localeCompare(b.name));
    return { root, reports, missing: false };
}

function summarizeVideoAlphaShapeGate(gateRoot) {
    const reports = gateRoot.reports || [];
    const summaries = reports.map(({ name, artifact }) => {
        const result = artifact.json?.result || {};
        const top = Array.isArray(result.topCandidates) ? result.topCandidates[0] : null;
        return {
            name,
            path: artifact.path,
            promotedCount: Number(result.promotedCount || 0),
            rejectedByVideoCount: Number(result.rejectedByVideoCount || 0),
            totalCommonCandidates: result.totalCommonCandidates ?? null,
            topCandidate: top?.name || null,
            topFitVerdict: top?.fitGate?.verdict || null,
            topVideoVerdict: top?.videoGate?.verdict || null,
            topVideoRegressionCount: Array.isArray(top?.videoGate?.regressions)
                ? top.videoGate.regressions.length
                : null
        };
    });
    const promotedCount = summaries.reduce((sum, item) => sum + item.promotedCount, 0);
    const rejectedByVideoCount = summaries.reduce((sum, item) => sum + item.rejectedByVideoCount, 0);
    const noBenchmarkCount = summaries.filter((item) => item.topVideoVerdict === 'no-video-benchmark').length;
    const blockers = [];
    if (gateRoot.missing || reports.length === 0) blockers.push('video-alpha-shape-gate-missing');
    if (promotedCount === 0) blockers.push('video-alpha-shape-no-promoted-candidate');
    if (rejectedByVideoCount > 0) blockers.push('video-alpha-shape-video-regressions-present');
    if (noBenchmarkCount > 0) blockers.push('video-alpha-shape-benchmark-missing-for-some-candidates');

    return {
        status: promotedCount > 0 ? 'candidate-ready' : 'experiment-only',
        blockers,
        evidence: {
            root: gateRoot.root,
            reportCount: reports.length,
            promotedCount,
            rejectedByVideoCount,
            noBenchmarkCount,
            reports: summaries
        }
    };
}

function deriveOverall({ allenkReference, imageV2, videoBenchmark, videoDenoise, videoAlphaShape }) {
    const comparisonEvidenceReady = allenkReference.status === 'current' &&
        imageV2.status === 'guarded-release' &&
        videoBenchmark.status === 'compared';
    const canClaimImageV2SmallGuarded = imageV2.status === 'guarded-release';
    const canClaimVideoAllenkParity = videoBenchmark.status === 'compared' &&
        videoDenoise.status === 'candidate-ready' &&
        videoAlphaShape.status === 'candidate-ready';
    const blockedClaims = [];
    if (!canClaimVideoAllenkParity) blockedClaims.push('video-v2-allenk-parity');
    if (!canClaimImageV2SmallGuarded) blockedClaims.push('image-v2-36-guarded-support');
    if (imageV2.canClaimBroadImageV2Coverage === false) blockedClaims.push('broad-image-v2-coverage');
    if (videoDenoise.status !== 'candidate-ready') blockedClaims.push('new-video-denoise-default');
    if (videoAlphaShape.status !== 'candidate-ready') blockedClaims.push('new-video-alpha-shape-default');

    return {
        status: comparisonEvidenceReady ? 'current-gap-known' : 'missing-evidence',
        comparisonEvidenceReady,
        canClaimImageV2SmallGuarded,
        canClaimBroadImageV2Coverage: false,
        canClaimVideoAllenkParity,
        blockedClaims,
        nextResearchTracks: [
            'image-v2-36-forward-render-composite-model',
            'video-roi-ml-webgpu-webnn-denoise-backend',
            'video-alpha-shape-candidate-with-video-benchmark-promotion'
        ]
    };
}

export function summarizeAllenkV2ComparisonGate(report) {
    const blockers = [];
    if (report?.overall?.status !== COMPARISON_READY_STATUS) {
        blockers.push('allenk-v2-comparison-not-current-gap-known');
    }
    if (report?.overall?.comparisonEvidenceReady !== true) {
        blockers.push('allenk-v2-comparison-evidence-incomplete');
    }
    return {
        ok: blockers.length === 0,
        requiredStatus: COMPARISON_READY_STATUS,
        actualStatus: report?.overall?.status || null,
        blockers
    };
}

export async function createAllenkV2ComparisonReport({ inputs = DEFAULT_INPUTS } = {}) {
    const comparisonScriptArtifact = await readFileArtifact(inputs.comparisonScript || fileURLToPath(import.meta.url));
    const imageArtifact = await readJsonArtifact(inputs.imageV2Summary || DEFAULT_INPUTS.imageV2Summary);
    const videoBenchmarkArtifact = await readJsonArtifact(inputs.videoCropBenchmark || DEFAULT_INPUTS.videoCropBenchmark);
    const videoDenoiseArtifact = await readJsonArtifact(inputs.videoDenoiseGate || DEFAULT_INPUTS.videoDenoiseGate);
    const videoAlphaShapeRoot = await readVideoAlphaShapeReports(inputs.videoAlphaShapeGateRoot || DEFAULT_INPUTS.videoAlphaShapeGateRoot);

    const sections = {
        allenkReference: summarizeAllenkReference(inputs.allenkRepo || DEFAULT_INPUTS.allenkRepo, {
            localHeadOverride: inputs.allenkLocalHead || null,
            remoteHeadOverride: inputs.allenkRemoteHead || null
        }),
        imageV2: summarizeImageV2(imageArtifact),
        videoBenchmark: summarizeAllenkVideoBenchmark(videoBenchmarkArtifact),
        videoDenoise: summarizeVideoDenoiseGate(videoDenoiseArtifact),
        videoAlphaShape: summarizeVideoAlphaShapeGate(videoAlphaShapeRoot)
    };
    const sourceArtifacts = [
        createArtifactProvenance('allenk-v2-comparison-script', comparisonScriptArtifact),
        createArtifactProvenance('image-v2-summary', imageArtifact),
        createArtifactProvenance('video-crop-benchmark', videoBenchmarkArtifact),
        createArtifactProvenance('video-denoise-gate', videoDenoiseArtifact),
        ...(videoAlphaShapeRoot.reports || []).map(({ name, artifact }) =>
            createArtifactProvenance(`video-alpha-shape:${name}`, artifact)
        )
    ];

    const overall = deriveOverall(sections);
    overall.comparisonGate = summarizeAllenkV2ComparisonGate({ overall });

    return {
        generatedAt: new Date().toISOString(),
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [
            key,
            typeof value === 'string' && key.endsWith('Head') === false
                ? path.resolve(value)
                : value
        ])),
        provenance: {
            sourceArtifacts
        },
        overall,
        ...sections
    };
}

function renderBlockers(blockers = []) {
    return blockers.length ? blockers.join(', ') : '-';
}

function renderGateSummary(gate) {
    return [
        `Gate: ${gate?.ok ? 'pass' : 'fail'}`,
        `Required status: ${gate?.requiredStatus || '-'}`,
        `Actual status: ${gate?.actualStatus || '-'}`,
        `Gate blockers: ${renderBlockers(gate?.blockers || [])}`
    ];
}

function renderMetric(value) {
    return Number.isFinite(Number(value)) ? String(value) : '-';
}

function formatImageConfig(config = {}) {
    if (!config || typeof config !== 'object') return '-';
    const logoSize = config.logoSize ?? '-';
    const marginRight = config.marginRight ?? '-';
    const marginBottom = config.marginBottom ?? '-';
    const variant = config.alphaVariant || 'default';
    return `${logoSize}/${marginRight}/${marginBottom}/${variant}`;
}

function summarizeWorstVideoBucket(caseSummary) {
    const entries = Object.entries(caseSummary?.buckets || {})
        .filter(([, bucket]) => Number.isFinite(Number(bucket?.meanAbs)));
    if (!entries.length) return '-';
    entries.sort(([, left], [, right]) => Number(right.meanAbs) - Number(left.meanAbs));
    const [name, bucket] = entries[0];
    return `${name} (${renderMetric(bucket.meanAbs)})`;
}

function formatVideoProfile(profile = {}) {
    if (!profile || typeof profile !== 'object') return '-';
    const parts = [
        profile.algorithm,
        profile.alphaProfile,
        profile.denoiseBackend ? `denoise=${profile.denoiseBackend}` : null
    ].filter(Boolean);
    return parts.join(' / ') || '-';
}

function renderVideoCaseGapRows(cases = []) {
    const rows = cases
        .filter((item) => item.status === 'rendered-comparison')
        .toSorted((left, right) =>
            Number(right.currentVsAllenkMeanAbs || -Infinity) - Number(left.currentVsAllenkMeanAbs || -Infinity)
        );
    return rows.map((item) => [
        item.id || '-',
        formatVideoProfile(item.currentProfile),
        renderMetric(item.currentVsAllenkMeanAbs),
        renderMetric(item.originalVsAllenkMeanAbs),
        item.currentCloserThanOriginal === true ? 'yes' : item.currentCloserThanOriginal === false ? 'no' : '-',
        summarizeWorstVideoBucket(item),
        item.outputPath || '-'
    ]);
}

export function renderAllenkV2ComparisonMarkdown(report) {
    const lines = [];
    lines.push('# allenk V2 Comparison Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.overall.status}`);
    lines.push(`Comparison evidence ready: ${report.overall.comparisonEvidenceReady ? 'yes' : 'no'}`);
    lines.push(`Image V2 36 guarded claim: ${report.overall.canClaimImageV2SmallGuarded ? 'yes' : 'no'}`);
    lines.push(`Broad image V2 claim: ${report.overall.canClaimBroadImageV2Coverage ? 'yes' : 'no'}`);
    lines.push(`Video allenk parity claim: ${report.overall.canClaimVideoAllenkParity ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('## Gate Summary');
    lines.push('');
    for (const line of renderGateSummary(report.overall.comparisonGate || summarizeAllenkV2ComparisonGate(report))) {
        lines.push(line);
    }
    lines.push('');
    lines.push('| Area | Status | Blockers |');
    lines.push('|---|---|---|');
    lines.push(`| allenk reference | ${report.allenkReference.status} | ${renderBlockers(report.allenkReference.blockers)} |`);
    lines.push(`| image V2 36 | ${report.imageV2.status} | ${renderBlockers(report.imageV2.blockers)} |`);
    lines.push(`| video crop benchmark | ${report.videoBenchmark.status} | ${renderBlockers(report.videoBenchmark.blockers)} |`);
    lines.push(`| video denoise | ${report.videoDenoise.status} | ${renderBlockers(report.videoDenoise.blockers)} |`);
    lines.push(`| video alpha shape | ${report.videoAlphaShape.status} | ${renderBlockers(report.videoAlphaShape.blockers)} |`);
    lines.push('');
    lines.push('## Blocked Claims');
    lines.push('');
    for (const claim of report.overall.blockedClaims) lines.push(`- ${claim}`);
    if (!report.overall.blockedClaims.length) lines.push('- none');
    lines.push('');
    lines.push('## Image V2 36 Evidence');
    lines.push('');
    const image = report.imageV2.evidence;
    lines.push(`- release scope: ${report.imageV2.releaseScope}`);
    lines.push(`- samples: total=${image.total ?? '-'}, applied=${image.applied ?? '-'}, pass=${image.pass ?? '-'}, residual=${image.residual ?? '-'}`);
    lines.push(`- v2 selected: ${image.v2Selected ?? '-'}, v2 cleanup: ${image.v2Cleanup ?? '-'}, v2 records: ${image.v2RecordCount ?? '-'}`);
    lines.push(`- passing V2 cleanup records: ${image.passingCleanupRecordCount ?? '-'}`);
    lines.push(`- broad V2 claim: ${report.imageV2.canClaimBroadImageV2Coverage ? 'yes' : 'no'}`);
    lines.push(`- known gaps: ${renderBlockers(report.imageV2.knownGaps || [])}`);
    lines.push('');
    lines.push('| File | Bucket | Config | Source | Processed spatial | Processed gradient |');
    lines.push('|---|---|---|---|---:|---:|');
    if (image.firstV2Record) {
        lines.push(`| ${image.firstV2Record.file || '-'} | ${image.firstV2Record.bucket || '-'} | ${formatImageConfig(image.firstV2Record.config)} | ${image.firstV2Record.source || '-'} | ${renderMetric(image.firstV2Record.processedSpatialScore)} | ${renderMetric(image.firstV2Record.processedGradientScore)} |`);
    } else {
        lines.push('| - | - | - | - | - | - |');
    }
    lines.push('');
    lines.push('## Video allenk Evidence');
    lines.push('');
    const video = report.videoBenchmark.evidence;
    lines.push(`- allenk cases: ${video.allenkCaseCount}`);
    lines.push(`- rendered comparisons: ${video.renderedComparisonCount}`);
    lines.push(`- missing reference cases: ${video.missingReferenceCount}`);
    lines.push(`- missing rendered artifacts: ${video.missingOutputArtifactCount ?? '-'}`);
    lines.push(`- mean current/allenk ROI abs delta: ${video.meanCurrentVsAllenkMeanAbs ?? '-'}`);
    lines.push(`- mean original/allenk ROI abs delta: ${video.meanOriginalVsAllenkMeanAbs ?? '-'}`);
    lines.push('');
    lines.push('## Video allenk Case Gaps');
    lines.push('');
    lines.push('| Case | Current profile | Current/allenk mean abs | Original/allenk mean abs | Current closer | Worst ROI bucket | Artifact |');
    lines.push('|---|---|---:|---:|---|---|---|');
    const caseRows = renderVideoCaseGapRows(video.cases || []);
    for (const row of caseRows) lines.push(`| ${row.join(' | ')} |`);
    if (!caseRows.length) lines.push('| - | - | - | - | - | - | - |');
    lines.push('');
    lines.push('## Source Provenance');
    lines.push('');
    for (const source of report.provenance?.sourceArtifacts || []) {
        lines.push(`- ${source.id}: ${source.sha256 || 'missing'} (${source.mtimeUtc || '-'})`);
    }
    lines.push('');
    lines.push('## Next Research Tracks');
    lines.push('');
    for (const track of report.overall.nextResearchTracks) lines.push(`- ${track}`);
    return `${lines.join('\n')}\n`;
}

export async function writeAllenkV2ComparisonReport({
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    inputs = DEFAULT_INPUTS
} = {}) {
    const report = await createAllenkV2ComparisonReport({ inputs });
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedMarkdownPath = path.resolve(markdownPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(resolvedMarkdownPath, renderAllenkV2ComparisonMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: resolvedOutputPath,
        markdownPath: resolvedMarkdownPath
    };
}

function parseCliArgs(argv) {
    const options = {
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        inputs: { ...DEFAULT_INPUTS },
        failOnIncomplete: false
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--') {
            continue;
        } else if (arg === '--output') {
            options.outputPath = next;
            index++;
        } else if (arg === '--markdown') {
            options.markdownPath = next;
            index++;
        } else if (arg === '--image-v2-summary') {
            options.inputs.imageV2Summary = next;
            index++;
        } else if (arg === '--video-crop-benchmark') {
            options.inputs.videoCropBenchmark = next;
            index++;
        } else if (arg === '--video-denoise-gate') {
            options.inputs.videoDenoiseGate = next;
            index++;
        } else if (arg === '--video-alpha-shape-root') {
            options.inputs.videoAlphaShapeGateRoot = next;
            index++;
        } else if (arg === '--allenk-repo') {
            options.inputs.allenkRepo = next;
            index++;
        } else if (arg === '--fail-on-incomplete') {
            options.failOnIncomplete = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        }
    }
    return options;
}

function printHelp() {
    console.log(`
Usage:
  node scripts/create-allenk-v2-comparison-report.js [options]

Options:
  --output <path>                  Default: .artifacts/allenk-v2-comparison/latest-report.json
  --markdown <path>                Default: .artifacts/allenk-v2-comparison/latest-report.md
  --image-v2-summary <path>        Image V2 36 cleanup summary
  --video-crop-benchmark <path>    Video crop benchmark latest-summary.json
  --video-denoise-gate <path>      Video denoise candidate gate report
  --video-alpha-shape-root <path>  Video alpha-shape gate root
  --allenk-repo <path>             Local allenk/GeminiWatermarkTool clone
  --fail-on-incomplete             Exit non-zero unless comparison evidence is complete
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
    } else {
        writeAllenkV2ComparisonReport(options)
            .then((report) => {
                console.log(`json: ${report.outputPath}`);
                console.log(`markdown: ${report.markdownPath}`);
                console.log(`status: ${report.overall.status}`);
                console.log(`video allenk parity claim: ${report.overall.canClaimVideoAllenkParity ? 'yes' : 'no'}`);
                if (options.failOnIncomplete) {
                    const gate = summarizeAllenkV2ComparisonGate(report);
                    console.log(`allenk comparison gate: ${gate.ok ? 'pass' : 'fail'}`);
                    if (!gate.ok) {
                        console.error(`allenk comparison gate blockers: ${gate.blockers.join(', ')}`);
                        process.exit(1);
                    }
                }
            })
            .catch((error) => {
                console.error(error);
                process.exitCode = 1;
            });
    }
}
