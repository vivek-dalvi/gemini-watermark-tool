import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import { createAlphaGradientMask } from '../src/core/alphaGradientMask.js';
import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { calculateNearBlackRatio } from '../src/core/candidateSelector.js';
import { buildPreviewNeighborhoodPrior } from '../src/core/previewAlphaCalibration.js';
import { scoreBalancedVisualCandidate } from '../src/core/watermarkScoring.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/gemini-watermark-metric-study/metric-48-96-96-taxonomy-positive-halo-calibration/latest.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/gemini-watermark-metric-study/metric-48-96-96-residual-profile-algorithmic-residuals'
);
const DEFAULT_FILE_PATTERN = 'wn0cz5|l8xbiy';
const DEFAULT_SCOPE = 'algorithmic-residuals';
const DEFAULT_PRIOR_RADIUS = 6;
const DEFAULT_BANDS = Object.freeze([
    { key: 'low', minAlpha: 0, maxAlpha: 0.04 },
    { key: 'edge', minAlpha: 0.04, maxAlpha: 0.12 },
    { key: 'mid', minAlpha: 0.12, maxAlpha: 0.28 },
    { key: 'body', minAlpha: 0.28, maxAlpha: 1 }
]);
const LOW_ALPHA_PRIOR_RELIABLE_MAX_ABS = 4;
const BODY_RESIDUAL_MEAN_THRESHOLD = 0.5;
const BODY_RESIDUAL_RATIO_THRESHOLD = 0.2;
const DEFAULT_CORRECTION_MIN_ALPHA = 0.12;
const DEFAULT_CORRECTION_RESIDUAL_THRESHOLD = -0.5;
const EDGE_STRUCTURE_MIN_EDGE_MEAN = 8;
const EDGE_STRUCTURE_MIN_EDGE_RATIO = 1.5;

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        filePattern: DEFAULT_FILE_PATTERN,
        scope: DEFAULT_SCOPE,
        priorRadius: DEFAULT_PRIOR_RADIUS
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--file-pattern') {
            parsed.filePattern = args.shift() || null;
            continue;
        }
        if (arg === '--scope') {
            const scope = args.shift();
            if (scope === 'all' || scope === 'algorithmic-residuals') parsed.scope = scope;
            continue;
        }
        if (arg === '--prior-radius') {
            const radius = Number(args.shift());
            if (Number.isFinite(radius) && radius > 0) parsed.priorRadius = radius;
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function clampChannel(value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
}

function luminance(data, index) {
    return (data[index] + data[index + 1] + data[index + 2]) / 3;
}

function imageLuminanceAt(imageData, x, y) {
    const clampedX = Math.max(0, Math.min(imageData.width - 1, x));
    const clampedY = Math.max(0, Math.min(imageData.height - 1, y));
    return luminance(imageData.data, (clampedY * imageData.width + clampedX) * 4);
}

function imageGradientMagnitude(imageData, x, y) {
    const gx = imageLuminanceAt(imageData, x + 1, y) - imageLuminanceAt(imageData, x - 1, y);
    const gy = imageLuminanceAt(imageData, x, y + 1) - imageLuminanceAt(imageData, x, y - 1);
    return Math.sqrt(gx * gx + gy * gy) / 2;
}

function countBy(records, getKey) {
    const counts = new Map();
    for (const record of records) {
        const key = getKey(record);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

export function analyzeResidualBands({
    imageData,
    priorImageData,
    alphaMap,
    position,
    bands = DEFAULT_BANDS
}) {
    if (!imageData || !priorImageData || !alphaMap || !position) {
        throw new TypeError('analyzeResidualBands requires imageData, priorImageData, alphaMap, and position');
    }
    if (imageData.width !== priorImageData.width || imageData.height !== priorImageData.height) {
        throw new RangeError('imageData and priorImageData must have identical dimensions');
    }

    return bands.map((band) => {
        let count = 0;
        let alphaSum = 0;
        let residualSum = 0;
        let absResidualSum = 0;
        let positiveCount = 0;
        let negativeCount = 0;

        for (let row = 0; row < position.height; row++) {
            for (let col = 0; col < position.width; col++) {
                const alpha = alphaMap[row * position.width + col];
                if (alpha < band.minAlpha || alpha >= band.maxAlpha) continue;
                const pixelIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
                const residual = luminance(imageData.data, pixelIndex) - luminance(priorImageData.data, pixelIndex);
                count++;
                alphaSum += alpha;
                residualSum += residual;
                absResidualSum += Math.abs(residual);
                if (residual > 1) positiveCount++;
                if (residual < -1) negativeCount++;
            }
        }

        return {
            key: band.key,
            minAlpha: band.minAlpha,
            maxAlpha: band.maxAlpha,
            count,
            meanAlpha: count > 0 ? round(alphaSum / count) : null,
            meanResidual: count > 0 ? round(residualSum / count) : null,
            meanAbsResidual: count > 0 ? round(absResidualSum / count) : null,
            positiveRatio: count > 0 ? round(positiveCount / count) : null,
            negativeRatio: count > 0 ? round(negativeCount / count) : null
        };
    });
}

export function classifyResidualProfile({ bands }) {
    const low = bands.find((band) => band.key === 'low');
    const body = bands.find((band) => band.key === 'body');
    const lowAbs = Number(low?.meanAbsResidual);
    const priorReliable = Number.isFinite(lowAbs) && lowAbs <= LOW_ALPHA_PRIOR_RELIABLE_MAX_ABS;

    if (!priorReliable) {
        return {
            label: 'structured-prior-unreliable',
            priorReliable: false,
            reason: 'low-alpha-band-does-not-match-neighborhood-prior'
        };
    }

    const bodyMean = Number(body?.meanResidual);
    const negativeRatio = Number(body?.negativeRatio);
    const positiveRatio = Number(body?.positiveRatio);
    if (
        Number.isFinite(bodyMean) &&
        bodyMean <= -BODY_RESIDUAL_MEAN_THRESHOLD &&
        Number.isFinite(negativeRatio) &&
        negativeRatio >= BODY_RESIDUAL_RATIO_THRESHOLD
    ) {
        return {
            label: 'over-subtracted-alpha-body',
            priorReliable: true,
            reason: 'reliable-prior-with-negative-body-residual'
        };
    }
    if (
        Number.isFinite(bodyMean) &&
        bodyMean >= BODY_RESIDUAL_MEAN_THRESHOLD &&
        Number.isFinite(positiveRatio) &&
        positiveRatio >= BODY_RESIDUAL_RATIO_THRESHOLD
    ) {
        return {
            label: 'under-subtracted-alpha-body',
            priorReliable: true,
            reason: 'reliable-prior-with-positive-body-residual'
        };
    }

    return {
        label: 'prior-reliable-no-directed-body-residual',
        priorReliable: true,
        reason: 'body-alpha-residual-is-not-directional'
    };
}

export function measureAlphaEdgeStructureOverlap({
    imageData,
    alphaMap,
    position
}) {
    if (!imageData || !alphaMap || !position) {
        throw new TypeError('measureAlphaEdgeStructureOverlap requires imageData, alphaMap, and position');
    }

    const mask = createAlphaGradientMask({
        alphaMap,
        width: position.width,
        height: position.height,
        dilateRadius: 1,
        blurSigma: 1,
        gamma: 0.7
    });
    let edgeWeight = 0;
    let edgeGradientSum = 0;
    let nonEdgeWeight = 0;
    let nonEdgeGradientSum = 0;
    let highEdgePixels = 0;
    let highNonEdgePixels = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const weight = mask[localIndex] ?? 0;
            const gradient = imageGradientMagnitude(
                imageData,
                position.x + col,
                position.y + row
            );
            edgeWeight += weight;
            edgeGradientSum += gradient * weight;
            nonEdgeWeight += 1 - weight;
            nonEdgeGradientSum += gradient * (1 - weight);
            if (weight > 0.5 && gradient > 16) highEdgePixels++;
            if (weight < 0.2 && gradient > 16) highNonEdgePixels++;
        }
    }

    const edgeMean = edgeWeight > 0 ? edgeGradientSum / edgeWeight : 0;
    const nonEdgeMean = nonEdgeWeight > 0 ? nonEdgeGradientSum / nonEdgeWeight : 0;
    return {
        edgeMean: round(edgeMean),
        nonEdgeMean: round(nonEdgeMean),
        edgeToNonEdgeRatio: round(edgeMean / Math.max(nonEdgeMean, 1e-6)),
        highEdgePixels,
        highNonEdgePixels
    };
}

export function classifyEdgeStructureRisk({
    taxonomy,
    production,
    residualProfile,
    edgeStructure
}) {
    if (
        taxonomy?.algorithmicResidualCandidate === true &&
        effectiveVisible(production) === true &&
        residualProfile?.label === 'structured-prior-unreliable' &&
        Number(edgeStructure?.edgeMean) >= EDGE_STRUCTURE_MIN_EDGE_MEAN &&
        Number(edgeStructure?.edgeToNonEdgeRatio) >= EDGE_STRUCTURE_MIN_EDGE_RATIO
    ) {
        return {
            label: 'structured-edge-collision-protected',
            actionable: false,
            reason: 'visible-residual-overlaps-strong-image-structure'
        };
    }

    return {
        label: 'not-protected',
        actionable: false,
        reason: 'edge-structure-risk-gates-not-met'
    };
}

export function applyQuantizedBodyResidualCorrection({
    imageData,
    priorImageData,
    alphaMap,
    position,
    minAlpha = DEFAULT_CORRECTION_MIN_ALPHA,
    residualThreshold = DEFAULT_CORRECTION_RESIDUAL_THRESHOLD
}) {
    if (!imageData || !priorImageData || !alphaMap || !position) {
        throw new TypeError('applyQuantizedBodyResidualCorrection requires imageData, priorImageData, alphaMap, and position');
    }

    const candidate = cloneImageData(imageData);
    let changedPixels = 0;
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = alphaMap[localIndex] ?? 0;
            if (alpha < minAlpha) continue;

            const pixelIndex = ((position.y + row) * imageData.width + position.x + col) * 4;
            const residual = luminance(imageData.data, pixelIndex) - luminance(priorImageData.data, pixelIndex);
            if (residual >= residualThreshold) continue;

            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(imageData.data[pixelIndex + channel] + 1);
            }
            changedPixels++;
        }
    }

    return {
        imageData: candidate,
        changedPixels,
        minAlpha,
        residualThreshold
    };
}

