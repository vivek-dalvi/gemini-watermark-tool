import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const DEFAULT_HTML_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png');
const DEFAULT_REPORT_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index-screenshot.json');

export function resolveReviewScreenshotOptions({
    htmlPath = DEFAULT_HTML_PATH,
    outputPath = DEFAULT_OUTPUT_PATH,
    reportPath = DEFAULT_REPORT_PATH,
    width = 1440,
    height = 1200,
    fullPage = true
} = {}) {
    return {
        htmlPath: path.resolve(htmlPath),
        outputPath: path.resolve(outputPath),
        reportPath: path.resolve(reportPath),
        width: Number(width) || 1440,
        height: Number(height) || 1200,
        fullPage: fullPage !== false
    };
}

export async function createVideoReviewScreenshot(options = {}) {
    const resolved = resolveReviewScreenshotOptions(options);
    const browser = await chromium.launch({ headless: true });
    let documentSize = null;
    try {
        const page = await browser.newPage({
            viewport: { width: resolved.width, height: resolved.height }
        });
        await page.goto(pathToFileURL(resolved.htmlPath).href, { waitUntil: 'load' });
        await page.locator('body').waitFor({ state: 'visible' });
        documentSize = await page.evaluate(() => {
            const element = document.documentElement;
            const body = document.body;
            return {
                scrollWidth: Math.max(element.scrollWidth, body?.scrollWidth || 0),
                scrollHeight: Math.max(element.scrollHeight, body?.scrollHeight || 0),
                clientWidth: element.clientWidth,
                clientHeight: element.clientHeight
            };
        });
        await mkdir(path.dirname(resolved.outputPath), { recursive: true });
        await page.screenshot({
            path: resolved.outputPath,
            fullPage: resolved.fullPage
        });
    } finally {
        await browser.close();
    }

    const report = {
        generatedAt: new Date().toISOString(),
        htmlPath: resolved.htmlPath,
        outputPath: resolved.outputPath,
        viewport: {
            width: resolved.width,
            height: resolved.height
        },
        documentSize,
        fullPage: resolved.fullPage
    };
    await mkdir(path.dirname(resolved.reportPath), { recursive: true });
    await writeFile(resolved.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return {
        ...report,
        reportPath: resolved.reportPath
    };
}

function parseArgs(argv) {
    const parsed = {
        htmlPath: DEFAULT_HTML_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        reportPath: DEFAULT_REPORT_PATH,
        width: 1440,
        height: 1200,
        fullPage: true
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--html') {
            parsed.htmlPath = path.resolve(argv[++i] || DEFAULT_HTML_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--report') {
            parsed.reportPath = path.resolve(argv[++i] || DEFAULT_REPORT_PATH);
        } else if (arg === '--width') {
            parsed.width = Number(argv[++i]);
        } else if (arg === '--height') {
            parsed.height = Number(argv[++i]);
        } else if (arg === '--viewport') {
            const [width, height] = String(argv[++i] || '').split(/[x,]/i).map(Number);
            parsed.width = width;
            parsed.height = height;
        } else if (arg === '--viewport-only') {
            parsed.fullPage = false;
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
  node scripts/create-video-review-screenshot.js [--html <review.html>] [--output <png>] [--report <json>]

Default output:
  .artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoReviewScreenshot(args)
        .then((report) => {
            console.log(`png: ${report.outputPath}`);
            console.log(`json: ${report.reportPath}`);
            console.log(`viewport: ${report.viewport.width}x${report.viewport.height}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
