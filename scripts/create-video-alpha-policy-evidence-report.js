import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPORT_PATHS = [
    '.artifacts/video-crop-benchmark-alpha-policy035-standard/latest-summary.json',
    '.artifacts/video-crop-benchmark-alpha-policy035-12mbps/latest-summary.json',
    '.artifacts/video-crop-benchmark-alpha-policy035-standard-candidate-aware/latest-summary.json',
    '.artifacts/video-crop-benchmark-alpha-policy035-12mbps-candidate-aware/latest-summary.json',
    '.artifacts/video-crop-benchmark-alpha-policy035-standard-expected-aware/latest-summary.json',
    '.artifacts/video-crop-benchmark-alpha-policy035-12mbps-expected-aware/latest-summary.json'
];
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-alpha-policy-evidence/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-alpha-policy-evidence/latest-report.md');
const BUCKETS = Object.freeze(['active', 'edge', 'lowBody', 'highBody']);

function classifyReportPath(reportPath) {
    const normalized = reportPath.replaceAll('\\', '/');
    return {
        bitrate: normalized.includes('12mbps') ? '12mbps' : 'standard',
        awareness: normalized.includes('candidate-aware')
            ? 'candidate-aware'
            : normalized.includes('expected-aware')
                ? 'expected-aware'
                : 'raw'
    };
}

function warningBuckets(riskNotes = []) {
    return new Set((Array.isArray(riskNotes) ? riskNotes : [])
        .filter((item) => item?.severity === 'warning' && item.bucket)
        .map((item) => item.bucket));
}

function summarizeComparison(item = {}) {
    const warnings = warningBuckets(item.riskNotes);
    const improvedBuckets = [];
    const materialRegressedBuckets = [];
    const warningRegressedBuckets = [];
    const neutralBuckets = [];

    for (const bucket of BUCKETS) {
        const verdict = item.deltas?.[bucket]?.verdict || 'missing';
        if (verdict === 'improved') improvedBuckets.push(bucket);
        else if (verdict === 'regressed' && warnings.has(bucket)) warningRegressedBuckets.push(bucket);
        else if (verdict === 'regressed') materialRegressedBuckets.push(bucket);
        else neutralBuckets.push(bucket);
    }

    return {
        baselineId: item.baselineId || null,
        variantId: item.variantId || null,
        profile: item.currentProfile || {},
        status: item.status || null,
        improvedBuckets,
        materialRegressedBuckets,
        warningRegressedBuckets,
        neutralBuckets,
        riskNotes: item.riskNotes || [],
        deltas: item.deltas || {}
    };
}

function summarizeReport(report, reportPath) {
    const kind = classifyReportPath(reportPath);
    const cases = (Array.isArray(report.variantComparisons) ? report.variantComparisons : [])
        .filter((item) => item.status === 'compared')
        .map(summarizeComparison);
    return {
        path: path.resolve(reportPath),
        generatedAt: report.generatedAt || null,
        ...kind,
        cases,
        summary: {
            comparedCases: cases.length,
            improvedCases: cases.filter((item) => item.improvedBuckets.length > 0).length,
            materialRegressedCases: cases.filter((item) => item.materialRegressedBuckets.length > 0).length,
            warningRegressedCases: cases.filter((item) => item.warningRegressedBuckets.length > 0).length
        }
    };
}

function createDecision(reports) {
    const awareReports = reports.filter((item) => item.awareness !== 'raw');
    const rawReports = reports.filter((item) => item.awareness === 'raw');
    const awareMaterial = awareReports.reduce((sum, item) => sum + item.summary.materialRegressedCases, 0);
    const rawMaterial = rawReports.reduce((sum, item) => sum + item.summary.materialRegressedCases, 0);
    const warningCases = reports.reduce((sum, item) => sum + item.summary.warningRegressedCases, 0);
    const improvedCases = reports.reduce((sum, item) => sum + item.summary.improvedCases, 0);
    const comparedCases = reports.reduce((sum, item) => sum + item.summary.comparedCases, 0);
    const hasStandard = reports.some((item) => item.bitrate === 'standard');
    const hasHighBitrate = reports.some((item) => item.bitrate === '12mbps');
    const hasAwareEvidence = awareReports.length > 0;

    if (awareMaterial > 0) {
        return {
            status: 'reject',
            reason: 'candidate-or-expected-aware-reports-still-have-material-regression'
        };
    }
    if (rawMaterial > 0 && hasAwareEvidence) {
        return {
            status: 'candidate-aware-human-review',
            reason: 'raw-benchmark-has-material-regression-but-aware-benchmarks-downgrade-or-clear-it'
        };
    }
    if (!hasStandard || !hasHighBitrate || comparedCases === 0) {
        return {
            status: 'insufficient-evidence',
            reason: 'missing-standard-or-high-bitrate-evidence'
        };
    }
    if (warningCases > 0) {
        return {
            status: 'human-review',
            reason: 'only-warning-level-regressions-remain'
        };
    }
    if (improvedCases > 0) {
        return {
            status: 'regression-free-human-review',
            reason: 'benchmark-evidence-shows-improvement-without-regression'
        };
    }
    return {
        status: 'insufficient-improvement',
        reason: 'no-material-regression-but-no-clear-improvement'
    };
}

