import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { removeWatermark } from '../src/core/blendModes.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/issue-103/vector-repair-fixture-pack');
const WIDTH = 320;
const HEIGHT = 320;
const HEADER_HEIGHT = 28;
const ROW_LABEL_HEIGHT = 24;
const POSITION = Object.freeze({ x: 160, y: 160, width: 96, height: 96 });
const ALPHA_KEY = '96-20260520';
const COLUMNS = Object.freeze(['truth', 'watermarked', 'inverse', 'palette-snap-repair', 'gated-palette-repair']);
const SAFE_COMPONENT_COLORS = Object.freeze([
    [34, 197, 94],
    [16, 185, 129],
    [132, 204, 22],
    [20, 184, 166]
]);
const REJECTED_COMPONENT_COLORS = Object.freeze([
    [239, 68, 68],
    [249, 115, 22],
    [234, 179, 8],
    [236, 72, 153],
    [168, 85, 247],
    [59, 130, 246],
    [14, 165, 233],
    [100, 116, 139]
]);
const PALETTE = Object.freeze([
    [0, 0, 0],
    [248, 0, 40],
    [32, 228, 4],
    [176, 240, 4],
    [8, 252, 248],
    [224, 120, 248],
    [255, 255, 255]
]);

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function pixelIndex(imageData, x, y) {
    return (y * imageData.width + x) * 4;
}

function writePixel(imageData, x, y, color) {
    const index = pixelIndex(imageData, x, y);
    imageData.data[index] = color[0];
    imageData.data[index + 1] = color[1];
    imageData.data[index + 2] = color[2];
    imageData.data[index + 3] = 255;
}

function readPixel(imageData, x, y) {
    const index = pixelIndex(imageData, x, y);
    return [
        imageData.data[index],
        imageData.data[index + 1],
        imageData.data[index + 2]
    ];
}

function colorDistanceSquared(left, right) {
    let sum = 0;
    for (let index = 0; index < 3; index++) {
        const delta = left[index] - right[index];
        sum += delta * delta;
    }
    return sum;
}

function forwardBlend(color, alpha) {
    return color.map((value) => value * (1 - alpha) + 255 * alpha);
}

function createBlankImageData() {
    return {
        width: WIDTH,
        height: HEIGHT,
        data: new Uint8ClampedArray(WIDTH * HEIGHT * 4)
    };
}

function paintCase(pattern) {
    const imageData = createBlankImageData();

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            let color = PALETTE[0];

            if (pattern === 'large-blocks') {
                color = x < 205
                    ? (y < 218 ? PALETTE[1] : PALETTE[2])
                    : (y < 218 ? PALETTE[3] : PALETTE[0]);
            } else if (pattern === 'nested-shapes') {
                color = PALETTE[0];
                if (x > 88 && x < 270 && y > 74 && y < 278) color = PALETTE[2];
                if ((x - 214) ** 2 + (y - 206) ** 2 < 54 ** 2) color = PALETTE[1];
                if (x > 164 && x < 244 && y > 166 && y < 188) color = PALETTE[5];
                if (x > 186 && x < 202 && y > 130 && y < 252) color = PALETTE[6];
            } else if (pattern === 'mixed-safe-component') {
                color = PALETTE[0];
                if (x < 205) color = PALETTE[1];
                if (x >= 258 && x < 268 && y >= 190 && y < 212) color = PALETTE[4];
                if ((x - 236) ** 2 + (y - 206) ** 2 < 16 ** 2) color = PALETTE[4];
            } else if (pattern === 'thin-stripes') {
                color = PALETTE[Math.floor((x + y * 2) / 7) % 5];
            } else if (pattern === 'diagonal-edge') {
                color = x + y < 390 ? PALETTE[1] : PALETTE[4];
                if (Math.abs(x - y) < 3) color = PALETTE[0];
            }

            writePixel(imageData, x, y, color);
        }
    }

    return imageData;
}

