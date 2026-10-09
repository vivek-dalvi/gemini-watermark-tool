import { createHash } from 'node:crypto';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { resolveVideoWatermarkCandidates } from '../src/video/videoWatermarkCatalog.js';

const DEFAULT_STRINGS_PATH = path.resolve('.artifacts/allenk-binary-analysis/windows-strings.txt');
const DEFAULT_ZIP_PATH = path.resolve('.artifacts/allenk-binary-analysis/GeminiWatermarkTool-Windows-x64-Video.zip');
const DEFAULT_EXE_PATH = path.resolve('.artifacts/allenk-binary-analysis/windows/GeminiWatermarkTool-Video.exe');
const DEFAULT_DISASSEMBLY_PATHS = Object.freeze([
    path.resolve('.artifacts/allenk-binary-analysis/candidate-search-function-disasm.txt'),
    path.resolve('.artifacts/allenk-binary-analysis/smart-search-function-disasm.txt'),
    path.resolve('.artifacts/allenk-binary-analysis/format-result-functions-disasm.txt')
]);
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/allenk-binary-analysis/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/allenk-binary-analysis/latest-report.md');
const DEFAULT_RELEASE_TAG = 'v0.6.3-demo';

const DIAMOND_VARIANT_PATTERNS = Object.freeze([
    {
        id: 'allenk-binary-video-1080p-standard',
        pattern: /1080p standard \(seed-only\)/,
        tier: '1080p',
        orientation: 'landscape',
        placement: 'standard',
        adaptation: 'seed-only'
    },
    {
        id: 'allenk-binary-video-1080p-landscape-relocated',
        pattern: /1080p landscape relocated \(seed-only\)/,
        tier: '1080p',
        orientation: 'landscape',
        placement: 'relocated',
        adaptation: 'seed-only'
    },
    {
        id: 'allenk-binary-video-1080p-portrait',
        pattern: /1080p portrait \(seed-only\)/,
        tier: '1080p',
        orientation: 'portrait',
        placement: 'standard',
        adaptation: 'seed-only'
    },
    {
        id: 'allenk-binary-video-1080p-portrait-relocated',
        pattern: /1080p portrait relocated \(seed-only\)/,
        tier: '1080p',
        orientation: 'portrait',
        placement: 'relocated',
        adaptation: 'seed-only'
    },
    {
        id: 'allenk-binary-video-720p-1-standard',
        pattern: /720p-1 standard \(per-frame adaptive\)/,
        tier: '720p-1',
        orientation: 'landscape',
        placement: 'standard',
        adaptation: 'per-frame adaptive',
        logoSize: 48,
        bitrateTier: 'low-bitrate'
    },
    {
        id: 'allenk-binary-video-720p-1-portrait',
        pattern: /720p-1 portrait \(per-frame adaptive\)/,
        tier: '720p-1',
        orientation: 'portrait',
        placement: 'standard',
        adaptation: 'per-frame adaptive',
        logoSize: 48,
        bitrateTier: 'low-bitrate'
    },
    {
        id: 'allenk-binary-video-720p-1-portrait-relocated',
        pattern: /720p-1 portrait relocated \(per-frame adaptive\)/,
        tier: '720p-1',
        orientation: 'portrait',
        placement: 'relocated',
        adaptation: 'per-frame adaptive',
        logoSize: 48,
        bitrateTier: 'low-bitrate'
    },
    {
        id: 'allenk-binary-video-720p-2-compact',
        pattern: /720p-2 compact \(per-frame adaptive\)/,
        tier: '720p-2',
        orientation: 'landscape',
        placement: 'compact',
        adaptation: 'per-frame adaptive',
        logoSize: 44,
        bitrateTier: 'high-bitrate'
    },
    {
        id: 'allenk-binary-video-720p-2-compact-portrait',
        pattern: /720p-2 compact portrait \(per-frame adaptive\)/,
        tier: '720p-2',
        orientation: 'portrait',
        placement: 'compact',
        adaptation: 'per-frame adaptive',
        logoSize: 44,
        bitrateTier: 'high-bitrate'
    }
]);

const SMART_SEARCH_PATTERNS = Object.freeze([
    {
        id: 'allenk-binary-video-smart-search-1080-class-relocated',
        pattern: /smart-search relocated 1080-class \(seed-only\)/,
        tier: '1080p',
        placement: 'relocated',
        adaptation: 'seed-only'
    },
    {
        id: 'allenk-binary-video-smart-search-720-class-relocated',
        pattern: /smart-search relocated 720-class \(seed-only\)/,
        tier: '720p',
        placement: 'relocated',
        adaptation: 'seed-only'
    }
]);