function effectiveVisible(score) {
    return score?.calibratedVisible ?? score?.visible ?? false;
}

function metricDelta(after, before, key) {
    const afterValue = Number(after?.[key]);
    const beforeValue = Number(before?.[key]);
    if (!Number.isFinite(afterValue) || !Number.isFinite(beforeValue)) return null;
    return round(afterValue - beforeValue, 6);
}

export function classifyResidualCorrectionSafety({ production, score }) {
    const balancedDelta = metricDelta(score, production, 'balancedCost');
    const artifactDelta = metricDelta(score, production, 'visualArtifactCost');
    const clearsVisible = effectiveVisible(score) !== true;
    const improvesBalanced = balancedDelta !== null && balancedDelta < -0.03;
    const artifactWorse = artifactDelta !== null && artifactDelta > 0.05;

    let label = 'quantized-correction-worsens-or-no-safe-candidate';
    if (clearsVisible && improvesBalanced && !artifactWorse) {
        label = 'safe-quantized-body-correction';
    } else if (clearsVisible && artifactWorse) {
        label = 'quantized-correction-clears-but-damages';
    } else if (clearsVisible) {
        label = 'quantized-correction-clears-without-balanced-gain';
    } else if (improvesBalanced) {
        label = 'quantized-correction-still-visible';
    }

    return {
        label,
        clearsVisible,
        improvesBalanced,
        artifactWorse,
        balancedDelta,
        artifactDelta
    };
}