function applyWatermark(imageData, alphaMap, trueGain) {
    const watermarked = cloneImageData(imageData);

    for (let row = 0; row < POSITION.height; row++) {
        for (let col = 0; col < POSITION.width; col++) {
            const localIndex = row * POSITION.width + col;
            const alpha = Math.min(0.99, Math.max(0, alphaMap[localIndex] * trueGain));
            if (alpha <= 0.002) continue;

            const index = pixelIndex(watermarked, POSITION.x + col, POSITION.y + row);
            for (let channel = 0; channel < 3; channel++) {
                const value = watermarked.data[index + channel];
                watermarked.data[index + channel] = Math.round(value * (1 - alpha) + 255 * alpha);
            }
        }
    }

    return watermarked;
}

function extractOutsidePalette(imageData, position = POSITION) {
    const counts = new Map();
    const margin = 8;

    for (let y = position.y - margin; y < position.y + position.height + margin; y++) {
        for (let x = position.x - margin; x < position.x + position.width + margin; x++) {
            if (x < 0 || y < 0 || x >= imageData.width || y >= imageData.height) continue;
            const inside = x >= position.x &&
                x < position.x + position.width &&
                y >= position.y &&
                y < position.y + position.height;
            if (inside) continue;

            const key = readPixel(imageData, x, y)
                .map((value) => Math.max(0, Math.min(255, Math.round(value / 4) * 4)))
                .join(',');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 24)
        .map(([key, count]) => ({
            color: key.split(',').map(Number),
            count
        }));
}

function applyPaletteSnapRepair(watermarked, alphaMap, alphaGain, position = POSITION) {
    const repaired = cloneImageData(watermarked);
    const palette = extractOutsidePalette(watermarked, position).map((item) => item.color);
    let changed = 0;

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.min(0.99, Math.max(0, alphaMap[localIndex] * alphaGain));
            if (alpha <= 0.025) continue;

            const target = readPixel(watermarked, position.x + col, position.y + row);
            let bestColor = null;
            let bestCost = Infinity;
            for (const color of palette) {
                const cost = colorDistanceSquared(forwardBlend(color, alpha), target);
                if (cost < bestCost) {
                    bestCost = cost;
                    bestColor = color;
                }
            }
            if (!bestColor) continue;

            writePixel(repaired, position.x + col, position.y + row, bestColor);
            changed++;
        }
    }

    return { imageData: repaired, changed, palette };
}

function createSceneLabelMap(watermarked, alphaMap, alphaGain, palette, position = POSITION) {
    const labels = new Int16Array(position.width * position.height);

    for (let row = 0; row < position.height; row++) {
        for (let col = 0; col < position.width; col++) {
            const localIndex = row * position.width + col;
            const alpha = Math.min(0.99, Math.max(0, alphaMap[localIndex] * alphaGain));
            const target = readPixel(watermarked, position.x + col, position.y + row);
            let bestIndex = -1;
            let bestCost = Infinity;

            for (let paletteIndex = 0; paletteIndex < palette.length; paletteIndex++) {
                const color = palette[paletteIndex];
                const projected = alpha > 0.002 ? forwardBlend(color, alpha) : color;
                const cost = colorDistanceSquared(projected, target);
                if (cost < bestCost) {
                    bestCost = cost;
                    bestIndex = paletteIndex;
                }
            }

            labels[localIndex] = bestIndex;
        }
    }

    return labels;
}

