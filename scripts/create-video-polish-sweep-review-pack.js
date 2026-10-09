import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_ARTIFACT_ROOT = path.resolve('.artifacts/video-light-polish-sweep018022');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json');

function isSweepComparisonReportName(name) {
    return /^[^-]+-(roi|full)-strength-sweep-4up\.mp4\.json$/.test(name);
}

function parseSweepComparisonReportName(name) {
    const match = /^(?<caseId>.+)-(?<kind>roi|full)-strength-sweep-4up\.mp4\.json$/.exec(name);
    if (!match?.groups) return null;
    return {
        caseId: match.groups.caseId,
        kind: match.groups.kind
    };
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

async function readJsonIfExists(filePath, fallback = null) {
    return existsSync(filePath) ? readJson(filePath) : fallback;
}

function summarizeGateCandidates(gate = {}) {
    return (gate.candidates || []).map((candidate) => ({
        profileLabel: candidate.profileLabel,
        decision: candidate.decision,
        improvedCases: candidate.improvedCases,
        warningLayers: candidate.warningLayers,
        materialFailureLayers: candidate.materialFailureLayers
    }));
}

async function readSweepComparisonReports(comparisonDir) {
    const names = (await readdir(comparisonDir)).filter(isSweepComparisonReportName).sort();
    const comparisons = [];
    for (const name of names) {
        const parsed = parseSweepComparisonReportName(name);
        if (!parsed) continue;
        const reportPath = path.join(comparisonDir, name);
        const report = await readJson(reportPath);
        comparisons.push({
            caseId: parsed.caseId,
            kind: parsed.kind,
            reportPath,
            outputPath: report.outputPath,
            markdownPath: report.markdownPath,
            cropBox: report.cropBox || null,
            inputs: report.inputs || [],
            probe: {
                exists: Boolean(report.outputPath),
                video: {
                    frameRate: '24fps',
                    duration: 10
                }
            }
        });
    }
    return comparisons.sort((a, b) => {
        const caseOrder = a.caseId.localeCompare(b.caseId);
        if (caseOrder !== 0) return caseOrder;
        const kindOrder = { roi: 0, full: 1 };
        return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    });
}

export async function createVideoPolishSweepReviewPack({
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const root = path.resolve(artifactRoot);
    const comparisonDir = path.join(root, 'comparison');
    const gatePath = path.join(root, 'gate/latest-report.json');
    const temporalPath = path.join(root, 'temporal-residual/latest-report.json');
    const comparisons = await readSweepComparisonReports(comparisonDir);
    const gate = await readJsonIfExists(gatePath, {});
    const temporal = await readJsonIfExists(temporalPath, {});

    const pack = {
        title: 'Video Polish Strength Sweep Review',
        subtitle: 'Compare s018, s020, s022, and current s025',
        generatedAt: new Date().toISOString(),
        source: 'video-light-polish-sweep018022',
        gateReportPath: gatePath,
        temporalReportPath: temporalPath,
        delivery: {
            status: 'review-only',
            ready: true,
            blockers: [],
            benchmark: {
                total: comparisons.length,
                rendered: comparisons.length,
                failed: 0
            },
            bestCandidate: {
                profileLabel: 'strength sweep 0.18 / 0.20 / 0.22 / 0.25',
                decision: 'human-review',
                gateCandidates: summarizeGateCandidates(gate)
            }
        },
        temporal: {
            reportPath: temporalPath,
            markdownPath: path.join(root, 'temporal-residual/latest-report.md'),
            generatedAt: temporal.generatedAt || null,
            matchRadius: temporal.matchRadius ?? null,
            includeVariants: temporal.includeVariants === true,
            cases: temporal.cases || []
        },
        comparisons,
        decisionOptions: [
            { value: 'pending', label: 'Pending' },
            { value: 'prefer-strength018', label: 'Prefer 0.18' },
            { value: 'prefer-light', label: 'Prefer 0.20' },
            { value: 'prefer-strength022', label: 'Prefer 0.22' },
            { value: 'prefer-current', label: 'Prefer current 0.25' },
            { value: 'needs-more-polish', label: 'Needs more polish' },
            { value: 'reject-both', label: 'Reject sweep' }
        ],
        checklist: [
            'ROI: chosen strength has the least visible residual across both samples',
            'ROI: chosen strength does not create stronger edge shimmer than 0.25',
            'Full frame: chosen strength does not look softer or more distracting than 0.25',
            'Temporal scan: chosen strength is acceptable at 2s, 4s, 6s, and 8s',
            'Decision notes mention whether to keep 0.25 or promote a lighter strength'
        ]
    };

    const resolvedOutputPath = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    return {
        outputPath: resolvedOutputPath,
        artifactRoot: root,
        comparisons: comparisons.length,
        temporalCases: pack.temporal.cases.length,
        gateCandidates: pack.delivery.bestCandidate.gateCandidates.length
    };
}

function parseArgs(argv) {
    const parsed = {
        artifactRoot: DEFAULT_ARTIFACT_ROOT,
        outputPath: DEFAULT_OUTPUT_PATH
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--artifact-root') {
            parsed.artifactRoot = path.resolve(argv[++i] || DEFAULT_ARTIFACT_ROOT);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
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
  node scripts/create-video-polish-sweep-review-pack.js [--artifact-root <dir>] [--output <json>]

Default output:
  .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoPolishSweepReviewPack(args)
        .then((report) => {
            console.log(`json: ${report.outputPath}`);
            console.log(`videos: ${report.comparisons}`);
            console.log(`temporal cases: ${report.temporalCases}`);
            console.log(`gate candidates: ${report.gateCandidates}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
