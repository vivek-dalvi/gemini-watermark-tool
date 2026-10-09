import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { calculateAlphaMap } from '../src/core/alphaMap.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import {
    computeRegionGradientCorrelation,
    computeRegionSpatialCorrelation,
    interpolateAlphaMap
} from '../src/core/adaptiveDetector.js';
import {
    calculateNearBlackRatio,
    evaluateRestorationCandidate
} from '../src/core/candidateSelector.js';
import {
    buildCandidateRankingReport,
    decodeImageDataInNode
} from './sample-benchmark.js';
import {
    calculateWatermarkPosition,
    detectWatermarkConfig,
    resolveInitialStandardConfig
} from '../src/core/watermarkConfig.js';

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/download-samples-report-after-fix.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/download-samples-geometry-scan');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const COARSE_SIZE_RANGE = Object.freeze({ min: 32, max: 72, step: 2 });
const COARSE_MARGIN_RANGE = Object.freeze({ min: 8, max: 140, step: 4 });
const FINE_SIZE_DELTAS = Object.freeze([-2, -1, 0, 1, 2]);
const FINE_MARGIN_DELTAS = Object.freeze([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
const ALPHA_GAINS = Object.freeze([0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.85, 1, 1.15, 1.3]);
const COARSE_TOP_K = 24;
const EVALUATED_TOP_K = 12;
const OVERLAY_CROP_SIZE = 256;
const SHEET_TILE_SIZE = 220;
const SHEET_LABEL_HEIGHT = 46;
const SHEET_COLUMNS = 4;

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function toFixedNumber(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        all: false,
        limit: Infinity
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--all') {
            parsed.all = true;
        } else if (arg === '--limit') {
            const limit = Number(args.shift());
            parsed.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : parsed.limit;
        }
    }

    return parsed;
}

async function readJsonWithBom(filePath) {
    return JSON.parse(stripBom(await readFile(filePath, 'utf8')));
}

function pushTopCandidate(top, candidate, limit = COARSE_TOP_K) {
    top.push(candidate);
    top.sort((left, right) => right.evidenceScore - left.evidenceScore);
    if (top.length > limit) top.length = limit;
}

function sameGeometry(left, right) {
    return left?.size === right?.size &&
        left?.marginRight === right?.marginRight &&
        left?.marginBottom === right?.marginBottom;
}

