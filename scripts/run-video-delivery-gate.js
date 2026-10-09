import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runVideoCropBenchmark } from './video-crop-benchmark.js';
import { createVideoCropBenchmarkMarkdownReport } from './report-video-crop-benchmark.js';
import {
    createVideoDenoiseCandidateGateReport,
    renderVideoDenoiseCandidateGateMarkdown
} from './gate-video-denoise-candidates.js';

const DEFAULT_MANIFEST_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/benchmark-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-delivery-gate');
const DEFAULT_TEMPORAL_REPORT_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/temporal-residual/latest-report.json');
const DEFAULT_REQUIRED_DECISION = 'promote-default-candidate';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countByDecision(candidates = []) {
    const counts = {};
    for (const item of candidates) {
        const decision = item?.decision || 'unknown';
        counts[decision] = (counts[decision] || 0) + 1;
    }
    return counts;
}

function getBestCandidate(gateReport, requiredDecision = DEFAULT_REQUIRED_DECISION) {
    const candidates = Array.isArray(gateReport?.candidates) ? gateReport.candidates : [];
    return candidates.find((item) => item.decision === requiredDecision) || candidates[0] || null;
}

function formatMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : '-';
}

function inferTemporalBaselineId(caseId) {
    return String(caseId || '')
        .replace(/-auto-relocated$/i, '')
        .replace(/-boundary-gradient$/i, '')
        .replace(/-variant$/i, '');
}

function getTemporalAggregate(caseItem) {
    const aggregate = caseItem?.aggregate || {};
    return {
        meanSameJitter: Number(aggregate.meanSameJitter),
        meanMatchedJitter: Number(aggregate.meanMatchedJitter),
        improvement: Number(aggregate.improvement),
        improvedRatio: Number(aggregate.improvedRatio),
        worsenedRatio: Number(aggregate.worsenedRatio)
    };
}

function createTemporalDelta(variant, baseline) {
    const result = {};
    for (const key of ['meanSameJitter', 'meanMatchedJitter', 'improvement', 'improvedRatio', 'worsenedRatio']) {
        const next = Number(variant[key]);
        const prev = Number(baseline[key]);
        result[key] = Number.isFinite(next) && Number.isFinite(prev) ? next - prev : null;
    }
    return result;
}

function exceedsDelta(delta, baselineValue, { absolute, ratio }) {
    if (!Number.isFinite(delta) || delta <= 0) return false;
    const relativeThreshold = Math.abs(Number(baselineValue) || 0) * ratio;
    return delta > Math.max(absolute, relativeThreshold);
}

export function summarizeTemporalResidualReadiness(temporalReport = null) {
    if (!temporalReport) return null;

    const cases = Array.isArray(temporalReport.cases) ? temporalReport.cases : [];
    const byId = new Map(cases.map((caseItem) => [caseItem.id, caseItem]));
    const comparisons = [];
    const blockers = [];
    const warnings = [];

    for (const caseItem of cases) {
        const baselineId = inferTemporalBaselineId(caseItem.id);
        if (!baselineId || baselineId === caseItem.id) continue;
        const baselineCase = byId.get(baselineId);
        if (!baselineCase) continue;

        const baseline = getTemporalAggregate(baselineCase);
        const variant = getTemporalAggregate(caseItem);
        const delta = createTemporalDelta(variant, baseline);
        const material = [];
        const warning = [];

        if (exceedsDelta(delta.meanSameJitter, baseline.meanSameJitter, { absolute: 1, ratio: 0.1 })) {
            material.push('same-jitter-regression');
        } else if (exceedsDelta(delta.meanSameJitter, baseline.meanSameJitter, { absolute: 0.5, ratio: 0.05 })) {
            warning.push('same-jitter-warning');
        }

        if (exceedsDelta(delta.meanMatchedJitter, baseline.meanMatchedJitter, { absolute: 1, ratio: 0.1 })) {
            material.push('matched-jitter-regression');
        } else if (exceedsDelta(delta.meanMatchedJitter, baseline.meanMatchedJitter, { absolute: 0.5, ratio: 0.05 })) {
            warning.push('matched-jitter-warning');
        }

        if (Number.isFinite(delta.worsenedRatio) && delta.worsenedRatio > 0.05) {
            material.push('worsened-ratio-regression');
        } else if (Number.isFinite(delta.worsenedRatio) && delta.worsenedRatio > 0.02) {
            warning.push('worsened-ratio-warning');
        }

        if (material.length) blockers.push(`${caseItem.id}:${material.join('+')}`);
        if (warning.length) warnings.push(`${caseItem.id}:${warning.join('+')}`);

        comparisons.push({
            baselineId,
            candidateId: caseItem.id,
            baseline,
            candidate: variant,
            delta,
            material,
            warning
        });
    }

    if (!comparisons.length) blockers.push('video-temporal-no-baseline-comparisons');

    return {
        generatedAt: temporalReport.generatedAt || null,
        matchRadius: temporalReport.matchRadius ?? null,
        includeVariants: temporalReport.includeVariants === true,
        status: blockers.length ? 'blocked' : warnings.length ? 'warning' : 'pass',
        ready: blockers.length === 0,
        blockers,
        warnings,
        comparisons
    };
}

