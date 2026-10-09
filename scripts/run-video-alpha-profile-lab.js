import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { removeWatermark } from '../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import {
    getVideoAlphaMap,
    resizeAlphaMapArea
} from '../src/video/videoWatermarkDetector.js';
import { applyVideoResidualCleanup } from '../src/video/videoCleanupBackends.js';
import {
    summarizeResidualFrames,
    summarizeWatermarkResidual
} from './analyze-video-residual.js';
import {
    formatTimestampFileSuffix,
    parseTimestampList,
    renderVideoCropSheet
} from './render-video-crop-sheet.js';
import {
    calculateBucketDeltas
} from './run-video-frame-backend-lab.js';
import {
    loadVideoCropBenchmarkManifest,
    resolveExpectedWatermarkCandidate
} from './video-crop-benchmark.js';

const DEFAULT_MANIFEST_PATH = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-alpha-profile-lab');
const VIDEO_ALPHA_PROFILE = '96-20260520';
const DEFAULT_EDGE_BOOST = 0.045;
const DEFAULT_RESIDUAL_CLEANUP_STRENGTH = 1.5;

const PROFILE_VARIANTS = Object.freeze([
    { name: 'current-edge045', type: 'current' },
    { name: 'edge000', type: 'edge-boost', strength: 0 },
    { name: 'edge020', type: 'edge-boost', strength: 0.02 },
    { name: 'edge035', type: 'edge-boost', strength: 0.035 },
    { name: 'edge060', type: 'edge-boost', strength: 0.06 },
    { name: 'edge080', type: 'edge-boost', strength: 0.08 },
    { name: 'edge045-low-dampen088', type: 'band-scale', minAlpha: 0.025, maxAlpha: 0.18, scale: 0.88 },
    { name: 'edge045-low-boost112', type: 'band-scale', minAlpha: 0.025, maxAlpha: 0.18, scale: 1.12 },
    { name: 'edge045-mid-dampen092', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.40, scale: 0.92 },
    { name: 'edge045-mid-boost108', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.40, scale: 1.08 },
    { name: 'edge045-power094', type: 'power', exponent: 0.94 },
    { name: 'edge045-power106', type: 'power', exponent: 1.06 }
]);

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function enhanceAlphaEdges(alphaMap, size, strength) {
    if (!Number.isFinite(strength) || strength <= 0 || size <= 2) {
        return new Float32Array(alphaMap);
    }

    const gradient = new Float32Array(alphaMap.length);
    let maxGradient = 0;
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const i = y * size + x;
            const gx =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - 1] - alphaMap[i + size - 1] +
                alphaMap[i - size + 1] + 2 * alphaMap[i + 1] + alphaMap[i + size + 1];
            const gy =
                -alphaMap[i - size - 1] - 2 * alphaMap[i - size] - alphaMap[i - size + 1] +
                alphaMap[i + size - 1] + 2 * alphaMap[i + size] + alphaMap[i + size + 1];
            const value = Math.sqrt(gx * gx + gy * gy);
            gradient[i] = value;
            if (value > maxGradient) maxGradient = value;
        }
    }

    if (maxGradient <= 0) return new Float32Array(alphaMap);
    const out = new Float32Array(alphaMap.length);
    for (let i = 0; i < alphaMap.length; i++) {
        const edge = Math.sqrt(gradient[i] / maxGradient);
        out[i] = clampAlpha(alphaMap[i] + edge * strength);
    }
    return out;
}

function buildBaseVideoAlphaMap(size) {
    const alpha96 = getEmbeddedAlphaMap(VIDEO_ALPHA_PROFILE) || getEmbeddedAlphaMap(96);
    if (!alpha96) throw new Error('缺少视频 alpha profile');
    return size === 96 ? new Float32Array(alpha96) : resizeAlphaMapArea(alpha96, 96, size);
}

