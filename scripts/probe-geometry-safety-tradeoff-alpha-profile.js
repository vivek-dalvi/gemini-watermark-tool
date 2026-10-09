import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { interpolateAlphaMap } from '../src/core/adaptiveDetector.js';
import { getEmbeddedAlphaMap } from '../src/core/embeddedAlphaMaps.js';
import { removeWatermark } from '../src/core/blendModes.js';
import {
    assessReferenceTextureAlignment,
    assessWatermarkResidualVisibility
} from '../src/core/restorationMetrics.js';
import { decodeImageDataInNode } from './sample-benchmark.js';

const DEFAULT_GEOMETRY_AUDIT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/geometry-audit/geometry-audit.json'
);
const DEFAULT_OUTPUT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-safety-tradeoff-alpha-profile.json'
);
const DEFAULT_RISK_KIND = 'local-profile-safety-tradeoff';
const ALPHA_GAINS = Object.freeze([0.45, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1, 1.15, 1.3]);
const PROFILE_VARIANTS = Object.freeze([
    { name: 'base', type: 'identity' },
    { name: 'edge-dampen-0.82', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.82 },
    { name: 'edge-dampen-0.88', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 0.88 },
    { name: 'edge-boost-1.12', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.12 },
    { name: 'edge-boost-1.24', type: 'band-scale', minAlpha: 0.02, maxAlpha: 0.16, scale: 1.24 },
    { name: 'mid-dampen-0.88', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 0.88 },
    { name: 'mid-boost-1.08', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.08 },
    { name: 'mid-boost-1.16', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.16 },
    { name: 'mid-boost-1.24', type: 'band-scale', minAlpha: 0.12, maxAlpha: 0.42, scale: 1.24 },
    { name: 'core-dampen-0.9', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 0.9 },
    { name: 'core-boost-1.1', type: 'band-scale', minAlpha: 0.24, maxAlpha: 0.78, scale: 1.1 },
    { name: 'power-0.88', type: 'power', exponent: 0.88 },
    { name: 'power-0.94', type: 'power', exponent: 0.94 },
    { name: 'power-1.08', type: 'power', exponent: 1.08 },
    { name: 'blur-mix-0.2', type: 'blur-mix', mix: 0.2 },
    { name: 'blur-mix-0.35', type: 'blur-mix', mix: 0.35 },
    { name: 'sharpen-0.25', type: 'sharpen', amount: 0.25 }
]);
const MAX_SAFE_TEXTURE_PENALTY = 0.2;

