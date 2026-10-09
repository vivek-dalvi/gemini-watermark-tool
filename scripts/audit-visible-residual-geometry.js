import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadLocalEnv } from './local-env.js';
import { runSampleWatermarkScan } from './scan-sample-watermarks.js';

loadLocalEnv();

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/geometry-audit');
const DEFAULT_SAMPLE_ROOT = path.resolve(process.env.GWR_SAMPLE_ROOT || 'sample-files/gemini-watermark');

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR,
        sampleRoot: DEFAULT_SAMPLE_ROOT,
        sourceSet: 'visibleTopPending',
        limit: Infinity
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
            continue;
        }
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || parsed.sampleRoot);
            continue;
        }
        if (arg === '--source-set') {
            parsed.sourceSet = args.shift() || parsed.sourceSet;
            continue;
        }
        if (arg === '--limit') {
            const limit = Number(args.shift());
            if (Number.isFinite(limit) && limit > 0) parsed.limit = Math.floor(limit);
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

async function readJsonWithHash(filePath) {
    const text = stripBom(await readFile(filePath, 'utf8'));
    return {
        value: JSON.parse(text),
        sha256: createHash('sha256').update(text).digest('hex')
    };
}

function toFixedNumber(value, digits = 4) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function geometryKey(candidateOrConfig) {
    if (!candidateOrConfig) return null;
    const size = candidateOrConfig.size ?? candidateOrConfig.logoSize ?? candidateOrConfig.watermarkSize;
    const marginRight = candidateOrConfig.marginRight;
    const marginBottom = candidateOrConfig.marginBottom;
    if (![size, marginRight, marginBottom].every(Number.isFinite)) return null;
    return `${size}/${marginRight}/${marginBottom}`;
}

function parseGeometryKey(key) {
    if (!key) return null;
    const [size, marginRight, marginBottom] = String(key).split('/').map(Number);
    if (![size, marginRight, marginBottom].every(Number.isFinite)) return null;
    return { size, marginRight, marginBottom };
}

function isCatalogGeometryKey(key) {
    return [
        '36/96/96',
        '48/32/32',
        '48/96/96',
        '96/64/64',
        '96/192/192'
    ].includes(key);
}

function isNearbyGeometry(leftKey, rightKey, tolerance = 3) {
    const left = parseGeometryKey(leftKey);
    const right = parseGeometryKey(rightKey);
    if (!left || !right) return false;
    return Math.abs(left.size - right.size) <= tolerance &&
        Math.abs(left.marginRight - right.marginRight) <= tolerance &&
        Math.abs(left.marginBottom - right.marginBottom) <= tolerance;
}

function candidateResidualScore(candidate) {
    const explicitScore = Number(candidate?.residual?.score);
    if (Number.isFinite(explicitScore)) return explicitScore;
    const validationCost = Number(candidate?.validationCost);
    if (Number.isFinite(validationCost)) return validationCost;
    const spatial = Number(candidate?.processedSpatial ?? candidate?.processedSpatialScore ?? candidate?.residual?.spatialResidual);
    const gradient = Number(candidate?.processedGradient ?? candidate?.processedGradientScore ?? candidate?.residual?.gradientResidual);
    if (Number.isFinite(spatial) && Number.isFinite(gradient)) {
        return Math.abs(spatial) + Math.max(0, gradient);
    }
    return null;
}

function isRestorationSafe(candidate) {
    if (!candidate) return false;
    if (typeof candidate.damage?.safe === 'boolean') return candidate.damage.safe;
    if (candidate.hardReject === true) return false;
    const nearBlackIncrease = Number(candidate.nearBlackIncrease ?? candidate.damage?.nearBlackIncrease);
    const texturePenalty = Number(candidate.texturePenalty ?? candidate.damage?.texturePenalty);
    if (Number.isFinite(nearBlackIncrease) && nearBlackIncrease > 0.08) return false;
    if (Number.isFinite(texturePenalty) && texturePenalty > 0.2) return false;
    return true;
}

function restorationSummary(candidate) {
    if (!candidate) return null;
    return {
        key: geometryKey(candidate),
        alphaGain: toFixedNumber(candidate.alphaGain, 3),
        accepted: candidate.accepted ?? null,
        safe: isRestorationSafe(candidate),
        damageReason: candidate.damage?.reason ?? null,
        residualScore: toFixedNumber(candidateResidualScore(candidate)),
        processedSpatial: toFixedNumber(candidate.processedSpatial ?? candidate.processedSpatialScore ?? candidate.residual?.spatial),
        processedGradient: toFixedNumber(candidate.processedGradient ?? candidate.processedGradientScore ?? candidate.residual?.gradient),
        nearBlackIncrease: toFixedNumber(candidate.nearBlackIncrease ?? candidate.damage?.nearBlackIncrease),
        texturePenalty: toFixedNumber(candidate.texturePenalty ?? candidate.damage?.texturePenalty)
    };
}

function pickLowestResidual(candidates) {
    const scored = candidates
        .map((candidate) => ({ candidate, score: candidateResidualScore(candidate) }))
        .filter((entry) => Number.isFinite(entry.score));
    scored.sort((left, right) => left.score - right.score);
    return scored[0]?.candidate ?? null;
}

function summarizeBestEvidenceRestoration({ scanRecord, bestEvidenceKey, selectedValidationCost }) {
    const catalogCandidates = (scanRecord.currentCatalogTop ?? [])
        .filter((candidate) => geometryKey(candidate) === bestEvidenceKey);
    const fallbackBestEvidence = geometryKey(scanRecord.bestEvidence) === bestEvidenceKey
        ? scanRecord.bestEvidence
        : null;
    const candidates = catalogCandidates.length > 0
        ? catalogCandidates
        : [fallbackBestEvidence].filter(Boolean);
    const safeCandidates = candidates.filter((candidate) => isRestorationSafe(candidate));
    const unsafeCandidates = candidates.filter((candidate) => !isRestorationSafe(candidate));
    const bestSafe = pickLowestResidual(safeCandidates);
    const bestUnsafe = pickLowestResidual(unsafeCandidates);
    const bestAny = pickLowestResidual(candidates);
    const bestSafeScore = candidateResidualScore(bestSafe);
    const bestUnsafeScore = candidateResidualScore(bestUnsafe);
    const bestAnyScore = candidateResidualScore(bestAny);
    const safeWorseThanSelected =
        Number.isFinite(bestSafeScore) &&
        Number.isFinite(selectedValidationCost) &&
        bestSafeScore > selectedValidationCost + 0.12;
    const safeResidualStillVisible =
        Number.isFinite(bestSafeScore) &&
        bestSafeScore >= 0.7;
    const unsafeCompetesWithSelected =
        Number.isFinite(bestUnsafeScore) &&
        Number.isFinite(selectedValidationCost) &&
        bestUnsafeScore <= selectedValidationCost + 0.12;

    return {
        candidateCount: candidates.length,
        bestAny: restorationSummary(bestAny),
        bestSafe: restorationSummary(bestSafe),
        bestUnsafe: restorationSummary(bestUnsafe),
        bestAnyScore: toFixedNumber(bestAnyScore),
        bestSafeScore: toFixedNumber(bestSafeScore),
        bestUnsafeScore: toFixedNumber(bestUnsafeScore),
        safeWorseThanSelected,
        safeResidualStillVisible,
        unsafeCompetesWithSelected,
        hasRestorationRisk: Boolean(
            safeWorseThanSelected ||
            safeResidualStillVisible ||
            unsafeCompetesWithSelected ||
            (bestSafe === null && bestUnsafe !== null)
        )
    };
}

function countBy(items, keyFn) {
    const counts = {};
    for (const item of items) {
        const key = keyFn(item) ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]));
}