function dedupeGeometry(candidates) {
    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const key = `${candidate.size}:${candidate.marginRight}:${candidate.marginBottom}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}

function createAlphaResolver({ alpha48, alpha96 }) {
    const cache = new Map();
    return (size) => {
        if (cache.has(size)) return cache.get(size);
        let alphaMap = null;
        if (size === '36-v2') {
            alphaMap = getEmbeddedAlphaMap('36-v2');
        } else if (size === 48) {
            alphaMap = alpha48;
        } else if (size === 96) {
            alphaMap = alpha96;
        } else {
            alphaMap = interpolateAlphaMap(alpha96, 96, size);
        }
        cache.set(size, alphaMap);
        return alphaMap;
    };
}

function scoreGeometry({ imageData, alphaMap, x, y, size }) {
    const spatial = computeRegionSpatialCorrelation({
        imageData,
        alphaMap,
        region: { x, y, size }
    });
    const gradient = computeRegionGradientCorrelation({
        imageData,
        alphaMap,
        region: { x, y, size }
    });
    return {
        spatial,
        gradient,
        evidenceScore: Math.max(0, spatial) * 0.45 + Math.max(0, gradient) * 0.55
    };
}

function createGeometryCandidate({ imageData, resolveAlphaMap, size, marginRight, marginBottom }) {
    const x = imageData.width - marginRight - size;
    const y = imageData.height - marginBottom - size;
    if (x < 0 || y < 0 || x + size > imageData.width || y + size > imageData.height) {
        return null;
    }
    const alphaMap = resolveAlphaMap(size);
    if (!alphaMap) return null;
    return {
        size,
        marginRight,
        marginBottom,
        x,
        y,
        alphaMap,
        ...scoreGeometry({ imageData, alphaMap, x, y, size })
    };
}

function scanCoarseGeometry({ imageData, resolveAlphaMap }) {
    const top = [];
    for (let size = COARSE_SIZE_RANGE.min; size <= COARSE_SIZE_RANGE.max; size += COARSE_SIZE_RANGE.step) {
        for (
            let marginRight = COARSE_MARGIN_RANGE.min;
            marginRight <= COARSE_MARGIN_RANGE.max;
            marginRight += COARSE_MARGIN_RANGE.step
        ) {
            for (
                let marginBottom = COARSE_MARGIN_RANGE.min;
                marginBottom <= COARSE_MARGIN_RANGE.max;
                marginBottom += COARSE_MARGIN_RANGE.step
            ) {
                const candidate = createGeometryCandidate({
                    imageData,
                    resolveAlphaMap,
                    size,
                    marginRight,
                    marginBottom
                });
                if (!candidate) continue;
                pushTopCandidate(top, candidate);
            }
        }
    }
    return top;
}

function expandFineGeometry({ imageData, resolveAlphaMap, coarseCandidates, fixedCandidates }) {
    const fine = [];
    for (const coarse of coarseCandidates) {
        for (const sizeDelta of FINE_SIZE_DELTAS) {
            const size = coarse.size + sizeDelta;
            if (size < 24 || size > 112) continue;
            for (const rightDelta of FINE_MARGIN_DELTAS) {
                const marginRight = coarse.marginRight + rightDelta;
                if (marginRight < 0) continue;
                for (const bottomDelta of FINE_MARGIN_DELTAS) {
                    const marginBottom = coarse.marginBottom + bottomDelta;
                    if (marginBottom < 0) continue;
                    const candidate = createGeometryCandidate({
                        imageData,
                        resolveAlphaMap,
                        size,
                        marginRight,
                        marginBottom
                    });
                    if (candidate) fine.push(candidate);
                }
            }
        }
    }

    for (const fixed of fixedCandidates) {
        const candidate = createGeometryCandidate({
            imageData,
            resolveAlphaMap,
            size: fixed.logoSize,
            marginRight: fixed.marginRight,
            marginBottom: fixed.marginBottom
        });
        if (candidate) fine.push(candidate);
    }

    return dedupeGeometry(fine)
        .sort((left, right) => right.evidenceScore - left.evidenceScore)
        .slice(0, 80);
}

function serializeCandidate(candidate) {
    if (!candidate) return null;
    return {
        size: candidate.size ?? candidate.config?.logoSize ?? candidate.position?.width ?? null,
        marginRight: candidate.marginRight ?? candidate.config?.marginRight ?? null,
        marginBottom: candidate.marginBottom ?? candidate.config?.marginBottom ?? null,
        x: candidate.x ?? candidate.position?.x ?? null,
        y: candidate.y ?? candidate.position?.y ?? null,
        spatial: toFixedNumber(candidate.spatial ?? candidate.originalSpatialScore),
        gradient: toFixedNumber(candidate.gradient ?? candidate.originalGradientScore),
        evidenceScore: toFixedNumber(candidate.evidenceScore),
        alphaGain: toFixedNumber(candidate.alphaGain, 3),
        accepted: candidate.accepted ?? null,
        processedSpatial: toFixedNumber(candidate.processedSpatialScore),
        processedGradient: toFixedNumber(candidate.processedGradientScore),
        improvement: toFixedNumber(candidate.improvement),
        nearBlackIncrease: toFixedNumber(candidate.nearBlackIncrease),
        texturePenalty: toFixedNumber(candidate.texturePenalty),
        hardReject: candidate.hardReject ?? null,
        validationCost: toFixedNumber(candidate.validationCost)
    };
}

function evaluateFineCandidates({ imageData, fineCandidates }) {
    const evaluated = [];
    for (const geometry of fineCandidates) {
        const position = {
            x: geometry.x,
            y: geometry.y,
            width: geometry.size,
            height: geometry.size
        };
        const baselineNearBlackRatio = calculateNearBlackRatio(imageData, position);
        for (const alphaGain of ALPHA_GAINS) {
            const candidate = evaluateRestorationCandidate({
                originalImageData: imageData,
                alphaMap: geometry.alphaMap,
                position,
                source: 'standard+sample-scan',
                config: {
                    logoSize: geometry.size,
                    marginRight: geometry.marginRight,
                    marginBottom: geometry.marginBottom
                },
                baselineNearBlackRatio,
                alphaGain,
                provenance: { sampleScan: true },
                includeImageData: false
            });
            if (!candidate) continue;
            evaluated.push({
                ...candidate,
                size: geometry.size,
                marginRight: geometry.marginRight,
                marginBottom: geometry.marginBottom,
                x: geometry.x,
                y: geometry.y,
                evidenceScore: geometry.evidenceScore,
                spatial: geometry.spatial,
                gradient: geometry.gradient
            });
        }
    }

    const byValidation = [...evaluated].sort((left, right) => {
        if (left.accepted !== right.accepted) return left.accepted ? -1 : 1;
        if (left.validationCost !== right.validationCost) return left.validationCost - right.validationCost;
        return right.improvement - left.improvement;
    });
    const byEvidence = [...evaluated].sort((left, right) => right.evidenceScore - left.evidenceScore);

    return {
        bestAccepted: byValidation.find((candidate) => candidate.accepted) ?? null,
        bestValidation: byValidation[0] ?? null,
        bestEvidence: byEvidence[0] ?? null,
        topValidation: byValidation.slice(0, EVALUATED_TOP_K),
        topEvidence: byEvidence.slice(0, EVALUATED_TOP_K)
    };
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function rectSvg({ x, y, width, height, color, label }) {
    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" ` +
        `stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"/>` +
        `<text x="${x + 4}" y="${Math.max(14, y - 6)}" fill="${color}" ` +
        `font-family="Arial, sans-serif" font-size="14" font-weight="700">${escapeSvgText(label)}</text>`;
}

