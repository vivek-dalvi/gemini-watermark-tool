import path from 'node:path';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import { calculateNearBlackRatio } from '../src/core/candidateSelector.js';
import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { scoreBalancedVisualCandidate } from '../src/core/watermarkScoring.js';
import { loadLocalEnv } from './local-env.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

loadLocalEnv();

const DEFAULT_ROOT = path.resolve(process.env.GWR_SAMPLE_ROOT || 'sample-files/gemini-watermark');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-study/latest');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ALPHA_GAINS = Object.freeze([0.6, 0.7, 0.85, 1, 1.1, 1.15, 1.3]);
const SHEET_TILE_SIZE = 220;
const SHEET_LABEL_HEIGHT = 60;
const SHEET_COLUMNS = 4;

function parseArgs(argv) {
    const parsed = {
        root: DEFAULT_ROOT,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: Infinity
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--root') {
            parsed.root = path.resolve(args.shift() || parsed.root);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
        }
    }

    return parsed;
}

async function listImageFiles(root) {
    const files = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const filePath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(filePath);
                continue;
            }
            if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(filePath);
            }
        }
    }
    await walk(root);
    return files.sort((left, right) => left.localeCompare(right));
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function toFixedNumber(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function resolveAlphaMapForConfig(config, alphaMaps) {
    if (!config) return null;
    if (config.alphaVariant === '20260520' && config.logoSize === 96) {
        return alphaMaps.alpha96NewMargin;
    }
    if (config.logoSize === 48) return alphaMaps.alpha48;
    if (config.logoSize === 96) return alphaMaps.alpha96;
    if (config.logoSize === 36 && config.alphaVariant === 'v2') return alphaMaps.alpha36v2;
    return interpolateAlphaMap(alphaMaps.alpha96, 96, config.logoSize);
}

function scoreImageData({ imageData, originalImageData, alphaMap, position, alphaGain = 1 }) {
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
    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
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
    const artifacts = originalImageData
        ? assessRemovalDiffArtifacts({
            originalImageData,
            candidateImageData: imageData,
            alphaMap,
            position,
            alphaGain
        })
        : null;
    const balancedVisual = scoreBalancedVisualCandidate({
        processedSpatial: spatial,
        processedGradient: gradient,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum: Math.max(0, -(artifacts?.halo?.deltaLum ?? 0)),
        visualArtifactCost: artifacts?.visualArtifactCost
    });

    return {
        spatial,
        gradient,
        absSpatial: Math.abs(spatial),
        positiveGradient: Math.max(0, gradient),
        residualCost: Math.abs(spatial) + Math.max(0, gradient) * 0.6,
        balancedVisual,
        nearBlackRatio,
        visibility,
        calibratedVisibility,
        artifacts,
        darkHaloLum: Math.max(0, -(artifacts?.halo?.deltaLum ?? 0)),
        positiveHaloLum: Math.max(0, artifacts?.halo?.deltaLum ?? 0),
        newlyClippedRatio: artifacts?.newlyClippedRatio ?? null,
        visualArtifactCost: artifacts?.visualArtifactCost ?? null
    };
}

function createRemovalCandidate({ originalImageData, alphaMap, position, alphaGain }) {
    const imageData = cloneImageData(originalImageData);
    removeWatermark(imageData, alphaMap, position, { alphaGain });
    return {
        imageData,
        alphaGain,
        score: scoreImageData({
            imageData,
            originalImageData,
            alphaMap,
            position,
            alphaGain
        })
    };
}

function summarizeScore(score) {
    return {
        spatial: toFixedNumber(score?.spatial),
        gradient: toFixedNumber(score?.gradient),
        residualCost: toFixedNumber(score?.residualCost),
        balancedCost: toFixedNumber(score?.balancedVisual?.score),
        nearBlackRatio: toFixedNumber(score?.nearBlackRatio),
        darkHaloLum: toFixedNumber(score?.darkHaloLum, 3),
        positiveHaloLum: toFixedNumber(score?.positiveHaloLum, 3),
        newlyClippedRatio: toFixedNumber(score?.newlyClippedRatio),
        visualArtifactCost: toFixedNumber(score?.visualArtifactCost),
        visible: score?.visibility?.visible ?? null,
        rawVisible: score?.calibratedVisibility?.rawVisible ?? score?.visibility?.visible ?? null,
        calibratedVisible: score?.calibratedVisibility?.calibratedVisible ?? score?.visibility?.visible ?? null,
        metricRisk: score?.calibratedVisibility?.metricRisk ?? null,
        visiblePositiveHalo: score?.visibility?.visiblePositiveHalo ?? null,
        visibleGradientResidual: score?.visibility?.visibleGradientResidual ?? null,
        visibleSpatialResidual: score?.visibility?.visibleSpatialResidual ?? null
    };
}

function classifyRecord({ prodScore, standardScore, prodMeta }) {
    const residualDrop = (standardScore?.residualCost ?? 0) - (prodScore?.residualCost ?? 0);
    const darkHaloIncrease = (prodScore?.darkHaloLum ?? 0) - (standardScore?.darkHaloLum ?? 0);
    const clipIncrease = (prodScore?.newlyClippedRatio ?? 0) - (standardScore?.newlyClippedRatio ?? 0);
    const artifactIncrease = (prodScore?.visualArtifactCost ?? 0) - (standardScore?.visualArtifactCost ?? 0);
    const gradientIncrease = (prodScore?.positiveGradient ?? 0) - (standardScore?.positiveGradient ?? 0);
    const aggressive = String(prodMeta.source || '').includes('located-aggressive');
    const proxyMismatch = residualDrop > 0.03 && (
        darkHaloIncrease > 1.5 ||
        clipIncrease > 0.005 ||
        artifactIncrease > 0.04 ||
        gradientIncrease > 0.03
    );
    const conservativeWouldBeSafer = proxyMismatch && (
        (standardScore?.residualCost ?? Infinity) <= 0.28 ||
        (standardScore?.positiveGradient ?? Infinity) <= 0.04
    );

    return {
        aggressive,
        proxyMismatch,
        conservativeWouldBeSafer,
        residualDrop: toFixedNumber(residualDrop),
        darkHaloIncrease: toFixedNumber(darkHaloIncrease, 3),
        clipIncrease: toFixedNumber(clipIncrease),
        artifactIncrease: toFixedNumber(artifactIncrease),
        gradientIncrease: toFixedNumber(gradientIncrease)
    };
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    return {
        alpha48,
        alpha96,
        alpha96NewMargin,
        alpha36v2: null,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha96, 96, size);
        }
    };
}