export function createVideoAlphaPolicyEvidenceSummary({ reports } = {}) {
    const normalizedReports = Array.isArray(reports) ? reports : [];
    const decision = createDecision(normalizedReports);
    const total = normalizedReports.reduce((acc, item) => {
        acc.comparedCases += item.summary.comparedCases;
        acc.improvedCases += item.summary.improvedCases;
        acc.materialRegressedCases += item.summary.materialRegressedCases;
        acc.warningRegressedCases += item.summary.warningRegressedCases;
        return acc;
    }, {
        reports: normalizedReports.length,
        comparedCases: 0,
        improvedCases: 0,
        materialRegressedCases: 0,
        warningRegressedCases: 0
    });
    return {
        generatedAt: new Date().toISOString(),
        candidate: 'alphaEdgePolicy=standard045-inset035',
        decision,
        total,
        reports: normalizedReports
    };
}

function escapeCell(value) {
    return String(value ?? '-').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function formatBuckets(buckets = []) {
    return buckets.length ? buckets.join(', ') : '-';
}

export function renderVideoAlphaPolicyEvidenceMarkdown(report) {
    const lines = [];
    lines.push('# Video Alpha Policy Evidence Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Candidate: ${report.candidate}`);
    lines.push(`Decision: ${report.decision.status}`);
    lines.push(`Reason: ${report.decision.reason}`);
    lines.push('');
    lines.push('| Reports | Compared cases | Improved | Material regressions | Warning regressions |');
    lines.push('|---:|---:|---:|---:|---:|');
    lines.push(`| ${report.total.reports} | ${report.total.comparedCases} | ${report.total.improvedCases} | ${report.total.materialRegressedCases} | ${report.total.warningRegressedCases} |`);
    lines.push('');
    lines.push('## Reports');
    lines.push('');
    lines.push('| Report | Bitrate | Awareness | Cases | Improved | Material | Warning |');
    lines.push('|---|---|---|---:|---:|---:|---:|');
    for (const item of report.reports) {
        lines.push(`| ${escapeCell(item.path)} | ${escapeCell(item.bitrate)} | ${escapeCell(item.awareness)} | ${item.summary.comparedCases} | ${item.summary.improvedCases} | ${item.summary.materialRegressedCases} | ${item.summary.warningRegressedCases} |`);
    }
    lines.push('');
    lines.push('## Cases');
    lines.push('');
    lines.push('| Report | Case | Variant | Improved | Material regressions | Warning regressions |');
    lines.push('|---|---|---|---|---|---|');
    for (const reportItem of report.reports) {
        const reportLabel = `${reportItem.bitrate}/${reportItem.awareness}`;
        for (const item of reportItem.cases) {
            lines.push(`| ${escapeCell(reportLabel)} | ${escapeCell(item.baselineId)} | ${escapeCell(item.variantId)} | ${escapeCell(formatBuckets(item.improvedBuckets))} | ${escapeCell(formatBuckets(item.materialRegressedBuckets))} | ${escapeCell(formatBuckets(item.warningRegressedBuckets))} |`);
        }
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function readReports(paths) {
    const reports = [];
    for (const reportPath of paths) {
        const resolved = path.resolve(reportPath);
        const report = JSON.parse(await readFile(resolved, 'utf8'));
        reports.push(summarizeReport(report, resolved));
    }
    return reports;
}

export async function writeVideoAlphaPolicyEvidenceReport({
    reportPaths = DEFAULT_REPORT_PATHS,
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH
} = {}) {
    const reports = await readReports(reportPaths);
    const result = createVideoAlphaPolicyEvidenceSummary({ reports });
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedMarkdownPath = path.resolve(markdownPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(resolvedMarkdownPath, renderVideoAlphaPolicyEvidenceMarkdown(result), 'utf8');
    return {
        ...result,
        outputPath: resolvedOutputPath,
        markdownPath: resolvedMarkdownPath
    };
}

function parseArgs(argv) {
    const parsed = {
        reportPaths: DEFAULT_REPORT_PATHS,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--reports') {
            parsed.reportPaths = String(argv[++i] || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(argv[++i] || DEFAULT_MARKDOWN_PATH);
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
  node scripts/create-video-alpha-policy-evidence-report.js [--reports a.json,b.json]

Default output:
  .artifacts/video-alpha-policy-evidence/latest-report.json
  .artifacts/video-alpha-policy-evidence/latest-report.md
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    writeVideoAlphaPolicyEvidenceReport(args)
        .then((report) => {
            console.log(`decision: ${report.decision.status}`);
            console.log(`reason: ${report.decision.reason}`);
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
