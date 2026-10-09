import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-alpha-profile.json'
);
const DEFAULT_OUTPUT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-reference-boundary.json'
);
const REFERENCE_CANDIDATE = Object.freeze({
    profileName: 'power-0.88',
    alphaGain: 0.55
});
const THRESHOLDS = Object.freeze(
    Array.from({ length: 101 }, (_, index) => Number((index / 100).toFixed(2)))
);

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function findReferenceTrial(record) {
    return (record.trials ?? []).find((trial) => (
        trial.profileName === REFERENCE_CANDIDATE.profileName &&
        trial.alphaGain === REFERENCE_CANDIDATE.alphaGain
    )) ?? null;
}

function toBoundaryRecord(record) {
    const reference = findReferenceTrial(record);
    const evidence = record.forcedGeometry?.originalEvidence ?? {};
    return {
        file: record.file,
        profileLine: record.profileLine,
        targetProfileLine: record.targetProfileLine === true,
        geometryFamilyApplicable: record.geometryFamilyApplicable === true,
        spatial: Number(evidence.spatial),
        gradient: Number(evidence.gradient),
        reference: {
            clearedVisible: reference?.clearedVisible === true,
            safe: reference?.texture?.safe === true,
            visible: reference?.visibility?.visible === true,
            severity: reference?.visibility?.severity ?? null,
            severityDelta: reference?.severityDelta ?? null
        }
    };
}

function classify(record) {
    if (record.reference.clearedVisible) return 'cleared';
    if (!record.reference.safe) return 'unsafe';
    if (record.reference.visible) return 'visible-after';
    return 'non-visible-not-cleared';
}

function passesRule(record, rule) {
    if (!Number.isFinite(record.spatial) || !Number.isFinite(record.gradient)) return false;
    if (rule.type === 'spatial-at-least') return record.spatial >= rule.spatial;
    if (rule.type === 'gradient-at-least') return record.gradient >= rule.gradient;
    if (rule.type === 'spatial-and-gradient-at-least') {
        return record.spatial >= rule.spatial && record.gradient >= rule.gradient;
    }
    if (rule.type === 'spatial-or-gradient-at-least') {
        return record.spatial >= rule.spatial || record.gradient >= rule.gradient;
    }
    if (rule.type === 'min-evidence-at-least') {
        return Math.min(record.spatial, record.gradient) >= rule.threshold;
    }
    if (rule.type === 'max-evidence-at-least') {
        return Math.max(record.spatial, record.gradient) >= rule.threshold;
    }
    return false;
}

function summarizeSelection(records, rule) {
    const selected = records.filter((record) => passesRule(record, rule));
    const counts = {
        cleared: 0,
        unsafe: 0,
        visibleAfter: 0,
        nonVisibleNotCleared: 0,
        targetProfileLine: 0,
        nonTargetProfileLine: 0
    };
    for (const record of selected) {
        const bucket = classify(record);
        if (bucket === 'cleared') counts.cleared++;
        if (bucket === 'unsafe') counts.unsafe++;
        if (bucket === 'visible-after') counts.visibleAfter++;
        if (bucket === 'non-visible-not-cleared') counts.nonVisibleNotCleared++;
        if (record.targetProfileLine) counts.targetProfileLine++;
        else counts.nonTargetProfileLine++;
    }
    const falsePositive = selected.length - counts.cleared;
    return {
        rule,
        selected: selected.length,
        counts,
        falsePositive,
        selectedFiles: selected.map((record) => ({
            file: record.file,
            profileLine: record.profileLine,
            spatial: round(record.spatial),
            gradient: round(record.gradient),
            outcome: classify(record)
        }))
    };
}

