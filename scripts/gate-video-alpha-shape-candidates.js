import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_FIT_SUMMARY_PATH = path.resolve('.artifacts/video-alpha-shape-fit/user-flaw-crops/latest-summary.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/video-alpha-shape-candidate-gate');
const DEFAULT_MIN_FIT_IMPROVEMENT = 0.02;
const DEFAULT_MAX_FIT_REGRESSION = 0.02;
const DEFAULT_TOP = 20;
const BENCHMARK_BUCKETS = Object.freeze(['active', 'edge', 'lowBody', 'highBody']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

function round4(value) {
    return Number.isFinite(value) ? Number(value.toFixed(4)) : null;
}

function formatSigned(value) {
    if (!Number.isFinite(value)) return '-';
    const fixed = value.toFixed(4);
    return value > 0 ? `+${fixed}` : fixed;
}

function compareCandidateByFit(a, b) {
    if (a.videoGate?.verdict !== b.videoGate?.verdict) {
        const order = {
            'candidate-visual-review': 0,
            'video-neutral': 1,
            'no-video-benchmark': 2,
            'rejected-video-regression': 3
        };
        return (order[a.videoGate?.verdict] ?? 9) - (order[b.videoGate?.verdict] ?? 9);
    }
    if (a.fitGate.verdict !== b.fitGate.verdict) {
        const order = { 'fit-pass': 0, 'fit-warning': 1, 'fit-reject': 2 };
        return (order[a.fitGate.verdict] ?? 9) - (order[b.fitGate.verdict] ?? 9);
    }
    return a.fitGate.meanDelta - b.fitGate.meanDelta;
}

function summarizeFitCases(candidateName, cases, {
    minFitImprovement = DEFAULT_MIN_FIT_IMPROVEMENT,
    maxFitRegression = DEFAULT_MAX_FIT_REGRESSION
} = {}) {
    const caseScores = cases.map((caseItem) => {
        const candidate = caseItem.candidates.get(candidateName);
        const delta = Number(candidate?.activeMeanAbs) - Number(caseItem.currentActiveMeanAbs);
        return {
            caseId: caseItem.id,
            currentActiveMeanAbs: round4(Number(caseItem.currentActiveMeanAbs)),
            activeMeanAbs: round4(Number(candidate?.activeMeanAbs)),
            delta: round4(delta),
            verdict: delta < -minFitImprovement
                ? 'improved'
                : delta > maxFitRegression
                    ? 'regressed'
                    : 'neutral'
        };
    });
    const deltas = caseScores.map((item) => item.delta).filter(Number.isFinite);
    const improvedCases = caseScores.filter((item) => item.verdict === 'improved').length;
    const regressedCases = caseScores.filter((item) => item.verdict === 'regressed').length;
    const meanDelta = deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : 0;
    const maxRegression = deltas.length ? Math.max(...deltas) : 0;
    const allImprove = improvedCases === caseScores.length && caseScores.length > 0;
    const noHardRegression = maxRegression <= maxFitRegression;
    const verdict = allImprove
        ? 'fit-pass'
        : meanDelta < -minFitImprovement && noHardRegression
            ? 'fit-warning'
            : 'fit-reject';

    return {
        verdict,
        cases: caseScores,
        improvedCases,
        regressedCases,
        meanDelta: round4(meanDelta),
        maxRegression: round4(maxRegression)
    };
}

function createNoBenchmarkGate() {
    return {
        verdict: 'no-video-benchmark',
        comparedCases: 0,
        regressions: [],
        improvements: []
    };
}

function normalizeBenchmarkGate(benchmarkSummary, { maxRegressions = 0 } = {}) {
    if (!isObject(benchmarkSummary)) {
        return createNoBenchmarkGate();
    }

    const comparisons = Array.isArray(benchmarkSummary.variantComparisons)
        ? benchmarkSummary.variantComparisons.filter((item) => item.status === 'compared')
        : [];
    const regressions = [];
    const improvements = [];

    for (const comparison of comparisons) {
        for (const bucket of BENCHMARK_BUCKETS) {
            const delta = comparison.deltas?.[bucket];
            if (!delta) continue;
            const record = {
                variantId: comparison.variantId,
                baselineId: comparison.baselineId,
                bucket,
                meanAbsDelta: round4(Number(delta.meanAbsDelta)),
                verdict: delta.verdict
            };
            if (delta.verdict === 'regressed') regressions.push(record);
            if (delta.verdict === 'improved') improvements.push(record);
        }
    }

    return {
        verdict: regressions.length > maxRegressions
            ? 'rejected-video-regression'
            : improvements.length > 0
                ? 'candidate-visual-review'
                : 'video-neutral',
        comparedCases: comparisons.length,
        regressions,
        improvements
    };
}

function normalizeCandidateBenchmarkSummaries(candidateBenchmarkSummaries = null) {
    if (candidateBenchmarkSummaries instanceof Map) {
        return candidateBenchmarkSummaries;
    }
    if (Array.isArray(candidateBenchmarkSummaries)) {
        return new Map(candidateBenchmarkSummaries);
    }
    if (isObject(candidateBenchmarkSummaries)) {
        return new Map(Object.entries(candidateBenchmarkSummaries));
    }
    return new Map();
}

export async function loadFitCandidateCases(fitSummaryPath = DEFAULT_FIT_SUMMARY_PATH) {
    const summaryPath = path.resolve(fitSummaryPath);
    const summary = await readJson(summaryPath);
    const outputDir = path.resolve(summary.outputDir || path.dirname(summaryPath));
    const reports = Array.isArray(summary.reports) ? summary.reports : [];

    const cases = [];
    for (const report of reports) {
        const allResultsPath = path.join(outputDir, report.id, 'all-results.json');
        let results = [];
        try {
            results = await readJson(allResultsPath);
        } catch {
            results = Array.isArray(report.top) ? report.top : [];
        }
        const candidates = new Map();
        for (const result of Array.isArray(results) ? results : []) {
            if (result?.name) candidates.set(result.name, result);
        }
        cases.push({
            id: report.id,
            currentActiveMeanAbs: report.current?.activeMeanAbs,
            candidates,
            allResultsPath
        });
    }

    return {
        summaryPath,
        outputDir,
        cases
    };
}

export function rankVideoAlphaShapeCandidates(cases, {
    benchmarkSummary = null,
    benchmarkCandidateName = null,
    candidateBenchmarkSummaries = null,
    minFitImprovement = DEFAULT_MIN_FIT_IMPROVEMENT,
    maxFitRegression = DEFAULT_MAX_FIT_REGRESSION,
    top = DEFAULT_TOP
} = {}) {
    const commonNames = cases.length
        ? [...cases[0].candidates.keys()].filter((name) =>
            cases.every((caseItem) => caseItem.candidates.has(name))
        )
        : [];
    const namedBenchmarkSummaries = normalizeCandidateBenchmarkSummaries(candidateBenchmarkSummaries);
    const hasNamedBenchmarks = namedBenchmarkSummaries.size > 0;
    const defaultVideoGate = normalizeBenchmarkGate(benchmarkSummary);
    let candidates = commonNames.map((name) => ({
        name,
        params: cases[0].candidates.get(name)?.params || {},
        fitGate: summarizeFitCases(name, cases, { minFitImprovement, maxFitRegression }),
        videoGate: namedBenchmarkSummaries.has(name)
            ? normalizeBenchmarkGate(namedBenchmarkSummaries.get(name))
            : hasNamedBenchmarks
                ? createNoBenchmarkGate()
                : benchmarkCandidateName && name !== benchmarkCandidateName
            ? createNoBenchmarkGate()
            : defaultVideoGate
    })).sort(compareCandidateByFit);
    if (hasNamedBenchmarks) {
        const pinnedNames = new Set(namedBenchmarkSummaries.keys());
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate]));
        candidates = [
            ...[...namedBenchmarkSummaries.keys()]
                .map((name) => byName.get(name))
                .filter(Boolean),
            ...candidates.filter((candidate) => !pinnedNames.has(candidate.name))
        ];
    }
    if (benchmarkCandidateName) {
        const targetIndex = candidates.findIndex((item) => item.name === benchmarkCandidateName);
        if (targetIndex > 0) {
            const [target] = candidates.splice(targetIndex, 1);
            candidates.unshift(target);
        }
    }

    const promoted = candidates.filter((item) =>
        item.fitGate.verdict !== 'fit-reject' &&
        item.videoGate.verdict === 'candidate-visual-review'
    );
    const rejectedByVideo = candidates.filter((item) => item.videoGate.verdict === 'rejected-video-regression');
    const targetCandidate = benchmarkCandidateName
        ? candidates.find((item) => item.name === benchmarkCandidateName)
        : null;

    return {
        totalCommonCandidates: commonNames.length,
        promotedCount: promoted.length,
        rejectedByVideoCount: rejectedByVideo.length,
        topCandidates: candidates.slice(0, top),
        recommendation: targetCandidate?.videoGate?.verdict === 'rejected-video-regression'
            ? 'Reject this alpha-shape branch: local fitting signal did not survive video-level benchmark gates.'
            : promoted.length > 0
            ? 'At least one alpha-shape candidate passed the available gates; send top candidates to visual review before changing defaults.'
            : defaultVideoGate.verdict === 'rejected-video-regression'
                ? 'Reject this alpha-shape branch: local fitting signal did not survive video-level benchmark gates.'
                : rejectedByVideo.length > 0
                    ? 'Video-validated alpha-shape candidates were rejected; keep the current default and benchmark any remaining fit-only candidates before visual review.'
                : 'No alpha-shape candidate has enough complete evidence to promote; fit-only candidates still need video benchmark validation.'
    };
}

