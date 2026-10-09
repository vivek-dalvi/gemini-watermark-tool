import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkImageReleaseEvidence } from './check-image-release-evidence.js';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/release-readiness/latest-report.json');
const DEFAULT_MARKDOWN_PATH = path.resolve('.artifacts/release-readiness/latest-report.md');

const DEFAULT_INPUTS = Object.freeze({
    packageJson: 'package.json',
    latestExtension: 'release/latest-extension.json',
    userscript: 'dist/userscript/gemini-watermark-remover.user.js',
    visibleResidualLoopSummary: '.artifacts/visible-residual-crops/latest/loop-summary.json',
    visibleResidualGoalAudit: '.artifacts/visible-residual-crops/latest/goal-audit-report.json',
    visibleResidualAdmission: '.artifacts/visible-residual-crops/latest/algorithm-admission-report.json',
    v2CleanupSummary: '.artifacts/sample-files-gemini-watermark-v2-36-cleanup-20260610/summary.json',
    videoCropBenchmark: '.artifacts/video-crop-benchmark/latest-summary.json',
    videoDenoiseGate: '.artifacts/video-denoise-candidate-gate/latest-report.json',
    videoDeliveryGate: '.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json',
    videoReviewPack: '.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json',
    videoAlphaShapeGateRoot: '.artifacts/video-alpha-shape-candidate-gate',
    allenkV2Comparison: '.artifacts/allenk-v2-comparison/latest-report.json',
    allenkRepo: '.artifacts/external-repos/GeminiWatermarkTool',
    videoCleanupBackendsSource: 'src/video/videoCleanupBackends.js',
    videoAppSource: 'src/video-app.js',
    videoPresetPolicySource: 'src/video/videoPresetPolicy.js',
    allenkV2ComparisonScript: 'scripts/create-allenk-v2-comparison-report.js',
    releaseClaimFiles: [
        'README.md',
        'README_zh.md',
        'CHANGELOG.md',
        'CHANGELOG_zh.md',
        'RELEASE.md',
        'RELEASE_zh.md',
        'package.json',
        'release/latest-extension.json'
    ]
});

const RELEASE_BUILD_INPUT_PREFIXES = Object.freeze([
    'bin/',
    'public/',
    'skills/',
    'src/'
]);

const RELEASE_BUILD_INPUT_FILES = Object.freeze([
    'build.js',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/package-extension-release.js'
]);

const REQUIRED_USERSCRIPT_MARKERS = Object.freeze([
    'getActionContextFromIntentGate(intentGate = null, candidate = null)',
    'downloadStickyUntil',
    'DEFAULT_DOWNLOAD_STICKY_WINDOW_MS'
]);

const FORBIDDEN_RELEASE_CLAIM_PATTERNS = Object.freeze([
    {
        id: 'video-allenk-parity',
        claim: 'video-v2-allenk-parity',
        pattern: /(?:video|视频)[\s\S]{0,120}(?:allenk|geminiwatermarktool)[\s\S]{0,120}(?:parity|match(?:es|ed|ing)?|same|equivalent|接近|媲美|同等|相当)/i
    },
    {
        id: 'allenk-video-parity',
        claim: 'video-v2-allenk-parity',
        pattern: /(?:allenk|geminiwatermarktool)[\s\S]{0,120}(?:video|视频)[\s\S]{0,120}(?:parity|match(?:es|ed|ing)?|same|equivalent|接近|媲美|同等|相当)/i
    },
    {
        id: 'video-denoise-default',
        claim: 'new-video-denoise-default',
        pattern: /(?:video|视频)[\s\S]{0,120}(?:denoise|去噪|降噪)[\s\S]{0,120}(?:default|enabled by default|production|ready|默认|生产|启用)/i
    },
    {
        id: 'video-alpha-shape-default',
        claim: 'new-video-alpha-shape-default',
        pattern: /(?:video|视频)[\s\S]{0,120}(?:alpha[ -]?shape|alpha profile|alpha\s*形状|alpha\s*配置)[\s\S]{0,120}(?:default|enabled by default|production|ready|默认|生产|启用)/i
    },
    {
        id: 'broad-image-v2-coverage',
        claim: 'broad-image-v2-coverage',
        pattern: /(?:image|images|图片|图像)[\s\S]{0,80}(?:v2|V2)[\s\S]{0,120}(?:broad|full|all|complete|coverage|covered|supported|全量|广泛|全面|覆盖|支持)[\s\S]{0,120}(?:ready|release|production|default|enabled|可发|发布|生产|默认|启用)/i
    },
    {
        id: 'visible-residual-productionization',
        claim: 'new-visible-residual-alpha-profile-productionization',
        pattern: /(?:visible residual|可见残留|残留)[\s\S]{0,120}(?:alpha[ -]?profile|alpha\s*配置|profile|配置)[\s\S]{0,120}(?:production|default|enabled|ready|生产|默认|启用|可发)/i
    }
]);

const BLOCKED_CAPABILITY_INVARIANTS = Object.freeze({
    'current-image-defaults': {
        blockedClaim: null,
        releaseClaimGuardRequired: false
    },
    'image-v2-36-small-profile': {
        blockedClaim: null,
        releaseClaimGuardRequired: false
    },
    'broad-image-v2-coverage': {
        blockedClaim: 'broad-image-v2-coverage',
        releaseClaimGuardRequired: true
    },
    'visible-residual-alpha-profile-productionization': {
        blockedClaim: 'new-visible-residual-alpha-profile-productionization',
        releaseClaimGuardRequired: true
    },
    'video-v2-allenk-parity': {
        blockedClaim: 'video-v2-allenk-parity',
        releaseClaimGuardRequired: true
    },
    'video-production-defaults': {
        blockedClaim: 'video-production-defaults-unsafe',
        releaseClaimGuardRequired: false
    },
    'video-review-delivery': {
        blockedClaim: null,
        releaseClaimGuardRequired: false
    },
    'video-denoise-default': {
        blockedClaim: 'new-video-denoise-default',
        releaseClaimGuardRequired: true
    },
    'video-alpha-shape-default': {
        blockedClaim: 'new-video-alpha-shape-default',
        releaseClaimGuardRequired: true
    }
});

const BLOCKED_CAPABILITY_DECISIONS = Object.freeze(new Set(['blocked', 'experiment-only']));
const RELEASE_QUALITY_GATE_SCRIPT = 'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready';
const RELEASE_GOAL_AUDIT_SCRIPT = 'node scripts/create-release-goal-audit-report.js';
const RELEASE_CI_CHECK_SCRIPT = 'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed';
const RELEASE_PREFLIGHT_SCRIPT = 'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check';
const RELEASE_READY_RECOMMENDATION = 'rc-current-image-defaults-with-scoped-claims';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePath(inputPath) {
    return path.resolve(inputPath);
}

async function readJsonArtifact(inputPath) {
    const resolved = normalizePath(inputPath);
    try {
        return {
            path: resolved,
            exists: true,
            json: JSON.parse(await readFile(resolved, 'utf8')),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            json: null,
            error: error?.message || String(error)
        };
    }
}

async function readTextArtifact(inputPath) {
    const resolved = normalizePath(inputPath);
    try {
        return {
            path: resolved,
            exists: true,
            text: await readFile(resolved, 'utf8'),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            text: '',
            error: error?.message || String(error)
        };
    }
}

async function readFileArtifact(inputPath) {
    const resolved = normalizePath(inputPath);
    try {
        const text = await readFile(resolved, 'utf8');
        const stats = statSync(resolved);
        return {
            path: resolved,
            exists: true,
            sha256: createHash('sha256').update(text).digest('hex'),
            mtimeUtc: stats.mtime.toISOString(),
            error: null
        };
    } catch (error) {
        return {
            path: resolved,
            exists: false,
            sha256: null,
            mtimeUtc: null,
            error: error?.message || String(error)
        };
    }
}

function createArtifactProvenance(id, artifact) {
    return {
        id,
        path: artifact.path,
        exists: artifact.exists,
        sha256: artifact.sha256 || null,
        mtimeUtc: artifact.mtimeUtc || null,
        error: artifact.error || null
    };
}

function runGit(args, cwd) {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        return null;
    }
}

function parseGitStatus(statusText = '') {
    return String(statusText || '')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => {
            const status = line.slice(0, 2);
            const rawPath = line.slice(3);
            const normalizedPath = rawPath.includes(' -> ')
                ? rawPath.split(' -> ').at(-1)
                : rawPath;
            return {
                status,
                path: normalizedPath.replaceAll('\\', '/')
            };
        });
}