const CLI_OPTION_PATTERNS = Object.freeze([
    ['--legacy', /--legacy/],
    ['--mark', /--mark/],
    ['--no-legacy', /--no-legacy/],
    ['--sigma', /--sigma/],
    ['--variant', /--variant/],
    ['--veo', /--veo/],
    ['--veo-alpha', /--veo-alpha/]
]);

function hasPattern(text, pattern) {
    return pattern.test(text);
}

function makeBinaryHint(base) {
    return {
        id: base.id,
        sourceLevel: 'binary-string',
        tier: base.tier,
        orientation: base.orientation,
        placement: base.placement,
        adaptation: base.adaptation,
        ...(Number.isFinite(base.logoSize) ? { logoSize: base.logoSize } : {}),
        ...(base.bitrateTier ? { bitrateTier: base.bitrateTier } : {})
    };
}

export function parseAllenkVideoBinaryHints(stringsText = '') {
    const text = String(stringsText || '');
    const diamondVariants = DIAMOND_VARIANT_PATTERNS
        .filter((variant) => hasPattern(text, variant.pattern))
        .map(makeBinaryHint);
    const smartSearchClasses = SMART_SEARCH_PATTERNS
        .filter((item) => hasPattern(text, item.pattern))
        .map((item) => ({
            id: item.id,
            sourceLevel: 'binary-string',
            tier: item.tier,
            placement: item.placement,
            adaptation: item.adaptation
        }));
    const cliOptions = CLI_OPTION_PATTERNS
        .filter(([, pattern]) => hasPattern(text, pattern))
        .map(([name]) => ({ name, sourceLevel: 'binary-string' }));
    const hasDiamondPath = /process_video_diamond|Gemini diamond|Watermark type:.*diamond/s.test(text);
    const hasVeoTextPath = /process_video_veo_text|Veo text: region|Watermark type:.*veo/s.test(text);
    const watermarkTypes = [
        ...(hasDiamondPath ? [{ id: 'diamond', label: 'Gemini diamond', sourceLevel: 'binary-string' }] : []),
        ...(hasVeoTextPath ? [{ id: 'veo-text', label: "new small 'Veo' text", sourceLevel: 'binary-string' }] : [])
    ];
    const veoText = {
        sourceLevel: hasVeoTextPath ? 'binary-string' : 'not-detected',
        supportedTier: /Veo-text removal supports 720p only/.test(text) ? '720p-only' : 'unknown',
        processFunction: /process_video_veo_text/.test(text) ? 'process_video_veo_text' : null,
        detection: /Veo text: region/.test(text) ? 'template-region-ncc' : 'unknown'
    };

    return {
        diamondVariants,
        smartSearchClasses,
        cliOptions,
        watermarkTypes,
        veoText
    };
}

export function parseAllenkVideoDisassemblyHints(disassemblyText = '') {
    const text = String(disassemblyText || '');
    const hasCandidateMin = /cmp\s+\$0x10,%r15d/.test(text);
    const hasCandidateStep = /add\s+\$0x4,%r15d/.test(text);
    const hasNegativeOffsetStart = /mov\s+\$0xfffffffc,%(?:r14d|ebx)/.test(text);
    const hasPositiveOffsetEnd = /cmp\s+\$0x4,%(?:r14d|ebx)/.test(text);
    const hasMinSupportingFrames = /cmp\s+\$0x3,%esi/.test(text);
    const hasHalfConsensus = /lea\s+\(%rsi,%rsi,1\),%eax[\s\S]*cmp\s+%r15d,%eax/.test(text);
    const smartSwitchBefore = text.match(/cmp\s+\$0x([0-9a-f]+),%edi[\s\S]{0,240}0x142248938/i);
    const smartSwitchAfter = text.match(/0x142248938[\s\S]{0,240}cmp\s+\$0x([0-9a-f]+),%edi/i);
    const smartSwitchMatch = smartSwitchBefore || smartSwitchAfter;

    return {
        sourceLevel: text.trim() ? 'binary-disassembly' : 'not-detected',
        candidateSizeSweep: {
            minCandidateSize: hasCandidateMin ? 16 : null,
            step: hasCandidateStep ? 4 : null
        },
        localRefinement: {
            offsetRadius: hasNegativeOffsetStart && hasPositiveOffsetEnd ? 4 : null,
            evidence: hasNegativeOffsetStart && hasPositiveOffsetEnd ? 'loop-immediates--4-through-4' : 'not-detected'
        },
        frameConsistency: {
            minSupportingFrames: hasMinSupportingFrames ? 3 : null,
            consensusRule: hasHalfConsensus ? 'supportingFrames * 2 >= totalFrames' : 'unknown'
        },
        smartSearchClassSwitch: {
            immediate: smartSwitchMatch ? Number.parseInt(smartSwitchMatch[1], 16) : null,
            interpretation: smartSwitchMatch ? 'near smart-search 720-class string xref; register meaning unproven' : 'not-detected'
        },
        interpretationSafety: 'behavioral-hints-only'
    };
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean))];
}

