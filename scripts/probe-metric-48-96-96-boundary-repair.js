import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
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
import { buildPreviewNeighborhoodPrior } from '../src/core/previewAlphaCalibration.js';
import {
    createAlphaGradientMask,
    getAlphaGradientWeight
} from '../src/core/alphaGradientMask.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/gemini-watermark-metric-study/metric-48-96-96-taxonomy-goal-continue-review-groups/latest.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-study/metric-48-96-96-boundary-repair');
const TILE_SIZE = 180;
const LABEL_HEIGHT = 54;
const HEADER_HEIGHT = 62;
const ROW_GAP = 12;
const BACKGROUND = '#171717';
const DEFAULT_FILE_PATTERN = 'wn0cz5|l8xbiy';
const PRESETS = Object.freeze([
    { name: 'edge-light-r12', radius: 12, minAlpha: 0.01, maxAlpha: 0.22, strength: 0.35, gamma: 0.7 },
    { name: 'edge-mid-r12', radius: 12, minAlpha: 0.01, maxAlpha: 0.30, strength: 0.5, gamma: 0.65 },
    { name: 'edge-strong-r12', radius: 12, minAlpha: 0.01, maxAlpha: 0.38, strength: 0.65, gamma: 0.6 },
    { name: 'body-light-r18', radius: 18, minAlpha: 0.04, maxAlpha: 0.55, strength: 0.35, gamma: 0.75 },
    { name: 'body-mid-r18', radius: 18, minAlpha: 0.04, maxAlpha: 0.65, strength: 0.5, gamma: 0.7 },
    { name: 'body-strong-r18', radius: 18, minAlpha: 0.04, maxAlpha: 0.75, strength: 0.68, gamma: 0.62 },
    { name: 'wide-soft-r24', radius: 24, minAlpha: 0.01, maxAlpha: 0.55, strength: 0.28, gamma: 0.85 },
    { name: 'wide-mid-r24', radius: 24, minAlpha: 0.01, maxAlpha: 0.65, strength: 0.42, gamma: 0.8 },
    { name: 'wide-strong-r24', radius: 24, minAlpha: 0.01, maxAlpha: 0.75, strength: 0.62, gamma: 0.7 },
    {
        name: 'smooth-negative-p2-r18',
        radius: 18,
        minAlpha: 0.04,
        maxAlpha: 0.82,
        strength: 0.75,
        gamma: 0.58,
        passes: 2,
        requiresBoundaryAllowed: true,
        requiresApplicabilityLabels: ['smooth-negative-prior-candidate']
    },
    {
        name: 'smooth-negative-p3-r18',
        radius: 18,
        minAlpha: 0.04,
        maxAlpha: 0.82,
        strength: 0.68,
        gamma: 0.6,
        passes: 3,
        requiresBoundaryAllowed: true,
        requiresApplicabilityLabels: ['smooth-negative-prior-candidate']
    },
    {
        name: 'smooth-negative-wide-p2-r24',
        radius: 24,
        minAlpha: 0.01,
        maxAlpha: 0.82,
        strength: 0.72,
        gamma: 0.62,
        passes: 2,
        requiresBoundaryAllowed: true,
        requiresApplicabilityLabels: ['smooth-negative-prior-candidate']
    },
    {
        name: 'edge-aware-luma-r3',
        method: 'luma-edge',
        minAlpha: 0.01,
        maxAlpha: 0.42,
        referenceAlphaMax: 0.04,
        radius: 3,
        strength: 0.45,
        colorSigma: 18,
        maxDelta: 10,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-aware-luma-r5',
        method: 'luma-edge',
        minAlpha: 0.01,
        maxAlpha: 0.52,
        referenceAlphaMax: 0.05,
        radius: 5,
        strength: 0.55,
        colorSigma: 24,
        maxDelta: 14,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-aware-luma-soft-r7',
        method: 'luma-edge',
        minAlpha: 0.01,
        maxAlpha: 0.58,
        referenceAlphaMax: 0.06,
        radius: 7,
        strength: 0.38,
        colorSigma: 32,
        maxDelta: 12,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-signed-alpha-soft',
        method: 'signed-template',
        minAlpha: 0.01,
        maxAlpha: 0.58,
        strength: 8,
        gamma: 1,
        maxDelta: 5,
        edgeWeightFloor: 0.45,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-signed-alpha-mid',
        method: 'signed-template',
        minAlpha: 0.01,
        maxAlpha: 0.68,
        strength: 12,
        gamma: 0.9,
        maxDelta: 8,
        edgeWeightFloor: 0.35,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-signed-alpha-strong',
        method: 'signed-template',
        minAlpha: 0.01,
        maxAlpha: 0.76,
        strength: 16,
        gamma: 0.85,
        maxDelta: 10,
        edgeWeightFloor: 0.28,
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-luma-r5-signed-vsoft',
        method: 'luma-then-signed-template',
        luma: {
            minAlpha: 0.01,
            maxAlpha: 0.52,
            referenceAlphaMax: 0.05,
            radius: 5,
            strength: 0.55,
            colorSigma: 24,
            maxDelta: 14
        },
        signed: {
            minAlpha: 0.01,
            maxAlpha: 0.58,
            strength: 4,
            gamma: 1,
            maxDelta: 2,
            edgeWeightFloor: 0.55
        },
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-luma-r5-signed-soft',
        method: 'luma-then-signed-template',
        luma: {
            minAlpha: 0.01,
            maxAlpha: 0.52,
            referenceAlphaMax: 0.05,
            radius: 5,
            strength: 0.55,
            colorSigma: 24,
            maxDelta: 14
        },
        signed: {
            minAlpha: 0.01,
            maxAlpha: 0.62,
            strength: 6,
            gamma: 0.95,
            maxDelta: 3,
            edgeWeightFloor: 0.45
        },
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-luma-r5-signed-mid',
        method: 'luma-then-signed-template',
        luma: {
            minAlpha: 0.01,
            maxAlpha: 0.52,
            referenceAlphaMax: 0.05,
            radius: 5,
            strength: 0.55,
            colorSigma: 24,
            maxDelta: 14
        },
        signed: {
            minAlpha: 0.01,
            maxAlpha: 0.66,
            strength: 8,
            gamma: 0.92,
            maxDelta: 4,
            edgeWeightFloor: 0.4
        },
        requiresApplicabilityLabels: ['structured-edge-protected']
    },
    {
        name: 'edge-luma-r7-signed-soft',
        method: 'luma-then-signed-template',
        luma: {
            minAlpha: 0.01,
            maxAlpha: 0.58,
            referenceAlphaMax: 0.06,
            radius: 7,
            strength: 0.38,
            colorSigma: 32,
            maxDelta: 12
        },
        signed: {
            minAlpha: 0.01,
            maxAlpha: 0.62,
            strength: 6,
            gamma: 0.95,
            maxDelta: 3,
            edgeWeightFloor: 0.45
        },
        requiresApplicabilityLabels: ['structured-edge-protected']
    }
]);

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        filePattern: DEFAULT_FILE_PATTERN,
        renderLimit: 8,
        scope: 'algorithmic'
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
            parsed.filePattern = args.shift() || parsed.filePattern;
            continue;
        }
        if (arg === '--render-limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit >= 0) parsed.renderLimit = Math.floor(limit);
            continue;
        }
        if (arg === '--scope') {
            parsed.scope = args.shift() || parsed.scope;
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

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function clampChannel(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function pixelLuminance(data, index) {
    return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
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

export function classifyBoundaryRepairTrialSafety({ production, score }) {
    const balancedDelta = metricDelta(score, production, 'balancedCost');
    const artifactDelta = metricDelta(score, production, 'visualArtifactCost');
    const gradientDelta = metricDelta(score, production, 'gradient');
    const clearsVisible = effectiveVisible(score) !== true;
    const improvesBalanced = balancedDelta !== null && balancedDelta < -0.03;
    const artifactWorse = artifactDelta !== null && artifactDelta > 0.05;
    const improvesStructure = !clearsVisible &&
        !improvesBalanced &&
        !artifactWorse &&
        artifactDelta !== null &&
        artifactDelta < -0.01 &&
        gradientDelta !== null &&
        gradientDelta < -0.015;

    let label = 'boundary-worsens-or-no-safe-candidate';
    if (clearsVisible && improvesBalanced && !artifactWorse) {
        label = 'safe-boundary-repair';
    } else if (clearsVisible && artifactWorse) {
        label = 'boundary-clears-but-damages';
    } else if (clearsVisible) {
        label = 'boundary-clears-without-balanced-gain';
    } else if (improvesBalanced) {
        label = 'boundary-improves-still-visible';
    } else if (improvesStructure) {
        label = 'boundary-structure-improves-still-visible';
    }

    return {
        label,
        clearsVisible,
        improvesBalanced,
        improvesStructure,
        artifactWorse,
        balancedDelta,
        artifactDelta,
        gradientDelta
    };
}

export function classifyBoundaryRepairApplicability(record) {
    const production = record.production ?? {};
    const taxonomyLabel = record.taxonomy?.label ?? '';
    if (
        taxonomyLabel === 'negative-spatial-ghost' ||
        (
            Number(production.spatial) <= -0.16 &&
            Number(production.gradient) < 0.08 &&
            Number(production.visualArtifactCost) <= 0.14
        )
    ) {
        return {
            label: 'smooth-negative-prior-candidate',
            allowBoundaryRepair: true,
            reason: 'negative-spatial-low-gradient'
        };
    }
    if (
        taxonomyLabel === 'edge-gradient-residual' ||
        Number(production.gradient) >= 0.2
    ) {
        return {
            label: 'structured-edge-protected',
            allowBoundaryRepair: false,
            reason: 'high-gradient-structure'
        };
    }
    if (Number(production.nearBlackRatio) >= 0.25) {
        return {
            label: 'low-texture-review-protected',
            allowBoundaryRepair: false,
            reason: 'low-texture-background'
        };
    }
    return {
        label: 'not-boundary-repair-target',
        allowBoundaryRepair: false,
        reason: 'no-supported-boundary-pattern'
    };
}

function resolvePosition(record, imageData) {
    const position = record.productionPosition ?? record.bestRemoval?.position ?? record.baseline?.position;
    if (position?.width && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        return position;
    }
    return {
        x: imageData.width - 96 - 48,
        y: imageData.height - 96 - 48,
        width: 48,
        height: 48
    };
}

function resolveAlphaMap(position, alpha48) {
    if (position.width === 48) return alpha48;
    return interpolateAlphaMap(alpha48, 48, position.width);
}

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function scoreCandidate({ imageData, originalImageData, alphaMap, position, alphaGain }) {
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
        visibilitySeverity: visibilitySeverity(visibility),
        visible: visibility.visible,
        rawVisible: calibratedVisibility?.rawVisible ?? visibility.visible,
        calibratedVisible: calibratedVisibility?.calibratedVisible ?? visibility.visible,
        metricRisk: calibratedVisibility?.metricRisk ?? null,
        nearBlackRatio: calculateNearBlackRatio(imageData, position),
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
        darkHaloLum: round(score.darkHaloLum, 3),
        newlyClippedRatio: round(score.newlyClippedRatio),
        visualArtifactCost: round(score.visualArtifactCost)
    };
}

function applyBoundaryRepair({ productionImageData, priorImageData, alphaMap, position, preset }) {
    const candidate = cloneImageData(productionImageData);
    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.abs(alphaMap[localIndex] ?? 0);
            if (alpha < preset.minAlpha || alpha > preset.maxAlpha) continue;

            const blend = clamp01(Math.pow(alpha, preset.gamma) * preset.strength);
            if (blend <= 0.005) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    productionImageData.data[pixelIndex + channel] * (1 - blend) +
                    priorImageData.data[pixelIndex + channel] * blend
                );
            }
        }
    }
    return candidate;
}

