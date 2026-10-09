import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_RENDER_SUMMARY_PATH = path.resolve('.artifacts/visible-residual-crops/latest/summary.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');

const INITIAL_REVIEW_OVERRIDES = Object.freeze({
    '样本2/Gemini_Generated_Image_a1d2x6a1d2x6a1d2.png': {
        verdict: 'trueVisibleResidual',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'centerGrayShadow'],
        profileLine: '48px-large-margin',
        severity: 'medium',
        suggestedNextStep: 'investigate-48-large-margin-alpha-profile',
        notes: 'after ROI raw 和 contrast 中可见稳定星形中心灰影；更像 profile/alpha under-subtraction，不像背景误报。'
    },
    '样本2/Gemini_Generated_Image_6mry9p6mry9p6mry.png': {
        verdict: 'trueVisibleResidual',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'centerGrayShadow'],
        profileLine: '48px-large-margin',
        severity: 'medium',
        suggestedNextStep: 'investigate-48-large-margin-alpha-profile',
        notes: '粉色高亮背景上仍能看到完整星形灰影；edge cleanup 已执行但中心仍残留。'
    },
    '2026-06-09/2064246191004061696-source.png': {
        verdict: 'needsModelInvestigation',
        confidence: 'high',
        residualClasses: ['positiveHalo', 'v2CenterGrayShadow'],
        profileLine: '36px-v2-small',
        severity: 'medium',
        suggestedNextStep: 'investigate-v2-36-forward-render-model',
        notes: 'V2 36 edge cleanup 后边缘指标通过，但中心灰影仍可见；不应继续增强 edge cleanup。'
    },
    '2026-06-08/2064131568774942720-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision'],
        profileLine: '96px-standard',
        severity: 'medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: '残影与漫画线条、对白框和文字边缘重叠；有可见水印形状，但需要 gold 标注区分失败与可容忍内容碰撞。'
    },
    '2026-06-08/2064131957880524800-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision'],
        profileLine: '96px-standard',
        severity: 'medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: '与 2064131568774942720 同类，可能是重复/近重复样本；先归为内容碰撞，不单独推动算法调整。'
    },
    '2026-06-09/2064190955333881856-source.png': {
        verdict: 'contentCollision',
        confidence: 'medium',
        residualClasses: ['positiveHalo', 'contentEdgeCollision', 'largeScaledAnchor'],
        profileLine: '192px-scaled-anchor',
        severity: 'low-medium',
        suggestedNextStep: 'mark-gold-tolerance-before-algorithm-change',
        notes: '水印区域压在大号黑字和高对比背景上；指标为 positive halo，但肉眼判断强依赖内容结构。'
    }
});

