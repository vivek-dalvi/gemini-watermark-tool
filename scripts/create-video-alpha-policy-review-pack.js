import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { renderVideoComparisonGrid } from './render-video-comparison-grid.js';

const DEFAULT_MANIFEST_PATH = path.resolve('.artifacts/video-alpha-policy-12mbps-manifest.json');
const DEFAULT_EVIDENCE_REPORT_PATH = path.resolve('.artifacts/video-alpha-policy-evidence/latest-report.json');
const DEFAULT_ARTIFACT_ROOT = path.resolve('.artifacts/video-alpha-policy035-review');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json');
const DEFAULT_TEMPORAL_REPORT_PATH = path.resolve('.artifacts/video-alpha-policy035-review/temporal-residual/latest-report.json');
const ROI_PADDING = 28;
const ROI_SIZE = 200;

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

async function readJsonIfExists(filePath, fallback = null) {
    return existsSync(filePath) ? readJson(filePath) : fallback;
}

function normalizePath(filePath) {
    return path.resolve(filePath);
}

function caseBaseId(id = '') {
    return String(id)
        .replace(/-baseline(?:-12mbps)?$/, '')
        .replace(/-alpha-policy035(?:-12mbps)?$/, '');
}

function isBaselineCase(item = {}) {
    return /-baseline(?:-12mbps)?$/.test(item.id || '');
}

function isAlphaPolicyCase(item = {}) {
    return /-alpha-policy035(?:-12mbps)?$/.test(item.id || '');
}

function createRoiCropBox(expected = {}) {
    const anchor = expected.anchor || {};
    const x = Math.max(0, Math.round(Number(anchor.x) - ROI_PADDING));
    const y = Math.max(0, Math.round(Number(anchor.y) - ROI_PADDING));
    return {
        x,
        y,
        width: ROI_SIZE,
        height: ROI_SIZE
    };
}

export function createAlphaPolicyReviewJobs({
    manifest,
    artifactRoot = DEFAULT_ARTIFACT_ROOT
} = {}) {
    const cases = Array.isArray(manifest?.cases) ? manifest.cases : [];
    const baselineByBase = new Map(cases.filter(isBaselineCase).map((item) => [caseBaseId(item.id), item]));
    const variants = cases.filter(isAlphaPolicyCase);
    const jobs = [];

    for (const variant of variants) {
        const baseId = caseBaseId(variant.id);
        const baseline = baselineByBase.get(baseId);
        if (!baseline) continue;
        const inputs = [
            { label: 'original', path: normalizePath(variant.originalPath) },
            { label: 'baseline edge045', path: normalizePath(baseline.currentPath) },
            { label: 'policy035', path: normalizePath(variant.currentPath) },
            { label: 'allenk', path: normalizePath(variant.referencePath) }
        ];
        const comparisonDir = path.join(path.resolve(artifactRoot), 'comparison');
        const cropBox = createRoiCropBox(variant.expected || baseline.expected || {});
        jobs.push({
            caseId: baseId,
            kind: 'roi',
            cropBox,
            inputs,
            outputPath: path.join(comparisonDir, `${baseId}-roi-policy035-4up.mp4`)
        });
        jobs.push({
            caseId: baseId,
            kind: 'full',
            cropBox: null,
            inputs,
            outputPath: path.join(comparisonDir, `${baseId}-full-policy035-4up.mp4`)
        });
    }

    return jobs.sort((a, b) => {
        const caseOrder = a.caseId.localeCompare(b.caseId);
        if (caseOrder !== 0) return caseOrder;
        const kindOrder = { roi: 0, full: 1 };
        return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    });
}

function summarizeEvidence(evidence = null) {
    if (!evidence) return null;
    return {
        decision: evidence.decision || null,
        total: evidence.total || null,
        reportPath: evidence.outputPath || DEFAULT_EVIDENCE_REPORT_PATH
    };
}

function normalizeTemporalCase(item = {}) {
    const aggregate = item.aggregate || {};
    return {
        id: item.id || null,
        pairCount: Array.isArray(item.pairs) ? item.pairs.length : 0,
        pixelPairCount: aggregate.n ?? null,
        meanSameJitter: aggregate.meanSameJitter ?? null,
        meanMatchedJitter: aggregate.meanMatchedJitter ?? null,
        improvement: aggregate.improvement ?? null,
        meanMatchCost: aggregate.meanMatchCost ?? null,
        improvedRatio: aggregate.improvedRatio ?? null,
        worsenedRatio: aggregate.worsenedRatio ?? null,
        sheetPath: item.sheetPath ? path.resolve(item.sheetPath) : null,
        sourceSheetPath: item.sourceSheetPath ? path.resolve(item.sourceSheetPath) : null,
        cropBox: item.cropBox || null
    };
}

function summarizeTemporalReport({
    temporal = null,
    temporalReportPath = DEFAULT_TEMPORAL_REPORT_PATH
} = {}) {
    if (!temporal) {
        return {
            reportPath: null,
            markdownPath: null,
            generatedAt: null,
            matchRadius: null,
            includeVariants: false,
            cases: []
        };
    }
    const resolvedReportPath = path.resolve(temporalReportPath);
    return {
        reportPath: resolvedReportPath,
        markdownPath: resolvedReportPath.replace(/\.json$/i, '.md'),
        generatedAt: temporal.generatedAt || null,
        matchRadius: temporal.matchRadius ?? null,
        includeVariants: temporal.includeVariants === true,
        cases: (temporal.cases || []).map(normalizeTemporalCase)
    };
}

