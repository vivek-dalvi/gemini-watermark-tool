import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import {
    applyVideoResidualCleanup,
    applyVideoResidualCleanupAsync
} from '../src/video/videoCleanupBackends.js';
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
import {
    summarizeResidualFrames,
    summarizeWatermarkResidual
} from './analyze-video-residual.js';

const DEFAULT_MANIFEST_PATH = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-frame-backend-lab');
const DEFAULT_DENOISE_BACKEND = 'canvas-edge-denoise';
const DEFAULT_EDGE_DENOISE_STRENGTH = 0.65;
const DEFAULT_DIFF_AMPLIFY = 4;
const DELTA_VERDICT_EPSILON = 1e-9;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const LABEL_HEIGHT = 28;
const SHEET_PADDING = 16;
const PANEL_BACKGROUND = '#111827';
const SHEET_BACKGROUND = '#0b1020';

function isBaselineCase(caseItem) {
    return caseItem.referencePath &&
        caseItem.currentPath &&
        !caseItem.tags.includes('variant') &&
        (caseItem.currentProfile?.denoiseBackend || 'none') === 'none';
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
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

function createImageDataContext(imageData) {
    return {
        canvas: {
            width: imageData.width,
            height: imageData.height
        },
        getImageData(x, y, width, height) {
            const left = Math.round(x);
            const top = Math.round(y);
            const w = Math.round(width);
            const h = Math.round(height);
            const output = new Uint8ClampedArray(w * h * 4);

            for (let row = 0; row < h; row++) {
                for (let col = 0; col < w; col++) {
                    const sourceX = left + col;
                    const sourceY = top + row;
                    if (sourceX < 0 || sourceX >= imageData.width || sourceY < 0 || sourceY >= imageData.height) {
                        continue;
                    }
                    const sourceIdx = (sourceY * imageData.width + sourceX) * 4;
                    const targetIdx = (row * w + col) * 4;
                    output[targetIdx] = imageData.data[sourceIdx];
                    output[targetIdx + 1] = imageData.data[sourceIdx + 1];
                    output[targetIdx + 2] = imageData.data[sourceIdx + 2];
                    output[targetIdx + 3] = imageData.data[sourceIdx + 3];
                }
            }

            return { width: w, height: h, data: output };
        },
        putImageData(patch, x, y) {
            const left = Math.round(x);
            const top = Math.round(y);
            for (let row = 0; row < patch.height; row++) {
                for (let col = 0; col < patch.width; col++) {
                    const targetX = left + col;
                    const targetY = top + row;
                    if (targetX < 0 || targetX >= imageData.width || targetY < 0 || targetY >= imageData.height) {
                        continue;
                    }
                    const sourceIdx = (row * patch.width + col) * 4;
                    const targetIdx = (targetY * imageData.width + targetX) * 4;
                    imageData.data[targetIdx] = patch.data[sourceIdx];
                    imageData.data[targetIdx + 1] = patch.data[sourceIdx + 1];
                    imageData.data[targetIdx + 2] = patch.data[sourceIdx + 2];
                    imageData.data[targetIdx + 3] = patch.data[sourceIdx + 3];
                }
            }
        }
    };
}

export function calculateBucketDeltas(variantAggregate, baselineAggregate) {
    const buckets = ['active', 'edge', 'lowBody', 'highBody'];
    const deltas = {};
    for (const bucket of buckets) {
        const variant = variantAggregate?.[bucket];
        const baseline = baselineAggregate?.[bucket];
        if (!variant || !baseline) continue;
        const meanAbsDelta = variant.meanAbs - baseline.meanAbs;
        deltas[bucket] = {
            meanAbsDelta,
            rmsDelta: variant.rms - baseline.rms,
            meanDelta: variant.mean - baseline.mean,
            verdict: meanAbsDelta < -0.02 - DELTA_VERDICT_EPSILON
                ? 'improved'
                : meanAbsDelta > 0.02 + DELTA_VERDICT_EPSILON
                    ? 'regressed'
                    : 'neutral'
        };
    }
    return deltas;
}

function labelSvg({ width, height, label }) {
    const escaped = String(label)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${width}" height="${height}" fill="${PANEL_BACKGROUND}"/>` +
        `<text x="10" y="19" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="13">${escaped}</text>` +
        '</svg>'
    );
}

