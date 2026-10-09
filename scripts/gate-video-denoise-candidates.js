import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-denoise-candidate-gate/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/video-denoise-candidate-gate/latest-report.md');
const BUCKETS = Object.freeze(['active', 'edge', 'lowBody', 'highBody']);
const CONTROL_DELTA_EPSILON = 0.005;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLayerKind(report, fallbackPath) {
    if (Array.isArray(report.variantComparisons)) return 'video-benchmark';
    if (Array.isArray(report.cases) && isObject(report.profile)) return 'frame-lab';
    return `unknown:${path.basename(fallbackPath)}`;
}

function createLayerId(kind, reportPath) {
    const fileBase = path.basename(reportPath, '.json');
    const parentBase = path.basename(path.dirname(reportPath));
    return parentBase && parentBase !== '.'
        ? `${kind}:${parentBase}/${fileBase}`
        : `${kind}:${fileBase}`;
}

function normalizeProfile(profile = {}) {
    const denoiseBackend = profile.denoiseBackend || 'none';
    const strength = Number(profile.edgeDenoiseStrength);
    const parts = [
        `denoise=${denoiseBackend}`
    ].filter(Boolean);
    if (denoiseBackend !== 'none' && Number.isFinite(strength)) {
        parts.push(`strength=${strength}`);
    }
    if (denoiseBackend === 'none' && profile.alphaEdgePolicy) {
        parts.push(`alphaEdgePolicy=${profile.alphaEdgePolicy}`);
    }
    return parts.join(';');
}

function formatProfile(profile = {}) {
    const pieces = [profile.denoiseBackend || 'none'];
    if ((profile.denoiseBackend || 'none') !== 'none' && Number.isFinite(Number(profile.edgeDenoiseStrength))) {
        pieces.push(`strength=${Number(profile.edgeDenoiseStrength)}`);
    }
    if ((profile.denoiseBackend || 'none') === 'none' && profile.alphaEdgePolicy) {
        pieces.push(`alphaEdgePolicy=${profile.alphaEdgePolicy}`);
    }
    return pieces.join(', ');
}

function getRegressedBuckets(deltas = {}, riskNotes = [], controlAdjustments = []) {
    const warningBuckets = new Set((Array.isArray(riskNotes) ? riskNotes : [])
        .filter((note) => note?.severity === 'warning' && note.bucket)
        .map((note) => note.bucket));
    const controlBuckets = new Set((Array.isArray(controlAdjustments) ? controlAdjustments : [])
        .filter((note) => note?.bucket)
        .map((note) => note.bucket));
    const material = [];
    const warning = [];
    const control = [];

    for (const bucket of BUCKETS) {
        if (deltas?.[bucket]?.verdict !== 'regressed') continue;
        if (controlBuckets.has(bucket)) {
            control.push(bucket);
        } else if (warningBuckets.has(bucket)) {
            warning.push(bucket);
        } else {
            material.push(bucket);
        }
    }

    return { material, warning, control };
}

function hasImprovement(deltas = {}) {
    return BUCKETS.some((bucket) => deltas?.[bucket]?.verdict === 'improved');
}

function summarizeLayerCases(cases) {
    let improved = 0;
    let materialRegressed = 0;
    let warningRegressed = 0;
    const failures = [];

    for (const item of cases) {
        const regression = getRegressedBuckets(item.deltas, item.riskNotes, item.controlAdjustments);
        if (hasImprovement(item.deltas)) improved++;
        if (regression.material.length) {
            materialRegressed++;
            failures.push({
                caseId: item.caseId,
                buckets: regression.material,
                variantId: item.variantId || null
            });
        }
        if (regression.warning.length) warningRegressed++;
    }

    return {
        cases: cases.length,
        improved,
        materialRegressed,
        warningRegressed,
        failures,
        verdict: materialRegressed > 0
            ? 'fail'
            : warningRegressed > 0
                ? 'warning'
                : improved > 0
                    ? 'pass'
                    : 'neutral'
    };
}