export function createAlphaPolicyReviewPack({
    jobs,
    evidence = null,
    temporal = null,
    temporalReportPath = DEFAULT_TEMPORAL_REPORT_PATH,
    artifactRoot = DEFAULT_ARTIFACT_ROOT
} = {}) {
    const comparisons = (jobs || []).map((job) => ({
        caseId: job.caseId,
        kind: job.kind,
        reportPath: `${path.resolve(job.outputPath)}.json`,
        markdownPath: `${path.resolve(job.outputPath)}.md`,
        outputPath: path.resolve(job.outputPath),
        cropBox: job.cropBox,
        inputs: job.inputs,
        probe: {
            exists: existsSync(job.outputPath),
            video: {
                frameRate: '24fps',
                duration: 10
            }
        }
    }));
    const evidenceSummary = summarizeEvidence(evidence);
    const temporalSummary = summarizeTemporalReport({ temporal, temporalReportPath });
    return {
        title: 'Video Alpha Policy 0.35 Review',
        subtitle: 'Compare baseline edge045 with policy035 12mbps candidates',
        generatedAt: new Date().toISOString(),
        source: 'video-alpha-policy035-review',
        evidenceReportPath: DEFAULT_EVIDENCE_REPORT_PATH,
        delivery: {
            status: 'review-only',
            ready: comparisons.length > 0 && comparisons.every((item) => item.probe.exists),
            blockers: comparisons.filter((item) => !item.probe.exists).map((item) => `missing-${item.caseId}-${item.kind}-video`),
            benchmark: {
                total: comparisons.length,
                rendered: comparisons.filter((item) => item.probe.exists).length,
                failed: comparisons.filter((item) => !item.probe.exists).length
            },
            bestCandidate: {
                profileLabel: 'alphaEdgePolicy=standard045-inset035',
                decision: evidenceSummary?.decision?.status || 'human-review',
                evidence: evidenceSummary
            }
        },
        temporal: temporalSummary,
        comparisons,
        decisionOptions: [
            { value: 'pending', label: 'Pending' },
            { value: 'prefer-current', label: 'Keep current 0.25' },
            { value: 'prefer-alpha-policy035', label: 'Prefer policy035' },
            { value: 'needs-more-polish', label: 'Needs more evidence' },
            { value: 'reject-both', label: 'Reject policy035' }
        ],
        checklist: [
            'ROI: policy035 visibly reduces residual compared with baseline edge045',
            'ROI: policy035 does not introduce a visible dark body or edge halo',
            'Full frame: policy035 does not look softer or more distracting than baseline edge045',
            'Temporal scan: policy035 is acceptable at 2s, 4s, 6s, and 8s',
            'Decision notes mention whether policy035 deserves a default-candidate review lane'
        ],
        artifactRoot: path.resolve(artifactRoot)
    };
}

export async function createVideoAlphaPolicyReviewPack({
    manifestPath = DEFAULT_MANIFEST_PATH,
    evidenceReportPath = DEFAULT_EVIDENCE_REPORT_PATH,
    temporalReportPath = DEFAULT_TEMPORAL_REPORT_PATH,
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    outputPath = DEFAULT_OUTPUT_PATH,
    skipRender = false
} = {}) {
    const manifest = await readJson(manifestPath);
    const evidence = await readJsonIfExists(evidenceReportPath, null);
    const temporal = await readJsonIfExists(temporalReportPath, null);
    const jobs = createAlphaPolicyReviewJobs({ manifest, artifactRoot });
    if (!skipRender) {
        for (const job of jobs) {
            await renderVideoComparisonGrid({
                inputs: job.inputs,
                cropBox: job.cropBox,
                outputPath: job.outputPath,
                tileWidth: job.kind === 'roi' ? 360 : 640,
                crf: 22,
                preset: 'medium'
            });
        }
    }
    const pack = createAlphaPolicyReviewPack({ jobs, evidence, temporal, temporalReportPath, artifactRoot });
    const resolvedOutputPath = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    return {
        outputPath: resolvedOutputPath,
        artifactRoot: path.resolve(artifactRoot),
        comparisons: pack.comparisons.length,
        temporalCases: pack.temporal.cases.length,
        ready: pack.delivery.ready,
        blockers: pack.delivery.blockers
    };
}

function parseArgs(argv) {
    const parsed = {
        manifestPath: DEFAULT_MANIFEST_PATH,
        evidenceReportPath: DEFAULT_EVIDENCE_REPORT_PATH,
        temporalReportPath: DEFAULT_TEMPORAL_REPORT_PATH,
        artifactRoot: DEFAULT_ARTIFACT_ROOT,
        outputPath: DEFAULT_OUTPUT_PATH,
        skipRender: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--manifest') {
            parsed.manifestPath = path.resolve(argv[++i] || DEFAULT_MANIFEST_PATH);
        } else if (arg === '--evidence') {
            parsed.evidenceReportPath = path.resolve(argv[++i] || DEFAULT_EVIDENCE_REPORT_PATH);
        } else if (arg === '--temporal') {
            parsed.temporalReportPath = path.resolve(argv[++i] || DEFAULT_TEMPORAL_REPORT_PATH);
        } else if (arg === '--artifact-root') {
            parsed.artifactRoot = path.resolve(argv[++i] || DEFAULT_ARTIFACT_ROOT);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--skip-render') {
            parsed.skipRender = true;
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
  node scripts/create-video-alpha-policy-review-pack.js [--skip-render] [--temporal <latest-report.json>]

Default output:
  .artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoAlphaPolicyReviewPack(args)
        .then((report) => {
            console.log(`json: ${report.outputPath}`);
            console.log(`videos: ${report.comparisons}`);
            console.log(`temporal cases: ${report.temporalCases}`);
            console.log(`ready: ${report.ready}`);
            if (report.blockers.length) console.log(`blockers: ${report.blockers.join(', ')}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