function serializeCandidate(candidate) {
    if (!candidate) return null;
    return {
        alphaGain: candidate.alphaGain,
        score: summarizeScore(candidate.score)
    };
}

async function analyzeImage({ filePath, root, alphaMaps }) {
    const originalImageData = await decodeImageDataInNode(filePath);
    const processed = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48: alphaMaps.alpha48,
        alpha96: alphaMaps.alpha96,
        alpha96Variants: alphaMaps.alpha96Variants,
        getAlphaMap: alphaMaps.getAlphaMap
    });
    const prodMeta = processed.meta;
    const position = prodMeta.position;
    const alphaMap = resolveAlphaMapForConfig(prodMeta.config, alphaMaps);
    if (!prodMeta.applied || !position || !alphaMap) {
        return {
            file: path.relative(root, filePath),
            filePath,
            width: originalImageData.width,
            height: originalImageData.height,
            applied: false,
            skipReason: prodMeta.skipReason ?? null
        };
    }

    const originalScore = scoreImageData({
        imageData: originalImageData,
        originalImageData: null,
        alphaMap,
        position
    });
    const prodScore = scoreImageData({
        imageData: processed.imageData,
        originalImageData,
        alphaMap,
        position,
        alphaGain: prodMeta.alphaGain ?? 1
    });
    const candidates = ALPHA_GAINS.map((alphaGain) => createRemovalCandidate({
        originalImageData,
        alphaMap,
        position,
        alphaGain
    }));
    const standardCandidate = candidates.find((candidate) => candidate.alphaGain === 1);
    const bestResidualCandidate = [...candidates].sort((left, right) => (
        left.score.residualCost - right.score.residualCost
    ))[0];
    const bestBalancedCandidate = [...candidates].sort((left, right) => {
        return left.score.balancedVisual.score - right.score.balancedVisual.score;
    })[0];
    const classification = classifyRecord({
        prodScore,
        standardScore: standardCandidate.score,
        prodMeta
    });

    return {
        file: path.relative(root, filePath),
        filePath,
        width: originalImageData.width,
        height: originalImageData.height,
        applied: true,
        source: prodMeta.source || null,
        decisionTier: prodMeta.decisionTier || null,
        config: prodMeta.config ?? null,
        position,
        alphaGain: prodMeta.alphaGain ?? null,
        passCount: prodMeta.passCount ?? null,
        stages: Array.isArray(prodMeta.alphaAdjustmentStages)
            ? prodMeta.alphaAdjustmentStages.map((stage) => stage.stage).filter(Boolean)
            : [],
        original: summarizeScore(originalScore),
        production: summarizeScore(prodScore),
        standardAlpha: serializeCandidate(standardCandidate),
        bestResidual: serializeCandidate(bestResidualCandidate),
        bestBalanced: serializeCandidate(bestBalancedCandidate),
        alphaSweep: candidates.map(serializeCandidate),
        classification
    };
}