function applyLumaEdgeRepair({ productionImageData, alphaMap, position, preset }) {
    const candidate = cloneImageData(productionImageData);
    const { data, width: imageWidth, height: imageHeight } = productionImageData;
    const regionWidth = position.width;
    const regionHeight = position.height;
    const colorSigmaSafe = Math.max(1, preset.colorSigma ?? 18);
    const radius = Math.max(1, Math.floor(preset.radius ?? 3));
    const edgeMask = createAlphaGradientMask({
        alphaMap,
        width: regionWidth,
        height: regionHeight
    });

    for (let row = 0; row < regionHeight; row++) {
        for (let col = 0; col < regionWidth; col++) {
            const localIndex = row * regionWidth + col;
            const alpha = Math.abs(alphaMap[localIndex] ?? 0);
            if (alpha < preset.minAlpha || alpha > preset.maxAlpha) continue;

            const x = position.x + col;
            const y = position.y + row;
            const pixelIndex = (y * imageWidth + x) * 4;
            const currentLum = pixelLuminance(data, pixelIndex);
            let weightedLum = 0;
            let sumWeight = 0;

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const distanceSquared = dx * dx + dy * dy;
                    if (distanceSquared > radius * radius) continue;

                    const localX = col + dx;
                    const localY = row + dy;
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX < 0 || pixelY < 0 || pixelX >= imageWidth || pixelY >= imageHeight) continue;

                    let neighborAlpha = 0;
                    if (localX >= 0 && localY >= 0 && localX < regionWidth && localY < regionHeight) {
                        neighborAlpha = Math.abs(alphaMap[localY * regionWidth + localX] ?? 0);
                    }
                    if (neighborAlpha > preset.referenceAlphaMax && neighborAlpha >= alpha) continue;

                    const neighborIndex = (pixelY * imageWidth + pixelX) * 4;
                    const neighborLum = pixelLuminance(data, neighborIndex);
                    const colorDistance =
                        Math.abs(data[pixelIndex] - data[neighborIndex]) +
                        Math.abs(data[pixelIndex + 1] - data[neighborIndex + 1]) +
                        Math.abs(data[pixelIndex + 2] - data[neighborIndex + 2]);
                    const colorWeight = Math.exp(
                        -(colorDistance * colorDistance) / (2 * colorSigmaSafe * colorSigmaSafe * 9)
                    );
                    const alphaWeight = neighborAlpha <= preset.referenceAlphaMax ? 1.25 : 0.65;
                    const distanceWeight = 1 / Math.sqrt(distanceSquared);
                    const weight = colorWeight * alphaWeight * distanceWeight;
                    weightedLum += neighborLum * weight;
                    sumWeight += weight;
                }
            }

            if (sumWeight <= 0) continue;

            const targetLum = weightedLum / sumWeight;
            const delta = Math.max(-(preset.maxDelta ?? 10), Math.min(preset.maxDelta ?? 10, targetLum - currentLum));
            const edgeWeight = getAlphaGradientWeight(edgeMask, localIndex);
            const alphaFactor = Math.min(1, alpha / Math.max(preset.maxAlpha, 1e-6));
            const finalDelta = delta * (preset.strength ?? 0.45) * edgeWeight * alphaFactor;
            candidate.data[pixelIndex] = clampChannel(data[pixelIndex] + finalDelta);
            candidate.data[pixelIndex + 1] = clampChannel(data[pixelIndex + 1] + finalDelta);
            candidate.data[pixelIndex + 2] = clampChannel(data[pixelIndex + 2] + finalDelta);
        }
    }

    return candidate;
}

