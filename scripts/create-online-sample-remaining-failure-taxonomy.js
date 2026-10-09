import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/online-sample-2026-06-23-to-2026-06-24-max500');
const DEFAULT_REPORT_PATH = path.join(DEFAULT_OUTPUT_DIR, 'latest-report-after-rebalance.json');
const DEFAULT_AUDIT_PATH = path.join(DEFAULT_OUTPUT_DIR, 'tier-a-remaining-coverage-audit.json');
const DEFAULT_JSON_PATH = path.join(DEFAULT_OUTPUT_DIR, 'remaining-failures-taxonomy.json');
const DEFAULT_MARKDOWN_PATH = path.join(DEFAULT_OUTPUT_DIR, 'remaining-failures-taxonomy.md');

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        auditPath: DEFAULT_AUDIT_PATH,
        jsonPath: DEFAULT_JSON_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
        } else if (arg === '--audit') {
            parsed.auditPath = path.resolve(args.shift() || parsed.auditPath);
        } else if (arg === '--output') {
            parsed.jsonPath = path.resolve(args.shift() || parsed.jsonPath);
        } else if (arg === '--markdown') {
            parsed.markdownPath = path.resolve(args.shift() || parsed.markdownPath);
        }
    }

    return parsed;
}

function anchorKey(anchor) {
    if (!anchor) return 'none';
    const suffix = anchor.alphaVariant ? `/${anchor.alphaVariant}` : '';
    return `${anchor.logoSize}/${anchor.marginRight}/${anchor.marginBottom}${suffix}`;
}

function round(value, digits = 6) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Number(value.toFixed(digits))
        : null;
}

function clusterKey(failure) {
    return [
        failure.bucket,
        anchorKey(failure.anchor),
        failure.source || 'null'
    ].join('|');
}

function classifyPriority(cluster) {
    if (cluster.bucket === 'missed-detection') return 'P1';
    if (cluster.count >= 2) return 'P1';
    if (cluster.bucket === 'residual-edge') return 'P2';
    return 'P3';
}

function followUp(cluster) {
    if (cluster.bucket === 'missed-detection') {
        return '先复核是否真实 Gemini 水印；代表 sweep 没有生产级证据安全候选时，不应直接放宽检测阈值。';
    }
    if (cluster.anchor.startsWith('96/192/192')) {
        return '继续跟 192 边距大图的 alpha 边缘形状，而不是把 default-alpha 当通用答案。';
    }
    if (cluster.anchor.startsWith('48/96/96')) {
        return '优先检查 48px 大边距样本的 alpha profile / edge cleanup 是否仍有亮边残留。';
    }
    if (cluster.anchor.startsWith('48/32/32')) {
        return '检查 canonical 48px 小边距在高纹理背景下的 located-aggressive 是否过冲或欠抑制。';
    }
    if (cluster.bucket === 'weak-suppression') {
        return '核对定位证据是否足够强；如果原始证据弱，应进入人工/评估层而非自动增强。';
    }
    return '保留为单例追踪，等同类样本增加后再改生产路径。';
}

function summarizeCluster(records) {
    const first = records[0];
    const residuals = records.map((record) => record.residualScore).filter(Number.isFinite);
    const gradients = records.map((record) => record.processedGradientScore).filter(Number.isFinite);
    const originals = records.map((record) => record.originalSpatialScore).filter(Number.isFinite);
    const cluster = {
        key: clusterKey(first),
        bucket: first.bucket,
        anchor: anchorKey(first.anchor),
        source: first.source || 'null',
        count: records.length,
        priority: null,
        residualRange: {
            min: residuals.length ? round(Math.min(...residuals)) : null,
            max: residuals.length ? round(Math.max(...residuals)) : null
        },
        processedGradientRange: {
            min: gradients.length ? round(Math.min(...gradients)) : null,
            max: gradients.length ? round(Math.max(...gradients)) : null
        },
        originalSpatialRange: {
            min: originals.length ? round(Math.min(...originals)) : null,
            max: originals.length ? round(Math.max(...originals)) : null
        },
        examples: records.slice(0, 5).map((record) => ({
            fileName: record.fileName,
            width: record.width,
            height: record.height,
            residualScore: record.residualScore,
            processedGradientScore: record.processedGradientScore,
            originalSpatialScore: record.originalSpatialScore,
            originalGradientScore: record.originalGradientScore,
            alphaGain: record.alphaGain
        }))
    };
    cluster.priority = classifyPriority(cluster);
    cluster.followUp = followUp(cluster);
    return cluster;
}