function analyzeVectorSceneSafety(labelMap, width = POSITION.width, height = POSITION.height, options = {}) {
    const visited = new Uint8Array(labelMap.length);
    const components = [];
    const queue = [];
    const offsets = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
    ];

    for (let startY = 0; startY < height; startY++) {
        for (let startX = 0; startX < width; startX++) {
            const startIndex = startY * width + startX;
            if (visited[startIndex]) continue;

            visited[startIndex] = 1;
            const label = labelMap[startIndex];
            let area = 0;
            let minX = startX;
            let maxX = startX;
            let minY = startY;
            let maxY = startY;
            let touchesBoundary = false;
            const pixels = options.includePixels ? [] : null;
            queue.length = 0;
            queue.push(startIndex);

            for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
                const index = queue[queueIndex];
                const x = index % width;
                const y = Math.floor(index / width);
                area++;
                if (pixels) pixels.push(index);
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                touchesBoundary = touchesBoundary || x === 0 || y === 0 || x === width - 1 || y === height - 1;

                for (const [dx, dy] of offsets) {
                    const nextX = x + dx;
                    const nextY = y + dy;
                    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
                    const nextIndex = nextY * width + nextX;
                    if (visited[nextIndex] || labelMap[nextIndex] !== label) continue;
                    visited[nextIndex] = 1;
                    queue.push(nextIndex);
                }
            }

            const boxArea = (maxX - minX + 1) * (maxY - minY + 1);
            components.push({
                label,
                area,
                bbox: { minX, minY, maxX, maxY },
                fillRatio: Number((area / Math.max(1, boxArea)).toFixed(4)),
                touchesBoundary,
                ...(pixels ? { pixels } : {})
            });
        }
    }

    const significant = components.filter((component) => component.area >= 64);
    const reasons = [];
    if (significant.length > 4) reasons.push('too-many-components');
    if (significant.some((component) => !component.touchesBoundary)) reasons.push('internal-component');
    if (significant.some((component) => component.area < 256)) reasons.push('small-component');
    if (significant.some((component) => component.fillRatio < 0.84)) reasons.push('non-rectangular-component');

    return {
        safe: reasons.length === 0,
        reasons,
        componentCount: significant.length,
        components: significant
    };
}

function normalizeGateOptions(options = {}) {
    return {
        minArea: options.minArea ?? 256,
        minFillRatio: options.minFillRatio ?? 0.84,
        requireBoundary: options.requireBoundary ?? true
    };
}

function isSafeVectorRepairComponent(component, options = {}) {
    const gateOptions = normalizeGateOptions(options);
    return component.area >= gateOptions.minArea &&
        (!gateOptions.requireBoundary || component.touchesBoundary) &&
        component.fillRatio >= gateOptions.minFillRatio;
}

function stripComponentPixels(component) {
    const { pixels, ...rest } = component;
    return rest;
}

function createComponentMapImageData(components, width, height) {
    const imageData = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
    };
    imageData.data.fill(255);

    components.forEach((component, index) => {
        const colors = component.safeForRepair ? SAFE_COMPONENT_COLORS : REJECTED_COMPONENT_COLORS;
        const color = colors[index % colors.length];
        for (const localIndex of component.pixels ?? []) {
            const targetIndex = localIndex * 4;
            imageData.data[targetIndex] = color[0];
            imageData.data[targetIndex + 1] = color[1];
            imageData.data[targetIndex + 2] = color[2];
            imageData.data[targetIndex + 3] = 255;
        }
    });

    return imageData;
}

function applyGatedPaletteRepair(
    watermarked,
    inverseImageData,
    alphaMap,
    alphaGain,
    repair,
    position = POSITION,
    gateOptions = {}
) {
    const normalizedGateOptions = normalizeGateOptions(gateOptions);
    const labelMap = createSceneLabelMap(watermarked, alphaMap, alphaGain, repair.palette, position);
    const analysis = analyzeVectorSceneSafety(labelMap, position.width, position.height, { includePixels: true });
    const gated = cloneImageData(inverseImageData);
    let changed = 0;
    let adoptedComponents = 0;
    let rejectedComponents = 0;

    for (const component of analysis.components) {
        component.safeForRepair = isSafeVectorRepairComponent(component, normalizedGateOptions);
        if (!component.safeForRepair) {
            rejectedComponents++;
            continue;
        }

        let componentChanged = 0;
        for (const localIndex of component.pixels) {
            const alpha = Math.min(0.99, Math.max(0, alphaMap[localIndex] * alphaGain));
            if (alpha <= 0.025) continue;

            const col = localIndex % position.width;
            const row = Math.floor(localIndex / position.width);
            const targetIndex = pixelIndex(gated, position.x + col, position.y + row);
            const sourceIndex = pixelIndex(repair.imageData, position.x + col, position.y + row);
            for (let channel = 0; channel < 3; channel++) {
                gated.data[targetIndex + channel] = repair.imageData.data[sourceIndex + channel];
            }
            changed++;
            componentChanged++;
        }

        if (componentChanged > 0) {
            adoptedComponents++;
        } else {
            rejectedComponents++;
        }
    }

    return {
        imageData: gated,
        changed,
        adopted: changed > 0,
        componentMapImageData: createComponentMapImageData(analysis.components, position.width, position.height),
        safety: {
            ...analysis,
            gateOptions: normalizedGateOptions,
            components: analysis.components.map(stripComponentPixels),
            adoptedComponents,
            rejectedComponents
        }
    };
}