export function applySignedTemplateRepair({ productionImageData, alphaMap, position, preset }) {
    const candidate = cloneImageData(productionImageData);
    const regionWidth = position.width;
    const regionHeight = position.height;
    const edgeMask = createAlphaGradientMask({
        alphaMap,
        width: regionWidth,
        height: regionHeight
    });
    const maxDelta = Math.max(0, preset.maxDelta ?? 6);
    const strength = Math.max(0, preset.strength ?? 8);
    const gamma = Number.isFinite(preset.gamma) && preset.gamma > 0 ? preset.gamma : 1;
    const edgeWeightFloor = Number.isFinite(preset.edgeWeightFloor) ? preset.edgeWeightFloor : 0.35;

    for (let row = 0; row < regionHeight; row++) {
        for (let col = 0; col < regionWidth; col++) {
            const localIndex = row * regionWidth + col;
            const alpha = alphaMap[localIndex] ?? 0;
            const absAlpha = Math.abs(alpha);
            if (absAlpha < preset.minAlpha || absAlpha > preset.maxAlpha) continue;

            const pixelIndex = ((position.y + row) * candidate.width + position.x + col) * 4;
            const edgeWeight = getAlphaGradientWeight(edgeMask, localIndex, edgeWeightFloor);
            const scaled = Math.pow(absAlpha, gamma) * strength * edgeWeight;
            const signedDelta = -Math.sign(alpha || 1) * Math.min(maxDelta, scaled);
            for (let channel = 0; channel < 3; channel++) {
                candidate.data[pixelIndex + channel] = clampChannel(
                    productionImageData.data[pixelIndex + channel] + signedDelta
                );
            }
        }
    }

    return candidate;
}