function parseArgs(argv) {
    const parsed = {
        geometryAuditPath: DEFAULT_GEOMETRY_AUDIT_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        riskKind: DEFAULT_RISK_KIND,
        sampleRoot: null,
        limit: Infinity
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--geometry-audit') {
            parsed.geometryAuditPath = path.resolve(args.shift() || parsed.geometryAuditPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--risk-kind') {
            parsed.riskKind = args.shift() || parsed.riskKind;
            continue;
        }
        if (arg === '--sample-root') {
            parsed.sampleRoot = path.resolve(args.shift() || '.');
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

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

function round(value, digits = 4) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function parseGeometryKey(key) {
    const [logoSize, marginRight, marginBottom] = String(key ?? '').split('/').map(Number);
    if (![logoSize, marginRight, marginBottom].every(Number.isFinite)) return null;
    return { logoSize, marginRight, marginBottom };
}

function resolvePosition(config, imageData) {
    if (!config) return null;
    const size = config.logoSize ?? config.size;
    const { marginRight, marginBottom } = config;
    if (![size, marginRight, marginBottom].every(Number.isFinite)) return null;
    return {
        x: imageData.width - marginRight - size,
        y: imageData.height - marginBottom - size,
        width: size,
        height: size
    };
}

function buildAlphaResolver() {
    const alpha96 = getEmbeddedAlphaMap(96);
    const cache = new Map([
        [36, getEmbeddedAlphaMap('36-v2')],
        [48, getEmbeddedAlphaMap(48)],
        [96, alpha96],
        ['36-v2', getEmbeddedAlphaMap('36-v2')],
        ['96-20260520', getEmbeddedAlphaMap('96-20260520')]
    ]);

    return (config) => {
        if (!config) return null;
        if (config.alphaVariant) {
            const variantKey = `${config.logoSize}-${config.alphaVariant}`;
            if (cache.has(variantKey)) return cache.get(variantKey);
        }
        if (cache.has(config.logoSize)) return cache.get(config.logoSize);
        const alphaMap = interpolateAlphaMap(alpha96, 96, config.logoSize);
        cache.set(config.logoSize, alphaMap);
        return alphaMap;
    };
}

function clampAlpha(value) {
    return Math.max(0, Math.min(0.99, value));
}

function blurAlphaMap(alphaMap, width, height) {
    const blurred = new Float32Array(alphaMap.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let sum = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const sourceY = y + dy;
                if (sourceY < 0 || sourceY >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const sourceX = x + dx;
                    if (sourceX < 0 || sourceX >= width) continue;
                    sum += alphaMap[sourceY * width + sourceX];
                    count++;
                }
            }
            blurred[y * width + x] = count > 0 ? sum / count : alphaMap[y * width + x];
        }
    }
    return blurred;
}

function transformAlphaMap(alphaMap, width, height, variant) {
    if (variant.type === 'identity') return alphaMap;
    const transformed = new Float32Array(alphaMap.length);
    if (variant.type === 'band-scale') {
        for (let index = 0; index < alphaMap.length; index++) {
            const alpha = alphaMap[index];
            transformed[index] = alpha >= variant.minAlpha && alpha <= variant.maxAlpha
                ? clampAlpha(alpha * variant.scale)
                : alpha;
        }
        return transformed;
    }
    if (variant.type === 'power') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(Math.pow(alphaMap[index], variant.exponent));
        }
        return transformed;
    }

    const blurred = blurAlphaMap(alphaMap, width, height);
    if (variant.type === 'blur-mix') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] * (1 - variant.mix) + blurred[index] * variant.mix);
        }
        return transformed;
    }
    if (variant.type === 'sharpen') {
        for (let index = 0; index < alphaMap.length; index++) {
            transformed[index] = clampAlpha(alphaMap[index] + (alphaMap[index] - blurred[index]) * variant.amount);
        }
        return transformed;
    }
    return alphaMap;
}

function visibilitySeverity(visibility) {
    if (!visibility) return Number.POSITIVE_INFINITY;
    return Math.max(
        visibility.positiveHaloLum ?? 0,
        (visibility.gradientResidual ?? 0) * 80,
        (visibility.spatialResidual ?? 0) * 80
    );
}

function summarizeTrial({
    geometryName,
    config,
    profileName,
    alphaGain,
    candidateImageData,
    originalImageData,
    position,
    assessmentAlphaMap
}) {
    const residualVisibility = assessWatermarkResidualVisibility({
        imageData: candidateImageData,
        position,
        alphaMap: assessmentAlphaMap
    });
    const texture = assessReferenceTextureAlignment({
        originalImageData,
        candidateImageData,
        position
    });
    const hardReject = texture.hardReject === true;
    const texturePenalty = Number(texture.texturePenalty);
    const unsafeTexture =
        Number.isFinite(texturePenalty) &&
        texturePenalty > MAX_SAFE_TEXTURE_PENALTY;
    const unsafeToneShape = texture.tooDark === true && texture.tooFlat === true;
    const safe = !hardReject && !unsafeTexture && !unsafeToneShape;
    return {
        geometryName,
        config,
        profileName,
        alphaGain,
        severity: round(visibilitySeverity(residualVisibility)),
        visible: residualVisibility?.visible === true,
        positiveHaloLum: round(residualVisibility?.positiveHaloLum),
        haloVisibility: round(residualVisibility?.haloVisibility),
        spatialResidual: round(residualVisibility?.spatialResidual),
        gradientResidual: round(residualVisibility?.gradientResidual),
        texturePenalty: round(texturePenalty),
        nearBlackIncrease: round(texture.nearBlackIncrease),
        hardReject,
        tooDark: texture.tooDark === true,
        tooFlat: texture.tooFlat === true,
        safe
    };
}