function inferBinaryVariantResolution(variant) {
    if (!variant) return null;
    if (variant.tier === '1080p') {
        return variant.orientation === 'portrait'
            ? { width: 1080, height: 1920 }
            : { width: 1920, height: 1080 };
    }
    if (variant.tier?.startsWith('720p')) {
        return variant.orientation === 'portrait'
            ? { width: 720, height: 1280 }
            : { width: 1280, height: 720 };
    }
    return null;
}

function inferExpectedLogoSize(variant) {
    if (Number.isFinite(variant?.logoSize)) return variant.logoSize;
    if (variant?.tier === '1080p') return 72;
    return null;
}

function candidateMatchesPlacement(candidate, variant) {
    const id = String(candidate?.id || '').toLowerCase();
    if (variant.placement === 'compact') return id.includes('compact');
    if (variant.placement === 'relocated') return id.includes('relocated') || id.includes('inset');
    if (variant.placement === 'standard') {
        if (id.includes('relocated') || id.includes('inset') || id.includes('compact')) return false;
        return id.includes('standard') || (variant.orientation === 'portrait' && id.includes('portrait'));
    }
    return false;
}

function isConfirmedLocalCandidate(candidate) {
    return candidate?.sourceFamily === 'exact-size-exception' || candidate?.sourceFamily === 'reference-exact';
}

function classifyCoverage({ candidates, placementCandidates, matchingCandidates }) {
    if (!candidates.length) return 'missing-local-candidates';
    if (matchingCandidates.some(isConfirmedLocalCandidate)) return 'covered-with-local-confirmed-candidate';
    if (matchingCandidates.length > 0) return 'covered-by-local-candidate';
    if (placementCandidates.length > 0) return 'covered-by-local-placement-with-different-footprint';
    return 'local-candidates-exist-but-placement-unmapped';
}

export function createAllenkBinaryPriorCoverage({
    binaryHints = {},
    resolveCandidates = resolveVideoWatermarkCandidates
} = {}) {
    return (binaryHints.diamondVariants || []).map((variant) => {
        const resolution = inferBinaryVariantResolution(variant);
        const expectedLogoSize = inferExpectedLogoSize(variant);
        const candidates = resolution ? resolveCandidates(resolution.width, resolution.height) : [];
        const placementCandidates = candidates.filter((candidate) => candidateMatchesPlacement(candidate, variant));
        const matchingCandidates = placementCandidates.filter((candidate) => (
            !Number.isFinite(expectedLogoSize) || candidate.size === expectedLogoSize
        ));
        return {
            variantId: variant.id,
            sourceLevel: variant.sourceLevel,
            tier: variant.tier,
            orientation: variant.orientation,
            placement: variant.placement,
            expectedResolution: resolution ? `${resolution.width}x${resolution.height}` : 'unknown',
            expectedLogoSize,
            candidateCount: candidates.length,
            candidateIds: candidates.map((candidate) => candidate.id),
            placementCandidateIds: placementCandidates.map((candidate) => candidate.id),
            matchingCandidateIds: matchingCandidates.map((candidate) => candidate.id),
            confirmedMatchingCandidateIds: matchingCandidates
                .filter(isConfirmedLocalCandidate)
                .map((candidate) => candidate.id),
            status: classifyCoverage({ candidates, placementCandidates, matchingCandidates })
        };
    });
}