export function renderVideoAlphaShapeGateMarkdown(report) {
    const lines = [];
    lines.push('# Video Alpha Shape Candidate Gate');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Fit summary: ${report.inputs.fitSummaryPath}`);
    lines.push(`Benchmark summary: ${report.inputs.benchmarkSummaryPath || '-'}`);
    if (Array.isArray(report.inputs.candidateBenchmarks) && report.inputs.candidateBenchmarks.length > 0) {
        for (const item of report.inputs.candidateBenchmarks) {
            lines.push(`Candidate benchmark: ${item.candidate} -> ${item.summaryPath}`);
        }
    }
    lines.push(`Recommendation: ${report.result.recommendation}`);
    lines.push('');
    lines.push('| Candidate | Fit Verdict | Mean Δ | Max Regression | Improved/Regressed | Video Gate | Video Regressions |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const candidate of report.result.topCandidates) {
        lines.push([
            candidate.name,
            candidate.fitGate.verdict,
            formatSigned(candidate.fitGate.meanDelta),
            formatSigned(candidate.fitGate.maxRegression),
            `${candidate.fitGate.improvedCases}/${candidate.fitGate.regressedCases}`,
            candidate.videoGate.verdict,
            String(candidate.videoGate.regressions.length)
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

export async function createVideoAlphaShapeCandidateGateReport({
    fitSummaryPath = DEFAULT_FIT_SUMMARY_PATH,
    benchmarkSummaryPath = null,
    outputDir = DEFAULT_OUTPUT_DIR,
    benchmarkCandidateName = null,
    candidateBenchmarkSpecs = [],
    minFitImprovement = DEFAULT_MIN_FIT_IMPROVEMENT,
    maxFitRegression = DEFAULT_MAX_FIT_REGRESSION,
    top = DEFAULT_TOP
} = {}) {
    const fit = await loadFitCandidateCases(fitSummaryPath);
    const benchmarkSummary = benchmarkSummaryPath ? await readJson(benchmarkSummaryPath) : null;
    const candidateBenchmarkSummaries = new Map();
    const resolvedCandidateBenchmarkSpecs = [];
    for (const spec of Array.isArray(candidateBenchmarkSpecs) ? candidateBenchmarkSpecs : []) {
        const candidate = spec?.candidate;
        const summaryPath = spec?.summaryPath ? path.resolve(spec.summaryPath) : null;
        if (!candidate || !summaryPath) continue;
        candidateBenchmarkSummaries.set(candidate, await readJson(summaryPath));
        resolvedCandidateBenchmarkSpecs.push({ candidate, summaryPath });
    }
    const result = rankVideoAlphaShapeCandidates(fit.cases, {
        benchmarkSummary,
        benchmarkCandidateName,
        candidateBenchmarkSummaries,
        minFitImprovement,
        maxFitRegression,
        top
    });
    const resolvedOutputDir = path.resolve(outputDir);
    const report = {
        generatedAt: new Date().toISOString(),
        inputs: {
            fitSummaryPath: fit.summaryPath,
            benchmarkSummaryPath: benchmarkSummaryPath ? path.resolve(benchmarkSummaryPath) : null,
            benchmarkCandidateName,
            candidateBenchmarks: resolvedCandidateBenchmarkSpecs,
            minFitImprovement,
            maxFitRegression,
            top
        },
        fitCases: fit.cases.map((caseItem) => ({
            id: caseItem.id,
            currentActiveMeanAbs: round4(Number(caseItem.currentActiveMeanAbs)),
            candidateCount: caseItem.candidates.size,
            allResultsPath: caseItem.allResultsPath
        })),
        result
    };
    const markdown = renderVideoAlphaShapeGateMarkdown(report);

    await mkdir(resolvedOutputDir, { recursive: true });
    const jsonPath = path.join(resolvedOutputDir, 'latest-report.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest-report.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, markdown, 'utf8');

    return {
        jsonPath,
        markdownPath,
        report,
        markdown
    };
}

function parseCliArgs(argv) {
    const parsed = {
        fitSummaryPath: DEFAULT_FIT_SUMMARY_PATH,
        benchmarkSummaryPath: null,
        outputDir: DEFAULT_OUTPUT_DIR,
        benchmarkCandidateName: null,
        candidateBenchmarkSpecs: [],
        minFitImprovement: DEFAULT_MIN_FIT_IMPROVEMENT,
        maxFitRegression: DEFAULT_MAX_FIT_REGRESSION,
        top: DEFAULT_TOP
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            continue;
        } else if (arg === '--fit-summary') {
            parsed.fitSummaryPath = argv[++i] || parsed.fitSummaryPath;
        } else if (arg === '--benchmark-summary') {
            parsed.benchmarkSummaryPath = argv[++i] || null;
        } else if (arg === '--candidate') {
            parsed.benchmarkCandidateName = argv[++i] || null;
        } else if (arg === '--candidate-benchmark') {
            const value = argv[++i] || '';
            const eq = value.indexOf('=');
            if (eq <= 0 || eq === value.length - 1) {
                throw new Error('Expected --candidate-benchmark <candidate>=<summary.json>');
            }
            parsed.candidateBenchmarkSpecs.push({
                candidate: value.slice(0, eq),
                summaryPath: value.slice(eq + 1)
            });
        } else if (arg === '--output-dir') {
            parsed.outputDir = argv[++i] || parsed.outputDir;
        } else if (arg === '--min-fit-improvement') {
            parsed.minFitImprovement = Number(argv[++i]);
        } else if (arg === '--max-fit-regression') {
            parsed.maxFitRegression = Number(argv[++i]);
        } else if (arg === '--top') {
            parsed.top = Number(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/gate-video-alpha-shape-candidates.js [options]

Options:
  --fit-summary <path>          fit-video-alpha-shape latest-summary.json
  --benchmark-summary <path>    optional video-crop-benchmark latest-summary.json
  --candidate <name>            candidate name that the benchmark summary validates
  --candidate-benchmark <name=path>
                                bind one candidate to one benchmark summary; repeatable
  --output-dir <path>           output directory
  --min-fit-improvement <n>     fit delta threshold for improvement
  --max-fit-regression <n>      fit delta threshold for regression
  --top <n>                     candidates to include in markdown/json
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    createVideoAlphaShapeCandidateGateReport(args)
        .then((result) => {
            console.log(`json: ${result.jsonPath}`);
            console.log(`report: ${result.markdownPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
