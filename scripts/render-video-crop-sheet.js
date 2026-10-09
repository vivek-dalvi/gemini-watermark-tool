import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { resolveVideoWatermarkCandidates } from '../src/video/videoWatermarkCatalog.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-crop-sheets/latest.png');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);
const DEFAULT_PADDING = 64;
const DEFAULT_DIFF_AMPLIFY = 4;
const PANEL_GAP = 10;
const ROW_GAP = 14;
const LABEL_HEIGHT = 28;
const SHEET_PADDING = 16;
const PANEL_BACKGROUND = '#111827';
const SHEET_BACKGROUND = '#0b1020';

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clampInteger(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
}

export function parseTimestampList(value) {
    if (value == null || value === '') return [...DEFAULT_TIMESTAMPS];
    const items = Array.isArray(value) ? value : String(value).trim().split(/[,\s]+/);
    const timestamps = items
        .map((item) => toFiniteNumber(String(item).trim()))
        .filter((item) => item !== null && item >= 0);
    if (!timestamps.length) {
        throw new Error('至少需要一个有效时间点，例如 --timestamps 1,3,5');
    }
    return timestamps;
}

export function resolveVideoCropTimestamps(timestamps, metadata = {}) {
    const parsed = parseTimestampList(timestamps);
    const duration = Number(metadata.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
        return parsed;
    }

    const maxTimestamp = Math.max(0, duration - 0.05);
    const usable = parsed.filter((timestamp) => timestamp <= maxTimestamp);
    if (usable.length > 0) {
        return usable;
    }

    return [Number(Math.min(maxTimestamp, duration / 2).toFixed(3))];
}

export function parseCropBox(value) {
    if (value == null || value === '') return null;
    const parts = String(value).trim().split(/[,\s]+/).map((part) => toFiniteNumber(part.trim()));
    if (parts.length !== 4 || parts.some((part) => part === null)) {
        throw new Error('裁剪区域格式应为 --crop x,y,width,height');
    }
    return normalizeCropBox({
        left: parts[0],
        top: parts[1],
        width: parts[2],
        height: parts[3]
    });
}

export function normalizeCropBox(cropBox, bounds = null) {
    const left = Math.round(cropBox.left);
    const top = Math.round(cropBox.top);
    const width = Math.round(cropBox.width);
    const height = Math.round(cropBox.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw new Error('裁剪区域必须是正数尺寸');
    }

    if (!bounds) return { left, top, width, height };

    const boundedLeft = clampInteger(left, 0, Math.max(0, bounds.width - 1));
    const boundedTop = clampInteger(top, 0, Math.max(0, bounds.height - 1));
    const boundedRight = clampInteger(left + width, boundedLeft + 1, bounds.width);
    const boundedBottom = clampInteger(top + height, boundedTop + 1, bounds.height);
    return {
        left: boundedLeft,
        top: boundedTop,
        width: boundedRight - boundedLeft,
        height: boundedBottom - boundedTop
    };
}

export function resolveDefaultVideoCropBox({ width, height, padding = DEFAULT_PADDING } = {}) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('缺少有效的视频尺寸，无法推断裁剪区域');
    }

    const candidates = resolveVideoWatermarkCandidates(width, height);
    if (!candidates.length) {
        const size = Math.min(220, width, height);
        return normalizeCropBox({
            left: width - size,
            top: height - size,
            width: size,
            height: size
        }, { width, height });
    }

    const candidate = candidates[0];
    return normalizeCropBox({
        left: candidate.x - padding,
        top: candidate.y - padding,
        width: candidate.size + padding * 2,
        height: candidate.size + padding * 2
    }, { width, height });
}

export function buildComparisonColumns({ currentPath, referencePath }) {
    const columns = [
        { id: 'original', label: 'original', kind: 'video', source: 'original' }
    ];

    if (currentPath) {
        columns.push({ id: 'current', label: 'current MVP', kind: 'video', source: 'current' });
    }
    if (referencePath) {
        columns.push({ id: 'reference', label: 'allenk', kind: 'video', source: 'reference' });
    }
    if (currentPath) {
        columns.push({ id: 'changed', label: 'absdiff original/current', kind: 'diff', left: 'original', right: 'current' });
    }
    if (currentPath && referencePath) {
        columns.push({ id: 'residual', label: 'absdiff current/allenk', kind: 'diff', left: 'current', right: 'reference' });
    }

    return columns;
}

export function formatTimestampFileSuffix(timestamp) {
    return String(timestamp).replace(/\W+/g, '_');
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
        '-show_entries', 'stream=width,height:format=duration',
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
        duration: Number(parsed.format?.duration)
    };
}

async function extractCropFrame({
    videoPath,
    timestamp,
    cropBox,
    outputPath
}) {
    const filter = `crop=${cropBox.width}:${cropBox.height}:${cropBox.left}:${cropBox.top}`;
    await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(timestamp),
        '-i', videoPath,
        '-frames:v', '1',
        '-vf', filter,
        outputPath
    ]);
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
    const out = Buffer.alloc(leftData.length);

    for (let i = 0; i < leftData.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) {
            out[i + channel] = Math.min(255, Math.abs(leftData[i + channel] - rightData[i + channel]) * amplify);
        }
        out[i + 3] = 255;
    }

    await sharp(out, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4
        }
    }).png().toFile(outputPath);
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

