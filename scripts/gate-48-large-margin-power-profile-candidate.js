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
    '.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-power088-gate.json'
);
const TARGET_PROFILE_LINE = '48px-large-margin';
const CANDIDATE = Object.freeze({
    profileName: 'power-0.88',
    alphaGain: 0.55,
    config: {
        logoSize: 48,
        marginRight: 96,
        marginBottom: 96
    }
});
const MAX_SAFE_TEXTURE_PENALTY = 0.2;
const MIN_APPLICABLE_SPATIAL_SCORE = 0.3;
const MIN_APPLICABLE_GRADIENT_SCORE = 0.12;
const REQUIRED_TARGET_CLEAR_RATIO = 0.7;
const MAX_NON_TARGET_CLEAR_COUNT = 0;

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

function transformPower(alphaMap, exponent) {
    const transformed = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        transformed[index] = Math.max(0, Math.min(0.99, Math.pow(alphaMap[index], exponent)));
    }
    return transformed;
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

function summarizeOriginalEvidence(scores) {
    const spatial = Number(scores?.spatialScore);
    const gradient = Number(scores?.gradientScore);
    const applicable =
        spatial >= MIN_APPLICABLE_SPATIAL_SCORE ||
        gradient >= MIN_APPLICABLE_GRADIENT_SCORE;
    return {
        spatial: round(spatial),
        gradient: round(gradient),
        applicable
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

async function evaluateRecord({ record, sampleRoot, alpha48, candidateAlphaMap }) {
    const inputPath = path.resolve(sampleRoot, record.file);
    const original = await decodeImageDataInNode(inputPath);
    const position = resolvePosition(CANDIDATE.config, original);
    const originalEvidence = summarizeOriginalEvidence(scoreRegion(original, alpha48, position));
    const candidate = cloneImageData(original);
    removeWatermark(candidate, candidateAlphaMap, position, { alphaGain: CANDIDATE.alphaGain });
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
    const baseline = baselineSeverity(record);
    const resultVisibility = summarizeVisibility(visibility);
    const resultTexture = summarizeTexture(texture);
    const severityDelta = Number.isFinite(baseline) && Number.isFinite(resultVisibility.severity)
        ? baseline - resultVisibility.severity
        : null;

    const result = {
        file: record.file,
        sourceSet: record.sourceSet ?? null,
        profileLine: record.review?.profileLine ?? 'unknown',
        reviewVerdict: record.review?.verdict ?? 'pending',
        source: record.source ?? null,
        originalConfig: record.config ?? null,
        targetProfile: record.review?.profileLine === TARGET_PROFILE_LINE,
        baseline: {
            severity: round(baseline),
            metrics: record.metrics ?? null
        },
        candidate: {
            config: CANDIDATE.config,
            profileName: CANDIDATE.profileName,
            alphaGain: CANDIDATE.alphaGain,
            position,
            visibility: resultVisibility,
            texture: resultTexture,
            improvedSeverity: Number.isFinite(severityDelta) && severityDelta > 0,
            severityDelta: round(severityDelta),
            clearedVisible: originalEvidence.applicable &&
                resultTexture.safe &&
                resultVisibility.visible === false,
            originalEvidence,
            applicable: originalEvidence.applicable
        }
    };
    return result;
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

function summarizeGroup(records) {
    return {
        total: records.length,
        improvedSeverity: records.filter((record) => record.candidate.improvedSeverity).length,
        applicableImprovedSeverity: records.filter((record) => (
            record.candidate.applicable &&
            record.candidate.improvedSeverity
        )).length,
        clearedVisible: records.filter((record) => record.candidate.clearedVisible).length,
        applicable: records.filter((record) => record.candidate.applicable).length,
        applicableClearedVisible: records.filter((record) => (
            record.candidate.applicable &&
            record.candidate.clearedVisible
        )).length,
        unsafe: records.filter((record) => !record.candidate.texture.safe).length,
        visibleAfter: records.filter((record) => record.candidate.visibility.visible === true).length,
        bestSeverityDelta: round(Math.max(
            ...records
                .map((record) => Number(record.candidate.severityDelta))
                .filter(Number.isFinite),
            Number.NEGATIVE_INFINITY
        )),
        worstSeverityDelta: round(Math.min(
            ...records
                .map((record) => Number(record.candidate.severityDelta))
                .filter(Number.isFinite),
            Number.POSITIVE_INFINITY
        ))
    };
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
    const candidateAlphaMap = transformPower(alpha48, 0.88);
    const records = [];
    for (const record of collectRecords(manifest)) {
        records.push(await evaluateRecord({
            record,
            sampleRoot,
            alpha48,
            candidateAlphaMap
        }));
    }

    const targetRecords = records.filter((record) => record.targetProfile);
    const nonTargetRecords = records.filter((record) => !record.targetProfile);
    const targetSummary = summarizeGroup(targetRecords);
    const nonTargetSummary = summarizeGroup(nonTargetRecords);
    const targetClearRatio = targetSummary.total > 0
        ? targetSummary.clearedVisible / targetSummary.total
        : 0;
    const gate = {
        decision: 'reject-production-candidate',
        reasons: [],
        targetClearRatio: round(targetClearRatio),
        requiredTargetClearRatio: REQUIRED_TARGET_CLEAR_RATIO,
        maxNonTargetClearCount: MAX_NON_TARGET_CLEAR_COUNT
    };
    if (targetClearRatio < REQUIRED_TARGET_CLEAR_RATIO) {
        gate.reasons.push('target-clear-ratio-below-threshold');
    }
    if (nonTargetSummary.clearedVisible > MAX_NON_TARGET_CLEAR_COUNT) {
        gate.reasons.push('non-target-applicable-records-cleared');
    }
    if (targetSummary.unsafe > 0) {
        gate.reasons.push('target-records-have-unsafe-texture');
    }
    if (gate.reasons.length === 0) {
        gate.decision = 'eligible-for-human-review-only';
    }

    const report = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        inputs: {
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256
        },
        sampleRoot,
        candidate: CANDIDATE,
        policy: {
            diagnosticOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        summary: {
            total: records.length,
            targetProfileLine: TARGET_PROFILE_LINE,
            target: targetSummary,
            nonTarget: nonTargetSummary,
            profileCounts: countBy(records, (record) => record.profileLine),
            applicableByProfile: countBy(
                records.filter((record) => record.candidate.applicable),
                (record) => record.profileLine
            ),
            applicableImprovedByProfile: countBy(
                records.filter((record) => record.candidate.applicable && record.candidate.improvedSeverity),
                (record) => record.profileLine
            ),
            clearedByProfile: countBy(
                records.filter((record) => record.candidate.clearedVisible),
                (record) => record.profileLine
            ),
            unsafeByProfile: countBy(
                records.filter((record) => !record.candidate.texture.safe),
                (record) => record.profileLine
            )
        },
        gate,
        records
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        gate: report.gate
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