export function applyLumaThenSignedTemplateRepair({ productionImageData, alphaMap, position, preset }) {
    const lumaImageData = applyLumaEdgeRepair({
        productionImageData,
        alphaMap,
        position,
        preset: preset.luma
    });
    return applySignedTemplateRepair({
        productionImageData: lumaImageData,
        alphaMap,
        position,
        preset: preset.signed
    });
}

function applyBoundaryRepairPreset({ productionImageData, alphaMap, position, preset }) {
    if (preset?.method === 'luma-edge') {
        return applyLumaEdgeRepair({ productionImageData, alphaMap, position, preset });
    }
    if (preset?.method === 'signed-template') {
        return applySignedTemplateRepair({ productionImageData, alphaMap, position, preset });
    }
    if (preset?.method === 'luma-then-signed-template') {
        return applyLumaThenSignedTemplateRepair({ productionImageData, alphaMap, position, preset });
    }

    const passes = Math.max(1, Math.floor(preset?.passes ?? 1));
    let candidateImageData = productionImageData;
    for (let pass = 0; pass < passes; pass++) {
        const priorImageData = buildPreviewNeighborhoodPrior({
            previewImageData: candidateImageData,
            position,
            radius: preset.radius
        });
        candidateImageData = applyBoundaryRepair({
            productionImageData: candidateImageData,
            priorImageData,
            alphaMap,
            position,
            preset
        });
    }
    return candidateImageData;
}