function extractBenchmarkCandidates(report, layerId) {
    return (Array.isArray(report.variantComparisons) ? report.variantComparisons : [])
        .filter((item) => item.status === 'compared')
        .map((item) => ({
            layerId,
            caseId: item.baselineId || item.variantId,
            variantId: item.variantId,
            profile: item.currentProfile || {},
            profileKey: normalizeProfile(item.currentProfile || {}),
            deltas: item.deltas || {},
            riskNotes: item.riskNotes || [],
            controlAdjustments: []
        }));
}

function extractFrameLabCandidates(report, layerId) {
    const profile = report.profile || {};
    return (Array.isArray(report.cases) ? report.cases : []).map((item) => ({
        layerId,
        caseId: item.id,
        variantId: item.id,
        profile,
        profileKey: normalizeProfile(profile),
        deltas: item.deltas || {},
        riskNotes: item.riskNotes || [],
        controlAdjustments: []
    }));
}

function extractCandidates(report, reportPath) {
    const kind = normalizeLayerKind(report, reportPath);
    const layerId = report.layerId || createLayerId(kind, reportPath);
    const cases = kind === 'video-benchmark'
        ? extractBenchmarkCandidates(report, layerId)
        : kind === 'frame-lab'
            ? extractFrameLabCandidates(report, layerId)
            : [];

    return {
        id: layerId,
        kind,
        path: path.resolve(reportPath),
        generatedAt: report.generatedAt || null,
        cases
    };
}

function groupCandidates(layers) {
    const groups = new Map();
    for (const layer of layers) {
        for (const item of layer.cases) {
            if (!groups.has(item.profileKey)) {
                groups.set(item.profileKey, {
                    profileKey: item.profileKey,
                    profile: item.profile,
                    profileLabel: formatProfile(item.profile),
                    layers: []
                });
            }
            const group = groups.get(item.profileKey);
            let layerRecord = group.layers.find((entry) => entry.layerId === layer.id);
            if (!layerRecord) {
                layerRecord = {
                    layerId: layer.id,
                    kind: layer.kind,
                    path: layer.path,
                    cases: []
                };
                group.layers.push(layerRecord);
            }
            layerRecord.cases.push(item);
        }
    }
    return [...groups.values()];
}

function extractControlComparisons(controlReports = []) {
    const controls = new Map();
    for (const { report, reportPath } of controlReports) {
        const comparisons = Array.isArray(report?.variantComparisons) ? report.variantComparisons : [];
        for (const item of comparisons) {
            if (item?.status !== 'compared') continue;
            const caseId = item.baselineId || item.variantId;
            if (!caseId) continue;
            if (!controls.has(caseId)) {
                controls.set(caseId, []);
            }
            controls.get(caseId).push({
                reportPath: path.resolve(reportPath),
                variantId: item.variantId || null,
                profile: item.currentProfile || {},
                deltas: item.deltas || {}
            });
        }
    }
    return controls;
}

function findControlAdjustment(caseId, bucket, delta, controls) {
    const candidateDelta = Number(delta?.meanAbsDelta);
    if (!Number.isFinite(candidateDelta) || candidateDelta <= 0) return null;

    for (const control of controls.get(caseId) || []) {
        const controlDelta = control.deltas?.[bucket];
        const controlMeanAbsDelta = Number(controlDelta?.meanAbsDelta);
        if (
            controlDelta?.verdict === 'regressed' &&
            Number.isFinite(controlMeanAbsDelta) &&
            controlMeanAbsDelta >= candidateDelta - CONTROL_DELTA_EPSILON
        ) {
            return {
                bucket,
                source: 'encoding-control',
                controlReportPath: control.reportPath,
                controlVariantId: control.variantId,
                controlMeanAbsDelta,
                candidateMeanAbsDelta: candidateDelta
            };
        }
    }

    return null;
}

function applyControlAdjustments(layers, controlReports = []) {
    const controls = extractControlComparisons(controlReports);
    if (controls.size === 0) return layers;

    return layers.map((layer) => ({
        ...layer,
        cases: layer.cases.map((item) => {
            const controlAdjustments = [...(item.controlAdjustments || [])];
            for (const bucket of BUCKETS) {
                if (item.deltas?.[bucket]?.verdict !== 'regressed') continue;
                const adjustment = findControlAdjustment(item.caseId, bucket, item.deltas[bucket], controls);
                if (adjustment) controlAdjustments.push(adjustment);
            }
            return {
                ...item,
                controlAdjustments
            };
        })
    }));
}

