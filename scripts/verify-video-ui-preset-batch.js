import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
    parseTimestampList,
    renderVideoCropSheet
} from './render-video-crop-sheet.js';
import { verifyVideoUiPresetOutput } from './verify-video-ui-preset-output.js';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-ui-preset-batch');
const DEFAULT_TIMESTAMPS = Object.freeze([1, 3, 5, 7, 9]);

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function createSafeId(inputPath) {
    const base = path.basename(inputPath || 'video', path.extname(inputPath || ''));
    return base.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'video';
}

function normalizeTimestampValue(value) {
    if (value == null) return null;
    return parseTimestampList(value);
}

export function normalizeBatchInputItems(items = []) {
    if (!Array.isArray(items)) {
        throw new Error('batch inputs must be an array');
    }

    return items.map((item) => {
        if (typeof item === 'string') {
            return {
                id: createSafeId(item),
                inputPath: item,
                timestamps: null
            };
        }

        if (!item || typeof item !== 'object') {
            throw new Error('batch input item must be a string or object');
        }

        const inputPath = item.inputPath || item.input || item.path;
        if (!inputPath) {
            throw new Error('batch input item is missing input/path');
        }

        const normalized = {
            id: item.id || createSafeId(inputPath),
            inputPath,
            timestamps: normalizeTimestampValue(item.timestamps)
        };

        if (item.candidateId) {
            normalized.candidateId = item.candidateId;
        }

        const residualThresholds = {
            ...(item.thresholds || {}),
            ...(item.residualThresholds || {})
        };
        if (Object.keys(residualThresholds).length > 0) {
            normalized.residualThresholds = residualThresholds;
        }

        return normalized;
    });
}

export function resolveVideoUiPresetBatchItemOptions(item, options = {}) {
    return {
        inputPath: item.inputPath,
        outputDir: path.join(path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR), item.id),
        pagePath: options.pagePath,
        timestamps: item.timestamps || options.timestamps || [...DEFAULT_TIMESTAMPS],
        candidateId: item.candidateId || options.candidateId || null,
        residualThresholds: {
            ...(options.residualThresholds || {}),
            ...(item.residualThresholds || {})
        },
        gridLimit: options.gridLimit,
        gridStep: options.gridStep,
        screenshots: options.screenshots,
        timeoutMs: options.timeoutMs
    };
}

export function shouldCreateVideoUiPresetReviewArtifact(report, { reviewOnFailure = false } = {}) {
    if (!reviewOnFailure) return false;
    return classifyReportStatus(report) !== 'pass';
}

export function resolveVideoUiPresetBatchReviewArtifactPath({
    outputDir = DEFAULT_OUTPUT_DIR,
    itemId
} = {}) {
    const safeId = createSafeId(itemId || 'video');
    return path.join(path.resolve(outputDir || DEFAULT_OUTPUT_DIR), safeId, `${safeId}-review-crops.png`);
}

function classifyReportStatus(report) {
    if (!report) return 'fail';
    if (report.status === 'pass') return 'pass';
    if (report.status === 'fail') return 'fail';
    return 'needs-review';
}

export function createVideoUiPresetBatchSummary({
    items = [],
    outputPath = null
} = {}) {
    const results = items.map((item) => {
        const report = item.report || {};
        const verdict = report.residual?.verdict || {};
        return {
            id: item.id,
            inputPath: item.inputPath ? path.resolve(item.inputPath) : null,
            reportPath: report.reportPath || null,
            outputPath: report.outputPath || null,
            status: classifyReportStatus(report),
            fixedAnchor: report.fixedAnchor?.candidateId || null,
            originalMeanConfidence: verdict.originalMeanConfidence ?? null,
            currentMeanConfidence: verdict.currentMeanConfidence ?? null,
            reductionRatio: verdict.reductionRatio ?? null,
            reviewArtifactPath: item.reviewArtifactPath || null
        };
    });

    const counts = {
        total: results.length,
        pass: results.filter((result) => result.status === 'pass').length,
        needsReview: results.filter((result) => result.status === 'needs-review').length,
        fail: results.filter((result) => result.status === 'fail').length
    };

    let status = 'empty';
    if (counts.fail > 0) {
        status = 'fail';
    } else if (counts.needsReview > 0) {
        status = 'needs-review';
    } else if (counts.pass === counts.total && counts.total > 0) {
        status = 'pass';
    }

    return {
        generatedAt: new Date().toISOString(),
        outputPath: outputPath ? path.resolve(outputPath) : null,
        status,
        counts,
        results
    };
}

