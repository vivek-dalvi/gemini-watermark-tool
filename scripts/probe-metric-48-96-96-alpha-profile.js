import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessCalibratedWatermarkResidualVisibility,
    assessRemovalDiffArtifacts,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from '../src/core/adaptiveDetector.js';
import { calculateNearBlackRatio } from '../src/core/candidateSelector.js';
import { scoreBalancedVisualCandidate } from '../src/core/watermarkScoring.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/gemini-watermark-metric-study/balanced-final/latest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-study/metric-48-96-96-alpha-profile');
const DEFAULT_LIMIT = Infinity;
const TILE_SIZE = 180;
const LABEL_HEIGHT = 54;
const HEADER_HEIGHT = 62;
const ROW_GAP = 12;
const BACKGROUND = '#171717';
const ALPHA_GAINS = Object.freeze([0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.1, 1.15, 1.3]);
const PROFILE_VARIANTS = Object.freeze([
    { name: 'base', type: 'identity' },
    { name: 'edge-dampen-0.82', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.82 },
    { name: 'edge-dampen-0.88', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.88 },
    { name: 'edge-boost-1.12', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.12 },
    { name: 'edge-boost-1.24', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.24 },
    { name: 'mid-dampen-0.88', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 0.88 },
    { name: 'mid-boost-1.08', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.08 },
    { name: 'mid-boost-1.16', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.16 },
    { name: 'mid-boost-1.24', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.24 },
    { name: 'core-dampen-0.9', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 0.9 },
    { name: 'core-boost-1.1', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 1.1 },
    { name: 'power-0.88', type: 'power', exponent: 0.88 },
    { name: 'power-0.94', type: 'power', exponent: 0.94 },
    { name: 'power-1.08', type: 'power', exponent: 1.08 },
    { name: 'blur-mix-0.2', type: 'blur-mix', mix: 0.2 },
    { name: 'blur-mix-0.35', type: 'blur-mix', mix: 0.35 },
    { name: 'sharpen-0.25', type: 'sharpen', amount: 0.25 }
]);
const REFERENCE = Object.freeze({ profileName: 'power-0.88', alphaGain: 0.55 });

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: DEFAULT_LIMIT,
        renderLimit: 18,
        filePattern: null
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
            continue;
        }
        if (arg === '--file-pattern') {
            parsed.filePattern = args.shift() || null;
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

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function blurAlphaMap(alphaMap, width, height) {
    const blurred = new Float32Array(alphaMap.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const sourceY = y + dy;
                if (sourceY < 0 || sourceY >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    if (sourceX < 0 || sourceX >= width) continue;
                    sum += alphaMap[sourceY * width + sourceX];
                    count++;
                }
            }
            blurred[y * width + x] = count > 0 ? sum / count : alphaMap[y * width + x];
        }
    }
    return blurred;
}

function transformAlphaMap(alphaMap, width, height, variant) {
    if (variant.type === 'identity') return alphaMap;
    const transformed = new Float32Array(alphaMap.length);
    if (variant.type === 'band-scale') {
        for (let index = 0; index < alphaMap.length; index++) {
            const alpha = alphaMap[index];
            transformed[index] = alpha >= variant.minAlpha && alpha <= variant.maxAlpha
                ? clampAlpha(alpha * variant.scale)
                : alpha;
        }
        return transformed;
    }
    if (variant.type === 'power') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(Math.pow(alphaMap[index], variant.exponent));
        }
        return transformed;
    }

    const blurred = blurAlphaMap(alphaMap, width, height);
    if (variant.type === 'blur-mix') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] * (1 - variant.mix) + blurred[index] * variant.mix);
        }
        return transformed;
    }
    if (variant.type === 'sharpen') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] + (alphaMap[index] - blurred[index]) * variant.amount);
        }
        return transformed;
    }
    return alphaMap;
}

export function resolveRecordConfig(record) {
    if (record.config) return record.config;
    if (record.productionConfig) return record.productionConfig;
    if (record.baseline) {
        return {
            logoSize: record.baseline.logoSize ?? record.baseline.size,
            marginRight: record.baseline.marginRight,
            marginBottom: record.baseline.marginBottom
        };
    }
    if (record.bestEvidence) {
        return {
            logoSize: record.bestEvidence.logoSize ?? record.bestEvidence.size,
            marginRight: record.bestEvidence.marginRight,
            marginBottom: record.bestEvidence.marginBottom
        };
    }
    return null;
}

