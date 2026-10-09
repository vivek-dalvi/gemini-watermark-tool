import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.html');
const DEFAULT_REPORT_PATH = path.resolve('.artifacts/video-delivery-dashboard/latest-video-dashboard.json');

const DEFAULT_LANES = [
    {
        id: 'current025',
        title: 'Current Candidate 0.25',
        subtitle: 'Default visual-review candidate',
        reviewHtmlPath: path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html'),
        screenshotPath: path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.png'),
        reviewPackPath: path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json'),
        deliveryReportPath: path.resolve('.artifacts/video-boundary-gradient-auto/delivery-gate/latest-delivery-report.json'),
        decisionTemplatePath: path.resolve('.artifacts/video-delivery-bundle/decision-templates/current025.decision.template.json'),
        decisionReportPath: path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.md'),
        decisionJsonPath: path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-decision-report.json'),
        primaryAction: 'Accept current preset only after checklist is fully checked.'
    },
    {
        id: 'polish020',
        title: 'Light Polish 0.20',
        subtitle: 'Backup comparison against 0.25',
        reviewHtmlPath: path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.html'),
        screenshotPath: path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.png'),
        reviewPackPath: path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json'),
        gateReportPath: path.resolve('.artifacts/video-light-polish-strength020/gate/latest-report.md'),
        decisionTemplatePath: path.resolve('.artifacts/video-delivery-bundle/decision-templates/polish020.decision.template.json'),
        decisionReportPath: path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.md'),
        decisionJsonPath: path.resolve('.artifacts/video-light-polish-strength020/review-pack/latest-polish-review-decision-report.json'),
        primaryAction: 'Use only if it is visibly cleaner without new softness or shimmer.'
    },
    {
        id: 'sweep018022',
        title: 'Strength Sweep',
        subtitle: 'Compare 0.18, 0.20, 0.22, and 0.25',
        reviewHtmlPath: path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html'),
        screenshotPath: path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.png'),
        reviewPackPath: path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json'),
        gateReportPath: path.resolve('.artifacts/video-light-polish-sweep018022/gate/latest-report.md'),
        decisionTemplatePath: path.resolve('.artifacts/video-delivery-bundle/decision-templates/sweep018022.decision.template.json'),
        decisionReportPath: path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.md'),
        decisionJsonPath: path.resolve('.artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-decision-report.json'),
        primaryAction: 'Promote 0.18 or 0.22 only if the sweep page is clearly better by eye.'
    },
    {
        id: 'alphaPolicy035',
        title: 'Alpha Policy 0.35',
        subtitle: 'Candidate-aware alpha edge policy review',
        reviewHtmlPath: path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html'),
        screenshotPath: path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-index.png'),
        reviewPackPath: path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json'),
        gateReportPath: path.resolve('.artifacts/video-alpha-policy-evidence/latest-report.md'),
        decisionTemplatePath: path.resolve('.artifacts/video-delivery-bundle/decision-templates/alphaPolicy035.decision.template.json'),
        decisionReportPath: path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.md'),
        decisionJsonPath: path.resolve('.artifacts/video-alpha-policy035-review/review-pack/latest-alpha-policy-review-decision-report.json'),
        diagnosticLinks: [
            {
                label: 'Known flaw diagnostics',
                path: path.resolve('.artifacts/video-policy035-default-review/user-flaw-diagnostics/latest.json')
            },
            {
                label: 'Headlight crop',
                path: path.resolve('.artifacts/video-policy035-default-review/user-flaw-diagnostics/deaee69b-headlight-user-crop.png')
            },
            {
                label: 'Rail crop',
                path: path.resolve('.artifacts/video-policy035-default-review/user-flaw-diagnostics/e1997e6e-rail-user-crop.png')
            },
            {
                label: 'Rejected shape gate',
                path: path.resolve('.artifacts/video-alpha-shape-candidate-gate/manual-shape-validated/latest-report.md')
            }
        ],
        primaryAction: 'Use only if it is visibly cleaner than current 0.25 without edge shimmer or softness.'
    }
];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isWindowsAbsolutePath(filePath) {
    return /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\[^\\]/.test(filePath);
}