export function parseCliArgs(argv) {
    const parsed = {
        inputPaths: [],
        manifestPath: null,
        outputDir: DEFAULT_OUTPUT_DIR,
        summaryPath: null,
        timestamps: [...DEFAULT_TIMESTAMPS],
        screenshots: true,
        reviewOnFailure: false,
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
            parsed.inputPaths.push(args.shift());
            continue;
        }
        if (arg === '--manifest') {
            parsed.manifestPath = args.shift();
            continue;
        }
        if (arg === '--output-dir') {
            parsed.outputDir = args.shift() || parsed.outputDir;
            continue;
        }
        if (arg === '--summary' || arg === '--report') {
            parsed.summaryPath = args.shift();
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
        if (arg === '--review-on-failure') {
            parsed.reviewOnFailure = true;
            continue;
        }
        if (arg === '--fail-on-residual') {
            parsed.failOnResidual = true;
            continue;
        }
        parsed.inputPaths.push(arg);
    }

    parsed.inputPaths = parsed.inputPaths.filter(Boolean);
    return parsed;
}

async function readManifestItems(manifestPath) {
    if (!manifestPath) return [];
    const body = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.inputs)) return parsed.inputs;
    if (Array.isArray(parsed.cases)) return parsed.cases;
    if (Array.isArray(parsed.videos)) return parsed.videos;
    throw new Error('manifest must be an array or contain inputs/cases/videos');
}

export async function verifyVideoUiPresetBatch(options = {}) {
    const outputDir = path.resolve(options.outputDir || DEFAULT_OUTPUT_DIR);
    const summaryPath = path.resolve(options.summaryPath || path.join(outputDir, 'latest-summary.json'));
    const manifestItems = await readManifestItems(options.manifestPath);
    const items = normalizeBatchInputItems([
        ...manifestItems,
        ...(options.inputPaths || [])
    ]);

    if (!items.length) {
        throw new Error('缺少 --input 或 --manifest');
    }

    const results = [];
    for (const item of items) {
        const itemOptions = resolveVideoUiPresetBatchItemOptions(item, {
            ...options,
            outputDir
        });
        const report = await verifyVideoUiPresetOutput(itemOptions);
        let reviewArtifactPath = null;
        if (shouldCreateVideoUiPresetReviewArtifact(report, options) && report.outputPath) {
            reviewArtifactPath = resolveVideoUiPresetBatchReviewArtifactPath({
                outputDir,
                itemId: item.id
            });
            await renderVideoCropSheet({
                originalPath: item.inputPath,
                currentPath: report.outputPath,
                outputPath: reviewArtifactPath,
                timestamps: itemOptions.timestamps,
                caseNote: item.id
            });
        }
        results.push({
            id: item.id,
            inputPath: item.inputPath,
            report,
            reviewArtifactPath
        });
    }

    const summary = createVideoUiPresetBatchSummary({
        items: results,
        outputPath: summaryPath
    });
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return summary;
}

export function resolveVideoUiPresetBatchExitCode(summary, { failOnResidual = false } = {}) {
    if (!failOnResidual) return 0;
    return summary?.status === 'pass' ? 0 : 1;
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const summary = await verifyVideoUiPresetBatch(options);
    console.log(`summary: ${summary.outputPath}`);
    console.log(`status: ${summary.status}`);
    console.log(`counts: ${summary.counts.pass}/${summary.counts.total} pass, ${summary.counts.needsReview} review, ${summary.counts.fail} fail`);
    for (const result of summary.results) {
        const original = result.originalMeanConfidence?.toFixed(4) || '0.0000';
        const current = result.currentMeanConfidence?.toFixed(4) || '0.0000';
        const reduction = ((result.reductionRatio || 0) * 100).toFixed(1);
        console.log(`${result.id}: ${result.status} ${result.fixedAnchor || 'none'} ${original} -> ${current} (${reduction}%)`);
        if (result.reviewArtifactPath) {
            console.log(`  review: ${result.reviewArtifactPath}`);
        }
    }
    process.exitCode = resolveVideoUiPresetBatchExitCode(summary, {
        failOnResidual: options.failOnResidual
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