function summarize(records) {
    const applied = records.filter((record) => record.applied);
    const byGeometry = new Map();
    const bySource = new Map();
    for (const record of applied) {
        const key = record.config
            ? `${record.config.logoSize}/${record.config.marginRight}/${record.config.marginBottom}${record.config.alphaVariant ? `/${record.config.alphaVariant}` : ''}`
            : 'unknown';
        byGeometry.set(key, (byGeometry.get(key) ?? 0) + 1);
        const source = record.source || 'unknown';
        bySource.set(source, (bySource.get(source) ?? 0) + 1);
    }

    const aggressive = applied.filter((record) => record.classification?.aggressive);
    const proxyMismatch = applied.filter((record) => record.classification?.proxyMismatch);
    const conservativeWouldBeSafer = applied.filter((record) => record.classification?.conservativeWouldBeSafer);
    const visibleAfterProduction = applied.filter((record) => record.production.visible);
    const calibratedVisibleAfterProduction = applied.filter((record) => record.production.calibratedVisible);
    const metricRiskAfterProduction = applied.filter((record) => record.production.metricRisk);

    return {
        total: records.length,
        applied: applied.length,
        skipped: records.length - applied.length,
        aggressiveCount: aggressive.length,
        proxyMismatchCount: proxyMismatch.length,
        conservativeWouldBeSaferCount: conservativeWouldBeSafer.length,
        visibleAfterProductionCount: visibleAfterProduction.length,
        calibratedVisibleAfterProductionCount: calibratedVisibleAfterProduction.length,
        metricRiskAfterProductionCount: metricRiskAfterProduction.length,
        geometryClusters: [...byGeometry.entries()]
            .map(([geometry, count]) => ({ geometry, count }))
            .sort((left, right) => right.count - left.count),
        sourceClusters: [...bySource.entries()]
            .map(([source, count]) => ({ source, count }))
            .sort((left, right) => right.count - left.count),
        topProxyMismatch: proxyMismatch
            .sort((left, right) => (
                (right.classification.artifactIncrease ?? 0) - (left.classification.artifactIncrease ?? 0)
            ))
            .slice(0, 20)
            .map((record) => ({
                file: record.file,
                source: record.source,
                alphaGain: record.alphaGain,
                config: record.config,
                production: record.production,
                standardAlpha: record.standardAlpha,
                classification: record.classification
            }))
    };
}

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function recordsToCsv(records) {
    const columns = [
        'file',
        'width',
        'height',
        'applied',
        'source',
        'geometry',
        'alphaGain',
        'prodSpatial',
        'prodGradient',
        'prodResidualCost',
        'prodRawVisible',
        'prodCalibratedVisible',
        'prodMetricRisk',
        'stdSpatial',
        'stdGradient',
        'stdResidualCost',
        'prodDarkHalo',
        'stdDarkHalo',
        'prodClip',
        'stdClip',
        'prodArtifactCost',
        'stdArtifactCost',
        'aggressive',
        'proxyMismatch',
        'conservativeWouldBeSafer',
        'residualDrop',
        'artifactIncrease'
    ];
    const rows = records.map((record) => {
        const geometry = record.config
            ? `${record.config.logoSize}/${record.config.marginRight}/${record.config.marginBottom}`
            : '';
        return {
            file: record.file,
            width: record.width,
            height: record.height,
            applied: record.applied,
            source: record.source,
            geometry,
            alphaGain: record.alphaGain,
            prodSpatial: record.production?.spatial,
            prodGradient: record.production?.gradient,
            prodResidualCost: record.production?.residualCost,
            prodRawVisible: record.production?.rawVisible,
            prodCalibratedVisible: record.production?.calibratedVisible,
            prodMetricRisk: record.production?.metricRisk,
            stdSpatial: record.standardAlpha?.score?.spatial,
            stdGradient: record.standardAlpha?.score?.gradient,
            stdResidualCost: record.standardAlpha?.score?.residualCost,
            prodDarkHalo: record.production?.darkHaloLum,
            stdDarkHalo: record.standardAlpha?.score?.darkHaloLum,
            prodClip: record.production?.newlyClippedRatio,
            stdClip: record.standardAlpha?.score?.newlyClippedRatio,
            prodArtifactCost: record.production?.visualArtifactCost,
            stdArtifactCost: record.standardAlpha?.score?.visualArtifactCost,
            aggressive: record.classification?.aggressive,
            proxyMismatch: record.classification?.proxyMismatch,
            conservativeWouldBeSafer: record.classification?.conservativeWouldBeSafer,
            residualDrop: record.classification?.residualDrop,
            artifactIncrease: record.classification?.artifactIncrease
        };
    });
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
    ].join('\n') + '\n';
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function calculateCropBox(position, imageData) {
    const padding = Math.max(24, Math.round(position.width * 0.65));
    const left = Math.max(0, Math.min(imageData.width - 1, position.x - padding));
    const top = Math.max(0, Math.min(imageData.height - 1, position.y - padding));
    const right = Math.min(imageData.width, position.x + position.width + padding);
    const bottom = Math.min(imageData.height, position.y + position.height + padding);
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

function createDiffImageData(before, after) {
    const data = new Uint8ClampedArray(before.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const beforeLum = (before.data[offset] + before.data[offset + 1] + before.data[offset + 2]) / 3;
        const afterLum = (after.data[offset] + after.data[offset + 1] + after.data[offset + 2]) / 3;
        const signedDelta = beforeLum - afterLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * 5);
        if (signedDelta >= 0) {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.45);
            data[offset + 2] = Math.round(amplified * 0.15);
        } else {
            data[offset] = Math.round(amplified * 0.2);
            data[offset + 1] = Math.round(amplified * 0.55);
            data[offset + 2] = amplified;
        }
        data[offset + 3] = 255;
    }
    return { width: before.width, height: before.height, data };
}

