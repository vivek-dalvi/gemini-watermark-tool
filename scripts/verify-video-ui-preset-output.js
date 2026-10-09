import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseTimestampList } from './render-video-crop-sheet.js';
import { exportVideoUiPreset } from './export-video-ui-preset.js';
import {
    createVideoOutputResidualReport,
    resolveVideoOutputResidualExitCode
} from './score-video-output-residual.js';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-ui-preset-verification');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function createSafeStem(inputPath) {
    const base = path.basename(inputPath || 'video', path.extname(inputPath || ''));
    return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'video';
}

export function resolveVideoUiPresetVerificationPaths({
    inputPath,
    outputDir = DEFAULT_OUTPUT_DIR,
    outputPath = null,
    reportPath = null,
    exportReportPath = null,
    exportMarkdownPath = null,
    residualReportPath = null
} = {}) {
    const resolvedOutputDir = path.resolve(outputDir || DEFAULT_OUTPUT_DIR);
    const stem = createSafeStem(inputPath);
    return {
        outputDir: resolvedOutputDir,
        outputPath: path.resolve(outputPath || path.join(resolvedOutputDir, `${stem}-ui-preset.mp4`)),
        reportPath: path.resolve(reportPath || path.join(resolvedOutputDir, `${stem}-verification.json`)),
        exportReportPath: path.resolve(exportReportPath || path.join(resolvedOutputDir, `${stem}-export-report.json`)),
        exportMarkdownPath: path.resolve(exportMarkdownPath || path.join(resolvedOutputDir, `${stem}-export-report.md`)),
        residualReportPath: path.resolve(residualReportPath || path.join(resolvedOutputDir, `${stem}-residual-report.json`))
    };
}

export function createVideoUiPresetVerificationSummary({
    inputPath,
    outputPath,
    exportReport,
    residualReport,
    reportPath = null
} = {}) {
    const verdict = residualReport?.verdict || {};
    return {
        generatedAt: new Date().toISOString(),
        status: verdict.action || 'unknown',
        inputPath: inputPath ? path.resolve(inputPath) : null,
        outputPath: outputPath ? path.resolve(outputPath) : null,
        reportPath: reportPath ? path.resolve(reportPath) : null,
        export: {
            outputPath: exportReport?.outputPath || null,
            bytes: exportReport?.bytes ?? null,
            statusTone: exportReport?.resultState?.statusTone || null,
            statusText: exportReport?.resultState?.statusText || null,
            preset: exportReport?.presetState || null,
            reportPath: exportReport?.reportPath || null,
            markdownPath: exportReport?.markdownPath || null
        },
        fixedAnchor: residualReport?.fixedAnchor || null,
        residual: {
            reportPath: residualReport?.outputPath || null,
            verdict,
            currentBestGridIgnoredForVerdict: residualReport?.currentBestGridIgnoredForVerdict || null
        }
    };
}

export function resolveVideoUiPresetVerificationExitCode(report, { failOnResidual = false } = {}) {
    return resolveVideoOutputResidualExitCode({
        verdict: report?.residual?.verdict
    }, { failOnResidual });
}