export function createComponentGatedVectorRepair({
    imageData,
    position = POSITION,
    alphaMap,
    alphaGain,
    inverseAlphaGain = alphaGain,
    gateOptions = {}
}) {
    const inverseImageData = cloneImageData(imageData);
    removeWatermark(inverseImageData, alphaMap, position, { alphaGain: inverseAlphaGain });
    const repair = applyPaletteSnapRepair(imageData, alphaMap, alphaGain, position);
    const gatedRepair = applyGatedPaletteRepair(
        imageData,
        inverseImageData,
        alphaMap,
        alphaGain,
        repair,
        position,
        gateOptions
    );

    return {
        inverseImageData,
        paletteSnapImageData: repair.imageData,
        componentGatedImageData: gatedRepair.imageData,
        componentMapImageData: gatedRepair.componentMapImageData,
        palette: repair.palette,
        paletteSnapChangedPixels: repair.changed,
        gatedDecision: {
            adopted: gatedRepair.adopted,
            changedPixels: gatedRepair.changed,
            safety: gatedRepair.safety
        }
    };
}

export function createIssue103VectorRepairFixtureCases() {
    return [
        {
            id: 'large-blocks-recoverable',
            pattern: 'large-blocks',
            expected: 'repairable',
            trueGain: 0.85,
            inverseAlphaGain: 1,
            repairAlphaGain: 0.85,
            description: 'Large connected color regions around the watermark.'
        },
        {
            id: 'nested-shapes-protected',
            pattern: 'nested-shapes',
            expected: 'protect',
            trueGain: 0.85,
            inverseAlphaGain: 1,
            repairAlphaGain: 0.85,
            description: 'Local hidden shapes inside the watermark footprint.'
        },
        {
            id: 'mixed-safe-component-protected',
            pattern: 'mixed-safe-component',
            expected: 'protect',
            trueGain: 0.85,
            inverseAlphaGain: 1,
            repairAlphaGain: 0.85,
            description: 'One safe connected block plus one internal component that must stay protected.'
        },
        {
            id: 'thin-stripes-protected',
            pattern: 'thin-stripes',
            expected: 'protect',
            trueGain: 0.85,
            inverseAlphaGain: 1,
            repairAlphaGain: 0.85,
            description: 'Thin vector stripes that should not be flattened.'
        },
        {
            id: 'diagonal-edge-protected',
            pattern: 'diagonal-edge',
            expected: 'protect',
            trueGain: 0.85,
            inverseAlphaGain: 1,
            repairAlphaGain: 0.85,
            description: 'Hard diagonal edge crossing the watermark footprint.'
        }
    ];
}

export function calculateRoiErrorMetrics(candidateImageData, truthImageData) {
    let squared = 0;
    let maxError = 0;
    let exact = 0;
    let count = 0;

    for (let row = 0; row < POSITION.height; row++) {
        for (let col = 0; col < POSITION.width; col++) {
            const candidate = readPixel(candidateImageData, POSITION.x + col, POSITION.y + row);
            const truth = readPixel(truthImageData, POSITION.x + col, POSITION.y + row);
            const error = Math.sqrt(colorDistanceSquared(candidate, truth) / 3);
            squared += error * error;
            maxError = Math.max(maxError, error);
            if (colorDistanceSquared(candidate, truth) === 0) exact++;
            count++;
        }
    }

    return {
        rmse: Number(Math.sqrt(squared / Math.max(1, count)).toFixed(4)),
        maxError: Number(maxError.toFixed(4)),
        exactRatio: Number((exact / Math.max(1, count)).toFixed(4))
    };
}