async function imageDataToBuffer(imageData) {
    return sharp(Buffer.from(imageData.data), {
        raw: { width: imageData.width, height: imageData.height, channels: 4 }
    }).png().toBuffer();
}

async function renderRecordRow({ record, alphaMaps, root }) {
    const originalImageData = await decodeImageDataInNode(path.join(root, record.file));
    const processed = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48: alphaMaps.alpha48,
        alpha96: alphaMaps.alpha96,
        alpha96Variants: alphaMaps.alpha96Variants,
        getAlphaMap: alphaMaps.getAlphaMap
    });
    const alphaMap = resolveAlphaMapForConfig(processed.meta.config, alphaMaps);
    if (!processed.meta.position || !alphaMap) return null;
    const standard = createRemovalCandidate({
        originalImageData,
        alphaMap,
        position: processed.meta.position,
        alphaGain: 1
    });
    const cropBox = calculateCropBox(processed.meta.position, originalImageData);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const standardCrop = cropImageData(standard.imageData, cropBox);
    const prodCrop = cropImageData(processed.imageData, cropBox);
    const diffCrop = createDiffImageData(standardCrop, prodCrop);
    const panels = [
        { title: 'before', image: beforeCrop },
        { title: 'std a=1', image: standardCrop },
        { title: 'prod', image: prodCrop },
        { title: 'std-prod diff', image: diffCrop }
    ];
    const composites = [];
    for (let index = 0; index < panels.length; index++) {
        const panel = panels[index];
        const image = await sharp(await imageDataToBuffer(panel.image))
            .resize(SHEET_TILE_SIZE, SHEET_TILE_SIZE, { fit: 'contain', background: '#111' })
            .png()
            .toBuffer();
        const label = `<svg width="${SHEET_TILE_SIZE}" height="${SHEET_LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
            `<rect width="100%" height="100%" fill="#111"/>` +
            `<text x="8" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="12" font-weight="700">${escapeSvgText(panel.title)}</text>` +
            `<text x="8" y="38" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(record.source || '').slice(0, 34)}</text>` +
            `<text x="8" y="53" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">drop=${record.classification?.residualDrop} art+=${record.classification?.artifactIncrease}</text>` +
            `</svg>`;
        composites.push({ input: image, left: index * SHEET_TILE_SIZE, top: 0 });
        composites.push({ input: Buffer.from(label), left: index * SHEET_TILE_SIZE, top: SHEET_TILE_SIZE });
    }

    const headerHeight = 42;
    const width = panels.length * SHEET_TILE_SIZE;
    const height = headerHeight + SHEET_TILE_SIZE + SHEET_LABEL_HEIGHT;
    const header = `<svg width="${width}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="18" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 120)}</text>` +
        `<text x="10" y="34" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(JSON.stringify(record.config))}</text>` +
        `</svg>`;
    return {
        width,
        height,
        buffer: await sharp({
            create: { width, height, channels: 4, background: '#171717' }
        })
            .composite([
                { input: Buffer.from(header), left: 0, top: 0 },
                ...composites.map((item) => ({ ...item, top: item.top + headerHeight }))
            ])
            .png()
            .toBuffer()
    };
}

