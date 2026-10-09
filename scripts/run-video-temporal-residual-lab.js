import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { getVideoAlphaMap } from '../src/video/videoWatermarkDetector.js';
import {
    formatTimestampFileSuffix,
    parseTimestampList,
    renderVideoCropSheet
} from './render-video-crop-sheet.js';
import {
    loadVideoCropBenchmarkManifest,
    resolveBenchmarkPrimaryCandidate
} from './video-crop-benchmark.js';

const DEFAULT_MANIFEST_PATH = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-temporal-residual-lab');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_MATCH_RADIUS = 2;
const LABEL_HEIGHT = 28;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const SHEET_PADDING = 16;
const PANEL_BACKGROUND = '#111827';
const SHEET_BACKGROUND = '#0b1020';

function isBaselineCase(caseItem) {
    return caseItem.referencePath &&
        caseItem.currentPath &&
        !caseItem.tags.includes('variant') &&
        (caseItem.currentProfile?.denoiseBackend || 'none') === 'none';
}

export function selectTemporalResidualCases(manifestCases, { cases = null, includeVariants = false } = {}) {
    const selectedIds = Array.isArray(cases) && cases.length ? new Set(cases) : null;
    return manifestCases
        .filter((caseItem) => caseItem.referencePath && caseItem.currentPath)
        .filter((caseItem) => includeVariants || isBaselineCase(caseItem))
        .filter((caseItem) => !selectedIds || selectedIds.has(caseItem.id));
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

async function encodePng(imageData, outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(imageData.data, {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toFile(outputPath);
}

function lumaAt(data, idx) {
    return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
}

function buildLumaMap(imageData) {
    const luma = new Float32Array(imageData.width * imageData.height);
    for (let i = 0; i < luma.length; i++) {
        luma[i] = lumaAt(imageData.data, i * 4);
    }
    return luma;
}

function scorePatch(currentLuma, previousLuma, width, height, x, y, dx, dy) {
    let sum = 0;
    let count = 0;
    for (let py = -1; py <= 1; py++) {
        const cy = y + py;
        const sy = y + dy + py;
        if (cy < 0 || cy >= height || sy < 0 || sy >= height) continue;
        for (let px = -1; px <= 1; px++) {
            const cx = x + px;
            const sx = x + dx + px;
            if (cx < 0 || cx >= width || sx < 0 || sx >= width) continue;
            sum += Math.abs(currentLuma[cy * width + cx] - previousLuma[sy * width + sx]);
            count++;
        }
    }
    return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
}

function createAccumulator() {
    return {
        n: 0,
        sameJitter: 0,
        matchedJitter: 0,
        matchCost: 0,
        improved: 0,
        worsened: 0
    };
}

function finalizeAccumulator(accumulator) {
    return {
        n: accumulator.n,
        meanSameJitter: accumulator.n ? accumulator.sameJitter / accumulator.n : 0,
        meanMatchedJitter: accumulator.n ? accumulator.matchedJitter / accumulator.n : 0,
        meanMatchCost: accumulator.n ? accumulator.matchCost / accumulator.n : 0,
        improvement: accumulator.n ? (accumulator.sameJitter - accumulator.matchedJitter) / accumulator.n : 0,
        improvedRatio: accumulator.n ? accumulator.improved / accumulator.n : 0,
        worsenedRatio: accumulator.n ? accumulator.worsened / accumulator.n : 0
    };
}

function colorHeat(value, scale, mode = 'hot') {
    const t = Math.max(0, Math.min(1, value / Math.max(0.001, scale)));
    if (mode === 'blue') {
        return [Math.round(40 + t * 80), Math.round(70 + t * 120), Math.round(100 + t * 155)];
    }
    return [Math.round(30 + t * 225), Math.round(30 + Math.max(0, t - 0.35) * 180), Math.round(40 + Math.max(0, t - 0.75) * 120)];
}

function createHeatmap({ width, height, samples, field, scale, mode }) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const idx = i * 4;
        const sample = samples[i];
        if (!sample) {
            data[idx] = 10;
            data[idx + 1] = 14;
            data[idx + 2] = 24;
            data[idx + 3] = 255;
            continue;
        }
        const [r, g, b] = colorHeat(sample[field], scale, mode);
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
    }
    return { width, height, data };
}

function analyzeTemporalPair({ previousOriginal, previousCurrent, currentOriginal, currentCurrent, alphaMap, localPosition, matchRadius }) {
    const width = currentOriginal.width;
    const height = currentOriginal.height;
    const previousOriginalLuma = buildLumaMap(previousOriginal);
    const currentOriginalLuma = buildLumaMap(currentOriginal);
    const samples = new Array(width * height).fill(null);
    const aggregate = createAccumulator();
    const offsetCounts = new Map();

    for (let y = 0; y < localPosition.height; y++) {
        for (let x = 0; x < localPosition.width; x++) {
            const alpha = alphaMap[y * localPosition.width + x] || 0;
            if (alpha <= 0.035) continue;
            const px = localPosition.x + x;
            const py = localPosition.y + y;
            if (px < 0 || px >= width || py < 0 || py >= height) continue;

            let bestDx = 0;
            let bestDy = 0;
            let bestCost = Number.POSITIVE_INFINITY;
            for (let dy = -matchRadius; dy <= matchRadius; dy++) {
                for (let dx = -matchRadius; dx <= matchRadius; dx++) {
                    const sx = px + dx;
                    const sy = py + dy;
                    if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
                    const cost = scorePatch(currentOriginalLuma, previousOriginalLuma, width, height, px, py, dx, dy);
                    if (cost < bestCost) {
                        bestCost = cost;
                        bestDx = dx;
                        bestDy = dy;
                    }
                }
            }

            const idx = (py * width + px) * 4;
            const sameIdx = idx;
            const matchIdx = ((py + bestDy) * width + px + bestDx) * 4;
            const currentDelta = lumaAt(currentCurrent.data, idx) - lumaAt(currentOriginal.data, idx);
            const sameDelta = lumaAt(previousCurrent.data, sameIdx) - lumaAt(previousOriginal.data, sameIdx);
            const matchedDelta = lumaAt(previousCurrent.data, matchIdx) - lumaAt(previousOriginal.data, matchIdx);
            const sameJitter = Math.abs(currentDelta - sameDelta);
            const matchedJitter = Math.abs(currentDelta - matchedDelta);
            const sample = {
                sameJitter,
                matchedJitter,
                matchCost: bestCost,
                improvement: sameJitter - matchedJitter,
                dx: bestDx,
                dy: bestDy,
                alpha
            };
            samples[py * width + px] = sample;

            aggregate.n++;
            aggregate.sameJitter += sameJitter;
            aggregate.matchedJitter += matchedJitter;
            aggregate.matchCost += bestCost;
            if (matchedJitter < sameJitter - 0.5) aggregate.improved++;
            if (matchedJitter > sameJitter + 0.5) aggregate.worsened++;
            const key = `${bestDx},${bestDy}`;
            offsetCounts.set(key, (offsetCounts.get(key) || 0) + 1);
        }
    }

    const offsets = [...offsetCounts.entries()]
        .map(([offset, count]) => ({ offset, count, ratio: aggregate.n ? count / aggregate.n : 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    return {
        ...finalizeAccumulator(aggregate),
        offsets,
        samples
    };
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
        `<text x="10" y="19" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="13">${escaped}</text>` +
        '</svg>'
    );
}

async function buildSheet({ rows, outputPath }) {
    const firstPanel = await sharp(rows[0].panels[0].path).metadata();
    const panelWidth = firstPanel.width;
    const panelHeight = firstPanel.height;
    const columns = rows[0].panels.length;
    const tileHeight = LABEL_HEIGHT + panelHeight;
    const sheetWidth = SHEET_PADDING * 2 + columns * panelWidth + (columns - 1) * PANEL_GAP;
    const sheetHeight = SHEET_PADDING * 2 + rows.length * tileHeight + (rows.length - 1) * ROW_GAP;
    const composites = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const top = SHEET_PADDING + rowIndex * (tileHeight + ROW_GAP);
        for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
            const panel = rows[rowIndex].panels[columnIndex];
            const left = SHEET_PADDING + columnIndex * (panelWidth + PANEL_GAP);
            composites.push({ input: labelSvg({ width: panelWidth, label: `${rows[rowIndex].label} | ${panel.label}` }), left, top });
            composites.push({ input: panel.path, left, top: top + LABEL_HEIGHT });
        }
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp({
        create: {
            width: sheetWidth,
            height: sheetHeight,
            channels: 4,
            background: SHEET_BACKGROUND
        }
    }).composite(composites).png().toFile(outputPath);
}

async function runTemporalResidualCase(caseItem, { outputDir, timestamps, matchRadius }) {
    const caseDir = path.join(outputDir, caseItem.id);
    await rm(caseDir, { recursive: true, force: true });
    await mkdir(caseDir, { recursive: true });

    const sourceSheetPath = path.join(caseDir, 'source-sheet.png');
    const renderResult = await renderVideoCropSheet({
        originalPath: caseItem.originalPath,
        currentPath: caseItem.currentPath,
        referencePath: caseItem.referencePath,
        outputPath: sourceSheetPath,
        timestamps,
        keepFrames: true
    });
    const candidate = resolveBenchmarkPrimaryCandidate(renderResult, caseItem);
    const localPosition = {
        x: candidate.x - renderResult.cropBox.left,
        y: candidate.y - renderResult.cropBox.top,
        width: candidate.size,
        height: candidate.size
    };
    const alphaMap = getVideoAlphaMap(candidate.size, { candidate });
    const rows = [];
    const pairs = [];

    for (let i = 1; i < renderResult.timestamps.length; i++) {
        const prevTs = renderResult.timestamps[i - 1];
        const currTs = renderResult.timestamps[i];
        const prevSuffix = formatTimestampFileSuffix(prevTs);
        const currSuffix = formatTimestampFileSuffix(currTs);
        const previousOriginal = await decodeImageData(path.join(renderResult.frameDir, `original-${prevSuffix}.png`));
        const previousCurrent = await decodeImageData(path.join(renderResult.frameDir, `current-${prevSuffix}.png`));
        const currentOriginal = await decodeImageData(path.join(renderResult.frameDir, `original-${currSuffix}.png`));
        const currentCurrent = await decodeImageData(path.join(renderResult.frameDir, `current-${currSuffix}.png`));
        const referencePath = path.join(renderResult.frameDir, `reference-${currSuffix}.png`);
        const analysis = analyzeTemporalPair({
            previousOriginal,
            previousCurrent,
            currentOriginal,
            currentCurrent,
            alphaMap,
            localPosition,
            matchRadius
        });
        const sameHeatmapPath = path.join(caseDir, `same-jitter-${currSuffix}.png`);
        const matchedHeatmapPath = path.join(caseDir, `matched-jitter-${currSuffix}.png`);
        const matchCostPath = path.join(caseDir, `match-cost-${currSuffix}.png`);
        await encodePng(createHeatmap({
            width: currentOriginal.width,
            height: currentOriginal.height,
            samples: analysis.samples,
            field: 'sameJitter',
            scale: 16
        }), sameHeatmapPath);
        await encodePng(createHeatmap({
            width: currentOriginal.width,
            height: currentOriginal.height,
            samples: analysis.samples,
            field: 'matchedJitter',
            scale: 16
        }), matchedHeatmapPath);
        await encodePng(createHeatmap({
            width: currentOriginal.width,
            height: currentOriginal.height,
            samples: analysis.samples,
            field: 'matchCost',
            scale: 20,
            mode: 'blue'
        }), matchCostPath);

        pairs.push({
            from: prevTs,
            to: currTs,
            n: analysis.n,
            meanSameJitter: analysis.meanSameJitter,
            meanMatchedJitter: analysis.meanMatchedJitter,
            improvement: analysis.improvement,
            meanMatchCost: analysis.meanMatchCost,
            improvedRatio: analysis.improvedRatio,
            worsenedRatio: analysis.worsenedRatio,
            offsets: analysis.offsets
        });
        rows.push({
            label: `${prevTs.toFixed(2)}-${currTs.toFixed(2)}s`,
            panels: [
                { label: 'current', path: path.join(renderResult.frameDir, `current-${currSuffix}.png`) },
                { label: 'reference', path: referencePath },
                { label: 'same jitter', path: sameHeatmapPath },
                { label: 'matched jitter', path: matchedHeatmapPath },
                { label: 'match cost', path: matchCostPath }
            ]
        });
    }

    const sheetPath = path.join(outputDir, `${caseItem.id}-temporal-residual.png`);
    await buildSheet({ rows, outputPath: sheetPath });
    const aggregate = pairs.reduce((acc, pair) => {
        acc.n += pair.n;
        acc.same += pair.meanSameJitter * pair.n;
        acc.matched += pair.meanMatchedJitter * pair.n;
        acc.cost += pair.meanMatchCost * pair.n;
        acc.improved += pair.improvedRatio * pair.n;
        acc.worsened += pair.worsenedRatio * pair.n;
        return acc;
    }, { n: 0, same: 0, matched: 0, cost: 0, improved: 0, worsened: 0 });

    return {
        id: caseItem.id,
        sheetPath,
        sourceSheetPath,
        cropBox: renderResult.cropBox,
        primaryCandidate: candidate,
        localPosition,
        pairs,
        aggregate: {
            n: aggregate.n,
            meanSameJitter: aggregate.n ? aggregate.same / aggregate.n : 0,
            meanMatchedJitter: aggregate.n ? aggregate.matched / aggregate.n : 0,
            improvement: aggregate.n ? (aggregate.same - aggregate.matched) / aggregate.n : 0,
            meanMatchCost: aggregate.n ? aggregate.cost / aggregate.n : 0,
            improvedRatio: aggregate.n ? aggregate.improved / aggregate.n : 0,
            worsenedRatio: aggregate.n ? aggregate.worsened / aggregate.n : 0
        }
    };
}

function formatNumber(value) {
    return Number.isFinite(value) ? value.toFixed(4) : '-';
}

export function renderTemporalResidualLabMarkdown(report) {
    const lines = [];
    lines.push('# Video Temporal Residual Lab');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Match radius: ${report.matchRadius}`);
    lines.push(`Include variants: ${report.includeVariants ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('| Case | Same jitter | Matched jitter | Improvement | Match cost | Improved/Worsened | Sheet |');
    lines.push('|---|---:|---:|---:|---:|---:|---|');
    for (const item of report.cases) {
        lines.push([
            item.id,
            formatNumber(item.aggregate.meanSameJitter),
            formatNumber(item.aggregate.meanMatchedJitter),
            formatNumber(item.aggregate.improvement),
            formatNumber(item.aggregate.meanMatchCost),
            `${formatNumber(item.aggregate.improvedRatio)} / ${formatNumber(item.aggregate.worsenedRatio)}`,
            item.sheetPath
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

export async function runVideoTemporalResidualLab({
    manifestPath = DEFAULT_MANIFEST_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    cases = null,
    timestamps = DEFAULT_TIMESTAMPS,
    matchRadius = DEFAULT_MATCH_RADIUS,
    includeVariants = false
} = {}) {
    const manifest = await loadVideoCropBenchmarkManifest(manifestPath);
    const selectedCases = selectTemporalResidualCases(manifest.cases, { cases, includeVariants });
    const resolvedOutputDir = path.resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
    const resolvedTimestamps = parseTimestampList(timestamps);
    const results = [];
    for (const caseItem of selectedCases) {
        results.push(await runTemporalResidualCase(caseItem, {
            outputDir: resolvedOutputDir,
            timestamps: resolvedTimestamps,
            matchRadius
        }));
    }
    const report = {
        generatedAt: new Date().toISOString(),
        manifestPath: path.resolve(manifestPath),
        outputDir: resolvedOutputDir,
        matchRadius,
        includeVariants,
        timestamps: resolvedTimestamps,
        cases: results
    };
    const jsonPath = path.join(resolvedOutputDir, 'latest-report.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest-report.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderTemporalResidualLabMarkdown(report), 'utf8');
    return { ...report, jsonPath, markdownPath };
}

function parseCliArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        cases: null,
        timestamps: DEFAULT_TIMESTAMPS,
        matchRadius: DEFAULT_MATCH_RADIUS,
        includeVariants: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = path.resolve(argv[++i] || parsed.manifestPath);
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(argv[++i] || parsed.outputDir);
        } else if (arg === '--cases' || arg === '--only') {
            parsed.cases = String(argv[++i] || '').split(',').map((item) => item.trim()).filter(Boolean);
        } else if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(argv[++i]);
        } else if (arg === '--match-radius') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value) && value >= 0) parsed.matchRadius = Math.min(4, Math.round(value));
        } else if (arg === '--include-variants') {
            parsed.includeVariants = true;
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
  node scripts/run-video-temporal-residual-lab.js [options]

Options:
  --cases <ids>            Comma-separated baseline case ids
  --timestamps <list>      Example: 1,3,5,7,9
  --match-radius <n>       Default: 2
  --include-variants       Include explicitly selected variant/currentProfile candidates
  --output-dir <dir>       Default: .artifacts/video-temporal-residual-lab
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    runVideoTemporalResidualLab(args)
        .then((report) => {
            console.log(`json: ${report.jsonPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            for (const item of report.cases) {
                console.log(`[case] ${item.id} sheet=${item.sheetPath}`);
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