function transformAlphaMap(baseAlphaMap, size, variant, candidate = null) {
    if (variant.type === 'current') return getVideoAlphaMap(size, { candidate });
    const edge045 = enhanceAlphaEdges(baseAlphaMap, size, DEFAULT_EDGE_BOOST);
    if (variant.type === 'edge-boost') {
        return enhanceAlphaEdges(baseAlphaMap, size, variant.strength);
    }
    const transformed = new Float32Array(edge045.length);
    if (variant.type === 'band-scale') {
        for (let i = 0; i < edge045.length; i++) {
            const alpha = edge045[i] || 0;
            transformed[i] = alpha >= variant.minAlpha && alpha <= variant.maxAlpha
                ? clampAlpha(alpha * variant.scale)
                : alpha;
        }
        return transformed;
    }
    if (variant.type === 'power') {
        for (let i = 0; i < edge045.length; i++) {
            transformed[i] = clampAlpha(Math.pow(edge045[i] || 0, variant.exponent));
        }
        return transformed;
    }
    return edge045;
}

async function decodeImageData(filePath) {
    const { data, info } = await sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return {
        width: info.width,
        height: info.height,
        data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createImageDataContext(imageData) {
    return {
        canvas: {
            width: imageData.width,
            height: imageData.height
        },
        getImageData(x, y, width, height) {
            const out = new Uint8ClampedArray(width * height * 4);
            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const sourceIdx = ((y + row) * imageData.width + x + col) * 4;
                    const targetIdx = (row * width + col) * 4;
                    out[targetIdx] = imageData.data[sourceIdx];
                    out[targetIdx + 1] = imageData.data[sourceIdx + 1];
                    out[targetIdx + 2] = imageData.data[sourceIdx + 2];
                    out[targetIdx + 3] = imageData.data[sourceIdx + 3];
                }
            }
            return { width, height, data: out };
        },
        putImageData(patch, x, y) {
            for (let row = 0; row < patch.height; row++) {
                for (let col = 0; col < patch.width; col++) {
                    const sourceIdx = (row * patch.width + col) * 4;
                    const targetIdx = ((y + row) * imageData.width + x + col) * 4;
                    imageData.data[targetIdx] = patch.data[sourceIdx];
                    imageData.data[targetIdx + 1] = patch.data[sourceIdx + 1];
                    imageData.data[targetIdx + 2] = patch.data[sourceIdx + 2];
                    imageData.data[targetIdx + 3] = patch.data[sourceIdx + 3];
                }
            }
        }
    };
}

function isBaselineCase(caseItem) {
    return !caseItem.tags?.includes('variant') &&
        (caseItem.currentProfile?.denoiseBackend || 'none') === 'none' &&
        caseItem.currentPath &&
        caseItem.referencePath;
}

function buildLocalPosition(candidate, cropBox) {
    return {
        x: candidate.x - cropBox.left,
        y: candidate.y - cropBox.top,
        width: candidate.size,
        height: candidate.size
    };
}