async function writeOverlay({ filePath, outputPath, imageData, initialConfig, selectedCandidate, bestCandidate }) {
    const cropWidth = Math.min(OVERLAY_CROP_SIZE, imageData.width);
    const cropHeight = Math.min(OVERLAY_CROP_SIZE, imageData.height);
    const cropLeft = imageData.width - cropWidth;
    const cropTop = imageData.height - cropHeight;
    const rects = [];

    const initialPosition = calculateWatermarkPosition(imageData.width, imageData.height, initialConfig);
    rects.push(rectSvg({
        x: initialPosition.x - cropLeft,
        y: initialPosition.y - cropTop,
        width: initialPosition.width,
        height: initialPosition.height,
        color: '#2f80ed',
        label: 'initial'
    }));

    const largeMarginPosition = {
        x: imageData.width - 96 - 48,
        y: imageData.height - 96 - 48,
        width: 48,
        height: 48
    };
    rects.push(rectSvg({
        x: largeMarginPosition.x - cropLeft,
        y: largeMarginPosition.y - cropTop,
        width: largeMarginPosition.width,
        height: largeMarginPosition.height,
        color: '#f2994a',
        label: '48/96'
    }));

    if (selectedCandidate) {
        rects.push(rectSvg({
            x: selectedCandidate.x - cropLeft,
            y: selectedCandidate.y - cropTop,
            width: selectedCandidate.size,
            height: selectedCandidate.size,
            color: '#eb5757',
            label: `selected ${selectedCandidate.size}/${selectedCandidate.marginRight}/${selectedCandidate.marginBottom}`
        }));
    }

    if (bestCandidate) {
        rects.push(rectSvg({
            x: bestCandidate.x - cropLeft,
            y: bestCandidate.y - cropTop,
            width: bestCandidate.size,
            height: bestCandidate.size,
            color: '#27ae60',
            label: `best ${bestCandidate.size}/${bestCandidate.marginRight}/${bestCandidate.marginBottom}`
        }));
    }

    const svg = `<svg width="${cropWidth}" height="${cropHeight}" viewBox="0 0 ${cropWidth} ${cropHeight}" ` +
        `xmlns="http://www.w3.org/2000/svg">${rects.join('')}</svg>`;

    await sharp(filePath)
        .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
        .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
        .png()
        .toFile(outputPath);
}