export function resolvePosition(record, imageData) {
    const position = record.position ??
        record.productionPosition ??
        record.baseline?.position ??
        record.bestEvidence?.position ??
        record.bestRemoval?.position;
    if (position?.width === 48 && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        return position;
    }
    return {
        x: imageData.width - 96 - 48,
        y: imageData.height - 96 - 48,
        width: 48,
        height: 48
    };
}

function residualSeverity(score) {
    return Math.abs(score.spatial) + Math.max(0, score.gradient) * 0.6;
}

function effectiveVisible(score) {
    return score?.calibratedVisible ?? score?.visible ?? false;
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function metricDelta(after, before, key) {
    const afterValue = finiteNumber(after?.[key]);
    const beforeValue = finiteNumber(before?.[key]);
    if (afterValue === null || beforeValue === null) return null;
    return afterValue - beforeValue;
}

export function classifyProfileTrialSafety({ production, score }) {
    const balancedDelta = metricDelta(score, production, 'balancedCost');
    const artifactDelta = metricDelta(score, production, 'visualArtifactCost');
    const clearsVisible = effectiveVisible(score) !== true;
    const improvesBalanced = balancedDelta !== null && balancedDelta < -0.03;
    const artifactWorse = artifactDelta !== null && artifactDelta > 0.05;

    let label = 'profile-worsens-or-no-safe-candidate';
    if (clearsVisible && improvesBalanced && !artifactWorse) {
        label = 'safe-profile-improvement';
    } else if (clearsVisible && artifactWorse) {
        label = 'profile-clears-but-damages';
    } else if (clearsVisible) {
        label = 'profile-clears-without-balanced-gain';
    } else if (improvesBalanced) {
        label = 'profile-improves-still-visible';
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

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

export function scoreCandidate({ imageData, originalImageData, alphaMapForScoring, alphaMapForDiff, position, alphaGain }) {
    const spatial = computeRegionSpatialCorrelation({
        imageData,
        alphaMap: alphaMapForScoring,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const gradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap: alphaMapForScoring,
        region: { x: position.x, y: position.y, size: position.width }
    });
    const visibility = assessWatermarkResidualVisibility({
        imageData,
        alphaMap: alphaMapForScoring,
        position
    });
    const calibratedVisibility = assessCalibratedWatermarkResidualVisibility({
        imageData,
        originalImageData,
        alphaMap: alphaMapForScoring,
        position,
        alphaGain
    });
    const artifacts = assessRemovalDiffArtifacts({
        originalImageData,
        candidateImageData: imageData,
        alphaMap: alphaMapForDiff,
        position,
        alphaGain
    });
    const darkHaloLum = Math.max(0, -(artifacts?.halo?.deltaLum ?? 0));
    const nearBlackRatio = calculateNearBlackRatio(imageData, position);
    const baselineNearBlackRatio = calculateNearBlackRatio(originalImageData, position);
    const nearBlackIncrease = nearBlackRatio - baselineNearBlackRatio;
    const balanced = scoreBalancedVisualCandidate({
        processedSpatial: spatial,
        processedGradient: gradient,
        nearBlackIncrease,
        newlyClippedRatio: artifacts?.newlyClippedRatio,
        darkHaloLum,
        visualArtifactCost: artifacts?.visualArtifactCost
    });
    return {
        spatial,
        gradient,
        residualCost: residualSeverity({ spatial, gradient }),
        balancedCost: balanced.score,
        visibilitySeverity: visibilitySeverity(visibility),
        visible: visibility.visible,
        rawVisible: calibratedVisibility?.rawVisible ?? visibility.visible,
        calibratedVisible: calibratedVisibility?.calibratedVisible ?? visibility.visible,
        metricRisk: calibratedVisibility?.metricRisk ?? null,
        nearBlackRatio,
        baselineNearBlackRatio,
        nearBlackIncrease,
        darkHaloLum,
        newlyClippedRatio: artifacts?.newlyClippedRatio ?? null,
        visualArtifactCost: artifacts?.visualArtifactCost ?? null
    };
}

function summarizeScore(score) {
    return {
        spatial: round(score.spatial),
        gradient: round(score.gradient),
        residualCost: round(score.residualCost),
        balancedCost: round(score.balancedCost),
        visibilitySeverity: round(score.visibilitySeverity),
        visible: score.visible,
        rawVisible: score.rawVisible ?? score.visible,
        calibratedVisible: score.calibratedVisible ?? score.visible,
        metricRisk: score.metricRisk ?? null,
        nearBlackRatio: round(score.nearBlackRatio),
        baselineNearBlackRatio: round(score.baselineNearBlackRatio),
        nearBlackIncrease: round(score.nearBlackIncrease),
        darkHaloLum: round(score.darkHaloLum, 3),
        newlyClippedRatio: round(score.newlyClippedRatio),
        visualArtifactCost: round(score.visualArtifactCost)
    };
}

function selectBestTrial(trials) {
    return [...trials].sort((left, right) => (
        left.score.balancedCost - right.score.balancedCost ||
        left.score.visibilitySeverity - right.score.visibilitySeverity ||
        left.score.residualCost - right.score.residualCost
    ))[0] ?? null;
}

function selectBestVisibleTrial(trials) {
    return [...trials]
        .filter((trial) => effectiveVisible(trial.score) !== true)
        .sort((left, right) => (
            left.score.balancedCost - right.score.balancedCost ||
            left.score.residualCost - right.score.residualCost
        ))[0] ?? null;
}

function selectBestSafeTrial(trials) {
    return [...trials]
        .filter((trial) => trial.safety.label === 'safe-profile-improvement')
        .sort((left, right) => (
            left.score.balancedCost - right.score.balancedCost ||
            left.score.residualCost - right.score.residualCost
        ))[0] ?? null;
}

async function analyzeRecord({ record, alpha48, alpha96, alpha96NewMargin, profileMaps }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const position = resolvePosition(record, originalImageData);
    const production = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return alpha48;
        }
    });
    const productionScore = scoreCandidate({
        imageData: production.imageData,
        originalImageData,
        alphaMapForScoring: alpha48,
        alphaMapForDiff: alpha48,
        position,
        alphaGain: production.meta.alphaGain ?? record.alphaGain ?? 1
    });
    const trials = [];
    for (const variant of PROFILE_VARIANTS) {
        const alphaMap = profileMaps.get(variant.name);
        for (const alphaGain of ALPHA_GAINS) {
            const candidate = cloneImageData(originalImageData);
            removeWatermark(candidate, alphaMap, position, { alphaGain });
            const score = scoreCandidate({
                imageData: candidate,
                originalImageData,
                alphaMapForScoring: alpha48,
                alphaMapForDiff: alphaMap,
                position,
                alphaGain
            });
            trials.push({
                profileName: variant.name,
                alphaGain,
                score,
                safety: classifyProfileTrialSafety({ production: productionScore, score })
            });
        }
    }
    const best = selectBestTrial(trials);
    const bestNonVisible = selectBestVisibleTrial(trials);
    const bestSafe = selectBestSafeTrial(trials);
    const reference = trials.find((trial) => (
        trial.profileName === REFERENCE.profileName &&
        trial.alphaGain === REFERENCE.alphaGain
    ));

    return {
        file: record.file,
        filePath: record.filePath,
        width: record.width,
        height: record.height,
        source: record.source,
        position,
        production: summarizeScore(productionScore),
        currentRecordProduction: record.production,
        best: best ? {
            profileName: best.profileName,
            alphaGain: best.alphaGain,
            score: summarizeScore(best.score),
            safety: best.safety
        } : null,
        bestNonVisible: bestNonVisible ? {
            profileName: bestNonVisible.profileName,
            alphaGain: bestNonVisible.alphaGain,
            score: summarizeScore(bestNonVisible.score),
            safety: bestNonVisible.safety
        } : null,
        bestSafe: bestSafe ? {
            profileName: bestSafe.profileName,
            alphaGain: bestSafe.alphaGain,
            score: summarizeScore(bestSafe.score),
            safety: bestSafe.safety
        } : null,
        reference: reference ? {
            profileName: reference.profileName,
            alphaGain: reference.alphaGain,
            score: summarizeScore(reference.score),
            safety: reference.safety
        } : null,
        trials: trials.map((trial) => ({
            profileName: trial.profileName,
            alphaGain: trial.alphaGain,
            score: summarizeScore(trial.score),
            safety: trial.safety
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

export function summarizeProfileRecords(records) {
    const bestProfiles = new Map();
    const bestNonVisibleProfiles = new Map();
    for (const record of records) {
        const bestKey = record.best ? `${record.best.profileName}@${record.best.alphaGain}` : 'none';
        bestProfiles.set(bestKey, (bestProfiles.get(bestKey) ?? 0) + 1);
        const nonVisibleKey = record.bestNonVisible
            ? `${record.bestNonVisible.profileName}@${record.bestNonVisible.alphaGain}`
            : 'none';
        bestNonVisibleProfiles.set(nonVisibleKey, (bestNonVisibleProfiles.get(nonVisibleKey) ?? 0) + 1);
    }
    const productionVisible = records.filter((record) => record.production.visible).length;
    const productionCalibratedVisible = records.filter((record) => effectiveVisible(record.production)).length;
    const bestVisible = records.filter((record) => effectiveVisible(record.best?.score)).length;
    const bestNonVisibleCount = records.filter((record) => record.bestNonVisible).length;
    const bestSafeCount = records.filter((record) => record.bestSafe).length;
    const referenceVisible = records.filter((record) => effectiveVisible(record.reference?.score)).length;
    const referenceBetterThanProduction = records.filter((record) => (
        Number(record.reference?.score?.balancedCost) < Number(record.production?.balancedCost)
    )).length;

    return {
        total: records.length,
        productionVisible,
        productionCalibratedVisible,
        bestVisible,
        bestNonVisibleCount,
        bestSafeCount,
        referenceVisible,
        referenceBetterThanProduction,
        bestSafetyLabels: countBy(records.filter((record) => record.best), (record) => record.best.safety.label),
        bestNonVisibleSafetyLabels: countBy(records.filter((record) => record.bestNonVisible), (record) => record.bestNonVisible.safety.label),
        referenceSafetyLabels: countBy(records.filter((record) => record.reference), (record) => record.reference.safety.label),
        bestProfiles: Object.fromEntries([...bestProfiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        bestNonVisibleProfiles: Object.fromEntries([...bestNonVisibleProfiles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    };
}

function cropBoxForPosition(position, imageData) {
    const padding = Math.max(28, Math.round(position.width * 0.8));
    const left = Math.max(0, Math.min(imageData.width - 1, Math.round(position.x - padding)));
    const top = Math.max(0, Math.min(imageData.height - 1, Math.round(position.y - padding)));
    const right = Math.min(imageData.width, Math.max(left + 1, Math.round(position.x + position.width + padding)));
    const bottom = Math.min(imageData.height, Math.max(top + 1, Math.round(position.y + position.height + padding)));
    return {
        left,
        top,
        width: right - left,
        height: bottom - top
    };
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
    return {
        width: before.width,
        height: before.height,
        data
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

function grLine(score) {
    return `g=${formatNumber(score?.gradient)} s=${formatNumber(score?.spatial)}`;
}

async function renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, profileMaps }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const position = resolvePosition(record, originalImageData);
    const cropBox = cropBoxForPosition(position, originalImageData);
    const production = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return alpha48;
        }
    });
    const makeCandidate = (trial) => {
        if (!trial) return null;
        const candidate = cloneImageData(originalImageData);
        removeWatermark(candidate, profileMaps.get(trial.profileName), position, { alphaGain: trial.alphaGain });
        return candidate;
    };
    const bestImage = makeCandidate(record.best);
    const nonVisibleImage = makeCandidate(record.bestNonVisible);
    const safeImage = makeCandidate(record.bestSafe);
    const referenceImage = makeCandidate(record.reference);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const productionCrop = cropImageData(production.imageData, cropBox);
    const panels = [
        await imageDataToPanel(beforeCrop, 'before', `${record.width}x${record.height}`, '48/96/96'),
        await imageDataToPanel(productionCrop, 'production', scoreLine(record.production), grLine(record.production)),
        bestImage
            ? await imageDataToPanel(
                cropImageData(bestImage, cropBox),
                `best ${record.best.profileName}`,
                `a=${record.best.alphaGain} ${scoreLine(record.best.score)}`,
                grLine(record.best.score)
            )
            : null,
        nonVisibleImage
            ? await imageDataToPanel(
                cropImageData(nonVisibleImage, cropBox),
                `best clean ${record.bestNonVisible.profileName}`,
                `a=${record.bestNonVisible.alphaGain} ${scoreLine(record.bestNonVisible.score)}`,
                grLine(record.bestNonVisible.score)
            )
            : null,
        safeImage
            ? await imageDataToPanel(
                cropImageData(safeImage, cropBox),
                `best safe ${record.bestSafe.profileName}`,
                `a=${record.bestSafe.alphaGain} ${scoreLine(record.bestSafe.score)}`,
                grLine(record.bestSafe.score)
            )
            : null,
        referenceImage
            ? await imageDataToPanel(
                cropImageData(referenceImage, cropBox),
                `ref ${record.reference.profileName}`,
                `a=${record.reference.alphaGain} ${scoreLine(record.reference.score)}`,
                grLine(record.reference.score)
            )
            : null,
        await imageDataToPanel(
            createDiffImageData(beforeCrop, productionCrop),
            'prod diff x5',
            'orange removed',
            'blue added'
        )
    ].filter(Boolean);
    const rowWidth = panels.length * TILE_SIZE;
    const rowHeight = HEADER_HEIGHT + TILE_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 120)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(record.source).slice(0, 120)}</text>` +
        `<text x="10" y="55" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10.5">prodCalVisible=${effectiveVisible(record.production)} bestSafety=${record.best?.safety?.label ?? 'none'} bestSafe=${record.bestSafe ? 'yes' : 'no'}</text>` +
        `</svg>`;
    const rowBuffer = await sharp({
        create: { width: rowWidth, height: rowHeight, channels: 4, background: BACKGROUND }
    })
        .composite([
            { input: Buffer.from(header), left: 0, top: 0 },
            ...panels.map((panel, index) => ({ input: panel, left: index * TILE_SIZE, top: HEADER_HEIGHT }))
        ])
        .png()
        .toBuffer();
    return {
        rowBuffer,
        rowWidth,
        rowHeight
    };
}

async function renderSheet({ records, alpha48, alpha96, alpha96NewMargin, profileMaps, outputPath, renderLimit }) {
    const rows = [];
    for (const record of records.slice(0, renderLimit)) {
        rows.push(await renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, profileMaps }));
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
    return {
        outputPath,
        count: rows.length,
        width,
        height
    };
}

function createMarkdown({ summary, outputDir }) {
    return [
        '# Metric 48/96/96 Alpha Profile Probe',
        '',
        `- total: ${summary.total}`,
        `- production visible: ${summary.productionVisible}`,
        `- production calibrated visible: ${summary.productionCalibratedVisible}`,
        `- best visible: ${summary.bestVisible}`,
        `- best non-visible available: ${summary.bestNonVisibleCount}`,
        `- best safe profile improvements: ${summary.bestSafeCount}`,
        `- reference visible: ${summary.referenceVisible}`,
        `- reference better than production: ${summary.referenceBetterThanProduction}`,
        '',
        '## Best Safety Labels',
        '',
        ...Object.entries(summary.bestSafetyLabels).slice(0, 12).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Non-Visible Safety Labels',
        '',
        ...Object.entries(summary.bestNonVisibleSafetyLabels).slice(0, 12).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Profiles',
        '',
        ...Object.entries(summary.bestProfiles).slice(0, 12).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Non-Visible Profiles',
        '',
        ...Object.entries(summary.bestNonVisibleProfiles).slice(0, 12).map(([key, count]) => `- ${key}: ${count}`),
        '',
        `Artifacts: ${outputDir}`,
        ''
    ].join('\n');
}

export async function probeMetric489696AlphaProfile(options = {}) {
    const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const renderLimit = options.renderLimit ?? 18;
    const filePattern = options.filePattern ? new RegExp(options.filePattern) : null;
    await mkdir(outputDir, { recursive: true });
    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const profileMaps = new Map(PROFILE_VARIANTS.map((variant) => [
        variant.name,
        transformAlphaMap(alpha48, 48, 48, variant)
    ]));
    const targetRecords = (report.records ?? [])
        .filter((record) => {
            const config = resolveRecordConfig(record);
            const isApplied = record.applied !== false;
            return (
                isApplied &&
                (!filePattern || filePattern.test(record.file ?? record.filePath ?? '')) &&
                config?.logoSize === 48 &&
                config?.marginRight === 96 &&
                config?.marginBottom === 96
            );
        })
        .slice(0, limit);
    const records = [];
    for (let index = 0; index < targetRecords.length; index++) {
        console.log(`[48-profile] ${index + 1}/${targetRecords.length} ${targetRecords[index].file}`);
        records.push(await analyzeRecord({
            record: targetRecords[index],
            alpha48,
            alpha96,
            alpha96NewMargin,
            profileMaps
        }));
    }
    const summary = summarizeProfileRecords(records);
    const output = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        geometry: '48/96/96',
        reference: REFERENCE,
        filePattern: options.filePattern ?? null,
        profileVariants: PROFILE_VARIANTS,
        alphaGains: ALPHA_GAINS,
        summary,
        records
    };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'summary.md'), createMarkdown({ summary, outputDir }), 'utf8');
    const sheet = await renderSheet({
        records: records
            .filter((record) => effectiveVisible(record.production) || effectiveVisible(record.best?.score) || effectiveVisible(record.reference?.score))
            .sort((left, right) => (
                Number(right.production.balancedCost ?? 0) - Number(left.production.balancedCost ?? 0)
            )),
        alpha48,
        alpha96,
        alpha96NewMargin,
        profileMaps,
        outputPath: path.join(outputDir, 'profile-sweep-sheet.png'),
        renderLimit
    });
    const withSheet = { ...output, sheet };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(withSheet, null, 2)}\n`, 'utf8');
    return withSheet;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await probeMetric489696AlphaProfile(args);
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
