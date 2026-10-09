import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

const DEFAULT_REPORT_PATH = path.resolve(
    '.artifacts/visible-residual-crops/latest/alpha-profile/geometry-family-48-96-96-reference-boundary.json'
);
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/alpha-profile');
const WIDTH = 920;
const HEIGHT = 680;
const PLOT_LEFT = 78;
const PLOT_TOP = 76;
const PLOT_WIDTH = 730;
const PLOT_HEIGHT = 480;

function parseArgs(argv) {
    const parsed = {
        reportPath: DEFAULT_REPORT_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };
    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--report') {
            parsed.reportPath = path.resolve(args.shift() || parsed.reportPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        }
    }
    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function escapeSvgText(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function pointX(spatial) {
    return PLOT_LEFT + Math.max(0, Math.min(1, spatial)) * PLOT_WIDTH;
}

function pointY(gradient) {
    return PLOT_TOP + (1 - Math.max(0, Math.min(1, gradient))) * PLOT_HEIGHT;
}

function colorForOutcome(outcome) {
    if (outcome === 'cleared') return '#40d97a';
    if (outcome === 'unsafe') return '#ff5c5c';
    if (outcome === 'visible-after') return '#ffb238';
    return '#9aa4b2';
}

function shapeForRecord(record) {
    return record.targetProfileLine ? 'circle' : 'diamond';
}

function basenameWithoutExt(file) {
    return path.basename(file).replace(/\.[^.]+$/, '');
}

function renderGrid() {
    const parts = [];
    for (let tick = 0; tick <= 10; tick++) {
        const value = tick / 10;
        const x = pointX(value);
        const y = pointY(value);
        const label = value.toFixed(1);
        parts.push(`<line x1="${x}" y1="${PLOT_TOP}" x2="${x}" y2="${PLOT_TOP + PLOT_HEIGHT}" stroke="#2d2d2d" stroke-width="1"/>`);
        parts.push(`<line x1="${PLOT_LEFT}" y1="${y}" x2="${PLOT_LEFT + PLOT_WIDTH}" y2="${y}" stroke="#2d2d2d" stroke-width="1"/>`);
        parts.push(`<text x="${x}" y="${PLOT_TOP + PLOT_HEIGHT + 22}" fill="#b8b8b8" font-size="11" text-anchor="middle">${label}</text>`);
        parts.push(`<text x="${PLOT_LEFT - 16}" y="${y + 4}" fill="#b8b8b8" font-size="11" text-anchor="end">${label}</text>`);
    }
    return parts.join('');
}

function renderPoint(record, index) {
    const x = pointX(record.spatial);
    const y = pointY(record.gradient);
    const color = colorForOutcome(record.outcome);
    const shape = shapeForRecord(record);
    const label = `${basenameWithoutExt(record.file).slice(-8)} ${record.profileLine}`;
    const labelOnLeft = x > PLOT_LEFT + PLOT_WIDTH * 0.78;
    const labelX = labelOnLeft ? x - 10 : x + 10;
    const labelAnchor = labelOnLeft ? 'end' : 'start';
    const yNudge = y < PLOT_TOP + 36
        ? 18 + (index % 4) * 12
        : (index % 2 === 0 ? -12 : 22);
    const labelY = y + yNudge;
    const marker = shape === 'circle'
        ? `<circle cx="${x}" cy="${y}" r="7" fill="${color}" stroke="#101010" stroke-width="2"/>`
        : `<rect x="${x - 6}" y="${y - 6}" width="12" height="12" transform="rotate(45 ${x} ${y})" fill="${color}" stroke="#101010" stroke-width="2"/>`;
    return `${marker}<text x="${labelX}" y="${labelY}" fill="#e5e5e5" font-size="10" font-family="Arial, sans-serif" text-anchor="${labelAnchor}">${escapeSvgText(label)}</text>`;
}

function renderBestRule(report) {
    const rule = report.summary?.bestRuleKeepingAllCleared?.rule;
    if (!rule) return '';
    const parts = [];
    if (rule.type === 'gradient-at-least' || rule.type === 'spatial-and-gradient-at-least' || rule.type === 'spatial-or-gradient-at-least') {
        const gradient = rule.gradient;
        if (Number.isFinite(gradient)) {
            const y = pointY(gradient);
            parts.push(`<line x1="${PLOT_LEFT}" y1="${y}" x2="${PLOT_LEFT + PLOT_WIDTH}" y2="${y}" stroke="#f5f5f5" stroke-width="2" stroke-dasharray="8 6"/>`);
            parts.push(`<text x="${PLOT_LEFT + PLOT_WIDTH - 6}" y="${y - 8}" fill="#f5f5f5" font-size="12" text-anchor="end">best keep-clear: gradient >= ${gradient}</text>`);
        }
    }
    if (rule.type === 'spatial-at-least' || rule.type === 'spatial-and-gradient-at-least' || rule.type === 'spatial-or-gradient-at-least') {
        const spatial = rule.spatial;
        if (Number.isFinite(spatial)) {
            const x = pointX(spatial);
            parts.push(`<line x1="${x}" y1="${PLOT_TOP}" x2="${x}" y2="${PLOT_TOP + PLOT_HEIGHT}" stroke="#f5f5f5" stroke-width="2" stroke-dasharray="8 6"/>`);
            parts.push(`<text x="${x + 6}" y="${PLOT_TOP + 16}" fill="#f5f5f5" font-size="12">spatial >= ${spatial}</text>`);
        }
    }
    return parts.join('');
}

function renderSvg(report) {
    const records = [...(report.records ?? [])].sort((left, right) => (
        (left.outcome === 'cleared' ? 1 : 0) - (right.outcome === 'cleared' ? 1 : 0)
    ));
    const legend = [
        ['cleared', 'cleared'],
        ['visible-after', 'visible after'],
        ['unsafe', 'unsafe'],
        ['non-visible-not-cleared', 'not cleared']
    ].map(([outcome, label], index) => {
        const x = PLOT_LEFT + index * 140;
        const y = HEIGHT - 62;
        return `<circle cx="${x}" cy="${y}" r="6" fill="${colorForOutcome(outcome)}"/><text x="${x + 12}" y="${y + 4}" fill="#d7d7d7" font-size="12">${label}</text>`;
    }).join('');
    const title = [
        '48/96/96 reference evidence boundary',
        `reference power-0.88 + alphaGain=0.55, cleanIsolationRules=${report.summary?.cleanIsolationRuleCount ?? 0}`,
        'circle = 48px-large-margin profileLine, diamond = non-target profileLine'
    ];
    return `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
<rect width="100%" height="100%" fill="#111"/>
${title.map((line, index) => `<text x="${PLOT_LEFT}" y="${28 + index * 18}" fill="${index === 0 ? '#f2f2f2' : '#c7c7c7'}" font-size="${index === 0 ? 16 : 12}" font-family="Arial, sans-serif">${escapeSvgText(line)}</text>`).join('')}
<rect x="${PLOT_LEFT}" y="${PLOT_TOP}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#181818" stroke="#555"/>
${renderGrid()}
${renderBestRule(report)}
${records.map(renderPoint).join('')}
<text x="${PLOT_LEFT + PLOT_WIDTH / 2}" y="${PLOT_TOP + PLOT_HEIGHT + 48}" fill="#d0d0d0" font-size="13" text-anchor="middle">forced 48/96/96 spatial evidence</text>
<text x="22" y="${PLOT_TOP + PLOT_HEIGHT / 2}" fill="#d0d0d0" font-size="13" transform="rotate(-90 22 ${PLOT_TOP + PLOT_HEIGHT / 2})" text-anchor="middle">forced 48/96/96 gradient evidence</text>
${legend}
</svg>`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const report = JSON.parse(stripBom(await readFile(args.reportPath, 'utf8')));
    await mkdir(args.outputDir, { recursive: true });
    const imagePath = path.join(args.outputDir, 'geometry-family-48-96-96-reference-boundary.png');
    const sheetJsonPath = path.join(args.outputDir, 'geometry-family-48-96-96-reference-boundary-sheet.json');
    const svg = renderSvg(report);
    await sharp(Buffer.from(svg)).png().toFile(imagePath);
    const sheetSummary = {
        generatedAt: new Date().toISOString(),
        reportPath: args.reportPath,
        imagePath,
        summary: report.summary,
        policy: report.policy
    };
    await writeFile(sheetJsonPath, `${JSON.stringify(sheetSummary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        imagePath,
        sheetJsonPath,
        summary: report.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