export function summarizeVideoDeliveryReadiness({
    benchmarkReport,
    gateReport,
    temporalReport = null,
    requiredDecision = DEFAULT_REQUIRED_DECISION,
    artifacts = {}
} = {}) {
    const benchmarkSummary = isObject(benchmarkReport?.summary) ? benchmarkReport.summary : {};
    const candidates = Array.isArray(gateReport?.candidates) ? gateReport.candidates : [];
    const bestCandidate = getBestCandidate(gateReport, requiredDecision);
    const temporal = summarizeTemporalResidualReadiness(temporalReport);
    const blockers = [];

    if (Number(benchmarkSummary.failed || 0) > 0) blockers.push('video-benchmark-failed-cases');
    if (Number(benchmarkSummary.renderedComparison || 0) <= 0) blockers.push('video-benchmark-no-comparisons');
    if (!candidates.length) blockers.push('video-gate-no-candidates');
    if (!candidates.some((item) => item.decision === requiredDecision)) {
        blockers.push(`video-gate-missing-${requiredDecision}`);
    }
    if (bestCandidate?.summary?.materialFailureLayers > 0) blockers.push('video-gate-material-failures');
    if (bestCandidate?.summary?.warningLayers > 0) blockers.push('video-gate-warning-layers');
    if (temporal?.blockers?.length) blockers.push('video-temporal-material-regression');

    return {
        generatedAt: new Date().toISOString(),
        status: blockers.length === 0 ? 'ready-for-visual-review' : 'blocked',
        ready: blockers.length === 0,
        requiredDecision,
        blockers,
        benchmark: {
            total: benchmarkSummary.total ?? null,
            rendered: benchmarkSummary.rendered ?? null,
            renderedComparison: benchmarkSummary.renderedComparison ?? null,
            failed: benchmarkSummary.failed ?? null
        },
        gate: {
            generatedAt: gateReport?.generatedAt || null,
            requiredLayerCount: gateReport?.requiredLayerCount ?? null,
            totalCandidates: candidates.length,
            decisionCounts: countByDecision(candidates),
            bestCandidate: bestCandidate
                ? {
                    profileLabel: bestCandidate.profileLabel,
                    decision: bestCandidate.decision,
                    layerCount: bestCandidate.summary?.layerCount ?? null,
                    improvedCases: bestCandidate.summary?.improvedCases ?? null,
                    materialFailureLayers: bestCandidate.summary?.materialFailureLayers ?? null,
                    warningLayers: bestCandidate.summary?.warningLayers ?? null
                }
                : null
        },
        temporal,
        artifacts
    };
}

