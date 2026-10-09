import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { getVideoAlphaMap } from '../src/video/videoWatermarkDetector.js';
import {
    buildAlphaGradientMap,
    classifyResidualBucket
} from './analyze-video-residual.js';
import {
    formatTimestampFileSuffix,
    parseCropBox,
    parseTimestampList
} from './render-video-crop-sheet.js';

const DEFAULT_MANIFEST_PATH = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_CASE_ID = 'deaee69b';
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-lowbody-regression');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_CROP_BOX = Object.freeze({ left: 1676, top: 836, width: 200, height: 200 });
const DELTA_BINS = Object.freeze([0, 0.25, 0.5, 1, 2, 4, Number.POSITIVE_INFINITY]);
const ALPHA_BINS = Object.freeze([0.035, 0.06, 0.09, 0.12, 0.16, 0.22]);
const GRADIENT_BINS = Object.freeze([0, 0.04, 0.08, 0.12, 0.16, 0.18]);
const SHEET_PADDING = 14;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const LABEL_HEIGHT = 26;
const PANEL_BACKGROUND = '#111827';
const SHEET_BACKGROUND = '#0b1020';

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function createAccumulator() {
    return {
        count: 0,
        baselineAbs: 0,
        variantAbs: 0,
        deltaAbs: 0,
        worsened: 0,
        improved: 0,
        neutral: 0,
        variantMinusBaseline: 0,
        maxDeltaAbs: Number.NEGATIVE_INFINITY,
        maxPixel: null
    };
}

function addSample(acc, sample) {
    acc.count++;
    acc.baselineAbs += sample.baselineAbs;
    acc.variantAbs += sample.variantAbs;
    acc.deltaAbs += sample.deltaAbs;
    acc.variantMinusBaseline += sample.variantResidual - sample.baselineResidual;
    if (sample.deltaAbs > 0.02) acc.worsened++;
    else if (sample.deltaAbs < -0.02) acc.improved++;
    else acc.neutral++;
    if (sample.deltaAbs > acc.maxDeltaAbs) {
        acc.maxDeltaAbs = sample.deltaAbs;
        acc.maxPixel = {
            x: sample.x,
            y: sample.y,
            alpha: round(sample.alpha, 6),
            gradient: round(sample.gradient, 6),
            baselineResidual: round(sample.baselineResidual),
            variantResidual: round(sample.variantResidual),
            baselineAbs: round(sample.baselineAbs),
            variantAbs: round(sample.variantAbs),
            deltaAbs: round(sample.deltaAbs),
            variantMinusBaseline: round(sample.variantResidual - sample.baselineResidual)
        };
    }
}

function finalizeAccumulator(acc) {
    if (!acc || acc.count <= 0) {
        return {
            count: 0,
            baselineMeanAbs: 0,
            variantMeanAbs: 0,
            meanAbsDelta: 0,
            worsenedRatio: 0,
            improvedRatio: 0,
            neutralRatio: 0,
            meanVariantMinusBaseline: 0,
            maxDeltaAbs: 0,
            maxPixel: null
        };
    }

    return {
        count: acc.count,
        baselineMeanAbs: round(acc.baselineAbs / acc.count),
        variantMeanAbs: round(acc.variantAbs / acc.count),
        meanAbsDelta: round(acc.deltaAbs / acc.count),
        worsenedRatio: round(acc.worsened / acc.count),
        improvedRatio: round(acc.improved / acc.count),
        neutralRatio: round(acc.neutral / acc.count),
        meanVariantMinusBaseline: round(acc.variantMinusBaseline / acc.count),
        maxDeltaAbs: round(acc.maxDeltaAbs),
        maxPixel: acc.maxPixel
    };
}

function createBinAccumulators(labels) {
    return Object.fromEntries(labels.map((label) => [label, createAccumulator()]));
}

function findBin(value, bins, formatter) {
    for (let i = 0; i < bins.length - 1; i++) {
        if (value >= bins[i] && value < bins[i + 1]) {
            return formatter(bins[i], bins[i + 1]);
        }
    }
    return formatter(bins[bins.length - 2], bins[bins.length - 1]);
}

function alphaBinLabel(lo, hi) {
    return `${lo.toFixed(3)}-${Number.isFinite(hi) ? hi.toFixed(3) : 'inf'}`;
}