export async function renderVideoCropSheet({
    originalPath,
    currentPath = null,
    referencePath = null,
    outputPath = DEFAULT_OUTPUT_PATH,
    timestamps = DEFAULT_TIMESTAMPS,
    cropBox = null,
    keepFrames = false,
    diffAmplify = DEFAULT_DIFF_AMPLIFY,
    allowOriginalOnly = false,
    caseNote = null
} = {}) {
    if (!originalPath) {
        throw new Error('缺少原始视频路径：--original input.mp4');
    }
    if (!currentPath && !referencePath && !allowOriginalOnly) {
        throw new Error('至少提供 --current 或 --reference 中的一个对比视频');
    }

    const resolvedOutputPath = path.resolve(outputPath);
    const frameDir = path.join(path.dirname(resolvedOutputPath), `${path.basename(resolvedOutputPath, path.extname(resolvedOutputPath))}-frames`);
    const videos = {
        original: path.resolve(originalPath),
        current: currentPath ? path.resolve(currentPath) : null,
        reference: referencePath ? path.resolve(referencePath) : null
    };
    const metadata = await probeVideo(videos.original);
    const resolvedCropBox = cropBox
        ? normalizeCropBox(cropBox, metadata)
        : resolveDefaultVideoCropBox({ width: metadata.width, height: metadata.height });
    const candidates = resolveVideoWatermarkCandidates(metadata.width, metadata.height);
    const resolvedTimestamps = resolveVideoCropTimestamps(timestamps, metadata);
    const columns = buildComparisonColumns({ currentPath: videos.current, referencePath: videos.reference });

    await rm(frameDir, { recursive: true, force: true });
    await mkdir(frameDir, { recursive: true });

    const rows = [];
    try {
        for (const timestamp of resolvedTimestamps) {
            const framePaths = {};
            for (const [key, videoPath] of Object.entries(videos)) {
                if (!videoPath) continue;
                const outputFramePath = path.join(frameDir, `${key}-${formatTimestampFileSuffix(timestamp)}.png`);
                await extractCropFrame({
                    videoPath,
                    timestamp,
                    cropBox: resolvedCropBox,
                    outputPath: outputFramePath
                });
                framePaths[key] = outputFramePath;
            }

            const panels = [];
            for (const column of columns) {
                if (column.kind === 'video') {
                    panels.push({
                        label: column.label,
                        path: framePaths[column.source]
                    });
                    continue;
                }

                const outputFramePath = path.join(frameDir, `${column.id}-${formatTimestampFileSuffix(timestamp)}.png`);
                await createDiffPanel(framePaths[column.left], framePaths[column.right], outputFramePath, {
                    amplify: diffAmplify
                });
                panels.push({
                    label: `${column.label} x${diffAmplify}`,
                    path: outputFramePath
                });
            }

            rows.push({
                label: caseNote ? `${caseNote} | ${timestamp.toFixed(2)}s` : `${timestamp.toFixed(2)}s`,
                panels
            });
        }

        await buildSheet({ rows, columns, outputPath: resolvedOutputPath });
    } finally {
        if (!keepFrames) {
            await rm(frameDir, { recursive: true, force: true });
        }
    }

    return {
        outputPath: resolvedOutputPath,
        frameDir: keepFrames ? frameDir : null,
        timestamps: resolvedTimestamps,
        cropBox: resolvedCropBox,
        columns: columns.map((column) => column.id),
        candidates,
        primaryCandidate: candidates[0] || null,
        metadata
    };
}

function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        timestamps: [...DEFAULT_TIMESTAMPS],
        cropBox: null,
        keepFrames: false,
        diffAmplify: DEFAULT_DIFF_AMPLIFY
    };
    const args = [...argv];

    while (args.length) {
        const arg = args.shift();
        if (arg === '--') {
            continue;
        }
        if (arg === '--original') {
            parsed.originalPath = args.shift();
            continue;
        }
        if (arg === '--current') {
            parsed.currentPath = args.shift();
            continue;
        }
        if (arg === '--reference' || arg === '--allenk') {
            parsed.referencePath = args.shift();
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift() || parsed.outputPath;
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--crop') {
            parsed.cropBox = parseCropBox(args.shift());
            continue;
        }
        if (arg === '--keep-frames') {
            parsed.keepFrames = true;
            continue;
        }
        if (arg === '--original-only') {
            parsed.allowOriginalOnly = true;
            continue;
        }
        if (arg === '--diff-amplify') {
            const value = toFiniteNumber(args.shift());
            if (value !== null && value > 0) parsed.diffAmplify = value;
            continue;
        }
        if (!parsed.originalPath) {
            parsed.originalPath = arg;
        }
    }

    return parsed;
}

async function runCli() {
    const result = await renderVideoCropSheet(parseCliArgs(process.argv.slice(2)));
    console.log(`sheet: ${result.outputPath}`);
    console.log(`crop: ${result.cropBox.left},${result.cropBox.top},${result.cropBox.width},${result.cropBox.height}`);
    console.log(`timestamps: ${result.timestamps.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
