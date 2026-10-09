import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_ARTIFACT_ROOT = path.resolve('.artifacts/video-light-polish-strength020');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json');

function isComparisonReportName(name) {
    return /^[^-]+-(roi|full)-4up\.mp4\.json$/.test(name);
}

function parseComparisonReportName(name) {
    const match = /^(?<caseId>.+)-(?<kind>roi|full)-4up\.mp4\.json$/.exec(name);
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

async function readComparisonReports(comparisonDir) {
    const names = (await readdir(comparisonDir)).filter(isComparisonReportName).sort();
    const comparisons = [];
    for (const name of names) {
        const parsed = parseComparisonReportName(name);
        if (!parsed) continue;
        const reportPath = path.join(comparisonDir, name);
        const report = await readJson(reportPath);
        comparisons.push({
            caseId: parsed.caseId,
            kind: parsed.kind,
            reportPath,
            outputPath: report.outputPath,
            markdownPath: report.markdownPath,
            snapshotPath: path.join(comparisonDir, `${parsed.caseId}-${parsed.kind}-contact.png`),
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

export async function createVideoLightPolishReviewPack({
    artifactRoot = DEFAULT_ARTIFACT_ROOT,
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const root = path.resolve(artifactRoot);
    const comparisonDir = path.join(root, 'comparison');
    const gatePath = path.join(root, 'gate/latest-report.json');
    const temporalPath = path.join(root, 'temporal-residual/latest-report.json');
    const comparisons = await readComparisonReports(comparisonDir);
    const gate = await readJsonIfExists(gatePath, {});
    const temporal = await readJsonIfExists(temporalPath, {});

    const pack = {
        title: 'Video Light Polish Review',
        subtitle: 'Compare current 0.25 with backup 0.20',
        generatedAt: new Date().toISOString(),
        source: 'video-light-polish-strength020',
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
                profileLabel: 'strength=0.20 backup compared with current strength=0.25',
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
            { value: 'prefer-current', label: 'Prefer current 0.25' },
            { value: 'prefer-light', label: 'Prefer lighter 0.20' },
            { value: 'needs-more-polish', label: 'Needs more polish' },
            { value: 'reject-both', label: 'Reject both' }
        ],
        checklist: [
            'ROI: 0.20 removes visible residual at least as well as 0.25',
            'ROI: 0.20 does not make edge flicker or halo more noticeable',
            'Full frame: 0.20 does not look softer or more distracting than 0.25',
            'Temporal scan: no new 0.20 shimmer around 2s, 4s, 6s, 8s',
            'Decision notes mention whether to keep 0.25 or open a narrower 0.18-0.22 sweep'
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
  node scripts/create-video-light-polish-review-pack.js [--artifact-root <dir>] [--output <json>]

Default output:
  .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoLightPolishReviewPack(args)
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