function toAssetUrl(filePath, outputPath) {
    if (!filePath) return '';
    const relativePath = isWindowsAbsolutePath(filePath) && isWindowsAbsolutePath(outputPath)
        ? path.win32.relative(path.win32.dirname(path.win32.normalize(outputPath)), path.win32.normalize(filePath))
        : path.relative(path.dirname(path.resolve(outputPath)), path.resolve(filePath));
    return encodeURI(relativePath.replaceAll('\\', '/'));
}

function formatNumber(value, digits = 4) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '-';
}

async function readJsonIfExists(filePath) {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(await readFile(filePath, 'utf8'));
}

function summarizeReviewPack(pack = null) {
    if (!pack) return null;
    const evidence = pack.delivery?.bestCandidate?.evidence || null;
    return {
        generatedAt: pack.generatedAt || null,
        status: pack.delivery?.status || null,
        ready: pack.delivery?.ready === true,
        bestCandidate: pack.delivery?.bestCandidate?.profileLabel || null,
        candidateDecision: pack.delivery?.bestCandidate?.decision || null,
        candidateEvidence: evidence?.total ? {
            status: evidence.decision?.status || null,
            reason: evidence.decision?.reason || null,
            reportPath: evidence.reportPath || null,
            reports: Number(evidence.total.reports) || 0,
            comparedCases: Number(evidence.total.comparedCases) || 0,
            improvedCases: Number(evidence.total.improvedCases) || 0,
            materialRegressedCases: Number(evidence.total.materialRegressedCases) || 0,
            warningRegressedCases: Number(evidence.total.warningRegressedCases) || 0
        } : null,
        comparisons: pack.comparisons?.length || 0,
        temporalCases: pack.temporal?.cases?.length || 0,
        blockers: pack.delivery?.blockers || []
    };
}

function summarizeDeliveryReport(report = null) {
    if (!report) return null;
    return {
        status: report.status || null,
        ready: report.ready === true,
        temporalStatus: report.temporal?.status || null,
        blockers: report.blockers || [],
        bestCandidate: report.gate?.bestCandidate?.profileLabel || null,
        candidateDecision: report.gate?.bestCandidate?.decision || null
    };
}

function summarizeDecisionReport(report = null) {
    if (!report) return null;
    return {
        status: report.status || null,
        decision: report.decision || null,
        reviewMode: report.reviewMode || null,
        nextAction: report.nextAction || null,
        checklist: report.checklist || null,
        warnings: report.warnings || [],
        blockers: report.blockers || []
    };
}

function renderPill(label, value, tone = 'neutral') {
    return `<span class="pill ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></span>`;
}

function statusTone(value, ready = false) {
    if (ready || value === 'pass' || value === 'ready-for-visual-review' || value === 'review-only' || value === 'promote-default-candidate' || value === 'regression-free-human-review') return 'good';
    if (!value || value === '-') return 'muted';
    if (['rejected', 'reject', 'invalid'].includes(value)) return 'bad';
    return 'warn';
}

function renderFileLink(label, filePath, outputPath) {
    if (!filePath) return '';
    const exists = existsSync(filePath);
    const href = toAssetUrl(filePath, outputPath);
    return `<a class="${exists ? '' : 'missing'}" href="${href}">${escapeHtml(label)}${exists ? '' : ' (missing)'}</a>`;
}

function createDecisionCommand(lane = {}) {
    if (!lane.decisionTemplatePath || !lane.decisionJsonPath || !lane.decisionReportPath) return null;
    return `pnpm report:video-review-decision -- --decision ${path.resolve(lane.decisionTemplatePath)} --output ${path.resolve(lane.decisionJsonPath)} --markdown ${path.resolve(lane.decisionReportPath)}`;
}

function renderCopyableCommand(command = null) {
    if (!command) return '-';
    return `
              <div class="copy-command">
                <code>${escapeHtml(command)}</code>
                <button type="button" data-copy-command="${escapeHtml(command)}">Copy</button>
              </div>`;
}

function formatEvidenceSummary(evidence = null) {
    if (!evidence) return '-';
    return `${evidence.reports} reports, ${evidence.comparedCases} cases, ${evidence.improvedCases} improved, ${evidence.materialRegressedCases} material, ${evidence.warningRegressedCases} warning`;
}

