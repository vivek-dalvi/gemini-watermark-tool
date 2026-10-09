import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_LOCALIZATION_PATH = path.resolve(
    '.artifacts/gemini-watermark-metric-study/metric-48-96-96-localization/latest.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/gemini-watermark-metric-study/metric-48-96-96-taxonomy');
const DEFAULT_RENDER_LIMIT = 16;
const TILE_SIZE = 180;
const LABEL_HEIGHT = 56;
const HEADER_HEIGHT = 62;
const ROW_GAP = 12;
const BACKGROUND = '#171717';

function parseArgs(argv) {
    const parsed = {
        localizationPath: DEFAULT_LOCALIZATION_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        renderLimit: DEFAULT_RENDER_LIMIT
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--localization') {
            parsed.localizationPath = path.resolve(args.shift() || parsed.localizationPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
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

function sanitizeFileName(value) {
    return String(value)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 120);
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

function geometryKey(value) {
    if (!value) return 'none';
    return `${value.size}/${value.marginRight}/${value.marginBottom}`;
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

export function classifyCandidateSafety(record) {
    const production = record.production ?? {};
    const best = record.bestRemoval;
    const processed = best?.processed;
    if (!best || !processed) {
        return {
            label: 'no-candidate',
            clearsVisible: false,
            improvesBalanced: false,
            artifactWorse: false,
            balancedDelta: null,
            artifactDelta: null,
            removalGain: null
        };
    }

    const balancedDelta = metricDelta(processed, production, 'balancedCost');
    const artifactDelta = metricDelta(processed, production, 'visualArtifactCost');
    const removalGain = finiteNumber(best.removalGain);
    const clearsVisible = effectiveVisible(processed) !== true;
    const improvesBalanced = removalGain !== null
        ? removalGain > 0.03
        : balancedDelta !== null && balancedDelta < -0.03;
    const artifactWorse = artifactDelta !== null && artifactDelta > 0.05;

    let label = 'worsens-or-no-safe-candidate';
    if (clearsVisible && improvesBalanced && !artifactWorse) {
        label = 'safe-improvement';
    } else if (clearsVisible && improvesBalanced && artifactWorse) {
        label = 'clears-with-artifact-risk';
    } else if (clearsVisible) {
        label = 'metric-clears-but-damages';
    } else if (improvesBalanced) {
        label = 'partial-improvement-still-visible';
    }

    return {
        label,
        clearsVisible,
        improvesBalanced,
        artifactWorse,
        balancedDelta,
        artifactDelta,
        removalGain
    };
}

const METRIC_MISMATCH_CANDIDATE_LABELS = new Set([
    'background-collision-or-metric-false-positive',
    'clipped-flat-low-texture-metric-risk',
    'metric-risk-calibrated-pass'
]);

const ALGORITHMIC_RESIDUAL_CANDIDATE_LABELS = new Set([
    'fixable-local-drift',
    'fixable-conservative-gain',
    'dark-halo',
    'negative-spatial-ghost',
    'edge-gradient-residual',
    'mixed-visible'
]);

function resolveMetricMismatchReason({ label, production }) {
    if (!METRIC_MISMATCH_CANDIDATE_LABELS.has(label)) return null;
    const p = production ?? {};
    if (Number(p.nearBlackRatio) >= 0.25) {
        return 'low-texture-background-collision';
    }
    if (Number(p.spatial) >= 0.14 && Number(p.gradient) < 0.12) {
        return 'positive-spatial-background-collision';
    }
    return 'weak-halo-background-collision';
}

function createClassification({ label, action, fixable, drifted, production }) {
    return {
        label,
        action,
        fixable,
        drifted,
        metricMismatchCandidate: METRIC_MISMATCH_CANDIDATE_LABELS.has(label),
        algorithmicResidualCandidate: ALGORITHMIC_RESIDUAL_CANDIDATE_LABELS.has(label),
        mismatchReason: resolveMetricMismatchReason({ label, production }),
        needsHumanLabel: action.includes('human')
    };
}

export function classifyRecord(record) {
    const p = record.production ?? {};
    const best = record.bestRemoval;
    const fixable = Boolean(
        best &&
        effectiveVisible(best.processed) !== true &&
        Number(best.removalGain) > 0.03
    );
    const drifted = Boolean(
        best &&
        geometryKey(best) !== '48/96/96' &&
        Number(best.removalGain) > 0.03
    );

    if (effectiveVisible(p) !== true) {
        if (p.metricRisk) {
            return createClassification({
                label: 'metric-risk-calibrated-pass',
                action: 'raw metric flagged this, but calibrated metric-risk check says do not tune production against it without human confirmation',
                fixable,
                drifted,
                production: p
            });
        }
        return createClassification({
            label: 'clean-or-metric-pass',
            action: 'keep as regression background; do not tune against visible failure',
            fixable,
            drifted,
            production: p
        });
    }

    if (fixable && drifted) {
        return createClassification({
            label: 'fixable-local-drift',
            action: 'candidate for a tightly gated local relocation rescue',
            fixable,
            drifted,
            production: p
        });
    }

    if (fixable) {
        return createClassification({
            label: 'fixable-conservative-gain',
            action: 'candidate for a tightly gated lower-gain rescue',
            fixable,
            drifted,
            production: p
        });
    }

    if (
        Number(p.nearBlackRatio) >= 0.6 ||
        Number(p.newlyClippedRatio) >= 0.18
    ) {
        return createClassification({
            label: 'clipped-flat-low-texture-metric-risk',
            action: 'likely metric risk on flat background; do not add stronger subtraction or flat-fill without human confirmation',
            fixable,
            drifted,
            production: p
        });
    }

    if (Number(p.darkHaloLum) >= 3) {
        return createClassification({
            label: 'dark-halo',
            action: 'investigate halo-aware conservative rescue',
            fixable,
            drifted,
            production: p
        });
    }

    if (
        Number(p.spatial) <= -0.16 &&
        Number(p.gradient) < 0.08
    ) {
        return createClassification({
            label: 'negative-spatial-ghost',
            action: 'likely over-subtraction or alpha polarity mismatch; tune against anti-template residual',
            fixable,
            drifted,
            production: p
        });
    }

    if (Number(p.gradient) >= 0.2) {
        return createClassification({
            label: 'edge-gradient-residual',
            action: 'investigate edge cleanup/profile shape; not solved by global gain',
            fixable,
            drifted,
            production: p
        });
    }

    if (Number(record.bestRemoval?.removalGain) <= 0.03) {
        return createClassification({
            label: 'background-collision-or-metric-false-positive',
            action: 'needs human label before production changes',
            fixable,
            drifted,
            production: p
        });
    }

    return createClassification({
        label: 'mixed-visible',
        action: 'needs human label before production changes',
        fixable,
        drifted,
        production: p
    });
}

function severity(record) {
    const p = record.production ?? {};
    return Math.max(
        Number(p.visibilitySeverity) || 0,
        Number(p.balancedCost) || 0,
        Math.abs(Number(p.spatial) || 0) * 80,
        Math.max(0, Number(p.gradient) || 0) * 80
    );
}

function countBy(records, getKey) {
    const counts = new Map();
    for (const record of records) {
        const key = getKey(record);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

export function buildSheetGroups(records) {
    const visibleRecords = records.filter((record) => effectiveVisible(record.production) === true);
    const labelGroups = [...new Set(visibleRecords.map((record) => record.taxonomy.label))]
        .sort()
        .map((label) => ({
            key: label,
            records: visibleRecords.filter((record) => record.taxonomy.label === label)
        }));
    const mismatchReasonGroups = [...new Set(visibleRecords
        .filter((record) => record.taxonomy.metricMismatchCandidate && record.taxonomy.mismatchReason)
        .map((record) => record.taxonomy.mismatchReason))]
        .sort()
        .map((reason) => ({
            key: `mismatch-${reason}`,
            records: visibleRecords.filter((record) => (
                record.taxonomy.metricMismatchCandidate &&
                record.taxonomy.mismatchReason === reason
            ))
        }));
    return [...labelGroups, ...mismatchReasonGroups];
}

function buildTaxonomy(records) {
    return records.map((record) => {
        const classification = classifyRecord(record);
        return {
            ...record,
            taxonomy: {
                ...classification,
                candidateSafety: classifyCandidateSafety(record),
                severity: severity(record)
            }
        };
    });
}

export function summarize(records) {
    const rawVisible = records.filter((record) => record.production?.visible === true);
    const visible = records.filter((record) => effectiveVisible(record.production) === true);
    const fixable = visible.filter((record) => record.taxonomy.fixable);
    const metricMismatchVisible = visible.filter((record) => record.taxonomy.metricMismatchCandidate);
    const algorithmicResidualVisible = visible.filter((record) => record.taxonomy.algorithmicResidualCandidate);
    const humanReviewVisible = visible.filter((record) => record.taxonomy.needsHumanLabel);
    return {
        total: records.length,
        rawVisible: rawVisible.length,
        visible: visible.length,
        calibratedVisible: visible.length,
        metricRisk: records.filter((record) => record.production?.metricRisk).length,
        metricRiskCounts: countBy(
            records.filter((record) => record.production?.metricRisk),
            (record) => record.production.metricRisk
        ),
        cleanOrMetricPass: records.length - visible.length,
        fixableVisible: fixable.length,
        metricMismatchCandidateVisible: metricMismatchVisible.length,
        algorithmicResidualCandidateVisible: algorithmicResidualVisible.length,
        humanReviewVisible: humanReviewVisible.length,
        candidateSafetyCounts: countBy(records, (record) => record.taxonomy.candidateSafety.label),
        visibleCandidateSafetyCounts: countBy(visible, (record) => record.taxonomy.candidateSafety.label),
        taxonomyCounts: countBy(records, (record) => record.taxonomy.label),
        visibleTaxonomyCounts: countBy(visible, (record) => record.taxonomy.label),
        visibleMismatchReasonCounts: countBy(
            metricMismatchVisible,
            (record) => record.taxonomy.mismatchReason ?? 'none'
        ),
        actionCounts: countBy(records, (record) => record.taxonomy.action),
        topVisible: visible
            .sort((left, right) => right.taxonomy.severity - left.taxonomy.severity)
            .slice(0, 20)
            .map((record) => ({
                file: record.file,
                label: record.taxonomy.label,
                action: record.taxonomy.action,
                candidateSafety: record.taxonomy.candidateSafety,
                production: record.production,
                bestRemoval: record.bestRemoval
            }))
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

function processProduction({ originalImageData, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }) {
    return processWatermarkImageData(cloneImageData(originalImageData), {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (size === 48) return alpha48;
            if (size === 96) return alpha96;
            return resolveAlphaMap(size);
        }
    });
}

function cropBoxForRecord(imageData, record) {
    const positions = [
        record.baseline?.position,
        record.bestRemoval?.position
    ].filter(Boolean);
    const fallback = {
        x: imageData.width - 96 - 48,
        y: imageData.height - 96 - 48,
        width: 48,
        height: 48
    };
    const used = positions.length ? positions : [fallback];
    const padding = 38;
    const left = Math.max(0, Math.min(...used.map((position) => position.x)) - padding);
    const top = Math.max(0, Math.min(...used.map((position) => position.y)) - padding);
    const right = Math.min(imageData.width, Math.max(...used.map((position) => position.x + position.width)) + padding);
    const bottom = Math.min(imageData.height, Math.max(...used.map((position) => position.y + position.height)) + padding);
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

function createContrastImageData(imageData) {
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        sum += lum;
        sumSquares += lum * lum;
        count++;
    }
    const mean = count ? sum / count : 128;
    const variance = count ? Math.max(1, sumSquares / count - mean * mean) : 1;
    const std = Math.sqrt(variance);
    const gain = std < 16 ? 3.4 : 2.3;
    const data = new Uint8ClampedArray(imageData.data.length);
    for (let offset = 0; offset < imageData.data.length; offset += 4) {
        const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
        const value = Math.max(0, Math.min(255, Math.round(128 + (lum - mean) * gain)));
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = imageData.data[offset + 3];
    }
    return { width: imageData.width, height: imageData.height, data };
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
        `<text x="8" y="36" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="10.5">${escapeSvgText(line1).slice(0, 42)}</text>` +
        `<text x="8" y="51" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10">${escapeSvgText(line2).slice(0, 42)}</text>` +
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
    return `s=${formatNumber(score?.spatial)} g=${formatNumber(score?.gradient)}`;
}

async function renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }) {
    const originalImageData = await decodeImageDataInNode(record.filePath);
    const production = processProduction({ originalImageData, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap });
    const cropBox = cropBoxForRecord(originalImageData, record);
    const beforeCrop = cropImageData(originalImageData, cropBox);
    const productionCrop = cropImageData(production.imageData, cropBox);
    let bestCrop = null;
    if (record.bestRemoval) {
        const bestImage = cloneImageData(originalImageData);
        removeWatermark(
            bestImage,
            resolveAlphaMap(record.bestRemoval.size),
            record.bestRemoval.position,
            { alphaGain: record.bestRemoval.alphaGain }
        );
        bestCrop = cropImageData(bestImage, cropBox);
    }
    const panels = [
        await imageDataToPanel(beforeCrop, 'before', `${record.width}x${record.height}`, '48/96/96'),
        await imageDataToPanel(productionCrop, 'production', scoreLine(record.production), detailLine(record.production)),
        bestCrop
            ? await imageDataToPanel(
                bestCrop,
                `best ${geometryKey(record.bestRemoval)}`,
                `a=${record.bestRemoval.alphaGain} gain=${formatNumber(record.bestRemoval.removalGain)}`,
                scoreLine(record.bestRemoval.processed)
            )
            : null,
        await imageDataToPanel(createDiffImageData(beforeCrop, productionCrop), 'prod diff x5', 'orange removed', 'blue added'),
        await imageDataToPanel(createContrastImageData(productionCrop), 'prod contrast', 'local luma', 'visual check')
    ].filter(Boolean);
    const rowWidth = panels.length * TILE_SIZE;
    const rowHeight = HEADER_HEIGHT + TILE_SIZE + LABEL_HEIGHT;
    const header = `<svg width="${rowWidth}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="#080808"/>` +
        `<text x="10" y="19" fill="#fff" font-family="Arial, sans-serif" font-size="13" font-weight="700">${escapeSvgText(record.file).slice(0, 112)}</text>` +
        `<text x="10" y="39" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(record.taxonomy.label)} | ${escapeSvgText(record.taxonomy.action).slice(0, 94)}</text>` +
        `<text x="10" y="55" fill="#9ea7ad" font-family="Arial, sans-serif" font-size="10.5">visible=${effectiveVisible(record.production)} safety=${record.taxonomy.candidateSafety.label} raw=${record.production?.rawVisible ?? record.production?.visible} risk=${record.production?.metricRisk ?? 'none'} nearBlack=${formatNumber(record.production?.nearBlackRatio)} clip=${formatNumber(record.production?.newlyClippedRatio)}</text>` +
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

async function renderSheet({ records, outputPath, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap, renderLimit }) {
    const selected = records
        .sort((left, right) => right.taxonomy.severity - left.taxonomy.severity)
        .slice(0, renderLimit);
    if (selected.length === 0) return null;
    const rows = [];
    for (const record of selected) {
        rows.push(await renderRecordRow({ record, alpha48, alpha96, alpha96NewMargin, resolveAlphaMap }));
    }
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
    return { outputPath, count: selected.length, width, height };
}

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function recordsToCsv(records) {
    const columns = [
        'file',
        'label',
        'action',
        'severity',
        'visible',
        'rawVisible',
        'calibratedVisible',
        'metricRisk',
        'prodSpatial',
        'prodGradient',
        'prodBalanced',
        'nearBlack',
        'clip',
        'darkHalo',
        'bestGeometry',
        'bestAlphaGain',
        'bestRemovalGain',
        'metricMismatchCandidate',
        'algorithmicResidualCandidate',
        'mismatchReason',
        'needsHumanLabel',
        'candidateSafety',
        'candidateClearsVisible',
        'candidateBalancedDelta',
        'candidateArtifactDelta',
        'source'
    ];
    const rows = records.map((record) => ({
        file: record.file,
        label: record.taxonomy.label,
        action: record.taxonomy.action,
        severity: record.taxonomy.severity,
        visible: effectiveVisible(record.production),
        rawVisible: record.production?.rawVisible ?? record.production?.visible,
        calibratedVisible: record.production?.calibratedVisible ?? record.production?.visible,
        metricRisk: record.production?.metricRisk,
        prodSpatial: record.production?.spatial,
        prodGradient: record.production?.gradient,
        prodBalanced: record.production?.balancedCost,
        nearBlack: record.production?.nearBlackRatio,
        clip: record.production?.newlyClippedRatio,
        darkHalo: record.production?.darkHaloLum,
        bestGeometry: geometryKey(record.bestRemoval),
        bestAlphaGain: record.bestRemoval?.alphaGain,
        bestRemovalGain: record.bestRemoval?.removalGain,
        metricMismatchCandidate: record.taxonomy.metricMismatchCandidate,
        algorithmicResidualCandidate: record.taxonomy.algorithmicResidualCandidate,
        mismatchReason: record.taxonomy.mismatchReason,
        needsHumanLabel: record.taxonomy.needsHumanLabel,
        candidateSafety: record.taxonomy.candidateSafety.label,
        candidateClearsVisible: record.taxonomy.candidateSafety.clearsVisible,
        candidateBalancedDelta: record.taxonomy.candidateSafety.balancedDelta,
        candidateArtifactDelta: record.taxonomy.candidateSafety.artifactDelta,
        source: record.source
    }));
    return [
        columns.join(','),
        ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
    ].join('\n') + '\n';
}

function reviewGroup(record) {
    if (record.taxonomy?.algorithmicResidualCandidate) return 'algorithmic-residual';
    if (record.taxonomy?.metricMismatchCandidate) {
        return `metric-mismatch:${record.taxonomy.mismatchReason ?? 'unknown'}`;
    }
    return 'other-visible';
}

function reviewGroupRank(group) {
    if (group === 'algorithmic-residual') return 0;
    if (group === 'metric-mismatch:low-texture-background-collision') return 1;
    if (group === 'metric-mismatch:positive-spatial-background-collision') return 2;
    if (group === 'metric-mismatch:weak-halo-background-collision') return 3;
    if (group.startsWith('metric-mismatch:')) return 4;
    return 5;
}

function buildDecisionEvidence(record) {
    const reasonCodes = [];
    const candidateSafetyLabel = record.taxonomy?.candidateSafety?.label ?? 'unknown';
    const safeProductionChange = candidateSafetyLabel === 'safe-improvement';
    const needsHumanLabel = record.taxonomy?.needsHumanLabel === true ||
        String(record.taxonomy?.action ?? '').includes('human');

    if (!safeProductionChange) {
        reasonCodes.push(`candidate-${candidateSafetyLabel}`);
    }
    if (record.taxonomy?.metricMismatchCandidate) {
        reasonCodes.push('metric-mismatch-candidate');
    }
    if (needsHumanLabel) {
        reasonCodes.push('human-label-required');
    }
    if (record.taxonomy?.algorithmicResidualCandidate) {
        reasonCodes.push('algorithmic-residual-needs-profile-investigation');
    }

    let nextStep = 'review-candidate-before-production-change';
    if (needsHumanLabel) {
        nextStep = 'human-label-before-production-change';
    } else if (record.taxonomy?.algorithmicResidualCandidate) {
        nextStep = 'investigate-profile-or-alpha-model';
    } else if (safeProductionChange) {
        nextStep = 'candidate-for-gated-production-change';
    }

    return {
        safeProductionChange,
        candidateSafetyLabel,
        reasonCodes,
        nextStep
    };
}

export function buildReviewDecisions(records) {
    return records
        .filter((record) => effectiveVisible(record.production) === true)
        .sort((left, right) => {
            const leftGroup = reviewGroup(left);
            const rightGroup = reviewGroup(right);
            return (
                reviewGroupRank(leftGroup) - reviewGroupRank(rightGroup) ||
                right.taxonomy.severity - left.taxonomy.severity ||
                String(left.file).localeCompare(String(right.file))
            );
        })
        .map((record, index) => {
            const group = reviewGroup(record);
            return {
                index,
                reviewGroup: group,
                mismatchReason: record.taxonomy.mismatchReason,
                file: record.file,
                suggestedLabel: record.taxonomy.label,
                suggestedAction: record.taxonomy.action,
                metrics: {
                    production: record.production,
                    bestRemoval: record.bestRemoval
                },
                taxonomy: {
                    metricMismatchCandidate: record.taxonomy.metricMismatchCandidate,
                    algorithmicResidualCandidate: record.taxonomy.algorithmicResidualCandidate,
                    mismatchReason: record.taxonomy.mismatchReason,
                    candidateSafety: record.taxonomy.candidateSafety
                },
                decisionEvidence: buildDecisionEvidence(record),
                humanLabel: null,
                humanConfidence: null,
                humanNotes: ''
            };
        });
}

function buildDecisionTemplate(records) {
    return {
        schemaVersion: 1,
        instructions: {
            humanLabelValues: [
                'true-visible-watermark',
                'overdark-low-texture',
                'negative-ghost',
                'edge-halo',
                'background-collision',
                'metric-false-positive',
                'acceptable',
                'unsure'
            ],
            confidenceValues: ['high', 'medium', 'low'],
            note: 'Confirm or override the suggested taxonomy. Do not add alpha/profile fields here.'
        },
        decisions: buildReviewDecisions(records)
    };
}

function createMarkdown({ summary, sheets, outputDir }) {
    return [
        '# Metric 48/96/96 Failure Taxonomy',
        '',
        `- total: ${summary.total}`,
        `- raw visible: ${summary.rawVisible}`,
        `- calibrated visible: ${summary.calibratedVisible}`,
        `- metric risk: ${summary.metricRisk}`,
        `- fixable visible: ${summary.fixableVisible}`,
        `- metric mismatch candidate visible: ${summary.metricMismatchCandidateVisible}`,
        `- algorithmic residual candidate visible: ${summary.algorithmicResidualCandidateVisible}`,
        `- human review visible: ${summary.humanReviewVisible}`,
        '',
        '## Metric Risk Reasons',
        '',
        ...Object.entries(summary.metricRiskCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Visible Candidate Safety',
        '',
        ...Object.entries(summary.visibleCandidateSafetyCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Visible Taxonomy',
        '',
        ...Object.entries(summary.visibleTaxonomyCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Visible Mismatch Reasons',
        '',
        ...Object.entries(summary.visibleMismatchReasonCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## Sheets',
        '',
        ...Object.entries(sheets).map(([key, sheet]) => (
            sheet ? `- ${key}: \`${sheet.outputPath}\` (${sheet.count})` : `- ${key}: not generated`
        )),
        '',
        `Artifacts: ${outputDir}`,
        ''
    ].join('\n');
}

export async function createMetric489696FailureTaxonomy(options = {}) {
    const localizationPath = path.resolve(options.localizationPath ?? DEFAULT_LOCALIZATION_PATH);
    const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
    const renderLimit = options.renderLimit ?? DEFAULT_RENDER_LIMIT;
    await mkdir(outputDir, { recursive: true });
    const localization = JSON.parse(stripBom(await readFile(localizationPath, 'utf8')));
    const records = buildTaxonomy(localization.records ?? []);
    const summary = summarize(records);

    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    const resolveAlphaMap = createAlphaResolver(alpha48);

    const sheets = {};
    for (const group of buildSheetGroups(records)) {
        sheets[group.key] = await renderSheet({
            records: group.records,
            outputPath: path.join(outputDir, `${sanitizeFileName(group.key)}.png`),
            alpha48,
            alpha96,
            alpha96NewMargin,
            resolveAlphaMap,
            renderLimit
        });
    }

    const decisionTemplate = buildDecisionTemplate(records);
    await writeFile(path.join(outputDir, 'latest.json'), `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        localizationPath,
        outputDir,
        summary,
        sheets,
        records
    }, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDir, 'summary.md'), createMarkdown({ summary, sheets, outputDir }), 'utf8');
    await writeFile(path.join(outputDir, 'taxonomy.csv'), recordsToCsv(records), 'utf8');
    await writeFile(path.join(outputDir, 'review-decisions.json'), `${JSON.stringify(decisionTemplate, null, 2)}\n`, 'utf8');
    return {
        outputDir,
        summary,
        sheets,
        decisionCount: decisionTemplate.decisions.length
    };
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await createMetric489696FailureTaxonomy(args);
    console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
