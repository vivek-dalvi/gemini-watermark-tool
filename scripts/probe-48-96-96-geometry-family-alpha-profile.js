import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessReferenceTextureAlignment,
    assessWatermarkResidualVisibility,
    scoreRegion
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-alpha-profile.json'
);
const GEOMETRY_FAMILY = Object.freeze({
    name: '48/96/96',
    logoSize: 48,
    marginRight: 96,
    marginBottom: 96
});
const REFERENCE_CANDIDATE = Object.freeze({
    profileName: 'power-0.88',
    alphaGain: 0.55
});
const TARGET_PROFILE_LINE = '48px-large-margin';
const MAX_SAFE_TEXTURE_PENALTY = 0.2;
const MIN_APPLICABLE_SPATIAL_SCORE = 0.3;
const MIN_APPLICABLE_GRADIENT_SCORE = 0.12;
const ALPHA_GAINS = Object.freeze([0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.15, 1.3]);
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

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        sampleRoot: null
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || '.');
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function resolvePosition(config, imageData) {
    const size = config.logoSize ?? config.size;
    return {
        x: imageData.width - config.marginRight - size,
        y: imageData.height - config.marginBottom - size,
        width: size,
        height: size
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

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function baselineSeverity(record) {
    const metrics = record.metrics ?? record.residualVisibility;
    return visibilitySeverity(metrics);
}

function summarizeVisibility(visibility) {
    return {
        severity: round(visibilitySeverity(visibility)),
        visible: visibility?.visible === true,
        positiveHaloLum: round(visibility?.positiveHaloLum),
        haloVisibility: round(visibility?.haloVisibility),
        spatialResidual: round(visibility?.spatialResidual),
        gradientResidual: round(visibility?.gradientResidual)
    };
}

function summarizeTexture(texture) {
    const texturePenalty = Number(texture.texturePenalty);
    const unsafeTexture =
        Number.isFinite(texturePenalty) &&
        texturePenalty > MAX_SAFE_TEXTURE_PENALTY;
    const unsafeToneShape = texture.tooDark === true && texture.tooFlat === true;
    const hardReject = texture.hardReject === true;
    return {
        safe: !hardReject && !unsafeTexture && !unsafeToneShape,
        hardReject,
        tooDark: texture.tooDark === true,
        tooFlat: texture.tooFlat === true,
        texturePenalty: round(texturePenalty),
        nearBlackIncrease: round(texture.nearBlackIncrease)
    };
}

function summarizeOriginalEvidence(scores) {
    const spatial = Number(scores?.spatialScore);
    const gradient = Number(scores?.gradientScore);
    return {
        spatial: round(spatial),
        gradient: round(gradient),
        applicable: spatial >= MIN_APPLICABLE_SPATIAL_SCORE || gradient >= MIN_APPLICABLE_GRADIENT_SCORE
    };
}

function collectRecords(manifest) {
    return [
        ...(manifest.groups?.metricPassVisible ?? []).map((record) => ({ ...record, sourceSet: 'metricPassVisible' })),
        ...(manifest.groups?.visibleTopPending ?? []).map((record) => ({ ...record, sourceSet: 'visibleTopPending' }))
    ];
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item) ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

async function buildFamilyRecord({ record, sampleRoot, alpha48, transformedAlphaMaps }) {
    const inputPath = path.resolve(sampleRoot, record.file);
    const original = await decodeImageDataInNode(inputPath);
    const position = resolvePosition(GEOMETRY_FAMILY, original);
    const originalEvidence = summarizeOriginalEvidence(scoreRegion(original, alpha48, position));
    const baseline = baselineSeverity(record);
    const trials = [];

    for (const variant of PROFILE_VARIANTS) {
        const alphaMap = transformedAlphaMaps.get(variant.name);
        for (const alphaGain of ALPHA_GAINS) {
            const candidate = cloneImageData(original);
            removeWatermark(candidate, alphaMap, position, { alphaGain });
            const visibility = assessWatermarkResidualVisibility({
                imageData: candidate,
                position,
                alphaMap: alpha48
            });
            const texture = assessReferenceTextureAlignment({
                originalImageData: original,
                candidateImageData: candidate,
                position
            });
            const resultVisibility = summarizeVisibility(visibility);
            const resultTexture = summarizeTexture(texture);
            const severityDelta = Number.isFinite(baseline) && Number.isFinite(resultVisibility.severity)
                ? baseline - resultVisibility.severity
                : null;
            trials.push({
                profileName: variant.name,
                alphaGain,
                visibility: resultVisibility,
                texture: resultTexture,
                improvedSeverity: Number.isFinite(severityDelta) && severityDelta > 0,
                severityDelta: round(severityDelta),
                clearedVisible: originalEvidence.applicable &&
                    resultTexture.safe &&
                    resultVisibility.visible === false
            });
        }
    }

    return {
        file: record.file,
        sourceSet: record.sourceSet ?? null,
        profileLine: record.review?.profileLine ?? 'unknown',
        reviewVerdict: record.review?.verdict ?? 'pending',
        source: record.source ?? null,
        originalConfig: record.config ?? null,
        targetProfileLine: record.review?.profileLine === TARGET_PROFILE_LINE,
        geometryFamilyApplicable: originalEvidence.applicable,
        baseline: {
            severity: round(baseline),
            metrics: record.metrics ?? null
        },
        forcedGeometry: {
            config: GEOMETRY_FAMILY,
            position,
            originalEvidence
        },
        trials
    };
}

function summarizeTrialSet(records, profileName, alphaGain) {
    const trialRecords = records.map((record) => ({
        record,
        trial: record.trials.find((item) => item.profileName === profileName && item.alphaGain === alphaGain)
    })).filter((item) => item.trial);
    const applicable = trialRecords.filter((item) => item.record.geometryFamilyApplicable);
    const nonApplicable = trialRecords.filter((item) => !item.record.geometryFamilyApplicable);
    const targetProfileLine = applicable.filter((item) => item.record.targetProfileLine);
    const nonTargetProfileLine = applicable.filter((item) => !item.record.targetProfileLine);
    const cleared = applicable.filter((item) => item.trial.clearedVisible);
    const unsafe = applicable.filter((item) => !item.trial.texture.safe);
    const visibleAfter = applicable.filter((item) => item.trial.visibility.visible === true);
    const improved = applicable.filter((item) => item.trial.improvedSeverity);
    const nonApplicableCleared = nonApplicable.filter((item) => item.trial.clearedVisible);
    const severityDeltas = applicable
        .map((item) => Number(item.trial.severityDelta))
        .filter(Number.isFinite);

    return {
        profileName,
        alphaGain,
        familyApplicable: {
            total: applicable.length,
            targetProfileLine: targetProfileLine.length,
            nonTargetProfileLine: nonTargetProfileLine.length,
            clearedVisible: cleared.length,
            clearRatio: applicable.length > 0 ? round(cleared.length / applicable.length, 4) : 0,
            unsafe: unsafe.length,
            visibleAfter: visibleAfter.length,
            improvedSeverity: improved.length,
            averageSeverityDelta: severityDeltas.length > 0
                ? round(severityDeltas.reduce((sum, value) => sum + value, 0) / severityDeltas.length)
                : null,
            worstSeverityDelta: severityDeltas.length > 0 ? round(Math.min(...severityDeltas)) : null,
            clearedByProfileLine: countBy(cleared, (item) => item.record.profileLine),
            unsafeByProfileLine: countBy(unsafe, (item) => item.record.profileLine)
        },
        outsideFamilyEvidence: {
            total: nonApplicable.length,
            clearedVisible: nonApplicableCleared.length
        },
        sampleFiles: {
            cleared: cleared.map((item) => item.record.file),
            unsafe: unsafe.map((item) => item.record.file),
            visibleAfter: visibleAfter.slice(0, 10).map((item) => item.record.file)
        }
    };
}

function rankCandidate(summary) {
    return [
        -summary.familyApplicable.clearedVisible,
        summary.familyApplicable.unsafe,
        summary.outsideFamilyEvidence.clearedVisible,
        summary.familyApplicable.visibleAfter,
        -(summary.familyApplicable.averageSeverityDelta ?? Number.NEGATIVE_INFINITY)
    ];
}

function compareRank(left, right) {
    const leftRank = rankCandidate(left);
    const rightRank = rankCandidate(right);
    for (let index = 0; index < leftRank.length; index++) {
        if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return left.profileName.localeCompare(right.profileName) || left.alphaGain - right.alphaGain;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const reviewManifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const manifest = JSON.parse(reviewManifestText);
    const sampleRoot = args.sampleRoot || manifest.sourceSampleRoot;
    if (!sampleRoot) {
        throw new Error('sampleRoot is required; pass --sample-root or use a manifest with sourceSampleRoot');
    }

    const alpha48 = getEmbeddedAlphaMap(48);
    const transformedAlphaMaps = new Map(PROFILE_VARIANTS.map((variant) => [
        variant.name,
        transformAlphaMap(alpha48, 48, 48, variant)
    ]));
    const records = [];
    for (const record of collectRecords(manifest)) {
        records.push(await buildFamilyRecord({
            record,
            sampleRoot,
            alpha48,
            transformedAlphaMaps
        }));
    }

    const candidateSummaries = [];
    for (const variant of PROFILE_VARIANTS) {
        for (const alphaGain of ALPHA_GAINS) {
            candidateSummaries.push(summarizeTrialSet(records, variant.name, alphaGain));
        }
    }
    candidateSummaries.sort(compareRank);
    const reference = candidateSummaries.find((item) => (
        item.profileName === REFERENCE_CANDIDATE.profileName &&
        item.alphaGain === REFERENCE_CANDIDATE.alphaGain
    ));
    const bestHumanReviewOnly = candidateSummaries.find((item) => (
        item.familyApplicable.clearedVisible > 0 &&
        item.familyApplicable.unsafe === 0 &&
        item.outsideFamilyEvidence.clearedVisible === 0
    )) ?? null;
    const applicableRecords = records.filter((record) => record.geometryFamilyApplicable);

    const report = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        inputs: {
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256
        },
        sampleRoot,
        geometryFamily: GEOMETRY_FAMILY,
        referenceCandidate: REFERENCE_CANDIDATE,
        policy: {
            diagnosticOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        thresholds: {
            maxSafeTexturePenalty: MAX_SAFE_TEXTURE_PENALTY,
            minApplicableSpatialScore: MIN_APPLICABLE_SPATIAL_SCORE,
            minApplicableGradientScore: MIN_APPLICABLE_GRADIENT_SCORE
        },
        summary: {
            total: records.length,
            geometryFamilyApplicable: applicableRecords.length,
            geometryFamilyNonApplicable: records.length - applicableRecords.length,
            applicableByProfileLine: countBy(applicableRecords, (record) => record.profileLine),
            reference,
            topCandidates: candidateSummaries.slice(0, 12),
            bestHumanReviewOnly,
            conclusion: reference?.familyApplicable?.unsafe > 0
                ? 'reference-candidate-rejected-unsafe-within-family'
                : 'reference-candidate-diagnostic-only'
        },
        records,
        candidateSummaries
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
