import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_SAMPLE_ROOT = path.resolve(
    process.env.GWR_ONLINE_SAMPLE_ROOT ||
    'sample-files/gemini-watermark/online-sample-2026-06-23-to-2026-06-24-max500'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/online-sample-2026-06-23-to-2026-06-24-max500');
const BENCHMARK_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-report-after-rebalance.json');
const GAINS = Object.freeze([0.35, 0.43, 0.45, 0.55, 0.65, 0.75, 0.85, 1, 1.1, 1.2]);
const PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL = 0.45;
const PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT = 0.16;

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function negateAlphaMap(alphaMap) {
    return Float32Array.from(alphaMap, (value) => -value);
}

function scoreTrial(originalImageData, alphaMap, position, alphaGain) {
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, alphaMap, position, { alphaGain });
    const spatial = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const visibility = assessWatermarkResidualVisibility({ imageData, alphaMap, position });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position,
        alphaGain
    });
    const darkHalo = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const artifact = artifacts?.visualArtifactCost ?? Number.POSITIVE_INFINITY;
    const clipped = artifacts?.newlyClippedRatio ?? Number.POSITIVE_INFINITY;
    const safe =
        spatial < 0.22 &&
        Math.abs(spatial) <= 0.22 &&
        gradient <= 0.25 &&
        visibility?.visible === false &&
        artifact <= 0.34 &&
        darkHalo <= 4 &&
        clipped <= 0.02;
    return {
        alphaGain,
        spatial,
        gradient,
        visible: visibility?.visible,
        visibleSpatial: visibility?.visibleSpatialResidual,
        visibleGradient: visibility?.visibleGradientResidual,
        positiveHaloLum: visibility?.positiveHaloLum,
        artifact,
        darkHalo,
        clipped,
        safe
    };
}

function rankTrials(left, right) {
    if (left.safe !== right.safe) return left.safe ? -1 : 1;
    return Math.abs(left.spatial) + Math.max(0, left.gradient) * 0.8 -
        (Math.abs(right.spatial) + Math.max(0, right.gradient) * 0.8);
}

function hasProductionEvidence(row) {
    return row.originalSpatial >= PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL &&
        row.originalGradient >= PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT;
}

function summarizeSafeCandidates(rows) {
    return {
        safeCandidateCount: rows.reduce((sum, row) => sum + row.safeCount, 0),
        productionEvidenceSafeCandidateCount: rows.reduce((sum, row) => (
            sum + (hasProductionEvidence(row) ? row.safeCount : 0)
        ), 0)
    };
}

async function auditSkipped({ sampleRoot, alpha48, alpha96 }) {
    const sample = '2026-06-23/2069406094224003072-source.png';
    const original = await decodeImageDataInNode(path.join(sampleRoot, sample));
    const rows = [];
    for (const size of [48, 96]) {
        for (const marginRight of [32, 64, 96, 128, 192]) {
            for (const marginBottom of [32, 64, 96, 128, 192]) {
                const baseAlphaMap = size === 48 ? alpha48 : alpha96;
                for (const polarity of ['white', 'dark']) {
                    const alphaMap = polarity === 'dark' ? negateAlphaMap(baseAlphaMap) : baseAlphaMap;
                    const position = {
                        x: original.width - marginRight - size,
                        y: original.height - marginBottom - size,
                        width: size,
                        height: size
                    };
                    if (position.x < 0 || position.y < 0) continue;
                    const originalSpatial = computeRegionSpatialCorrelation({
                        imageData: original,
                        alphaMap,
                        region: { x: position.x, y: position.y, size }
                    });
                    const originalGradient = computeRegionGradientCorrelation({
                        imageData: original,
                        alphaMap,
                        region: { x: position.x, y: position.y, size }
                    });
                    const trials = GAINS.map((gain) => scoreTrial(original, alphaMap, position, gain))
                        .sort(rankTrials);
                    rows.push({
                        label: `${size}/${marginRight}/${marginBottom}/${polarity}`,
                        originalSpatial,
                        originalGradient,
                        safeCount: trials.filter((trial) => trial.safe).length,
                        best: trials[0]
                    });
                }
            }
        }
    }
    rows.sort((left, right) =>
        right.safeCount - left.safeCount ||
        Math.abs(right.originalSpatial) + Math.max(0, right.originalGradient) -
            (Math.abs(left.originalSpatial) + Math.max(0, left.originalGradient))
    );
    return {
        kind: 'strong-skipped',
        sample,
        ...summarizeSafeCandidates(rows),
        top: rows.slice(0, 12)
    };
}