function isReleaseBuildInputPath(filePath) {
    const normalized = filePath.replaceAll('\\', '/');
    return RELEASE_BUILD_INPUT_FILES.includes(normalized) ||
        RELEASE_BUILD_INPUT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function getPathMtimeMs(filePath, mtimeOverrides = {}) {
    const normalized = String(filePath || '').replaceAll('\\', '/');
    const resolved = path.resolve(filePath);
    if (Number.isFinite(mtimeOverrides[normalized])) return mtimeOverrides[normalized];
    if (Number.isFinite(mtimeOverrides[resolved])) return mtimeOverrides[resolved];
    try {
        return statSync(resolved).mtimeMs;
    } catch {
        return null;
    }
}

function readSha256File(shaFilePath) {
    try {
        const text = readFileSync(shaFilePath, 'utf8').trim();
        const [hash, fileName] = text.split(/\s+/);
        return {
            text,
            hash: /^[a-f0-9]{64}$/i.test(hash || '') ? hash.toLowerCase() : null,
            fileName: fileName || null
        };
    } catch {
        return {
            text: null,
            hash: null,
            fileName: null
        };
    }
}

function summarizeZipIntegrity({ zipPath, shaFilePath, latest }) {
    const zipExists = Boolean(zipPath && existsSync(zipPath));
    const shaFileExists = Boolean(shaFilePath && existsSync(shaFilePath));
    const actualSize = zipExists ? statSync(zipPath).size : null;
    const actualSha256 = zipExists
        ? createHash('sha256').update(readFileSync(zipPath)).digest('hex')
        : null;
    const metadataSize = Number.isFinite(Number(latest?.size)) ? Number(latest.size) : null;
    const metadataSha256 = typeof latest?.sha256 === 'string'
        ? latest.sha256.toLowerCase()
        : null;
    const shaFile = shaFileExists ? readSha256File(shaFilePath) : { text: null, hash: null, fileName: null };
    const zipFileName = zipPath ? path.basename(zipPath) : null;

    return {
        zipPath,
        shaFilePath,
        zipExists,
        shaFileExists,
        actualSize,
        metadataSize,
        sizeMatchesMetadata: zipExists && metadataSize !== null && actualSize === metadataSize,
        actualSha256,
        metadataSha256,
        shaMatchesMetadata: Boolean(actualSha256 && metadataSha256 && actualSha256 === metadataSha256),
        shaFileHash: shaFile.hash,
        shaFileName: shaFile.fileName,
        shaFileMatchesZip: Boolean(actualSha256 && shaFile.hash && actualSha256 === shaFile.hash),
        shaFileNameMatchesZip: !shaFile.fileName || shaFile.fileName === zipFileName
    };
}

function summarizeGitReleaseFreshness({
    gitStatusText = null,
    zipPath = null,
    mtimeOverrides = {}
} = {}) {
    const statusText = gitStatusText ?? runGit(['status', '--short'], process.cwd());
    const entries = statusText === null ? null : parseGitStatus(statusText);
    const buildInputDirtyPaths = entries
        ? entries.filter((entry) => isReleaseBuildInputPath(entry.path)).map((entry) => entry.path)
        : [];
    const releaseArtifactDirtyPaths = entries
        ? entries.filter((entry) => entry.path.startsWith('release/')).map((entry) => entry.path)
        : [];
    const zipMtimeMs = zipPath && existsSync(zipPath) ? getPathMtimeMs(zipPath, mtimeOverrides) : null;
    const newestBuildInputMtimeMs = buildInputDirtyPaths
        .map((dirtyPath) => getPathMtimeMs(dirtyPath, mtimeOverrides))
        .filter((mtime) => mtime !== null)
        .reduce((max, mtime) => Math.max(max, mtime), 0);

    return {
        gitStatusAvailable: entries !== null,
        dirtyPathCount: entries ? entries.length : null,
        buildInputDirtyPaths,
        releaseArtifactDirtyPaths,
        zipMtimeUtc: zipMtimeMs ? new Date(zipMtimeMs).toISOString() : null,
        newestDirtyBuildInputMtimeUtc: newestBuildInputMtimeMs
            ? new Date(newestBuildInputMtimeMs).toISOString()
            : null,
        dirtyBuildInputsNewerThanZip: Boolean(zipMtimeMs && newestBuildInputMtimeMs && newestBuildInputMtimeMs > zipMtimeMs)
    };
}

function summarizePackage(packageArtifact, latestExtensionArtifact, { gitStatusText = null, mtimeOverrides = {} } = {}) {
    const pkg = packageArtifact.json || {};
    const latest = latestExtensionArtifact.json || {};
    const packageVersion = pkg.version || null;
    const extensionVersion = latest.version || null;
    const extensionFile = latest.file || null;
    const extensionFileExists = extensionFile
        ? existsSync(path.resolve(path.dirname(latestExtensionArtifact.path), extensionFile))
        : false;
    const extensionZipPath = extensionFile
        ? path.resolve(path.dirname(latestExtensionArtifact.path), extensionFile)
        : null;
    const shaFilePath = extensionFile
        ? path.resolve(path.dirname(latestExtensionArtifact.path), `${extensionFile}.sha256.txt`)
        : null;
    const shaFileExists = shaFilePath ? existsSync(shaFilePath) : false;
    const zipIntegrity = summarizeZipIntegrity({
        zipPath: extensionZipPath,
        shaFilePath,
        latest
    });
    const releaseReadinessScriptReady = pkg.scripts?.['release:readiness'] === 'node scripts/create-release-readiness-report.js';
    const allenkV2ComparisonScriptReady = pkg.scripts?.['compare:allenk-v2'] === 'node scripts/create-allenk-v2-comparison-report.js';
    const releaseQualityGateScriptReady = pkg.scripts?.['release:quality-gate'] === RELEASE_QUALITY_GATE_SCRIPT;
    const releaseGoalAuditScriptReady = pkg.scripts?.['release:goal-audit'] === RELEASE_GOAL_AUDIT_SCRIPT;
    const releaseCiCheckScriptReady = pkg.scripts?.['release:ci-check'] === RELEASE_CI_CHECK_SCRIPT;
    const releasePreflightScriptReady = pkg.scripts?.['release:preflight'] === RELEASE_PREFLIGHT_SCRIPT;
    const releaseFreshness = summarizeGitReleaseFreshness({
        gitStatusText,
        zipPath: extensionZipPath,
        mtimeOverrides
    });

    const blockers = [];
    if (!packageArtifact.exists) blockers.push('package-json-missing');
    if (!latestExtensionArtifact.exists) blockers.push('latest-extension-json-missing');
    if (packageVersion && extensionVersion && packageVersion !== extensionVersion) {
        blockers.push('package-extension-version-mismatch');
    }
    if (!extensionFileExists) blockers.push('extension-zip-missing');
    if (!shaFileExists) blockers.push('extension-sha256-missing');
    if (extensionFileExists && zipIntegrity.sizeMatchesMetadata === false) blockers.push('extension-size-mismatch');
    if (extensionFileExists && zipIntegrity.shaMatchesMetadata === false) blockers.push('extension-sha256-metadata-mismatch');
    if (shaFileExists && zipIntegrity.shaFileMatchesZip === false) blockers.push('extension-sha256-file-mismatch');
    if (shaFileExists && zipIntegrity.shaFileNameMatchesZip === false) blockers.push('extension-sha256-file-name-mismatch');
    if (!releaseReadinessScriptReady) blockers.push('release-readiness-script-missing');
    if (!allenkV2ComparisonScriptReady) blockers.push('allenk-v2-comparison-script-missing');
    if (!releaseQualityGateScriptReady) blockers.push('release-quality-gate-script-missing');
    if (!releaseGoalAuditScriptReady) blockers.push('release-goal-audit-script-missing');
    if (!releaseCiCheckScriptReady) blockers.push('release-ci-check-script-missing');
    if (!releasePreflightScriptReady) blockers.push('release-preflight-script-missing');
    if (!releaseFreshness.gitStatusAvailable) blockers.push('git-status-unavailable');
    if (releaseFreshness.dirtyBuildInputsNewerThanZip) blockers.push('release-build-inputs-dirty-rebuild-required');

    return {
        id: 'release-artifact',
        title: 'Release artifact',
        status: blockers.includes('release-build-inputs-dirty-rebuild-required')
            ? 'needs-rebuild'
            : blockers.length === 0
                ? 'ready'
                : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: {
            packageJsonPath: packageArtifact.path,
            latestExtensionPath: latestExtensionArtifact.path,
            packageVersion,
            extensionVersion,
            extensionFile,
            extensionFileExists,
            shaFileExists,
            zipIntegrity,
            scriptReady: releaseReadinessScriptReady,
            releaseReadinessScriptReady,
            allenkV2ComparisonScriptReady,
            releaseQualityGateScriptReady,
            releaseGoalAuditScriptReady,
            releaseCiCheckScriptReady,
            releasePreflightScriptReady,
            releaseFreshness
        },
        releaseNotes: releaseFreshness.dirtyBuildInputsNewerThanZip
            ? [
                '当前存在 dirty release build inputs；发布前需要重新运行 build/package，并刷新 release artifact。',
                '该状态不否定算法能力边界，只表示现有 zip 不能作为最终待发包。'
            ]
            : releaseFreshness.buildInputDirtyPaths.length > 0
                ? [
                    '当前存在 dirty release build inputs，但 release zip 不早于这些输入；仍需保留 dirty path 审计记录。',
                    '若后续继续修改构建输入，需要重新 build/package 并刷新 readiness。'
                ]
            : [
                'release zip、sha256 和 latest metadata 当前存在且版本一致。'
            ]
    };
}

function parseUserscriptMetadata(text = '') {
    const metadata = {};
    const match = text.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
    if (!match) return metadata;
    for (const line of match[1].split(/\r?\n/)) {
        const item = line.match(/^\s*\/\/\s+@(\S+)\s+(.+?)\s*$/);
        if (!item) continue;
        metadata[item[1]] = item[2];
    }
    return metadata;
}

function summarizeUserscriptArtifact(userscriptArtifact, packageArtifact, { mtimeOverrides = {} } = {}) {
    const pkg = packageArtifact.json || {};
    const text = userscriptArtifact.text || '';
    const metadata = parseUserscriptMetadata(text);
    const userscriptMtimeMs = userscriptArtifact.exists ? getPathMtimeMs(userscriptArtifact.path, mtimeOverrides) : null;
    const packageMtimeMs = packageArtifact.exists ? getPathMtimeMs(packageArtifact.path, mtimeOverrides) : null;
    const missingMarkers = REQUIRED_USERSCRIPT_MARKERS.filter((marker) => !text.includes(marker));
    const blockers = [];

    if (!userscriptArtifact.exists) blockers.push('userscript-artifact-missing');
    if (userscriptArtifact.exists && metadata.version !== pkg.version) blockers.push('userscript-version-mismatch');
    if (!metadata.downloadURL?.includes('gemini-watermark-remover.user.js')) blockers.push('userscript-download-url-missing');
    if (!metadata.updateURL?.includes('gemini-watermark-remover.user.js')) blockers.push('userscript-update-url-missing');
    if (missingMarkers.length > 0) blockers.push('userscript-required-runtime-markers-missing');
    if (userscriptMtimeMs && packageMtimeMs && userscriptMtimeMs < packageMtimeMs) {
        blockers.push('userscript-older-than-package-json');
    }

    return {
        id: 'userscript-artifact',
        title: 'Userscript artifact',
        status: blockers.length === 0 ? 'ready' : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: {
            path: userscriptArtifact.path,
            exists: userscriptArtifact.exists,
            packageVersion: pkg.version || null,
            userscriptVersion: metadata.version || null,
            downloadURL: metadata.downloadURL || null,
            updateURL: metadata.updateURL || null,
            userscriptMtimeUtc: userscriptMtimeMs ? new Date(userscriptMtimeMs).toISOString() : null,
            packageJsonMtimeUtc: packageMtimeMs ? new Date(packageMtimeMs).toISOString() : null,
            requiredMarkers: REQUIRED_USERSCRIPT_MARKERS,
            missingMarkers
        },
        releaseNotes: blockers.length === 0
            ? [
                'userscript artifact exists, version matches package.json, hosted update metadata is present, and request-layer runtime markers are included.'
            ]
            : [
                'userscript artifact is not ready for release; rebuild and verify metadata before publishing scoped RC assets.'
            ]
    };
}

async function summarizeReleaseVersionDocs(packageArtifact, {
    changelogEn = 'CHANGELOG.md',
    changelogZh = 'CHANGELOG_zh.md',
    releaseEn = 'RELEASE.md',
    releaseZh = 'RELEASE_zh.md'
} = {}) {
    const pkg = packageArtifact.json || {};
    const artifacts = {
        changelogEn: await readTextArtifact(changelogEn),
        changelogZh: await readTextArtifact(changelogZh),
        releaseEn: await readTextArtifact(releaseEn),
        releaseZh: await readTextArtifact(releaseZh)
    };
    const version = pkg.version || null;
    const versionHeadingPattern = version ? new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+-\\s+`, 'm') : null;
    const checks = {
        changelogEnHasVersion: Boolean(versionHeadingPattern && versionHeadingPattern.test(artifacts.changelogEn.text)),
        changelogZhHasVersion: Boolean(versionHeadingPattern && versionHeadingPattern.test(artifacts.changelogZh.text)),
        releaseEnMentionsBothChangelogs: /CHANGELOG\.md/.test(artifacts.releaseEn.text) && /CHANGELOG_zh\.md/.test(artifacts.releaseEn.text),
        releaseZhMentionsBothChangelogs: /CHANGELOG\.md/.test(artifacts.releaseZh.text) && /CHANGELOG_zh\.md/.test(artifacts.releaseZh.text),
        releaseEnMentionsExtensionPackage: /pnpm package:extension/.test(artifacts.releaseEn.text) && /latest-extension\.json/.test(artifacts.releaseEn.text),
        releaseZhMentionsExtensionPackage: /pnpm package:extension/.test(artifacts.releaseZh.text) && /latest-extension\.json/.test(artifacts.releaseZh.text),
        releaseEnMentionsInternalComparisonGate: /internal comparison gate/i.test(artifacts.releaseEn.text),
        releaseZhMentionsInternalComparisonGate: /内部对比 gate/.test(artifacts.releaseZh.text),
        releaseEnMentionsInternalComparisonFailGate: /release:image-quality-gate/.test(artifacts.releaseEn.text) && /image-defaults/.test(artifacts.releaseEn.text),
        releaseZhMentionsInternalComparisonFailGate: /release:image-quality-gate/.test(artifacts.releaseZh.text) && /image-defaults/.test(artifacts.releaseZh.text),
        releaseEnMentionsReadinessGate: /pnpm release:readiness/.test(artifacts.releaseEn.text),
        releaseZhMentionsReadinessGate: /pnpm release:readiness/.test(artifacts.releaseZh.text),
        releaseEnMentionsReadinessFailGate: /--fail-on-not-ready/.test(artifacts.releaseEn.text),
        releaseZhMentionsReadinessFailGate: /--fail-on-not-ready/.test(artifacts.releaseZh.text),
        releaseEnMentionsQualityGate: /pnpm release:quality-gate/.test(artifacts.releaseEn.text),
        releaseZhMentionsQualityGate: /pnpm release:quality-gate/.test(artifacts.releaseZh.text),
        releaseEnMentionsPreflight: /pnpm release:preflight/.test(artifacts.releaseEn.text),
        releaseZhMentionsPreflight: /pnpm release:preflight/.test(artifacts.releaseZh.text),
        releaseEnMentionsClaimMatrix: /Release Claim Matrix/.test(artifacts.releaseEn.text),
        releaseZhMentionsClaimMatrix: /Release Claim Matrix/.test(artifacts.releaseZh.text),
        releaseEnMentionsAllowedClaimRows: /allowed-scoped/.test(artifacts.releaseEn.text) && /allowed-safety-only/.test(artifacts.releaseEn.text),
        releaseZhMentionsAllowedClaimRows: /allowed-scoped/.test(artifacts.releaseZh.text) && /allowed-safety-only/.test(artifacts.releaseZh.text),
        releaseEnMentionsNonPublicClaimRows: /review-only/.test(artifacts.releaseEn.text) && /experiment-only/.test(artifacts.releaseEn.text) && /forbidden/.test(artifacts.releaseEn.text),
        releaseZhMentionsNonPublicClaimRows: /review-only/.test(artifacts.releaseZh.text) && /experiment-only/.test(artifacts.releaseZh.text) && /forbidden/.test(artifacts.releaseZh.text)
    };
    const blockers = [];
    for (const [key, artifact] of Object.entries(artifacts)) {
        if (!artifact.exists) blockers.push(`${key}-missing`);
    }
    for (const [key, ok] of Object.entries(checks)) {
        if (!ok) blockers.push(`${key}-missing`);
    }

    return {
        id: 'release-version-docs',
        title: 'Release version docs',
        status: blockers.length === 0 ? 'ready' : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: {
            packageVersion: version,
            paths: Object.fromEntries(Object.entries(artifacts).map(([key, artifact]) => [key, artifact.path])),
            checks
        },
        releaseNotes: blockers.length === 0
            ? [
                '当前 package version 已记录在中英文 changelog，release checklist 覆盖 changelog、extension package artifact、内部对比 gate、release readiness gate、一键 release preflight / quality gate 与 Release Claim Matrix。'
            ]
            : [
                '版本文档或发版清单未覆盖当前版本；发布前需要补齐 changelog / release checklist。'
            ]
    };
}

function summarizeVisibleResidual(loopArtifact, auditArtifact, admissionArtifact) {
    const loop = loopArtifact.json || {};
    const audit = auditArtifact.json || {};
    const admission = admissionArtifact.json || {};
    const loopSummary = loop.summary || {};
    const auditSummary = audit.summary || {};
    const admissionSummary = admission.summary || {};

    const requiredArtifactsPresent = loopArtifact.exists && auditArtifact.exists && admissionArtifact.exists;
    const productionProfileAllowed = loopSummary.productionProfileAllowed === true ||
        auditSummary.productionProfileAllowed === true ||
        admission.productionProfileAdmission?.allowed === true;
    const humanReviewIncomplete = loopSummary.readyForGoldMigration === false ||
        auditSummary.readyForGoldMigration === false ||
        admission.humanGate?.readyForGoldMigration === false;
    const gateContractReady = loopSummary.productionGateContractReady === true &&
        loopSummary.packageScriptGateReady === true;
    const noProductionMutation = productionProfileAllowed === false &&
        Number(loopSummary.productionHitCount || 0) === 0 &&
        Number(loopSummary.productionArtifactHitCount || 0) === 0;

    const blockers = [];
    if (!requiredArtifactsPresent) blockers.push('visible-residual-artifact-missing');
    if (!gateContractReady) blockers.push('visible-residual-production-gate-contract-not-ready');
    if (productionProfileAllowed) blockers.push('visible-residual-production-profile-allowed-unexpectedly');
    if (!noProductionMutation) blockers.push('visible-residual-production-mutation-detected');
    if (humanReviewIncomplete) blockers.push('visible-residual-human-review-incomplete');

    return {
        id: 'image-visible-residual',
        title: 'Image visible residual / alpha profile admission',
        status: blockers.filter((item) => item !== 'visible-residual-human-review-incomplete').length === 0
            ? 'safe-to-release-current-defaults'
            : 'blocked',
        releaseEligible: requiredArtifactsPresent && gateContractReady && noProductionMutation,
        productionChangeAllowed: false,
        blockers,
        evidence: {
            loopSummaryPath: loopArtifact.path,
            goalAuditPath: auditArtifact.path,
            admissionPath: admissionArtifact.path,
            readyForGoldMigration: loopSummary.readyForGoldMigration ?? auditSummary.readyForGoldMigration ?? null,
            unconfirmedCount: loopSummary.unconfirmedCount ?? auditSummary.unconfirmedCount ?? null,
            structuralErrorCount: loopSummary.structuralErrorCount ?? auditSummary.structuralErrorCount ?? null,
            readyDecisionCount: auditSummary.readyDecisionCount ?? admission.humanGate?.readyDecisionCount ?? null,
            pendingHumanReview: admissionSummary.pendingHumanReview ?? admission.humanGate?.pendingTotal ?? null,
            goldCandidateTotal: admission.humanGate?.goldCandidateTotal ?? auditSummary.goldCandidateUnconfirmedCount ?? null,
            goldCandidateUnconfirmedCount: auditSummary.goldCandidateUnconfirmedCount ?? null,
            topReviewCluster: auditSummary.topReviewCluster || null,
            nextGoldCandidateReviewCluster: auditSummary.nextGoldCandidateReviewCluster || null,
            reviewBatchCount: auditSummary.reviewBatchCount ?? null,
            reviewBatchTotal: auditSummary.reviewBatchTotal ?? null,
            focusedReviewBatchDecisionCount: auditSummary.focusedReviewBatchDecisionCount ?? null,
            reviewManifestSha256: loopSummary.reviewManifestSha256 ?? auditSummary.reviewManifestSha256 ?? null,
            focusedReviewBatchSha256: auditSummary.focusedReviewBatchSha256 ?? null,
            humanReviewPackArtifactHashesReady: auditSummary.humanReviewPackArtifactHashesReady ?? null,
            goldManifestExists: loopSummary.goldManifestExists ?? auditSummary.goldManifestExists ?? null,
            goldManifestIntegrityReady: auditSummary.goldManifestIntegrityReady ?? admission.goldManifestIntegrity?.ok ?? null,
            productionProfileAllowed,
            productionGateContractReady: loopSummary.productionGateContractReady ?? null,
            packageScriptGateReady: loopSummary.packageScriptGateReady ?? null,
            productionHitCount: loopSummary.productionHitCount ?? null,
            productionArtifactHitCount: loopSummary.productionArtifactHitCount ?? null,
            admissionCurrentState: admissionSummary.currentState || null,
            admissionBlockedReasons: admission.productionProfileAdmission?.blockedReasons || []
        },
        releaseNotes: [
            '当前默认图片路径可继续发版，但不能把 visible residual alpha/profile 候选升为生产默认。',
            '正式 gold 迁移与生产 profile 变更仍需要人工审阅完成。'
        ]
    };
}

function matchStringConstant(text = '', name) {
    const match = text.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]\\s*;`));
    return match ? match[1] : null;
}

