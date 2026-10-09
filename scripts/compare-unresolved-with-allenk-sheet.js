import path from 'node:path';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { processWatermarkImageData } from '../src/core/watermarkProcessor.js';
import { scoreRegion } from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const execFileAsync = promisify(execFile);

const DEFAULT_REPORT_PATH = path.resolve('.artifacts/sample-files-gemini-watermark/latest-strong-located-report.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/sample-files-gemini-watermark/allenk-unresolved-comparison');
const DEFAULT_ALLENK_EXE = path.resolve('.artifacts/allenk-GeminiWatermarkTool-bin/gwt-mini.exe');
const PANEL_SIZE = 172;
const LABEL_HEIGHT = 46;
const HEADER_HEIGHT = 58;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const BACKGROUND = '#111111';

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        sampleRoot: null,
        allenkExe: DEFAULT_ALLENK_EXE
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || '.');
        } else if (arg === '--allenk-exe') {
            parsed.allenkExe = path.resolve(args.shift() || parsed.allenkExe);
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

function formatNumber(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function sanitizeName(fileName, index) {
    return `${String(index + 1).padStart(2, '0')}-${fileName
        .replace(/\\/g, '/')
        .replace(/[^\w.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(-140)}`;
}

async function pathExists(filePath) {
    try {
        await access(filePath, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function removeIfExists(filePath) {
    try {
        await unlink(filePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function resolveAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', alpha36V2]
    ]);

    return {
        alpha48,
        alpha96,
        alpha96Variants: {
            '20260520': alpha96NewMargin
        },
        getAlphaMap(size) {
            if (cache.has(size)) return cache.get(size);
            if (typeof size === 'string') return null;
            const alphaMap = interpolateAlphaMap(alpha96, 96, size);
            cache.set(size, alphaMap);
            return alphaMap;
        }
    };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

async function encodeImageData(imageData, outputPath) {
    await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .png()
        .toFile(outputPath);
}

function cropImageData(imageData, cropBox) {
    const data = new Uint8ClampedArray(cropBox.width * cropBox.height * 4);
    for (let row = 0; row < cropBox.height; row++) {
        const sourceStart = ((cropBox.top + row) * imageData.width + cropBox.left) * 4;
        const targetStart = row * cropBox.width * 4;
        data.set(
            imageData.data.subarray(sourceStart, sourceStart + cropBox.width * 4),
            targetStart
        );
    }
    return {
        width: cropBox.width,
        height: cropBox.height,
        data
    };
}

function calculatePositionCropBox(position, imageData) {
    const targetSize = Math.max(180, Math.min(460, Math.round(position.width * 3.6)));
    const width = Math.min(targetSize, imageData.width);
    const height = Math.min(targetSize, imageData.height);
    const centerX = position.x + position.width / 2;
    const centerY = position.y + position.height / 2;
    return {
        left: Math.max(0, Math.min(imageData.width - width, Math.round(centerX - width / 2))),
        top: Math.max(0, Math.min(imageData.height - height, Math.round(centerY - height / 2))),
        width,
        height
    };
}

function resolvePosition(record, imageData) {
    if (record.position) return record.position;
    const config = record.actualAnchor ?? record.anchor;
    if (config?.logoSize && Number.isFinite(config.marginRight) && Number.isFinite(config.marginBottom)) {
        return {
            x: imageData.width - config.marginRight - config.logoSize,
            y: imageData.height - config.marginBottom - config.logoSize,
            width: config.logoSize,
            height: config.logoSize
        };
    }
    const size = imageData.width > 1024 && imageData.height > 1024 ? 96 : 48;
    const margin = size === 96 ? 64 : 32;
    return {
        x: imageData.width - margin - size,
        y: imageData.height - margin - size,
        width: size,
        height: size
    };
}

function parseHexColor(color) {
    const match = /^#?([0-9a-f]{6})$/i.exec(color);
    if (!match) return [255, 255, 255];
    const value = Number.parseInt(match[1], 16);
    return [
        (value >> 16) & 255,
        (value >> 8) & 255,
        value & 255
    ];
}

function blendPixel(data, offset, red, green, blue, alpha = 0.78) {
    data[offset] = Math.round(data[offset] * (1 - alpha) + red * alpha);
    data[offset + 1] = Math.round(data[offset + 1] * (1 - alpha) + green * alpha);
    data[offset + 2] = Math.round(data[offset + 2] * (1 - alpha) + blue * alpha);
    data[offset + 3] = 255;
}

function drawCornerMarkers(imageData, position, cropBox, color = '#ff5555') {
    const data = new Uint8ClampedArray(imageData.data);
    const [red, green, blue] = parseHexColor(color);
    const local = {
        x: Math.round(position.x - cropBox.left),
        y: Math.round(position.y - cropBox.top),
        width: Math.round(position.width),
        height: Math.round(position.height)
    };
    const left = Math.max(0, Math.min(imageData.width - 1, local.x));
    const top = Math.max(0, Math.min(imageData.height - 1, local.y));
    const right = Math.max(left, Math.min(imageData.width - 1, local.x + local.width));
    const bottom = Math.max(top, Math.min(imageData.height - 1, local.y + local.height));
    const tickLength = Math.max(10, Math.min(28, Math.round(Math.min(local.width, local.height) * 0.32)));

    const paint = (x, y) => blendPixel(data, (y * imageData.width + x) * 4, red, green, blue);
    for (let inset = 0; inset < 2; inset++) {
        const x0 = Math.min(imageData.width - 1, left + inset);
        const x1 = Math.max(0, right - inset);
        const y0 = Math.min(imageData.height - 1, top + inset);
        const y1 = Math.max(0, bottom - inset);
        for (let x = x0; x <= Math.min(x1, x0 + tickLength); x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let x = Math.max(x0, x1 - tickLength); x <= x1; x++) {
            paint(x, y0);
            paint(x, y1);
        }
        for (let y = y0; y <= Math.min(y1, y0 + tickLength); y++) {
            paint(x0, y);
            paint(x1, y);
        }
        for (let y = Math.max(y0, y1 - tickLength); y <= y1; y++) {
            paint(x0, y);
            paint(x1, y);
        }
    }

    return {
        width: imageData.width,
        height: imageData.height,
        data
    };
}

function createDiffImageData(leftImage, rightImage) {
    const data = new Uint8ClampedArray(leftImage.data.length);
    for (let offset = 0; offset < data.length; offset += 4) {
        const leftLum = (leftImage.data[offset] + leftImage.data[offset + 1] + leftImage.data[offset + 2]) / 3;
        const rightLum = (rightImage.data[offset] + rightImage.data[offset + 1] + rightImage.data[offset + 2]) / 3;
        const signedDelta = leftLum - rightLum;
        const amplified = Math.min(255, Math.abs(signedDelta) * 4);
        if (signedDelta >= 0) {
            data[offset] = amplified;
            data[offset + 1] = Math.round(amplified * 0.48);
            data[offset + 2] = Math.round(amplified * 0.16);
        } else {
            data[offset] = Math.round(amplified * 0.18);
            data[offset + 1] = Math.round(amplified * 0.5);
            data[offset + 2] = amplified;
        }
        data[offset + 3] = 255;
    }
    return {
        width: leftImage.width,
        height: leftImage.height,
        data
    };
}

function createMissingImageData(width, height, label = 'skipped') {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) {
        data[offset] = 25;
        data[offset + 1] = 25;
        data[offset + 2] = 25;
        data[offset + 3] = 255;
    }
    return { width, height, data, label };
}

function resolveAlphaMapForRecord(record, alphaMaps) {
    const config = record.actualAnchor ?? record.anchor;
    if (!config) return null;
    const key = config.alphaVariant === '20260520' ? '96-20260520' : config.logoSize;
    const alphaMap = alphaMaps.getAlphaMap(key);
    if (!alphaMap) return null;
    if (String(record.source).includes('dark-polarity')) {
        const negative = new Float32Array(alphaMap.length);
        for (let index = 0; index < alphaMap.length; index++) negative[index] = -alphaMap[index];
        return negative;
    }
    return alphaMap;
}

function scoreOutput(imageData, record, position, alphaMaps) {
    const alphaMap = resolveAlphaMapForRecord(record, alphaMaps);
    if (!alphaMap || position.width !== position.height || alphaMap.length !== position.width * position.height) {
        return null;
    }
    return scoreRegion(imageData, alphaMap, position);
}

async function encodePanel(imageData, labelLines, options = {}) {
    const imageBuffer = await sharp(Buffer.from(imageData.data), {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    })
        .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
    const missingLabel = imageData.label ? `
        <text x="${PANEL_SIZE / 2}" y="${PANEL_SIZE / 2}" fill="#d8d8d8"
          text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700">${escapeSvgText(imageData.label)}</text>
    ` : '';
    const labelSvg = Buffer.from(`
        <svg width="${PANEL_SIZE}" height="${LABEL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="${options.labelFill ?? '#171717'}"/>
          ${labelLines.slice(0, 3).map((line, index) => `
            <text x="7" y="${14 + index * 14}" fill="${index === 0 ? '#f2f2f2' : '#b8b8b8'}"
              font-family="Arial, sans-serif" font-size="${index === 0 ? 10 : 9}">${escapeSvgText(line)}</text>
          `).join('')}
        </svg>
    `);

    const base = await sharp({
        create: {
            width: PANEL_SIZE,
            height: PANEL_SIZE + LABEL_HEIGHT,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite([
            { input: imageBuffer, left: 0, top: 0 },
            ...(missingLabel
                ? [{
                    input: Buffer.from(`<svg width="${PANEL_SIZE}" height="${PANEL_SIZE}" xmlns="http://www.w3.org/2000/svg">${missingLabel}</svg>`),
                    left: 0,
                    top: 0
                }]
                : []),
            { input: labelSvg, left: 0, top: PANEL_SIZE }
        ])
        .png()
        .toBuffer();

    return base;
}

async function createHeader(width, title, subtitle) {
    return Buffer.from(`
        <svg width="${width}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#0b0b0b"/>
          <text x="10" y="22" fill="#ffffff" font-family="Arial, sans-serif" font-size="15" font-weight="700">${escapeSvgText(title)}</text>
          <text x="10" y="43" fill="#bdbdbd" font-family="Arial, sans-serif" font-size="11">${escapeSvgText(subtitle)}</text>
        </svg>
    `);
}

async function writeSheet(rows, outputPath, title, subtitle) {
    const columns = 5;
    const panelHeight = PANEL_SIZE + LABEL_HEIGHT;
    const width = columns * PANEL_SIZE + (columns - 1) * PANEL_GAP;
    const height = HEADER_HEIGHT + rows.length * panelHeight + Math.max(0, rows.length - 1) * ROW_GAP;
    const composites = [
        { input: await createHeader(width, title, subtitle), left: 0, top: 0 }
    ];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const top = HEADER_HEIGHT + rowIndex * (panelHeight + ROW_GAP);
        for (let column = 0; column < columns; column++) {
            composites.push({
                input: rows[rowIndex][column],
                left: column * (PANEL_SIZE + PANEL_GAP),
                top
            });
        }
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);
}

async function runAllenk({ allenkExe, inputPath, outputPath, mode }) {
    await removeIfExists(outputPath);
    const args = [
        '--no-banner',
        '-i',
        inputPath,
        '-o',
        outputPath,
        '-r'
    ];
    if (mode === 'fallback-snap') {
        args.push('--fallback-region', 'br:auto', '--snap', '--snap-threshold', '0.45');
    }

    let stdout = '';
    let stderr = '';
    let errorText = null;
    try {
        const result = await execFileAsync(allenkExe, args, {
            cwd: path.dirname(allenkExe),
            timeout: 60000,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024
        });
        stdout = result.stdout ?? '';
        stderr = result.stderr ?? '';
    } catch (error) {
        stdout = error?.stdout ?? '';
        stderr = error?.stderr ?? '';
        errorText = error?.message ?? String(error);
    }

    return {
        mode,
        outputPath,
        created: await pathExists(outputPath),
        stdout,
        stderr,
        errorText
    };
}

function summarizeAllenkText(text) {
    const confidence = /\((\d+)% confidence\)/.exec(text)?.[1] ?? null;
    if (/No watermark detected/i.test(text) && !/Saved:/i.test(text)) return 'skipped';
    if (/Saved:/i.test(text)) return confidence ? `${confidence}%` : 'saved';
    return 'n/a';
}

function summarizeAllenkRun(run) {
    const status = summarizeAllenkText(`${run.stdout}\n${run.stderr}`);
    if (run.created && status === 'n/a') return 'saved';
    return status;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const sampleRoot = args.sampleRoot ?? report.sampleRoot;
    if (!sampleRoot) throw new Error('sampleRoot is required');
    if (!await pathExists(args.allenkExe)) throw new Error(`allenk executable not found: ${args.allenkExe}`);

    await mkdir(args.outputDir, { recursive: true });
    const oursDir = path.join(args.outputDir, 'ours');
    const allenkDefaultDir = path.join(args.outputDir, 'allenk-default');
    const allenkSnapDir = path.join(args.outputDir, 'allenk-fallback-snap');
    await mkdir(oursDir, { recursive: true });
    await mkdir(allenkDefaultDir, { recursive: true });
    await mkdir(allenkSnapDir, { recursive: true });

    const alphaMaps = resolveAlphaMaps();
    const failures = (report.failures ?? [])
        .filter((failure) => failure.bucket === 'weak-suppression' || failure.bucket === 'residual-edge');
    const rows = [];
    const records = [];

    for (let index = 0; index < failures.length; index++) {
        const failure = failures[index];
        const resultRecord = (report.results ?? []).find((record) => record.fileName === failure.fileName) ?? failure;
        const sourcePath = resultRecord.filePath ?? path.join(sampleRoot, failure.fileName);
        const safeName = sanitizeName(failure.fileName, index);
        const oursPath = path.join(oursDir, `${safeName}.png`);
        const allenkDefaultPath = path.join(allenkDefaultDir, `${safeName}.png`);
        const allenkSnapPath = path.join(allenkSnapDir, `${safeName}.png`);

        const original = await decodeImageDataInNode(sourcePath);
        const ours = processWatermarkImageData(cloneImageData(original), alphaMaps);
        await encodeImageData(ours.imageData, oursPath);

        const allenkDefault = await runAllenk({
            allenkExe: args.allenkExe,
            inputPath: sourcePath,
            outputPath: allenkDefaultPath,
            mode: 'default'
        });
        const allenkSnap = await runAllenk({
            allenkExe: args.allenkExe,
            inputPath: sourcePath,
            outputPath: allenkSnapPath,
            mode: 'fallback-snap'
        });

        const position = resolvePosition(resultRecord, original);
        const cropBox = calculatePositionCropBox(position, original);
        const sourceCrop = drawCornerMarkers(cropImageData(original, cropBox), position, cropBox);
        const oursCrop = cropImageData(ours.imageData, cropBox);
        const allenkDefaultImage = allenkDefault.created
            ? await decodeImageDataInNode(allenkDefaultPath)
            : null;
        const allenkSnapImage = allenkSnap.created
            ? await decodeImageDataInNode(allenkSnapPath)
            : null;
        const allenkDefaultCrop = allenkDefaultImage
            ? cropImageData(allenkDefaultImage, cropBox)
            : createMissingImageData(cropBox.width, cropBox.height, 'skipped');
        const allenkSnapCrop = allenkSnapImage
            ? cropImageData(allenkSnapImage, cropBox)
            : createMissingImageData(cropBox.width, cropBox.height, 'skipped');
        const diffBase = allenkDefaultImage ? allenkDefaultCrop : allenkSnapCrop;
        const diffCrop = createDiffImageData(oursCrop, diffBase);

        const oursScore = scoreOutput(ours.imageData, resultRecord, position, alphaMaps);
        const allenkDefaultScore = allenkDefaultImage
            ? scoreOutput(allenkDefaultImage, resultRecord, position, alphaMaps)
            : null;
        const allenkSnapScore = allenkSnapImage
            ? scoreOutput(allenkSnapImage, resultRecord, position, alphaMaps)
            : null;
        const shortName = failure.fileName.split(/[\\/]/).pop();
        const anchor = resultRecord.actualAnchor ?? failure.anchor;
        const anchorLabel = anchor
            ? `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${anchor.alphaVariant ? `/${anchor.alphaVariant}` : ''}`
            : 'none';
        const defaultStatus = summarizeAllenkRun(allenkDefault);
        const snapStatus = summarizeAllenkRun(allenkSnap);

        rows.push([
            await encodePanel(sourceCrop, [shortName, `${failure.bucket}`, `anchor ${anchorLabel}`]),
            await encodePanel(oursCrop, ['ours', resultRecord.source ?? failure.source, `res ${formatNumber(oursScore?.spatialScore)}`]),
            await encodePanel(allenkDefaultCrop, ['allenk default', defaultStatus, `res ${formatNumber(allenkDefaultScore?.spatialScore)}`]),
            await encodePanel(allenkSnapCrop, ['allenk snap', snapStatus, `res ${formatNumber(allenkSnapScore?.spatialScore)}`]),
            await encodePanel(diffCrop, ['diff x4', 'ours - allenk', allenkDefault.created ? 'vs default' : 'vs snap'])
        ]);

        records.push({
            fileName: failure.fileName,
            bucket: failure.bucket,
            sourcePath,
            oursPath,
            allenkDefaultPath,
            allenkSnapPath,
            allenkDefaultCreated: allenkDefault.created,
            allenkSnapCreated: allenkSnap.created,
            allenkDefaultStatus: defaultStatus,
            allenkSnapStatus: snapStatus,
            anchor,
            oursScore,
            allenkDefaultScore,
            allenkSnapScore,
            allenkDefaultError: allenkDefault.errorText,
            allenkSnapError: allenkSnap.errorText
        });

        console.log(`[${index + 1}/${failures.length}] ${failure.fileName} default=${defaultStatus} snap=${snapStatus}`);
    }

    const sheetPath = path.join(args.outputDir, 'ours-vs-allenk-unresolved-sheet.png');
    await writeSheet(
        rows,
        sheetPath,
        'Unresolved Cases: Ours vs allenk',
        `${failures.length} weak-suppression/residual-edge cases, same ROI crop per row`
    );

    const summary = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        allenkExe: args.allenkExe,
        outputDir: args.outputDir,
        sheetPath,
        caseCount: failures.length,
        buckets: failures.reduce((acc, failure) => {
            acc[failure.bucket] = (acc[failure.bucket] ?? 0) + 1;
            return acc;
        }, {}),
        allenkDefaultCreatedCount: records.filter((record) => record.allenkDefaultCreated).length,
        allenkSnapCreatedCount: records.filter((record) => record.allenkSnapCreated).length,
        records
    };

    await writeFile(path.join(args.outputDir, 'latest-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'latest-report.md'), [
        '# Unresolved Cases: Ours vs allenk',
        '',
        `- Cases: ${summary.caseCount}`,
        `- Buckets: ${Object.entries(summary.buckets).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        `- allenk default output: ${summary.allenkDefaultCreatedCount}/${summary.caseCount}`,
        `- allenk fallback-snap output: ${summary.allenkSnapCreatedCount}/${summary.caseCount}`,
        `- Sheet: \`${sheetPath}\``,
        '',
        '| Case | Bucket | allenk default | allenk snap | ours residual | default residual | snap residual |',
        '|---|---:|---:|---:|---:|---:|---:|',
        ...records.map((record) => [
            record.fileName,
            record.bucket,
            record.allenkDefaultStatus,
            record.allenkSnapStatus,
            formatNumber(record.oursScore?.spatialScore),
            formatNumber(record.allenkDefaultScore?.spatialScore),
            formatNumber(record.allenkSnapScore?.spatialScore)
        ].map((cell) => String(cell).replace(/\|/g, '\\|')).join(' | ')).map((line) => `| ${line} |`),
        ''
    ].join('\n'), 'utf8');

    console.log(JSON.stringify({
        sheetPath,
        caseCount: summary.caseCount,
        allenkDefaultCreatedCount: summary.allenkDefaultCreatedCount,
        allenkSnapCreatedCount: summary.allenkSnapCreatedCount
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
