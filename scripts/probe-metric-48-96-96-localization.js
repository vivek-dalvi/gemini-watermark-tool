import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { calculateNearBlackRatio } from '../src/core/candidateSelector.js';
import { scoreBalancedVisualCandidate } from '../src/core/watermarkScoring.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/gemini-watermark-metric-study/balanced-final/latest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-study/metric-48-96-96-localization');
const DEFAULT_LIMIT = Infinity;
const SIZE_RANGE = Object.freeze({ min: 44, max: 54 });
const MARGIN_RANGE = Object.freeze({ min: 84, max: 108 });
const ALPHA_GAINS = Object.freeze([0.45, 0.55, 0.6, 0.7, 0.85, 1, 1.15]);
const BASELINE = Object.freeze({ size: 48, marginRight: 96, marginBottom: 96 });
const TILE_SIZE = 180;
const LABEL_HEIGHT = 54;
const HEADER_HEIGHT = 62;
const ROW_GAP = 12;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: DEFAULT_LIMIT,
        renderLimit: 24
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
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
            continue;
        }
        if (arg === '--render-limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit >= 0) parsed.renderLimit = Math.floor(limit);
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function escapeSvgText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function geometryKey(candidate) {
    return `${candidate.size}/${candidate.marginRight}/${candidate.marginBottom}`;
}

function geometryDelta(candidate) {
    return {
        size: candidate.size - BASELINE.size,
        marginRight: candidate.marginRight - BASELINE.marginRight,
        marginBottom: candidate.marginBottom - BASELINE.marginBottom
    };
}

function createAlphaResolver(alpha48) {
    const cache = new Map([[48, alpha48]]);
    return (size) => {
        if (cache.has(size)) return cache.get(size);
        const alphaMap = interpolateAlphaMap(alpha48, 48, size);
        cache.set(size, alphaMap);
        return alphaMap;
    };
}

function resolvePosition(imageData, candidate) {
    const x = imageData.width - candidate.marginRight - candidate.size;
    const y = imageData.height - candidate.marginBottom - candidate.size;
    if (x < 0 || y < 0 || x + candidate.size > imageData.width || y + candidate.size > imageData.height) {
        return null;
    }
    return {
        x,
        y,
        width: candidate.size,
        height: candidate.size
    };
}

function evidenceScore({ spatial, gradient }) {
    return Math.max(0, spatial) * 0.42 + Math.max(0, gradient) * 0.58;
}

function scoreEvidence({ imageData, alphaMap, position }) {
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
    return {
        spatial,
        gradient,
        evidenceScore: evidenceScore({ spatial, gradient })
    };
}

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function scoreProcessed({ imageData, originalImageData, alphaMap, position, alphaGain }) {
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
        spatial,
        gradient,
        residualCost: Math.abs(spatial) + Math.max(0, gradient) * 0.6,
        balancedCost: balanced.score,
        visible: visibility.visible,
        rawVisible: calibratedVisibility?.rawVisible ?? visibility.visible,
        calibratedVisible: calibratedVisibility?.calibratedVisible ?? visibility.visible,
        metricRisk: calibratedVisibility?.metricRisk ?? null,
        visibilitySeverity: visibilitySeverity(visibility),
        nearBlackRatio: calculateNearBlackRatio(imageData, position),
        darkHaloLum,
        newlyClippedRatio: artifacts?.newlyClippedRatio ?? null,
        visualArtifactCost: artifacts?.visualArtifactCost ?? null
    };
}

function resolveProductionAlphaMap({ productionMeta, productionPosition, alpha96, resolveAlphaMap, baselineAlphaMap }) {
    if (
        productionMeta?.alphaMapSource === 'alpha96-interpolated' &&
        productionPosition?.width &&
        productionPosition.width !== 96
    ) {
        return interpolateAlphaMap(alpha96, 96, productionPosition.width) ?? baselineAlphaMap;
    }
    return resolveAlphaMap(productionPosition.width) ?? baselineAlphaMap;
}

function summarizeScore(score) {
    return {
        spatial: round(score.spatial),
        gradient: round(score.gradient),
        residualCost: round(score.residualCost),
        balancedCost: round(score.balancedCost),
        evidenceScore: round(score.evidenceScore),
        visible: score.visible ?? null,
        rawVisible: score.rawVisible ?? score.visible ?? null,
        calibratedVisible: score.calibratedVisible ?? score.visible ?? null,
        metricRisk: score.metricRisk ?? null,
        visibilitySeverity: round(score.visibilitySeverity),
        nearBlackRatio: round(score.nearBlackRatio),
        darkHaloLum: round(score.darkHaloLum, 3),
        newlyClippedRatio: round(score.newlyClippedRatio),
        visualArtifactCost: round(score.visualArtifactCost)
    };
}