function classifyGeometryRisk({ manifestRecord, scanRecord }) {
    const selected = scanRecord.selectedGeometry;
    const selectedBest = scanRecord.selectedBestAccepted ?? scanRecord.selectedBestValidation;
    const bestAccepted = scanRecord.bestAccepted;
    const bestEvidence = scanRecord.bestEvidence;
    const bestValidation = scanRecord.bestValidation;
    const selectedKey = geometryKey(selected ?? manifestRecord.config);
    const bestAcceptedKey = geometryKey(bestAccepted);
    const bestEvidenceKey = geometryKey(bestEvidence);
    const bestValidationKey = geometryKey(bestValidation);
    const selectedEvidence = Number(selected?.evidenceScore);
    const bestEvidenceScore = Number(bestEvidence?.evidenceScore);
    const selectedValidationCost = Number(selectedBest?.validationCost);
    const bestValidationCost = Number(bestValidation?.validationCost);
    const evidenceGap = Number.isFinite(selectedEvidence) && Number.isFinite(bestEvidenceScore)
        ? bestEvidenceScore - selectedEvidence
        : null;
    const validationCostGap = Number.isFinite(selectedValidationCost) && Number.isFinite(bestValidationCost)
        ? selectedValidationCost - bestValidationCost
        : null;
    const reasons = [];
    const bestEvidenceRestoration = summarizeBestEvidenceRestoration({
        scanRecord,
        bestEvidenceKey,
        selectedValidationCost
    });

    const selectedProfileLine = String(manifestRecord.review?.profileLine ?? '');
    const selectedIsOtherProfile = selectedProfileLine.endsWith('-other');
    const catalogEvidenceChallenge =
        bestEvidenceKey &&
        selectedKey &&
        bestEvidenceKey !== selectedKey &&
        isCatalogGeometryKey(bestEvidenceKey) &&
        evidenceGap !== null &&
        evidenceGap >= 0.08;
    const strongCatalogEvidenceChallenge = catalogEvidenceChallenge && evidenceGap >= 0.25;
    const catalogValidationChallenge =
        bestValidationKey &&
        selectedKey &&
        bestValidationKey !== selectedKey &&
        isCatalogGeometryKey(bestValidationKey) &&
        validationCostGap !== null &&
        validationCostGap >= 0.12;
    const nearbyAcceptedVariant =
        bestAcceptedKey &&
        selectedKey &&
        bestAcceptedKey !== selectedKey &&
        isNearbyGeometry(bestAcceptedKey, selectedKey);

    if (!selected) reasons.push('selected-geometry-not-scored');
    if (strongCatalogEvidenceChallenge) {
        reasons.push('catalog-evidence-stronger-different-geometry');
    } else if (catalogEvidenceChallenge) {
        reasons.push('catalog-evidence-slightly-stronger-different-geometry');
    }
    if (catalogValidationChallenge) {
        reasons.push('catalog-validation-cheaper-different-geometry');
    }
    if (nearbyAcceptedVariant) {
        reasons.push('nearby-accepted-variant');
    }
    if (selectedIsOtherProfile) {
        reasons.push('non-catalog-local-profile');
    }
    if (bestEvidenceRestoration.safeWorseThanSelected) {
        reasons.push('best-evidence-safe-restoration-worse-than-selected');
    }
    if (bestEvidenceRestoration.safeResidualStillVisible) {
        reasons.push('best-evidence-safe-restoration-still-visible');
    }
    if (bestEvidenceRestoration.unsafeCompetesWithSelected) {
        reasons.push('best-evidence-low-residual-requires-unsafe-damage');
    }

    const selectedNoWorseThanBestValidation =
        Number.isFinite(validationCostGap) &&
        validationCostGap <= 0.03;
    let riskKind = 'none';
    let priority = 'low';
    if (reasons.includes('selected-geometry-not-scored')) {
        riskKind = 'unscored-selected-geometry';
        priority = 'high';
    } else if (
        strongCatalogEvidenceChallenge &&
        bestEvidenceRestoration.hasRestorationRisk
    ) {
        riskKind = selectedIsOtherProfile || nearbyAcceptedVariant || selectedNoWorseThanBestValidation
            ? 'local-profile-safety-tradeoff'
            : 'catalog-evidence-restoration-risk';
        priority = 'medium';
    } else if (
        reasons.includes('catalog-validation-cheaper-different-geometry') ||
        (
            strongCatalogEvidenceChallenge &&
            !bestEvidenceRestoration.hasRestorationRisk
        )
    ) {
        riskKind = 'probable-geometry-mismatch';
        priority = 'high';
    } else if (catalogEvidenceChallenge) {
        riskKind = 'catalog-evidence-review';
        priority = 'medium';
    } else if (nearbyAcceptedVariant || selectedIsOtherProfile) {
        riskKind = 'nearby-local-variant';
        priority = 'medium';
    }

    return {
        priority,
        riskKind,
        reasons,
        selectedKey,
        bestAcceptedKey,
        bestEvidenceKey,
        bestValidationKey,
        evidenceGap: toFixedNumber(evidenceGap),
        validationCostGap: toFixedNumber(validationCostGap),
        selectedValidationCost: toFixedNumber(selectedValidationCost),
        bestValidationCost: toFixedNumber(bestValidationCost),
        bestEvidenceRestoration
    };
}

