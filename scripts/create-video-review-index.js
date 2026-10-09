import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_REVIEW_PACK_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-pack.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMetric(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(4) : '-';
}

function formatVideoProbe(probe) {
    if (!probe?.exists) return 'missing';
    const video = probe.video || {};
    return [
        video.width && video.height ? `${video.width}x${video.height}` : null,
        video.frameRate || null,
        Number.isFinite(Number(video.duration)) ? `${Number(video.duration).toFixed(3)}s` : null
    ].filter(Boolean).join(' / ');
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

function groupComparisonsByCase(comparisons = []) {
    const grouped = new Map();
    for (const item of comparisons) {
        if (!grouped.has(item.caseId)) grouped.set(item.caseId, []);
        grouped.get(item.caseId).push(item);
    }
    for (const items of grouped.values()) {
        items.sort((a, b) => {
            const order = { roi: 0, full: 1 };
            return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
        });
    }
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderStatusPill(label, value, tone = 'neutral') {
    return `<span class="pill ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></span>`;
}

function renderComparisonCard(item, outputPath) {
    const videoUrl = toAssetUrl(item.outputPath, outputPath);
    const snapshotUrl = toAssetUrl(item.snapshotPath, outputPath);
    const crop = item.cropBox
        ? `Crop ${item.cropBox.x},${item.cropBox.y},${item.cropBox.width},${item.cropBox.height}`
        : 'Full frame';
    return `
      <article class="media-card ${item.kind === 'roi' ? 'roi-card' : 'full-card'}">
        <div class="media-head">
          <h3>${escapeHtml(item.kind.toUpperCase())}</h3>
          <span>${escapeHtml(formatVideoProbe(item.probe))}</span>
        </div>
        <video class="review-video" controls preload="metadata" data-case="${escapeHtml(item.caseId)}" data-kind="${escapeHtml(item.kind)}" src="${videoUrl}"></video>
        ${snapshotUrl ? `<a class="snapshot-link" href="${snapshotUrl}"><img src="${snapshotUrl}" alt="${escapeHtml(item.caseId)} ${escapeHtml(item.kind)} contact sheet"></a>` : ''}
        <div class="meta-row">${escapeHtml(crop)}</div>
        <a class="path-link" href="${videoUrl}">${escapeHtml(path.basename(item.outputPath || 'video'))}</a>
      </article>`;
}

function renderTemporalGate(deliveryReport = {}) {
    const temporal = deliveryReport?.temporal;
    if (!temporal) return '';
    const rows = (temporal.comparisons || []).map((item) => `
      <tr>
        <td>${escapeHtml(item.candidateId)}</td>
        <td>${escapeHtml(item.baselineId)}</td>
        <td>${formatMetric(item.delta?.meanSameJitter)}</td>
        <td>${formatMetric(item.delta?.meanMatchedJitter)}</td>
        <td>${formatMetric(item.delta?.worsenedRatio)}</td>
      </tr>`).join('');
    return `
      <section>
        <div class="section-title">
          <h2>Temporal Gate</h2>
          ${renderStatusPill('status', temporal.status, temporal.status === 'pass' ? 'good' : 'warn')}
        </div>
        <table>
          <thead><tr><th>Candidate</th><th>Baseline</th><th>Same Δ</th><th>Matched Δ</th><th>Worsened Δ</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function renderTemporalLab(reviewPack = {}, outputPath) {
    if (!reviewPack.temporal?.cases?.length) return '';
    const rows = reviewPack.temporal.cases.map((item) => `
      <tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${escapeHtml(item.pairCount)}</td>
        <td>${formatMetric(item.meanSameJitter)}</td>
        <td>${formatMetric(item.meanMatchedJitter)}</td>
        <td>${formatMetric(item.improvement)}</td>
        <td>${formatMetric(item.worsenedRatio)}</td>
        <td><a href="${toAssetUrl(item.sheetPath, outputPath)}">sheet</a></td>
      </tr>`).join('');
    return `
      <section>
        <div class="section-title">
          <h2>Temporal Lab</h2>
          ${renderStatusPill('match radius', reviewPack.temporal.matchRadius)}
        </div>
        <table>
          <thead><tr><th>Case</th><th>Pairs</th><th>Same jitter</th><th>Matched jitter</th><th>Improvement</th><th>Worsened</th><th>Sheet</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
}

function renderChecklist(items = []) {
    if (!items.length) return '';
    return `
      <section>
        <h2>Checklist</h2>
        <ul class="checklist">
          ${items.map((item) => `<li><input type="checkbox"> <span>${escapeHtml(item)}</span></li>`).join('')}
        </ul>
      </section>`;
}

function normalizeDecisionOptions(options = null) {
    const fallback = [
        { value: 'pending', label: 'Pending' },
        { value: 'accept', label: 'Accept current preset' },
        { value: 'needs-polish', label: 'Needs light polish' },
        { value: 'reject', label: 'Reject candidate' }
    ];
    if (!Array.isArray(options) || !options.length) return fallback;
    return options
        .filter((item) => item && item.value && item.label)
        .map((item) => ({ value: String(item.value), label: String(item.label) }));
}

function renderDecisionPanel(options = null) {
    const normalizedOptions = normalizeDecisionOptions(options);
    return `
      <section class="decision-panel">
        <div class="section-title">
          <h2>Decision</h2>
          <span class="save-status" data-role="save-status">Not saved</span>
        </div>
        <div class="decision-grid">
          <label>Review result
            <select data-action="decision">
              ${normalizedOptions.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </label>
          <label>Notes
            <textarea data-action="notes" rows="4" placeholder="Record visible residual, edge flicker, or acceptance notes."></textarea>
          </label>
        </div>
        <div class="decision-actions">
          <button type="button" data-action="export-decision">Export decision JSON</button>
        </div>
      </section>`;
}

function renderPlaybackControls() {
    return `
      <section class="review-controls" aria-label="Video playback controls">
        <div>
          <h2>Playback</h2>
          <p>Use these controls to scan ROI and full-frame videos together.</p>
        </div>
        <div class="control-row">
          <button type="button" data-action="play-all">Play all</button>
          <button type="button" data-action="pause-all">Pause</button>
          <button type="button" data-action="reset-all">Reset</button>
          <span class="divider" aria-hidden="true"></span>
          <button type="button" data-action="seek-all" data-time="0">0s</button>
          <button type="button" data-action="seek-all" data-time="2">2s</button>
          <button type="button" data-action="seek-all" data-time="4">4s</button>
          <button type="button" data-action="seek-all" data-time="6">6s</button>
          <button type="button" data-action="seek-all" data-time="8">8s</button>
          <button type="button" data-action="seek-all" data-time="9.5">9.5s</button>
          <span class="divider" aria-hidden="true"></span>
          <label class="toggle"><input type="checkbox" data-action="loop-all"> Loop</label>
          <label class="select-label">Speed
            <select data-action="speed">
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
          </label>
        </div>
      </section>`;
}

export function renderVideoReviewIndexHtml({ reviewPack, deliveryReport = null, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
    const best = reviewPack?.delivery?.bestCandidate || {};
    const grouped = groupComparisonsByCase(reviewPack?.comparisons || []);
    const deliveryReady = reviewPack?.delivery?.ready === true;
    const temporalStatus = deliveryReport?.temporal?.status || (reviewPack?.temporal ? 'available' : 'missing');
    const pageTitle = reviewPack?.title || 'Video Watermark Review';
    const subtitle = reviewPack?.subtitle ? `${reviewPack.subtitle} · ` : '';

    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --panel: #171b22;
      --panel-2: #202630;
      --text: #f5f7fb;
      --muted: #a9b2c3;
      --line: #313948;
      --good: #42d392;
      --warn: #f4c95d;
      --bad: #ff6b6b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1360px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
    h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 20px; }
    h3 { font-size: 14px; }
    .subtle { color: var(--muted); margin-top: 8px; }
    .pills { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 6px 10px; display: inline-flex; gap: 8px; align-items: center; color: var(--muted); }
    .pill strong { color: var(--text); font-weight: 650; }
    .pill.good strong { color: var(--good); }
    .pill.warn strong { color: var(--warn); }
    .pill.bad strong { color: var(--bad); }
    section { margin-top: 26px; }
    .section-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .case { border-top: 1px solid var(--line); padding-top: 18px; margin-top: 22px; }
    .review-controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .review-controls p { color: var(--muted); margin: 4px 0 0; }
    .control-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }
    button, select, textarea { color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px; font: inherit; }
    button, select { min-height: 34px; padding: 0 10px; }
    textarea { width: 100%; min-height: 96px; padding: 10px; resize: vertical; }
    button { cursor: pointer; }
    button:hover, select:hover, textarea:hover { border-color: #5b6a82; }
    button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid #8cc7ff; outline-offset: 2px; }
    .toggle, .select-label { color: var(--muted); display: inline-flex; gap: 6px; align-items: center; min-height: 34px; }
    .divider { width: 1px; height: 24px; background: var(--line); display: inline-block; }
    .media-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; margin-top: 12px; }
    .media-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
    .media-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; color: var(--muted); margin-bottom: 10px; }
    video { width: 100%; aspect-ratio: 16 / 9; background: #05070a; border-radius: 6px; display: block; }
    .media-card.roi-card video { aspect-ratio: 1 / 1; }
    .snapshot-link { display: block; margin-top: 10px; }
    img { width: 100%; border-radius: 6px; border: 1px solid var(--line); display: block; }
    .meta-row { color: var(--muted); margin-top: 8px; }
    a { color: #8cc7ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .path-link { display: inline-block; margin-top: 6px; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
    th { background: var(--panel-2); color: var(--muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .checklist { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
    .checklist li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
    .decision-panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    .decision-grid { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 14px; }
    .decision-grid label { color: var(--muted); display: grid; gap: 8px; }
    .decision-actions { margin-top: 12px; display: flex; justify-content: flex-end; }
    .save-status { color: var(--muted); }
    input[type="checkbox"] { margin-top: 3px; }
    @media (max-width: 720px) {
      main { padding: 18px; }
      header { display: block; }
      .pills { justify-content: flex-start; margin-top: 14px; }
      .review-controls { display: block; }
      .control-row { justify-content: flex-start; margin-top: 12px; }
      .decision-grid { grid-template-columns: 1fr; }
      .decision-actions { justify-content: flex-start; }
      .media-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(pageTitle)}</h1>
        <div class="subtle">${escapeHtml(subtitle)}Generated: ${escapeHtml(reviewPack?.generatedAt || '-')}</div>
      </div>
      <div class="pills">
        ${renderStatusPill('delivery', reviewPack?.delivery?.status, deliveryReady ? 'good' : 'bad')}
        ${renderStatusPill('temporal', temporalStatus, temporalStatus === 'pass' ? 'good' : 'neutral')}
        ${renderStatusPill('candidate', best.decision || '-')}
      </div>
    </header>

    <section>
      <div class="section-title">
        <h2>Summary</h2>
      </div>
      <table>
        <tbody>
          <tr><th>Best candidate</th><td>${escapeHtml(best.profileLabel || '-')}</td></tr>
          <tr><th>Benchmark</th><td>total ${escapeHtml(reviewPack?.delivery?.benchmark?.total ?? '-')}, rendered ${escapeHtml(reviewPack?.delivery?.benchmark?.rendered ?? '-')}, failed ${escapeHtml(reviewPack?.delivery?.benchmark?.failed ?? '-')}</td></tr>
          <tr><th>Blockers</th><td>${escapeHtml(reviewPack?.delivery?.blockers?.length ? reviewPack.delivery.blockers.join(', ') : '-')}</td></tr>
        </tbody>
      </table>
    </section>

    ${renderPlaybackControls()}

    <section>
      <h2>Videos</h2>
      ${grouped.map(([caseId, items]) => `
        <div class="case">
          <h3>${escapeHtml(caseId)}</h3>
          <div class="media-grid">
            ${items.map((item) => renderComparisonCard(item, outputPath)).join('')}
          </div>
        </div>`).join('')}
    </section>

    ${renderTemporalGate(deliveryReport)}
    ${renderTemporalLab(reviewPack, outputPath)}
    ${renderDecisionPanel(reviewPack?.decisionOptions)}
    ${renderChecklist(reviewPack?.checklist || [])}
  </main>
  <script>
    (() => {
      const videos = Array.from(document.querySelectorAll('.review-video'));
      const $ = (selector) => document.querySelector(selector);
      const storageKey = 'gwr-video-review:' + location.pathname;
      const status = $('[data-role="save-status"]');
      const decision = $('[data-action="decision"]');
      const notes = $('[data-action="notes"]');
      const checklist = Array.from(document.querySelectorAll('.checklist input[type="checkbox"]'));
      const getState = () => ({
        decision: decision?.value || 'pending',
        notes: notes?.value || '',
        checklist: checklist.map((input, index) => ({
          index,
          checked: input.checked,
          text: input.closest('li')?.innerText.trim() || ''
        }))
      });
      const setStatus = (text) => {
        if (status) status.textContent = text;
      };
      const saveState = () => {
        localStorage.setItem(storageKey, JSON.stringify(getState()));
        setStatus('Saved locally');
      };
      const restoreState = () => {
        try {
          const state = JSON.parse(localStorage.getItem(storageKey) || '{}');
          if (decision && state.decision) decision.value = state.decision;
          if (notes && typeof state.notes === 'string') notes.value = state.notes;
          if (Array.isArray(state.checklist)) {
            state.checklist.forEach((item) => {
              if (checklist[item.index]) checklist[item.index].checked = item.checked === true;
            });
          }
          if (state.decision || state.notes || state.checklist) setStatus('Restored local draft');
        } catch {
          setStatus('Local draft unavailable');
        }
      };
      const collectDecision = () => ({
        exportedAt: new Date().toISOString(),
        page: location.href,
        deliveryStatus: ${JSON.stringify(reviewPack?.delivery?.status || null)},
        temporalStatus: ${JSON.stringify(temporalStatus)},
        candidate: ${JSON.stringify(best.profileLabel || null)},
        videos: videos.map((video) => ({
          caseId: video.dataset.case || '',
          kind: video.dataset.kind || '',
          src: video.getAttribute('src') || '',
          currentTime: Number(video.currentTime.toFixed(3)),
          playbackRate: video.playbackRate,
          loop: video.loop
        })),
        ...getState()
      });
      const downloadJson = (payload) => {
        const blob = new Blob([JSON.stringify(payload, null, 2) + '\\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'video-review-decision-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setStatus('Exported decision JSON');
      };
      const setLoop = (enabled) => videos.forEach((video) => { video.loop = enabled; });
      const setSpeed = (value) => videos.forEach((video) => { video.playbackRate = value; });
      $('[data-action="play-all"]')?.addEventListener('click', () => {
        for (const video of videos) {
          video.play().catch(() => {});
        }
      });
      $('[data-action="pause-all"]')?.addEventListener('click', () => {
        videos.forEach((video) => video.pause());
      });
      $('[data-action="reset-all"]')?.addEventListener('click', () => {
        videos.forEach((video) => {
          video.pause();
          video.currentTime = 0;
        });
      });
      document.querySelectorAll('[data-action="seek-all"]').forEach((button) => {
        button.addEventListener('click', () => {
          const time = Number(button.dataset.time) || 0;
          videos.forEach((video) => {
            video.pause();
            video.currentTime = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
          });
        });
      });
      $('[data-action="loop-all"]')?.addEventListener('change', (event) => {
        setLoop(event.target.checked);
      });
      $('[data-action="speed"]')?.addEventListener('change', (event) => {
        setSpeed(Number(event.target.value) || 1);
      });
      decision?.addEventListener('change', saveState);
      notes?.addEventListener('input', saveState);
      checklist.forEach((input) => input.addEventListener('change', saveState));
      $('[data-action="export-decision"]')?.addEventListener('click', () => {
        saveState();
        downloadJson(collectDecision());
      });
      restoreState();
      setSpeed(1);
    })();
  </script>
</body>
</html>
`;
}

async function readJson(filePath) {
    return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function createVideoReviewIndex({
    reviewPackPath = DEFAULT_REVIEW_PACK_PATH,
    outputPath = DEFAULT_OUTPUT_PATH
} = {}) {
    const reviewPack = await readJson(reviewPackPath);
    const deliveryReport = reviewPack.deliveryReportPath && existsSync(reviewPack.deliveryReportPath)
        ? await readJson(reviewPack.deliveryReportPath)
        : null;
    const resolvedOutputPath = path.resolve(outputPath);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, renderVideoReviewIndexHtml({
        reviewPack,
        deliveryReport,
        outputPath: resolvedOutputPath
    }), 'utf8');
    return {
        outputPath: resolvedOutputPath,
        reviewPackPath: path.resolve(reviewPackPath),
        comparisons: reviewPack.comparisons?.length || 0,
        temporalStatus: deliveryReport?.temporal?.status || null,
        temporalCases: reviewPack.temporal?.cases?.length || 0
    };
}

function parseArgs(argv) {
    const parsed = {
        reviewPackPath: DEFAULT_REVIEW_PACK_PATH,
        outputPath: DEFAULT_OUTPUT_PATH
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') continue;
        if (arg === '--review-pack') {
            parsed.reviewPackPath = path.resolve(argv[++i] || DEFAULT_REVIEW_PACK_PATH);
        } else if (arg === '--output') {
            parsed.outputPath = path.resolve(argv[++i] || DEFAULT_OUTPUT_PATH);
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
  node scripts/create-video-review-index.js [--review-pack <json>] [--output <html>]

Default output:
  .artifacts/video-boundary-gradient-auto/review-pack/latest-review-index.html
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }
    createVideoReviewIndex(args)
        .then((report) => {
            console.log(`html: ${report.outputPath}`);
            console.log(`videos: ${report.comparisons}`);
            console.log(`temporal: ${report.temporalStatus || (report.temporalCases ? `${report.temporalCases} lab cases` : '-')}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exitCode = 1;
        });
}
