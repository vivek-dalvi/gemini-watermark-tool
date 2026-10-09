import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { evaluateRestorationCandidate } from '../src/core/candidateSelector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { assessWatermarkResidualVisibility } from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_CURRENT_MONITOR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/phase5-current/latest.json'
);
const DEFAULT_BASELINE_MONITOR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-monitor/initial/latest.json'
);
const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/latest-report-phase5-decision-path.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve(
    '.artifacts/online-sample-2026-06-23-to-2026-06-24-max500/quality-ablation/phase5-vs-initial'
);
const DEFAULT_LIMIT = 60;
const DEFAULT_GAINS = Object.freeze([0.45, 0.5, 0.55, 0.6, 0.62, 0.65, 0.7, 0.75, 0.85, 1, 1.1, 1.15, 1.3]);

const STRICT_THRESHOLDS = Object.freeze({
    spatialResidual: 0.04,
    gradientResidual: 0.08,
    positiveHaloLum: 3,
    damagePenalty: 0.2,
    texturePenalty: 0.25,
    nearBlackIncrease: 0.02,
    newlyClippedRatio: 0.005,
    minSuppressionGain: 0.3
});

const CLEAN_THRESHOLDS = Object.freeze({
    spatialResidual: 0.08,
    gradientResidual: 0.12,
    positiveHaloLum: 6,
    damagePenalty: 0.5,
    texturePenalty: 0.6,
    nearBlackIncrease: 0.05,
    newlyClippedRatio: 0.01,
    minSuppressionGain: 0.25
});

function parseArgs(argv) {
    const parsed = {
        currentMonitorPath: DEFAULT_CURRENT_MONITOR,
        baselineMonitorPath: DEFAULT_BASELINE_MONITOR,
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        limit: DEFAULT_LIMIT
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--current-monitor') {
            parsed.currentMonitorPath = path.resolve(args.shift() || parsed.currentMonitorPath);
        } else if (arg === '--baseline-monitor') {
            parsed.baselineMonitorPath = path.resolve(args.shift() || parsed.baselineMonitorPath);
        } else if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        } else if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function round(value, digits = 6) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function toFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveAlphaMaps() {
    const alpha48 = getEmbeddedAlphaMap(48);
    const alpha96 = getEmbeddedAlphaMap(96);
    const alpha96NewMargin = getEmbeddedAlphaMap('96-20260520');
    const alpha36V2 = getEmbeddedAlphaMap('36-v2');
    const cache = new Map([
        [48, alpha48],
        [96, alpha96],
        ['96-20260520', alpha96NewMargin],
        ['36-v2', alpha36V2]
    ]);

    return {
        getAlphaMap(size, alphaVariant = null) {
            const key = alphaVariant === '20260520' ? '96-20260520' : size;
            if (cache.has(key)) return cache.get(key);
            if (typeof size === 'string') return null;
            const source = size <= 64 ? alpha48 : alpha96;
            const sourceSize = size <= 64 ? 48 : 96;
            const alphaMap = interpolateAlphaMap(source, sourceSize, size);
            cache.set(key, alphaMap);
            return alphaMap;
        }
    };
}

function selectQueues({ currentRecords, baselineRecords, limit }) {
    const baselineByFile = new Map(baselineRecords.map((record) => [record.fileName, record]));
    const queues = {
        perfectLost: [],
        severeDefectIntroduced: [],
        passGained: []
    };
    for (const current of currentRecords) {
        const baseline = baselineByFile.get(current.fileName);
        if (!baseline) continue;
        if (baseline.perfect && !current.perfect) queues.perfectLost.push(current);
        if (!baseline.severeDefect && current.severeDefect) queues.severeDefectIntroduced.push(current);
        if (!baseline.metrics.pass && current.metrics.pass) queues.passGained.push(current);
    }

    return Object.fromEntries(Object.entries(queues).map(([name, records]) => [
        name,
        records
            .sort((left, right) => severity(right) - severity(left) || left.fileName.localeCompare(right.fileName))
            .slice(0, limit)
    ]));
}