function scanGeometry({ imageData, resolveAlphaMap }) {
    const candidates = [];
    for (let size = SIZE_RANGE.min; size <= SIZE_RANGE.max; size++) {
        const alphaMap = resolveAlphaMap(size);
        for (let marginRight = MARGIN_RANGE.min; marginRight <= MARGIN_RANGE.max; marginRight++) {
            for (let marginBottom = MARGIN_RANGE.min; marginBottom <= MARGIN_RANGE.max; marginBottom++) {
                const geometry = { size, marginRight, marginBottom };
                const position = resolvePosition(imageData, geometry);
                if (!position) continue;
                const evidence = scoreEvidence({ imageData, alphaMap, position });
                candidates.push({
                    ...geometry,
                    position,
                    evidence
                });
            }
        }
    }
    return candidates.sort((left, right) => right.evidence.evidenceScore - left.evidence.evidenceScore);
}

function selectBestRemoval({ originalImageData, candidates, resolveAlphaMap }) {
    const topCandidates = candidates.slice(0, 16);
    const trials = [];
    for (const candidate of topCandidates) {
        const alphaMap = resolveAlphaMap(candidate.size);
        for (const alphaGain of ALPHA_GAINS) {
            const imageData = cloneImageData(originalImageData);
            removeWatermark(imageData, alphaMap, candidate.position, { alphaGain });
            trials.push({
                ...candidate,
                alphaGain,
                processed: scoreProcessed({
                    imageData,
                    originalImageData,
                    alphaMap,
                    position: candidate.position,
                    alphaGain
                })
            });
        }
    }
    return trials.sort((left, right) => (
        left.processed.balancedCost - right.processed.balancedCost ||
        left.processed.visibilitySeverity - right.processed.visibilitySeverity ||
        left.processed.residualCost - right.processed.residualCost
    ))[0] ?? null;
}

function processProduction({ originalImageData, alpha48, alpha96, alpha96NewMargin }) {
    return processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha48, 48, size);
        }
    });
}