function renderEvidenceSummary(evidence = null, outputPath) {
    const summary = escapeHtml(formatEvidenceSummary(evidence));
    if (!evidence?.reportPath) return summary;
    return `${summary}<br>${renderFileLink('Evidence report', evidence.reportPath, outputPath)}`;
}

function renderDiagnosticLinks(links = [], outputPath) {
    if (!links.length) return '';
    return links.map((item) => renderFileLink(item.label || 'Diagnostic', item.path, outputPath)).join(' ');
}

function renderLane(lane, outputPath) {
    const summary = lane.summary || {};
    const delivery = lane.deliverySummary || null;
    const decision = lane.decisionSummary || null;
    const status = delivery?.status || summary.status || '-';
    const temporalStatus = delivery?.temporalStatus || (summary.temporalCases ? 'available' : '-');
    const ready = Boolean(delivery?.ready || summary.ready);
    const candidateDecision = summary.candidateDecision || delivery?.candidateDecision || null;
    const candidateEvidence = summary.candidateEvidence || null;
    const blockers = [...(delivery?.blockers || []), ...(summary.blockers || [])];
    const checklist = decision?.checklist ? `${decision.checklist.checked}/${decision.checklist.total}` : '-';
    const decisionCommand = createDecisionCommand(lane);
    const screenshot = lane.screenshotPath && existsSync(lane.screenshotPath)
        ? `<a class="shot-link" href="${toAssetUrl(lane.reviewHtmlPath, outputPath)}"><img src="${toAssetUrl(lane.screenshotPath, outputPath)}" alt="${escapeHtml(lane.title)} screenshot"></a>`
        : '<div class="shot-missing">No screenshot</div>';

    return `
      <article class="lane-card" data-lane="${escapeHtml(lane.id)}">
        <div class="lane-head">
          <div>
            <h2>${escapeHtml(lane.title)}</h2>
            <p>${escapeHtml(lane.subtitle)}</p>
          </div>
          <div class="pill-stack">
            ${renderPill('status', status, statusTone(status, ready))}
            ${renderPill('temporal', temporalStatus, statusTone(temporalStatus))}
            ${renderPill('evidence', candidateDecision, statusTone(candidateDecision))}
          </div>
        </div>
        ${screenshot}
        <table>
          <tbody>
            <tr><th>Candidate</th><td>${escapeHtml(summary.bestCandidate || delivery?.bestCandidate || '-')}</td></tr>
            <tr><th>Decision</th><td>${escapeHtml(candidateDecision || '-')}</td></tr>
            <tr><th>Evidence stats</th><td>${renderEvidenceSummary(candidateEvidence, outputPath)}</td></tr>
            <tr><th>Diagnostics</th><td>${renderDiagnosticLinks(lane.diagnosticLinks || [], outputPath) || '-'}</td></tr>
            <tr><th>Videos</th><td>${escapeHtml(summary.comparisons ?? '-')}</td></tr>
            <tr><th>Temporal cases</th><td>${escapeHtml(summary.temporalCases ?? '-')}</td></tr>
            <tr><th>Review status</th><td>${escapeHtml(decision?.status || '-')}</td></tr>
            <tr><th>Checklist</th><td>${escapeHtml(checklist)}</td></tr>
            <tr><th>Blockers</th><td>${escapeHtml(blockers.length ? blockers.join(', ') : '-')}</td></tr>
            <tr><th>Next</th><td>${escapeHtml(decision?.nextAction || lane.primaryAction)}</td></tr>
            <tr><th>Decision command</th><td class="command">${renderCopyableCommand(decisionCommand)}</td></tr>
          </tbody>
        </table>
        <div class="links">
          ${renderFileLink('Open review page', lane.reviewHtmlPath, outputPath)}
          ${renderFileLink('Review pack JSON', lane.reviewPackPath, outputPath)}
          ${renderFileLink('Gate report', lane.gateReportPath || lane.deliveryReportPath, outputPath)}
          ${candidateEvidence?.reportPath ? renderFileLink('Evidence report', candidateEvidence.reportPath, outputPath) : ''}
          ${renderDiagnosticLinks(lane.diagnosticLinks || [], outputPath)}
          ${renderFileLink('Decision template', lane.decisionTemplatePath, outputPath)}
          ${renderFileLink('Decision report', lane.decisionReportPath, outputPath)}
          ${renderFileLink('Decision JSON', lane.decisionJsonPath, outputPath)}
        </div>
      </article>`;
}