function severity(record) {
    const metrics = record.metrics ?? {};
    return (
        (record.severeDefect ? 1000 : 0) +
        (record.strictFlags?.length ?? 0) * 25 +
        Math.max(0, metrics.damagePenalty ?? 0) * 120 +
        Math.max(0, metrics.texturePenalty ?? 0) * 100 +
        Math.max(0, metrics.positiveHaloLum ?? 0) * 3 +
        Math.max(0, metrics.gradient ?? 0) * 90 +
        Math.max(0, metrics.residual ?? 0) * 90
    );
}

function resolvePosition(record, imageData) {
    const position = record?.position;
    if (position && [position.x, position.y, position.width, position.height].every(Number.isFinite)) {
        return position;
    }
    const anchor = record?.actualAnchor;
    const size = anchor?.logoSize;
    const marginRight = anchor?.marginRight;
    const marginBottom = anchor?.marginBottom;
    if ([size, marginRight, marginBottom].every(Number.isFinite)) {
        const x = imageData.width - marginRight - size;
        const y = imageData.height - marginBottom - size;
        if (x >= 0 && y >= 0 && x + size <= imageData.width && y + size <= imageData.height) {
            return { x, y, width: size, height: size };
        }
    }
    return null;
}

function getAcceptedFromAlphaGain(sourceRecord) {
    const strategies = sourceRecord?.decisionPath?.alphaTrial?.acceptedStrategies;
    if (!Array.isArray(strategies)) return null;
    for (let index = strategies.length - 1; index >= 0; index--) {
        const fromAlphaGain = toFiniteNumber(strategies[index]?.fromAlphaGain);
        if (fromAlphaGain !== null) return fromAlphaGain;
    }
    return null;
}

function buildGains(sourceRecord) {
    const gains = new Set(DEFAULT_GAINS);
    const current = toFiniteNumber(sourceRecord?.alphaGain);
    const from = getAcceptedFromAlphaGain(sourceRecord);
    if (current !== null) gains.add(current);
    if (from !== null) gains.add(from);
    return [...gains].filter((gain) => gain > 0).sort((left, right) => left - right);
}

function flagsForScore(score, thresholds) {
    const flags = [];
    if (score.spatialResidual > thresholds.spatialResidual) flags.push('spatial-residual');
    if (score.gradientResidual > thresholds.gradientResidual) flags.push('gradient-residual');
    if (score.positiveHaloLum > thresholds.positiveHaloLum) flags.push('positive-halo');
    if (
        Number.isFinite(score.suppressionGain) &&
        score.suppressionGain < thresholds.minSuppressionGain
    ) {
        flags.push('weak-suppression');
    }
    if (score.damagePenalty > thresholds.damagePenalty) flags.push('damage-penalty');
    if (score.texturePenalty > thresholds.texturePenalty) flags.push('texture-penalty');
    if (score.nearBlackIncrease > thresholds.nearBlackIncrease) flags.push('near-black-increase');
    if (score.newlyClippedRatio > thresholds.newlyClippedRatio) flags.push('newly-clipped');
    if (score.visible === true) flags.push('visible-residual');
    return flags;
}

