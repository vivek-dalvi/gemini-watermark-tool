import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-alpha-profile.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const REFERENCE_CANDIDATE = Object.freeze({
    profileName: 'power-0.88',
    alphaGain: 0.55
});
const PROFILE_VARIANTS = Object.freeze([
    { name: 'base', type: 'identity' },
    { name: 'edge-dampen-0.82', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.82 },
    { name: 'edge-dampen-0.88', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.88 },
    { name: 'edge-boost-1.12', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.12 },
    { name: 'edge-boost-1.24', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.24 },
    { name: 'mid-dampen-0.88', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 0.88 },
    { name: 'mid-boost-1.08', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.08 },
    { name: 'mid-boost-1.16', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.16 },
    { name: 'mid-boost-1.24', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.24 },
    { name: 'core-dampen-0.9', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 0.9 },
    { name: 'core-boost-1.1', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 1.1 },
    { name: 'power-0.88', type: 'power', exponent: 0.88 },
    { name: 'power-0.94', type: 'power', exponent: 0.94 },
    { name: 'power-1.08', type: 'power', exponent: 1.08 },
    { name: 'blur-mix-0.2', type: 'blur-mix', mix: 0.2 },
    { name: 'blur-mix-0.35', type: 'blur-mix', mix: 0.35 },
    { name: 'sharpen-0.25', type: 'sharpen', amount: 0.25 }
]);
const PANEL_SIZE = 172;
const LABEL_HEIGHT = 50;
const HEADER_HEIGHT = 74;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#161616';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        includeAll: false
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--all') {
            parsed.includeAll = true;
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
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
                const sourceY = y + dy;
                if (sourceY < 0 || sourceY >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    if (sourceX < 0 || sourceX >= width) continue;
                    sum += alphaMap[sourceY * width + sourceX];
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

function calculateCropBox(position, imageData) {
    const padding = Math.max(16, Math.round(position.width * 0.65));
    const left = Math.max(0, position.x - padding);
    const top = Math.max(0, position.y - padding);
    const right = Math.min(imageData.width, position.x + position.width + padding);
    const bottom = Math.min(imageData.height, position.y + position.height + padding);
    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    };
}

async function cropPanel(imageData, cropBox) {
    return sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .extract(cropBox)
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'contain', background: BACKGROUND })
        .png()
        .toBuffer();
}

function labelSvg(lines, width = PANEL_SIZE, height = LABEL_HEIGHT) {
    const text = lines.slice(0, 3).map((line, index) => (
        `<text x="6" y="${16 + index * 14}" fill="${index === 0 ? '#f5f5f5' : '#c7c7c7'}" font-size="${index === 0 ? 12 : 10}" font-family="Arial, sans-serif">${escapeSvgText(line)}</text>`
    )).join('');
    return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#101010"/>${text}</svg>`);
}

function headerSvg(report, width) {
    const summary = report.summary ?? {};
    const reference = summary.reference?.familyApplicable ?? {};
    const lines = [
        `48/96/96 geometry-family alpha/profile sweep`,
        `records=${summary.total} applicable=${summary.geometryFamilyApplicable} reference clear=${reference.clearedVisible}/${reference.total} unsafe=${reference.unsafe} bestHumanReviewOnly=${summary.bestHumanReviewOnly ? 'yes' : 'none'}`,
        `policy: diagnostic-only, no gold manifest, no production alpha/profile`
    ];
    const text = lines.map((line, index) => (
        `<text x="10" y="${20 + index * 18}" fill="${index === 0 ? '#f5f5f5' : '#c7c7c7'}" font-size="${index === 0 ? 14 : 11}" font-family="Arial, sans-serif">${escapeSvgText(line)}</text>`
    )).join('');
    return Buffer.from(`<svg width="${width}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0b0b0b"/>${text}</svg>`);
}

function chooseBestSafeTrial(record) {
    return [...(record.trials ?? [])]
        .filter((trial) => trial.texture?.safe === true)
        .sort((left, right) => (
            Number(left.visibility?.severity ?? Number.POSITIVE_INFINITY) -
            Number(right.visibility?.severity ?? Number.POSITIVE_INFINITY)
        ))[0] ?? null;
}

function chooseBestTrial(record) {
    return [...(record.trials ?? [])]
        .sort((left, right) => (
            Number(left.visibility?.severity ?? Number.POSITIVE_INFINITY) -
            Number(right.visibility?.severity ?? Number.POSITIVE_INFINITY)
        ))[0] ?? null;
}

function findTrial(record, profileName, alphaGain) {
    return (record.trials ?? []).find((trial) => trial.profileName === profileName && trial.alphaGain === alphaGain) ?? null;
}

function recordRank(record) {
    const reference = findTrial(record, REFERENCE_CANDIDATE.profileName, REFERENCE_CANDIDATE.alphaGain);
    if (reference?.clearedVisible) return 0;
    if (reference?.texture?.safe === false) return 1;
    if (record.targetProfileLine) return 2;
    return 3;
}

