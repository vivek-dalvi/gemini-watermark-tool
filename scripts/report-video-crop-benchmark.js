import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_SUMMARY_PATH = path.resolve('.artifacts/video-crop-benchmark/latest-summary.json');
const DEFAULT_REPORT_PATH = path.resolve('.artifacts/video-crop-benchmark/latest-report.md');

function formatNumber(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatSigned(value, digits = 4) {
    if (!Number.isFinite(value)) return '-';
    const formatted = value.toFixed(digits);
    return value > 0 ? `+${formatted}` : formatted;
}

function formatBucket(bucket) {
    if (!bucket) return '-';
    return `${formatNumber(bucket.meanAbs)} / ${formatNumber(bucket.rms)}`;
}

function formatDelta(delta) {
    if (!delta) return '-';
    return `${formatSigned(delta.meanAbsDelta)} (${delta.verdict})`;
}

function formatRiskNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return '-';
    return notes.map((note) => note.code).join(', ');
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function buildOverallRecommendation(report) {
    const comparisons = Array.isArray(report.variantComparisons) ? report.variantComparisons : [];
    const compared = comparisons.filter((item) => item.status === 'compared');
    const canvasEdge = compared.filter((item) => item.currentProfile?.denoiseBackend === 'canvas-edge-denoise');
    const canvasEdgeBand = compared.filter((item) => item.currentProfile?.denoiseBackend === 'canvas-edge-band-denoise');
    const strength065 = canvasEdge.filter((item) => Number(item.currentProfile?.edgeDenoiseStrength) === 0.65);
    const strength100 = canvasEdge.filter((item) => Number(item.currentProfile?.edgeDenoiseStrength) === 1);
    const edgeBandByStrength = new Map();
    for (const item of canvasEdgeBand) {
        const strength = Number(item.currentProfile?.edgeDenoiseStrength);
        const key = Number.isFinite(strength) ? String(strength) : 'unknown';
        if (!edgeBandByStrength.has(key)) edgeBandByStrength.set(key, []);
        edgeBandByStrength.get(key).push(item);
    }
    const hasSafeEdgeBandStrength = [...edgeBandByStrength.values()].some((items) => items.length > 0 && items.every((item) =>
        !['active', 'edge', 'lowBody', 'highBody'].some((bucket) => item.deltas?.[bucket]?.verdict === 'regressed')
    ));
    const anyEdgeBandActiveRegress = canvasEdgeBand.some((item) => item.deltas?.active?.verdict === 'regressed');
    const anyEdgeBandBodyRegress = canvasEdgeBand.some((item) =>
        item.deltas?.lowBody?.verdict === 'regressed' ||
        item.deltas?.highBody?.verdict === 'regressed'
    );

    const allStrength065ImproveEdge = strength065.length > 0 &&
        strength065.every((item) => item.deltas?.edge?.verdict === 'improved');
    const anyStrength065ActiveRegress = strength065.some((item) => item.deltas?.active?.verdict === 'regressed');
    const anyStrength065BodyRegress = strength065.some((item) =>
        item.deltas?.lowBody?.verdict === 'regressed' ||
        item.deltas?.highBody?.verdict === 'regressed'
    );
    const anyStrength100Regress = strength100.some((item) =>
        ['active', 'edge', 'lowBody', 'highBody'].some((bucket) => item.deltas?.[bucket]?.verdict === 'regressed')
    );
    const hasOnlyWarningRegressions = (item) => {
        const warningBuckets = new Set((Array.isArray(item.riskNotes) ? item.riskNotes : [])
            .filter((note) => note?.severity === 'warning' && note.bucket)
            .map((note) => note.bucket));
        return ['active', 'edge', 'lowBody', 'highBody'].every((bucket) => {
            const verdict = item.deltas?.[bucket]?.verdict;
            return verdict !== 'regressed' || warningBuckets.has(bucket);
        });
    };
    const hasMaterialImprovement = (item) =>
        ['active', 'edge', 'lowBody', 'highBody'].some((bucket) => item.deltas?.[bucket]?.verdict === 'improved');
    const hasNoRegressions = (item) =>
        ['active', 'edge', 'lowBody', 'highBody'].every((bucket) => item.deltas?.[bucket]?.verdict !== 'regressed');
    const allComparedHaveNoRegressions = compared.length > 0 && compared.every(hasNoRegressions);
    const allComparedHaveOnlyWarningRegressions = compared.length > 0 && compared.every(hasOnlyWarningRegressions);
    const hasAnyMaterialImprovement = compared.some(hasMaterialImprovement);

    if (canvasEdgeBand.length > 0 && !hasSafeEdgeBandStrength && (anyEdgeBandActiveRegress || anyEdgeBandBodyRegress)) {
        return 'Canvas edge-band denoise did not survive video-level validation: no registered edge-band strength is regression-free across the benchmark set, despite the single-frame lab signal. Keep the default at `none`; treat edge-band as rejected until the mask is redesigned or validated with a stronger codec-aware path.';
    }

    if (allStrength065ImproveEdge && !anyStrength065ActiveRegress && anyStrength065BodyRegress) {
        return 'Canvas edge denoise 0.65 is a weak experimental candidate: edge residual improves, but body buckets still regress on at least one sample. Keep the default at `none` and prefer mask refinement or ML/WebGPU/WebNN denoise next.';
    }

    if (anyStrength100Regress) {
        return 'Canvas edge denoise strength 1.0 is not a safe default candidate. Keep it as a rejected/diagnostic branch.';
    }

    if (allComparedHaveNoRegressions && hasAnyMaterialImprovement) {
        return 'The best variant is regression-free on this benchmark set and improves at least one case. It is ready for visual review before default promotion.';
    }

    if (allComparedHaveOnlyWarningRegressions && hasAnyMaterialImprovement) {
        return 'The best variant is usable with warning-level risk: all material regressions are covered by risk notes, while at least one benchmark case improves. Review the linked sheets before promoting it as the default.';
    }

    return 'No variant has enough evidence to replace the current default. Keep `denoiseBackend=none` until a candidate improves edge residual without active/body regressions.';
}

export function renderVideoCropBenchmarkMarkdown(report) {
    const lines = [];
    const summary = report.summary || {};
    const results = Array.isArray(report.results) ? report.results : [];
    const comparisons = Array.isArray(report.variantComparisons) ? report.variantComparisons : [];

    lines.push('# Video Crop Benchmark Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt || '-'}`);
    lines.push(`Summary: rendered ${summary.rendered ?? '-'} / total ${summary.total ?? '-'}, failed ${summary.failed ?? '-'}`);
    lines.push(`Recommendation: ${buildOverallRecommendation(report)}`);
    lines.push('');

    lines.push('## Cases');
    lines.push('');
    lines.push('| Case | Backend | Strength | Status | Active meanAbs/RMS | Edge meanAbs/RMS | LowBody meanAbs/RMS | HighBody meanAbs/RMS | Sheet |');
    lines.push('|---|---:|---:|---|---:|---:|---:|---:|---|');
    for (const result of results) {
        const aggregate = result.residualMetrics?.aggregate || {};
        const profile = result.currentProfile || {};
        lines.push([
            escapeCell(result.id),
            escapeCell(profile.denoiseBackend || '-'),
            escapeCell(profile.edgeDenoiseStrength ?? '-'),
            escapeCell(result.status),
            escapeCell(formatBucket(aggregate.active)),
            escapeCell(formatBucket(aggregate.edge)),
            escapeCell(formatBucket(aggregate.lowBody)),
            escapeCell(formatBucket(aggregate.highBody)),
            escapeCell(result.outputPath || '-')
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');

    lines.push('## Variant Deltas');
    lines.push('');
    lines.push('| Variant | Baseline | Backend | Strength | Active Δ | Edge Δ | LowBody Δ | HighBody Δ | Notes |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|---|');
    for (const item of comparisons) {
        const profile = item.currentProfile || {};
        lines.push([
            escapeCell(item.variantId),
            escapeCell(item.baselineId || item.status),
            escapeCell(profile.denoiseBackend || '-'),
            escapeCell(profile.edgeDenoiseStrength ?? '-'),
            escapeCell(formatDelta(item.deltas?.active)),
            escapeCell(formatDelta(item.deltas?.edge)),
            escapeCell(formatDelta(item.deltas?.lowBody)),
            escapeCell(formatDelta(item.deltas?.highBody)),
            escapeCell(formatRiskNotes(item.riskNotes))
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');

    return `${lines.join('\n')}\n`;
}

export async function createVideoCropBenchmarkMarkdownReport({
    summaryPath = DEFAULT_SUMMARY_PATH,
    outputPath = DEFAULT_REPORT_PATH
} = {}) {
    const report = JSON.parse(await readFile(path.resolve(summaryPath), 'utf8'));
    const markdown = renderVideoCropBenchmarkMarkdown(report);
    const resolvedOutputPath = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, markdown, 'utf8');
    return {
        outputPath: resolvedOutputPath,
        markdown
    };
}

function parseCliArgs(argv) {
    const parsed = {
        summaryPath: DEFAULT_SUMMARY_PATH,
        outputPath: DEFAULT_REPORT_PATH
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--summary') {
            parsed.summaryPath = argv[++i] || parsed.summaryPath;
        } else if (arg === '--output') {
            parsed.outputPath = argv[++i] || parsed.outputPath;
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
  node scripts/report-video-crop-benchmark.js [--summary <latest-summary.json>] [--output <report.md>]
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    createVideoCropBenchmarkMarkdownReport(args)
        .then((result) => {
            console.log(`report: ${result.outputPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