function gradientBinLabel(lo, hi) {
    return `${lo.toFixed(2)}-${Number.isFinite(hi) ? hi.toFixed(2) : 'inf'}`;
}

function deltaBinLabel(lo, hi) {
    return `${lo.toFixed(2)}-${Number.isFinite(hi) ? hi.toFixed(2) : 'inf'}`;
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

function computeBackgroundMean(image, reference, roi, alphaMap) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < roi.height; y++) {
        for (let x = 0; x < roi.width; x++) {
            const alphaIndex = y * roi.width + x;
            if ((alphaMap[alphaIndex] || 0) > 0.035) continue;
            const imageX = roi.x + x;
            const imageY = roi.y + y;
            if (imageX < 0 || imageX >= image.width || imageY < 0 || imageY >= image.height) continue;
            const idx = (imageY * image.width + imageX) * 4;
            sum += lumaAt(image.data, idx) - lumaAt(reference.data, idx);
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}

function createHeatmap({
    width,
    height,
    roi,
    lowBodySamples,
    baseImage
}) {
    const out = new Uint8ClampedArray(baseImage.data.length);
    for (let i = 0; i < baseImage.data.length; i += 4) {
        const luma = lumaAt(baseImage.data, i);
        out[i] = Math.round(luma * 0.35);
        out[i + 1] = Math.round(luma * 0.35);
        out[i + 2] = Math.round(luma * 0.35);
        out[i + 3] = 255;
    }

    for (const sample of lowBodySamples) {
        const imageX = roi.x + sample.x;
        const imageY = roi.y + sample.y;
        if (imageX < 0 || imageX >= width || imageY < 0 || imageY >= height) continue;
        const idx = (imageY * width + imageX) * 4;
        const magnitude = Math.min(1, Math.abs(sample.deltaAbs) / 4);
        if (sample.deltaAbs > 0) {
            out[idx] = Math.round(80 + 175 * magnitude);
            out[idx + 1] = Math.round(28 * (1 - magnitude));
            out[idx + 2] = Math.round(42 * (1 - magnitude));
        } else {
            out[idx] = Math.round(20 * (1 - magnitude));
            out[idx + 1] = Math.round(120 + 110 * magnitude);
            out[idx + 2] = Math.round(180 + 75 * magnitude);
        }
    }

    return { width, height, data: out };
}

async function encodePng(image, outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(image.data, {
        raw: {
            width: image.width,
            height: image.height,
            channels: 4
        }
    }).png().toFile(outputPath);
}

function labelSvg({ width, label }) {
    const escaped = String(label)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return Buffer.from(
        `<svg width="${width}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${width}" height="${LABEL_HEIGHT}" fill="${PANEL_BACKGROUND}"/>` +
        `<text x="8" y="18" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="12">${escaped}</text>` +
        '</svg>'
    );
}

async function buildSheet(rows, outputPath) {
    const first = await sharp(rows[0].panels[0].path).metadata();
    const panelWidth = first.width;
    const panelHeight = first.height;
    const tileHeight = LABEL_HEIGHT + panelHeight;
    const columns = rows[0].panels.length;
    const sheetWidth = SHEET_PADDING * 2 + columns * panelWidth + (columns - 1) * PANEL_GAP;
    const sheetHeight = SHEET_PADDING * 2 + rows.length * tileHeight + (rows.length - 1) * ROW_GAP;
    const composites = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const top = SHEET_PADDING + rowIndex * (tileHeight + ROW_GAP);
        for (let col = 0; col < row.panels.length; col++) {
            const panel = row.panels[col];
            const left = SHEET_PADDING + col * (panelWidth + PANEL_GAP);
            composites.push({ input: labelSvg({ width: panelWidth, label: `${row.label} | ${panel.label}` }), left, top });
            composites.push({ input: panel.path, left, top: top + LABEL_HEIGHT });
        }
    }

    await sharp({
        create: {
            width: sheetWidth,
            height: sheetHeight,
            channels: 4,
            background: SHEET_BACKGROUND
        }
    }).composite(composites).png().toFile(outputPath);
}