async function runCase(caseItem, {
    outputDir,
    timestamps,
    residualCleanupStrength
}) {
    const caseDir = path.join(outputDir, caseItem.id);
    const sheetPath = path.join(caseDir, 'source-crops.png');
    const renderResult = await renderVideoCropSheet({
        originalPath: caseItem.originalPath,
        currentPath: caseItem.currentPath,
        referencePath: caseItem.referencePath,
        outputPath: sheetPath,
        timestamps,
        keepFrames: true
    });
    const analysisCandidate = resolveExpectedWatermarkCandidate(caseItem.expected, renderResult.metadata);
    const position = analysisCandidate ? buildLocalPosition(analysisCandidate, renderResult.cropBox) : null;
    if (!position) throw new Error(`无法解析 ${caseItem.id} 的水印位置`);

    const baseAlphaMap = buildBaseVideoAlphaMap(position.width);
    const baselineFrames = [];
    const variantFrames = new Map(PROFILE_VARIANTS.map((variant) => [variant.name, []]));

    for (const timestamp of renderResult.timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const originalImage = await decodeImageData(path.join(renderResult.frameDir, `original-${suffix}.png`));
        const currentImage = await decodeImageData(path.join(renderResult.frameDir, `current-${suffix}.png`));
        const referenceImage = await decodeImageData(path.join(renderResult.frameDir, `reference-${suffix}.png`));
        const currentAlpha = getVideoAlphaMap(position.width, { candidate: analysisCandidate });
        const baselineResidual = summarizeWatermarkResidual({
            currentImage,
            referenceImage,
            alphaMap: currentAlpha,
            watermarkPosition: position
        });

        baselineFrames.push({
            timestamp,
            backgroundMean: baselineResidual.backgroundMean,
            buckets: baselineResidual.buckets
        });

        for (const variant of PROFILE_VARIANTS) {
            const alphaMap = transformAlphaMap(baseAlphaMap, position.width, variant, analysisCandidate);
            const candidateImage = cloneImageData(originalImage);
            removeWatermark(candidateImage, alphaMap, position, { alphaGain: 1 });
            applyVideoResidualCleanup(createImageDataContext(candidateImage), position, alphaMap, {
                residualCleanupStrength,
                denoiseBackend: 'none'
            });
            const residual = summarizeWatermarkResidual({
                currentImage: candidateImage,
                referenceImage,
                alphaMap: currentAlpha,
                watermarkPosition: position
            });
            variantFrames.get(variant.name).push({
                timestamp,
                backgroundMean: residual.backgroundMean,
                buckets: residual.buckets
            });
        }
    }

    const baselineAggregate = summarizeResidualFrames(baselineFrames);
    const rawVariants = PROFILE_VARIANTS.map((variant) => {
        const aggregate = summarizeResidualFrames(variantFrames.get(variant.name));
        return {
            name: variant.name,
            profile: variant,
            aggregate,
            mvpDeltas: calculateBucketDeltas(aggregate, baselineAggregate)
        };
    });
    const currentVariant = rawVariants.find((variant) => variant.name === 'current-edge045') || rawVariants[0];
    const variants = rawVariants.map((variant) => ({
        ...variant,
        deltas: calculateBucketDeltas(variant.aggregate, currentVariant.aggregate)
    }));

    return {
        id: caseItem.id,
        outputDir: caseDir,
        sheetPath,
        cropBox: renderResult.cropBox,
        timestamps: renderResult.timestamps,
        localWatermarkPosition: position,
        baselineAggregate,
        variants
    };
}

function scoreVariant(variant) {
    const deltas = variant.deltas || {};
    const edgeGain = Math.max(0, -(deltas.edge?.meanAbsDelta ?? 0));
    const activeGain = Math.max(0, -(deltas.active?.meanAbsDelta ?? 0));
    const bodyRegression =
        Math.max(0, deltas.lowBody?.meanAbsDelta ?? 0) +
        Math.max(0, deltas.highBody?.meanAbsDelta ?? 0);
    const regressions = ['active', 'edge', 'lowBody', 'highBody']
        .filter((bucket) => deltas[bucket]?.verdict === 'regressed')
        .length;
    return edgeGain * 2 + activeGain - bodyRegression * 4 - regressions * 2;
}

function formatSigned(value, digits = 4) {
    if (!Number.isFinite(value)) return '-';
    const formatted = value.toFixed(digits);
    return value > 0 ? `+${formatted}` : formatted;
}

function summarizeProfileAcrossCases(cases) {
    const profileNames = PROFILE_VARIANTS.map((variant) => variant.name);
    return profileNames.map((name) => {
        const variants = cases.map((caseItem) => caseItem.variants.find((variant) => variant.name === name));
        const bucketTotals = {};
        for (const bucket of ['active', 'edge', 'lowBody', 'highBody']) {
            const values = variants.map((variant) => variant?.deltas?.[bucket]?.meanAbsDelta).filter(Number.isFinite);
            bucketTotals[bucket] = values.length
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null;
        }
        return {
            name,
            score: variants.reduce((sum, variant) => sum + scoreVariant(variant), 0),
            regressions: variants.reduce((sum, variant) => sum + ['active', 'edge', 'lowBody', 'highBody']
                .filter((bucket) => variant?.deltas?.[bucket]?.verdict === 'regressed').length, 0),
            meanDeltas: bucketTotals
        };
    }).sort((left, right) => right.score - left.score);
}

