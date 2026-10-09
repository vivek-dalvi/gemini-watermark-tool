import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import {
    isHttpUrl,
    withLocalStaticPreviewPage
} from './local-static-preview-server.js';

const DEFAULT_PAGE_PATH = path.resolve('dist/video-preview.html');
const PRESET_BUTTON_SELECTOR = '#relocatedReviewPresetBtn';

function defaultArtifactPath(outputPath, suffix) {
    const parsed = path.parse(outputPath);
    return path.join(parsed.dir, `${parsed.name}${suffix}`);
}

function parseArgs(argv) {
    const args = {
        pagePath: DEFAULT_PAGE_PATH,
        timeoutMs: 6 * 60 * 1000,
        screenshots: true
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            continue;
        } else if (arg === '--input') {
            args.inputPath = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.outputPath = path.resolve(argv[++i]);
        } else if (arg === '--page') {
            const pageValue = argv[++i];
            args.pagePath = isHttpUrl(pageValue) ? pageValue : path.resolve(pageValue);
        } else if (arg === '--report') {
            args.reportPath = path.resolve(argv[++i]);
        } else if (arg === '--markdown') {
            args.markdownPath = path.resolve(argv[++i]);
        } else if (arg === '--screenshot-dir') {
            args.screenshotDir = path.resolve(argv[++i]);
        } else if (arg === '--no-screenshots') {
            args.screenshots = false;
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Number(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }

    return args;
}

function printHelp() {
    console.log(`Usage:
  node scripts/export-video-ui-preset.js --input <video.mp4> --output <out.mp4> [options]

Options:
  --page <dist html path>      Defaults to dist/video-preview.html
  --report <json path>         Defaults to <output-name>-ui-preset-report.json
  --markdown <md path>         Defaults to <output-name>-ui-preset-report.md
  --screenshot-dir <dir>       Defaults to the output directory
  --no-screenshots             Skip before/after page screenshots
  --timeout-ms <ms>            Defaults to 360000

This script uses the real UI path and clicks ${PRESET_BUTTON_SELECTOR}.
The preset is a relocated-anchor human-review candidate, not a default backend.
`);
}

async function blobUrlToBuffer(page) {
    const base64 = await page.evaluate(async () => {
        const link = document.getElementById('downloadBtn');
        if (!link?.href || link.getAttribute('aria-disabled') === 'true') {
            throw new Error('页面尚未生成可下载结果');
        }

        const blob = await fetch(link.href).then((response) => response.blob());
        const reader = new FileReader();
        return await new Promise((resolve, reject) => {
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
                const result = String(reader.result || '');
                resolve(result.includes(',') ? result.split(',')[1] : result);
            };
            reader.readAsDataURL(blob);
        });
    });

    return Buffer.from(base64, 'base64');
}

async function collectPresetState(page) {
    return await page.evaluate(() => {
        const valueOf = (id) => document.getElementById(id)?.value ?? '';
        const checkedOf = (id) => Boolean(document.getElementById(id)?.checked);
        const status = document.getElementById('status');
        return {
            denoiseBackend: valueOf('denoiseBackend'),
            edgeDenoiseStrength: Number(valueOf('edgeDenoiseStrength')),
            videoBitrateMbps: Number(valueOf('videoBitrateMbps')),
            allowLowConfidence: checkedOf('allowLowConfidence'),
            statusText: status?.textContent?.trim() || '',
            statusTone: status?.dataset?.tone || ''
        };
    });
}

async function clickPresetButton(page) {
    await page.evaluate((selector) => {
        document.querySelector(selector)?.click();
    }, PRESET_BUTTON_SELECTOR);
}