function collectLaneAssets(lane = {}) {
    const assets = [
        ['reviewHtml', lane.reviewHtmlPath],
        ['screenshot', lane.screenshotPath],
        ['reviewPack', lane.reviewPackPath],
        ['deliveryReport', lane.deliveryReportPath],
        ['gateReport', lane.gateReportPath],
        ['decisionTemplate', lane.decisionTemplatePath],
        ['decisionReport', lane.decisionReportPath],
        ['decisionJson', lane.decisionJsonPath],
        ...(lane.diagnosticLinks || []).map((item) => [`diagnostic:${item.label || 'Diagnostic'}`, item.path])
    ]
        .filter(([, filePath]) => Boolean(filePath))
        .map(([name, filePath]) => ({
            name,
            path: path.resolve(filePath),
            exists: existsSync(filePath)
        }));
    return {
        assets,
        missingAssets: assets.filter((asset) => !asset.exists)
    };
}

function renderSummaryRows(lanes = []) {
    return lanes.map((lane) => {
        const summary = lane.summary || {};
        const delivery = lane.deliverySummary || {};
        return `
          <tr>
            <td>${escapeHtml(lane.title)}</td>
            <td>${escapeHtml(delivery.status || summary.status || '-')}</td>
            <td>${escapeHtml(delivery.temporalStatus || (summary.temporalCases ? 'available' : '-'))}</td>
            <td>${escapeHtml(summary.bestCandidate || delivery.bestCandidate || '-')}</td>
            <td>${escapeHtml(lane.decisionSummary?.status || '-')}</td>
            <td>${escapeHtml(summary.comparisons ?? '-')}</td>
            <td>${escapeHtml(summary.temporalCases ?? '-')}</td>
          </tr>`;
    }).join('');
}

function collectTemporalRows(lanes = []) {
    const rows = [];
    for (const lane of lanes) {
        for (const item of lane.reviewPack?.temporal?.cases || []) {
            const aggregate = item.aggregate || item;
            rows.push({
                laneId: lane.id,
                lane: lane.title,
                id: item.id,
                same: aggregate.meanSameJitter,
                matched: aggregate.meanMatchedJitter,
                worsened: aggregate.worsenedRatio
            });
        }
    }
    return rows;
}