function makeRules() {
    const rules = [];
    for (const threshold of THRESHOLDS) {
        rules.push({ type: 'spatial-at-least', spatial: threshold });
        rules.push({ type: 'gradient-at-least', gradient: threshold });
        rules.push({ type: 'min-evidence-at-least', threshold });
        rules.push({ type: 'max-evidence-at-least', threshold });
    }
    for (const spatial of THRESHOLDS) {
        for (const gradient of THRESHOLDS) {
            rules.push({ type: 'spatial-and-gradient-at-least', spatial, gradient });
            rules.push({ type: 'spatial-or-gradient-at-least', spatial, gradient });
        }
    }
    return rules;
}

function compareRule(left, right, totalCleared) {
    const leftKeepsAllCleared = left.counts.cleared === totalCleared ? 0 : 1;
    const rightKeepsAllCleared = right.counts.cleared === totalCleared ? 0 : 1;
    return leftKeepsAllCleared - rightKeepsAllCleared ||
        left.falsePositive - right.falsePositive ||
        left.counts.unsafe - right.counts.unsafe ||
        left.counts.visibleAfter - right.counts.visibleAfter ||
        right.counts.cleared - left.counts.cleared ||
        left.selected - right.selected ||
        left.rule.type.localeCompare(right.rule.type);
}

function summarizeByProfile(records) {
    const byProfile = new Map();
    for (const record of records) {
        const profile = record.profileLine ?? 'unknown';
        if (!byProfile.has(profile)) {
            byProfile.set(profile, {
                profileLine: profile,
                total: 0,
                cleared: 0,
                unsafe: 0,
                visibleAfter: 0,
                nonVisibleNotCleared: 0
            });
        }
        const summary = byProfile.get(profile);
        summary.total++;
        const bucket = classify(record);
        if (bucket === 'cleared') summary.cleared++;
        if (bucket === 'unsafe') summary.unsafe++;
        if (bucket === 'visible-after') summary.visibleAfter++;
        if (bucket === 'non-visible-not-cleared') summary.nonVisibleNotCleared++;
    }
    return [...byProfile.values()].sort((left, right) => right.total - left.total || left.profileLine.localeCompare(right.profileLine));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const sourceReport = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const records = (sourceReport.records ?? [])
        .filter((record) => record.geometryFamilyApplicable === true)
        .map(toBoundaryRecord);
    const totalCleared = records.filter((record) => record.reference.clearedVisible).length;
    const ruleSummaries = makeRules().map((rule) => summarizeSelection(records, rule));
    ruleSummaries.sort((left, right) => compareRule(left, right, totalCleared));
    const cleanIsolationRules = ruleSummaries.filter((summary) => (
        summary.counts.cleared === totalCleared &&
        summary.falsePositive === 0
    ));
    const cleanNoUnsafeRules = ruleSummaries.filter((summary) => (
        summary.counts.cleared === totalCleared &&
        summary.counts.unsafe === 0
    ));
    const topKeepAllCleared = ruleSummaries.filter((summary) => (
        summary.counts.cleared === totalCleared
    )).slice(0, 12);

    const report = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        sourceInputs: sourceReport.inputs ?? null,
        geometryFamily: sourceReport.geometryFamily ?? null,
        referenceCandidate: REFERENCE_CANDIDATE,
        policy: {
            diagnosticOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        summary: {
            total: records.length,
            totalCleared,
            cleanIsolationRuleCount: cleanIsolationRules.length,
            cleanNoUnsafeRuleCount: cleanNoUnsafeRules.length,
            bestRuleKeepingAllCleared: topKeepAllCleared[0] ?? null,
            conclusion: cleanIsolationRules.length > 0
                ? 'reference-candidate-has-clean-evidence-boundary'
                : 'reference-candidate-has-no-clean-evidence-boundary'
        },
        outcomeByProfileLine: summarizeByProfile(records),
        records: records.map((record) => ({
            ...record,
            outcome: classify(record),
            spatial: round(record.spatial),
            gradient: round(record.gradient)
        })),
        cleanIsolationRules: cleanIsolationRules.slice(0, 20),
        cleanNoUnsafeRules: cleanNoUnsafeRules.slice(0, 20),
        topKeepAllCleared
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        outcomeByProfileLine: report.outcomeByProfileLine
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