function buildScanInputRecord({ manifestRecord, sampleRoot }) {
    const input = path.resolve(sampleRoot, manifestRecord.file);
    return {
        input,
        file: manifestRecord.file,
        meta: {
            applied: true,
            source: manifestRecord.source ?? null,
            config: manifestRecord.config ?? null,
            alphaGain: manifestRecord.alphaGain ?? null,
            detection: {
                residualVisibility: manifestRecord.residualVisibility ?? null
            }
        }
    };
}

function markdownTable(rows) {
    const header = '| priority | kind | profile | file | selected | best validation | best evidence | selected cost | best evidence safe cost | reasons | overlay |\n' +
        '|---|---|---|---|---|---|---|---:|---:|---|---|';
    const body = rows.map((record) => {
        const relOverlay = record.overlayPath
            ? path.relative(path.dirname(record.markdownPath), record.overlayPath).replace(/\\/g, '/')
            : '';
        const overlayLink = relOverlay ? `[overlay](${relOverlay})` : '';
        return [
            record.geometryRisk.priority,
            record.geometryRisk.riskKind,
            record.profileLine,
            record.file,
            record.geometryRisk.selectedKey ?? '',
            record.geometryRisk.bestValidationKey ?? record.geometryRisk.bestAcceptedKey ?? '',
            record.geometryRisk.bestEvidenceKey ?? '',
            record.geometryRisk.selectedValidationCost ?? '',
            record.geometryRisk.bestEvidenceRestoration?.bestSafeScore ?? '',
            record.geometryRisk.reasons.join(', '),
            overlayLink
        ].map((value) => String(value).replace(/\|/g, '\\|')).join(' | ');
    }).map((line) => `| ${line} |`);
    return [header, ...body].join('\n');
}