function renderTemporalRows(rows = []) {
    return rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.lane)}</td>
        <td>${escapeHtml(row.id)}</td>
        <td>${formatNumber(row.same)}</td>
        <td>${formatNumber(row.matched)}</td>
        <td>${formatNumber(row.worsened)}</td>
      </tr>`).join('');
}

export function renderVideoDeliveryDashboardHtml({ generatedAt, lanes, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
    const temporalRows = collectTemporalRows(lanes);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Video Delivery Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101216;
      --panel: #171b22;
      --panel-2: #202632;
      --text: #f5f7fb;
      --muted: #aab4c5;
      --line: #303849;
      --good: #45d483;
      --warn: #f2c05e;
      --bad: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1440px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; }
    p { margin: 6px 0 0; color: var(--muted); }
    .subtle { color: var(--muted); }
    .pill-stack, .top-pills { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; color: var(--muted); display: inline-flex; gap: 8px; }
    .pill strong { color: var(--text); }
    .pill.good strong { color: var(--good); }
    .pill.warn strong { color: var(--warn); }
    .pill.bad strong { color: var(--bad); }
    .pill.muted strong { color: var(--muted); }
    .lanes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 20px; }
    .lane-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .lane-head { display: flex; justify-content: space-between; gap: 12px; padding: 14px; border-bottom: 1px solid var(--line); }
    .shot-link, .shot-missing { display: block; background: #0b0d11; border-bottom: 1px solid var(--line); }
    .shot-link img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top left; display: block; }
    .shot-missing { padding: 48px 14px; color: var(--muted); text-align: center; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); width: 140px; font-weight: 600; background: color-mix(in srgb, var(--panel-2) 65%, transparent); }
    .links { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 14px 14px; }
    a { color: #8cc8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.missing { color: var(--bad); }
    section { margin-top: 26px; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .panel h2 { padding: 14px; border-bottom: 1px solid var(--line); }
    .command { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text); overflow-wrap: anywhere; }
    .copy-command { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
    .copy-command code { white-space: normal; word-break: break-word; }
    .copy-command button {
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      font: 600 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .copy-command button:hover { border-color: #587091; }
    .copy-command button:focus-visible { outline: 2px solid #8cc8ff; outline-offset: 2px; }
    @media (max-width: 980px) {
      main { padding: 18px; }
      header { display: block; }
      .top-pills { justify-content: flex-start; margin-top: 14px; }
      .lanes { grid-template-columns: 1fr; }
      .lane-head { display: block; }
      .pill-stack { justify-content: flex-start; margin-top: 10px; }
      .copy-command { grid-template-columns: 1fr; }
      .copy-command button { width: max-content; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Video Delivery Dashboard</h1>
        <p>Generated: ${escapeHtml(generatedAt || '-')}</p>
      </div>
      <div class="top-pills">
        ${renderPill('lanes', lanes?.length ?? 0, 'good')}
        ${renderPill('primary', '0.25 review', 'good')}
        ${renderPill('goal', 'human acceptance pending', 'warn')}
      </div>
    </header>

    <section class="panel">
      <h2>Lane Summary</h2>
      <table>
        <thead><tr><th>Lane</th><th>Status</th><th>Temporal</th><th>Candidate</th><th>Review</th><th>Videos</th><th>Temporal cases</th></tr></thead>
        <tbody>${renderSummaryRows(lanes)}</tbody>
      </table>
    </section>

    <section class="lanes">
      ${lanes.map((lane) => renderLane(lane, outputPath)).join('')}
    </section>

    <section class="panel">
      <h2>Temporal Snapshot</h2>
      <table>
        <thead><tr><th>Lane</th><th>Case</th><th>Same jitter</th><th>Matched jitter</th><th>Worsened</th></tr></thead>
        <tbody>${renderTemporalRows(temporalRows)}</tbody>
      </table>
    </section>

    <section class="panel">
      <h2>Rebuild Commands</h2>
      <table>
        <tbody>
          <tr><th>Primary review</th><td class="command">pnpm report:video-review-pack && pnpm report:video-review-index</td></tr>
          <tr><th>0.20 review</th><td class="command">pnpm report:video-light-polish-review-pack && pnpm report:video-review-index -- --review-pack .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-pack.json --output .artifacts/video-light-polish-strength020/review-pack/latest-polish-review-index.html</td></tr>
          <tr><th>Sweep review</th><td class="command">pnpm report:video-polish-sweep-review-pack && pnpm report:video-review-index -- --review-pack .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-pack.json --output .artifacts/video-light-polish-sweep018022/review-pack/latest-sweep-review-index.html</td></tr>
          <tr><th>0.35 alpha review</th><td class="command">pnpm report:video-alpha-policy-evidence && pnpm report:video-alpha-policy-review-pack && pnpm report:video-review-index -- --review-pack .artifacts/video-alpha-policy035-review/review-pack/latest-review-pack.json --output .artifacts/video-alpha-policy035-review/review-pack/latest-review-index.html && pnpm report:video-review-screenshot && pnpm report:video-pending-review-decision</td></tr>
        </tbody>
      </table>
    </section>
  </main>
  <script>
    (() => {
      async function copyText(text) {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      document.querySelectorAll('[data-copy-command]').forEach((button) => {
        const original = button.textContent;
        button.addEventListener('click', async () => {
          try {
            await copyText(button.dataset.copyCommand || '');
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = original; }, 1200);
          } catch {
            button.textContent = 'Failed';
            setTimeout(() => { button.textContent = original; }, 1600);
          }
        });
      });
    })();
  </script>
</body>
</html>
`;
}