function summarizeCandidateScore({ trial, visibility }) {
    const spatial = Math.abs(toFiniteNumber(trial.processedSpatialScore) ?? 0);
    const gradient = Math.max(0, toFiniteNumber(trial.processedGradientScore) ?? 0);
    const damage = trial.damage ?? {};
    const score = {
        accepted: trial.accepted === true,
        alphaGain: trial.alphaGain,
        spatialResidual: spatial,
        gradientResidual: gradient,
        suppressionGain: toFiniteNumber(trial.suppressionGain),
        positiveHaloLum: Math.max(0, toFiniteNumber(visibility?.positiveHaloLum) ?? 0),
        visible: visibility?.visible === true,
        damagePenalty: Math.max(0, toFiniteNumber(damage.penalty) ?? 0),
        texturePenalty: Math.max(0, toFiniteNumber(trial.texturePenalty ?? damage.texturePenalty) ?? 0),
        nearBlackIncrease: Math.max(0, toFiniteNumber(trial.nearBlackIncrease ?? damage.nearBlackIncrease) ?? 0),
        newlyClippedRatio: Math.max(0, toFiniteNumber(damage.newlyClippedRatio) ?? 0)
    };
    const strictFlags = flagsForScore(score, STRICT_THRESHOLDS);
    const cleanFlags = flagsForScore(score, CLEAN_THRESHOLDS);
    return {
        ...score,
        strictFlags,
        cleanFlags,
        perfect: strictFlags.length === 0,
        clean: cleanFlags.length === 0,
        cost:
            spatial +
            gradient * 0.6 +
            score.positiveHaloLum * 0.01 +
            score.damagePenalty * 0.4 +
            score.texturePenalty * 0.3 +
            score.nearBlackIncrease * 3
    };
}

function productionScoreFromMonitor(record) {
    const metrics = record.metrics ?? {};
    return {
        alphaGain: null,
        spatialResidual: metrics.residual,
        gradientResidual: metrics.gradient,
        suppressionGain: metrics.suppressionGain,
        positiveHaloLum: metrics.positiveHaloLum,
        visible: metrics.residualVisible,
        damagePenalty: metrics.damagePenalty,
        texturePenalty: metrics.texturePenalty,
        nearBlackIncrease: metrics.nearBlackIncrease,
        newlyClippedRatio: metrics.newlyClippedRatio,
        strictFlags: record.strictFlags ?? [],
        cleanFlags: record.cleanFlags ?? [],
        perfect: record.perfect === true,
        clean: record.clean === true,
        cost:
            (metrics.residual ?? 0) +
            (metrics.gradient ?? 0) * 0.6 +
            (metrics.positiveHaloLum ?? 0) * 0.01 +
            (metrics.damagePenalty ?? 0) * 0.4 +
            (metrics.texturePenalty ?? 0) * 0.3 +
            (metrics.nearBlackIncrease ?? 0) * 3
    };
}

async function analyzeRecord({ queueName, reviewRecord, sourceRecord, alphaMaps }) {
    const imageData = await decodeImageDataInNode(reviewRecord.filePath);
    const position = resolvePosition(sourceRecord, imageData);
    if (!position) {
        return {
            queueName,
            fileName: reviewRecord.fileName,
            error: 'missing-position'
        };
    }
    const config = sourceRecord.actualAnchor ?? sourceRecord.decisionPath?.detectionCandidate?.config ?? null;
    const alphaMap = alphaMaps.getAlphaMap(position.width, config?.alphaVariant ?? null);
    if (!alphaMap) {
        return {
            queueName,
            fileName: reviewRecord.fileName,
            error: 'missing-alpha-map'
        };
    }

    const baselineNearBlackRatio = toFiniteNumber(reviewRecord.metrics?.baselineNearBlackRatio) ?? 0;
    const trials = [];
    for (const alphaGain of buildGains(sourceRecord)) {
        const trial = evaluateRestorationCandidate({
            originalImageData: imageData,
            alphaMap,
            position,
            source: `ablation-direct-alpha-${alphaGain}`,
            config,
            baselineNearBlackRatio,
            alphaGain,
            includeImageData: true,
            provenance: {
                ablation: true,
                catalogVariant: Boolean(config),
                catalogEvidenceGate: 'ablation'
            }
        });
        if (!trial) continue;
        const visibility = assessWatermarkResidualVisibility({
            imageData: trial.imageData,
            position: {
                x: 0,
                y: 0,
                width: position.width,
                height: position.height
            },
            alphaMap
        });
        trials.push({
            name: `direct-alpha-${alphaGain}`,
            ...summarizeCandidateScore({ trial, visibility })
        });
    }

    const production = productionScoreFromMonitor(reviewRecord);
    const currentGain = toFiniteNumber(sourceRecord.alphaGain);
    const fromGain = getAcceptedFromAlphaGain(sourceRecord);
    const currentDirect = trials.find((trial) => trial.alphaGain === currentGain) ?? null;
    const fromDirect = trials.find((trial) => trial.alphaGain === fromGain) ?? null;
    const bestPerfect = selectBest(trials.filter((trial) => trial.perfect));
    const bestClean = selectBest(trials.filter((trial) => trial.clean));
    const bestOverall = selectBest(trials);
    const diagnosis = diagnose({
        production,
        currentDirect,
        fromDirect,
        bestPerfect,
        bestClean,
        bestOverall,
        source: sourceRecord.source ?? ''
    });

    return {
        queueName,
        fileName: reviewRecord.fileName,
        filePath: reviewRecord.filePath,
        source: sourceRecord.source ?? '',
        anchor: config,
        position,
        production,
        currentAlphaGain: currentGain,
        previousAlphaGain: fromGain,
        currentDirect,
        previousDirect: fromDirect,
        bestPerfect,
        bestClean,
        bestOverall,
        diagnosis,
        trials: trials.map((trial) => ({
            name: trial.name,
            alphaGain: trial.alphaGain,
            perfect: trial.perfect,
            clean: trial.clean,
            strictFlags: trial.strictFlags,
            cleanFlags: trial.cleanFlags,
            spatialResidual: round(trial.spatialResidual),
            gradientResidual: round(trial.gradientResidual),
            positiveHaloLum: round(trial.positiveHaloLum, 3),
            damagePenalty: round(trial.damagePenalty, 4),
            texturePenalty: round(trial.texturePenalty, 4),
            nearBlackIncrease: round(trial.nearBlackIncrease, 6),
            suppressionGain: round(trial.suppressionGain),
            cost: round(trial.cost, 4)
        }))
    };
}