async function writeContactSheet({ outputPath, overlays, records }) {
    if (overlays.length === 0) return;

    const columns = SHEET_COLUMNS;
    const rows = Math.ceil(overlays.length / columns);
    const tileWidth = SHEET_TILE_SIZE;
    const tileHeight = SHEET_TILE_SIZE + SHEET_LABEL_HEIGHT;
    const composites = [];

    for (let index = 0; index < overlays.length; index++) {
        const record = records[index];
        const left = (index % columns) * tileWidth;
        const top = Math.floor(index / columns) * tileHeight;
        const thumb = await sharp(overlays[index])
            .resize(SHEET_TILE_SIZE, SHEET_TILE_SIZE, { fit: 'cover' })
            .png()
            .toBuffer();
        const best = record.bestAccepted ?? record.bestValidation ?? record.bestEvidence;
        const label = `${record.fileName}\n${best ? `best ${best.size}/${best.marginRight}/${best.marginBottom} a=${best.alphaGain ?? 'n/a'}` : 'no candidate'}`;
        const labelSvg = `<svg width="${tileWidth}" height="${SHEET_LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
            `<rect width="100%" height="100%" fill="#111"/>` +
            `<text x="8" y="16" fill="#fff" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(label).replace('\n', '</text><text x="8" y="34" fill="#cfd8dc" font-family="Arial, sans-serif" font-size="11">')}</text>` +
            `</svg>`;

        composites.push({ input: thumb, left, top });
        composites.push({ input: Buffer.from(labelSvg), left, top: top + SHEET_TILE_SIZE });
    }

    await sharp({
        create: {
            width: columns * tileWidth,
            height: rows * tileHeight,
            channels: 4,
            background: '#181818'
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
}

function summarizeClusters(records) {
    const byGeometry = new Map();
    const byAccepted = { accepted: 0, rejected: 0 };
    for (const record of records) {
        const best = record.bestAccepted ?? record.bestValidation ?? record.bestEvidence;
        if (!best) continue;
        const key = `${best.size}/${best.marginRight}/${best.marginBottom}`;
        byGeometry.set(key, (byGeometry.get(key) ?? 0) + 1);
        if (record.bestAccepted) byAccepted.accepted++;
        else byAccepted.rejected++;
    }

    return {
        total: records.length,
        bestAcceptedCount: byAccepted.accepted,
        noAcceptedButEvidenceCount: byAccepted.rejected,
        topGeometryClusters: [...byGeometry.entries()]
            .map(([geometry, count]) => ({ geometry, count }))
            .sort((left, right) => right.count - left.count)
    };
}

async function loadAlphaMaps() {
    const alpha48 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_48.png')));
    const alpha96 = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96.png')));
    const alpha96NewMargin = calculateAlphaMap(await decodeImageDataInNode(path.resolve('src/assets/bg_96_20260520.png')));
    return {
        alpha48,
        alpha96,
        alpha96Variants: { '20260520': alpha96NewMargin }
    };
}

async function analyzeRecord({ record, outputDir, alpha48, alpha96, alpha96Variants }) {
    const filePath = record.input;
    const fileName = path.basename(filePath);
    const imageData = await decodeImageDataInNode(filePath);
    const resolveAlphaMap = createAlphaResolver({ alpha48, alpha96 });
    const defaultConfig = detectWatermarkConfig(imageData.width, imageData.height);
    const initialConfig = resolveInitialStandardConfig({
        imageData,
        defaultConfig,
        alpha48,
        alpha96
    });
    const fixedCandidates = [
        initialConfig,
        { logoSize: 48, marginRight: 32, marginBottom: 32 },
        { logoSize: 48, marginRight: 96, marginBottom: 96 },
        { logoSize: 96, marginRight: 64, marginBottom: 64 },
        { logoSize: 96, marginRight: 192, marginBottom: 192 }
    ];
    const selectedConfig = record.meta?.config ?? null;
    const selectedGeometry = selectedConfig
        ? createGeometryCandidate({
            imageData,
            resolveAlphaMap,
            size: selectedConfig.logoSize,
            marginRight: selectedConfig.marginRight,
            marginBottom: selectedConfig.marginBottom
        })
        : null;
    const selectedEvaluation = selectedGeometry
        ? evaluateFineCandidates({ imageData, fineCandidates: [selectedGeometry] })
        : null;
    const coarseTop = scanCoarseGeometry({ imageData, resolveAlphaMap });
    const fineCandidates = expandFineGeometry({
        imageData,
        resolveAlphaMap,
        coarseCandidates: coarseTop,
        fixedCandidates
    });
    const evaluated = evaluateFineCandidates({ imageData, fineCandidates });
    const candidateRankings = buildCandidateRankingReport({
        imageData,
        initialConfig,
        alpha48,
        alpha96,
        alpha96Variants,
        getAlphaMap: resolveAlphaMap,
        limit: 10
    });
    const bestForOverlay = evaluated.bestAccepted ?? evaluated.bestValidation ?? evaluated.bestEvidence;
    const overlayPath = path.join(outputDir, 'overlays', `${path.parse(fileName).name}.png`);

    await writeOverlay({
        filePath,
        outputPath: overlayPath,
        imageData,
        initialConfig,
        selectedCandidate: selectedGeometry,
        bestCandidate: bestForOverlay
    });

    return {
        fileName,
        input: filePath,
        overlayPath,
        width: imageData.width,
        height: imageData.height,
        previousMeta: {
            applied: record.meta?.applied ?? null,
            skipReason: record.meta?.skipReason ?? null,
            originalSpatial: toFixedNumber(record.meta?.detection?.originalSpatialScore),
            originalGradient: toFixedNumber(record.meta?.detection?.originalGradientScore)
        },
        initialConfig,
        selectedGeometry: serializeCandidate(selectedGeometry),
        selectedBestAccepted: serializeCandidate(selectedEvaluation?.bestAccepted),
        selectedBestValidation: serializeCandidate(selectedEvaluation?.bestValidation),
        coarseTop: coarseTop.slice(0, 8).map(serializeCandidate),
        bestEvidence: serializeCandidate(evaluated.bestEvidence),
        bestValidation: serializeCandidate(evaluated.bestValidation),
        bestAccepted: serializeCandidate(evaluated.bestAccepted),
        topValidation: evaluated.topValidation.map(serializeCandidate),
        topEvidence: evaluated.topEvidence.map(serializeCandidate),
        currentCatalogTop: candidateRankings
    };
}

export async function runSampleWatermarkScan(options = {}) {
    const {
        reportPath = DEFAULT_REPORT_PATH,
        outputDir = DEFAULT_OUTPUT_DIR,
        all = false,
        limit = Infinity
    } = options;

    await mkdir(path.join(outputDir, 'overlays'), { recursive: true });
    const report = await readJsonWithBom(reportPath);
    const targets = report
        .filter((record) => all || record.meta?.applied !== true)
        .filter((record) => IMAGE_EXTENSIONS.has(path.extname(record.input).toLowerCase()))
        .slice(0, limit);
    const { alpha48, alpha96, alpha96Variants } = await loadAlphaMaps();
    const records = [];
    const overlayPaths = [];

    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        console.log(`[scan] ${index + 1}/${targets.length} ${path.basename(target.input)}`);
        const analyzed = await analyzeRecord({
            record: target,
            outputDir,
            alpha48,
            alpha96,
            alpha96Variants
        });
        records.push(analyzed);
        overlayPaths.push(analyzed.overlayPath);
    }

    const summary = summarizeClusters(records);
    const output = {
        generatedAt: new Date().toISOString(),
        reportPath,
        outputDir,
        targetCount: targets.length,
        summary,
        records
    };
    const jsonPath = path.join(outputDir, 'geometry-scan.json');
    const sheetPath = path.join(outputDir, 'geometry-overlays.png');
    await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeContactSheet({ outputPath: sheetPath, overlays: overlayPaths, records });
    await writeFile(
        path.join(outputDir, 'summary.txt'),
        [
            `targetCount=${targets.length}`,
            `bestAcceptedCount=${summary.bestAcceptedCount}`,
            `noAcceptedButEvidenceCount=${summary.noAcceptedButEvidenceCount}`,
            ...summary.topGeometryClusters.map((cluster) => `${cluster.geometry} ${cluster.count}`)
        ].join('\n') + '\n',
        'utf8'
    );
    return { ...output, jsonPath, sheetPath };
}

async function runCli() {
    const options = parseArgs(process.argv.slice(2));
    const report = await runSampleWatermarkScan(options);
    console.log(`summary: ${JSON.stringify(report.summary)}`);
    console.log(`report: ${report.jsonPath}`);
    console.log(`overlays: ${report.sheetPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