async function analyzeRecord({ record, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const baselinePosition = resolvePosition(originalImageData, BASELINE);
    const baselineAlphaMap = resolveAlphaMap(48);
    const baselineEvidence = scoreEvidence({
        imageData: originalImageData,
        alphaMap: baselineAlphaMap,
        position: baselinePosition
    });
    const production = processProduction({ originalImageData, alpha48, alpha96, alpha96NewMargin });
    const productionConfig = production.meta?.config;
    const productionPosition = production.meta?.position ??
        (productionConfig ? resolvePosition(originalImageData, {
            size: productionConfig.logoSize,
            marginRight: productionConfig.marginRight,
            marginBottom: productionConfig.marginBottom
        }) : null) ??
        baselinePosition;
    const productionAlphaMap = resolveProductionAlphaMap({
        productionMeta: production.meta,
        productionPosition,
        alpha96,
        resolveAlphaMap,
        baselineAlphaMap
    });
    const productionScore = scoreProcessed({
        imageData: production.imageData,
        originalImageData,
        alphaMap: productionAlphaMap,
        position: productionPosition,
        alphaGain: production.meta.alphaGain ?? record.alphaGain ?? 1
    });
    const candidates = scanGeometry({ imageData: originalImageData, resolveAlphaMap });
    const bestEvidence = candidates[0];
    const baselineRank = candidates.findIndex((candidate) => (
        candidate.size === BASELINE.size &&
        candidate.marginRight === BASELINE.marginRight &&
        candidate.marginBottom === BASELINE.marginBottom
    )) + 1;
    const bestRemoval = selectBestRemoval({
        originalImageData,
        candidates,
        resolveAlphaMap
    });
    const drift = geometryDelta(bestEvidence);
    const evidenceGain = bestEvidence.evidence.evidenceScore - baselineEvidence.evidenceScore;
    const removalGain = bestRemoval
        ? productionScore.balancedCost - bestRemoval.processed.balancedCost
        : null;

    return {
        file: record.file,
        filePath: record.filePath,
        width: record.width,
        height: record.height,
        source: record.source,
        productionConfig: productionConfig ? {
            logoSize: productionConfig.logoSize,
            marginRight: productionConfig.marginRight,
            marginBottom: productionConfig.marginBottom
        } : null,
        productionPosition,
        productionAlphaMapSource: production.meta?.alphaMapSource ?? null,
        baseline: {
            ...BASELINE,
            position: baselinePosition,
            evidence: summarizeScore(baselineEvidence),
            rank: baselineRank
        },
        production: summarizeScore(productionScore),
        bestEvidence: {
            size: bestEvidence.size,
            marginRight: bestEvidence.marginRight,
            marginBottom: bestEvidence.marginBottom,
            position: bestEvidence.position,
            drift,
            evidence: summarizeScore(bestEvidence.evidence),
            evidenceGain: round(evidenceGain)
        },
        bestRemoval: bestRemoval ? {
            size: bestRemoval.size,
            marginRight: bestRemoval.marginRight,
            marginBottom: bestRemoval.marginBottom,
            position: bestRemoval.position,
            drift: geometryDelta(bestRemoval),
            alphaGain: bestRemoval.alphaGain,
            evidence: summarizeScore(bestRemoval.evidence),
            processed: summarizeScore(bestRemoval.processed),
            removalGain: round(removalGain)
        } : null,
        topEvidence: candidates.slice(0, 8).map((candidate) => ({
            size: candidate.size,
            marginRight: candidate.marginRight,
            marginBottom: candidate.marginBottom,
            drift: geometryDelta(candidate),
            evidence: summarizeScore(candidate.evidence)
        }))
    };
}

function countBy(records, getKey) {
    const counts = new Map();
    for (const record of records) {
        const key = getKey(record);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function summarize(records) {
    const evidenceDrift = records.filter((record) => (
        geometryKey(record.bestEvidence) !== geometryKey(BASELINE) &&
        Number(record.bestEvidence.evidenceGain) > 0.06
    ));
    const removalImproved = records.filter((record) => (
        record.bestRemoval &&
        record.bestRemoval.processed.calibratedVisible !== true &&
        Number(record.bestRemoval.removalGain) > 0.03
    ));
    const productionVisible = records.filter((record) => record.production.visible).length;
    const productionCalibratedVisible = records.filter((record) => record.production.calibratedVisible).length;
    const productionMetricRisk = records.filter((record) => record.production.metricRisk).length;
    const productionVisibleImproved = records.filter((record) => (
        record.production.calibratedVisible &&
        record.bestRemoval &&
        record.bestRemoval.processed.calibratedVisible !== true &&
        Number(record.bestRemoval.removalGain) > 0.03
    ));

    return {
        total: records.length,
        productionVisible,
        productionCalibratedVisible,
        productionMetricRisk,
        evidenceDriftCount: evidenceDrift.length,
        removalImprovedCount: removalImproved.length,
        productionVisibleImprovedCount: productionVisibleImproved.length,
        baselineTop1Count: records.filter((record) => record.baseline.rank === 1).length,
        baselineTop5Count: records.filter((record) => record.baseline.rank > 0 && record.baseline.rank <= 5).length,
        bestEvidenceGeometry: countBy(records, (record) => geometryKey(record.bestEvidence)),
        bestEvidenceDrift: countBy(records, (record) => JSON.stringify(record.bestEvidence.drift)),
        bestRemovalGeometry: countBy(records.filter((record) => record.bestRemoval), (record) => geometryKey(record.bestRemoval)),
        bestRemovalDrift: countBy(records.filter((record) => record.bestRemoval), (record) => JSON.stringify(record.bestRemoval.drift)),
        topProductionVisibleImproved: productionVisibleImproved.slice(0, 20).map((record) => ({
            file: record.file,
            production: record.production,
            bestRemoval: record.bestRemoval
        }))
    };
}

function cropBoxForPositions(imageData, positions) {
    const padding = 36;
    const left = Math.max(0, Math.min(...positions.map((position) => position.x)) - padding);
    const top = Math.max(0, Math.min(...positions.map((position) => position.y)) - padding);
    const right = Math.min(imageData.width, Math.max(...positions.map((position) => position.x + position.width)) + padding);
    const bottom = Math.min(imageData.height, Math.max(...positions.map((position) => position.y + position.height)) + padding);
    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
}

function cropImageData(imageData, cropBox) {
    const data = new Uint8ClampedArray(cropBox.width * cropBox.height * 4);
    for (let row = 0; row < cropBox.height; row++) {
        const sourceStart = ((cropBox.top + row) * imageData.width + cropBox.left) * 4;
        const targetStart = row * cropBox.width * 4;
        data.set(imageData.data.subarray(sourceStart, sourceStart + cropBox.width * 4), targetStart);
    }
    return { width: cropBox.width, height: cropBox.height, data };
}

function createDiffImageData(before, after, gain = 5) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const delta = beforeLum - afterLum;
        const amp = Math.min(255, Math.abs(delta) * gain);
        if (delta >= 0) {
            data[offset] = amp;
            data[offset + 1] = Math.round(amp * 0.48);
            data[offset + 2] = Math.round(amp * 0.14);
        } else {
            data[offset] = Math.round(amp * 0.18);
            data[offset + 1] = Math.round(amp * 0.52);
            data[offset + 2] = amp;
        }
        data[offset + 3] = 255;
    }
    return { width: before.width, height: before.height, data };
}

async function imageDataToPanel(imageData, title, line1 = '', line2 = '') {
    const image = await sharp(Buffer.from(imageData.data), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 }
    })
        .resize(TILE_SIZE, TILE_SIZE, { fit: 'contain', background: '#0d0d0d' })
        .png()
        .toBuffer();
    const label = `<svg width="${TILE_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#101010"/>` +
        `<text x="8" y="17" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(title).slice(0, 32)}</text>` +
        `<text x="8" y="35" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 42)}</text>` +
        `<text x="8" y="50" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(line2).slice(0, 42)}</text>` +
        `</svg>`;
    return sharp({
        create: { width: TILE_SIZE, height: TILE_SIZE + LABEL_HEIGHT, channels: 4, background: BACKGROUND }
    })
        .composite([
            { input: image, left: 0, top: 0 },
            { input: Buffer.from(label), left: 0, top: TILE_SIZE }
        ])
        .png()
        .toBuffer();
}