function matchBooleanConstant(text = '', name) {
    const match = text.match(new RegExp(`const\\s+${name}\\s*=\\s*(true|false)\\s*;`));
    return match ? match[1] === 'true' : null;
}

function summarizeVideoProductionDefaults(cleanupArtifact, appArtifact, presetArtifact) {
    const cleanupText = cleanupArtifact.text || '';
    const appText = appArtifact.text || '';
    const presetText = presetArtifact.text || '';
    const defaultDenoiseBackend = matchStringConstant(cleanupText, 'DEFAULT_DENOISE_BACKEND');
    const defaultTextureRepair = matchBooleanConstant(cleanupText, 'DEFAULT_TEXTURE_REPAIR');
    const defaultHighQualityCleanup = matchBooleanConstant(cleanupText, 'DEFAULT_HIGH_QUALITY_CLEANUP');
    const appUsesDefaultDenoiseBackend = /els\.denoiseBackend\.value\s*=\s*Object\.values\(VIDEO_DENOISE_BACKENDS\)\.includes\(DEFAULT_DENOISE_BACKEND\)/.test(appText);
    const appUsesPresetDenoiseBackend = /els\.denoiseBackend\.value\s*=\s*Object\.values\(VIDEO_DENOISE_BACKENDS\)\.includes\(preset\.denoiseBackend\)/.test(appText);
    const appExportsSelectedBackend = /denoiseBackend:\s*els\.denoiseBackend\.value\s*\|\|\s*DEFAULT_DENOISE_BACKEND/.test(appText) ||
        /const\s+denoiseBackend\s*=\s*els\.denoiseBackend\.value\s*\|\|\s*DEFAULT_DENOISE_BACKEND\s*;[\s\S]{0,1200}denoiseBackend\s*,/.test(appText);
    const hasStandardAutoAiPreset = /function\s+getStandardAutoPresetConfig\(/.test(presetText) &&
        /ALLENK_FDNCNN_BROWSER_SPIKE/.test(presetText);
    const appAppliesAutomaticPreset = /function\s+applyAutomaticPreset\(/.test(appText) &&
        /getAutomaticVideoPresetConfig\(detection,\s*metadata\)/.test(appText);
    const appBackendSelectionReady = appUsesDefaultDenoiseBackend ||
        (hasStandardAutoAiPreset && appAppliesAutomaticPreset && appUsesPresetDenoiseBackend);
    const hasRelocatedReviewPreset = /function\s+getRelocatedReviewPresetConfig\(/.test(presetText) &&
        /CANVAS_TEMPORAL_MATCH_DELTA_STABILIZE/.test(presetText);
    const reviewPresetAutoApplies = /function\s+maybeApplyRelocatedReviewPreset\(/.test(appText);
    const reviewPresetMarkedReviewOnly = /复核预设/.test(appText) && /不是默认策略/.test(appText);
    const debugAlphaOverrides = [
        '__gwrVideoAlphaLowScale',
        '__gwrVideoAlphaBodyScale',
        '__gwrVideoAlphaEdgeBoost',
        '__gwrVideoAlphaLocalRegion',
        '__gwrVideoAlphaLocalLowScale',
        '__gwrVideoAlphaLocalBodyScale'
    ].filter((marker) => appText.includes(marker));

    const blockers = [];
    if (!cleanupArtifact.exists) blockers.push('video-cleanup-source-missing');
    if (!appArtifact.exists) blockers.push('video-app-source-missing');
    if (!presetArtifact.exists) blockers.push('video-preset-policy-source-missing');
    if (defaultDenoiseBackend !== 'none') blockers.push('video-default-denoise-backend-not-none');
    if (defaultTextureRepair !== false) blockers.push('video-default-texture-repair-enabled');
    if (defaultHighQualityCleanup !== false) blockers.push('video-default-high-quality-cleanup-enabled');
    if (!appBackendSelectionReady) blockers.push('video-ui-default-not-bound-to-safe-or-auto-preset');
    if (!appExportsSelectedBackend) blockers.push('video-export-not-falling-back-to-default-denoise-constant');
    if (reviewPresetAutoApplies && !reviewPresetMarkedReviewOnly) blockers.push('video-review-preset-not-marked-review-only');

    return {
        id: 'video-production-defaults',
        title: 'Video production defaults',
        status: blockers.length === 0 ? 'safe-current-defaults' : 'blocked',
        releaseEligible: blockers.length === 0,
        productionChangeAllowed: false,
        blockers,
        evidence: {
            cleanupSourcePath: cleanupArtifact.path,
            appSourcePath: appArtifact.path,
            presetPolicySourcePath: presetArtifact.path,
            defaultDenoiseBackend,
            defaultTextureRepair,
            defaultHighQualityCleanup,
            appUsesDefaultDenoiseBackend,
            appUsesPresetDenoiseBackend,
            hasStandardAutoAiPreset,
            appAppliesAutomaticPreset,
            appBackendSelectionReady,
            appExportsSelectedBackend,
            hasRelocatedReviewPreset,
            reviewPresetAutoApplies,
            reviewPresetMarkedReviewOnly,
            debugAlphaOverrideCount: debugAlphaOverrides.length,
            debugAlphaOverrides
        },
        releaseNotes: blockers.length === 0
            ? [
                '视频底层全局默认仍保持 denoiseBackend=none；页面可通过自动 preset 选择本地 AI 处理，但不得宣传为 allenk parity。',
                'relocated review preset 可保留为自动复核入口；更强 denoise / alpha shape 质量 claim 仍由独立 gate 控制。'
            ]
            : [
                '视频生产默认路径疑似启用了未 promoted 的实验候选；发版前必须恢复为安全默认或补齐多层 gate 证据。'
            ]
    };
}

function summarizeV2Cleanup(v2Artifact) {
    const summary = v2Artifact.json?.summary || {};
    const v2Records = Array.isArray(v2Artifact.json?.v2Records) ? v2Artifact.json.v2Records : [];
    const blockers = [];
    if (!v2Artifact.exists) blockers.push('v2-cleanup-summary-missing');
    if (Number(summary.v2Selected || 0) <= 0) blockers.push('v2-36-no-selected-sample');
    if (Number(summary.total || 0) <= 0) blockers.push('v2-36-sample-total-missing');

    const selected = Number(summary.v2Selected || 0);
    const cleanup = Number(summary.v2Cleanup || 0);
    const pass = Number(summary.pass || 0);
    const residual = Number(summary.residual || 0);
    const firstRecord = v2Records[0] || null;

    return {
        id: 'image-v2-36',
        title: 'Image V2 36px profile',
        status: blockers.length === 0 ? 'guarded-release' : 'missing-evidence',
        releaseEligible: blockers.length === 0,
        productionChangeAllowed: true,
        blockers,
        evidence: {
            summaryPath: v2Artifact.path,
            total: summary.total ?? null,
            applied: summary.applied ?? null,
            skipped: summary.skipped ?? null,
            pass,
            residual,
            v2Selected: selected,
            v2Cleanup: cleanup,
            configs: summary.configs || null,
            firstV2Record: firstRecord
                ? {
                    file: firstRecord.file || firstRecord.rel || null,
                    bucket: firstRecord.bucket || null,
                    config: firstRecord.config || null,
                    processedSpatialScore: firstRecord.detection?.processedSpatialScore ?? firstRecord.processedSpatial ?? null,
                    processedGradientScore: firstRecord.detection?.processedGradientScore ?? firstRecord.processedGradient ?? null,
                    source: firstRecord.source || null
                }
                : null
        },
        releaseNotes: [
            'V2 36px 只按 evidence-gated 小水印 profile 发布，不应宣传为全量 V2 覆盖。',
            '当前样本显示 edge cleanup 可过 metric，但中心灰影问题仍属于后续 render/composite 模型研究。'
        ]
    };
}

function summarizeVideoDenoise(gateArtifact) {
    const gate = gateArtifact.json || {};
    const candidates = Array.isArray(gate.candidates) ? gate.candidates : [];
    const promoted = candidates.filter((item) => item.decision === 'promote-default-candidate');
    const humanReview = candidates.filter((item) => item.decision === 'human-review');
    const insufficient = candidates.filter((item) => item.decision === 'insufficient-evidence');
    const rejected = candidates.filter((item) => item.decision === 'reject');
    const blockers = [];
    if (!gateArtifact.exists) blockers.push('video-denoise-gate-missing');
    if (promoted.length === 0) blockers.push('video-denoise-no-promoted-default-candidate');
    if (rejected.length > 0) blockers.push('video-denoise-existing-canvas-candidates-rejected');

    return {
        id: 'video-denoise-v2',
        title: 'Video V2 denoise parity',
        status: promoted.length > 0 ? 'candidate-ready' : 'experiment-only',
        releaseEligible: promoted.length > 0,
        productionChangeAllowed: promoted.length > 0,
        blockers,
        evidence: {
            gatePath: gateArtifact.path,
            generatedAt: gate.generatedAt || null,
            requiredLayerCount: gate.requiredLayerCount ?? null,
            totalCandidates: candidates.length,
            promotedCandidates: promoted.map((item) => item.profileLabel),
            humanReviewCandidates: humanReview.map((item) => item.profileLabel),
            insufficientEvidenceCandidates: insufficient.map((item) => item.profileLabel),
            rejectedCandidates: rejected.map((item) => item.profileLabel),
            layerIds: Array.isArray(gate.layers) ? gate.layers.map((item) => item.id) : []
        },
        releaseNotes: [
            '视频 V2 不能宣传为接近 allenk v0.6.2 的 denoise 质量。',
            '旧 Canvas denoise 候选已被 gate 拒绝，下一步应接入真正 ROI ML/WebGPU/WebNN denoise 候选。'
        ]
    };
}

function summarizeVideoReviewDelivery(deliveryArtifact, reviewPackArtifact) {
    const delivery = deliveryArtifact.json || {};
    const reviewPack = reviewPackArtifact.json || {};
    const deliveryReady = delivery.ready === true && delivery.status === 'ready-for-visual-review';
    const reviewComparisons = Array.isArray(reviewPack.comparisons) ? reviewPack.comparisons : [];
    const hasFullAndRoiViews = ['full', 'roi'].every((kind) =>
        reviewComparisons.some((item) => item.kind === kind)
    );
    const blockers = [];

    if (!deliveryArtifact.exists) blockers.push('video-delivery-gate-missing');
    if (!reviewPackArtifact.exists) blockers.push('video-review-pack-missing');
    if (!deliveryReady) blockers.push('video-delivery-gate-not-ready-for-visual-review');
    if (Array.isArray(delivery.blockers) && delivery.blockers.length > 0) blockers.push('video-delivery-gate-has-blockers');
    if (reviewComparisons.length <= 0) blockers.push('video-review-pack-empty');
    if (reviewComparisons.length > 0 && !hasFullAndRoiViews) blockers.push('video-review-pack-missing-full-or-roi');

    return {
        id: 'video-review-delivery',
        title: 'Video review delivery pack',
        status: blockers.length === 0 ? 'ready-for-visual-review' : 'missing-evidence',
        releaseEligible: blockers.length === 0,
        productionChangeAllowed: false,
        blockers,
        evidence: {
            deliveryGatePath: deliveryArtifact.path,
            reviewPackPath: reviewPackArtifact.path,
            deliveryStatus: delivery.status || null,
            deliveryReady: delivery.ready === true,
            deliveryBlockers: delivery.blockers || [],
            benchmark: delivery.benchmark || null,
            bestCandidate: delivery.gate?.bestCandidate || null,
            temporalStatus: delivery.temporal?.status || null,
            temporalBlockers: delivery.temporal?.blockers || [],
            temporalWarnings: delivery.temporal?.warnings || [],
            temporalComparisons: Array.isArray(delivery.temporal?.comparisons)
                ? delivery.temporal.comparisons.map((item) => ({
                    baselineId: item.baselineId || null,
                    candidateId: item.candidateId || null,
                    sameJitterDelta: item.delta?.meanSameJitter ?? null,
                    matchedJitterDelta: item.delta?.meanMatchedJitter ?? null,
                    worsenedRatioDelta: item.delta?.worsenedRatio ?? null
                }))
                : [],
            reviewComparisonCount: reviewComparisons.length,
            reviewCases: [...new Set(reviewComparisons.map((item) => item.caseId).filter(Boolean))],
            reviewViews: [...new Set(reviewComparisons.map((item) => item.kind).filter(Boolean))]
        },
        releaseNotes: blockers.length === 0
            ? [
                '视频候选已生成 delivery gate 与 review pack，可进入人工视觉复核。',
                '该 lane 只证明复核材料就绪；正式默认策略仍需人工接受后再更新 release claim。'
            ]
            : [
                '视频候选缺少可复核材料或 gate 未 ready；继续保持实验/复核路径。'
            ]
    };
}

async function readVideoAlphaShapeGateReports(rootPath) {
    const root = normalizePath(rootPath);
    const reports = [];
    if (!existsSync(root)) return { root, reports, missing: true };
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const reportPath = path.join(root, entry.name, 'latest-report.json');
        if (!existsSync(reportPath)) continue;
        reports.push({
            name: entry.name,
            artifact: await readJsonArtifact(reportPath)
        });
    }
    reports.sort((a, b) => a.name.localeCompare(b.name));
    return { root, reports, missing: false };
}

function summarizeVideoAlphaShape(gateRoot) {
    const reports = gateRoot.reports || [];
    const summaries = reports.map(({ name, artifact }) => {
        const result = artifact.json?.result || {};
        const topCandidates = Array.isArray(result.topCandidates) ? result.topCandidates : [];
        const top = topCandidates[0] || {};
        return {
            name,
            path: artifact.path,
            totalCommonCandidates: result.totalCommonCandidates ?? null,
            promotedCount: result.promotedCount ?? null,
            rejectedByVideoCount: result.rejectedByVideoCount ?? null,
            topCandidate: top.name || null,
            topFitVerdict: top.fitGate?.verdict || null,
            topVideoVerdict: top.videoGate?.verdict || null,
            topVideoRegressionCount: Array.isArray(top.videoGate?.regressions)
                ? top.videoGate.regressions.length
                : null
        };
    });
    const promotedCount = summaries.reduce((sum, item) => sum + Number(item.promotedCount || 0), 0);
    const noBenchmarkCount = summaries.filter((item) => item.topVideoVerdict === 'no-video-benchmark').length;
    const rejectedByVideoCount = summaries.reduce((sum, item) => sum + Number(item.rejectedByVideoCount || 0), 0);
    const blockers = [];
    if (gateRoot.missing || reports.length === 0) blockers.push('video-alpha-shape-gate-missing');
    if (promotedCount === 0) blockers.push('video-alpha-shape-no-promoted-candidate');
    if (rejectedByVideoCount > 0) blockers.push('video-alpha-shape-video-regressions-present');
    if (noBenchmarkCount > 0) blockers.push('video-alpha-shape-benchmark-missing-for-some-candidates');

    return {
        id: 'video-alpha-shape',
        title: 'Video alpha shape/profile candidates',
        status: promotedCount > 0 ? 'candidate-ready' : 'experiment-only',
        releaseEligible: promotedCount > 0,
        productionChangeAllowed: promotedCount > 0,
        blockers,
        evidence: {
            root: gateRoot.root,
            reportCount: reports.length,
            promotedCount,
            rejectedByVideoCount,
            noBenchmarkCount,
            reports: summaries
        },
        releaseNotes: [
            'alpha-shape 候选仍是实验线；fit 层改善不能替代视频级 gate。',
            '没有 promoted candidate 前，不应把这些 profile 写入默认视频处理路径。'
        ]
    };
}

async function summarizeReleaseClaims(claimFiles = DEFAULT_INPUTS.releaseClaimFiles) {
    const artifacts = [];
    const violations = [];
    for (const claimFile of claimFiles) {
        const artifact = await readTextArtifact(claimFile);
        artifacts.push({
            path: artifact.path,
            exists: artifact.exists,
            error: artifact.error
        });
        if (!artifact.exists) continue;
        const segments = artifact.text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        for (const segment of segments) {
            for (const rule of FORBIDDEN_RELEASE_CLAIM_PATTERNS) {
                const match = segment.match(rule.pattern);
                if (!match) continue;
                violations.push({
                    ruleId: rule.id,
                    blockedClaim: rule.claim,
                    path: artifact.path,
                    excerpt: match[0].replace(/\s+/g, ' ').slice(0, 220)
                });
            }
        }
    }

    const missingFiles = artifacts.filter((item) => !item.exists);
    const blockers = [];
    if (missingFiles.length > 0) blockers.push('release-claim-file-missing');
    if (violations.length > 0) blockers.push('release-claim-scan-violations');

    return {
        id: 'release-claims',
        title: 'Release claim scope',
        status: blockers.length === 0 ? 'clean' : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: {
            scannedFiles: artifacts,
            scannedFileCount: artifacts.length,
            missingFileCount: missingFiles.length,
            violationCount: violations.length,
            violations
        },
        releaseNotes: blockers.length === 0
            ? [
                '公开 README / CHANGELOG / RELEASE / package metadata 未声明被 readiness 阻断的视频 parity 或默认视频后端能力。'
            ]
            : [
                '公开发版文案包含 readiness 当前阻断的能力 claim；发版前必须移除或改写这些表述。'
            ]
    };
}

function summarizeAllenkReference(allenkRepoPath, { localHeadOverride = null, remoteHeadOverride = null } = {}) {
    const resolved = normalizePath(allenkRepoPath);
    const exists = existsSync(resolved);
    const localHead = localHeadOverride || (exists ? runGit(['rev-parse', 'HEAD'], resolved) : null);
    const remoteHead = remoteHeadOverride || runGit(['ls-remote', 'https://github.com/allenk/GeminiWatermarkTool.git', 'HEAD'], process.cwd())
        ?.split(/\s+/)[0] || null;
    const status = exists && localHead && remoteHead && localHead === remoteHead
        ? 'current'
        : exists
            ? 'needs-refresh-check'
            : 'missing';
    const blockers = [];
    if (!exists) blockers.push('allenk-reference-repo-missing');
    if (localHead && remoteHead && localHead !== remoteHead) blockers.push('allenk-reference-remote-head-changed');
    if (!remoteHead) blockers.push('allenk-reference-remote-head-unverified');

    return {
        id: 'allenk-reference',
        title: 'allenk/GeminiWatermarkTool reference',
        status,
        releaseEligible: status === 'current',
        blockers,
        evidence: {
            repoPath: resolved,
            localHead,
            remoteHead,
            referenceVideoDir: path.resolve('.artifacts/allenk-video')
        },
        releaseNotes: [
            '当前比较基线绑定 allenk/GeminiWatermarkTool HEAD；如果 remote HEAD 改变，需要刷新对比。'
        ]
    };
}

function summarizeAllenkV2ComparisonFreshness(comparisonArtifact, sourcePaths = [], mtimeOverrides = {}) {
    const comparisonMtimeMs = comparisonArtifact.exists
        ? getPathMtimeMs(comparisonArtifact.path, mtimeOverrides)
        : null;
    const sourceInputs = sourcePaths
        .filter(Boolean)
        .map((sourcePath) => {
            const resolved = path.resolve(sourcePath);
            const exists = existsSync(resolved);
            const mtimeMs = exists ? getPathMtimeMs(resolved, mtimeOverrides) : null;
            return {
                path: resolved,
                exists,
                mtimeUtc: mtimeMs ? new Date(mtimeMs).toISOString() : null,
                newerThanComparison: Boolean(comparisonMtimeMs && mtimeMs && mtimeMs > comparisonMtimeMs)
            };
        });
    const newestSourceInputMtimeMs = sourceInputs
        .map((item) => item.mtimeUtc ? Date.parse(item.mtimeUtc) : null)
        .filter((mtime) => mtime !== null)
        .reduce((max, mtime) => Math.max(max, mtime), 0);
    const staleSourceInputs = sourceInputs.filter((item) => item.newerThanComparison);

    return {
        comparisonMtimeUtc: comparisonMtimeMs ? new Date(comparisonMtimeMs).toISOString() : null,
        newestSourceInputMtimeUtc: newestSourceInputMtimeMs
            ? new Date(newestSourceInputMtimeMs).toISOString()
            : null,
        stale: staleSourceInputs.length > 0,
        staleSourceInputs,
        sourceInputs
    };
}

function computeFileSha256(filePath) {
    try {
        return createHash('sha256').update(readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function summarizeAllenkV2ComparisonProvenance(comparisonArtifact) {
    const requiredProvenanceIds = [
        'allenk-v2-comparison-script',
        'image-v2-summary',
        'video-crop-benchmark',
        'video-denoise-gate'
    ];
    const recorded = Array.isArray(comparisonArtifact.json?.provenance?.sourceArtifacts)
        ? comparisonArtifact.json.provenance.sourceArtifacts
        : [];
    const sourceArtifacts = recorded.map((item) => {
        const resolved = path.resolve(item.path || '');
        const exists = Boolean(item.path && existsSync(resolved));
        const actualSha256 = exists ? computeFileSha256(resolved) : null;
        const recordedSha256 = typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : null;
        return {
            id: item.id || null,
            path: resolved,
            exists,
            recordedSha256,
            actualSha256,
            matches: Boolean(recordedSha256 && actualSha256 && recordedSha256 === actualSha256)
        };
    });
    const missing = sourceArtifacts.filter((item) => !item.exists);
    const mismatched = sourceArtifacts.filter((item) => item.exists && !item.matches);
    const recordedIds = new Set(recorded.map((item) => item.id).filter(Boolean));
    const missingProvenanceIds = requiredProvenanceIds.filter((id) => !recordedIds.has(id));

    return {
        recordedCount: recorded.length,
        missingCount: missing.length,
        mismatchCount: mismatched.length,
        missingProvenanceIds,
        ok: recorded.length > 0 &&
            missing.length === 0 &&
            mismatched.length === 0 &&
            missingProvenanceIds.length === 0,
        missing,
        mismatched,
        sourceArtifacts
    };
}

function summarizeAllenkV2Comparison(comparisonArtifact, {
    sourcePaths = [],
    mtimeOverrides = {},
    allenkReferenceLane = null
} = {}) {
    const report = comparisonArtifact.json || {};
    const overall = report.overall || {};
    const imageV2 = report.imageV2 || {};
    const videoBenchmark = report.videoBenchmark || {};
    const comparisonReference = report.allenkReference || {};
    const currentReference = allenkReferenceLane?.evidence || {};
    const freshness = summarizeAllenkV2ComparisonFreshness(comparisonArtifact, sourcePaths, mtimeOverrides);
    const provenance = summarizeAllenkV2ComparisonProvenance(comparisonArtifact);
    const referenceHeadCheck = {
        comparisonLocalHead: comparisonReference.localHead || null,
        comparisonRemoteHead: comparisonReference.remoteHead || null,
        currentLocalHead: currentReference.localHead || null,
        currentRemoteHead: currentReference.remoteHead || null,
        localHeadMatches: Boolean(
            comparisonReference.localHead &&
            currentReference.localHead &&
            comparisonReference.localHead === currentReference.localHead
        ),
        remoteHeadMatches: Boolean(
            comparisonReference.remoteHead &&
            currentReference.remoteHead &&
            comparisonReference.remoteHead === currentReference.remoteHead
        )
    };
    const blockers = [];
    if (!comparisonArtifact.exists) blockers.push('allenk-v2-comparison-report-missing');
    if (overall.comparisonEvidenceReady !== true) blockers.push('allenk-v2-comparison-evidence-incomplete');
    if (imageV2.status !== 'guarded-release') blockers.push('allenk-v2-image-guarded-evidence-missing');
    if (videoBenchmark.status !== 'compared') blockers.push('allenk-v2-video-comparison-missing');
    const imageEvidence = imageV2.evidence || {};
    const videoEvidence = videoBenchmark.evidence || {};
    const imageV2Selected = Number(imageEvidence.v2Selected);
    const imageV2Cleanup = Number(imageEvidence.v2Cleanup);
    const imageV2RecordCount = Number(imageEvidence.v2RecordCount);
    const imageV2PassingCleanupRecordCount = Number(imageEvidence.passingCleanupRecordCount);
    if (!Number.isFinite(imageV2Selected) || imageV2Selected <= 0) {
        blockers.push('allenk-v2-image-selected-count-missing');
    }
    if (!Number.isFinite(imageV2Cleanup) || imageV2Cleanup <= 0) {
        blockers.push('allenk-v2-image-cleanup-count-missing');
    }
    if (!Number.isFinite(imageV2RecordCount) || imageV2RecordCount !== imageV2Selected) {
        blockers.push('allenk-v2-image-record-count-mismatch');
    }
    if (!Number.isFinite(imageV2PassingCleanupRecordCount) || imageV2PassingCleanupRecordCount <= 0) {
        blockers.push('allenk-v2-image-passing-cleanup-record-missing');
    }
    if (Number(videoEvidence.missingOutputArtifactCount || 0) !== 0) {
        blockers.push('allenk-v2-video-rendered-artifacts-missing');
    }
    const videoCaseCount = Array.isArray(videoEvidence.cases) ? videoEvidence.cases.length : null;
    const videoRenderedComparisonCount = Number(videoEvidence.renderedComparisonCount);
    if (!Number.isFinite(videoRenderedComparisonCount) || videoRenderedComparisonCount <= 0) {
        blockers.push('allenk-v2-video-rendered-count-missing');
    }
    if (videoCaseCount !== null && Number.isFinite(videoRenderedComparisonCount) && videoCaseCount < videoRenderedComparisonCount) {
        blockers.push('allenk-v2-video-case-summary-incomplete');
    }
    if (freshness.stale) blockers.push('allenk-v2-comparison-stale');
    if (!provenance.ok) blockers.push('allenk-v2-comparison-provenance-mismatch');
    if (!referenceHeadCheck.localHeadMatches || !referenceHeadCheck.remoteHeadMatches) {
        blockers.push('allenk-v2-comparison-reference-head-mismatch');
    }

    return {
        id: 'allenk-v2-comparison',
        title: 'allenk V2 comparison',
        status: blockers.length === 0 ? 'current-gap-known' : 'missing-evidence',
        releaseEligible: blockers.length === 0,
        productionChangeAllowed: false,
        blockers,
        evidence: {
            comparisonPath: comparisonArtifact.path,
            generatedAt: report.generatedAt || null,
            comparisonEvidenceReady: overall.comparisonEvidenceReady ?? null,
            canClaimImageV2SmallGuarded: overall.canClaimImageV2SmallGuarded ?? null,
            canClaimBroadImageV2Coverage: overall.canClaimBroadImageV2Coverage ?? null,
            canClaimVideoAllenkParity: overall.canClaimVideoAllenkParity ?? null,
            blockedClaims: overall.blockedClaims || [],
            imageV2Status: imageV2.status || null,
            imageV2KnownGaps: imageV2.knownGaps || [],
            imageV2Selected: imageEvidence.v2Selected ?? null,
            imageV2Cleanup: imageEvidence.v2Cleanup ?? null,
            imageV2RecordCount: imageEvidence.v2RecordCount ?? null,
            imageV2PassingCleanupRecordCount: imageEvidence.passingCleanupRecordCount ?? null,
            videoBenchmarkStatus: videoBenchmark.status || null,
            videoAllenkCaseCount: videoEvidence.allenkCaseCount ?? null,
            videoRenderedComparisonCount: videoEvidence.renderedComparisonCount ?? null,
            videoMissingOutputArtifactCount: videoEvidence.missingOutputArtifactCount ?? null,
            videoCaseSummaryCount: videoCaseCount,
            videoMeanCurrentVsAllenkMeanAbs: videoEvidence.meanCurrentVsAllenkMeanAbs ?? null,
            videoMeanOriginalVsAllenkMeanAbs: videoEvidence.meanOriginalVsAllenkMeanAbs ?? null,
            freshness,
            provenance,
            referenceHeadCheck
        },
        releaseNotes: [
            'allenk V2 对比已汇总为独立 artifact；当前结论是图片 V2 36 只能 guarded 发布，视频 allenk parity 仍不可宣称。',
            '如果 allenk 参考、视频 benchmark 或候选 gate 更新，应先刷新 compare:allenk-v2 再刷新 release:readiness。'
        ]
    };
}

function findLaneById(lanes, id) {
    return (lanes || []).find((lane) => lane.id === id) || null;
}

function yesNo(value) {
    return value === true ? 'yes' : 'no';
}

function buildCapabilityDecisions(lanes, overall) {
    const visibleResidual = findLaneById(lanes, 'image-visible-residual');
    const v2 = findLaneById(lanes, 'image-v2-36');
    const videoProductionDefaults = findLaneById(lanes, 'video-production-defaults');
    const videoDenoise = findLaneById(lanes, 'video-denoise-v2');
    const videoReviewDelivery = findLaneById(lanes, 'video-review-delivery');
    const videoAlpha = findLaneById(lanes, 'video-alpha-shape');
    const allenkV2 = findLaneById(lanes, 'allenk-v2-comparison');

    const imageV2SmallReady = Boolean(
        v2?.releaseEligible &&
        allenkV2?.releaseEligible &&
        allenkV2?.evidence?.canClaimImageV2SmallGuarded === true
    );
    const broadImageV2Ready = Boolean(
        allenkV2?.releaseEligible &&
        allenkV2?.evidence?.canClaimBroadImageV2Coverage === true
    );
    const visibleResidualProductionReady = visibleResidual?.productionChangeAllowed === true;
    const videoProductionDefaultsSafe = videoProductionDefaults?.releaseEligible === true;
    const videoDenoiseDefaultReady = Boolean(
        videoProductionDefaultsSafe &&
        videoDenoise?.releaseEligible &&
        videoDenoise?.status === 'candidate-ready'
    );
    const videoAlphaShapeDefaultReady = Boolean(
        videoProductionDefaultsSafe &&
        videoAlpha?.releaseEligible &&
        videoAlpha?.status === 'candidate-ready'
    );

    return [
        {
            id: 'current-image-defaults',
            title: 'Current image defaults',
            decision: overall.canReleaseCurrentImageDefaults ? 'release' : 'blocked',
            evidenceSummary: `canReleaseCurrentImageDefaults=${yesNo(overall.canReleaseCurrentImageDefaults)}`,
            evidence: {
                canReleaseCurrentImageDefaults: overall.canReleaseCurrentImageDefaults,
                currentImageCapabilityReady: overall.currentImageCapabilityReady
            }
        },
        {
            id: 'image-v2-36-small-profile',
            title: 'Image V2 36px small profile',
            decision: imageV2SmallReady ? 'guarded-release' : 'blocked',
            evidenceSummary: `image-v2-36=${v2?.status || 'missing'}, canClaimImageV2SmallGuarded=${yesNo(allenkV2?.evidence?.canClaimImageV2SmallGuarded)}`,
            evidence: {
                laneStatus: v2?.status || null,
                laneReleaseEligible: v2?.releaseEligible === true,
                allenkV2ComparisonStatus: allenkV2?.status || null,
                canClaimImageV2SmallGuarded: allenkV2?.evidence?.canClaimImageV2SmallGuarded === true
            }
        },
        {
            id: 'broad-image-v2-coverage',
            title: 'Broad image V2 coverage',
            decision: broadImageV2Ready ? 'release' : 'blocked',
            evidenceSummary: `canClaimBroadImageV2Coverage=${yesNo(allenkV2?.evidence?.canClaimBroadImageV2Coverage)}`,
            evidence: {
                allenkV2ComparisonStatus: allenkV2?.status || null,
                canClaimBroadImageV2Coverage: allenkV2?.evidence?.canClaimBroadImageV2Coverage === true
            }
        },
        {
            id: 'visible-residual-alpha-profile-productionization',
            title: 'Visible residual alpha/profile productionization',
            decision: visibleResidualProductionReady ? 'release' : 'blocked',
            evidenceSummary: `productionChangeAllowed=${yesNo(visibleResidual?.productionChangeAllowed === true)}, image-visible-residual=${visibleResidual?.status || 'missing'}`,
            evidence: {
                laneStatus: visibleResidual?.status || null,
                productionChangeAllowed: visibleResidual?.productionChangeAllowed === true,
                readyForGoldMigration: visibleResidual?.evidence?.readyForGoldMigration ?? null,
                productionProfileAllowed: visibleResidual?.evidence?.productionProfileAllowed ?? null
            }
        },
        {
            id: 'video-v2-allenk-parity',
            title: 'Video V2 allenk parity',
            decision: overall.canClaimVideoV2Parity ? 'release' : 'blocked',
            evidenceSummary: `canClaimVideoV2Parity=${yesNo(overall.canClaimVideoV2Parity)}`,
            evidence: {
                canClaimVideoV2Parity: overall.canClaimVideoV2Parity,
                videoDenoiseReleaseEligible: videoDenoise?.releaseEligible === true,
                videoAlphaShapeReleaseEligible: videoAlpha?.releaseEligible === true,
                allenkV2CanClaimVideoParity: allenkV2?.evidence?.canClaimVideoAllenkParity === true
            }
        },
        {
            id: 'video-production-defaults',
            title: 'Video production defaults',
            decision: videoProductionDefaultsSafe ? 'safe-current-defaults' : 'blocked',
            evidenceSummary: `video-production-defaults=${videoProductionDefaults?.status || 'missing'}`,
            evidence: {
                laneStatus: videoProductionDefaults?.status || null,
                laneReleaseEligible: videoProductionDefaultsSafe,
                defaultDenoiseBackend: videoProductionDefaults?.evidence?.defaultDenoiseBackend ?? null,
                reviewPresetMarkedReviewOnly: videoProductionDefaults?.evidence?.reviewPresetMarkedReviewOnly ?? null
            }
        },
        {
            id: 'video-denoise-default',
            title: 'Video denoise default',
            decision: videoDenoiseDefaultReady
                ? 'release'
                : videoProductionDefaultsSafe
                    ? 'experiment-only'
                    : 'blocked',
            evidenceSummary: `video-denoise-v2=${videoDenoise?.status || 'missing'}`,
            evidence: {
                laneStatus: videoDenoise?.status || null,
                laneReleaseEligible: videoDenoise?.releaseEligible === true,
                videoProductionDefaultsSafe
            }
        },
        {
            id: 'video-review-delivery',
            title: 'Video review delivery',
            decision: videoReviewDelivery?.releaseEligible === true ? 'ready-for-visual-review' : 'blocked',
            evidenceSummary: `video-review-delivery=${videoReviewDelivery?.status || 'missing'}`,
            evidence: {
                laneStatus: videoReviewDelivery?.status || null,
                laneReleaseEligible: videoReviewDelivery?.releaseEligible === true,
                reviewComparisonCount: videoReviewDelivery?.evidence?.reviewComparisonCount ?? null,
                reviewViews: videoReviewDelivery?.evidence?.reviewViews || []
            }
        },
        {
            id: 'video-alpha-shape-default',
            title: 'Video alpha-shape default',
            decision: videoAlphaShapeDefaultReady
                ? 'release'
                : videoProductionDefaultsSafe
                    ? 'experiment-only'
                    : 'blocked',
            evidenceSummary: `video-alpha-shape=${videoAlpha?.status || 'missing'}`,
            evidence: {
                laneStatus: videoAlpha?.status || null,
                laneReleaseEligible: videoAlpha?.releaseEligible === true,
                videoProductionDefaultsSafe
            }
        }
    ];
}

export function summarizeReleaseInvariantChecks(overall) {
    const blockedClaims = new Set(overall.blockedClaims || []);
    const guardedClaims = new Set(FORBIDDEN_RELEASE_CLAIM_PATTERNS.map((rule) => rule.claim));
    const missingBlockedClaims = [];
    const missingReleaseClaimGuards = [];
    const unregisteredBlockedCapabilities = [];

    for (const decision of overall.capabilityDecisions || []) {
        if (!BLOCKED_CAPABILITY_DECISIONS.has(decision.decision)) continue;
        const invariant = BLOCKED_CAPABILITY_INVARIANTS[decision.id];
        if (!invariant) {
            unregisteredBlockedCapabilities.push(decision.id);
            continue;
        }
        if (invariant.blockedClaim && !blockedClaims.has(invariant.blockedClaim)) {
            missingBlockedClaims.push({
                capability: decision.id,
                blockedClaim: invariant.blockedClaim
            });
        }
        if (invariant.blockedClaim && invariant.releaseClaimGuardRequired && !guardedClaims.has(invariant.blockedClaim)) {
            missingReleaseClaimGuards.push({
                capability: decision.id,
                blockedClaim: invariant.blockedClaim
            });
        }
    }

    const ok = missingBlockedClaims.length === 0 &&
        missingReleaseClaimGuards.length === 0 &&
        unregisteredBlockedCapabilities.length === 0;
    return {
        ok,
        missingBlockedClaims,
        missingReleaseClaimGuards,
        unregisteredBlockedCapabilities,
        guardedBlockedClaims: Array.from(guardedClaims).sort()
    };
}

export function summarizeReleaseReadinessGate(report) {
    const overall = report?.overall || {};
    const blockers = [];
    if (overall.recommendation !== RELEASE_READY_RECOMMENDATION) {
        blockers.push('release-recommendation-not-immediately-releasable');
    }
    if (overall.canReleaseCurrentImageDefaults !== true) {
        blockers.push('current-image-defaults-not-releasable');
    }
    if (overall.releaseInvariantChecks?.ok !== true) {
        blockers.push('release-invariant-checks-failed');
    }
    if (overall.releaseDecisionSummary?.releaseClaimGuardsOk !== true) {
        blockers.push('release-claim-guards-failed');
    }
    if (overall.releaseEvidenceIndexIntegrity && overall.releaseEvidenceIndexIntegrity.ok !== true) {
        blockers.push('release-evidence-index-integrity-failed');
    }
    return {
        ok: blockers.length === 0,
        requiredRecommendation: RELEASE_READY_RECOMMENDATION,
        actualRecommendation: overall.recommendation || null,
        blockers
    };
}

function summarizeReleaseDecisionSummary(overall) {
    const decisions = Array.isArray(overall.capabilityDecisions)
        ? overall.capabilityDecisions
        : [];
    const collectByDecision = (decisionNames) => decisions
        .filter((decision) => decisionNames.includes(decision.decision))
        .map((decision) => ({
            id: decision.id,
            title: decision.title,
            decision: decision.decision,
            evidenceSummary: decision.evidenceSummary
        }));

    return {
        recommendation: overall.recommendation,
        currentReleaseScope: overall.canReleaseCurrentImageDefaults
            ? 'current-image-defaults-and-guarded-v2-36-only'
            : 'not-ready',
        releaseNow: collectByDecision(['release']),
        guardedRelease: collectByDecision(['guarded-release']),
        safeCurrentDefaults: collectByDecision(['safe-current-defaults']),
        visualReviewOnly: collectByDecision(['ready-for-visual-review']),
        experimentOnly: collectByDecision(['experiment-only']),
        blocked: collectByDecision(['blocked']),
        forbiddenClaims: [...(overall.blockedClaims || [])],
        releaseClaimGuardsOk: overall.releaseInvariantChecks?.ok === true
    };
}

function classifyReleaseClaimStatus(decision) {
    if (decision === 'release') return 'allowed';
    if (decision === 'guarded-release') return 'allowed-scoped';
    if (decision === 'safe-current-defaults') return 'allowed-safety-only';
    if (decision === 'ready-for-visual-review') return 'review-only';
    if (decision === 'experiment-only') return 'experiment-only';
    return 'forbidden';
}

function summarizeReleaseClaimMatrix(overall) {
    const decisions = Array.isArray(overall.capabilityDecisions)
        ? overall.capabilityDecisions
        : [];
    const blockedClaims = new Set(overall.blockedClaims || []);
    return decisions.map((decision) => {
        const invariant = BLOCKED_CAPABILITY_INVARIANTS[decision.id] || {};
        const forbiddenClaim = invariant.blockedClaim || null;
        return {
            id: decision.id,
            title: decision.title,
            decision: decision.decision,
            claimStatus: classifyReleaseClaimStatus(decision.decision),
            forbiddenClaim,
            forbiddenClaimActive: Boolean(forbiddenClaim && blockedClaims.has(forbiddenClaim)),
            releaseClaimGuardRequired: invariant.releaseClaimGuardRequired === true,
            evidenceSummary: decision.evidenceSummary
        };
    });
}

function summarizeReleaseEvidenceIndex(lanes, overall) {
    const releaseArtifact = findLaneById(lanes, 'release-artifact');
    const releaseClaims = findLaneById(lanes, 'release-claims');
    const releaseVersionDocs = findLaneById(lanes, 'release-version-docs');
    const visibleResidual = findLaneById(lanes, 'image-visible-residual');
    const v2 = findLaneById(lanes, 'image-v2-36');
    const videoProductionDefaults = findLaneById(lanes, 'video-production-defaults');
    const videoDenoise = findLaneById(lanes, 'video-denoise-v2');
    const videoReviewDelivery = findLaneById(lanes, 'video-review-delivery');
    const videoAlpha = findLaneById(lanes, 'video-alpha-shape');
    const allenkReference = findLaneById(lanes, 'allenk-reference');
    const allenkV2 = findLaneById(lanes, 'allenk-v2-comparison');
    const imageReleaseEvidence = findLaneById(lanes, 'image-release-evidence');
    const releaseZip = releaseArtifact?.evidence?.zipIntegrity || {};
    const claimRows = Array.isArray(overall.releaseClaimMatrix) ? overall.releaseClaimMatrix : [];

    return {
        recommendation: overall.recommendation,
        requestedScope: overall.requestedScope || null,
        gateOk: overall.releaseReadinessGate?.ok === true,
        releaseScope: overall.releaseDecisionSummary?.currentReleaseScope || null,
        releasePackage: {
            version: releaseArtifact?.evidence?.extensionVersion || null,
            zipPath: releaseZip.zipPath || null,
            sha256Path: releaseZip.shaFilePath || null,
            latestExtensionPath: releaseArtifact?.evidence?.latestExtensionPath || null,
            sha256: releaseZip.actualSha256 || null,
            size: releaseZip.actualSize ?? null,
            zipMtimeUtc: releaseArtifact?.evidence?.releaseFreshness?.zipMtimeUtc || null,
            hashMatchesMetadata: releaseZip.shaMatchesMetadata === true,
            hashMatchesShaFile: releaseZip.shaFileMatchesZip === true,
            sizeMatchesMetadata: releaseZip.sizeMatchesMetadata === true
        },
        imageQuality: {
            status: imageReleaseEvidence?.status || null,
            gateOk: imageReleaseEvidence?.releaseEligible === true,
            evidencePath: imageReleaseEvidence?.evidence?.path || null,
            blockers: imageReleaseEvidence?.blockers || []
        },
        claimPolicy: {
            publicClaimScanStatus: releaseClaims?.status || null,
            publicClaimViolationCount: releaseClaims?.evidence?.violationCount ?? null,
            releaseDocsStatus: releaseVersionDocs?.status || null,
            matrixRowCount: claimRows.length,
            allowedCapabilityIds: claimRows
                .filter((row) => ['allowed', 'allowed-scoped', 'allowed-safety-only'].includes(row.claimStatus))
                .map((row) => row.id),
            reviewOnlyCapabilityIds: claimRows
                .filter((row) => row.claimStatus === 'review-only')
                .map((row) => row.id),
            experimentOnlyCapabilityIds: claimRows
                .filter((row) => row.claimStatus === 'experiment-only')
                .map((row) => row.id),
            forbiddenCapabilityIds: claimRows
                .filter((row) => row.claimStatus === 'forbidden')
                .map((row) => row.id),
            activeForbiddenClaims: claimRows
                .filter((row) => row.forbiddenClaimActive)
                .map((row) => row.forbiddenClaim)
        },
        allenkComparison: {
            referenceStatus: allenkReference?.status || null,
            comparisonStatus: allenkV2?.status || null,
            comparisonPath: allenkV2?.evidence?.comparisonPath || null,
            canClaimImageV2SmallGuarded: allenkV2?.evidence?.canClaimImageV2SmallGuarded === true,
            canClaimBroadImageV2Coverage: allenkV2?.evidence?.canClaimBroadImageV2Coverage === true,
            canClaimVideoAllenkParity: allenkV2?.evidence?.canClaimVideoAllenkParity === true,
            videoAllenkCaseCount: allenkV2?.evidence?.videoAllenkCaseCount ?? null,
            videoRenderedComparisonCount: allenkV2?.evidence?.videoRenderedComparisonCount ?? null,
            videoMissingOutputArtifactCount: allenkV2?.evidence?.videoMissingOutputArtifactCount ?? null
        },
        imageScope: {
            visibleResidualStatus: visibleResidual?.status || null,
            visibleResidualProductionAllowed: visibleResidual?.productionChangeAllowed === true,
            readyForGoldMigration: visibleResidual?.evidence?.readyForGoldMigration === true,
            visibleResidualUnconfirmedCount: visibleResidual?.evidence?.unconfirmedCount ?? null,
            v2Status: v2?.status || null,
            v2ReleaseEligible: v2?.releaseEligible === true
        },
        videoScope: {
            productionDefaultsStatus: videoProductionDefaults?.status || null,
            defaultDenoiseBackend: videoProductionDefaults?.evidence?.defaultDenoiseBackend ?? null,
            denoiseStatus: videoDenoise?.status || null,
            denoisePromotedCount: Array.isArray(videoDenoise?.evidence?.promotedCandidates)
                ? videoDenoise.evidence.promotedCandidates.length
                : null,
            alphaShapeStatus: videoAlpha?.status || null,
            alphaShapePromotedCount: videoAlpha?.evidence?.promotedCount ?? null,
            reviewDeliveryStatus: videoReviewDelivery?.status || null,
            reviewComparisonCount: videoReviewDelivery?.evidence?.reviewComparisonCount ?? null
        }
    };
}

function uniqueSorted(values = []) {
    return [...new Set(values.filter((value) => value !== null && value !== undefined).map(String))].sort();
}

function arrayDifference(left = [], right = []) {
    const rightSet = new Set(right);
    return left.filter((value) => !rightSet.has(value));
}

function summarizeReleaseEvidenceIndexIntegrity(overall) {
    const index = overall.releaseEvidenceIndex || {};
    const claimRows = Array.isArray(overall.releaseClaimMatrix) ? overall.releaseClaimMatrix : [];
    const claimPolicy = index.claimPolicy || {};
    const releasePackage = index.releasePackage || {};
    const allenkComparison = index.allenkComparison || {};
    const imageQuality = index.imageQuality || {};
    const matrixIds = uniqueSorted(claimRows.map((row) => row.id));
    const indexedIds = uniqueSorted([
        ...(claimPolicy.allowedCapabilityIds || []),
        ...(claimPolicy.reviewOnlyCapabilityIds || []),
        ...(claimPolicy.experimentOnlyCapabilityIds || []),
        ...(claimPolicy.forbiddenCapabilityIds || [])
    ]);
    const indexedRawIds = [
        ...(claimPolicy.allowedCapabilityIds || []),
        ...(claimPolicy.reviewOnlyCapabilityIds || []),
        ...(claimPolicy.experimentOnlyCapabilityIds || []),
        ...(claimPolicy.forbiddenCapabilityIds || [])
    ].map(String);
    const duplicateIndexedCapabilityIds = uniqueSorted(
        indexedRawIds.filter((id, indexInArray) => indexedRawIds.indexOf(id) !== indexInArray)
    );
    const expectedActiveForbiddenClaims = uniqueSorted(
        claimRows
            .filter((row) => row.forbiddenClaimActive)
            .map((row) => row.forbiddenClaim)
    );
    const indexedActiveForbiddenClaims = uniqueSorted(claimPolicy.activeForbiddenClaims || []);
    const blockers = [];
    const missingIndexedCapabilityIds = arrayDifference(matrixIds, indexedIds);
    const extraIndexedCapabilityIds = arrayDifference(indexedIds, matrixIds);
    const missingActiveForbiddenClaims = arrayDifference(expectedActiveForbiddenClaims, indexedActiveForbiddenClaims);
    const extraActiveForbiddenClaims = arrayDifference(indexedActiveForbiddenClaims, expectedActiveForbiddenClaims);

    if (Number(claimPolicy.matrixRowCount) !== claimRows.length) blockers.push('release-evidence-index-matrix-row-count-mismatch');
    if (missingIndexedCapabilityIds.length > 0) blockers.push('release-evidence-index-capability-missing');
    if (extraIndexedCapabilityIds.length > 0) blockers.push('release-evidence-index-capability-extra');
    if (duplicateIndexedCapabilityIds.length > 0) blockers.push('release-evidence-index-capability-duplicated');
    if (missingActiveForbiddenClaims.length > 0) blockers.push('release-evidence-index-active-forbidden-claim-missing');
    if (extraActiveForbiddenClaims.length > 0) blockers.push('release-evidence-index-active-forbidden-claim-extra');

    if (overall.canReleaseCurrentImageDefaults === true) {
        if (!releasePackage.zipPath || !releasePackage.sha256 || !releasePackage.sha256Path || !releasePackage.latestExtensionPath) {
            blockers.push('release-evidence-index-release-package-paths-missing');
        }
        if (releasePackage.hashMatchesMetadata !== true) blockers.push('release-evidence-index-release-hash-metadata-mismatch');
        if (releasePackage.hashMatchesShaFile !== true) blockers.push('release-evidence-index-release-hash-file-mismatch');
        if (releasePackage.sizeMatchesMetadata !== true) blockers.push('release-evidence-index-release-size-metadata-mismatch');
        if (claimPolicy.publicClaimScanStatus !== 'clean' || claimPolicy.publicClaimViolationCount !== 0) {
            blockers.push('release-evidence-index-public-claim-scan-not-clean');
        }
        if (claimPolicy.releaseDocsStatus !== 'ready') blockers.push('release-evidence-index-release-docs-not-ready');
        if (index.requestedScope === 'image-defaults') {
            if (imageQuality.status !== 'current' || imageQuality.gateOk !== true || !imageQuality.evidencePath) {
                blockers.push('release-evidence-index-image-quality-not-current');
            }
        } else {
            if (allenkComparison.referenceStatus !== 'current') blockers.push('release-evidence-index-allenk-reference-not-current');
            if (allenkComparison.comparisonStatus !== 'current-gap-known') blockers.push('release-evidence-index-allenk-comparison-not-current');
            if (!allenkComparison.comparisonPath) blockers.push('release-evidence-index-allenk-comparison-path-missing');
            if (!Number.isFinite(Number(allenkComparison.videoAllenkCaseCount)) || Number(allenkComparison.videoAllenkCaseCount) <= 0) {
                blockers.push('release-evidence-index-allenk-video-cases-missing');
            }
            if (!Number.isFinite(Number(allenkComparison.videoRenderedComparisonCount)) || Number(allenkComparison.videoRenderedComparisonCount) <= 0) {
                blockers.push('release-evidence-index-allenk-rendered-comparisons-missing');
            }
            if (Number(allenkComparison.videoMissingOutputArtifactCount) !== 0) {
                blockers.push('release-evidence-index-allenk-rendered-artifacts-missing');
            }
        }
    }

    return {
        ok: blockers.length === 0,
        blockers,
        matrixRowCount: claimRows.length,
        indexedCapabilityCount: indexedIds.length,
        missingIndexedCapabilityIds,
        extraIndexedCapabilityIds,
        duplicateIndexedCapabilityIds,
        expectedActiveForbiddenClaims,
        indexedActiveForbiddenClaims,
        missingActiveForbiddenClaims,
        extraActiveForbiddenClaims
    };
}

export function isCurrentImageCapabilityReady(lanes, scope = null) {
    const releaseClaims = findLaneById(lanes, 'release-claims');
    const userscriptArtifact = findLaneById(lanes, 'userscript-artifact');
    const releaseVersionDocs = findLaneById(lanes, 'release-version-docs');
    const videoProductionDefaults = findLaneById(lanes, 'video-production-defaults');
    if (scope === 'image-defaults') {
        const imageReleaseEvidence = findLaneById(lanes, 'image-release-evidence');
        return Boolean(
            releaseClaims?.releaseEligible &&
            userscriptArtifact?.releaseEligible &&
            releaseVersionDocs?.releaseEligible &&
            imageReleaseEvidence?.releaseEligible &&
            videoProductionDefaults?.releaseEligible
        );
    }
    const visibleResidual = findLaneById(lanes, 'image-visible-residual');
    const v2 = findLaneById(lanes, 'image-v2-36');
    const allenk = findLaneById(lanes, 'allenk-reference');
    const allenkV2 = findLaneById(lanes, 'allenk-v2-comparison');
    return Boolean(
        releaseClaims?.releaseEligible &&
        userscriptArtifact?.releaseEligible &&
        releaseVersionDocs?.releaseEligible &&
        visibleResidual?.releaseEligible &&
        v2?.releaseEligible &&
        videoProductionDefaults?.releaseEligible &&
        allenk?.releaseEligible &&
        allenkV2?.releaseEligible
    );
}

export function summarizeImageReleaseEvidenceLane(gate, evidencePath) {
    const blockers = gate?.ok === true
        ? []
        : gate?.blockers?.length
            ? [...gate.blockers]
            : ['image-release-evidence-not-current'];
    return {
        id: 'image-release-evidence',
        title: 'Image release evidence',
        status: blockers.length === 0 ? 'current' : 'blocked',
        releaseEligible: blockers.length === 0,
        blockers,
        evidence: {
            path: evidencePath,
            gateOk: blockers.length === 0
        }
    };
}

function deriveOverall(lanes, scope = null) {
    const releaseArtifact = findLaneById(lanes, 'release-artifact');
    const releaseClaims = findLaneById(lanes, 'release-claims');
    const userscriptArtifact = findLaneById(lanes, 'userscript-artifact');
    const releaseVersionDocs = findLaneById(lanes, 'release-version-docs');
    const visibleResidual = findLaneById(lanes, 'image-visible-residual');
    const v2 = findLaneById(lanes, 'image-v2-36');
    const videoProductionDefaults = findLaneById(lanes, 'video-production-defaults');
    const videoDenoise = findLaneById(lanes, 'video-denoise-v2');
    const videoAlpha = findLaneById(lanes, 'video-alpha-shape');
    const allenk = findLaneById(lanes, 'allenk-reference');
    const allenkV2 = findLaneById(lanes, 'allenk-v2-comparison');

    const currentImageCapabilityReady = isCurrentImageCapabilityReady(lanes, scope);
    const canReleaseCurrentImageDefaults = Boolean(releaseArtifact?.releaseEligible && currentImageCapabilityReady);
    const canClaimVideoV2Parity = Boolean(
        videoDenoise?.releaseEligible &&
        videoAlpha?.releaseEligible &&
        allenkV2?.evidence?.canClaimVideoAllenkParity === true
    );
    const blockedClaims = [];
    if (!canClaimVideoV2Parity) blockedClaims.push('video-v2-allenk-parity');
    if (releaseClaims?.releaseEligible === false) blockedClaims.push('release-claim-scan-violations');
    if (visibleResidual?.productionChangeAllowed !== true) {
        blockedClaims.push('new-visible-residual-alpha-profile-productionization');
    }
    if (allenkV2?.evidence?.canClaimBroadImageV2Coverage !== true) blockedClaims.push('broad-image-v2-coverage');
    if (videoProductionDefaults?.releaseEligible === false) blockedClaims.push('video-production-defaults-unsafe');
    if (videoDenoise?.releaseEligible === false) blockedClaims.push('new-video-denoise-default');
    if (videoAlpha?.releaseEligible === false) blockedClaims.push('new-video-alpha-shape-default');
    if (allenkV2?.releaseEligible === false) blockedClaims.push('allenk-v2-comparison-evidence');

    const overall = {
        requestedScope: scope,
        recommendation: canReleaseCurrentImageDefaults
            ? 'rc-current-image-defaults-with-scoped-claims'
            : currentImageCapabilityReady && releaseArtifact?.status === 'needs-rebuild'
                ? 'rc-current-image-defaults-after-rebuild'
            : 'not-ready-for-release',
        currentImageCapabilityReady,
        canReleaseCurrentImageDefaults,
        canClaimVideoV2Parity,
        blockedClaims,
        requiredBeforeBroaderRelease: lanes
            .filter((item) => item.releaseEligible === false)
            .map((item) => ({
                lane: item.id,
                blockers: item.blockers || []
            }))
    };
    overall.capabilityDecisions = buildCapabilityDecisions(lanes, overall);
    overall.releaseInvariantChecks = summarizeReleaseInvariantChecks(overall);
    if (!overall.releaseInvariantChecks.ok) {
        if (!overall.blockedClaims.includes('release-invariant-coverage-missing')) {
            overall.blockedClaims.push('release-invariant-coverage-missing');
        }
        overall.recommendation = 'not-ready-for-release';
        overall.currentImageCapabilityReady = false;
        overall.canReleaseCurrentImageDefaults = false;
        overall.capabilityDecisions = buildCapabilityDecisions(lanes, overall);
        overall.releaseInvariantChecks = summarizeReleaseInvariantChecks(overall);
    }
    overall.releaseDecisionSummary = summarizeReleaseDecisionSummary(overall);
    overall.releaseClaimMatrix = summarizeReleaseClaimMatrix(overall);
    overall.releaseReadinessGate = summarizeReleaseReadinessGate({ overall });
    overall.releaseEvidenceIndex = summarizeReleaseEvidenceIndex(lanes, overall);
    overall.releaseEvidenceIndexIntegrity = summarizeReleaseEvidenceIndexIntegrity(overall);
    overall.releaseReadinessGate = summarizeReleaseReadinessGate({ overall });
    overall.releaseEvidenceIndex = summarizeReleaseEvidenceIndex(lanes, overall);
    overall.releaseEvidenceIndexIntegrity = summarizeReleaseEvidenceIndexIntegrity(overall);
    return overall;
}

export async function createReleaseReadinessReport({
    inputs = DEFAULT_INPUTS,
    scope = null
} = {}) {
    const readinessScriptArtifact = await readFileArtifact(inputs.releaseReadinessScript || fileURLToPath(import.meta.url));
    const packageArtifact = await readJsonArtifact(inputs.packageJson || DEFAULT_INPUTS.packageJson);
    const latestExtensionArtifact = await readJsonArtifact(inputs.latestExtension || DEFAULT_INPUTS.latestExtension);
    const userscriptArtifact = await readTextArtifact(inputs.userscript || DEFAULT_INPUTS.userscript);
    const visibleLoopArtifact = await readJsonArtifact(inputs.visibleResidualLoopSummary || DEFAULT_INPUTS.visibleResidualLoopSummary);
    const visibleAuditArtifact = await readJsonArtifact(inputs.visibleResidualGoalAudit || DEFAULT_INPUTS.visibleResidualGoalAudit);
    const visibleAdmissionArtifact = await readJsonArtifact(inputs.visibleResidualAdmission || DEFAULT_INPUTS.visibleResidualAdmission);
    const v2CleanupArtifact = await readJsonArtifact(inputs.v2CleanupSummary || DEFAULT_INPUTS.v2CleanupSummary);
    const videoCleanupBackendsSource = await readTextArtifact(inputs.videoCleanupBackendsSource || DEFAULT_INPUTS.videoCleanupBackendsSource);
    const videoAppSource = await readTextArtifact(inputs.videoAppSource || DEFAULT_INPUTS.videoAppSource);
    const videoPresetPolicySource = await readTextArtifact(inputs.videoPresetPolicySource || DEFAULT_INPUTS.videoPresetPolicySource);
    const videoDenoiseArtifact = await readJsonArtifact(inputs.videoDenoiseGate || DEFAULT_INPUTS.videoDenoiseGate);
    const videoDeliveryArtifact = await readJsonArtifact(inputs.videoDeliveryGate || DEFAULT_INPUTS.videoDeliveryGate);
    const videoReviewPackArtifact = await readJsonArtifact(inputs.videoReviewPack || DEFAULT_INPUTS.videoReviewPack);
    const videoAlphaShapeGateRoot = await readVideoAlphaShapeGateReports(inputs.videoAlphaShapeGateRoot || DEFAULT_INPUTS.videoAlphaShapeGateRoot);
    const allenkV2ComparisonArtifact = await readJsonArtifact(inputs.allenkV2Comparison || DEFAULT_INPUTS.allenkV2Comparison);
    const allenkV2ComparisonScriptPath = path.resolve(inputs.allenkV2ComparisonScript || DEFAULT_INPUTS.allenkV2ComparisonScript);
    const releaseClaims = await summarizeReleaseClaims(inputs.releaseClaimFiles || DEFAULT_INPUTS.releaseClaimFiles);

    const allenkReferenceLane = summarizeAllenkReference(inputs.allenkRepo || DEFAULT_INPUTS.allenkRepo, {
        localHeadOverride: inputs.allenkLocalHead || null,
        remoteHeadOverride: inputs.allenkRemoteHead || null
    });

    const lanes = [
        summarizePackage(packageArtifact, latestExtensionArtifact, {
            gitStatusText: inputs.gitStatusText ?? null,
            mtimeOverrides: inputs.releaseMtimeOverrides || {}
        }),
        releaseClaims,
        summarizeUserscriptArtifact(userscriptArtifact, packageArtifact, {
            mtimeOverrides: inputs.releaseMtimeOverrides || {}
        }),
        await summarizeReleaseVersionDocs(packageArtifact, inputs.releaseVersionDocs || {}),
        summarizeVisibleResidual(visibleLoopArtifact, visibleAuditArtifact, visibleAdmissionArtifact),
        summarizeV2Cleanup(v2CleanupArtifact),
        summarizeVideoProductionDefaults(videoCleanupBackendsSource, videoAppSource, videoPresetPolicySource),
        summarizeVideoDenoise(videoDenoiseArtifact),
        summarizeVideoReviewDelivery(videoDeliveryArtifact, videoReviewPackArtifact),
        summarizeVideoAlphaShape(videoAlphaShapeGateRoot),
        allenkReferenceLane,
        summarizeAllenkV2Comparison(allenkV2ComparisonArtifact, {
            sourcePaths: [
                allenkV2ComparisonScriptPath,
                v2CleanupArtifact.path,
                path.resolve(
                    inputs.videoCropBenchmark ||
                    allenkV2ComparisonArtifact.json?.inputs?.videoCropBenchmark ||
                    DEFAULT_INPUTS.videoCropBenchmark
                ),
                videoDenoiseArtifact.path,
                ...(videoAlphaShapeGateRoot.reports || []).map((item) => item.artifact.path)
            ],
            mtimeOverrides: inputs.allenkV2MtimeOverrides || inputs.releaseMtimeOverrides || {},
            allenkReferenceLane
        })
    ];

    if (scope === 'image-defaults') {
        const evidencePath = path.resolve(
            inputs.imageReleaseEvidence || `release/evidence/v${packageArtifact.json?.version}-image-quality.json`
        );
        const evidenceGate = inputs.imageEvidenceGate || await checkImageReleaseEvidence({
            evidencePath,
            quiet: true
        });
        lanes.push(summarizeImageReleaseEvidenceLane(
            evidenceGate,
            evidencePath
        ));
    }

    return {
        generatedAt: new Date().toISOString(),
        releaseScope: scope,
        inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [
            key,
            typeof value === 'string' &&
                key.endsWith('Head') === false &&
                key !== 'gitStatusText'
                ? path.resolve(value)
                : value
        ])),
        overall: deriveOverall(lanes, scope),
        provenance: {
            sourceArtifacts: [
                createArtifactProvenance('release-readiness-script', readinessScriptArtifact)
            ]
        },
        lanes
    };
}

function renderBlockers(blockers = []) {
    return blockers.length ? blockers.join(', ') : '-';
}

function renderCapabilityDecisionRows(report) {
    return Array.isArray(report.overall.capabilityDecisions)
        ? report.overall.capabilityDecisions
        : buildCapabilityDecisions(report.lanes || [], report.overall);
}

function renderReleaseInvariantChecks(report) {
    return report.overall.releaseInvariantChecks || summarizeReleaseInvariantChecks({
        ...report.overall,
        capabilityDecisions: renderCapabilityDecisionRows(report)
    });
}

function renderDecisionIds(items = []) {
    return items.length ? items.map((item) => item.id).join(', ') : '-';
}

function renderReleaseClaimMatrixRows(report) {
    return Array.isArray(report.overall.releaseClaimMatrix)
        ? report.overall.releaseClaimMatrix
        : summarizeReleaseClaimMatrix({
            ...report.overall,
            capabilityDecisions: renderCapabilityDecisionRows(report)
        });
}

function renderReleaseEvidenceIndexRows(report) {
    const derivedOverall = {
        ...report.overall,
        releaseDecisionSummary: report.overall.releaseDecisionSummary || summarizeReleaseDecisionSummary({
            ...report.overall,
            capabilityDecisions: renderCapabilityDecisionRows(report),
            releaseInvariantChecks: renderReleaseInvariantChecks(report)
        }),
        releaseClaimMatrix: renderReleaseClaimMatrixRows(report),
        releaseReadinessGate: report.overall.releaseReadinessGate || summarizeReleaseReadinessGate(report)
    };
    const index = report.overall.releaseEvidenceIndex || summarizeReleaseEvidenceIndex(report.lanes || [], derivedOverall);
    const integrity = report.overall.releaseEvidenceIndexIntegrity || summarizeReleaseEvidenceIndexIntegrity({
        ...derivedOverall,
        releaseEvidenceIndex: index
    });
    return [
        ['Recommendation', index.recommendation || '-'],
        ['Gate', index.gateOk ? 'pass' : 'fail'],
        ['Evidence index integrity', integrity.ok === true
            ? 'ok'
            : renderBlockers(integrity.blockers || [])],
        ['Release scope', index.releaseScope || '-'],
        ['Release zip', index.releasePackage?.zipPath || '-'],
        ['Release sha256', index.releasePackage?.sha256 || '-'],
        ['Zip hash checks', [
            `metadata=${yesNo(index.releasePackage?.hashMatchesMetadata === true)}`,
            `sha-file=${yesNo(index.releasePackage?.hashMatchesShaFile === true)}`,
            `size=${yesNo(index.releasePackage?.sizeMatchesMetadata === true)}`
        ].join(', ')],
        ['Claim scan', [
            index.claimPolicy?.publicClaimScanStatus || '-',
            `violations=${index.claimPolicy?.publicClaimViolationCount ?? '-'}`
        ].join(', ')],
        ['Allowed public capability rows', renderBlockers(index.claimPolicy?.allowedCapabilityIds || [])],
        ['Review-only capability rows', renderBlockers(index.claimPolicy?.reviewOnlyCapabilityIds || [])],
        ['Experiment-only capability rows', renderBlockers(index.claimPolicy?.experimentOnlyCapabilityIds || [])],
        ['Forbidden capability rows', renderBlockers(index.claimPolicy?.forbiddenCapabilityIds || [])],
        ['Active forbidden claims', renderBlockers(index.claimPolicy?.activeForbiddenClaims || [])],
        ['allenk comparison', [
            index.allenkComparison?.comparisonStatus || '-',
            `cases=${index.allenkComparison?.videoAllenkCaseCount ?? '-'}`,
            `rendered=${index.allenkComparison?.videoRenderedComparisonCount ?? '-'}`,
            `missingArtifacts=${index.allenkComparison?.videoMissingOutputArtifactCount ?? '-'}`
        ].join(', ')],
        ['allenk claim flags', [
            `v2-36=${yesNo(index.allenkComparison?.canClaimImageV2SmallGuarded === true)}`,
            `broad-v2=${yesNo(index.allenkComparison?.canClaimBroadImageV2Coverage === true)}`,
            `video-parity=${yesNo(index.allenkComparison?.canClaimVideoAllenkParity === true)}`
        ].join(', ')],
        ['Visible residual gate', [
            index.imageScope?.visibleResidualStatus || '-',
            `readyForGold=${yesNo(index.imageScope?.readyForGoldMigration === true)}`,
            `unconfirmed=${index.imageScope?.visibleResidualUnconfirmedCount ?? '-'}`
        ].join(', ')],
        ['Image V2 36 gate', [
            index.imageScope?.v2Status || '-',
            `releaseEligible=${yesNo(index.imageScope?.v2ReleaseEligible === true)}`
        ].join(', ')],
        ['Video defaults', [
            index.videoScope?.productionDefaultsStatus || '-',
            `denoise=${index.videoScope?.defaultDenoiseBackend ?? '-'}`
        ].join(', ')],
        ['Video experimental gates', [
            `denoise=${index.videoScope?.denoiseStatus || '-'}`,
            `denoisePromoted=${index.videoScope?.denoisePromotedCount ?? '-'}`,
            `alpha=${index.videoScope?.alphaShapeStatus || '-'}`,
            `alphaPromoted=${index.videoScope?.alphaShapePromotedCount ?? '-'}`
        ].join(', ')],
        ['Video review pack', [
            index.videoScope?.reviewDeliveryStatus || '-',
            `comparisons=${index.videoScope?.reviewComparisonCount ?? '-'}`
        ].join(', ')]
    ];
}

function renderVisibleResidualGateRows(report) {
    const lane = findLaneById(report.lanes, 'image-visible-residual');
    const evidence = lane?.evidence || {};
    return [
        ['Ready for gold migration', yesNo(evidence.readyForGoldMigration === true)],
        ['Unconfirmed decisions', evidence.unconfirmedCount ?? '-'],
        ['Ready decisions', evidence.readyDecisionCount ?? '-'],
        ['Pending human review', evidence.pendingHumanReview ?? '-'],
        ['Gold candidate total', evidence.goldCandidateTotal ?? '-'],
        ['Gold candidate unconfirmed', evidence.goldCandidateUnconfirmedCount ?? '-'],
        ['Top review cluster', evidence.topReviewCluster || '-'],
        ['Next gold candidate cluster', evidence.nextGoldCandidateReviewCluster || '-'],
        ['Review batches', evidence.reviewBatchCount !== null && evidence.reviewBatchCount !== undefined
            ? `${evidence.reviewBatchCount}/${evidence.reviewBatchTotal ?? '-'}`
            : '-'],
        ['Focused review decisions', evidence.focusedReviewBatchDecisionCount ?? '-'],
        ['Review manifest sha256', evidence.reviewManifestSha256 || '-'],
        ['Focused batch sha256', evidence.focusedReviewBatchSha256 || '-'],
        ['Human review pack hashes ready', yesNo(evidence.humanReviewPackArtifactHashesReady === true)],
        ['Formal gold manifest exists', yesNo(evidence.goldManifestExists === true)],
        ['Gold manifest integrity ready', yesNo(evidence.goldManifestIntegrityReady === true)],
        ['Production profile allowed', yesNo(evidence.productionProfileAllowed === true)],
        ['Production gate contract ready', yesNo(evidence.productionGateContractReady === true)],
        ['Production hits in source', evidence.productionHitCount ?? '-'],
        ['Production artifact hits', evidence.productionArtifactHitCount ?? '-'],
        ['Admission state', evidence.admissionCurrentState || '-'],
        ['Admission blockers', renderBlockers(evidence.admissionBlockedReasons || [])]
    ];
}

function renderVideoExperimentalGateRows(report) {
    const denoise = findLaneById(report.lanes, 'video-denoise-v2');
    const alpha = findLaneById(report.lanes, 'video-alpha-shape');
    const review = findLaneById(report.lanes, 'video-review-delivery');
    const denoiseEvidence = denoise?.evidence || {};
    const alphaEvidence = alpha?.evidence || {};
    const reviewEvidence = review?.evidence || {};
    const topAlphaRegression = Array.isArray(alphaEvidence.reports)
        ? [...alphaEvidence.reports]
            .filter((item) => Number(item.topVideoRegressionCount || 0) > 0)
            .sort((left, right) => Number(right.topVideoRegressionCount || 0) - Number(left.topVideoRegressionCount || 0))[0]
        : null;
    return [
        ['Denoise status', denoise?.status || '-'],
        ['Denoise required layers', denoiseEvidence.requiredLayerCount ?? '-'],
        ['Denoise observed layers', Array.isArray(denoiseEvidence.layerIds) ? denoiseEvidence.layerIds.length : '-'],
        ['Denoise total candidates', denoiseEvidence.totalCandidates ?? '-'],
        ['Denoise promoted candidates', renderBlockers(denoiseEvidence.promotedCandidates || [])],
        ['Denoise human review candidates', renderBlockers(denoiseEvidence.humanReviewCandidates || [])],
        ['Denoise insufficient evidence', renderBlockers(denoiseEvidence.insufficientEvidenceCandidates || [])],
        ['Denoise rejected candidates', renderBlockers(denoiseEvidence.rejectedCandidates || [])],
        ['Alpha-shape status', alpha?.status || '-'],
        ['Alpha-shape reports', alphaEvidence.reportCount ?? '-'],
        ['Alpha-shape promoted count', alphaEvidence.promotedCount ?? '-'],
        ['Alpha-shape rejected by video count', alphaEvidence.rejectedByVideoCount ?? '-'],
        ['Alpha-shape no-benchmark count', alphaEvidence.noBenchmarkCount ?? '-'],
        ['Worst alpha-shape regression report', topAlphaRegression
            ? `${topAlphaRegression.name} / ${topAlphaRegression.topCandidate || '-'} / regressions=${topAlphaRegression.topVideoRegressionCount}`
            : '-'],
        ['Review delivery status', review?.status || '-'],
        ['Review delivery ready', yesNo(reviewEvidence.deliveryReady === true)],
        ['Review comparison count', reviewEvidence.reviewComparisonCount ?? '-'],
        ['Review cases', renderBlockers(reviewEvidence.reviewCases || [])],
        ['Review views', renderBlockers(reviewEvidence.reviewViews || [])],
        ['Review best candidate', reviewEvidence.bestCandidate?.profileLabel || '-'],
        ['Review best candidate decision', reviewEvidence.bestCandidate?.decision || '-'],
        ['Temporal gate status', reviewEvidence.temporalStatus || '-']
    ];
}

function renderGateBlockers(blockers = []) {
    return blockers.length ? blockers.join(', ') : '-';
}

function renderReleaseGateSummary(gate) {
    return [
        `Gate: ${gate?.ok ? 'pass' : 'fail'}`,
        `Required recommendation: ${gate?.requiredRecommendation || '-'}`,
        `Actual recommendation: ${gate?.actualRecommendation || '-'}`,
        `Gate blockers: ${renderGateBlockers(gate?.blockers || [])}`
    ];
}

export function renderReleaseReadinessMarkdown(report) {
    const lines = [];
    lines.push('# Release Readiness Report');
    lines.push('');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push(`Recommendation: ${report.overall.recommendation}`);
    lines.push(`Current image capability ready: ${report.overall.currentImageCapabilityReady ? 'yes' : 'no'}`);
    lines.push(`Current image defaults immediately releasable: ${report.overall.canReleaseCurrentImageDefaults ? 'yes' : 'no'}`);
    lines.push(`Video V2 allenk parity claim: ${report.overall.canClaimVideoV2Parity ? 'yes' : 'no'}`);
    lines.push('');
    lines.push('## Gate Summary');
    lines.push('');
    for (const line of renderReleaseGateSummary(report.overall.releaseReadinessGate || summarizeReleaseReadinessGate(report))) {
        lines.push(line);
    }
    lines.push('');
    lines.push('## Capability Decisions');
    lines.push('');
    lines.push('| Capability | Decision | Evidence |');
    lines.push('|---|---|---|');
    for (const row of renderCapabilityDecisionRows(report)) {
        lines.push(`| ${row.title} | ${row.decision} | ${row.evidenceSummary} |`);
    }
    lines.push('');
    const decisionSummary = report.overall.releaseDecisionSummary || summarizeReleaseDecisionSummary({
        ...report.overall,
        capabilityDecisions: renderCapabilityDecisionRows(report),
        releaseInvariantChecks: renderReleaseInvariantChecks(report)
    });
    lines.push('## Release Decision Summary');
    lines.push('');
    lines.push(`Current release scope: ${decisionSummary.currentReleaseScope}`);
    lines.push(`Release now: ${renderDecisionIds(decisionSummary.releaseNow)}`);
    lines.push(`Guarded release: ${renderDecisionIds(decisionSummary.guardedRelease)}`);
    lines.push(`Safe current defaults: ${renderDecisionIds(decisionSummary.safeCurrentDefaults)}`);
    lines.push(`Visual review only: ${renderDecisionIds(decisionSummary.visualReviewOnly)}`);
    lines.push(`Experiment only: ${renderDecisionIds(decisionSummary.experimentOnly)}`);
    lines.push(`Blocked: ${renderDecisionIds(decisionSummary.blocked)}`);
    lines.push(`Release claim guards: ${decisionSummary.releaseClaimGuardsOk ? 'ok' : 'blocked'}`);
    lines.push('');
    lines.push('## Release Claim Matrix');
    lines.push('');
    lines.push('| Capability | Claim status | Decision | Forbidden claim | Guard required | Evidence |');
    lines.push('|---|---|---|---|---:|---|');
    for (const row of renderReleaseClaimMatrixRows(report)) {
        const forbiddenClaim = row.forbiddenClaim
            ? `${row.forbiddenClaim}${row.forbiddenClaimActive ? ' (active)' : ''}`
            : '-';
        lines.push(`| ${row.title} | ${row.claimStatus} | ${row.decision} | ${forbiddenClaim} | ${row.releaseClaimGuardRequired ? 'yes' : 'no'} | ${row.evidenceSummary || '-'} |`);
    }
    lines.push('');
    lines.push('## Release Evidence Index');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    for (const [field, value] of renderReleaseEvidenceIndexRows(report)) {
        lines.push(`| ${field} | ${value} |`);
    }
    lines.push('');
    lines.push('## Lane Summary');
    lines.push('');
    lines.push('| Lane | Status | Release Eligible | Blockers |');
    lines.push('|---|---|---:|---|');
    for (const lane of report.lanes) {
        lines.push(`| ${lane.title} | ${lane.status} | ${lane.releaseEligible ? 'yes' : 'no'} | ${renderBlockers(lane.blockers)} |`);
    }
    lines.push('');
    const invariantChecks = renderReleaseInvariantChecks(report);
    lines.push('## Release Invariant Checks');
    lines.push('');
    lines.push(`Invariant coverage: ${invariantChecks.ok ? 'ok' : 'blocked'}`);
    lines.push(`Missing blocked claims: ${invariantChecks.missingBlockedClaims.length}`);
    lines.push(`Missing release claim guards: ${invariantChecks.missingReleaseClaimGuards.length}`);
    lines.push(`Unregistered blocked capabilities: ${invariantChecks.unregisteredBlockedCapabilities.length}`);
    lines.push('');
    lines.push('## Source Provenance');
    lines.push('');
    for (const source of report.provenance?.sourceArtifacts || []) {
        lines.push(`- ${source.id}: ${source.sha256 || 'missing'} (${source.mtimeUtc || '-'})`);
    }
    if (!report.provenance?.sourceArtifacts?.length) lines.push('- none');
    lines.push('');
    lines.push('## Blocked Claims');
    lines.push('');
    if (report.overall.blockedClaims.length) {
        for (const claim of report.overall.blockedClaims) lines.push(`- ${claim}`);
    } else {
        lines.push('- none');
    }
    lines.push('');
    lines.push('## Visible Residual Gate');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    for (const [field, value] of renderVisibleResidualGateRows(report)) {
        lines.push(`| ${field} | ${value} |`);
    }
    lines.push('');
    lines.push('## Video Experimental Gates');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    for (const [field, value] of renderVideoExperimentalGateRows(report)) {
        lines.push(`| ${field} | ${value} |`);
    }
    lines.push('');
    lines.push('## Lane Notes');
    lines.push('');
    for (const lane of report.lanes) {
        lines.push(`### ${lane.title}`);
        lines.push('');
        for (const note of lane.releaseNotes || []) lines.push(`- ${note}`);
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

export async function writeReleaseReadinessReport({
    outputPath = DEFAULT_OUTPUT_PATH,
    markdownPath = DEFAULT_MARKDOWN_PATH,
    inputs = DEFAULT_INPUTS,
    scope = null
} = {}) {
    const report = await createReleaseReadinessReport({ inputs, scope });
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedMarkdownPath = path.resolve(markdownPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(resolvedMarkdownPath, renderReleaseReadinessMarkdown(report), 'utf8');
    return {
        ...report,
        outputPath: resolvedOutputPath,
        markdownPath: resolvedMarkdownPath
    };
}

function parseCliArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        markdownPath: DEFAULT_MARKDOWN_PATH,
        failOnNotReady: false
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--output') {
            parsed.outputPath = argv[++i] || parsed.outputPath;
        } else if (arg === '--markdown') {
            parsed.markdownPath = argv[++i] || parsed.markdownPath;
        } else if (arg === '--fail-on-not-ready') {
            parsed.failOnNotReady = true;
        } else if (arg === '--scope') {
            parsed.scope = argv[++i] || null;
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
  node scripts/create-release-readiness-report.js [options]

Options:
  --output <path>      Default: .artifacts/release-readiness/latest-report.json
  --markdown <path>    Default: .artifacts/release-readiness/latest-report.md
  --scope <scope>      Supported: image-defaults
  --fail-on-not-ready  Exit non-zero unless the report is immediately releasable
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    writeReleaseReadinessReport(args)
        .then((report) => {
            console.log(`json: ${report.outputPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            console.log(`recommendation: ${report.overall.recommendation}`);
            if (args.failOnNotReady) {
                const gate = summarizeReleaseReadinessGate(report);
                console.log(`release quality gate: ${gate.ok ? 'pass' : 'fail'}`);
                if (!gate.ok) {
                    console.error(`release quality gate blockers: ${gate.blockers.join(', ')}`);
                    process.exit(1);
                }
            }
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