function probeGeometry({
    geometryName,
    config,
    originalImageData,
    resolveAlphaMap
}) {
    const position = resolvePosition(config, originalImageData);
    const baseAlphaMap = resolveAlphaMap(config);
    if (!position || !baseAlphaMap) {
        return {
            geometryName,
            config,
            error: 'missing-position-or-alpha-map'
        };
    }

    const trials = [];
    for (const variant of PROFILE_VARIANTS) {
        const profileAlphaMap = transformAlphaMap(baseAlphaMap, position.width, position.height, variant);
        for (const alphaGain of ALPHA_GAINS) {
            const candidateImageData = cloneImageData(originalImageData);
            removeWatermark(candidateImageData, profileAlphaMap, position, { alphaGain });
            trials.push(summarizeTrial({
                geometryName,
                config,
                profileName: variant.name,
                alphaGain,
                candidateImageData,
                originalImageData,
                position,
                assessmentAlphaMap: baseAlphaMap
            }));
        }
    }

    const safeTrials = trials.filter((trial) => trial.safe);
    const bySeverity = [...safeTrials].sort((left, right) => left.severity - right.severity);
    const cleared = safeTrials
        .filter((trial) => trial.visible === false)
        .sort((left, right) => left.severity - right.severity);
    const baseTrials = safeTrials
        .filter((trial) => trial.profileName === 'base')
        .sort((left, right) => left.severity - right.severity);

    return {
        geometryName,
        config,
        position,
        bestSafe: bySeverity[0] ?? null,
        bestBaseSafe: baseTrials[0] ?? null,
        bestCleared: cleared[0] ?? null,
        clearedCount: cleared.length,
        safeTrialCount: safeTrials.length,
        topBySeverity: bySeverity.slice(0, 10),
        topCleared: cleared.slice(0, 5)
    };
}