async function writeMarkdownSummary({ outputPath, report }) {
    const rows = report.records
        .filter((record) => record.geometryRisk.priority !== 'low')
        .slice(0, 30)
        .map((record) => ({ ...record, markdownPath: outputPath }));
    const lines = [
        '# Visible Residual Geometry Audit',
        '',
        `generatedAt: \`${report.generatedAt}\``,
        `sourceSet: \`${report.sourceSet}\``,
        `targetCount: \`${report.targetCount}\``,
        '',
        '## Summary',
        '',
        `priorityCounts: \`${JSON.stringify(report.summary.priorityCounts)}\``,
        `riskKindCounts: \`${JSON.stringify(report.summary.riskKindCounts)}\``,
        `profileCounts: \`${JSON.stringify(report.summary.profileCounts)}\``,
        `reasonCounts: \`${JSON.stringify(report.summary.reasonCounts)}\``,
        '',
        '## Geometry Review Queue',
        '',
        rows.length > 0 ? markdownTable(rows) : 'No medium/high geometry risks detected.'
    ];
    await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

export async function runVisibleResidualGeometryAudit(options = {}) {
    const {
        reviewManifestPath = DEFAULT_REVIEW_MANIFEST_PATH,
        outputDir = DEFAULT_OUTPUT_DIR,
        sampleRoot = DEFAULT_SAMPLE_ROOT,
        sourceSet = 'visibleTopPending',
        limit = Infinity
    } = options;

    await mkdir(outputDir, { recursive: true });
    const { value: reviewManifest, sha256: reviewManifestSha256 } = await readJsonWithHash(reviewManifestPath);
    const manifestRecords = (reviewManifest.groups?.[sourceSet] ?? [])
        .slice(0, limit);
    const scanInputRecords = manifestRecords
        .map((manifestRecord) => buildScanInputRecord({ manifestRecord, sampleRoot }))
        .filter((record) => existsSync(record.input));
    const missingFiles = manifestRecords
        .map((manifestRecord) => ({
            file: manifestRecord.file,
            input: path.resolve(sampleRoot, manifestRecord.file)
        }))
        .filter((record) => !existsSync(record.input));
    const scanInputPath = path.join(outputDir, 'scan-input.json');
    await writeFile(scanInputPath, `${JSON.stringify(scanInputRecords, null, 2)}\n`, 'utf8');

    const scanReport = await runSampleWatermarkScan({
        reportPath: scanInputPath,
        outputDir: path.join(outputDir, 'scan'),
        all: true,
        limit: Infinity
    });
    const scanRecordsByInput = new Map(scanReport.records.map((record) => [path.resolve(record.input), record]));
    const records = scanInputRecords.map((scanInputRecord) => {
        const manifestRecord = manifestRecords.find((record) => record.file === scanInputRecord.file);
        const scanRecord = scanRecordsByInput.get(path.resolve(scanInputRecord.input));
        const geometryRisk = classifyGeometryRisk({ manifestRecord, scanRecord });
        return {
            file: manifestRecord.file,
            input: scanInputRecord.input,
            profileLine: manifestRecord.review?.profileLine ?? 'unknown',
            source: manifestRecord.source ?? null,
            config: manifestRecord.config ?? null,
            cropPath: manifestRecord.cropPath ?? null,
            overlayPath: scanRecord?.overlayPath ?? null,
            geometryRisk,
            selectedGeometry: scanRecord?.selectedGeometry ?? null,
            selectedBestAccepted: scanRecord?.selectedBestAccepted ?? null,
            selectedBestValidation: scanRecord?.selectedBestValidation ?? null,
            bestAccepted: scanRecord?.bestAccepted ?? null,
            bestValidation: scanRecord?.bestValidation ?? null,
            bestEvidence: scanRecord?.bestEvidence ?? null,
            currentCatalogTop: scanRecord?.currentCatalogTop ?? []
        };
    });
    const summary = {
        priorityCounts: countBy(records, (record) => record.geometryRisk.priority),
        riskKindCounts: countBy(records, (record) => record.geometryRisk.riskKind),
        profileCounts: countBy(records, (record) => record.profileLine),
        reasonCounts: countBy(
            records.flatMap((record) => record.geometryRisk.reasons),
            (reason) => reason
        ),
        trueGeometryMismatchCandidateCount: records
            .filter((record) => record.geometryRisk.riskKind === 'probable-geometry-mismatch').length,
        catalogEvidenceRestorationRiskCount: records
            .filter((record) => record.geometryRisk.riskKind === 'catalog-evidence-restoration-risk').length,
        localGeometrySafetyTradeoffCount: records
            .filter((record) => record.geometryRisk.riskKind === 'local-profile-safety-tradeoff').length,
        mediumOrHighCount: records.filter((record) => record.geometryRisk.priority !== 'low').length,
        highCount: records.filter((record) => record.geometryRisk.priority === 'high').length,
        missingFileCount: missingFiles.length
    };
    const report = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath,
        reviewManifestSha256,
        outputDir,
        sampleRoot,
        sourceSet,
        targetCount: manifestRecords.length,
        scannedCount: scanInputRecords.length,
        missingFiles,
        scanReportPath: scanReport.jsonPath,
        scanSheetPath: scanReport.sheetPath,
        summary,
        records
    };
    const outputPath = path.join(outputDir, 'geometry-audit.json');
    const markdownPath = path.join(outputDir, 'geometry-audit.md');
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeMarkdownSummary({ outputPath: markdownPath, report });
    return {
        ...report,
        outputPath,
        markdownPath
    };
}

async function runCli() {
    const args = parseArgs(process.argv.slice(2));
    const report = await runVisibleResidualGeometryAudit(args);
    console.log(JSON.stringify({
        outputPath: report.outputPath,
        markdownPath: report.markdownPath,
        scanSheetPath: report.scanSheetPath,
        summary: report.summary
    }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