function selectBest(trials) {
    return [...trials].sort((left, right) => (
        Number(left.perfect !== true) - Number(right.perfect !== true) ||
        Number(left.clean !== true) - Number(right.clean !== true) ||
        left.cost - right.cost ||
        left.alphaGain - right.alphaGain
    ))[0] ?? null;
}

function diagnose({ production, currentDirect, fromDirect, bestPerfect, bestClean, bestOverall, source }) {
    if (bestPerfect) {
        if (currentDirect?.perfect) {
            return source.includes('edge-cleanup') || source.includes('luma-edge') || source.includes('flat-fill')
                ? 'post-processing-suspect-current-direct-perfect'
                : 'monitor-or-production-path-mismatch-current-direct-perfect';
        }
        if (fromDirect?.perfect) return 'alpha-stage-overfit-previous-gain-perfect';
        if ((bestPerfect.alphaGain ?? 0) < (production.alphaGain ?? Number.POSITIVE_INFINITY)) {
            return 'alpha-too-strong-lower-gain-perfect';
        }
        return 'alpha-grid-has-perfect-candidate';
    }
    if (bestClean) {
        if (fromDirect?.clean) return 'alpha-stage-overfit-previous-gain-clean';
        return 'alpha-grid-has-clean-candidate';
    }
    if (bestOverall && production && bestOverall.cost < production.cost - 0.05) {
        return 'direct-alpha-improves-but-not-clean';
    }
    if (currentDirect && Math.abs(currentDirect.cost - production.cost) <= 0.03) {
        return 'selected-alpha-core-causes-quality-flag';
    }
    return 'no-direct-alpha-improvement';
}