function renderMarkdown(report) {
    const lines = [];
    lines.push('# Video Alpha Profile Lab');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Residual cleanup strength: ${report.profile.residualCleanupStrength}`);
    lines.push('Profile deltas are measured against `current-edge045` in the same PNG lab path.');
    lines.push('');
    lines.push('## Profile Summary');
    lines.push('');
    lines.push('| Profile | Score | Regressions | Active mean Δ | Edge mean Δ | LowBody mean Δ | HighBody mean Δ |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const item of report.profileSummary) {
        lines.push([
            item.name,
            item.score.toFixed(4),
            item.regressions,
            formatSigned(item.meanDeltas.active),
            formatSigned(item.meanDeltas.edge),
            formatSigned(item.meanDeltas.lowBody),
            formatSigned(item.meanDeltas.highBody)
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Cases');
    for (const caseItem of report.cases) {
        lines.push('');
        lines.push(`### ${caseItem.id}`);
        lines.push('');
        lines.push('| Profile | Active Δ | Edge Δ | LowBody Δ | HighBody Δ |');
        lines.push('|---|---:|---:|---:|---:|');
        for (const variant of caseItem.variants) {
            const deltas = variant.deltas;
            lines.push([
                variant.name,
                `${formatSigned(deltas.active?.meanAbsDelta)} (${deltas.active?.verdict})`,
                `${formatSigned(deltas.edge?.meanAbsDelta)} (${deltas.edge?.verdict})`,
                `${formatSigned(deltas.lowBody?.meanAbsDelta)} (${deltas.lowBody?.verdict})`,
                `${formatSigned(deltas.highBody?.meanAbsDelta)} (${deltas.highBody?.verdict})`
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }
    }
    return `${lines.join('\n')}\n`;
}

export async function runVideoAlphaProfileLab({
    manifestPath = DEFAULT_MANIFEST_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    cases = null,
    timestamps = null,
    residualCleanupStrength = DEFAULT_RESIDUAL_CLEANUP_STRENGTH
} = {}) {
    const manifest = await loadVideoCropBenchmarkManifest(manifestPath);
    const selectedIds = Array.isArray(cases) && cases.length ? new Set(cases) : null;
    const selectedCases = manifest.cases
        .filter(isBaselineCase)
        .filter((caseItem) => !selectedIds || selectedIds.has(caseItem.id));
    const resolvedOutputDir = path.resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });

    const results = [];
    for (const caseItem of selectedCases) {
        results.push(await runCase(caseItem, {
            outputDir: resolvedOutputDir,
            timestamps: timestamps ? parseTimestampList(timestamps) : (manifest.timestamps || undefined),
            residualCleanupStrength
        }));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        manifestPath: path.resolve(manifestPath),
        outputDir: resolvedOutputDir,
        profile: {
            residualCleanupStrength
        },
        profileSummary: summarizeProfileAcrossCases(results),
        cases: results
    };
    const jsonPath = path.join(resolvedOutputDir, 'latest-report.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest-report.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return {
        ...report,
        jsonPath,
        markdownPath
    };
}

function parseCliArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        cases: null,
        timestamps: null,
        residualCleanupStrength: DEFAULT_RESIDUAL_CLEANUP_STRENGTH
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = argv[++i] || parsed.manifestPath;
        } else if (arg === '--output-dir') {
            parsed.outputDir = argv[++i] || parsed.outputDir;
        } else if (arg === '--cases') {
            parsed.cases = String(argv[++i] || '').split(',').map((item) => item.trim()).filter(Boolean);
        } else if (arg === '--timestamps') {
            parsed.timestamps = argv[++i] || parsed.timestamps;
        } else if (arg === '--residual-cleanup-strength') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value)) parsed.residualCleanupStrength = value;
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/run-video-alpha-profile-lab.js [--manifest <path>] [--cases <ids>] [--timestamps 1,3,5] [--output-dir <dir>]
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    runVideoAlphaProfileLab(args)
        .then((report) => {
            console.log(`json: ${report.jsonPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            for (const item of report.profileSummary.slice(0, 5)) {
                console.log(`[profile] ${item.name} score=${item.score.toFixed(4)} regressions=${item.regressions}`);
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