export function shouldApplyQuantizedBodyCorrection({
    classification,
    production,
    taxonomy
}) {
    return (
        classification?.label === 'over-subtracted-alpha-body' &&
        effectiveVisible(production) === true &&
        taxonomy?.algorithmicResidualCandidate === true
    );
}

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function scoreCandidate({ imageData, originalImageData, alphaMap, position, alphaGain = 1 }) {
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
    const visibility = assessWatermarkResidualVisibility({
        imageData,
        alphaMap,
        position
    });
    const calibratedVisibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        alphaMap,
        position,
        alphaGain
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap,
        position,
        alphaGain
    });
    const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const balanced = scoreBalancedVisualCandidate({
        processedSpatial: spatial,
        processedGradient: gradient,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum,
        visualArtifactCost: artifacts?.visualArtifactCost
    });

    return {
        spatial: round(spatial),
        gradient: round(gradient),
        residualCost: round(Math.abs(spatial) + Math.max(0, gradient) * 0.6),
        balancedCost: round(balanced.score),
        visibilitySeverity: round(visibilitySeverity(visibility)),
        visible: visibility.visible,
        rawVisible: calibratedVisibility?.rawVisible ?? visibility.visible,
        calibratedVisible: calibratedVisibility?.calibratedVisible ?? visibility.visible,
        metricRisk: calibratedVisibility?.metricRisk ?? null,
        nearBlackRatio: round(calculateNearBlackRatio(imageData, position)),
        darkHaloLum: round(darkHaloLum, 3),
        newlyClippedRatio: round(artifacts?.newlyClippedRatio),
        visualArtifactCost: round(artifacts?.visualArtifactCost)
    };
}

