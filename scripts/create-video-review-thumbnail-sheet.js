import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

const DEFAULT_QUICKSTART_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-acceptance-quickstart.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.png');
const DEFAULT_JSON_PATH = path.resolve('.artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.json');

const TILE_WIDTH = 360;
const TILE_HEIGHT = 203;
const LABEL_HEIGHT = 58;
const GAP = 14;
const PADDING = 18;
const HEADER_HEIGHT = 74;

function escapeXml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function basename(filePath) {
    return filePath ? path.basename(filePath) : '-';
}

function labelSvg({ width, height, title, subtitle, fill = '#171b22' }) {
    return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="${fill}"/>
<text x="12" y="23" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="#f4f7fb">${escapeXml(title)}</text>
<text x="12" y="45" font-family="Consolas, monospace" font-size="11" fill="#a8b0bd">${escapeXml(subtitle)}</text>
</svg>`);
}

function headerSvg({ width, total, lanes }) {
    return Buffer.from(`<svg width="${width}" height="${HEADER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="#0e1117"/>
<text x="${PADDING}" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#f4f7fb">Video Review Thumbnail Sheet</text>
<text x="${PADDING}" y="55" font-family="Consolas, monospace" font-size="12" fill="#a8b0bd">${escapeXml(`${total} thumbnails across ${lanes} lanes`)}</text>
</svg>`);
}

function collectThumbnailItems(quickstart = {}) {
    const items = [];
    for (const lane of quickstart.lanes || []) {
        for (const video of lane.reviewVideos || []) {
            items.push({
                laneId: lane.id || null,
                caseId: video.caseId || null,
                kind: video.kind || null,
                currentTime: video.currentTime ?? null,
                videoPath: video.src || null,
                thumbnailPath: video.thumbnailPath || null
            });
        }
    }
    return items;
}

export async function createVideoReviewThumbnailSheet({
    quickstartPath = DEFAULT_QUICKSTART_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    jsonPath = DEFAULT_JSON_PATH,
    columns = 3
} = {}) {
    const resolvedQuickstartPath = path.resolve(quickstartPath);
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedJsonPath = path.resolve(jsonPath);
    const quickstart = JSON.parse(await readFile(resolvedQuickstartPath, 'utf8'));
    const items = collectThumbnailItems(quickstart);
    const readyItems = items.filter((item) => item.thumbnailPath);
    const columnCount = Math.max(1, Number(columns) || 3);
    const rowCount = Math.max(1, Math.ceil(Math.max(readyItems.length, 1) / columnCount));
    const width = PADDING * 2 + columnCount * TILE_WIDTH + (columnCount - 1) * GAP;
    const tileTotalHeight = LABEL_HEIGHT + TILE_HEIGHT;
    const height = HEADER_HEIGHT + PADDING * 2 + rowCount * tileTotalHeight + (rowCount - 1) * GAP;
    const composites = [
        { input: headerSvg({ width, total: readyItems.length, lanes: new Set(items.map((item) => item.laneId).filter(Boolean)).size }), left: 0, top: 0 }
    ];

    for (let index = 0; index < readyItems.length; index++) {
        const item = readyItems[index];
        const col = index % columnCount;
        const row = Math.floor(index / columnCount);
        const left = PADDING + col * (TILE_WIDTH + GAP);
        const top = HEADER_HEIGHT + PADDING + row * (tileTotalHeight + GAP);
        const title = `${item.laneId || '-'} | ${item.caseId || '-'} | ${item.kind || '-'}`;
        const time = Number.isFinite(Number(item.currentTime)) ? `${Number(item.currentTime)}s` : '-';
        const subtitle = `${time} | ${basename(item.thumbnailPath)}`;
        const image = await sharp(path.resolve(item.thumbnailPath))
            .resize(TILE_WIDTH, TILE_HEIGHT, { fit: 'cover' })
            .png()
            .toBuffer();
        composites.push({ input: labelSvg({ width: TILE_WIDTH, height: LABEL_HEIGHT, title, subtitle }), left, top });
        composites.push({ input: image, left, top: top + LABEL_HEIGHT });
    }

    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: '#0e1117'
        }
    }).composite(composites).png().toFile(resolvedOutputPath);

    const report = {
        generatedAt: new Date().toISOString(),
        quickstartPath: resolvedQuickstartPath,
        outputPath: resolvedOutputPath,
        outputUrl: pathToFileURL(resolvedOutputPath).href,
        columns: columnCount,
        rows: rowCount,
        width,
        height,
        totalVideos: items.length,
        thumbnails: readyItems.length,
        missingThumbnails: items.length - readyItems.length,
        items: readyItems
    };
    await mkdir(path.dirname(resolvedJsonPath), { recursive: true });
    await writeFile(resolvedJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return {
        ...report,
        jsonPath: resolvedJsonPath
    };
}

function parseArgs(argv) {
    const parsed = {
        quickstartPath: DEFAULT_QUICKSTART_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        jsonPath: DEFAULT_JSON_PATH,
        columns: 3
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--quickstart') {
            parsed.quickstartPath = path.resolve(argv[++i] || DEFAULT_QUICKSTART_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--json') {
            parsed.jsonPath = path.resolve(argv[++i] || DEFAULT_JSON_PATH);
        } else if (arg === '--columns') {
            parsed.columns = Number(argv[++i]);
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
  node scripts/create-video-review-thumbnail-sheet.js [--quickstart <json>] [--output <png>] [--json <json>]

Default output:
  .artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.png
  .artifacts/video-delivery-bundle/latest-review-thumbnail-sheet.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoReviewThumbnailSheet(args)
        .then((report) => {
            console.log(`sheet: ${report.outputPath}`);
            console.log(`json: ${report.jsonPath}`);
            console.log(`thumbnails: ${report.thumbnails}/${report.totalVideos}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