export function renderVideoUiPresetExportMarkdown(report) {
    const screenshots = report.screenshots || {};
    const lines = [
        '# Video UI Preset Export Report',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        '## Input',
        '',
        `- Page: ${report.pagePath}`,
        `- Input: ${report.inputPath}`,
        `- Output: ${report.outputPath}`,
        `- Bytes: ${report.bytes}`,
        '',
        '## UI Path',
        '',
        `- Preset button: ${report.presetButtonSelector}`,
        `- denoiseBackend: ${report.presetState?.denoiseBackend}`,
        `- edgeDenoiseStrength: ${report.presetState?.edgeDenoiseStrength}`,
        `- videoBitrateMbps: ${report.presetState?.videoBitrateMbps}`,
        `- allowLowConfidence: ${report.presetState?.allowLowConfidence}`,
        '',
        '## Result',
        '',
        `- Status tone: ${report.resultState?.statusTone}`,
        `- Status text: ${report.resultState?.statusText}`,
        `- Before screenshot: ${screenshots.before || '-'}`,
        `- After screenshot: ${screenshots.after || '-'}`
    ];

    return `${lines.join('\n')}\n`;
}

export async function exportVideoUiPreset({
    inputPath,
    outputPath,
    pagePath = DEFAULT_PAGE_PATH,
    reportPath = null,
    markdownPath = null,
    screenshotDir = null,
    screenshots = true,
    timeoutMs = 6 * 60 * 1000
}) {
    if (!inputPath) throw new Error('缺少 --input');
    if (!outputPath) throw new Error('缺少 --output');

    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedReportPath = reportPath
        ? path.resolve(reportPath)
        : defaultArtifactPath(resolvedOutputPath, '-ui-preset-report.json');
    const resolvedMarkdownPath = markdownPath
        ? path.resolve(markdownPath)
        : defaultArtifactPath(resolvedOutputPath, '-ui-preset-report.md');
    const resolvedScreenshotDir = screenshotDir
        ? path.resolve(screenshotDir)
        : path.dirname(resolvedOutputPath);
    const outputStem = path.parse(resolvedOutputPath).name;
    const beforeScreenshotPath = path.join(resolvedScreenshotDir, `${outputStem}-before-export.png`);
    const afterScreenshotPath = path.join(resolvedScreenshotDir, `${outputStem}-after-export.png`);

    const browser = await chromium.launch({ headless: true });
    try {
        return await withLocalStaticPreviewPage(pagePath, async (pageUrl) => {
            const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
            page.setDefaultTimeout(timeoutMs);
            await page.goto(pageUrl);
            await page.locator('#fileInput').setInputFiles(inputPath);
            await clickPresetButton(page);
            const presetState = await collectPresetState(page);

            if (screenshots) {
                await mkdir(resolvedScreenshotDir, { recursive: true });
                await page.screenshot({ path: beforeScreenshotPath, fullPage: true });
            }

            await page.locator('#processBtn').click();
            await page.waitForFunction(() => {
                const status = document.getElementById('status');
                return status?.dataset?.tone === 'success' || status?.dataset?.tone === 'error';
            }, null, { timeout: timeoutMs });

            const resultState = await collectPresetState(page);
            if (screenshots) {
                await page.screenshot({ path: afterScreenshotPath, fullPage: true });
            }
            if (resultState.statusTone !== 'success') {
                throw new Error(resultState.statusText || '视频导出失败');
            }

            const buffer = await blobUrlToBuffer(page);
            await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
            await writeFile(resolvedOutputPath, buffer);

            const report = {
                generatedAt: new Date().toISOString(),
                pagePath: isHttpUrl(pagePath) ? pagePath : path.resolve(pagePath),
                pageUrl,
                inputPath: path.resolve(inputPath),
                outputPath: resolvedOutputPath,
                reportPath: resolvedReportPath,
                markdownPath: resolvedMarkdownPath,
                presetButtonSelector: PRESET_BUTTON_SELECTOR,
                presetState,
                resultState,
                screenshots: screenshots
                    ? { before: beforeScreenshotPath, after: afterScreenshotPath }
                    : {},
                bytes: buffer.byteLength
            };

            await mkdir(path.dirname(resolvedReportPath), { recursive: true });
            await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
            await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
            await writeFile(resolvedMarkdownPath, renderVideoUiPresetExportMarkdown(report));

            return report;
        });
    } finally {
        await browser.close();
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    exportVideoUiPreset(args)
        .then((result) => {
            console.log(JSON.stringify(result, null, 2));
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
