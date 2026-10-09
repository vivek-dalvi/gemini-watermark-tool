import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { resolveVideoWatermarkCandidates } from '../src/video/videoWatermarkCatalog.js';
import { loadLocalEnv } from './local-env.js';

loadLocalEnv();

const DEFAULT_UPSTREAM_PATH = path.resolve(
    process.env.GWR_ALLENK_ROOT ||
    process.env.ALLENK_GEMINI_WATERMARK_TOOL_DIR ||
    'external/GeminiWatermarkTool'
);
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/allenk-catalog-audit/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/allenk-catalog-audit/latest-report.md');

function hasAll(source, patterns) {
    return patterns.every((pattern) => pattern.test(source));
}

export function parseAllenkImageCatalogFromSource(source = '') {
    const rules = [];

    if (hasAll(source, [/WatermarkVariant::V1|variant == WatermarkVariant::V1|logo_size = 48|logo_size:\s*48/, /margin_right\s*=\s*32|marginRight:\s*32/])) {
        rules.push({
            id: 'allenk-image-v1-small',
            sourceLevel: 'source-backed',
            variant: 'V1',
            condition: 'not both dimensions > 1024',
            logoSize: 48,
            marginRight: 32,
            marginBottom: 32
        });
    }

    if (hasAll(source, [/WatermarkVariant::V1|variant == WatermarkVariant::V1|logo_size = 96|logoSize:\s*96/, /margin_right\s*=\s*64|marginRight:\s*64/])) {
        rules.push({
            id: 'allenk-image-v1-large',
            sourceLevel: 'source-backed',
            variant: 'V1',
            condition: 'both dimensions > 1024',
            logoSize: 96,
            marginRight: 64,
            marginBottom: 64
        });
    }

    if (hasAll(source, [/logo_size\s*=\s*36|logoSize:\s*36/, /192\.0\s*\*\s*scale|192\s*\*\s*scale|round\(192/])) {
        rules.push({
            id: 'allenk-image-v2-small-scaled',
            sourceLevel: 'source-backed',
            variant: 'V2',
            condition: 'not both dimensions > 1024; 1024-class output scaled from canonical large source',
            logoSize: 36,
            marginRule: 'round(192 * scale)'
        });
    }

    if (hasAll(source, [/logo_size\s*=\s*96|logoSize:\s*96/, /margin_right\s*=\s*192|marginRight:\s*192/])) {
        rules.push({
            id: 'allenk-image-v2-large',
            sourceLevel: 'source-backed',
            variant: 'V2',
            condition: 'both dimensions > 1024',
            logoSize: 96,
            marginRight: 192,
            marginBottom: 192
        });
    }

    return { sourceLevel: 'source-backed', rules };
}

function textHasResolution(text, resolution) {
    const [w, h] = resolution.split('x');
    return new RegExp(`${w}\\s*[x×脳]\\s*${h}`).test(text);
}

export function parseAllenkVideoPriorsFromReadme(readme = '') {
    const knownResolutions = [
        ['1920x1080', 'landscape', '1080p'],
        ['1080x1920', 'portrait', '1080p'],
        ['1280x720', 'landscape', '720p'],
        ['720x1280', 'portrait', '720p']
    ]
        .filter(([size]) => textHasResolution(readme, size))
        .map(([size, orientation, tier]) => ({
            size,
            orientation,
            tier,
            sourceLevel: 'readme-prior'
        }));

    const known720pVariants = [];
    if (/720p-1|standard/i.test(readme) && /48\s*[x×脳]\s*48/i.test(readme) && /72\s*,\s*72/.test(readme)) {
        known720pVariants.push({
            id: 'allenk-video-720p-1-standard',
            sourceLevel: 'readme-prior',
            logoSize: 48,
            marginRight: 72,
            marginBottom: 72
        });
    }
    if (/720p-2|compact/i.test(readme) && /44\s*[x×脳]\s*44/i.test(readme) && /29\s*,\s*40/.test(readme)) {
        known720pVariants.push({
            id: 'allenk-video-720p-2-compact',
            sourceLevel: 'readme-prior',
            logoSize: 44,
            marginRight: 29,
            marginBottom: 40
        });
    }

    return {
        sourceLevel: 'readme-prior',
        knownResolutions,
        known720pVariants
    };
}

function parseResolutionSize(size) {
    const match = String(size || '').match(/^(\d+)x(\d+)$/);
    if (!match) return null;
    return {
        width: Number(match[1]),
        height: Number(match[2])
    };
}

export function createCurrentVideoCoverage({
    videoPriors = {},
    resolveCandidates = resolveVideoWatermarkCandidates
} = {}) {
    return (videoPriors.knownResolutions || []).map((prior) => {
        const size = parseResolutionSize(prior.size);
        const candidates = size ? resolveCandidates(size.width, size.height) : [];
        const confirmed = candidates.filter((candidate) => candidate.sourceFamily === 'exact-size-exception');
        let status = 'missing-local-candidates';
        if (confirmed.length > 0) {
            status = 'covered-with-local-confirmed-candidates';
        } else if (candidates.length > 0) {
            status = 'covered-by-projected-candidates-only';
        }
        return {
            size: prior.size,
            upstreamSourceLevel: prior.sourceLevel,
            candidateCount: candidates.length,
            candidateIds: candidates.map((candidate) => candidate.id),
            confirmedCandidateIds: confirmed.map((candidate) => candidate.id),
            status
        };
    });
}

async function listSourceFiles(root) {
    const results = [];
    async function walk(dir) {
        let entries = [];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['.git', 'build', 'external'].includes(entry.name)) continue;
                await walk(fullPath);
                continue;
            }
            if (/\.(cpp|cc|cxx|h|hpp|md|txt)$/i.test(entry.name)) {
                results.push(fullPath);
            }
        }
    }
    await walk(root);
    return results;
}