export function renderVideoDeliveryReadinessMarkdown(report) {
    const lines = [];
    const best = report.gate?.bestCandidate;

    lines.push('# Video Delivery Gate');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Status: ${report.status}`);
    lines.push(`Ready: ${report.ready ? 'yes' : 'no'}`);
    lines.push(`Required decision: ${report.requiredDecision}`);
    lines.push(`Blockers: ${report.blockers.length ? report.blockers.join(', ') : '-'}`);
    lines.push('');
    lines.push('## Benchmark');
    lines.push('');
    lines.push('| Total | Rendered | Comparisons | Failed |');
    lines.push('|---:|---:|---:|---:|');
    lines.push(`| ${report.benchmark.total ?? '-'} | ${report.benchmark.rendered ?? '-'} | ${report.benchmark.renderedComparison ?? '-'} | ${report.benchmark.failed ?? '-'} |`);
    lines.push('');
    lines.push('## Gate');
    lines.push('');
    lines.push('| Candidate | Decision | Layers | Improved Cases | Material Fail Layers | Warning Layers |');
    lines.push('|---|---|---:|---:|---:|---:|');
    lines.push(best
        ? `| ${best.profileLabel} | ${best.decision} | ${best.layerCount ?? '-'} | ${best.improvedCases ?? '-'} | ${best.materialFailureLayers ?? '-'} | ${best.warningLayers ?? '-'} |`
        : '| - | - | - | - | - | - |');
    lines.push('');
    if (report.temporal) {
        lines.push('## Temporal Residual');
        lines.push('');
        lines.push(`Status: ${report.temporal.status}`);
        lines.push(`Blockers: ${report.temporal.blockers?.length ? report.temporal.blockers.join(', ') : '-'}`);
        lines.push(`Warnings: ${report.temporal.warnings?.length ? report.temporal.warnings.join(', ') : '-'}`);
        lines.push('');
        lines.push('| Candidate | Baseline | Same Δ | Matched Δ | Worsened Δ | Decision |');
        lines.push('|---|---|---:|---:|---:|---|');
        for (const item of report.temporal.comparisons || []) {
            const decision = item.material?.length
                ? `block: ${item.material.join('+')}`
                : item.warning?.length
                    ? `warn: ${item.warning.join('+')}`
                    : 'pass';
            lines.push(`| ${item.candidateId} | ${item.baselineId} | ${formatMetric(item.delta?.meanSameJitter)} | ${formatMetric(item.delta?.meanMatchedJitter)} | ${formatMetric(item.delta?.worsenedRatio)} | ${decision} |`);
        }
        lines.push('');
    }
    lines.push('## Artifacts');
    lines.push('');
    for (const [key, value] of Object.entries(report.artifacts || {})) {
        if (value == null) continue;
        lines.push(`- ${key}: \`${value}\``);
    }
    lines.push('');

    return `${lines.join('\n')}\n`;
}

