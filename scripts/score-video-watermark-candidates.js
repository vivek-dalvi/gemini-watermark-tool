import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation
} from '../src/core/adaptiveDetector.js';
import {
    detectVideoWatermarkFromFrames,
    getVideoAlphaMap
} from '../src/video/videoWatermarkDetector.js';
import { resolveVideoWatermarkCandidates } from '../src/video/videoWatermarkCatalog.js';
import {
    normalizeCropBox,
    parseTimestampList,
    renderVideoCropSheet,
    resolveVideoCropTimestamps
} from './render-video-crop-sheet.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-candidate-scores/latest.json');
const DEFAULT_CROP_SHEET_PATH = path.resolve('.artifacts/video-candidate-scores/latest-crop-sheet.png');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_GRID_LIMIT = 20;
const DEFAULT_GRID_STEP = 4;
const DEFAULT_MARGIN_PADDING = 48;
const DEFAULT_SIZE_PADDING = 8;
const STRONG_CONFIDENCE = 0.18;
const CATALOG_MATCH_CONFIDENCE_DELTA = 0.08;
const GEOMETRY_MATCH_TOLERANCE = 2;

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
}

function uniqueSorted(values) {
    return [...new Set(values.filter(Number.isFinite).map(Math.round))].sort((a, b) => a - b);
}

function buildSteppedRange(min, max, step) {
    const safeStep = Math.max(1, Math.round(step || DEFAULT_GRID_STEP));
    const values = [];
    for (let value = Math.round(min); value <= Math.round(max); value += safeStep) {
        values.push(value);
    }
    values.push(Math.round(min), Math.round(max));
    return uniqueSorted(values);
}

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
            }
        });
    });
}

async function probeVideo(videoPath) {
    const { stdout } = await runProcess('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration,size,bit_rate',
        '-of', 'json',
        videoPath
    ]);
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams?.[0];
    if (!stream) {
        throw new Error(`无法读取视频流：${videoPath}`);
    }
    return {
        width: Number(stream.width),
        height: Number(stream.height),
        duration: Number(parsed.format?.duration),
        sizeBytes: Number(parsed.format?.size),
        bitRate: Number(parsed.format?.bit_rate),
        frameRate: stream.avg_frame_rate || stream.r_frame_rate || null,
        frameCount: Number(stream.nb_frames) || null
    };
}

async function extractFrame({ videoPath, timestamp, outputPath }) {
    await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        outputPath
    ]);
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

function scoreCandidateFrame(imageData, candidate, alphaMap = null) {
    const resolvedAlphaMap = alphaMap || getVideoAlphaMap(candidate.size, { candidate });
    const region = {
        x: candidate.x,
        y: candidate.y,
        size: candidate.size
    };
    const spatial = computeRegionSpatialCorrelation({ imageData, alphaMap: resolvedAlphaMap, region });
    const gradient = computeRegionGradientCorrelation({ imageData, alphaMap: resolvedAlphaMap, region });
    const confidence = Math.max(0, spatial) * 0.35 + Math.max(0, gradient) * 0.65;
    return { spatial, gradient, confidence };
}

function summarizeFrameScoreValues(scores) {
    if (!scores.length) {
        return {
            meanSpatial: 0,
            meanGradient: 0,
            meanConfidence: 0,
            maxConfidence: 0,
            minConfidence: 0
        };
    }
    const totals = scores.reduce((acc, score) => {
        acc.spatial += score.spatial;
        acc.gradient += score.gradient;
        acc.confidence += score.confidence;
        acc.maxConfidence = Math.max(acc.maxConfidence, score.confidence);
        acc.minConfidence = Math.min(acc.minConfidence, score.confidence);
        return acc;
    }, {
        spatial: 0,
        gradient: 0,
        confidence: 0,
        maxConfidence: Number.NEGATIVE_INFINITY,
        minConfidence: Number.POSITIVE_INFINITY
    });
    return {
        meanSpatial: totals.spatial / scores.length,
        meanGradient: totals.gradient / scores.length,
        meanConfidence: totals.confidence / scores.length,
        maxConfidence: totals.maxConfidence,
        minConfidence: totals.minConfidence
    };
}