function summarize(records) {
    const countBy = (items, getKey) => {
        const counts = {};
        for (const item of items) {
            const key = getKey(item);
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    };
    const byQueue = {};
    for (const queueName of [...new Set(records.map((record) => record.queueName))]) {
        const scoped = records.filter((record) => record.queueName === queueName);
        byQueue[queueName] = {
            total: scoped.length,
            bestPerfect: scoped.filter((record) => record.bestPerfect).length,
            bestClean: scoped.filter((record) => record.bestClean).length,
            diagnosisCounts: countBy(scoped, (record) => record.diagnosis ?? record.error ?? 'unknown'),
            sourceCounts: countBy(scoped, (record) => record.source || 'null')
        };
    }
    return {
        total: records.length,
        byQueue,
        diagnosisCounts: countBy(records, (record) => record.diagnosis ?? record.error ?? 'unknown'),
        bestPerfectCount: records.filter((record) => record.bestPerfect).length,
        bestCleanCount: records.filter((record) => record.bestClean).length
    };
}

function createMarkdown({ summary, records, outputDir }) {
    const lines = [
        '# Online Quality Ablation Report',
        '',
        `- Output dir: \`${outputDir}\``,
        `- Total: ${summary.total}`,
        `- Best perfect candidates: ${summary.bestPerfectCount}`,
        `- Best clean candidates: ${summary.bestCleanCount}`,
        '',
        '## Diagnosis Counts',
        '',
        ...Object.entries(summary.diagnosisCounts).map(([key, count]) => `- ${key}: ${count}`),
        '',
        '## By Queue',
        ''
    ];
    for (const [queueName, queue] of Object.entries(summary.byQueue)) {
        lines.push(`### ${queueName}`);
        lines.push('');
        lines.push(`- total: ${queue.total}`);
        lines.push(`- best perfect: ${queue.bestPerfect}`);
        lines.push(`- best clean: ${queue.bestClean}`);
        lines.push('- diagnoses:');
        for (const [key, count] of Object.entries(queue.diagnosisCounts)) {
            lines.push(`  - ${key}: ${count}`);
        }
        lines.push('');
    }

    lines.push('## Top Records');
    lines.push('');
    for (const record of records.slice(0, 40)) {
        lines.push(
            `- ${record.queueName} | ${record.fileName} | ${record.diagnosis ?? record.error} | ` +
            `source=${record.source || 'null'} | ` +
            `prodFlags=${(record.production?.strictFlags ?? []).join('+') || 'none'} | ` +
            `bestPerfect=${record.bestPerfect?.alphaGain ?? 'none'} | bestClean=${record.bestClean?.alphaGain ?? 'none'}`
        );
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.outputDir, { recursive: true });
    const currentMonitor = JSON.parse(stripBom(await readFile(args.currentMonitorPath, 'utf8')));
    const baselineMonitor = JSON.parse(stripBom(await readFile(args.baselineMonitorPath, 'utf8')));
    const sourceReport = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    const sourceByFile = new Map((sourceReport.results ?? []).map((record) => [record.fileName, record]));
    const queues = selectQueues({
        currentRecords: currentMonitor.records ?? [],
        baselineRecords: baselineMonitor.records ?? [],
        limit: args.limit
    });
    const alphaMaps = resolveAlphaMaps();
    const records = [];
    for (const [queueName, queueRecords] of Object.entries(queues)) {
        for (let index = 0; index < queueRecords.length; index++) {
            const reviewRecord = queueRecords[index];
            console.log(`[quality-ablation] ${queueName} ${index + 1}/${queueRecords.length} ${reviewRecord.fileName}`);
            const sourceRecord = sourceByFile.get(reviewRecord.fileName);
            records.push(await analyzeRecord({
                queueName,
                reviewRecord,
                sourceRecord,
                alphaMaps
            }));
        }
    }
    const summary = summarize(records);
    const output = {
        generatedAt: new Date().toISOString(),
        currentMonitorPath: args.currentMonitorPath,
        baselineMonitorPath: args.baselineMonitorPath,
        reportPath: args.reportPath,
        limit: args.limit,
        gains: DEFAULT_GAINS,
        thresholds: {
            strict: STRICT_THRESHOLDS,
            clean: CLEAN_THRESHOLDS
        },
        summary,
        records
    };
    await writeFile(path.join(args.outputDir, 'latest.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    await writeFile(path.join(args.outputDir, 'latest.md'), createMarkdown({
        summary,
        records,
        outputDir: args.outputDir
    }), 'utf8');
    console.log(JSON.stringify({
        outputDir: args.outputDir,
        summary
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