export function createAllenkVideoBinaryAnalysisReport({
    stringsText = '',
    releaseTag = DEFAULT_RELEASE_TAG,
    zipSha256 = null,
    exeSha256 = null,
    stringsPath = DEFAULT_STRINGS_PATH,
    zipPath = DEFAULT_ZIP_PATH,
    exePath = DEFAULT_EXE_PATH,
    disassemblyText = '',
    disassemblyPaths = DEFAULT_DISASSEMBLY_PATHS
} = {}) {
    const hints = parseAllenkVideoBinaryHints(stringsText);
    const disassemblyHints = parseAllenkVideoDisassemblyHints(disassemblyText);
    const binaryPriorCoverage = createAllenkBinaryPriorCoverage({ binaryHints: hints });
    const limitations = [
        'variant names do not expose exact x/y margins in strings',
        'smart-search confirms a fallback class but not its acceptance thresholds',
        'disassembly hints describe search behavior, not confirmed watermark geometry',
        'static strings do not prove runtime branch reachability for every input',
        'binary-derived priors must pass local scorer/residual gates before catalog import'
    ];

    return {
        generatedAt: new Date().toISOString(),
        releaseTag,
        evidence: {
            source: 'static-strings',
            stringsPath,
            zipPath,
            exePath,
            disassemblyPaths,
            zipSha256,
            exeSha256
        },
        hints: {
            ...hints,
            disassembly: disassemblyHints,
            currentCoverage: binaryPriorCoverage
        },
        summary: {
            diamondVariantHints: hints.diamondVariants.length,
            smartSearchHints: hints.smartSearchClasses.length,
            disassemblyHints: disassemblyHints.sourceLevel === 'binary-disassembly' ? 'available' : 'not-detected',
            binaryPriorCoverage: {
                total: binaryPriorCoverage.length,
                coveredWithConfirmedCandidate: binaryPriorCoverage.filter((item) => item.status === 'covered-with-local-confirmed-candidate').length,
                coveredByLocalCandidate: binaryPriorCoverage.filter((item) => item.status === 'covered-by-local-candidate').length,
                differentFootprint: binaryPriorCoverage.filter((item) => item.status === 'covered-by-local-placement-with-different-footprint').length,
                unmappedOrMissing: binaryPriorCoverage.filter((item) => item.status === 'missing-local-candidates' || item.status === 'local-candidates-exist-but-placement-unmapped').length
            },
            cliOptions: hints.cliOptions.map((option) => option.name),
            watermarkTypes: hints.watermarkTypes.map((type) => type.id),
            videoTiers: uniqueStrings(hints.diamondVariants.map((variant) => variant.tier)),
            veoTextSupportedTier: hints.veoText.supportedTier
        },
        limitations,
        recommendation: 'treat-binary-strings-as-priors-until-geometry-is-verified'
    };
}

function renderMarkdown(report) {
    const diamondRows = report.hints.diamondVariants
        .map((variant) => `| ${variant.id} | ${variant.tier} | ${variant.orientation} | ${variant.placement} | ${variant.logoSize ?? '-'} | ${variant.adaptation} |`)
        .join('\n');
    const smartRows = report.hints.smartSearchClasses
        .map((item) => `| ${item.id} | ${item.tier} | ${item.placement} | ${item.adaptation} |`)
        .join('\n');
    const cliRows = report.hints.cliOptions
        .map((option) => `- \`${option.name}\``)
        .join('\n');
    const limitations = report.limitations
        .map((item) => `- ${item}`)
        .join('\n');
    const coverageRows = report.hints.currentCoverage
        .map((item) => `| ${item.variantId} | ${item.expectedResolution} | ${item.expectedLogoSize ?? '-'} | ${item.matchingCandidateIds.join(', ') || '-'} | ${item.status} |`)
        .join('\n');

    return `# Allenk Video Binary Analysis

- Release tag: \`${report.releaseTag}\`
- Evidence source: \`${report.evidence.source}\`
- Zip SHA256: \`${report.evidence.zipSha256 || 'unknown'}\`
- Exe SHA256: \`${report.evidence.exeSha256 || 'unknown'}\`
- Recommendation: \`${report.recommendation}\`

## Diamond Variant Hints

| ID | Tier | Orientation | Placement | Logo | Adaptation |
|---|---|---|---|---:|---|
${diamondRows || '| - | - | - | - | - | - |'}

## Smart Search Hints

| ID | Tier | Placement | Adaptation |
|---|---|---|---|
${smartRows || '| - | - | - | - |'}

## CLI Options

${cliRows || '- No relevant CLI options detected.'}

## Veo Text

- Source level: \`${report.hints.veoText.sourceLevel}\`
- Supported tier: \`${report.hints.veoText.supportedTier}\`
- Process function: \`${report.hints.veoText.processFunction || 'unknown'}\`
- Detection hint: \`${report.hints.veoText.detection}\`

## Disassembly Hints

- Candidate size sweep: min \`${report.hints.disassembly.candidateSizeSweep.minCandidateSize ?? 'unknown'}\`, step \`${report.hints.disassembly.candidateSizeSweep.step ?? 'unknown'}\`
- Local refinement offset radius: \`${report.hints.disassembly.localRefinement.offsetRadius ?? 'unknown'}\`
- Frame consistency: min \`${report.hints.disassembly.frameConsistency.minSupportingFrames ?? 'unknown'}\`, rule \`${report.hints.disassembly.frameConsistency.consensusRule}\`
- Smart-search class switch immediate: \`${report.hints.disassembly.smartSearchClassSwitch.immediate ?? 'unknown'}\`
- Safety: \`${report.hints.disassembly.interpretationSafety}\`

## Current Coverage

| Binary Prior | Expected Size | Logo | Matching Local Candidates | Status |
|---|---|---:|---|---|
${coverageRows || '| - | - | - | - | - |'}

## Limitations

${limitations}
`;
}