async function renderSheet({ records, alphaMaps, root, outputPath }) {
    const rows = [];
    for (const record of records) {
        const row = await renderRecordRow({ record, alphaMaps, root });
        if (row) rows.push(row);
    }
    if (rows.length === 0) return null;
    const gap = 12;
    const width = Math.max(...rows.map((row) => row.width));
    const height = rows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.buffer, left: 0, top });
        top += row.height + gap;
    }
    await sharp({ create: { width, height, channels: 4, background: '#171717' } })
        .composite(composites)
        .png()
        .toFile(outputPath);
    return outputPath;
}

function createMarkdownReport({ summary, outputDir }) {
    const lines = [
        '# Gemini Watermark Metric Study',
        '',
        `- total: ${summary.total}`,
        `- applied: ${summary.applied}`,
        `- skipped: ${summary.skipped}`,
        `- aggressiveCount: ${summary.aggressiveCount}`,
        `- proxyMismatchCount: ${summary.proxyMismatchCount}`,
        `- conservativeWouldBeSaferCount: ${summary.conservativeWouldBeSaferCount}`,
        `- visibleAfterProductionCount: ${summary.visibleAfterProductionCount}`,
        `- calibratedVisibleAfterProductionCount: ${summary.calibratedVisibleAfterProductionCount}`,
        `- metricRiskAfterProductionCount: ${summary.metricRiskAfterProductionCount}`,
        '',
        '## Geometry Clusters',
        '',
        ...summary.geometryClusters.slice(0, 20).map((item) => `- ${item.geometry}: ${item.count}`),
        '',
        '## Source Clusters',
        '',
        ...summary.sourceClusters.slice(0, 20).map((item) => `- ${item.source}: ${item.count}`),
        '',
        '## Top Proxy Mismatch',
        '',
        ...summary.topProxyMismatch.slice(0, 10).map((item) => (
            `- ${item.file}: source=${item.source}, alpha=${item.alphaGain}, ` +
            `drop=${item.classification.residualDrop}, artifact+=${item.classification.artifactIncrease}, ` +
            `dark+=${item.classification.darkHaloIncrease}, clip+=${item.classification.clipIncrease}`
        )),
        '',
        `Artifacts: ${outputDir}`
    ];
    return lines.join('\n') + '\n';
}

export async function runMetricStudy(options = {}) {
    const root = path.resolve(options.root ?? DEFAULT_ROOT);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });
    const alphaMaps = await loadAlphaMaps();
    const files = (await listImageFiles(root)).slice(0, options.limit ?? Infinity);
    const records = [];

    for (let index = 0; index < files.length; index++) {
        const filePath = files[index];
        console.log(`[study] ${index + 1}/${files.length} ${path.relative(root, filePath)}`);
        records.push(await analyzeImage({ filePath, root, alphaMaps }));
    }

    const summary = summarize(records);
    const report = {
        generatedAt: new Date().toISOString(),
        root,
        outputDir,
        summary,
        records
    };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'records.csv'), recordsToCsv(records), 'utf8');
    await writeFile(path.join(outputDir, 'summary.md'), createMarkdownReport({ summary, outputDir }), 'utf8');

    const mismatchRecords = records
        .filter((record) => record.classification?.proxyMismatch)
        .sort((left, right) => (right.classification.artifactIncrease ?? 0) - (left.classification.artifactIncrease ?? 0))
        .slice(0, 12);
    const saferRecords = records
        .filter((record) => record.classification?.conservativeWouldBeSafer)
        .sort((left, right) => (right.classification.artifactIncrease ?? 0) - (left.classification.artifactIncrease ?? 0))
        .slice(0, 12);
    await renderSheet({
        records: mismatchRecords,
        alphaMaps,
        root,
        outputPath: path.join(outputDir, 'proxy-mismatch-sheet.png')
    });
    await renderSheet({
        records: saferRecords,
        alphaMaps,
        root,
        outputPath: path.join(outputDir, 'conservative-safer-sheet.png')
    });

    return report;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await runMetricStudy(args);
    console.log(JSON.stringify({
        outputDir: report.outputDir,
        summary: report.summary
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