function selectRows(report, includeAll) {
    const applicable = (report.records ?? [])
        .filter((record) => record.geometryFamilyApplicable)
        .sort((left, right) => (
            recordRank(left) - recordRank(right) ||
            Number(right.forcedGeometry?.originalEvidence?.spatial ?? 0) -
                Number(left.forcedGeometry?.originalEvidence?.spatial ?? 0) ||
            left.file.localeCompare(right.file)
        ));
    return includeAll ? applicable : applicable.slice(0, 18);
}

async function renderRow({ report, record, transformedAlphaMaps, sampleRoot }) {
    const original = await decodeImageDataInNode(path.resolve(sampleRoot, record.file));
    const cropBox = calculateCropBox(record.forcedGeometry.position, original);
    const referenceTrial = findTrial(record, REFERENCE_CANDIDATE.profileName, REFERENCE_CANDIDATE.alphaGain);
    const bestSafeTrial = chooseBestSafeTrial(record) ?? chooseBestTrial(record);
    const referenceImage = cloneImageData(original);
    const bestSafeImage = cloneImageData(original);
    removeWatermark(
        referenceImage,
        transformedAlphaMaps.get(REFERENCE_CANDIDATE.profileName),
        record.forcedGeometry.position,
        { alphaGain: REFERENCE_CANDIDATE.alphaGain }
    );
    removeWatermark(
        bestSafeImage,
        transformedAlphaMaps.get(bestSafeTrial.profileName),
        record.forcedGeometry.position,
        { alphaGain: bestSafeTrial.alphaGain }
    );

    const sourceLabel = labelSvg([
        record.file.split(/[\\/]/).pop(),
        `${record.profileLine} evidence s=${record.forcedGeometry.originalEvidence.spatial} g=${record.forcedGeometry.originalEvidence.gradient}`,
        `baseline severity=${record.baseline.severity}`
    ]);
    const referenceLabel = labelSvg([
        `ref ${REFERENCE_CANDIDATE.profileName} gain=${REFERENCE_CANDIDATE.alphaGain}`,
        `visible=${referenceTrial.visibility.visible} safe=${referenceTrial.texture.safe}`,
        `sev=${referenceTrial.visibility.severity} delta=${referenceTrial.severityDelta}`
    ]);
    const bestLabel = labelSvg([
        `${bestSafeTrial.texture.safe ? 'best safe' : 'best unsafe'} ${bestSafeTrial.profileName} gain=${bestSafeTrial.alphaGain}`,
        `visible=${bestSafeTrial.visibility.visible} safe=${bestSafeTrial.texture.safe}`,
        `sev=${bestSafeTrial.visibility.severity} delta=${bestSafeTrial.severityDelta}`
    ]);

    return {
        record: {
            file: record.file,
            profileLine: record.profileLine,
            targetProfileLine: record.targetProfileLine,
            evidence: record.forcedGeometry.originalEvidence,
            reference: referenceTrial,
            bestSafe: bestSafeTrial
        },
        panels: [
            { input: await cropPanel(original, cropBox), label: sourceLabel },
            { input: await cropPanel(referenceImage, cropBox), label: referenceLabel },
            { input: await cropPanel(bestSafeImage, cropBox), label: bestLabel }
        ]
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const sampleRoot = report.sampleRoot;
    if (!sampleRoot) {
        throw new Error('report.sampleRoot is required');
    }

    const alpha48 = getEmbeddedAlphaMap(48);
    const transformedAlphaMaps = new Map(PROFILE_VARIANTS.map((variant) => [
        variant.name,
        transformAlphaMap(alpha48, 48, 48, variant)
    ]));
    const rows = [];
    for (const record of selectRows(report, args.includeAll)) {
        rows.push(await renderRow({ report, record, transformedAlphaMaps, sampleRoot }));
    }

    const columnCount = 3;
    const rowWidth = columnCount * PANEL_SIZE + (columnCount - 1) * PANEL_GAP;
    const rowHeight = PANEL_SIZE + LABEL_HEIGHT;
    const height = HEADER_HEIGHT + rows.length * rowHeight + Math.max(0, rows.length - 1) * ROW_GAP;
    const composites = [{ input: headerSvg(report, rowWidth), left: 0, top: 0 }];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const rowTop = HEADER_HEIGHT + rowIndex * (rowHeight + ROW_GAP);
        for (let panelIndex = 0; panelIndex < rows[rowIndex].panels.length; panelIndex++) {
            const left = panelIndex * (PANEL_SIZE + PANEL_GAP);
            const panel = rows[rowIndex].panels[panelIndex];
            composites.push({ input: panel.input, left, top: rowTop });
            composites.push({ input: panel.label, left, top: rowTop + PANEL_SIZE });
        }
    }

    await mkdir(args.outputDir, { recursive: true });
    const imagePath = path.join(args.outputDir, 'geometry-family-48-96-96-alpha-profile.png');
    const sheetJsonPath = path.join(args.outputDir, 'geometry-family-48-96-96-alpha-profile-sheet.json');
    await sharp({
        create: {
            width: rowWidth,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(imagePath);

    const sheetSummary = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        imagePath,
        includeAll: args.includeAll,
        rowCount: rows.length,
        rows: rows.map((row) => row.record),
        policy: report.policy
    };
    await writeFile(sheetJsonPath, `${JSON.stringify(sheetSummary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        imagePath,
        sheetJsonPath,
        rowCount: rows.length
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