export function resolveBoundaryRepairPresetsForRecord(record, presets = PRESETS) {
    return presets.filter((preset) => (
        (
            preset.requiresBoundaryAllowed !== true ||
            record.repairApplicability?.allowBoundaryRepair === true
        ) &&
        (
            !Array.isArray(preset.requiresApplicabilityLabels) ||
            preset.requiresApplicabilityLabels.length === 0 ||
            preset.requiresApplicabilityLabels.includes(record.repairApplicability?.label)
        )
    ));
}

function selectBestTrial(trials) {
    return [...trials].sort((left, right) => (
        left.score.balancedCost - right.score.balancedCost ||
        left.score.visibilitySeverity - right.score.visibilitySeverity ||
        left.score.residualCost - right.score.residualCost
    ))[0] ?? null;
}

function selectBestSafeTrial(trials) {
    return [...trials]
        .filter((trial) => trial.safety.label === 'safe-boundary-repair')
        .sort((left, right) => (
            left.score.balancedCost - right.score.balancedCost ||
            left.score.visibilitySeverity - right.score.visibilitySeverity ||
            left.score.residualCost - right.score.residualCost
        ))[0] ?? null;
}

export function selectBestStructurePreservingTrial(trials) {
    return [...trials]
        .filter((trial) => (
            trial.safety.label === 'safe-boundary-repair' ||
            trial.safety.label === 'boundary-structure-improves-still-visible'
        ))
        .filter((trial) => trial.safety.artifactWorse !== true)
        .sort((left, right) => (
            (left.safety.label === 'safe-boundary-repair' ? 0 : 1) -
            (right.safety.label === 'safe-boundary-repair' ? 0 : 1) ||
            left.score.visualArtifactCost - right.score.visualArtifactCost ||
            left.score.gradient - right.score.gradient ||
            left.score.balancedCost - right.score.balancedCost
        ))[0] ?? null;
}

