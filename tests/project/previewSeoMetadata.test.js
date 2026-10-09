import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readText(relativePath) {
    return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('public root page should stay noindex with canonical pointed to the official website', async () => {
    const html = await readText('public/index.html');

    assert.match(html, /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*nofollow[^"]*"/i);
    assert.match(
        html,
        /<link\s+rel="canonical"\s+href="https:\/\/geminiwatermarkremover\.io\/"\s*\/?>/i
    );
});

test('public root page should point users to the official website, userscript, and retained internal preview page', async () => {
    const html = await readText('public/index.html');

    assert.match(html, /href="https:\/\/geminiwatermarkremover\.io\/"/i);
    assert.match(html, /href="userscript\/gemini-watermark-remover\.user\.js"/i);
    assert.match(html, /href="\.\/dev-preview\.html"|href="dev-preview\.html"/i);
});

test('internal dev preview page should retain the browser preview app entry', async () => {
    const html = await readText('public/dev-preview.html');

    assert.match(html, /id="uploadArea"/i);
    assert.match(html, /id="comparisonContainer"/i);
    assert.match(html, /<script\s+src="app\.js"><\/script>/i);
});

test('internal dev preview page should not depend on external Tailwind CDN', async () => {
    const html = await readText('public/dev-preview.html');

    assert.doesNotMatch(html, /cdn\.tailwindcss\.com/i);
    assert.doesNotMatch(html, /\btailwind\.config\b/i);
    assert.match(html, /href="dev-preview\.css"/i);
});

test('internal dev preview page should support multi-file image batches without old zip download UI', async () => {
    const html = await readText('public/dev-preview.html');

    assert.match(html, /<input[^>]+id="fileInput"[^>]+\bmultiple\b/i);
    assert.match(html, /id="multiPreview"/i);
    assert.match(html, /id="imageList"/i);
    assert.match(html, /id="progressText"/i);
    assert.doesNotMatch(html, /id="downloadAllBtn"/i);
});

test('internal dev preview page should not expose language switch, theme toggle, or html i18n hooks', async () => {
    const html = await readText('public/dev-preview.html');

    assert.doesNotMatch(html, /id="langSwitch"/i);
    assert.doesNotMatch(html, /id="themeToggle"/i);
    assert.doesNotMatch(html, /data-i18n="/i);
    assert.doesNotMatch(html, /\bdark:/i);
});