export function summarizeCandidateScores(candidates, perCandidateFrameScores, metadata) {
    return candidates
        .map((candidate) => {
            const frameScores = perCandidateFrameScores.get(candidate.id) || [];
            const summary = summarizeFrameScoreValues(frameScores);
            return {
                candidateId: candidate.id,
                label: candidate.label,
                x: candidate.x,
                y: candidate.y,
                size: candidate.size,
                marginRight: metadata.width - candidate.x - candidate.size,
                marginBottom: metadata.height - candidate.y - candidate.size,
                sourceFamily: candidate.sourceFamily ?? null,
                evidenceGate: candidate.evidenceGate ?? null,
                meanSpatial: summary.meanSpatial,
                meanGradient: summary.meanGradient,
                meanConfidence: summary.meanConfidence,
                maxConfidence: summary.maxConfidence,
                minConfidence: summary.minConfidence,
                frameScores
            };
        })
        .sort((left, right) => right.meanConfidence - left.meanConfidence);
}

export function createGridSearchRanges({
    width,
    height,
    candidates = [],
    extraSizes = [],
    step = DEFAULT_GRID_STEP,
    marginPadding = DEFAULT_MARGIN_PADDING,
    sizePadding = DEFAULT_SIZE_PADDING
}) {
    const candidateSizes = candidates.map((candidate) => candidate.size).filter(Number.isFinite);
    const explicitExtraSizes = extraSizes.map((value) => Number(value)).filter(Number.isFinite);
    const minCandidateSize = candidateSizes.length ? Math.min(...candidateSizes) : Math.min(width, height) * 0.05;
    const maxCandidateSize = candidateSizes.length ? Math.max(...candidateSizes) : Math.min(width, height) * 0.08;
    const sizes = uniqueSorted([
        ...buildSteppedRange(
            Math.max(24, minCandidateSize - sizePadding),
            Math.min(Math.min(width, height), maxCandidateSize + sizePadding),
            Math.max(2, step)
        ),
        ...candidateSizes,
        ...explicitExtraSizes
    ]);

    const catalogMarginRights = candidates.map((candidate) => candidate.marginRight).filter(Number.isFinite);
    const catalogMarginBottoms = candidates.map((candidate) => candidate.marginBottom).filter(Number.isFinite);
    const maxSize = Math.max(...sizes);
    const minRight = Math.max(8, (catalogMarginRights.length ? Math.min(...catalogMarginRights) : 24) - marginPadding);
    const maxRight = Math.min(width - maxSize, (catalogMarginRights.length ? Math.max(...catalogMarginRights) : 128) + marginPadding);
    const minBottom = Math.max(8, (catalogMarginBottoms.length ? Math.min(...catalogMarginBottoms) : 24) - marginPadding);
    const maxBottom = Math.min(height - maxSize, (catalogMarginBottoms.length ? Math.max(...catalogMarginBottoms) : 128) + marginPadding);

    return {
        sizes,
        marginRights: uniqueSorted([
            ...buildSteppedRange(minRight, Math.max(minRight, maxRight), step),
            ...catalogMarginRights
        ]),
        marginBottoms: uniqueSorted([
            ...buildSteppedRange(minBottom, Math.max(minBottom, maxBottom), step),
            ...catalogMarginBottoms
        ])
    };
}

function createGridCandidate({ width, height, size, marginRight, marginBottom }) {
    const x = width - marginRight - size;
    const y = height - marginBottom - size;
    if (x < 0 || y < 0 || x + size > width || y + size > height) return null;
    return {
        id: `grid-${size}-${marginRight}-${marginBottom}`,
        label: `grid ${size}px margin ${marginRight}/${marginBottom}`,
        x,
        y,
        size,
        marginRight,
        marginBottom,
        sourceFamily: 'grid-search',
        evidenceGate: 'review'
    };
}

export function summarizeGridSearch(gridScores, { limit = DEFAULT_GRID_LIMIT } = {}) {
    return [...gridScores]
        .sort((left, right) => right.meanConfidence - left.meanConfidence)
        .slice(0, Math.max(1, Math.round(limit)));
}

function isGeometryMatch(left, right, tolerance = GEOMETRY_MATCH_TOLERANCE) {
    if (!left || !right) return false;
    return (
        Math.abs(left.size - right.size) <= tolerance &&
        Math.abs(left.marginRight - right.marginRight) <= tolerance &&
        Math.abs(left.marginBottom - right.marginBottom) <= tolerance
    );
}

function getCandidateCenter(candidate) {
    if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
    return {
        x: candidate.x + candidate.size / 2,
        y: candidate.y + candidate.size / 2
    };
}

function isGridCoreCoveredByCatalog(catalog, grid) {
    const catalogCenter = getCandidateCenter(catalog);
    const gridCenter = getCandidateCenter(grid);
    if (!catalogCenter || !gridCenter) return false;
    const maxCenterDelta = Math.max(6, catalog.size * 0.25);
    return (
        grid.size <= catalog.size &&
        Math.abs(catalogCenter.x - gridCenter.x) <= maxCenterDelta &&
        Math.abs(catalogCenter.y - gridCenter.y) <= maxCenterDelta
    );
}