function resolveAlphaMap(size, alphaMaps) {
    if (size === 48) return alphaMaps.alpha48;
    if (size === 96) return alphaMaps.alpha96;
    if (!alphaMaps.cache.has(size)) {
        alphaMaps.cache.set(size, interpolateAlphaMap(alphaMaps.alpha96, 96, size));
    }
    return alphaMaps.cache.get(size);
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    return {
        alpha48,
        alpha96,
        alpha96NewMargin,
        cache: new Map()
    };
}

async function analyzeRecord({ record, alphaMaps, priorRadius }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const production = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48: alphaMaps.alpha48,
        alpha96: alphaMaps.alpha96,
        alpha96Variants: {
            '20260520': alphaMaps.alpha96NewMargin
        },
        getAlphaMap(size) {
            return resolveAlphaMap(size, alphaMaps);
        }
    });
    const position = production.meta.position ?? record.productionPosition ?? record.bestEvidence?.position;
    const alphaMap = resolveAlphaMap(position.width, alphaMaps);
    const priorImageData = buildPreviewNeighborhoodPrior({
        previewImageData: production.imageData,
        position,
        radius: priorRadius
    });
    const bands = analyzeResidualBands({
        imageData: production.imageData,
        priorImageData,
        alphaMap,
        position
    });
    const classification = classifyResidualProfile({ bands });
    const edgeStructure = measureAlphaEdgeStructureOverlap({
        imageData: production.imageData,
        alphaMap,
        position
    });
    const productionScore = scoreCandidate({
        imageData: production.imageData,
        originalImageData,
        alphaMap,
        position,
        alphaGain: production.meta.alphaGain ?? 1
    });
    let correction = null;
    const correctionEligible = shouldApplyQuantizedBodyCorrection({
        classification,
        production: productionScore,
        taxonomy: record.taxonomy
    });
    if (correctionEligible) {
        const correctionResult = applyQuantizedBodyResidualCorrection({
            imageData: production.imageData,
            priorImageData,
            alphaMap,
            position
        });
        const score = scoreCandidate({
            imageData: correctionResult.imageData,
            originalImageData,
            alphaMap,
            position,
            alphaGain: production.meta.alphaGain ?? 1
        });
        correction = {
            type: 'quantized-body-residual-correction',
            changedPixels: correctionResult.changedPixels,
            minAlpha: correctionResult.minAlpha,
            residualThreshold: correctionResult.residualThreshold,
            score,
            safety: classifyResidualCorrectionSafety({
                production: productionScore,
                score
            })
        };
    }

    return {
        file: record.file,
        filePath: record.filePath,
        width: record.width,
        height: record.height,
        source: record.source,
        taxonomy: record.taxonomy,
        production: productionScore,
        currentRecordProduction: record.production,
        position,
        alphaMapSize: position.width,
        priorRadius,
        bands,
        classification,
        edgeStructure,
        edgeStructureRisk: classifyEdgeStructureRisk({
            taxonomy: record.taxonomy,
            production: productionScore,
            residualProfile: classification,
            edgeStructure
        }),
        correctionEligible,
        correction
    };
}