export async function runVideoDeliveryGate({
    manifestPath = DEFAULT_MANIFEST_PATH,
    outputDir = DEFAULT_OUTPUT_DIR,
    temporalReportPath = DEFAULT_TEMPORAL_REPORT_PATH,
    requiredDecision = DEFAULT_REQUIRED_DECISION,
    requiredLayerCount = null,
    timestamps = null
} = {}) {
    const resolvedOutputDir = path.resolve(outputDir);
    const benchmarkDir = path.join(resolvedOutputDir, 'benchmark');
    const benchmarkSummaryPath = path.join(benchmarkDir, 'latest-summary.json');
    const benchmarkMarkdownPath = path.join(benchmarkDir, 'latest-report.md');
    const gateDir = path.join(resolvedOutputDir, 'gate');
    const gateJsonPath = path.join(gateDir, 'latest-report.json');
    const gateMarkdownPath = path.join(gateDir, 'latest-report.md');
    const deliveryJsonPath = path.join(resolvedOutputDir, 'latest-delivery-report.json');
    const deliveryMarkdownPath = path.join(resolvedOutputDir, 'latest-delivery-report.md');
    const resolvedTemporalReportPath = temporalReportPath ? path.resolve(temporalReportPath) : null;

    const benchmarkReport = await runVideoCropBenchmark({
        manifestPath,
        outputDir: benchmarkDir,
        summaryPath: benchmarkSummaryPath,
        timestamps
    });
    await createVideoCropBenchmarkMarkdownReport({
        summaryPath: benchmarkSummaryPath,
        outputPath: benchmarkMarkdownPath
    });

    const gateReport = createVideoDenoiseCandidateGateReport({
        reports: [{ report: benchmarkReport, reportPath: benchmarkSummaryPath }],
        requiredLayerCount
    });
    await mkdir(gateDir, { recursive: true });
    await writeFile(gateJsonPath, `${JSON.stringify(gateReport, null, 2)}\n`, 'utf8');
    await writeFile(gateMarkdownPath, renderVideoDenoiseCandidateGateMarkdown(gateReport), 'utf8');
    const temporalReport = resolvedTemporalReportPath && existsSync(resolvedTemporalReportPath)
        ? JSON.parse(await readFile(resolvedTemporalReportPath, 'utf8'))
        : null;

    const deliveryReport = summarizeVideoDeliveryReadiness({
        benchmarkReport,
        gateReport,
        temporalReport,
        requiredDecision,
        artifacts: {
            manifest: path.resolve(manifestPath),
            benchmarkSummary: benchmarkSummaryPath,
            benchmarkReport: benchmarkMarkdownPath,
            gateJson: gateJsonPath,
            gateMarkdown: gateMarkdownPath,
            temporalReport: temporalReport ? resolvedTemporalReportPath : null,
            deliveryJson: deliveryJsonPath,
            deliveryMarkdown: deliveryMarkdownPath
        }
    });
    await mkdir(resolvedOutputDir, { recursive: true });
    await writeFile(deliveryJsonPath, `${JSON.stringify(deliveryReport, null, 2)}\n`, 'utf8');
    await writeFile(deliveryMarkdownPath, renderVideoDeliveryReadinessMarkdown(deliveryReport), 'utf8');
    return deliveryReport;
}

function parseArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        requiredDecision: DEFAULT_REQUIRED_DECISION,
        requiredLayerCount: null,
        temporalReportPath: DEFAULT_TEMPORAL_REPORT_PATH,
        timestamps: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = path.resolve(argv[++i] || parsed.manifestPath);
        } else if (arg === '--output-dir') {
            parsed.outputDir = path.resolve(argv[++i] || parsed.outputDir);
        } else if (arg === '--required-decision') {
            parsed.requiredDecision = argv[++i] || parsed.requiredDecision;
        } else if (arg === '--required-layer-count') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value) && value > 0) parsed.requiredLayerCount = value;
        } else if (arg === '--temporal-report') {
            parsed.temporalReportPath = path.resolve(argv[++i] || DEFAULT_TEMPORAL_REPORT_PATH);
        } else if (arg === '--no-temporal-report') {
            parsed.temporalReportPath = null;
        } else if (arg === '--timestamps') {
            parsed.timestamps = argv[++i] || null;
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
  node scripts/run-video-delivery-gate.js [--manifest <manifest.json>] [--output-dir <dir>]

Options:
  --required-decision <decision>      Default: promote-default-candidate
  --required-layer-count <count>      Optional gate layer count
  --temporal-report <json>            Optional temporal residual report
  --no-temporal-report                Skip temporal residual gate
  --timestamps <list>                 Optional benchmark timestamps
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    runVideoDeliveryGate(args)
        .then((report) => {
            console.log(`status: ${report.status}`);
            console.log(`ready: ${report.ready ? 'yes' : 'no'}`);
            console.log(`report: ${report.artifacts.deliveryMarkdown}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