export function classifyVectorRepairOutcome({ expected, inverse, repair }) {
    if (expected === 'repairable') {
        const improvedEnough = repair.rmse <= inverse.rmse * 0.4 && repair.maxError <= inverse.maxError;
        return {
            label: improvedEnough ? 'repairable-improved' : 'repairable-not-improved',
            productionBlocker: !improvedEnough
        };
    }

    const regressed = repair.rmse > inverse.rmse * 1.25 || repair.maxError > inverse.maxError + 24;
    return {
        label: regressed ? 'protected-regression' : 'protected-not-worse',
        productionBlocker: regressed
    };
}

export function summarizeVectorRepairFixtureResults(results) {
    const labels = {};
    const blockers = new Set();
    for (const result of results) {
        const label = result.outcome?.label ?? 'unknown';
        labels[label] = (labels[label] ?? 0) + 1;
        if (result.outcome?.productionBlocker === true || label === 'protected-regression') {
            blockers.add(label);
        }
    }

    return {
        total: results.length,
        productionReady: blockers.size === 0,
        labels,
        blockers: [...blockers].sort()
    };
}

async function saveImage(imageData, filePath) {
    await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toFile(filePath);
}

function escapeSvgText(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function labelSvg({ width, height, text, background = '#111827', fill = '#e5e7eb', fontSize = 13 }) {
    return Buffer.from(
        `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="100%" height="100%" fill="${background}"/>` +
        `<text x="8" y="${Math.round(height / 2 + fontSize / 3)}" fill="${fill}" ` +
        `font-family="Arial, sans-serif" font-size="${fontSize}">${escapeSvgText(text)}</text>` +
        '</svg>'
    );
}

async function createSheet(rows, filePath) {
    const tileWidth = WIDTH;
    const tileHeight = HEIGHT;
    const columns = COLUMNS.length;
    const sheet = {
        width: tileWidth * columns,
        height: HEADER_HEIGHT + (tileHeight + ROW_LABEL_HEIGHT) * rows.length,
        data: new Uint8ClampedArray(
            tileWidth * columns * (HEADER_HEIGHT + (tileHeight + ROW_LABEL_HEIGHT) * rows.length) * 4
        )
    };
    sheet.data.fill(255);
    const overlays = [];

    COLUMNS.forEach((label, columnIndex) => {
        overlays.push({
            input: labelSvg({ width: tileWidth, height: HEADER_HEIGHT, text: label }),
            left: columnIndex * tileWidth,
            top: 0
        });
    });

    rows.forEach((row, rowIndex) => {
        const rowTop = HEADER_HEIGHT + rowIndex * (tileHeight + ROW_LABEL_HEIGHT);
        overlays.push({
            input: labelSvg({
                width: sheet.width,
                height: ROW_LABEL_HEIGHT,
                text: `${row.id} | ${row.expected} | raw=${row.outcome.label} | gated=${row.gatedOutcome.label}`,
                background: row.gatedOutcome.productionBlocker ? '#7f1d1d' : '#14532d',
                fill: '#f9fafb',
                fontSize: 12
            }),
            left: 0,
            top: rowTop
        });

        [
            row.truth,
            row.watermarked,
            row.inverseImageData,
            row.repairImageData,
            row.gatedRepairImageData
        ].forEach((imageData, columnIndex) => {
            for (let y = 0; y < tileHeight; y++) {
                for (let x = 0; x < tileWidth; x++) {
                    const sourceIndex = pixelIndex(imageData, x, y);
                    const targetY = rowTop + ROW_LABEL_HEIGHT + y;
                    const targetIndex = (targetY * sheet.width + columnIndex * tileWidth + x) * 4;
                    sheet.data[targetIndex] = imageData.data[sourceIndex];
                    sheet.data[targetIndex + 1] = imageData.data[sourceIndex + 1];
                    sheet.data[targetIndex + 2] = imageData.data[sourceIndex + 2];
                    sheet.data[targetIndex + 3] = 255;
                }
            }
        });
    });

    await sharp(Buffer.from(sheet.data), {
        raw: {
            width: sheet.width,
            height: sheet.height,
            channels: 4
        }
    }).composite(overlays).png().toFile(filePath);
}

export async function createIssue103VectorRepairFixturePack({
    outputDir = DEFAULT_OUTPUT_DIR
} = {}) {
    await mkdir(outputDir, { recursive: true });
    const alphaMap = getEmbeddedAlphaMap(ALPHA_KEY);
    const results = [];
    const sheetRows = [];

    for (const caseItem of createIssue103VectorRepairFixtureCases()) {
        const truth = paintCase(caseItem.pattern);
        const watermarked = applyWatermark(truth, alphaMap, caseItem.trueGain);
        const inverseImageData = cloneImageData(watermarked);
        removeWatermark(inverseImageData, alphaMap, POSITION, { alphaGain: caseItem.inverseAlphaGain });
        const repair = applyPaletteSnapRepair(watermarked, alphaMap, caseItem.repairAlphaGain);
        const gatedRepair = applyGatedPaletteRepair(
            watermarked,
            inverseImageData,
            alphaMap,
            caseItem.repairAlphaGain,
            repair
        );

        const inverse = calculateRoiErrorMetrics(inverseImageData, truth);
        const repairMetrics = calculateRoiErrorMetrics(repair.imageData, truth);
        const gatedRepairMetrics = calculateRoiErrorMetrics(gatedRepair.imageData, truth);
        const outcome = classifyVectorRepairOutcome({
            expected: caseItem.expected,
            inverse,
            repair: repairMetrics
        });
        const gatedOutcome = classifyVectorRepairOutcome({
            expected: caseItem.expected,
            inverse,
            repair: gatedRepairMetrics
        });

        const files = {
            truth: path.join(outputDir, `${caseItem.id}-truth.png`),
            watermarked: path.join(outputDir, `${caseItem.id}-watermarked.png`),
            inverse: path.join(outputDir, `${caseItem.id}-inverse.png`),
            repair: path.join(outputDir, `${caseItem.id}-palette-snap.png`),
            gatedRepair: path.join(outputDir, `${caseItem.id}-gated-palette-snap.png`)
        };
        const result = {
            id: caseItem.id,
            expected: caseItem.expected,
            pattern: caseItem.pattern,
            trueGain: caseItem.trueGain,
            inverseAlphaGain: caseItem.inverseAlphaGain,
            repairAlphaGain: caseItem.repairAlphaGain,
            repairChangedPixels: repair.changed,
            inverse,
            repair: repairMetrics,
            gatedRepair: gatedRepairMetrics,
            outcome,
            gatedOutcome,
            gatedDecision: {
                adopted: gatedRepair.adopted,
                changedPixels: gatedRepair.changed,
                safety: gatedRepair.safety
            },
            files
        };
        results.push(result);
        sheetRows.push({
            id: caseItem.id,
            expected: caseItem.expected,
            outcome,
            gatedOutcome,
            truth,
            watermarked,
            inverseImageData,
            repairImageData: repair.imageData,
            gatedRepairImageData: gatedRepair.imageData
        });

        await saveImage(truth, files.truth);
        await saveImage(watermarked, files.watermarked);
        await saveImage(inverseImageData, files.inverse);
        await saveImage(repair.imageData, files.repair);
        await saveImage(gatedRepair.imageData, files.gatedRepair);
    }

    const sheetPath = path.join(outputDir, 'comparison-sheet.png');
    await createSheet(sheetRows, sheetPath);
    const report = {
        generatedAt: new Date().toISOString(),
        alphaKey: ALPHA_KEY,
        columns: COLUMNS,
        position: POSITION,
        summary: summarizeVectorRepairFixtureResults(results),
        gatedSummary: summarizeVectorRepairFixtureResults(
            results.map((result) => ({
                ...result,
                outcome: result.gatedOutcome
            }))
        ),
        results,
        sheetPath
    };
    const reportPath = path.join(outputDir, 'report.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2));

    return {
        reportPath,
        sheetPath,
        report
    };
}

function parseArgs(argv) {
    const parsed = { outputDir: DEFAULT_OUTPUT_DIR };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(argv[++index] ?? DEFAULT_OUTPUT_DIR);
        }
    }
    return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const options = parseArgs(process.argv.slice(2));
    createIssue103VectorRepairFixturePack(options)
        .then(({ reportPath, sheetPath, report }) => {
            console.log(JSON.stringify({
                reportPath,
                sheetPath,
                summary: report.summary,
                gatedSummary: report.gatedSummary
            }, null, 2));
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