async function createDiffPanel(leftPath, rightPath, outputPath, { amplify = DEFAULT_DIFF_AMPLIFY } = {}) {
    const { data: leftData, info } = await sharp(leftPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const { data: rightData } = await sharp(rightPath)
        .ensureAlpha()
        .resize(info.width, info.height, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const output = Buffer.alloc(leftData.length);

    for (let i = 0; i < leftData.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            output[i + channel] = Math.min(255, Math.abs(leftData[i + channel] - rightData[i + channel]) * amplify);
        }
        output[i + 3] = 255;
    }

    await sharp(output, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4
        }
    }).png().toFile(outputPath);
}

async function buildSheet({ rows, columns, outputPath }) {
    const firstPanel = await sharp(rows[0].panels[0].path).metadata();
    const panelWidth = firstPanel.width;
    const panelHeight = firstPanel.height;
    const tileHeight = LABEL_HEIGHT + panelHeight;
    const sheetWidth = SHEET_PADDING * 2 + columns.length * panelWidth + (columns.length - 1) * PANEL_GAP;
    const sheetHeight = SHEET_PADDING * 2 + rows.length * tileHeight + (rows.length - 1) * ROW_GAP;
    const composites = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const top = SHEET_PADDING + rowIndex * (tileHeight + ROW_GAP);
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
            const panel = row.panels[columnIndex];
            const left = SHEET_PADDING + columnIndex * (panelWidth + PANEL_GAP);
            composites.push({
                input: labelSvg({
                    width: panelWidth,
                    height: LABEL_HEIGHT,
                    label: `${row.label} | ${panel.label}`
                }),
                left,
                top
            });
            composites.push({
                input: panel.path,
                left,
                top: top + LABEL_HEIGHT
            });
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

async function runCaseLab(caseItem, {
    outputDir,
    timestamps,
    denoiseBackend,
    edgeDenoiseStrength,
    residualCleanupStrength,
    allenkFdncnnRuntime = null,
    allenkFdncnnSigma = undefined,
    allenkFdncnnPadding = undefined,
    diffAmplify
}) {
    const caseDir = path.join(outputDir, caseItem.id);
    const sourceSheetPath = path.join(caseDir, 'source-sheet.png');
    await rm(caseDir, { recursive: true, force: true });
    await mkdir(caseDir, { recursive: true });

    const renderResult = await renderVideoCropSheet({
        originalPath: caseItem.originalPath,
        currentPath: caseItem.currentPath,
        referencePath: caseItem.referencePath,
        outputPath: sourceSheetPath,
        timestamps,
        keepFrames: true,
        diffAmplify
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
    const baselineFrames = [];
    const variantFrames = [];
    const cleanupResults = [];

    for (const timestamp of renderResult.timestamps) {
        const suffix = formatTimestampFileSuffix(timestamp);
        const originalPath = path.join(renderResult.frameDir, `original-${suffix}.png`);
        const currentPath = path.join(renderResult.frameDir, `current-${suffix}.png`);
        const referencePath = path.join(renderResult.frameDir, `reference-${suffix}.png`);
        const variantPath = path.join(caseDir, `variant-${suffix}.png`);
        const currentDiffPath = path.join(caseDir, `diff-current-reference-${suffix}.png`);
        const variantDiffPath = path.join(caseDir, `diff-variant-reference-${suffix}.png`);

        const currentImage = await decodeImageData(currentPath);
        const referenceImage = await decodeImageData(referencePath);
        const variantImage = cloneImageData(currentImage);
        const ctx = createImageDataContext(variantImage);
        const cleanupOptions = {
            residualCleanupStrength,
            denoiseBackend,
            edgeDenoiseStrength,
            allenkFdncnnRuntime,
            allenkFdncnnSigma,
            allenkFdncnnPadding
        };
        const cleanupResult = allenkFdncnnRuntime
            ? await applyVideoResidualCleanupAsync(ctx, localPosition, alphaMap, cleanupOptions)
            : applyVideoResidualCleanup(ctx, localPosition, alphaMap, cleanupOptions);
        cleanupResults.push({
            timestamp,
            denoiseRuntimeStatus: cleanupResult.denoiseRuntimeStatus || null,
            denoiseRuntime: cleanupResult.denoiseRuntime || null,
            denoiseRuntimeMacs: cleanupResult.denoiseRuntimeMacs ?? null,
            denoiseRuntimeRunMs: cleanupResult.denoiseRuntimeRunMs ?? null,
            denoiseRuntimeReason: cleanupResult.denoiseRuntimeReason || null
        });
        await encodePng(variantImage, variantPath);
        await createDiffPanel(currentPath, referencePath, currentDiffPath, { amplify: diffAmplify });
        await createDiffPanel(variantPath, referencePath, variantDiffPath, { amplify: diffAmplify });

        const baselineResidual = summarizeWatermarkResidual({
            currentImage,
            referenceImage,
            alphaMap,
            watermarkPosition: localPosition
        });
        const variantResidual = summarizeWatermarkResidual({
            currentImage: variantImage,
            referenceImage,
            alphaMap,
            watermarkPosition: localPosition
        });

        baselineFrames.push({
            timestamp,
            backgroundMean: baselineResidual.backgroundMean,
            buckets: baselineResidual.buckets
        });
        variantFrames.push({
            timestamp,
            backgroundMean: variantResidual.backgroundMean,
            buckets: variantResidual.buckets
        });
        rows.push({
            label: `${timestamp.toFixed(2)}s`,
            panels: [
                { label: 'original', path: originalPath },
                { label: 'baseline', path: currentPath },
                { label: 'variant', path: variantPath },
                { label: 'reference', path: referencePath },
                { label: `diff baseline/ref x${diffAmplify}`, path: currentDiffPath },
                { label: `diff variant/ref x${diffAmplify}`, path: variantDiffPath }
            ]
        });
    }

    const sheetPath = path.join(outputDir, `${caseItem.id}-${denoiseBackend}.png`);
    await buildSheet({
        rows,
        columns: ['original', 'baseline', 'variant', 'reference', 'baselineDiff', 'variantDiff'],
        outputPath: sheetPath
    });

    const baselineAggregate = summarizeResidualFrames(baselineFrames);
    const variantAggregate = summarizeResidualFrames(variantFrames);
    return {
        id: caseItem.id,
        label: caseItem.label,
        outputDir: caseDir,
        sheetPath,
        sourceSheetPath,
        timestamps: renderResult.timestamps,
        cropBox: renderResult.cropBox,
        primaryCandidate: candidate,
        localWatermarkPosition: localPosition,
        profile: {
            denoiseBackend,
            edgeDenoiseStrength,
            residualCleanupStrength,
            allenkFdncnnSigma,
            allenkFdncnnPadding
        },
        cleanupResults,
        baselineAggregate,
        variantAggregate,
        deltas: calculateBucketDeltas(variantAggregate, baselineAggregate)
    };
}

function formatNumber(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatSigned(value, digits = 4) {
    if (!Number.isFinite(value)) return '-';
    const formatted = value.toFixed(digits);
    return value > 0 ? `+${formatted}` : formatted;
}

export function renderVideoFrameBackendLabMarkdown(report) {
    const lines = [];
    lines.push('# Video Frame Backend Lab');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Backend: ${report.profile.denoiseBackend}`);
    lines.push(`Edge denoise strength: ${report.profile.edgeDenoiseStrength}`);
    lines.push(`Residual cleanup strength: ${report.profile.residualCleanupStrength}`);
    if (report.profile.allenkFdncnnRuntime) {
        lines.push(`allenk runtime: ${report.profile.allenkFdncnnRuntime}`);
    }
    lines.push('');
    lines.push('| Case | Active Δ | Edge Δ | LowBody Δ | HighBody Δ | Sheet |');
    lines.push('|---|---:|---:|---:|---:|---|');
    for (const item of report.cases) {
        const delta = item.deltas;
        lines.push([
            item.id,
            `${formatSigned(delta.active?.meanAbsDelta)} (${delta.active?.verdict || '-'})`,
            `${formatSigned(delta.edge?.meanAbsDelta)} (${delta.edge?.verdict || '-'})`,
            `${formatSigned(delta.lowBody?.meanAbsDelta)} (${delta.lowBody?.verdict || '-'})`,
            `${formatSigned(delta.highBody?.meanAbsDelta)} (${delta.highBody?.verdict || '-'})`,
            item.sheetPath
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Aggregates');
    lines.push('');
    for (const item of report.cases) {
        lines.push(`### ${item.id}`);
        lines.push('');
        const appliedRuntimeFrames = (item.cleanupResults || [])
            .filter((result) => result.denoiseRuntimeStatus === 'applied');
        if (appliedRuntimeFrames.length) {
            const avgRunMs = appliedRuntimeFrames.reduce((sum, result) => sum + (result.denoiseRuntimeRunMs || 0), 0) / appliedRuntimeFrames.length;
            lines.push(`Runtime: ${appliedRuntimeFrames[0].denoiseRuntime}, applied frames: ${appliedRuntimeFrames.length}, avg run: ${formatNumber(avgRunMs, 1)}ms`);
            lines.push('');
        }
        lines.push('| Bucket | Baseline meanAbs/RMS | Variant meanAbs/RMS | Δ meanAbs | Verdict |');
        lines.push('|---|---:|---:|---:|---|');
        for (const bucket of ['active', 'edge', 'lowBody', 'highBody']) {
            const baseline = item.baselineAggregate[bucket];
            const variant = item.variantAggregate[bucket];
            const delta = item.deltas[bucket];
            lines.push([
                bucket,
                `${formatNumber(baseline?.meanAbs)} / ${formatNumber(baseline?.rms)}`,
                `${formatNumber(variant?.meanAbs)} / ${formatNumber(variant?.rms)}`,
                formatSigned(delta?.meanAbsDelta),
                delta?.verdict || '-'
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

export async function runVideoFrameBackendLab({
    manifestPath = DEFAULT_MANIFEST_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    cases = null,
    timestamps = null,
    denoiseBackend = DEFAULT_DENOISE_BACKEND,
    edgeDenoiseStrength = DEFAULT_EDGE_DENOISE_STRENGTH,
    residualCleanupStrength = 0,
    allenkFdncnnRuntime = null,
    allenkFdncnnSigma = undefined,
    allenkFdncnnPadding = undefined,
    diffAmplify = DEFAULT_DIFF_AMPLIFY
} = {}) {
    const manifest = await loadVideoCropBenchmarkManifest(manifestPath);
    const selectedIds = Array.isArray(cases) && cases.length ? new Set(cases) : null;
    const selectedCases = manifest.cases
        .filter(isBaselineCase)
        .filter((caseItem) => !selectedIds || selectedIds.has(caseItem.id));
    const resolvedOutputDir = path.resolve(outputDir);
    const resolvedTimestamps = timestamps ? parseTimestampList(timestamps) : (manifest.timestamps || undefined);
    await mkdir(resolvedOutputDir, { recursive: true });

    const results = [];
    for (const caseItem of selectedCases) {
        results.push(await runCaseLab(caseItem, {
            outputDir: resolvedOutputDir,
            timestamps: resolvedTimestamps,
            denoiseBackend,
            edgeDenoiseStrength,
            residualCleanupStrength,
            allenkFdncnnRuntime,
            allenkFdncnnSigma,
            allenkFdncnnPadding,
            diffAmplify
        }));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        manifestPath: path.resolve(manifestPath),
        outputDir: resolvedOutputDir,
        profile: {
            denoiseBackend,
            edgeDenoiseStrength,
            residualCleanupStrength,
            allenkFdncnnRuntime: allenkFdncnnRuntime?.id || null,
            allenkFdncnnSigma,
            allenkFdncnnPadding
        },
        cases: results
    };
    const jsonPath = path.join(resolvedOutputDir, 'latest-report.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest-report.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderVideoFrameBackendLabMarkdown(report), 'utf8');
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
        denoiseBackend: DEFAULT_DENOISE_BACKEND,
        edgeDenoiseStrength: DEFAULT_EDGE_DENOISE_STRENGTH,
        residualCleanupStrength: 0,
        diffAmplify: DEFAULT_DIFF_AMPLIFY
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
        } else if (arg === '--denoise-backend') {
            parsed.denoiseBackend = argv[++i] || parsed.denoiseBackend;
        } else if (arg === '--edge-denoise-strength') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value)) parsed.edgeDenoiseStrength = value;
        } else if (arg === '--residual-cleanup-strength') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value)) parsed.residualCleanupStrength = value;
        } else if (arg === '--diff-amplify') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value) && value > 0) parsed.diffAmplify = value;
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
  node scripts/run-video-frame-backend-lab.js [options]

Options:
  --cases <ids>                    Comma-separated baseline case ids
  --denoise-backend <backend>      Default: canvas-edge-denoise
  --edge-denoise-strength <n>      Default: 0.65
  --residual-cleanup-strength <n>  Default: 0
  --timestamps <list>              Example: 1,3,5
  --output-dir <dir>               Default: .artifacts/video-frame-backend-lab
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    runVideoFrameBackendLab(args)
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
