import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessReferenceTextureAlignment,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile/large-margin-48-profile-candidate.json');
const ALPHA_GAINS = Object.freeze([0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
const MID_BOOST_VARIANT = Object.freeze({
    name: 'mid-boost-1.24',
    minAlpha: 0.12,
    maxAlpha: 0.4,
    scale: 1.24
});

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
    const size = record.config.logoSize;
    return {
        x: imageData.width - record.config.marginRight - size,
        y: imageData.height - record.config.marginBottom - size,
        width: size,
        height: size
    };
}

function is48LargeMargin(record) {
    return record?.config?.logoSize === 48 &&
        record.config.marginRight === 96 &&
        record.config.marginBottom === 96 &&
        !record.config.alphaVariant;
}

function transformMidBoost(alphaMap) {
    const transformed = new Float32Array(alphaMap.length);
    for (let index = 0; index < alphaMap.length; index++) {
        const alpha = alphaMap[index];
        transformed[index] = alpha >= MID_BOOST_VARIANT.minAlpha && alpha <= MID_BOOST_VARIANT.maxAlpha
            ? Math.max(0, Math.min(0.99, alpha * MID_BOOST_VARIANT.scale))
            : alpha;
    }
    return transformed;
}

function visibilitySeverityFromMetrics(metrics) {
    if (!metrics) return Number.POSITIVE_INFINITY;
    return Math.max(
        metrics.positiveHaloLum ?? 0,
        (metrics.gradientResidual ?? 0) * 80,
        (metrics.spatialResidual ?? 0) * 80
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

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function summarizeTrial(alphaGain, candidateImageData, originalImageData, position, alphaMap) {
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
        profileName: MID_BOOST_VARIANT.name,
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

async function probeRecord({ record, sampleRoot, alpha48, profileAlpha }) {
    const original = await decodeImageDataInNode(path.join(sampleRoot, record.file));
    const position = resolvePosition(record, original);
    const trials = ALPHA_GAINS.map((alphaGain) => {
        const candidate = cloneImageData(original);
        removeWatermark(candidate, profileAlpha, position, { alphaGain });
        return summarizeTrial(alphaGain, candidate, original, position, alpha48);
    });
    const safeTrials = trials.filter((trial) => !trial.hardReject);
    const best = [...safeTrials].sort((left, right) => left.severity - right.severity)[0] ?? null;
    const bestCleared = safeTrials
        .filter((trial) => trial.visible === false)
        .sort((left, right) => left.severity - right.severity)[0] ?? null;
    const baselineSeverity = visibilitySeverityFromMetrics(record.metrics);

    return {
        file: record.file,
        group: record.group,
        source: record.source,
        reviewVerdict: record.review?.verdict ?? 'pending',
        baseline: {
            severity: round(baselineSeverity, 4),
            metrics: record.metrics
        },
        best,
        bestCleared,
        improvedSeverity: best ? best.severity < baselineSeverity : false,
        clearedVisible: Boolean(bestCleared),
        trials
    };
}

function collectRecords(manifest) {
    return [
        ...(manifest.groups?.metricPassVisible ?? []),
        ...(manifest.groups?.visibleTopPending ?? [])
    ].filter(is48LargeMargin);
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
    const profileAlpha = transformMidBoost(alpha48);
    const records = collectRecords(manifest);
    const probes = [];
    for (const record of records) {
        probes.push(await probeRecord({
            record,
            sampleRoot,
            alpha48,
            profileAlpha
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
        variant: MID_BOOST_VARIANT,
        alphaGains: ALPHA_GAINS,
        summary: {
            total: probes.length,
            improvedSeverity: probes.filter((probe) => probe.improvedSeverity).length,
            clearedVisible: probes.filter((probe) => probe.clearedVisible).length,
            hardRejectBest: probes.filter((probe) => probe.best?.hardReject === true).length,
            verdictCounts: countBy(probes, (probe) => probe.reviewVerdict),
            bestAlphaGainCounts: countBy(probes, (probe) => String(probe.best?.alphaGain ?? 'none'))
        },
        probes
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        samples: probes.map((probe) => ({
            file: probe.file,
            reviewVerdict: probe.reviewVerdict,
            baselineSeverity: probe.baseline.severity,
            best: probe.best,
            bestCleared: probe.bestCleared
        }))
    }, null, 2));
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