export function parseCliArgs(argv) {
    const parsed = {
        outputDir: DEFAULT_OUTPUT_DIR,
        timestamps: [...DEFAULT_TIMESTAMPS],
        screenshots: true,
        failOnResidual: false,
        gridLimit: 10,
        gridStep: 8,
        residualThresholds: {},
        timeoutMs: 6 * 60 * 1000
    };
    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--input' || arg === '--original' || arg === '--source') {
            parsed.inputPath = args.shift();
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift();
            continue;
        }
        if (arg === '--output-dir') {
            parsed.outputDir = args.shift() || parsed.outputDir;
            continue;
        }
        if (arg === '--report') {
            parsed.reportPath = args.shift();
            continue;
        }
        if (arg === '--export-report') {
            parsed.exportReportPath = args.shift();
            continue;
        }
        if (arg === '--export-markdown') {
            parsed.exportMarkdownPath = args.shift();
            continue;
        }
        if (arg === '--residual-report') {
            parsed.residualReportPath = args.shift();
            continue;
        }
        if (arg === '--page') {
            parsed.pagePath = args.shift();
            continue;
        }
        if (arg === '--timestamps') {
            parsed.timestamps = parseTimestampList(args.shift());
            continue;
        }
        if (arg === '--candidate-id') {
            parsed.candidateId = args.shift();
            continue;
        }
        if (arg === '--max-allowed-confidence') {
            parsed.residualThresholds.maxAllowedConfidence = toFiniteNumber(args.shift());
            continue;
        }
        if (arg === '--min-reduction-ratio') {
            parsed.residualThresholds.minReductionRatio = toFiniteNumber(args.shift());
            continue;
        }
        if (arg === '--min-original-confidence') {
            parsed.residualThresholds.minOriginalConfidence = toFiniteNumber(args.shift());
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
        if (arg === '--timeout-ms') {
            parsed.timeoutMs = toFiniteNumber(args.shift()) ?? parsed.timeoutMs;
            continue;
        }
        if (arg === '--no-screenshots') {
            parsed.screenshots = false;
            continue;
        }
        if (arg === '--fail-on-residual') {
            parsed.failOnResidual = true;
            continue;
        }
        if (!parsed.inputPath) {
            parsed.inputPath = arg;
        }
    }
    return parsed;
}

export async function verifyVideoUiPresetOutput({
    inputPath,
    outputPath = null,
    outputDir = DEFAULT_OUTPUT_DIR,
    reportPath = null,
    exportReportPath = null,
    exportMarkdownPath = null,
    residualReportPath = null,
    pagePath = undefined,
    timestamps = [...DEFAULT_TIMESTAMPS],
    candidateId = null,
    residualThresholds = {},
    gridLimit = 10,
    gridStep = 8,
    screenshots = true,
    timeoutMs = 6 * 60 * 1000
} = {}) {
    if (!inputPath) throw new Error('缺少 --input 视频路径');
    const paths = resolveVideoUiPresetVerificationPaths({
        inputPath,
        outputDir,
        outputPath,
        reportPath,
        exportReportPath,
        exportMarkdownPath,
        residualReportPath
    });

    const exportReport = await exportVideoUiPreset({
        inputPath,
        outputPath: paths.outputPath,
        pagePath,
        reportPath: paths.exportReportPath,
        markdownPath: paths.exportMarkdownPath,
        screenshotDir: paths.outputDir,
        screenshots,
        timeoutMs
    });
    const residualReport = await createVideoOutputResidualReport({
        originalPath: inputPath,
        currentPath: paths.outputPath,
        outputPath: paths.residualReportPath,
        timestamps,
        candidateId,
        thresholds: residualThresholds,
        gridLimit,
        gridStep
    });
    const summary = createVideoUiPresetVerificationSummary({
        inputPath,
        outputPath: paths.outputPath,
        reportPath: paths.reportPath,
        exportReport,
        residualReport
    });

    await mkdir(path.dirname(paths.reportPath), { recursive: true });
    await writeFile(paths.reportPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await verifyVideoUiPresetOutput(options);
    console.log(`report: ${report.reportPath}`);
    console.log(`output: ${report.outputPath}`);
    console.log(`fixedAnchor: ${report.fixedAnchor?.candidateId || 'none'}`);
    console.log(`original: ${report.residual.verdict.originalMeanConfidence?.toFixed(4) || '0.0000'}`);
    console.log(`current: ${report.residual.verdict.currentMeanConfidence?.toFixed(4) || '0.0000'}`);
    console.log(`reduction: ${((report.residual.verdict.reductionRatio || 0) * 100).toFixed(1)}%`);
    console.log(`verdict: ${report.status} (${report.residual.verdict.reason || 'unknown'})`);
    process.exitCode = resolveVideoUiPresetVerificationExitCode(report, {
        failOnResidual: options.failOnResidual
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
