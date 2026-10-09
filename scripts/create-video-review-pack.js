import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

const DEFAULT_DELIVERY_REPORT = path.resolve('.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json');
const DEFAULT_COMPARISON_DIR = path.resolve('.artifacts/video-boundary-gradient-auto/comparison');
const DEFAULT_SNAPSHOT_DIR = path.resolve('.artifacts/video-boundary-gradient-auto/review-snapshots');
const DEFAULT_TEMPORAL_REPORT = path.resolve('.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.md');
const DEFAULT_JSON_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json');

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function formatDuration(value) {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(3)}s` : '-';
}

function formatMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : '-';
}

function formatVideoProbe(probe) {
    if (!probe?.exists) return 'missing';
    const video = probe.video || {};
    return [
        video.width && video.height ? `${video.width}x${video.height}` : null,
        video.frameRate || null,
        formatDuration(video.duration)
    ].filter(Boolean).join(' / ');
}

function inferComparisonKind(reportPath, report = {}) {
    const raw = `${path.basename(reportPath || '')} ${report.outputPath || ''}`.toLowerCase();
    if (raw.includes('roi')) return 'roi';
    if (raw.includes('full')) return 'full';
    return report.cropBox ? 'roi' : 'full';
}

function inferCaseId(reportPath, report = {}) {
    const raw = path.basename(report.outputPath || reportPath || '', '.json')
        .replace(/\.mp4$/i, '');
    return raw
        .replace(/-(full|roi)-4up$/i, '')
        .replace(/-4up$/i, '');
}

function normalizeFrameRate(value) {
    if (typeof value !== 'string' || !value.includes('/')) return value || null;
    const [num, den] = value.split('/').map(Number);
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return value;
    const rate = num / den;
    return Number.isInteger(rate) ? `${rate}fps` : `${rate.toFixed(3)}fps`;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

async function readJsonIfExists(filePath) {
    const resolved = path.resolve(filePath);
    if (!existsSync(resolved)) return null;
    return readJson(resolved);
}

async function discoverDefaultComparisonReports(comparisonDir = DEFAULT_COMPARISON_DIR) {
    if (!existsSync(comparisonDir)) return [];
    const entries = await readdir(comparisonDir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.mp4.json'))
        .map((entry) => path.join(comparisonDir, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function discoverReviewSnapshots(snapshotDir = DEFAULT_SNAPSHOT_DIR) {
    const snapshots = new Map();
    if (!existsSync(snapshotDir)) return snapshots;
    const entries = await readdir(snapshotDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('-contact.png')) continue;
        const match = entry.name.match(/^(.+?)-(full|roi)-contact\.png$/);
        if (!match) continue;
        snapshots.set(`${match[1]}:${match[2]}`, path.join(snapshotDir, entry.name));
    }
    return snapshots;
}

async function probeVideo(videoPath) {
    const resolved = path.resolve(videoPath);
    if (!existsSync(resolved)) {
        return { path: resolved, exists: false, error: 'missing' };
    }
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,r_frame_rate,duration',
            '-show_entries', 'format=duration,size,bit_rate',
            '-of', 'json',
            resolved
        ], { windowsHide: true });
        const parsed = JSON.parse(stdout);
        const stream = parsed.streams?.[0] || {};
        return {
            path: resolved,
            exists: true,
            video: {
                width: Number(stream.width) || null,
                height: Number(stream.height) || null,
                frameRate: normalizeFrameRate(stream.r_frame_rate),
                duration: Number(stream.duration || parsed.format?.duration) || null
            },
            format: {
                duration: Number(parsed.format?.duration) || null,
                size: Number(parsed.format?.size) || null,
                bitRate: Number(parsed.format?.bit_rate) || null
            },
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: true,
            video: null,
            format: null,
            error: error?.message || String(error)
        };
    }
}

export async function createVideoReviewPack({
    deliveryReportPath = DEFAULT_DELIVERY_REPORT,
    comparisonReportPaths = null,
    snapshotDir = DEFAULT_SNAPSHOT_DIR,
    temporalReportPath = DEFAULT_TEMPORAL_REPORT,
    outputPath = DEFAULT_OUTPUT_PATH,
    jsonPath = DEFAULT_JSON_PATH
} = {}) {
    const resolvedDeliveryReportPath = path.resolve(deliveryReportPath);
    const delivery = await readJson(resolvedDeliveryReportPath);
    const resolvedComparisonReportPaths = Array.isArray(comparisonReportPaths) && comparisonReportPaths.length
        ? comparisonReportPaths.map((item) => path.resolve(item))
        : await discoverDefaultComparisonReports();
    const snapshots = await discoverReviewSnapshots(snapshotDir);
    const temporalReport = await readJsonIfExists(temporalReportPath);
    const comparisons = [];

    for (const reportPath of resolvedComparisonReportPaths) {
        const report = await readJson(reportPath);
        const probe = await probeVideo(report.outputPath);
        const caseId = inferCaseId(reportPath, report);
        const kind = inferComparisonKind(reportPath, report);
        comparisons.push({
            caseId,
            kind,
            reportPath: path.resolve(reportPath),
            outputPath: path.resolve(report.outputPath),
            snapshotPath: snapshots.get(`${caseId}:${kind}`) || null,
            cropBox: report.cropBox || null,
            inputs: report.inputs || [],
            probe
        });
    }

    comparisons.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.kind.localeCompare(b.kind));
    const reviewPack = {
        generatedAt: new Date().toISOString(),
        deliveryReportPath: resolvedDeliveryReportPath,
        delivery: {
            status: delivery.status || null,
            ready: delivery.ready === true,
            blockers: delivery.blockers || [],
            benchmark: delivery.benchmark || {},
            bestCandidate: delivery.gate?.bestCandidate || null
        },
        temporal: temporalReport ? {
            reportPath: path.resolve(temporalReportPath),
            markdownPath: path.join(path.dirname(path.resolve(temporalReportPath)), 'latest-report.md'),
            generatedAt: temporalReport.generatedAt || null,
            matchRadius: temporalReport.matchRadius ?? null,
            includeVariants: temporalReport.includeVariants === true,
            cases: (temporalReport.cases || []).map((item) => ({
                id: item.id,
                sheetPath: item.sheetPath || null,
                sourceSheetPath: item.sourceSheetPath || null,
                pairCount: item.pairs?.length || 0,
                meanSameJitter: item.aggregate?.meanSameJitter ?? null,
                meanMatchedJitter: item.aggregate?.meanMatchedJitter ?? null,
                improvement: item.aggregate?.improvement ?? null,
                meanMatchCost: item.aggregate?.meanMatchCost ?? null,
                improvedRatio: item.aggregate?.improvedRatio ?? null,
                worsenedRatio: item.aggregate?.worsenedRatio ?? null
            }))
        } : null,
        comparisons,
        checklist: [
            'ROI 4-up: auto boundary 面板中不应有明显星形残影、亮/暗边框或突兀色块。',
            'Full 4-up: 水印区域外不应出现可见全局损伤或色彩跳变。',
            'Temporal: 拖动 0s 到 10s，水印区域不应有明显闪烁、跳动或局部纹理呼吸。',
            'Sentinel: 标准锚点样例仍应保持 denoiseBackend=none，不应误套 relocated preset。',
            'Decision: 若 ROI 可接受且 full-frame 无副作用，可把当前 preset 进入默认策略复核。'
        ]
    };

    await mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await writeFile(path.resolve(jsonPath), `${JSON.stringify(reviewPack, null, 2)}\n`, 'utf8');
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(path.resolve(outputPath), renderVideoReviewPackMarkdown(reviewPack), 'utf8');
    return {
        ...reviewPack,
        outputPath: path.resolve(outputPath),
        jsonPath: path.resolve(jsonPath)
    };
}

export function renderVideoReviewPackMarkdown(reviewPack) {
    const lines = [];
    const best = reviewPack.delivery?.bestCandidate || {};

    lines.push('# Video Review Pack');
    lines.push('');
    lines.push(`Generated: ${reviewPack.generatedAt}`);
    lines.push(`Delivery status: ${reviewPack.delivery?.status || '-'}`);
    lines.push(`Ready: ${reviewPack.delivery?.ready ? 'yes' : 'no'}`);
    lines.push(`Blockers: ${reviewPack.delivery?.blockers?.length ? reviewPack.delivery.blockers.join(', ') : '-'}`);
    lines.push(`Best candidate: ${best.profileLabel || '-'} (${best.decision || '-'})`);
    if (reviewPack.temporal) {
        lines.push(`Temporal report: ${reviewPack.temporal.reportPath}`);
    }
    lines.push('');
    lines.push('## Videos');
    lines.push('');
    lines.push('| Case | View | Media | Video | Snapshot |');
    lines.push('|---|---|---|---|---|');
    for (const item of reviewPack.comparisons || []) {
        lines.push([
            escapeCell(item.caseId),
            escapeCell(item.kind),
            escapeCell(formatVideoProbe(item.probe)),
            escapeCell(item.outputPath),
            escapeCell(item.snapshotPath || '-')
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    if (reviewPack.temporal) {
        lines.push('');
        lines.push('## Temporal Residual');
        lines.push('');
        lines.push(`Generated: ${reviewPack.temporal.generatedAt || '-'}`);
        lines.push(`Match radius: \`${reviewPack.temporal.matchRadius ?? '-'}\`, include variants: \`${reviewPack.temporal.includeVariants ? 'yes' : 'no'}\``);
        lines.push('');
        lines.push('| Case | Pairs | Same jitter | Matched jitter | Improvement | Improved/Worsened | Sheet |');
        lines.push('|---|---:|---:|---:|---:|---:|---|');
        for (const item of reviewPack.temporal.cases || []) {
            lines.push([
                escapeCell(item.id),
                escapeCell(item.pairCount),
                escapeCell(formatMetric(item.meanSameJitter)),
                escapeCell(formatMetric(item.meanMatchedJitter)),
                escapeCell(formatMetric(item.improvement)),
                escapeCell(`${formatMetric(item.improvedRatio)} / ${formatMetric(item.worsenedRatio)}`),
                escapeCell(item.sheetPath || '-')
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }
    }
    lines.push('');
    lines.push('## Inputs');
    lines.push('');
    for (const item of reviewPack.comparisons || []) {
        lines.push(`### ${item.caseId} ${item.kind}`);
        lines.push('');
        lines.push('| Label | Path |');
        lines.push('|---|---|');
        for (const input of item.inputs || []) {
            lines.push(`| ${escapeCell(input.label)} | ${escapeCell(input.path)} |`);
        }
        if (item.cropBox) {
            const crop = item.cropBox;
            lines.push('');
            lines.push(`Crop: \`${crop.x},${crop.y},${crop.width},${crop.height}\``);
        }
        lines.push('');
    }
    lines.push('## Checklist');
    lines.push('');
    for (const item of reviewPack.checklist || []) {
        lines.push(`- [ ] ${item}`);
    }
    lines.push('');
    lines.push('## Evidence');
    lines.push('');
    lines.push(`- Delivery report: \`${reviewPack.deliveryReportPath}\``);
    if (reviewPack.temporal) {
        lines.push(`- Temporal report: \`${reviewPack.temporal.reportPath}\``);
        lines.push(`- Temporal markdown: \`${reviewPack.temporal.markdownPath}\``);
    }
    lines.push(`- Benchmark: total \`${reviewPack.delivery?.benchmark?.total ?? '-'}\`, rendered \`${reviewPack.delivery?.benchmark?.rendered ?? '-'}\`, failed \`${reviewPack.delivery?.benchmark?.failed ?? '-'}\``);
    lines.push(`- Gate: material fail layers \`${best.materialFailureLayers ?? '-'}\`, warning layers \`${best.warningLayers ?? '-'}\`, improved cases \`${best.improvedCases ?? '-'}\``);
    lines.push('');

    return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
    const parsed = {
        deliveryReportPath: DEFAULT_DELIVERY_REPORT,
        comparisonReportPaths: [],
        outputPath: DEFAULT_OUTPUT_PATH,
        jsonPath: DEFAULT_JSON_PATH,
        temporalReportPath: DEFAULT_TEMPORAL_REPORT
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--delivery-report') {
            parsed.deliveryReportPath = path.resolve(argv[++i] || parsed.deliveryReportPath);
        } else if (arg === '--comparison-report') {
            parsed.comparisonReportPaths.push(path.resolve(argv[++i]));
        } else if (arg === '--snapshot-dir') {
            parsed.snapshotDir = path.resolve(argv[++i] || DEFAULT_SNAPSHOT_DIR);
        } else if (arg === '--temporal-report') {
            parsed.temporalReportPath = path.resolve(argv[++i] || DEFAULT_TEMPORAL_REPORT);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || parsed.outputPath);
        } else if (arg === '--json') {
            parsed.jsonPath = path.resolve(argv[++i] || parsed.jsonPath);
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
  node scripts/create-video-review-pack.js [--delivery-report <json>] [--comparison-report <json>] [--temporal-report <json>] [--output <md>]

When no --comparison-report is provided, the script scans:
  .artifacts/video-boundary-gradient-auto/comparison/*.mp4.json
When the temporal report exists, it is summarized from:
  .artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    const comparisonReportPaths = args.comparisonReportPaths.length ? args.comparisonReportPaths : null;
    createVideoReviewPack({ ...args, comparisonReportPaths })
        .then((report) => {
            console.log(`review: ${report.outputPath}`);
            console.log(`json: ${report.jsonPath}`);
            console.log(`videos: ${report.comparisons.length}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
