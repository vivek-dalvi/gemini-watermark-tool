import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readText(relativePath) {
    return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('current package version should be documented in both changelog files', async () => {
    const packageJson = JSON.parse(await readText('package.json'));
    const versionHeadingPattern = new RegExp(`^##\\s+${packageJson.version}\\s+-\\s+`, 'm');
    const [changelogEn, changelogZh] = await Promise.all([
        readText('CHANGELOG.md'),
        readText('CHANGELOG_zh.md')
    ]);

    assert.match(changelogEn, versionHeadingPattern);
    assert.match(changelogZh, versionHeadingPattern);
});

test('release checklists should require updating both changelog files', async () => {
    const [releaseEn, releaseZh] = await Promise.all([
        readText('RELEASE.md'),
        readText('RELEASE_zh.md')
    ]);

    assert.match(releaseEn, /CHANGELOG\.md/);
    assert.match(releaseEn, /CHANGELOG_zh\.md/);
    assert.match(releaseZh, /CHANGELOG\.md/);
    assert.match(releaseZh, /CHANGELOG_zh\.md/);
});

test('release checklists should include the Chrome extension package artifacts', async () => {
    const packageJson = JSON.parse(await readText('package.json'));
    const [releaseEn, releaseZh] = await Promise.all([
        readText('RELEASE.md'),
        readText('RELEASE_zh.md')
    ]);

    assert.equal(packageJson.scripts?.['package:extension'], 'node scripts/package-extension-release.js');
    assert.match(releaseEn, /pnpm package:extension/);
    assert.match(releaseEn, /latest-extension\.json/);
    assert.match(releaseEn, /official website/i);
    assert.match(releaseZh, /pnpm package:extension/);
    assert.match(releaseZh, /latest-extension\.json/);
    assert.match(releaseZh, /官网/);
});

test('release checklists should require internal comparison and readiness gates', async () => {
    const packageJson = JSON.parse(await readText('package.json'));
    const [releaseEn, releaseZh] = await Promise.all([
        readText('RELEASE.md'),
        readText('RELEASE_zh.md')
    ]);

    assert.equal(packageJson.scripts?.['compare:allenk-v2'], 'node scripts/create-allenk-v2-comparison-report.js');
    assert.equal(packageJson.scripts?.['release:image-validation'], 'node scripts/run-image-release-validation.js');
    assert.equal(packageJson.scripts?.['release:image-evidence'], 'node scripts/create-image-release-evidence.js');
    assert.equal(packageJson.scripts?.['release:image-quality-gate'], 'node scripts/check-image-release-evidence.js');
    assert.equal(packageJson.scripts?.['release:readiness'], 'node scripts/create-release-readiness-report.js');
    assert.equal(
        packageJson.scripts?.['release:quality-gate'],
        'pnpm release:image-quality-gate && pnpm compare:allenk-v2 && pnpm release:readiness -- --scope image-defaults --fail-on-not-ready'
    );
    assert.equal(packageJson.scripts?.['release:goal-audit'], 'node scripts/create-release-goal-audit-report.js');
    assert.equal(
        packageJson.scripts?.['release:ci-check'],
        'node scripts/check-github-ci.js --workflow ci.yml --commit HEAD --fail-closed'
    );
    assert.equal(
        packageJson.scripts?.['release:preflight'],
        'pnpm build && pnpm test && pnpm package:extension && pnpm release:quality-gate && pnpm release:goal-audit -- --fail-on-incomplete && pnpm release:ci-check'
    );
    assert.match(releaseEn, /pnpm release:preflight/);
    assert.match(releaseEn, /pnpm release:goal-audit/);
    assert.match(releaseEn, /pnpm release:quality-gate/);
    assert.match(releaseEn, /pnpm release:ci-check/);
    assert.match(releaseEn, /GitHub Actions CI/);
    assert.match(releaseEn, /internal comparison gate/);
    assert.doesNotMatch(releaseEn, /pnpm compare:allenk-v2/);
    assert.match(releaseEn, /image-defaults/);
    assert.match(releaseEn, /pnpm release:readiness/);
    assert.match(releaseEn, /--fail-on-not-ready/);
    assert.match(releaseZh, /pnpm release:preflight/);
    assert.match(releaseZh, /pnpm release:goal-audit/);
    assert.match(releaseZh, /pnpm release:quality-gate/);
    assert.match(releaseZh, /pnpm release:ci-check/);
    assert.match(releaseZh, /GitHub Actions CI/);
    assert.match(releaseZh, /内部对比 gate/);
    assert.doesNotMatch(releaseZh, /pnpm compare:allenk-v2/);
    assert.match(releaseZh, /image-defaults/);
    assert.match(releaseZh, /pnpm release:readiness/);
    assert.match(releaseZh, /--fail-on-not-ready/);
});

test('release checklists should bind public notes to the release claim matrix', async () => {
    const [releaseEn, releaseZh] = await Promise.all([
        readText('RELEASE.md'),
        readText('RELEASE_zh.md')
    ]);

    assert.match(releaseEn, /Release Claim Matrix/);
    assert.match(releaseEn, /allowed-scoped/);
    assert.match(releaseEn, /allowed-safety-only/);
    assert.match(releaseEn, /review-only/);
    assert.match(releaseEn, /experiment-only/);
    assert.match(releaseEn, /forbidden/);
    assert.match(releaseZh, /Release Claim Matrix/);
    assert.match(releaseZh, /allowed-scoped/);
    assert.match(releaseZh, /allowed-safety-only/);
    assert.match(releaseZh, /review-only/);
    assert.match(releaseZh, /experiment-only/);
    assert.match(releaseZh, /forbidden/);
});