function scoreLine(score) {
    return `b=${formatNumber(score?.balancedCost)} r=${formatNumber(score?.residualCost)}`;
}

function evidenceLine(score) {
    return `e=${formatNumber(score?.evidenceScore)} g=${formatNumber(score?.gradient)}`;
}

async function renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const production = processProduction({ originalImageData, alpha48, alpha96, alpha96NewMargin });
    const baselineImage = cloneImageData(originalImageData);
    removeWatermark(baselineImage, resolveAlphaMap(48), record.baseline.position, { alphaGain: 1 });
    const bestImage = cloneImageData(originalImageData);
    removeWatermark(
        bestImage,
        resolveAlphaMap(record.bestRemoval.size),
        record.bestRemoval.position,
        { alphaGain: record.bestRemoval.alphaGain }
    );
    const cropBox = cropBoxForPositions(originalImageData, [
        record.baseline.position,
        record.bestEvidence.position,
        record.bestRemoval.position
    ]);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const productionCrop = cropImageData(production.imageData, cropBox);
    const bestCrop = cropImageData(bestImage, cropBox);
    const panels = [
        await imageDataToPanel(beforeCrop, 'before', `${record.width}x${record.height}`, '48/96/96 family'),
        await imageDataToPanel(productionCrop, 'production', scoreLine(record.production), `visible=${record.production.visible}`),
        await imageDataToPanel(
            cropImageData(baselineImage, cropBox),
            'baseline 48/96/96',
            evidenceLine(record.baseline.evidence),
            `rank=${record.baseline.rank}`
        ),
        await imageDataToPanel(
            bestCrop,
            `best ${geometryKey(record.bestRemoval)}`,
            `a=${record.bestRemoval.alphaGain} ${scoreLine(record.bestRemoval.processed)}`,
            `drift=${JSON.stringify(record.bestRemoval.drift)}`
        ),
        await imageDataToPanel(createDiffImageData(beforeCrop, bestCrop), 'best diff x5', 'orange removed', 'blue added')
    ];
    const rowWidth = panels.length * TILE_SIZE;
    const rowHeight = HEADER_HEIGHT + TILE_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 110)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(record.source).slice(0, 110)}</text>` +
        `<text x="10" y="55" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10.5">bestEvidence=${geometryKey(record.bestEvidence)} evidenceGain=${record.bestEvidence.evidenceGain} removalGain=${record.bestRemoval.removalGain}</text>` +
        `</svg>`;
    const rowBuffer = await sharp({ create: { width: rowWidth, height: rowHeight, channels: 4, background: BACKGROUND } })
        .composite([
            { input: Buffer.from(header), left: 0, top: 0 },
            ...panels.map((panel, index) => ({ input: panel, left: index * TILE_SIZE, top: HEADER_HEIGHT }))
        ])
        .png()
        .toBuffer();
    return { rowBuffer, rowWidth, rowHeight };
}