function finalizeCandidate(group, requiredLayerCount) {
    const layers = group.layers.map((layer) => ({
        ...layer,
        summary: summarizeLayerCases(layer.cases)
    }));
    const materialFailureLayers = layers.filter((layer) => layer.summary.verdict === 'fail');
    const warningLayers = layers.filter((layer) => layer.summary.verdict === 'warning');
    const improvedCases = layers.reduce((sum, layer) => sum + layer.summary.improved, 0);
    const missingLayerCount = Math.max(0, requiredLayerCount - layers.length);
    const syntheticSeamOnly = layers.length > 0 && layers.every((layer) => {
        return layer.cases.length > 0 && layer.cases.every((item) => item.profile?.syntheticSeamFixture === true);
    });

    const decision = materialFailureLayers.length > 0
        ? 'reject'
        : syntheticSeamOnly
            ? 'synthetic-seam-evidence-only'
            : missingLayerCount > 0
            ? 'insufficient-evidence'
            : improvedCases <= 0
                ? 'insufficient-improvement'
                : warningLayers.length > 0
                    ? 'human-review'
                    : 'promote-default-candidate';

    return {
        ...group,
        layers,
        summary: {
            layerCount: layers.length,
            requiredLayerCount,
            missingLayerCount,
            improvedCases,
            materialFailureLayers: materialFailureLayers.length,
            warningLayers: warningLayers.length,
            syntheticSeamOnly
        },
        decision
    };
}

export function createVideoDenoiseCandidateGateReport({
    reports,
    controlReports = [],
    requiredLayerCount = null
}) {
    if (!Array.isArray(reports) || reports.length === 0) {
        throw new Error('至少需要提供一个 --reports JSON');
    }
    const rawLayers = reports.map(({ report, reportPath }) => extractCandidates(report, reportPath));
    const layers = applyControlAdjustments(rawLayers, controlReports);
    const required = Number.isFinite(requiredLayerCount) && requiredLayerCount > 0
        ? Math.round(requiredLayerCount)
        : layers.length;
    const candidates = groupCandidates(layers)
        .map((group) => finalizeCandidate(group, required))
        .sort((a, b) => {
            const order = {
                'promote-default-candidate': 0,
                'human-review': 1,
                'insufficient-improvement': 2,
                'insufficient-evidence': 3,
                reject: 4
            };
            return (order[a.decision] ?? 9) - (order[b.decision] ?? 9) ||
                a.profileLabel.localeCompare(b.profileLabel);
        });

    return {
        generatedAt: new Date().toISOString(),
        requiredLayerCount: required,
        layers: layers.map((layer) => ({
            id: layer.id,
            kind: layer.kind,
            path: layer.path,
            generatedAt: layer.generatedAt,
            cases: layer.cases.length
        })),
        controlReports: controlReports.map(({ report, reportPath }) => ({
            path: path.resolve(reportPath),
            generatedAt: report?.generatedAt || null,
            cases: Array.isArray(report?.variantComparisons) ? report.variantComparisons.length : 0
        })),
        candidates,
        summary: {
            totalCandidates: candidates.length,
            promoteDefaultCandidates: candidates.filter((item) => item.decision === 'promote-default-candidate').length,
            humanReviewCandidates: candidates.filter((item) => item.decision === 'human-review').length,
            rejectedCandidates: candidates.filter((item) => item.decision === 'reject').length
        }
    };
}

function formatSigned(value, digits = 4) {
    if (!Number.isFinite(value)) return '-';
    const formatted = value.toFixed(digits);
    return value > 0 ? `+${formatted}` : formatted;
}

function formatCaseDelta(deltas = {}) {
    return BUCKETS.map((bucket) => {
        const delta = deltas?.[bucket];
        return `${bucket}:${formatSigned(delta?.meanAbsDelta)} ${delta?.verdict || '-'}`;
    }).join('; ');
}