async function analyzeRecord({ record, alpha48, alpha96, alpha96NewMargin }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const production = processWatermarkImageData(cloneImageData(originalImageData), {
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
    const position = resolvePosition(record, originalImageData);
    const alphaMap = resolveAlphaMap(position, alpha48);
    const alphaGain = production.meta?.alphaGain ?? record.bestRemoval?.alphaGain ?? 1;
    const productionScore = scoreCandidate({
        imageData: production.imageData,
        originalImageData,
        alphaMap,
        position,
        alphaGain
    });
    const summarizedProduction = summarizeScore(productionScore);
    const repairApplicability = classifyBoundaryRepairApplicability({
        ...record,
        production: summarizedProduction
    });
    const scopedPresets = resolveBoundaryRepairPresetsForRecord({ repairApplicability }, PRESETS);
    const trials = [];
    for (const preset of scopedPresets) {
        const candidateImageData = applyBoundaryRepairPreset({
            productionImageData: production.imageData,
            alphaMap,
            position,
            preset
        });
        const score = scoreCandidate({
            imageData: candidateImageData,
            originalImageData,
            alphaMap,
            position,
            alphaGain
        });
        trials.push({
            preset: preset.name,
            passes: Math.max(1, Math.floor(preset.passes ?? 1)),
            requiresBoundaryAllowed: preset.requiresBoundaryAllowed === true,
            score,
            safety: classifyBoundaryRepairTrialSafety({ production: productionScore, score })
        });
    }
    const best = selectBestTrial(trials);
    const bestSafe = selectBestSafeTrial(trials);
    const bestStructurePreserving = selectBestStructurePreservingTrial(trials);

    return {
        file: record.file,
        filePath: record.filePath,
        width: record.width,
        height: record.height,
        source: record.source,
        taxonomy: record.taxonomy,
        position,
        production: summarizedProduction,
        repairApplicability,
        trialCount: trials.length,
        gatedTrialCount: trials.filter((trial) => trial.requiresBoundaryAllowed).length,
        best: best ? {
            preset: best.preset,
            score: summarizeScore(best.score),
            safety: best.safety
        } : null,
        bestSafe: bestSafe ? {
            preset: bestSafe.preset,
            score: summarizeScore(bestSafe.score),
            safety: bestSafe.safety
        } : null,
        bestStructurePreserving: bestStructurePreserving ? {
            preset: bestStructurePreserving.preset,
            score: summarizeScore(bestStructurePreserving.score),
            safety: bestStructurePreserving.safety
        } : null,
        trials: trials.map((trial) => ({
            preset: trial.preset,
            passes: trial.passes,
            requiresBoundaryAllowed: trial.requiresBoundaryAllowed,
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

export function summarizeBoundaryRepairRecords(records) {
    return {
        total: records.length,
        productionCalibratedVisible: records.filter((record) => effectiveVisible(record.production)).length,
        bestSafeCount: records.filter((record) => record.bestSafe).length,
        repairApplicabilityCounts: countBy(records, (record) => record.repairApplicability?.label ?? 'unknown'),
        boundaryAllowedCount: records.filter((record) => record.repairApplicability?.allowBoundaryRepair === true).length,
        trialCounts: countBy(records, (record) => String(record.trialCount ?? record.trials?.length ?? 0)),
        gatedTrialTotal: records.reduce((sum, record) => sum + (record.gatedTrialCount ?? 0), 0),
        bestSafetyLabels: countBy(records.filter((record) => record.best), (record) => record.best.safety.label),
        bestPresets: countBy(records.filter((record) => record.best), (record) => record.best.preset),
        bestSafePresets: countBy(records.filter((record) => record.bestSafe), (record) => record.bestSafe.preset),
        bestStructurePreservingPresets: countBy(
            records.filter((record) => record.bestStructurePreserving),
            (record) => record.bestStructurePreserving.preset
        )
    };
}

export function selectBoundaryRepairRecords(records, { filePattern, scope = 'algorithmic' } = {}) {
    const pattern = filePattern instanceof RegExp
        ? filePattern
        : new RegExp(filePattern ?? DEFAULT_FILE_PATTERN);
    return records.filter((record) => {
        if (!pattern.test(record.file ?? record.filePath ?? '')) return false;
        if (scope === 'visible') return effectiveVisible(record.production) === true;
        return record.taxonomy?.algorithmicResidualCandidate === true;
    });
}

function cropBoxForPosition(position, imageData) {
    const padding = Math.max(28, Math.round(position.width * 0.8));
    const left = Math.max(0, Math.min(imageData.width - 1, Math.round(position.x - padding)));
    const top = Math.max(0, Math.min(imageData.height - 1, Math.round(position.y - padding)));
    const right = Math.min(imageData.width, Math.max(left + 1, Math.round(position.x + position.width + padding)));
    const bottom = Math.min(imageData.height, Math.max(top + 1, Math.round(position.y + position.height + padding)));
    return { left, top, width: right - left, height: bottom - top };
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

function detailLine(score) {
    return `g=${formatNumber(score?.gradient)} s=${formatNumber(score?.spatial)}`;
}

async function renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const production = processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48,
        alpha96,
        alpha96Variants: { '20260520': alpha96NewMargin },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return interpolateAlphaMap(alpha48, 48, size);
        }
    });
    const alphaMap = resolveAlphaMap(record.position, alpha48);
    const makeCandidate = (trial) => {
        if (!trial) return null;
        const preset = PRESETS.find((candidatePreset) => candidatePreset.name === trial.preset);
        if (!preset) return null;
        return applyBoundaryRepairPreset({
            productionImageData: production.imageData,
            alphaMap,
            position: record.position,
            preset
        });
    };
    const bestImage = makeCandidate(record.best);
    const safeImage = makeCandidate(record.bestSafe);
    const structureImage = makeCandidate(record.bestStructurePreserving);
    const cropBox = cropBoxForPosition(record.position, originalImageData);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const productionCrop = cropImageData(production.imageData, cropBox);
    const panels = [
        await imageDataToPanel(beforeCrop, 'before', `${record.width}x${record.height}`, `${record.position.width}px`),
        await imageDataToPanel(productionCrop, 'production', scoreLine(record.production), detailLine(record.production)),
        bestImage
            ? await imageDataToPanel(
                cropImageData(bestImage, cropBox),
                `best ${record.best.preset}`,
                scoreLine(record.best.score),
                record.best.safety.label
            )
            : null,
        safeImage
            ? await imageDataToPanel(
                cropImageData(safeImage, cropBox),
                `safe ${record.bestSafe.preset}`,
                scoreLine(record.bestSafe.score),
                record.bestSafe.safety.label
            )
            : null,
        structureImage
            ? await imageDataToPanel(
                cropImageData(structureImage, cropBox),
                `struct ${record.bestStructurePreserving.preset}`,
                scoreLine(record.bestStructurePreserving.score),
                record.bestStructurePreserving.safety.label
            )
            : null,
        await imageDataToPanel(createDiffImageData(beforeCrop, productionCrop), 'prod diff x5', 'orange removed', 'blue added')
    ].filter(Boolean);
    const rowWidth = panels.length * TILE_SIZE;
    const rowHeight = HEADER_HEIGHT + TILE_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 120)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(record.taxonomy?.label ?? record.source).slice(0, 120)}</text>` +
        `<text x="10" y="55" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10.5">gate=${record.repairApplicability?.label ?? 'unknown'} prodCalVisible=${effectiveVisible(record.production)} bestSafety=${record.best?.safety?.label ?? 'none'} bestSafe=${record.bestSafe ? 'yes' : 'no'}</text>` +
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

async function renderSheet({ records, alpha48, alpha96, alpha96NewMargin, outputPath, renderLimit }) {
    const rows = [];
    for (const record of records.slice(0, renderLimit)) {
        rows.push(await renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin }));
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
        '# Metric 48/96/96 Boundary Repair Probe',
        '',
        `- total: ${summary.total}`,
        `- production calibrated visible: ${summary.productionCalibratedVisible}`,
        `- best safe boundary repairs: ${summary.bestSafeCount}`,
        `- boundary repair allowed by gate: ${summary.boundaryAllowedCount}`,
        '',
        '## Repair Applicability',
        '',
        ...Object.entries(summary.repairApplicabilityCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Safety Labels',
        '',
        ...Object.entries(summary.bestSafetyLabels).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Presets',
        '',
        ...Object.entries(summary.bestPresets).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Best Safe Presets',
        '',
        ...Object.entries(summary.bestSafePresets).map(([key, count]) => `- ${key}: ${count}`),
        '',
        `Artifacts: ${outputDir}`,
        ''
    ].join('\n');
}

export async function probeMetric489696BoundaryRepair(options = {}) {
    const reportPath = path.resolve(options.reportPath ?? DEFAULT_REPORT_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const filePattern = new RegExp(options.filePattern ?? DEFAULT_FILE_PATTERN);
    const renderLimit = options.renderLimit ?? 8;
    const scope = options.scope ?? 'algorithmic';
    await mkdir(outputDir, { recursive: true });
    const report = JSON.parse(stripBom(await readFile(reportPath, 'utf8')));
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const targetRecords = selectBoundaryRepairRecords(report.records ?? [], { filePattern, scope });
    const records = [];
    for (let index = 0; index < targetRecords.length; index++) {
        console.log(`[48-boundary] ${index + 1}/${targetRecords.length} ${targetRecords[index].file}`);
        records.push(await analyzeRecord({
            record: targetRecords[index],
            alpha48,
            alpha96,
            alpha96NewMargin
        }));
    }
    const summary = summarizeBoundaryRepairRecords(records);
    const output = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        filePattern: options.filePattern ?? DEFAULT_FILE_PATTERN,
        scope,
        presets: PRESETS,
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
        outputPath: path.join(outputDir, 'boundary-repair-sheet.png'),
        renderLimit
    });
    const withSheet = { ...output, sheet };
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify(withSheet, null, 2)}\n`, 'utf8');
    return withSheet;
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await probeMetric489696BoundaryRepair(args);
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