function parseArgs(argv) {
    const parsed = {
        renderSummaryPath: DEFAULT_RENDER_SUMMARY_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--summary') {
            parsed.renderSummaryPath = path.resolve(args.shift() || parsed.renderSummaryPath);
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

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

function toFixedNumber(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function collectVisibleReasons(residualVisibility) {
    if (!residualVisibility?.visible) return [];
    return [
        residualVisibility.visiblePositiveHalo ? 'positiveHalo' : null,
        residualVisibility.visibleGradientResidual ? 'gradientResidual' : null,
        residualVisibility.visibleSpatialResidual ? 'spatialResidual' : null
    ].filter(Boolean);
}

function normalizeRecord(record, groupName, review = null) {
    const residualVisibility = record.residualVisibility ?? null;
    return {
        file: record.file,
        group: groupName,
        bucket: record.bucket,
        source: record.source,
        config: record.config ?? null,
        cropPath: record.cropPath,
        metrics: {
            positiveHaloLum: toFixedNumber(residualVisibility?.positiveHaloLum, 3),
            haloVisibility: toFixedNumber(residualVisibility?.haloVisibility, 3),
            gradientResidual: toFixedNumber(residualVisibility?.gradientResidual, 3),
            spatialResidual: toFixedNumber(residualVisibility?.spatialResidual, 3),
            visibleReasons: collectVisibleReasons(residualVisibility)
        },
        review: review ?? {
            verdict: 'pending',
            confidence: 'unknown',
            residualClasses: [],
            profileLine: inferProfileLine(record.config),
            severity: 'unknown',
            suggestedNextStep: 'human-review',
            notes: ''
        }
    };
}

function inferProfileLine(config) {
    if (!config) return 'unknown';
    if (config.logoSize === 36 && config.alphaVariant === 'v2') return '36px-v2-small';
    if (config.logoSize === 48 && config.marginRight === 96 && config.marginBottom === 96) return '48px-large-margin';
    if (config.logoSize === 48 && config.marginRight === 32 && config.marginBottom === 32) return '48px-standard-margin';
    if (config.logoSize === 96 && config.marginRight === 64 && config.marginBottom === 64) return '96px-standard';
    if (config.logoSize === 96 && config.marginRight === 192 && config.marginBottom === 192) return '96px-large-margin';
    if (config.logoSize >= 128) return `${config.logoSize}px-scaled-anchor`;
    return `${config.logoSize}px-other`;
}

function buildReviewManifest(renderSummary, { renderSummaryPath, renderSummarySha256 } = {}) {
    const metricPassVisibleRecords = renderSummary.groups?.metricPassVisible?.records ?? [];
    const visibleTopRecords = renderSummary.groups?.visibleTop?.records ?? [];
    const reviewedFiles = new Set(metricPassVisibleRecords.map((record) => record.file));

    const metricPassVisible = metricPassVisibleRecords.map((record) => {
        const override = INITIAL_REVIEW_OVERRIDES[record.file] ?? null;
        return normalizeRecord(record, 'metricPassVisible', override ? {
            ...override,
            reviewedBy: 'codex-initial-pass',
            reviewStatus: 'needs-human-confirmation'
        } : null);
    });

    const visibleTopPending = visibleTopRecords
        .filter((record) => !reviewedFiles.has(record.file))
        .map((record) => normalizeRecord(record, 'visibleTop'));

    return {
        generatedAt: new Date().toISOString(),
        inputs: {
            renderSummaryPath,
            renderSummarySha256
        },
        sourceRenderSummaryPath: renderSummary.summaryPath ?? DEFAULT_RENDER_SUMMARY_PATH,
        sourceSampleRoot: renderSummary.sampleRoot ?? null,
        reviewSchema: {
            verdicts: [
                'trueVisibleResidual',
                'backgroundStructure',
                'contentCollision',
                'acceptableResidual',
                'needsModelInvestigation',
                'pending'
            ],
            confidence: ['high', 'medium', 'low', 'unknown'],
            note: 'codex-initial-pass 是预填判断，不是正式 gold；进入 gold manifest 前需要人工确认。'
        },
        summary: {
            metricPassVisibleReviewed: metricPassVisible.length,
            visibleTopPending: visibleTopPending.length,
            verdictCounts: countVerdicts(metricPassVisible),
            reviewedProfileCounts: countBy(metricPassVisible, (record) => record.review?.profileLine ?? 'unknown'),
            pendingProfileCounts: countBy(visibleTopPending, (record) => record.review?.profileLine ?? 'unknown'),
            pendingReasonCounts: countReasons(visibleTopPending)
        },
        groups: {
            metricPassVisible,
            visibleTopPending
        },
        workQueues: {
            modelInvestigation: metricPassVisible.filter((record) => (
                record.review?.verdict === 'trueVisibleResidual' ||
                record.review?.verdict === 'needsModelInvestigation'
            )),
            goldToleranceDiscussion: metricPassVisible.filter((record) => (
                record.review?.verdict === 'contentCollision' ||
                record.review?.verdict === 'acceptableResidual'
            )),
            humanReviewNext: visibleTopPending.slice(0, 10)
        },
        nextActions: [
            '人工确认 metricPassVisible 的 6 条预填判断。',
            '把 trueVisibleResidual 与 needsModelInvestigation 样本归入模型研究队列。',
            '把 contentCollision 样本先转为 gold 容忍度讨论，不直接推动算法调整。',
            '确认后再把稳定字段迁移到正式样本 gold manifest。'
        ]
    };
}

function countVerdicts(records) {
    const counts = {};
    for (const record of records) {
        const verdict = record.review?.verdict ?? 'pending';
        counts[verdict] = (counts[verdict] ?? 0) + 1;
    }
    return counts;
}

function countBy(records, resolveKey) {
    const counts = {};
    for (const record of records) {
        const key = resolveKey(record);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

function countReasons(records) {
    const counts = {};
    for (const record of records) {
        for (const reason of record.metrics?.visibleReasons ?? []) {
            counts[reason] = (counts[reason] ?? 0) + 1;
        }
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const renderSummaryText = stripBom(await readFile(args.renderSummaryPath, 'utf8'));
    const renderSummarySha256 = sha256Text(renderSummaryText);
    const renderSummary = JSON.parse(renderSummaryText);
    const manifest = buildReviewManifest(renderSummary, {
        renderSummaryPath: args.renderSummaryPath,
        renderSummarySha256
    });
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        summary: manifest.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