async function auditAdaptive({ sampleRoot, alpha48, alpha96, sample, kind }) {
    const original = await decodeImageDataInNode(path.join(sampleRoot, sample));
    const rows = [];
    for (const size of [36, 40, 43, 45, 46, 47, 48, 49, 50, 52, 53, 54, 56, 64, 72, 88, 96]) {
        const alphaMap = size === 48
            ? alpha48
            : size === 96
                ? alpha96
                : interpolateAlphaMap(alpha48, 48, size);
        if (!alphaMap) continue;
        for (const marginRight of [32, 48, 58, 64, 71, 72, 80, 85, 96, 112, 128, 192]) {
            for (const marginBottom of [32, 48, 58, 64, 71, 72, 80, 85, 96, 112, 128, 192]) {
                const position = {
                    x: original.width - marginRight - size,
                    y: original.height - marginBottom - size,
                    width: size,
                    height: size
                };
                if (position.x < 0 || position.y < 0) continue;
                const originalSpatial = computeRegionSpatialCorrelation({
                    imageData: original,
                    alphaMap,
                    region: { x: position.x, y: position.y, size }
                });
                const originalGradient = computeRegionGradientCorrelation({
                    imageData: original,
                    alphaMap,
                    region: { x: position.x, y: position.y, size }
                });
                if (originalSpatial < 0.35 && originalGradient < 0.2) continue;
                const trials = GAINS.map((gain) => scoreTrial(original, alphaMap, position, gain))
                    .sort(rankTrials);
                rows.push({
                    label: `${size}/${marginRight}/${marginBottom}`,
                    originalSpatial,
                    originalGradient,
                    safeCount: trials.filter((trial) => trial.safe).length,
                    best: trials[0]
                });
            }
        }
    }
    rows.sort((left, right) =>
        right.safeCount - left.safeCount ||
        Math.abs(left.best.spatial) + Math.max(0, left.best.gradient) * 0.8 -
            (Math.abs(right.best.spatial) + Math.max(0, right.best.gradient) * 0.8)
    );
    return {
        kind,
        sample,
        ...summarizeSafeCandidates(rows),
        top: rows.slice(0, 12)
    };
}

function createMarkdown(report) {
    return [
        '# Tier A Remaining Coverage Audit',
        '',
        `- Generated: ${report.generatedAt}`,
        `- Benchmark: ${report.benchmark.passCount}/${report.benchmark.total} (${(report.benchmark.successRate * 100).toFixed(2)}%)`,
        `- Newly passing vs baseline: ${report.benchmark.newlyPassing}`,
        `- Newly failing vs baseline: ${report.benchmark.newlyFailing}`,
        '',
        '## Safe Candidate Criteria',
        '',
        ...Object.entries(report.safeCriteria).map(([key, value]) => `- ${key}: ${value}`),
        '',
        '## Representative Sweeps',
        '',
        ...report.audits.flatMap((audit) => [
            `### ${audit.kind}: ${audit.sample}`,
            `- safeCandidateCount: ${audit.safeCandidateCount}`,
            `- productionEvidenceSafeCandidateCount: ${audit.productionEvidenceSafeCandidateCount}`,
            `- best candidate: ${audit.top[0]?.label ?? 'none'}`,
            `- best scores: spatial=${audit.top[0]?.best?.spatial?.toFixed(6) ?? 'n/a'}, gradient=${audit.top[0]?.best?.gradient?.toFixed(6) ?? 'n/a'}, visible=${audit.top[0]?.best?.visible ?? 'n/a'}, artifact=${audit.top[0]?.best?.artifact?.toFixed(6) ?? 'n/a'}`,
            ''
        ])
    ].join('\n');
}

async function main() {
    const sampleRoot = path.resolve(process.argv[2] ?? DEFAULT_SAMPLE_ROOT);
    const outputDir = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT_DIR);
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const benchmark = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8'));
    const audits = [
        await auditSkipped({ sampleRoot, alpha48, alpha96 }),
        await auditAdaptive({
            sampleRoot,
            alpha48,
            alpha96,
            sample: '2026-06-23/2069409434081169408-source.png',
            kind: 'adaptive-located'
        }),
        await auditAdaptive({
            sampleRoot,
            alpha48,
            alpha96,
            sample: '2026-06-24/2069581324829593600-source.jpg',
            kind: 'preview-anchor'
        })
    ];
    const report = {
        generatedAt: new Date().toISOString(),
        benchmark: {
            total: benchmark.summary.total,
            passCount: benchmark.summary.passCount,
            failCount: benchmark.summary.failCount,
            successRate: benchmark.summary.successRate,
            newlyPassing: benchmark.newlyPassing.length,
            newlyFailing: benchmark.newlyFailing.length
        },
        safeCriteria: {
            spatial: 'spatial < 0.22 and abs(spatial) <= 0.22',
            gradient: '<= 0.25',
            visibility: 'visible === false',
            visualArtifactCost: '<= 0.34',
            darkHalo: '<= 4',
            newlyClippedRatio: '<= 0.02',
            productionEvidence: `originalSpatial >= ${PRODUCTION_EVIDENCE_MIN_ORIGINAL_SPATIAL} and originalGradient >= ${PRODUCTION_EVIDENCE_MIN_ORIGINAL_GRADIENT}`
        },
        audits
    };
    const jsonPath = path.join(outputDir, 'tier-a-remaining-coverage-audit.json');
    const markdownPath = path.join(outputDir, 'tier-a-remaining-coverage-audit.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, createMarkdown(report), 'utf8');
    console.log(JSON.stringify({
        jsonPath,
        markdownPath,
        audits: audits.map((audit) => ({
            kind: audit.kind,
            sample: audit.sample,
            safeCandidateCount: audit.safeCandidateCount,
            productionEvidenceSafeCandidateCount: audit.productionEvidenceSafeCandidateCount,
            best: audit.top[0]
        }))
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