function parseCliArgs(argv) {
    const parsed = {
        stringsPath: DEFAULT_STRINGS_PATH,
        zipPath: DEFAULT_ZIP_PATH,
        exePath: DEFAULT_EXE_PATH,
        disassemblyPaths: [...DEFAULT_DISASSEMBLY_PATHS],
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        releaseTag: DEFAULT_RELEASE_TAG
    };
    const args = [...argv];
    while (args.length) {
        const arg = args.shift();
        if (arg === '--') continue;
        if (arg === '--strings') {
            parsed.stringsPath = args.shift() || parsed.stringsPath;
            continue;
        }
        if (arg === '--zip') {
            parsed.zipPath = args.shift() || parsed.zipPath;
            continue;
        }
        if (arg === '--exe') {
            parsed.exePath = args.shift() || parsed.exePath;
            continue;
        }
        if (arg === '--disassembly') {
            parsed.disassemblyPaths.push(path.resolve(args.shift() || ''));
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
        if (arg === '--release-tag') {
            parsed.releaseTag = args.shift() || parsed.releaseTag;
        }
    }
    return parsed;
}

async function sha256File(filePath) {
    if (!filePath) return null;
    return new Promise((resolve) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('error', () => resolve(null));
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

export async function createAllenkVideoBinaryAnalysis(options = {}) {
    const stringsPath = path.resolve(options.stringsPath || DEFAULT_STRINGS_PATH);
    const zipPath = path.resolve(options.zipPath || DEFAULT_ZIP_PATH);
    const exePath = path.resolve(options.exePath || DEFAULT_EXE_PATH);
    const disassemblyPaths = options.disassemblyPaths || DEFAULT_DISASSEMBLY_PATHS;
    const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT_PATH);
    const markdownPath = path.resolve(options.markdownPath || DEFAULT_MARKDOWN_PATH);
    const [stringsText, disassemblyTexts, zipSha256, exeSha256] = await Promise.all([
        readFile(stringsPath, 'utf8'),
        Promise.all(disassemblyPaths.map((item) => readFile(item, 'utf8').catch(() => ''))),
        sha256File(zipPath),
        sha256File(exePath)
    ]);
    const report = createAllenkVideoBinaryAnalysisReport({
        stringsText,
        releaseTag: options.releaseTag || DEFAULT_RELEASE_TAG,
        zipSha256,
        exeSha256,
        stringsPath,
        zipPath,
        exePath,
        disassemblyText: disassemblyTexts.join('\n'),
        disassemblyPaths
    });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(path.dirname(markdownPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownPath, renderMarkdown(report), 'utf8');
    return { ...report, outputPath, markdownPath };
}

async function runCli() {
    const options = parseCliArgs(process.argv.slice(2));
    const report = await createAllenkVideoBinaryAnalysis(options);
    console.log(`report: ${report.outputPath}`);
    console.log(`markdown: ${report.markdownPath}`);
    console.log(`diamond variant hints: ${report.summary.diamondVariantHints}`);
    console.log(`smart-search hints: ${report.summary.smartSearchHints}`);
    console.log(`disassembly hints: ${report.summary.disassemblyHints}`);
    console.log(`Veo text supported tier: ${report.summary.veoTextSupportedTier}`);
    console.log(`recommendation: ${report.recommendation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runCli().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