export function classifyCatalogRecommendation({
    catalogScores = [],
    gridScores = [],
    strongConfidence = STRONG_CONFIDENCE,
    matchConfidenceDelta = CATALOG_MATCH_CONFIDENCE_DELTA
} = {}) {
    const bestCatalog = catalogScores[0] || null;
    const bestGrid = gridScores[0] || null;
    if (!bestGrid && !bestCatalog) {
        return {
            action: 'insufficient-data',
            reason: 'no-candidates',
            catalogCandidateId: null,
            catalogMeanConfidence: 0,
            gridMeanConfidence: 0,
            suggestedCandidate: null
        };
    }

    const catalogConfidence = bestCatalog?.meanConfidence ?? 0;
    const gridConfidence = bestGrid?.meanConfidence ?? 0;
    const matchesGrid = isGeometryMatch(bestCatalog, bestGrid);
    const coversGridCore = isGridCoreCoveredByCatalog(bestCatalog, bestGrid);
    if (bestCatalog && matchesGrid && catalogConfidence >= strongConfidence) {
        return {
            action: 'catalog-ok',
            reason: 'best-catalog-matches-grid',
            catalogCandidateId: bestCatalog.candidateId,
            catalogMeanConfidence: catalogConfidence,
            gridMeanConfidence: gridConfidence,
            suggestedCandidate: null
        };
    }

    if (
        bestCatalog &&
        bestGrid &&
        coversGridCore &&
        catalogConfidence >= strongConfidence &&
        gridConfidence <= catalogConfidence + matchConfidenceDelta
    ) {
        return {
            action: 'catalog-ok',
            reason: 'best-catalog-covers-grid-core',
            catalogCandidateId: bestCatalog.candidateId,
            catalogMeanConfidence: catalogConfidence,
            gridMeanConfidence: gridConfidence,
            suggestedCandidate: null
        };
    }

    if (
        bestGrid &&
        gridConfidence >= strongConfidence &&
        (!matchesGrid || gridConfidence > catalogConfidence + matchConfidenceDelta)
    ) {
        return {
            action: 'catalog-gap',
            reason: 'grid-stronger-than-catalog',
            catalogCandidateId: bestCatalog?.candidateId ?? null,
            catalogMeanConfidence: catalogConfidence,
            gridMeanConfidence: gridConfidence,
            suggestedCandidate: {
                size: bestGrid.size,
                marginRight: bestGrid.marginRight,
                marginBottom: bestGrid.marginBottom
            }
        };
    }

    return {
        action: 'needs-review',
        reason: 'weak-or-ambiguous-evidence',
        catalogCandidateId: bestCatalog?.candidateId ?? null,
        catalogMeanConfidence: catalogConfidence,
        gridMeanConfidence: gridConfidence,
        suggestedCandidate: null
    };
}

async function extractVideoFrames({ inputPath, timestamps, frameDir }) {
    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });
    const frames = [];
    for (let index = 0; index < timestamps.length; index++) {
        const timestamp = timestamps[index];
        const framePath = path.join(frameDir, `frame-${String(index + 1).padStart(3, '0')}.png`);
        await extractFrame({ videoPath: inputPath, timestamp, outputPath: framePath });
        frames.push({
            timestamp,
            path: framePath,
            imageData: await decodeImageData(framePath)
        });
    }
    return frames;
}

function scoreCatalogCandidates(frames, candidates) {
    const perCandidateFrameScores = new Map();
    for (const candidate of candidates) {
        const alphaMap = getVideoAlphaMap(candidate.size, { candidate });
        perCandidateFrameScores.set(candidate.id, frames.map((frame) => ({
            timestamp: frame.timestamp,
            ...scoreCandidateFrame(frame.imageData, candidate, alphaMap)
        })));
    }
    return perCandidateFrameScores;
}