function findVideoSourceMatches(files = []) {
    return files.filter((filePath) => /video|veo/i.test(filePath));
}

export function createAllenkCatalogAuditReport({
    upstreamPath = DEFAULT_UPSTREAM_PATH,
    imageSource = '',
    videoReadme = '',
    videoSourceMatches = []
} = {}) {
    const imageCatalog = parseAllenkImageCatalogFromSource(imageSource);
    const videoPriors = parseAllenkVideoPriorsFromReadme(videoReadme);
    const currentVideoCoverage = createCurrentVideoCoverage({ videoPriors });
    return {
        generatedAt: new Date().toISOString(),
        upstreamPath,
        imageCatalog,
        videoPriors,
        currentVideoCoverage,
        videoSourceMatches,
        summary: {
            imageSourceBackedRules: imageCatalog.rules.length,
            videoSourceFilesFound: videoSourceMatches.length,
            videoReadmePriors: videoPriors.knownResolutions.length + videoPriors.known720pVariants.length,
            videoPriorResolutionsCovered: currentVideoCoverage.filter((item) => item.candidateCount > 0).length,
            videoPriorResolutionsConfirmed: currentVideoCoverage.filter((item) => item.confirmedCandidateIds.length > 0).length
        },
        recommendation: videoSourceMatches.length > 0
            ? 'inspect-video-source-before-importing-catalog'
            : 'use-video-priors-only-after-local-evidence-gate'
    };
}

function renderMarkdown(report) {
    const imageRows = report.imageCatalog.rules
        .map((rule) => `| ${rule.id} | ${rule.variant} | ${rule.logoSize} | ${rule.marginRight ?? rule.marginRule} | ${rule.marginBottom ?? rule.marginRule} | ${rule.sourceLevel} |`)
        .join('\n');
    const videoRows = [
        ...report.videoPriors.knownResolutions.map((item) => `| ${item.size} | ${item.tier} | ${item.orientation} | resolution only | ${item.sourceLevel} |`),
        ...report.videoPriors.known720pVariants.map((item) => `| 720p variant | ${item.id} | diamond | ${item.logoSize}px, margin ${item.marginRight}/${item.marginBottom} | ${item.sourceLevel} |`)
    ].join('\n');
    const coverageRows = report.currentVideoCoverage
        .map((item) => `| ${item.size} | ${item.candidateCount} | ${item.confirmedCandidateIds.join(', ') || '-'} | ${item.status} |`)
        .join('\n');

    return `# Allenk Catalog Audit

- Upstream path: \`${report.upstreamPath}\`
- Image source-backed rules: ${report.summary.imageSourceBackedRules}
- Video source files found: ${report.summary.videoSourceFilesFound}
- Video README priors: ${report.summary.videoReadmePriors}
- Recommendation: \`${report.recommendation}\`

## Image Rules

| ID | Variant | Logo | Right | Bottom | Source |
|---|---|---:|---|---|---|
${imageRows || '| - | - | - | - | - | - |'}

## Video Priors

| Size/Group | Tier/ID | Orientation/Kind | Spec | Source |
|---|---|---|---|---|
${videoRows || '| - | - | - | - | - |'}

## Current Video Coverage

| Upstream Size | Local Candidates | Local Confirmed | Status |
|---|---:|---|---|
${coverageRows || '| - | - | - | - |'}

## Video Source Matches

${report.videoSourceMatches.length ? report.videoSourceMatches.map((item) => `- \`${item}\``).join('\n') : '- No video source files found in this fork; README video specs stay as priors.'}
`;
}

function parseCliArgs(argv) {
    const parsed = {
        upstreamPath: process.env.GWR_ALLENK_ROOT || process.env.ALLENK_GEMINI_WATERMARK_TOOL_DIR || DEFAULT_UPSTREAM_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH
    };
    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--upstream' || arg === '--repo') {
            parsed.upstreamPath = args.shift() || parsed.upstreamPath;
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = args.shift() || parsed.outputPath;
            continue;
        }
        if (arg === '--markdown') {
            parsed.markdownPath = args.shift() || parsed.markdownPath;
            continue;
        }
    }
    return parsed;
}

export async function createAllenkCatalogAudit(options = {}) {
    const upstreamPath = options.upstreamPath || DEFAULT_UPSTREAM_PATH;
    const imageSourcePath = path.join(upstreamPath, 'src/core/watermark_engine.cpp');
    const readmePath = path.join(upstreamPath, 'README.md');
    const [imageSource, videoReadme, sourceFiles] = await Promise.all([
        readFile(imageSourcePath, 'utf8').catch(() => ''),
        readFile(readmePath, 'utf8').catch(() => ''),
        listSourceFiles(upstreamPath)
    ]);
    const report = createAllenkCatalogAuditReport({
        upstreamPath,
        imageSource,
        videoReadme,
        videoSourceMatches: findVideoSourceMatches(sourceFiles)
    });
    const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
    const markdownPath = path.resolve(options.markdownPath || DEFAULT_MARKDOWN_PATH);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return { ...report, outputPath, markdownPath };
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await createAllenkCatalogAudit(options);
    console.log(`report: ${report.outputPath}`);
    console.log(`markdown: ${report.markdownPath}`);
    console.log(`image source-backed rules: ${report.summary.imageSourceBackedRules}`);
    console.log(`video source files found: ${report.summary.videoSourceFilesFound}`);
    console.log(`video README priors: ${report.summary.videoReadmePriors}`);
    console.log(`recommendation: ${report.recommendation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