async function probeRecord({ record, sampleRoot, resolveAlphaMap }) {
    const selectedConfig = record.config;
    const bestEvidenceConfig = parseGeometryKey(record.geometryRisk?.bestEvidenceKey);
    const bestValidationConfig = parseGeometryKey(record.geometryRisk?.bestValidationKey);
    const inputPath = path.resolve(sampleRoot, record.file);
    const originalImageData = await decodeImageDataInNode(inputPath);
    const geometries = [
        { geometryName: 'selected-current', config: selectedConfig },
        { geometryName: 'best-validation-local', config: bestValidationConfig },
        { geometryName: 'best-evidence-catalog', config: bestEvidenceConfig }
    ].filter((geometry, index, all) => (
        geometry.config &&
        all.findIndex((other) => (
            other.config?.logoSize === geometry.config.logoSize &&
            other.config?.marginRight === geometry.config.marginRight &&
            other.config?.marginBottom === geometry.config.marginBottom
        )) === index
    ));

    const probes = geometries.map((geometry) => probeGeometry({
        ...geometry,
        originalImageData,
        resolveAlphaMap
    }));
    const selectedProbe = probes.find((probe) => probe.geometryName === 'selected-current');
    const catalogProbe = probes.find((probe) => probe.geometryName === 'best-evidence-catalog');
    const selectedSeverity = Number(selectedProbe?.bestSafe?.severity);
    const catalogSeverity = Number(catalogProbe?.bestSafe?.severity);
    const catalogBaseSeverity = Number(catalogProbe?.bestBaseSafe?.severity);
    const catalogProfileImprovement = Number.isFinite(catalogSeverity) && Number.isFinite(catalogBaseSeverity)
        ? catalogBaseSeverity - catalogSeverity
        : null;
    const catalogBeatsSelected =
        Number.isFinite(catalogSeverity) &&
        Number.isFinite(selectedSeverity) &&
        catalogSeverity + 0.5 < selectedSeverity;

    return {
        file: record.file,
        inputPath,
        profileLine: record.profileLine,
        source: record.source,
        geometryRisk: record.geometryRisk,
        baseline: {
            selectedValidationCost: record.geometryRisk?.selectedValidationCost ?? null,
            bestEvidenceSafeCost: record.geometryRisk?.bestEvidenceRestoration?.bestSafeScore ?? null,
            bestEvidenceUnsafeCost: record.geometryRisk?.bestEvidenceRestoration?.bestUnsafeScore ?? null
        },
        probes,
        conclusion: {
            selectedBestSafeSeverity: round(selectedSeverity),
            catalogBestSafeSeverity: round(catalogSeverity),
            catalogBestBaseSeverity: round(catalogBaseSeverity),
            catalogProfileImprovement: round(catalogProfileImprovement),
            catalogBeatsSelected,
            catalogClearedSafely: Boolean(catalogProbe?.bestCleared),
            selectedClearedSafely: Boolean(selectedProbe?.bestCleared)
        }
    };
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item) ?? 'unknown';
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const geometryAuditText = stripBom(await readFile(args.geometryAuditPath, 'utf8'));
    const geometryAuditSha256 = sha256Text(geometryAuditText);
    const geometryAudit = JSON.parse(geometryAuditText);
    const sampleRoot = args.sampleRoot || geometryAudit.sampleRoot;
    if (!sampleRoot) {
        throw new Error('sampleRoot is required; pass --sample-root or use a geometry audit with sampleRoot');
    }

    const records = (geometryAudit.records ?? [])
        .filter((record) => record.geometryRisk?.riskKind === args.riskKind)
        .slice(0, args.limit);
    const resolveAlphaMap = buildAlphaResolver();
    const probes = [];
    for (const record of records) {
        probes.push(await probeRecord({ record, sampleRoot, resolveAlphaMap }));
    }

    const report = {
        generatedAt: new Date().toISOString(),
        geometryAuditPath: args.geometryAuditPath,
        inputs: {
            geometryAuditPath: args.geometryAuditPath,
            geometryAuditSha256,
            geometryAuditGeneratedAt: geometryAudit.generatedAt ?? null,
            geometryAuditReviewManifestSha256: geometryAudit.reviewManifestSha256 ?? null
        },
        sampleRoot,
        riskKind: args.riskKind,
        alphaGains: ALPHA_GAINS,
        profileVariants: PROFILE_VARIANTS,
        policy: {
            diagnosticOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        summary: {
            total: probes.length,
            catalogBeatsSelected: probes.filter((probe) => probe.conclusion.catalogBeatsSelected).length,
            catalogClearedSafely: probes.filter((probe) => probe.conclusion.catalogClearedSafely).length,
            selectedClearedSafely: probes.filter((probe) => probe.conclusion.selectedClearedSafely).length,
            bestCatalogProfileCounts: countBy(
                probes,
                (probe) => probe.probes.find((item) => item.geometryName === 'best-evidence-catalog')?.bestSafe?.profileName
            ),
            bestCatalogAlphaGainCounts: countBy(
                probes,
                (probe) => String(
                    probe.probes.find((item) => item.geometryName === 'best-evidence-catalog')?.bestSafe?.alphaGain ?? 'none'
                )
            )
        },
        probes
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: report.summary,
        samples: probes.map((probe) => ({
            file: probe.file,
            selected: probe.geometryRisk?.selectedKey,
            bestEvidence: probe.geometryRisk?.bestEvidenceKey,
            conclusion: probe.conclusion,
            bestCatalog: probe.probes.find((item) => item.geometryName === 'best-evidence-catalog')?.bestSafe ?? null,
            bestSelected: probe.probes.find((item) => item.geometryName === 'selected-current')?.bestSafe ?? null
        }))
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
