import path from 'node:path';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve('.artifacts/video-frame-backend-lab');

function formatNumber(value, digits = 4) {
    return Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function formatSigned(value, digits = 4) {
    if (!Number.isFinite(value)) return '-';
    const formatted = value.toFixed(digits);
    return value > 0 ? `+${formatted}` : formatted;
}

function profileLabel(profile = {}) {
    const parts = [profile.denoiseBackend || 'unknown'];
    if (Number.isFinite(profile.edgeDenoiseStrength)) {
        parts.push(`edge=${profile.edgeDenoiseStrength}`);
    }
    if (Number.isFinite(profile.residualCleanupStrength)) {
        parts.push(`cleanup=${profile.residualCleanupStrength}`);
    }
    return parts.join(' ');
}

function tallyBucketVerdicts(cases) {
    const totals = {
        improved: 0,
        regressed: 0,
        neutral: 0,
        edgeImprovement: 0,
        activeImprovement: 0,
        bodyRegression: 0,
        maxRegression: 0
    };

    for (const item of cases) {
        for (const bucket of ['active', 'edge', 'lowBody', 'highBody']) {
            const delta = item.deltas?.[bucket];
            if (!delta) continue;
            if (delta.verdict === 'improved') totals.improved++;
            if (delta.verdict === 'regressed') totals.regressed++;
            if (delta.verdict === 'neutral') totals.neutral++;
            if (bucket === 'edge' && Number.isFinite(delta.meanAbsDelta)) {
                totals.edgeImprovement += Math.max(0, -delta.meanAbsDelta);
            }
            if (bucket === 'active' && Number.isFinite(delta.meanAbsDelta)) {
                totals.activeImprovement += Math.max(0, -delta.meanAbsDelta);
            }
            if ((bucket === 'lowBody' || bucket === 'highBody') && Number.isFinite(delta.meanAbsDelta)) {
                totals.bodyRegression += Math.max(0, delta.meanAbsDelta);
            }
            if (Number.isFinite(delta.meanAbsDelta)) {
                totals.maxRegression = Math.max(totals.maxRegression, delta.meanAbsDelta);
            }
        }
    }

    return totals;
}

export function summarizeVideoFrameLabSweep(reports) {
    const profiles = reports.map((report) => {
        const cases = Array.isArray(report.cases) ? report.cases : [];
        const totals = tallyBucketVerdicts(cases);
        const score = totals.edgeImprovement + totals.activeImprovement - totals.bodyRegression * 2 - totals.regressed * 0.25;
        return {
            reportPath: report.reportPath || null,
            generatedAt: report.generatedAt,
            profile: report.profile || {},
            label: profileLabel(report.profile),
            caseCount: cases.length,
            cases,
            totals,
            score
        };
    }).sort((a, b) => {
        const strengthDelta = (a.profile.edgeDenoiseStrength ?? 0) - (b.profile.edgeDenoiseStrength ?? 0);
        if (strengthDelta !== 0) return strengthDelta;
        return a.label.localeCompare(b.label);
    });

    const maxCaseCount = Math.max(0, ...profiles.map((item) => item.caseCount));
    const stableCandidates = profiles
        .filter((item) => item.caseCount === maxCaseCount && item.totals.regressed === 0)
        .sort((a, b) => b.score - a.score);

    return {
        generatedAt: new Date().toISOString(),
        profiles,
        recommendedProfile: stableCandidates[0] || null
    };
}

export function renderVideoFrameLabSweepMarkdown(summary) {
    const lines = [];
    lines.push('# Video Frame Lab Sweep');
    lines.push('');
    lines.push(`Generated: ${summary.generatedAt}`);
    lines.push('');

    if (summary.recommendedProfile) {
        lines.push(`Recommended stable profile: ${summary.recommendedProfile.label}`);
        lines.push('');
    } else {
        lines.push('Recommended stable profile: none');
        lines.push('');
    }

    lines.push('| Profile | Cases | Improved | Regressed | Edge gain | Body regression | Score | Report |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
    for (const item of summary.profiles) {
        lines.push([
            item.label,
            item.caseCount,
            item.totals.improved,
            item.totals.regressed,
            formatNumber(item.totals.edgeImprovement),
            formatNumber(item.totals.bodyRegression),
            formatNumber(item.score),
            item.reportPath || '-'
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');
    lines.push('## Case Deltas');
    lines.push('');
    lines.push('| Profile | Case | Active | Edge | LowBody | HighBody |');
    lines.push('|---|---|---:|---:|---:|---:|');
    for (const item of summary.profiles) {
        for (const caseItem of item.cases) {
            const delta = caseItem.deltas || {};
            lines.push([
                item.label,
                caseItem.id,
                `${formatSigned(delta.active?.meanAbsDelta)} (${delta.active?.verdict || '-'})`,
                `${formatSigned(delta.edge?.meanAbsDelta)} (${delta.edge?.verdict || '-'})`,
                `${formatSigned(delta.lowBody?.meanAbsDelta)} (${delta.lowBody?.verdict || '-'})`,
                `${formatSigned(delta.highBody?.meanAbsDelta)} (${delta.highBody?.verdict || '-'})`
            ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
        }
    }

    return `${lines.join('\n')}\n`;
}

async function discoverReportPaths(root) {
    const reportPaths = [path.join(root, 'latest-report.json')];
    let entries = [];
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return reportPaths;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        reportPaths.push(path.join(root, entry.name, 'latest-report.json'));
    }
    return reportPaths;
}

async function loadReports(reportPaths) {
    const reports = [];
    for (const reportPath of reportPaths) {
        try {
            const resolved = path.resolve(reportPath);
            const report = JSON.parse(await readFile(resolved, 'utf8'));
            reports.push({ ...report, reportPath: resolved });
        } catch {
            // Missing sweep branches are fine; this reporter is often used mid-experiment.
        }
    }
    return reports;
}

export async function runVideoFrameLabSweepReport({
    root = DEFAULT_ROOT,
    reports = null,
    outputPath = null,
    jsonPath = null
} = {}) {
    const resolvedRoot = path.resolve(root);
    const reportPaths = reports?.length
        ? reports.map((item) => path.resolve(item))
        : await discoverReportPaths(resolvedRoot);
    const loadedReports = await loadReports(reportPaths);
    const summary = summarizeVideoFrameLabSweep(loadedReports);
    const resolvedOutputPath = path.resolve(outputPath || path.join(resolvedRoot, 'latest-sweep-report.md'));
    const resolvedJsonPath = path.resolve(jsonPath || path.join(resolvedRoot, 'latest-sweep-report.json'));

    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedJsonPath), { recursive: true });
    await writeFile(resolvedOutputPath, renderVideoFrameLabSweepMarkdown(summary), 'utf8');
    await writeFile(resolvedJsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    return {
        ...summary,
        outputPath: resolvedOutputPath,
        jsonPath: resolvedJsonPath
    };
}

function parseCliArgs(argv) {
    const parsed = {
        root: DEFAULT_ROOT,
        reports: null,
        outputPath: null,
        jsonPath: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--root') {
            parsed.root = path.resolve(argv[++i] || parsed.root);
        } else if (arg === '--reports') {
            parsed.reports = String(argv[++i] || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || '');
        } else if (arg === '--json') {
            parsed.jsonPath = path.resolve(argv[++i] || '');
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
  node scripts/report-video-frame-lab-sweep.js [options]

Options:
  --root <dir>         Root containing lab report directories
  --reports <files>    Comma-separated latest-report.json paths
  --output <file>      Markdown output path
  --json <file>        JSON output path
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    runVideoFrameLabSweepReport(args)
        .then((summary) => {
            console.log(`markdown: ${summary.outputPath}`);
            console.log(`json: ${summary.jsonPath}`);
            if (summary.recommendedProfile) {
                console.log(`recommended: ${summary.recommendedProfile.label}`);
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