function resolveCase(manifest, caseId) {
    const found = manifest.cases.find((item) => item.id === caseId);
    if (!found) throw new Error(`manifest 中找不到 case: ${caseId}`);
    if (!found.expected?.anchor) throw new Error(`case ${caseId} 缺少 expected.anchor`);
    return found;
}

function resolveExpectedCandidate(caseItem) {
    const anchor = caseItem?.expected?.anchor;
    if (!anchor) return null;
    const size = Number(anchor.size ?? anchor.width ?? anchor.height);
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    if (![size, x, y].every(Number.isFinite)) return null;
    return {
        id: 'expected-anchor',
        size: Math.round(size),
        width: Math.round(size),
        height: Math.round(size),
        x: Math.round(x),
        y: Math.round(y),
        marginRight: Number.isFinite(Number(anchor.marginRight)) ? Number(anchor.marginRight) : null,
        marginBottom: Number.isFinite(Number(anchor.marginBottom)) ? Number(anchor.marginBottom) : null,
        source: 'manifest-expected'
    };
}

function parseArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        caseId: DEFAULT_CASE_ID,
        cropBox: DEFAULT_CROP_BOX,
        timestamps: [...DEFAULT_TIMESTAMPS],
        outputDir: DEFAULT_OUTPUT_DIR
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = path.resolve(argv[++i]);
        } else if (arg === '--case') {
            parsed.caseId = argv[++i] || parsed.caseId;
        } else if (arg === '--baseline-frame-dir') {
            parsed.baselineFrameDir = path.resolve(argv[++i]);
        } else if (arg === '--variant-frame-dir') {
            parsed.variantFrameDir = path.resolve(argv[++i]);
        } else if (arg === '--reference-frame-dir') {
            parsed.referenceFrameDir = path.resolve(argv[++i]);
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(argv[++i]);
        } else if (arg === '--crop') {
            parsed.cropBox = parseCropBox(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }

    if (!parsed.help) {
        for (const key of ['baselineFrameDir', 'variantFrameDir', 'referenceFrameDir']) {
            if (!parsed[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
        }
    }

    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/diagnose-video-lowbody-regression.js --baseline-frame-dir <dir> --variant-frame-dir <dir> --reference-frame-dir <dir> [options]

Options:
  --case <id>             Default: deaee69b
  --crop x,y,w,h          Default: 1676,836,200,200
  --timestamps <list>     Default: 1,3,5,7,9
  --output-dir <dir>      Default: .artifacts/video-lowbody-regression
`);
}

export async function diagnoseVideoLowBodyRegression({
    manifestPath = DEFAULT_MANIFEST_PATH,
    caseId = DEFAULT_CASE_ID,
    baselineFrameDir,
    variantFrameDir,
    referenceFrameDir,
    outputDir = DEFAULT_OUTPUT_DIR,
    cropBox = DEFAULT_CROP_BOX,
    timestamps = [...DEFAULT_TIMESTAMPS]
} = {}) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const caseItem = resolveCase(manifest, caseId);
    const anchor = caseItem.expected.anchor;
    const candidate = resolveExpectedCandidate(caseItem);
    const roi = {
        x: Math.round(anchor.x - cropBox.left),
        y: Math.round(anchor.y - cropBox.top),
        width: Math.round(anchor.size || anchor.width || anchor.height),
        height: Math.round(anchor.size || anchor.width || anchor.height)
    };
    const alphaMap = getVideoAlphaMap(roi.width, { candidate });
    const { gradient, maxGradient } = buildAlphaGradientMap(alphaMap, roi.width, roi.height);
    const resolvedOutputDir = path.resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });

    const total = createAccumulator();
    const alphaLabels = ALPHA_BINS.slice(0, -1).map((value, index) => alphaBinLabel(value, ALPHA_BINS[index + 1]));
    const gradientLabels = GRADIENT_BINS.slice(0, -1).map((value, index) => gradientBinLabel(value, GRADIENT_BINS[index + 1]));
    const deltaLabels = DELTA_BINS.slice(0, -1).map((value, index) => deltaBinLabel(value, DELTA_BINS[index + 1]));
    const byAlpha = createBinAccumulators(alphaLabels);
    const byGradient = createBinAccumulators(gradientLabels);
    const byWorseningMagnitude = createBinAccumulators(deltaLabels);
    const frames = [];
    const sheetRows = [];

    for (const timestamp of timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const baselinePath = path.join(baselineFrameDir, `current-${suffix}.png`);
        const variantPath = path.join(variantFrameDir, `current-${suffix}.png`);
        const referencePath = path.join(referenceFrameDir, `reference-${suffix}.png`);
        const baseline = await decodeImageData(baselinePath);
        const variant = await decodeImageData(variantPath);
        const reference = await decodeImageData(referencePath);
        const baselineBackgroundMean = computeBackgroundMean(baseline, reference, roi, alphaMap);
        const variantBackgroundMean = computeBackgroundMean(variant, reference, roi, alphaMap);
        const frame = createAccumulator();
        const lowBodySamples = [];
        const topWorsened = [];

        for (let y = 0; y < roi.height; y++) {
            for (let x = 0; x < roi.width; x++) {
                const alphaIndex = y * roi.width + x;
                const alpha = alphaMap[alphaIndex] || 0;
                const normalizedGradient = maxGradient > 0 ? gradient[alphaIndex] / maxGradient : 0;
                const bucket = classifyResidualBucket(alpha, normalizedGradient);
                if (bucket !== 'lowBody') continue;

                const imageX = roi.x + x;
                const imageY = roi.y + y;
                const idx = (imageY * baseline.width + imageX) * 4;
                const baselineResidual = lumaAt(baseline.data, idx) - lumaAt(reference.data, idx) - baselineBackgroundMean;
                const variantResidual = lumaAt(variant.data, idx) - lumaAt(reference.data, idx) - variantBackgroundMean;
                const baselineAbs = Math.abs(baselineResidual);
                const variantAbs = Math.abs(variantResidual);
                const deltaAbs = variantAbs - baselineAbs;
                const sample = {
                    x,
                    y,
                    alpha,
                    gradient: normalizedGradient,
                    baselineResidual,
                    variantResidual,
                    baselineAbs,
                    variantAbs,
                    deltaAbs
                };

                addSample(frame, sample);
                addSample(total, sample);
                addSample(byAlpha[findBin(alpha, ALPHA_BINS, alphaBinLabel)], sample);
                addSample(byGradient[findBin(normalizedGradient, GRADIENT_BINS, gradientBinLabel)], sample);
                if (deltaAbs > 0) {
                    addSample(byWorseningMagnitude[findBin(deltaAbs, DELTA_BINS, deltaBinLabel)], sample);
                }
                lowBodySamples.push(sample);
                if (deltaAbs > 0) {
                    topWorsened.push({
                        x,
                        y,
                        alpha: round(alpha, 6),
                        gradient: round(normalizedGradient, 6),
                        baselineResidual: round(baselineResidual),
                        variantResidual: round(variantResidual),
                        deltaAbs: round(deltaAbs),
                        variantMinusBaseline: round(variantResidual - baselineResidual)
                    });
                }
            }
        }

        topWorsened.sort((a, b) => b.deltaAbs - a.deltaAbs);
        const heatmap = createHeatmap({
            width: baseline.width,
            height: baseline.height,
            roi,
            lowBodySamples,
            baseImage: reference
        });
        const heatmapPath = path.join(resolvedOutputDir, `lowbody-delta-${suffix}.png`);
        await encodePng(heatmap, heatmapPath);
        frames.push({
            timestamp,
            baselineBackgroundMean: round(baselineBackgroundMean),
            variantBackgroundMean: round(variantBackgroundMean),
            lowBody: finalizeAccumulator(frame),
            topWorsened: topWorsened.slice(0, 12),
            heatmapPath
        });
        sheetRows.push({
            label: `${timestamp.toFixed(2)}s`,
            panels: [
                { label: 'baseline', path: baselinePath },
                { label: 'variant', path: variantPath },
                { label: 'reference', path: referencePath },
                { label: 'lowBody delta', path: heatmapPath }
            ]
        });
    }

    const sheetPath = path.join(resolvedOutputDir, 'lowbody-delta-sheet.png');
    await buildSheet(sheetRows, sheetPath);

    const report = {
        generatedAt: new Date().toISOString(),
        caseId,
        cropBox,
        roi,
        candidate,
        timestamps,
        frameDirs: {
            baseline: path.resolve(baselineFrameDir),
            variant: path.resolve(variantFrameDir),
            reference: path.resolve(referenceFrameDir)
        },
        aggregate: finalizeAccumulator(total),
        byAlpha: Object.fromEntries(Object.entries(byAlpha).map(([key, value]) => [key, finalizeAccumulator(value)])),
        byGradient: Object.fromEntries(Object.entries(byGradient).map(([key, value]) => [key, finalizeAccumulator(value)])),
        byWorseningMagnitude: Object.fromEntries(Object.entries(byWorseningMagnitude).map(([key, value]) => [key, finalizeAccumulator(value)])),
        frames,
        sheetPath
    };
    const jsonPath = path.join(resolvedOutputDir, 'latest.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return { ...report, jsonPath, markdownPath };
}

function formatSigned(value) {
    if (!Number.isFinite(value)) return '-';
    return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function renderMarkdown(report) {
    const lines = [];
    lines.push('# Video LowBody Regression Diagnostic');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Case: ${report.caseId}`);
    lines.push(`ROI: ${report.roi.x},${report.roi.y},${report.roi.width},${report.roi.height}`);
    lines.push(`Sheet: ${report.sheetPath}`);
    lines.push('');
    lines.push('## Aggregate');
    lines.push('');
    lines.push('| Count | Baseline meanAbs | Variant meanAbs | Δ meanAbs | Worsened | Improved | Mean variant-baseline |');
    lines.push('|---:|---:|---:|---:|---:|---:|---:|');
    lines.push([
        report.aggregate.count,
        report.aggregate.baselineMeanAbs.toFixed(4),
        report.aggregate.variantMeanAbs.toFixed(4),
        formatSigned(report.aggregate.meanAbsDelta),
        report.aggregate.worsenedRatio.toFixed(4),
        report.aggregate.improvedRatio.toFixed(4),
        formatSigned(report.aggregate.meanVariantMinusBaseline)
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    lines.push('');
    lines.push('## Frames');
    lines.push('');
    lines.push('| Time | Baseline meanAbs | Variant meanAbs | Δ meanAbs | Worsened | Max Δ | Hotspot | Heatmap |');
    lines.push('|---:|---:|---:|---:|---:|---:|---|---|');
    for (const frame of report.frames) {
        const hot = frame.lowBody.maxPixel
            ? `${frame.lowBody.maxPixel.x},${frame.lowBody.maxPixel.y} a=${frame.lowBody.maxPixel.alpha} g=${frame.lowBody.maxPixel.gradient}`
            : '-';
        lines.push([
            frame.timestamp.toFixed(2),
            frame.lowBody.baselineMeanAbs.toFixed(4),
            frame.lowBody.variantMeanAbs.toFixed(4),
            formatSigned(frame.lowBody.meanAbsDelta),
            frame.lowBody.worsenedRatio.toFixed(4),
            frame.lowBody.maxDeltaAbs.toFixed(4),
            hot,
            frame.heatmapPath
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Alpha Bins');
    lines.push('');
    lines.push('| Alpha | Count | Δ meanAbs | Worsened | Mean variant-baseline | Max Δ |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const [label, stats] of Object.entries(report.byAlpha)) {
        lines.push([
            label,
            stats.count,
            formatSigned(stats.meanAbsDelta),
            stats.worsenedRatio.toFixed(4),
            formatSigned(stats.meanVariantMinusBaseline),
            stats.maxDeltaAbs.toFixed(4)
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Gradient Bins');
    lines.push('');
    lines.push('| Gradient | Count | Δ meanAbs | Worsened | Mean variant-baseline | Max Δ |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const [label, stats] of Object.entries(report.byGradient)) {
        lines.push([
            label,
            stats.count,
            formatSigned(stats.meanAbsDelta),
            stats.worsenedRatio.toFixed(4),
            formatSigned(stats.meanVariantMinusBaseline),
            stats.maxDeltaAbs.toFixed(4)
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    diagnoseVideoLowBodyRegression(args)
        .then((report) => {
            console.log(`json: ${report.jsonPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            console.log(`sheet: ${report.sheetPath}`);
            console.log(`lowBody delta: ${formatSigned(report.aggregate.meanAbsDelta)}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