export function summarizeResidualProfileRecords(records) {
    const safeCorrectionRecords = records.filter((record) => (
        record.correction?.safety?.label === 'safe-quantized-body-correction'
    ));
    return {
        total: records.length,
        priorReliableCount: records.filter((record) => record.classification?.priorReliable).length,
        safeCorrectionCount: safeCorrectionRecords.length,
        labelCounts: countBy(records, (record) => record.classification?.label ?? 'unknown'),
        correctionSafetyCounts: countBy(
            records.filter((record) => record.correction),
            (record) => record.correction.safety.label
        ),
        safeCorrectionTaxonomyCounts: countBy(
            safeCorrectionRecords,
            (record) => record.taxonomy?.label ?? 'unknown'
        ),
        edgeStructureRiskCounts: countBy(
            records,
            (record) => record.edgeStructureRisk?.label ?? 'unknown'
        )
    };
}

export function selectResidualProfileRecords({
    records,
    scope = DEFAULT_SCOPE,
    filePattern = null
}) {
    const matcher = filePattern ? new RegExp(filePattern) : null;
    return records
        .filter((record) => (
            scope === 'all' ||
            record.taxonomy?.algorithmicResidualCandidate
        ))
        .filter((record) => !matcher || matcher.test(record.file));
}

function createMarkdown({ summary, outputDir, records }) {
    return [
        '# Metric 48/96/96 Residual Profile Probe',
        '',
        `- total: ${summary.total}`,
        `- prior reliable: ${summary.priorReliableCount}`,
        `- safe correction: ${summary.safeCorrectionCount}`,
        '',
        '## Profile Labels',
        '',
        ...Object.entries(summary.labelCounts).map(([label, count]) => `- ${label}: ${count}`),
        '',
        '## Safe Correction Taxonomy',
        '',
        ...Object.entries(summary.safeCorrectionTaxonomyCounts).map(([label, count]) => `- ${label}: ${count}`),
        '',
        '## Edge Structure Risk',
        '',
        ...Object.entries(summary.edgeStructureRiskCounts).map(([label, count]) => `- ${label}: ${count}`),
        '',
        '## Records',
        '',
        ...records.map((record) => {
            const low = record.bands.find((band) => band.key === 'low');
            const body = record.bands.find((band) => band.key === 'body');
            const correction = record.correction
                ? `, correction=${record.correction.safety.label}, changed=${record.correction.changedPixels}`
                : '';
            const edge = record.edgeStructure
                ? `, edgeRatio=${record.edgeStructure.edgeToNonEdgeRatio}`
                : '';
            return `- ${record.file}: ${record.classification.label}, lowAbs=${low?.meanAbsResidual}, bodyMean=${body?.meanResidual}, reason=${record.classification.reason}${edge}${correction}`;
        }),
        '',
        `Artifacts: ${outputDir}`,
        ''
    ].join('\n');
}

export async function createMetric489696ResidualProfileProbe(options = {}) {
    const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const filePattern = options.filePattern ?? DEFAULT_FILE_PATTERN;
    const scope = options.scope ?? DEFAULT_SCOPE;
    const priorRadius = options.priorRadius ?? DEFAULT_PRIOR_RADIUS;
    await mkdir(outputDir, { recursive: true });

    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    const records = selectResidualProfileRecords({
        records: report.records ?? [],
        scope,
        filePattern
    });
    const alphaMaps = await loadAlphaMaps();
    const analyzed = [];
    for (const record of records) {
        console.log(`[residual-profile] ${record.file}`);
        analyzed.push(await analyzeRecord({ record, alphaMaps, priorRadius }));
    }
    const summary = summarizeResidualProfileRecords(analyzed);
    const result = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        filePattern,
        scope,
        priorRadius,
        summary,
        records: analyzed
    };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'summary.md'), createMarkdown({
        summary,
        outputDir,
        records: analyzed
    }), 'utf8');
    return result;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const result = await createMetric489696ResidualProfileProbe(args);
    console.log(JSON.stringify({
        outputDir: result.outputDir,
        summary: result.summary
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