function formatControlAdjustments(adjustments = []) {
    if (!Array.isArray(adjustments) || adjustments.length === 0) return '-';
    return adjustments
        .map((item) => `${item.bucket}:${formatSigned(item.candidateMeanAbsDelta)} covered by ${item.controlVariantId || 'control'} ${formatSigned(item.controlMeanAbsDelta)}`)
        .join('; ');
}

export function renderVideoDenoiseCandidateGateMarkdown(report) {
    const lines = [];
    lines.push('# Video Denoise Candidate Gate');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Required layers: ${report.requiredLayerCount}`);
    if (Array.isArray(report.controlReports) && report.controlReports.length) {
        lines.push(`Control reports: ${report.controlReports.length}`);
    }
    lines.push('');
    lines.push('| Candidate | Decision | Layers | Improved Cases | Material Fail Layers | Warning Layers |');
    lines.push('|---|---|---:|---:|---:|---:|');
    for (const candidate of report.candidates) {
        lines.push([
            candidate.profileLabel,
            candidate.decision,
            candidate.summary.layerCount,
            candidate.summary.improvedCases,
            candidate.summary.materialFailureLayers,
            candidate.summary.warningLayers
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
    lines.push('');

    for (const candidate of report.candidates) {
        lines.push(`## ${candidate.profileLabel}`);
        lines.push('');
        lines.push(`Decision: ${candidate.decision}`);
        lines.push('');
        for (const layer of candidate.layers) {
            lines.push(`### ${layer.layerId}`);
            lines.push('');
            lines.push(`Layer verdict: ${layer.summary.verdict}`);
            lines.push('');
            lines.push('| Case | Variant | Deltas | Material Regressions | Control Adjustments |');
            lines.push('|---|---|---|---|---|');
            for (const item of layer.cases) {
                const regression = getRegressedBuckets(item.deltas, item.riskNotes, item.controlAdjustments);
                lines.push([
                    item.caseId,
                    item.variantId || '-',
                    formatCaseDelta(item.deltas),
                    regression.material.join(', ') || '-',
                    formatControlAdjustments(item.controlAdjustments)
                ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
            }
            lines.push('');
        }
    }

    return `${lines.join('\n')}\n`;
}

async function readReports(paths) {
    const reports = [];
    for (const reportPath of paths) {
        const resolved = path.resolve(reportPath);
        reports.push({
            reportPath: resolved,
            report: JSON.parse(await readFile(resolved, 'utf8'))
        });
    }
    return reports;
}

export async function writeVideoDenoiseCandidateGateReport({
    reportPaths,
    controlReportPaths = [],
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    requiredLayerCount = null
}) {
    const reports = await readReports(reportPaths);
    const controlReports = await readReports(controlReportPaths);
    const report = createVideoDenoiseCandidateGateReport({
        reports,
        controlReports,
        requiredLayerCount
    });
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedMarkdownPath = path.resolve(markdownPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(resolvedMarkdownPath, renderVideoDenoiseCandidateGateMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: resolvedOutputPath,
        markdownPath: resolvedMarkdownPath
    };
}

function parseCliArgs(argv) {
    const parsed = {
        reportPaths: [],
        controlReportPaths: [],
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        requiredLayerCount: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--reports') {
            parsed.reportPaths = String(argv[++i] || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        } else if (arg === '--control-reports') {
            parsed.controlReportPaths = String(argv[++i] || '')
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean);
        } else if (arg === '--output') {
            parsed.outputPath = argv[++i] || parsed.outputPath;
        } else if (arg === '--markdown') {
            parsed.markdownPath = argv[++i] || parsed.markdownPath;
        } else if (arg === '--required-layers') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value) && value > 0) parsed.requiredLayerCount = value;
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
  node scripts/gate-video-denoise-candidates.js --reports <a.json,b.json> [options]

Options:
  --output <path>           Default: .artifacts/video-denoise-candidate-gate/latest-report.json
  --markdown <path>         Default: .artifacts/video-denoise-candidate-gate/latest-report.md
  --control-reports <json>  Optional no-op encoding-control benchmark reports
  --required-layers <n>     Defaults to the number of provided reports
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    writeVideoDenoiseCandidateGateReport(args)
        .then((report) => {
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            console.log(`candidates: ${report.summary.totalCandidates}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