async function renderSheet({ records, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap, outputPath, renderLimit }) {
    const selected = records
        .filter((record) => record.bestRemoval)
        .sort((left, right) => (
            Number(right.bestRemoval.removalGain ?? 0) - Number(left.bestRemoval.removalGain ?? 0) ||
            Number(right.bestEvidence.evidenceGain ?? 0) - Number(left.bestEvidence.evidenceGain ?? 0)
        ))
        .slice(0, renderLimit);
    const rows = [];
    for (const record of selected) {
        rows.push(await renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }));
    }
    if (rows.length === 0) return null;
    const width = Math.max(...rows.map((row) => row.rowWidth));
    const height = rows.reduce((sum, row) => sum + row.rowHeight, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.rowBuffer, left: 0, top });
        top += row.rowHeight + ROW_GAP;
    }
    await sharp({ create: { width, height, channels: 4, background: BACKGROUND } })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return { outputPath, count: rows.length, width, height };
}

function createMarkdown({ summary, outputDir }) {
    return [
        '# Metric 48/96/96 Localization Probe',
        '',
        `- total: ${summary.total}`,
        `- production visible: ${summary.productionVisible}`,
        `- production calibrated visible: ${summary.productionCalibratedVisible}`,
        `- production metric risk: ${summary.productionMetricRisk}`,
        `- evidence drift count: ${summary.evidenceDriftCount}`,
        `- removal improved count: ${summary.removalImprovedCount}`,
        `- production visible improved count: ${summary.productionVisibleImprovedCount}`,
        `- baseline top1 count: ${summary.baselineTop1Count}`,
        `- baseline top5 count: ${summary.baselineTop5Count}`,
        '',
        '## Best Evidence Geometry',
        '',
        ...Object.entries(summary.bestEvidenceGeometry).slice(0, 16).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Removal Geometry',
        '',
        ...Object.entries(summary.bestRemovalGeometry).slice(0, 16).map(([key, count]) => `- ${key}: ${count}`),
        '',
        `Artifacts: ${outputDir}`,
        ''
    ].join('\n');
}

export async function probeMetric489696Localization(options = {}) {
    const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const renderLimit = options.renderLimit ?? 24;
    await mkdir(outputDir, { recursive: true });
    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const resolveAlphaMap = createAlphaResolver(alpha48);
    const targetRecords = (report.records ?? [])
        .filter((record) => (
            record.applied &&
            record.config?.logoSize === 48 &&
            record.config?.marginRight === 96 &&
            record.config?.marginBottom === 96
        ))
        .slice(0, limit);
    const records = [];
    for (let index = 0; index < targetRecords.length; index++) {
        console.log(`[48-localization] ${index + 1}/${targetRecords.length} ${targetRecords[index].file}`);
        records.push(await analyzeRecord({
            record: targetRecords[index],
            alpha48,
            alpha96,
            alpha96NewMargin,
            resolveAlphaMap
        }));
    }
    const summary = summarize(records);
    const output = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        geometry: '48/96/96',
        scan: {
            sizeRange: SIZE_RANGE,
            marginRange: MARGIN_RANGE,
            alphaGains: ALPHA_GAINS
        },
        summary,
        records
    };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'summary.md'), createMarkdown({ summary, outputDir }), 'utf8');
    const sheet = await renderSheet({
        records,
        alpha48,
        alpha96,
        alpha96NewMargin,
        resolveAlphaMap,
        outputPath: path.join(outputDir, 'localization-sweep-sheet.png'),
        renderLimit
    });
    const withSheet = { ...output, sheet };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(withSheet, null, 2)}\n`, 'utf8');
    return withSheet;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await probeMetric489696Localization(args);
    console.log(JSON.stringify({
        outputDir: report.outputDir,
        summary: report.summary,
        sheet: report.sheet
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