async function readOptionalJson(filePath) {
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function renderMarkdown(taxonomy) {
    const lines = [
        '# Online Sample Remaining Failure Taxonomy',
        '',
        `- Generated: ${taxonomy.generatedAt}`,
        `- Report: \`${taxonomy.reportPath}\``,
        `- Pass: ${taxonomy.summary.passCount}/${taxonomy.summary.total} (${(taxonomy.summary.successRate * 100).toFixed(2)}%)`,
        `- Remaining failures: ${taxonomy.summary.failCount}`,
        `- Buckets: ${Object.entries(taxonomy.summary.buckets).map(([key, value]) => `${key}=${value}`).join(', ')}`,
        ''
    ];

    if (taxonomy.auditSummary.length > 0) {
        lines.push('## Representative Sweep Evidence');
        lines.push('');
        for (const audit of taxonomy.auditSummary) {
            lines.push(
                `- ${audit.kind}: safe=${audit.safeCandidateCount}, ` +
                `productionEvidenceSafe=${audit.productionEvidenceSafeCandidateCount}, sample=${audit.sample}`
            );
        }
        lines.push('');
    }

    lines.push('## Clusters');
    lines.push('');
    for (const cluster of taxonomy.clusters) {
        lines.push(`### ${cluster.priority} ${cluster.bucket} | ${cluster.anchor}`);
        lines.push(`- count: ${cluster.count}`);
        lines.push(`- source: ${cluster.source}`);
        lines.push(`- residualRange: ${cluster.residualRange.min ?? 'n/a'} ~ ${cluster.residualRange.max ?? 'n/a'}`);
        lines.push(`- processedGradientRange: ${cluster.processedGradientRange.min ?? 'n/a'} ~ ${cluster.processedGradientRange.max ?? 'n/a'}`);
        lines.push(`- followUp: ${cluster.followUp}`);
        lines.push(`- examples: ${cluster.examples.map((example) => example.fileName).join(', ')}`);
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(await readFile(args.reportPath, 'utf8'));
    const audit = await readOptionalJson(args.auditPath);
    const grouped = new Map();

    for (const failure of report.failures ?? []) {
        const key = clusterKey(failure);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(failure);
    }

    const clusters = [...grouped.values()]
        .map(summarizeCluster)
        .sort((left, right) =>
            left.priority.localeCompare(right.priority) ||
            right.count - left.count ||
            left.key.localeCompare(right.key)
        );
    const taxonomy = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        auditPath: audit ? args.auditPath : null,
        summary: report.summary,
        auditSummary: (audit?.audits ?? []).map((item) => ({
            kind: item.kind,
            sample: item.sample,
            safeCandidateCount: item.safeCandidateCount,
            productionEvidenceSafeCandidateCount: item.productionEvidenceSafeCandidateCount
        })),
        clusters
    };

    await mkdir(path.dirname(args.jsonPath), { recursive: true });
    await mkdir(path.dirname(args.markdownPath), { recursive: true });
    await writeFile(args.jsonPath, `${JSON.stringify(taxonomy, null, 2)}\n`, 'utf8');
    await writeFile(args.markdownPath, renderMarkdown(taxonomy), 'utf8');
    console.log(JSON.stringify({
        jsonPath: args.jsonPath,
        markdownPath: args.markdownPath,
        clusters: clusters.map((cluster) => ({
            key: cluster.key,
            count: cluster.count,
            priority: cluster.priority
        }))
    }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