function scoreGridCandidates(frames, metadata, ranges) {
    const scores = [];
    for (const size of ranges.sizes) {
        const alphaMap = getVideoAlphaMap(size);
        for (const marginRight of ranges.marginRights) {
            for (const marginBottom of ranges.marginBottoms) {
                const candidate = createGridCandidate({
                    width: metadata.width,
                    height: metadata.height,
                    size,
                    marginRight,
                    marginBottom
                });
                if (!candidate) continue;
                const frameScores = frames.map((frame) => ({
                    timestamp: frame.timestamp,
                    ...scoreCandidateFrame(frame.imageData, candidate, alphaMap)
                }));
                const summary = summarizeFrameScoreValues(frameScores);
                scores.push({
                    x: candidate.x,
                    y: candidate.y,
                    size,
                    marginRight,
                    marginBottom,
                    sourceFamily: candidate.sourceFamily,
                    evidenceGate: candidate.evidenceGate,
                    meanSpatial: summary.meanSpatial,
                    meanGradient: summary.meanGradient,
                    meanConfidence: summary.meanConfidence,
                    maxConfidence: summary.maxConfidence,
                    minConfidence: summary.minConfidence,
                    frameScores
                });
            }
        }
    }
    return scores;
}

function resolveCandidateCropBox(candidate, metadata, padding = 64) {
    if (!candidate) return null;
    const width = candidate.width ?? candidate.size;
    const height = candidate.height ?? candidate.size;
    return normalizeCropBox({
        left: candidate.x - padding,
        top: candidate.y - padding,
        width: width + padding * 2,
        height: height + padding * 2
    }, metadata);
}

function summarizeSelectedDetection(detection) {
    if (!detection) return null;
    if (detection.watermarkKind === 'veo-text') {
        return {
            watermarkKind: 'veo-text',
            isConfident: detection.isConfident,
            position: detection.position,
            templateId: detection.template?.id ?? null,
            alphaSeed: detection.alphaSeed ?? null,
            best: detection.summary?.best ?? null,
            alternatives: detection.summary?.alternatives ?? null
        };
    }
    return {
        watermarkKind: detection.watermarkKind ?? 'diamond',
        isConfident: detection.isConfident,
        position: detection.position,
        candidateId: detection.candidate?.id ?? detection.summary?.best?.candidateId ?? null,
        alphaSeed: detection.alphaSeed ?? null,
        best: detection.summary?.best ?? null,
        alternatives: detection.summary?.alternatives ?? null
    };
}

export async function createVideoWatermarkCandidateScoreReport({
    inputPath,
    outputPath = DEFAULT_OUTPUT_PATH,
    cropSheetPath = DEFAULT_CROP_SHEET_PATH,
    timestamps = DEFAULT_TIMESTAMPS,
    keepFrames = false,
    gridLimit = DEFAULT_GRID_LIMIT,
    gridStep = DEFAULT_GRID_STEP,
    gridMarginPadding = DEFAULT_MARGIN_PADDING,
    gridSizePadding = DEFAULT_SIZE_PADDING,
    gridExtraSizes = []
} = {}) {
    if (!inputPath) {
        throw new Error('缺少输入视频路径');
    }

    const resolvedInputPath = path.resolve(inputPath);
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedCropSheetPath = path.resolve(cropSheetPath);
    const frameDir = path.join(
        path.dirname(resolvedOutputPath),
        `${path.basename(resolvedOutputPath, path.extname(resolvedOutputPath))}-frames`
    );
    const metadata = await probeVideo(resolvedInputPath);
    const resolvedTimestamps = resolveVideoCropTimestamps(timestamps, metadata);
    const frames = await extractVideoFrames({
        inputPath: resolvedInputPath,
        timestamps: resolvedTimestamps,
        frameDir
    });
    const catalogCandidates = resolveVideoWatermarkCandidates(metadata.width, metadata.height);
    const catalogScores = summarizeCandidateScores(
        catalogCandidates,
        scoreCatalogCandidates(frames, catalogCandidates),
        metadata
    );
    const ranges = createGridSearchRanges({
        width: metadata.width,
        height: metadata.height,
        candidates: catalogCandidates,
        extraSizes: gridExtraSizes,
        step: gridStep,
        marginPadding: gridMarginPadding,
        sizePadding: gridSizePadding
    });
    const gridScores = summarizeGridSearch(
        scoreGridCandidates(frames, metadata, ranges),
        { limit: gridLimit }
    );
    const recommendation = classifyCatalogRecommendation({
        catalogScores,
        gridScores
    });
    const selectedDetection = detectVideoWatermarkFromFrames({
        frames,
        width: metadata.width,
        height: metadata.height,
        candidates: catalogCandidates
    });
    const selectedDetectionSummary = summarizeSelectedDetection(selectedDetection);
    const cropTarget = selectedDetection?.watermarkKind === 'veo-text'
        ? selectedDetection.position
        : recommendation.action === 'catalog-gap' && gridScores[0]
        ? gridScores[0]
        : catalogScores[0];
    const cropBox = resolveCandidateCropBox(cropTarget, metadata);
    const renderResult = await renderVideoCropSheet({
        originalPath: resolvedInputPath,
        outputPath: resolvedCropSheetPath,
        timestamps: resolvedTimestamps,
        cropBox,
        allowOriginalOnly: true,
        keepFrames: false,
        caseNote: path.basename(resolvedInputPath)
    });

    const report = {
        inputPath: resolvedInputPath,
        outputPath: resolvedOutputPath,
        cropSheetPath: resolvedCropSheetPath,
        frameDir: keepFrames ? frameDir : null,
        metadata,
        timestamps: resolvedTimestamps,
        catalogCandidates,
        catalogScores,
        gridSearch: {
            ranges,
            topCandidates: gridScores
        },
        recommendation,
        selectedWatermarkKind: selectedDetection?.watermarkKind ?? null,
        selectedDetection: selectedDetectionSummary,
        cropBox,
        render: {
            outputPath: renderResult.outputPath,
            cropBox: renderResult.cropBox,
            timestamps: renderResult.timestamps
        }
    };

    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!keepFrames) {
        await rm(frameDir, { recursive: true, force: true });
    }
    return report;
}

