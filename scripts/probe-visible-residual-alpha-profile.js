import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessReferenceTextureAlignment,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/model-investigation-alpha-profile.json');
const ALPHA_GAINS = Object.freeze([0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.2]);
const PROFILE_VARIANTS = Object.freeze([
    { name: 'base', type: 'identity' },
    { name: 'mid-boost-1.08', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.4, scale: 1.08 },
    { name: 'mid-boost-1.16', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.4, scale: 1.16 },
    { name: 'mid-boost-1.24', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.4, scale: 1.24 },
    { name: 'core-boost-1.08', type: 'band-scale', minAlpha: 0.18, maxAlpha: 0.65, scale: 1.08 },
    { name: 'core-boost-1.16', type: 'band-scale', minAlpha: 0.18, maxAlpha: 0.65, scale: 1.16 },
    { name: 'edge-boost-1.16', type: 'band-scale', minAlpha: 0.025, maxAlpha: 0.18, scale: 1.16 },
    { name: 'edge-dampen-0.88', type: 'band-scale', minAlpha: 0.025, maxAlpha: 0.18, scale: 0.88 },
    { name: 'power-0.88', type: 'power', exponent: 0.88 },
    { name: 'power-0.94', type: 'power', exponent: 0.94 },
    { name: 'power-1.08', type: 'power', exponent: 1.08 },
    { name: 'blur-mix-0.25', type: 'blur-mix', mix: 0.25 },
    { name: 'sharpen-0.20', type: 'sharpen', amount: 0.2 },
    { name: 'sharpen-0.35', type: 'sharpen', amount: 0.35 }
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

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function resolvePosition(record, imageData) {
    const config = record.config;
    if (!config) return null;
    const size = config.logoSize ?? config.size;
    const { marginRight, marginBottom } = config;
    if (![size, marginRight, marginBottom].every(Number.isFinite)) return null;
    return {
        x: imageData.width - marginRight - size,
        y: imageData.height - marginBottom - size,
        width: size,
        height: size
    };
}

function buildAlphaResolver() {
    const alpha96 = getEmbeddedAlphaMap(96);
    const cache = new Map([
        [36, getEmbeddedAlphaMap('36-v2')],
        [48, getEmbeddedAlphaMap(48)],
        [96, alpha96],
        ['36-v2', getEmbeddedAlphaMap('36-v2')],
        ['96-20260520', getEmbeddedAlphaMap('96-20260520')]
    ]);

    return (config) => {
        if (!config) return null;
        if (config.alphaVariant) {
            const variantKey = `${config.logoSize}-${config.alphaVariant}`;
            if (cache.has(variantKey)) return cache.get(variantKey);
        }
        if (cache.has(config.logoSize)) return cache.get(config.logoSize);
        const alphaMap = interpolateAlphaMap(alpha96, 96, config.logoSize);
        cache.set(config.logoSize, alphaMap);
        return alphaMap;
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
                const sy = y + dy;
                if (sy < 0 || sy >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sx = x + dx;
                    if (sx < 0 || sx >= width) continue;
                    sum += alphaMap[sy * width + sx];
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

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function summarizeTrial({
    profileName,
    alphaGain,
    candidateImageData,
    originalImageData,
    position,
    alphaMap
}) {
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData: candidateImageData,
        position,
        alphaMap
    });
    const texture = assessReferenceTextureAlignment({
        originalImageData,
        candidateImageData,
        position
    });
    return {
        profileName,
        alphaGain,
        severity: round(visibilitySeverity(residualVisibility), 4),
        visible: residualVisibility?.visible === true,
        positiveHaloLum: round(residualVisibility?.positiveHaloLum, 4),
        haloVisibility: round(residualVisibility?.haloVisibility, 4),
        spatialResidual: round(residualVisibility?.spatialResidual, 4),
        gradientResidual: round(residualVisibility?.gradientResidual, 4),
        texturePenalty: round(texture.texturePenalty, 4),
        hardReject: texture.hardReject === true,
        tooDark: texture.tooDark === true,
        tooFlat: texture.tooFlat === true
    };
}

async function probeRecord({ record, sampleRoot, resolveAlphaMap }) {
    const inputPath = path.join(sampleRoot, record.file);
    const original = await decodeImageDataInNode(inputPath);
    const position = resolvePosition(record, original);
    const baseAlphaMap = resolveAlphaMap(record.config);
    if (!position || !baseAlphaMap) {
        return {
            file: record.file,
            error: 'missing-position-or-alpha-map'
        };
    }

    const trials = [];
    for (const variant of PROFILE_VARIANTS) {
        const profileAlphaMap = transformAlphaMap(baseAlphaMap, position.width, position.height, variant);
        for (const alphaGain of ALPHA_GAINS) {
            const candidate = cloneImageData(original);
            removeWatermark(candidate, profileAlphaMap, position, { alphaGain });
            trials.push(summarizeTrial({
                profileName: variant.name,
                alphaGain,
                candidateImageData: candidate,
                originalImageData: original,
                position,
                alphaMap: baseAlphaMap
            }));
        }
    }

    const safeTrials = trials.filter((trial) => !trial.hardReject);
    const bySeverity = [...safeTrials].sort((left, right) => left.severity - right.severity).slice(0, 8);
    const byHalo = [...safeTrials].sort((left, right) => {
        if (left.positiveHaloLum !== right.positiveHaloLum) return left.positiveHaloLum - right.positiveHaloLum;
        return left.severity - right.severity;
    }).slice(0, 8);
    const cleared = safeTrials.filter((trial) => trial.visible === false)
        .sort((left, right) => left.severity - right.severity);

    return {
        file: record.file,
        reviewVerdict: record.review?.verdict ?? null,
        profileLine: record.review?.profileLine ?? null,
        config: record.config,
        baselineFromReview: record.metrics,
        position,
        bestBySeverity: bySeverity[0] ?? null,
        bestByHalo: byHalo[0] ?? null,
        clearedCount: cleared.length,
        bestCleared: cleared[0] ?? null,
        topBySeverity: bySeverity,
        topByHalo: byHalo
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

    const resolveAlphaMap = buildAlphaResolver();
    const records = manifest.workQueues?.modelInvestigation ?? [];
    const probes = [];
    for (const record of records) {
        probes.push(await probeRecord({
            record,
            sampleRoot,
            resolveAlphaMap
        }));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        inputs: {
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256
        },
        sampleRoot,
        alphaGains: ALPHA_GAINS,
        profileVariants: PROFILE_VARIANTS,
        summary: {
            total: probes.length,
            profileCouldClearVisible: probes.filter((probe) => probe.clearedCount > 0).length,
            bestProfileNames: probes.map((probe) => probe.bestBySeverity?.profileName ?? null)
        },
        probes
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        best: probes.map((probe) => ({
            file: probe.file,
            profileLine: probe.profileLine,
            clearedCount: probe.clearedCount,
            bestBySeverity: probe.bestBySeverity,
            bestCleared: probe.bestCleared
        }))
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