export async function createVideoDeliveryDashboard({
    outputPath = DEFAULT_OUTPUT_PATH,
    reportPath = DEFAULT_REPORT_PATH,
    lanes = DEFAULT_LANES
} = {}) {
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedReportPath = path.resolve(reportPath);
    const hydratedLanes = [];
    for (const lane of lanes) {
        const reviewPack = await readJsonIfExists(lane.reviewPackPath);
        const deliveryReport = await readJsonIfExists(lane.deliveryReportPath);
        const decisionReport = await readJsonIfExists(lane.decisionJsonPath);
        const assetStatus = collectLaneAssets(lane);
        hydratedLanes.push({
            ...lane,
            assetStatus,
            reviewPack,
            summary: summarizeReviewPack(reviewPack),
            deliverySummary: summarizeDeliveryReport(deliveryReport),
            decisionSummary: summarizeDecisionReport(decisionReport)
        });
    }
    const generatedAt = new Date().toISOString();
    const temporalRows = collectTemporalRows(hydratedLanes);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, renderVideoDeliveryDashboardHtml({
        generatedAt,
        lanes: hydratedLanes,
        outputPath: resolvedOutputPath
    }), 'utf8');
    const report = {
        generatedAt,
        outputPath: resolvedOutputPath,
        lanes: hydratedLanes.map((lane) => ({
            id: lane.id,
            title: lane.title,
            status: lane.deliverySummary?.status || lane.summary?.status || null,
            temporalStatus: lane.deliverySummary?.temporalStatus || (lane.summary?.temporalCases ? 'available' : null),
            reviewStatus: lane.decisionSummary?.status || null,
            nextAction: lane.decisionSummary?.nextAction || null,
            checklist: lane.decisionSummary?.checklist || null,
            decisionTemplatePath: lane.decisionTemplatePath ? path.resolve(lane.decisionTemplatePath) : null,
            decisionCommand: createDecisionCommand(lane),
            ready: Boolean(lane.summary?.ready || lane.deliverySummary?.ready),
            bestCandidate: lane.summary?.bestCandidate || lane.deliverySummary?.bestCandidate || null,
            candidateDecision: lane.summary?.candidateDecision || lane.deliverySummary?.candidateDecision || null,
            candidateEvidence: lane.summary?.candidateEvidence || null,
            diagnosticLinks: (lane.diagnosticLinks || []).map((item) => ({
                label: item.label || 'Diagnostic',
                path: item.path ? path.resolve(item.path) : null,
                exists: item.path ? existsSync(item.path) : false
            })),
            comparisons: lane.summary?.comparisons || 0,
            temporalCases: lane.summary?.temporalCases || 0,
            assets: lane.assetStatus.assets,
            missingAssets: lane.assetStatus.missingAssets
        })),
        temporalRows
    };
    report.missingAssets = report.lanes.flatMap((lane) => lane.missingAssets.map((asset) => ({
        laneId: lane.id,
        name: asset.name,
        path: asset.path
    })));
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return {
        outputPath: resolvedOutputPath,
        reportPath: resolvedReportPath,
        generatedAt,
        lanes: hydratedLanes.length,
        readyLanes: hydratedLanes.filter((lane) => lane.summary?.ready || lane.deliverySummary?.ready).length,
        missingAssets: report.missingAssets.length
    };
}

function parseArgs(argv) {
    const parsed = {
        outputPath: DEFAULT_OUTPUT_PATH,
        reportPath: DEFAULT_REPORT_PATH
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
        } else if (arg === '--report') {
            parsed.reportPath = path.resolve(argv[++i] || DEFAULT_REPORT_PATH);
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
  node scripts/create-video-delivery-dashboard.js [--output <html>] [--report <json>]

Default output:
  .artifacts/video-delivery-dashboard/latest-video-dashboard.html
  .artifacts/video-delivery-dashboard/latest-video-dashboard.json
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoDeliveryDashboard(args)
        .then((report) => {
            console.log(`html: ${report.outputPath}`);
            console.log(`json: ${report.reportPath}`);
            console.log(`lanes: ${report.lanes}`);
            console.log(`ready lanes: ${report.readyLanes}`);
            console.log(`missing assets: ${report.missingAssets}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