export function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        cropSheetPath: DEFAULT_CROP_SHEET_PATH,
        timestamps: [...DEFAULT_TIMESTAMPS],
        keepFrames: false,
        failOnCatalogGap: false,
        gridLimit: DEFAULT_GRID_LIMIT,
        gridStep: DEFAULT_GRID_STEP,
        gridMarginPadding: DEFAULT_MARGIN_PADDING,
        gridSizePadding: DEFAULT_SIZE_PADDING,
        gridExtraSizes: []
    };
    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--input' || arg === '--video' || arg === '--original') {
            parsed.inputPath = args.shift();
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift() || parsed.outputPath;
            continue;
        }
        if (arg === '--crop-sheet') {
            parsed.cropSheetPath = args.shift() || parsed.cropSheetPath;
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--keep-frames') {
            parsed.keepFrames = true;
            continue;
        }
        if (arg === '--fail-on-catalog-gap') {
            parsed.failOnCatalogGap = true;
            continue;
        }
        if (arg === '--grid-limit') {
            parsed.gridLimit = toFiniteNumber(args.shift()) ?? parsed.gridLimit;
            continue;
        }
        if (arg === '--grid-step') {
            parsed.gridStep = toFiniteNumber(args.shift()) ?? parsed.gridStep;
            continue;
        }
        if (arg === '--grid-margin-padding') {
            parsed.gridMarginPadding = toFiniteNumber(args.shift()) ?? parsed.gridMarginPadding;
            continue;
        }
        if (arg === '--grid-size-padding') {
            parsed.gridSizePadding = toFiniteNumber(args.shift()) ?? parsed.gridSizePadding;
            continue;
        }
        if (arg === '--grid-size') {
            const value = toFiniteNumber(args.shift());
            if (value != null) parsed.gridExtraSizes.push(value);
            continue;
        }
        if (!parsed.inputPath) {
            parsed.inputPath = arg;
        }
    }
    return parsed;
}

export function resolveVideoCandidateScoreExitCode(report, { failOnCatalogGap = false } = {}) {
    if (
        report?.selectedWatermarkKind === 'veo-text' &&
        report?.selectedDetection?.isConfident === true
    ) {
        return 0;
    }
    if (failOnCatalogGap && report?.recommendation?.action === 'catalog-gap') {
        return 1;
    }
    return 0;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await createVideoWatermarkCandidateScoreReport(options);
    console.log(`report: ${report.outputPath}`);
    console.log(`cropSheet: ${report.cropSheetPath}`);
    console.log(`bestCatalog: ${report.catalogScores[0]?.candidateId || 'none'} ${report.catalogScores[0]?.meanConfidence?.toFixed(4) || '0.0000'}`);
    console.log(`bestGrid: ${report.gridSearch.topCandidates[0]?.size || 'n/a'}px ${report.gridSearch.topCandidates[0]?.marginRight || 'n/a'}/${report.gridSearch.topCandidates[0]?.marginBottom || 'n/a'} ${report.gridSearch.topCandidates[0]?.meanConfidence?.toFixed(4) || '0.0000'}`);
    console.log(`selected: ${report.selectedWatermarkKind || 'none'} ${report.selectedDetection?.templateId || report.selectedDetection?.candidateId || ''}`);
    console.log(`recommendation: ${report.recommendation.action} (${report.recommendation.reason})`);
    process.exitCode = resolveVideoCandidateScoreExitCode(report, {
        failOnCatalogGap: options.failOnCatalogGap
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
