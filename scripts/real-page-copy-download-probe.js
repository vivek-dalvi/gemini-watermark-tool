import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import {
  runTampermonkeyFreshnessCheck,
  shouldFailTampermonkeyFreshnessCheck
} from './tampermonkey-freshness.js';

export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL = 'http://127.0.0.1:9226';
export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT = path.resolve(
  process.cwd(),
  '.artifacts/real-page-copy-download'
);
export const DEFAULT_REAL_PAGE_COPY_DOWNLOAD_PAGE_URL_PREFIX = 'https://gemini.google.com/';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const REPORT_FILENAME = 'latest.json';
const DOWNLOAD_FILENAME = 'latest-download.png';
const PAGE_RELOAD_TIMEOUT_MS = 30_000;
const PAGE_READY_TIMEOUT_MS = 60_000;
const CLIPBOARD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
const COPY_ACTION_LABELS = ['复制图片', 'Copy image'];
const DOWNLOAD_ACTION_LABELS = ['下载完整尺寸的图片', 'Download full size image'];

class ProbeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProbeFailure';
    this.code = code;
  }
}

function normalizeCdpUrl(value) {
  const normalized = String(value || '').trim();
  if (/^\d+$/.test(normalized)) {
    return `http://127.0.0.1:${normalized}`;
  }
  return normalized || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL;
}

export function parseExpectedImageSize(value, flagName) {
  const match = /^(\d+)[xX](\d+)$/.exec(String(value || '').trim());
  const width = Number(match?.[1] || 0);
  const height = Number(match?.[2] || 0);
  if (!match || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${flagName} must use WIDTHxHEIGHT with positive integers`);
  }
  return { width, height };
}

export function parseRealPageCopyDownloadCliArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    cdpUrl: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    outputRoot: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT,
    pageUrlPrefix: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_PAGE_URL_PREFIX,
    expectedClipboardSize: null,
    expectedDownloadSize: null
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--') continue;
    if (arg === '--cdp') {
      parsed.cdpUrl = normalizeCdpUrl(args.shift());
      continue;
    }
    if (arg === '--output-root') {
      parsed.outputRoot = path.resolve(process.cwd(), args.shift() || parsed.outputRoot);
      continue;
    }
    if (arg === '--page-prefix') {
      parsed.pageUrlPrefix = String(args.shift() || parsed.pageUrlPrefix).trim() || parsed.pageUrlPrefix;
      continue;
    }
    if (arg === '--expected-clipboard-size') {
      parsed.expectedClipboardSize = parseExpectedImageSize(args.shift(), arg);
      continue;
    }
    if (arg === '--expected-download-size') {
      parsed.expectedDownloadSize = parseExpectedImageSize(args.shift(), arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function inspectPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG signature or truncated IHDR');
  }
  if (buffer.readUInt32BE(8) < 13 || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Invalid PNG IHDR');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new Error('Invalid PNG dimensions');
  }
  return { bytes: buffer.length, width, height };
}

function sanitizeObservedPathname(pathname, kinds) {
  if (kinds.includes('rd-gg')) {
    return pathname.replace(/\/(rd-gg(?:-dl)?)(?:\/.*)?$/i, '/$1/<redacted>').slice(0, 240);
  }
  if (kinds.includes('gg')) {
    return pathname.replace(/\/(gg(?:-dl)?)(?:\/.*)?$/i, '/$1/<redacted>').slice(0, 240);
  }
  return pathname.slice(0, 240);
}

export function classifyObservedRequest({ url = '', postData = '', phase = 'copy', method = 'GET' } = {}) {
  const textUrl = String(url || '');
  const textPostData = String(postData || '');
  let parsed;
  try {
    parsed = new URL(textUrl);
  } catch {
    return null;
  }

  const kinds = [];
  const isGoogleAssetHost = /(^|\.)googleusercontent\.com$/i.test(parsed.hostname);
  if (textUrl.includes('c8o8Fe') || textPostData.includes('c8o8Fe')) kinds.push('c8o8Fe');
  if (isGoogleAssetHost && /\/rd-gg(?:-dl)?\//i.test(parsed.pathname)) kinds.push('rd-gg');
  if (isGoogleAssetHost && /\/gg(?:-dl)?\//i.test(parsed.pathname)) kinds.push('gg');
  if (kinds.length === 0) return null;

  return {
    phase,
    kinds,
    method: String(method || 'GET').toUpperCase(),
    hostname: parsed.hostname,
    pathname: sanitizeObservedPathname(parsed.pathname, kinds)
  };
}

export function sanitizeGeminiPageUrl(value) {
  try {
    const parsed = new URL(value);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments[0] === 'u' && segments[2] === 'app') {
      return `${parsed.origin}/u/<account>/app${segments[3] ? '/<conversation>' : ''}`;
    }
    if (segments[0] === 'app') {
      return `${parsed.origin}/app${segments[1] ? '/<conversation>' : ''}`;
    }
    return `${parsed.origin}/${segments[0] || ''}`.replace(/\/$/, '');
  } catch {
    return '';
  }
}

export function createInitialProbeReport(options = {}, generatedAt = new Date().toISOString()) {
  return {
    generatedAt,
    status: 'fail',
    stage: 'freshness',
    cdpUrl: options.cdpUrl || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    pageUrl: '',
    freshness: { status: 'unavailable', exactMatch: false, reportPath: null },
    expectations: {
      clipboardSize: options.expectedClipboardSize || null,
      downloadSize: options.expectedDownloadSize || null
    },
    clipboard: {
      writeCalled: false,
      writeResolved: false,
      mimeType: '',
      validPng: false,
      bytes: 0,
      width: 0,
      height: 0,
      error: ''
    },
    download: {
      eventObserved: false,
      artifactPath: null,
      suggestedFilename: '',
      validPng: false,
      bytes: 0,
      width: 0,
      height: 0,
      sawC8o8Fe: false,
      sawPhysicalRdGg: false
    },
    network: [],
    dialogs: [],
    failures: []
  };
}

function addFailure(failures, code, message) {
  failures.push({ code, message });
}

function matchesSize(actual, expected) {
  return !expected || (actual.width === expected.width && actual.height === expected.height);
}

export function evaluateCopyDownloadProbe(report) {
  const failures = [];
  if (report.freshness?.status !== 'fresh' || report.freshness?.exactMatch !== true) {
    addFailure(failures, 'freshness-not-fresh', 'Installed userscript is not an exact fresh match');
  }
  if (!report.clipboard?.writeCalled) {
    addFailure(failures, 'clipboard-write-not-called', 'navigator.clipboard.write was not called');
  } else if (!report.clipboard?.writeResolved) {
    addFailure(failures, 'clipboard-write-failed', report.clipboard?.error || 'Clipboard write did not resolve');
  }
  if (!report.clipboard?.validPng || report.clipboard?.mimeType !== 'image/png' || report.clipboard?.bytes <= 0) {
    addFailure(failures, 'clipboard-png-invalid', 'Clipboard did not contain a valid non-empty image/png item');
  }
  if (report.clipboard?.validPng && !matchesSize(report.clipboard, report.expectations?.clipboardSize)) {
    addFailure(failures, 'clipboard-size-mismatch', 'Clipboard PNG dimensions do not match the expected size');
  }
  if (!report.download?.eventObserved || !report.download?.validPng || report.download?.bytes <= 0) {
    addFailure(failures, 'download-png-invalid', 'Native download did not produce a valid non-empty PNG');
  }
  if (!report.download?.sawC8o8Fe) {
    addFailure(failures, 'download-c8o8fe-missing', 'Download phase did not observe c8o8Fe');
  }
  if (!report.download?.sawPhysicalRdGg) {
    addFailure(failures, 'download-rd-gg-missing', 'Download phase did not observe a physical rd-gg request');
  }
  if ((report.dialogs || []).length > 0) {
    addFailure(failures, 'failure-dialog', 'A browser dialog appeared during the probe');
  }
  if (report.download?.validPng && !matchesSize(report.download, report.expectations?.downloadSize)) {
    addFailure(failures, 'download-size-mismatch', 'Downloaded PNG dimensions do not match the expected size');
  }
  return { status: failures.length === 0 ? 'pass' : 'fail', failures };
}

function portablePath(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll('\\', '/');
}

async function writeProbeReport(reportPath, report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function recordCaughtFailure(report, error) {
  const code = error instanceof ProbeFailure ? error.code : `${report.stage}-failed`;
  report.failures = [{ code, message: String(error?.message || error) }];
  report.status = 'fail';
}

function listGeminiPages(browser, pageUrlPrefix) {
  return browser.contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => (
      candidate.url().startsWith(pageUrlPrefix)
      && !candidate.url().includes('RotateCookiesPage')
    ));
}

async function resolveUniqueVisibleAction(page, labels, actionName) {
  const visible = [];
  for (const label of labels) {
    const locator = page.getByRole('button', { name: label, exact: true });
    for (let index = 0; index < await locator.count(); index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible()) visible.push(candidate);
    }
  }
  if (visible.length !== 1) {
    throw new ProbeFailure(
      `${actionName}-action-ambiguous`,
      `Expected exactly one visible ${actionName} action, found ${visible.length}`
    );
  }
  return visible[0];
}

async function installClipboardObserver(page) {
  await page.evaluate(() => {
    const clipboard = window.navigator.clipboard;
    if (!clipboard || typeof clipboard.write !== 'function') {
      throw new Error('navigator.clipboard.write is unavailable');
    }

    const originalWrite = clipboard.write;
    const state = { originalWrite, writes: [] };
    window.__gwrCopyDownloadProbe = state;
    Object.defineProperty(clipboard, 'write', {
      configurable: true,
      writable: true,
      value: async (items) => {
        const record = {
          writeCalled: true,
          writeResolved: false,
          completed: false,
          mimeType: '',
          bytes: 0,
          width: 0,
          height: 0,
          header: [],
          error: ''
        };
        state.writes.push(record);

        try {
          for (const item of items || []) {
            const types = Array.from(item?.types || []);
            if (!types.includes('image/png') || typeof item.getType !== 'function') continue;

            const blob = await item.getType('image/png');
            const bitmap = await createImageBitmap(blob);
            record.mimeType = blob.type || 'image/png';
            record.bytes = blob.size;
            record.width = bitmap.width;
            record.height = bitmap.height;
            record.header = Array.from(new Uint8Array(await blob.slice(0, 24).arrayBuffer()));
            bitmap.close?.();
            break;
          }

          const result = await originalWrite.call(clipboard, items);
          record.writeResolved = true;
          return result;
        } catch (error) {
          record.error = String(error?.message || error);
          throw error;
        } finally {
          record.completed = true;
        }
      }
    });
  });
}

async function readClipboardRecord(page) {
  return page.evaluate(() => window.__gwrCopyDownloadProbe?.writes?.at(-1) || null);
}

async function restoreClipboardObserver(page) {
  await page.evaluate(() => {
    const state = window.__gwrCopyDownloadProbe;
    if (!state?.originalWrite || !window.navigator.clipboard) return;
    Object.defineProperty(window.navigator.clipboard, 'write', {
      configurable: true,
      writable: true,
      value: state.originalWrite
    });
    delete window.__gwrCopyDownloadProbe;
  });
}

function applyClipboardRecord(report, record) {
  report.clipboard = {
    writeCalled: record?.writeCalled === true,
    writeResolved: record?.writeResolved === true,
    mimeType: record?.mimeType || '',
    validPng: false,
    bytes: Number(record?.bytes || 0),
    width: Number(record?.width || 0),
    height: Number(record?.height || 0),
    error: record?.error || ''
  };
  try {
    const png = inspectPngBuffer(Buffer.from(record?.header || []));
    report.clipboard.validPng = (
      png.width === report.clipboard.width
      && png.height === report.clipboard.height
      && report.clipboard.bytes >= png.bytes
    );
  } catch {
    report.clipboard.validPng = false;
  }
}

export async function runRealPageCopyDownloadProbe(options = {}, dependencies = {}) {
  const resolvedOptions = {
    cdpUrl: options.cdpUrl || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    outputRoot: options.outputRoot || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT,
    pageUrlPrefix: options.pageUrlPrefix || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_PAGE_URL_PREFIX,
    expectedClipboardSize: options.expectedClipboardSize || null,
    expectedDownloadSize: options.expectedDownloadSize || null
  };
  const reportPath = path.join(resolvedOptions.outputRoot, REPORT_FILENAME);
  const downloadPath = path.join(resolvedOptions.outputRoot, DOWNLOAD_FILENAME);
  const now = dependencies.now || (() => new Date());
  const runFreshnessCheck = dependencies.runFreshnessCheck || runTampermonkeyFreshnessCheck;
  const connectOverCDP = dependencies.connectOverCDP || chromium.connectOverCDP.bind(chromium);
  const installClipboard = dependencies.installClipboardObserver || installClipboardObserver;
  const readClipboard = dependencies.readClipboardRecord || readClipboardRecord;
  const restoreClipboard = dependencies.restoreClipboardObserver || restoreClipboardObserver;
  const report = createInitialProbeReport(resolvedOptions, now().toISOString());
  let browser = null;
  let page = null;
  let requestListener = null;
  let dialogListener = null;
  let phase = 'copy';

  await mkdir(resolvedOptions.outputRoot, { recursive: true });

  try {
    await rm(downloadPath, { force: true });
    let freshnessResult;
    try {
      freshnessResult = await runFreshnessCheck({ cdpUrl: resolvedOptions.cdpUrl });
    } catch (error) {
      report.freshness = { status: 'unavailable', exactMatch: false, reportPath: null };
      throw new ProbeFailure('freshness-unavailable', String(error?.message || error));
    }

    const freshness = freshnessResult.report?.freshness || null;
    report.freshness = {
      status: freshness?.status || 'unavailable',
      exactMatch: freshness?.exactMatch === true,
      reportPath: freshnessResult.reportPath ? portablePath(freshnessResult.reportPath) : null
    };
    if (shouldFailTampermonkeyFreshnessCheck(freshness)) {
      throw new ProbeFailure('freshness-not-fresh', 'Installed userscript is not an exact fresh match');
    }

    report.stage = 'connect';
    browser = await connectOverCDP(resolvedOptions.cdpUrl);
    const pages = listGeminiPages(browser, resolvedOptions.pageUrlPrefix);
    if (pages.length !== 1) {
      throw new ProbeFailure('gemini-page-ambiguous', `Expected exactly one Gemini page, found ${pages.length}`);
    }
    page = pages[0];
    report.pageUrl = sanitizeGeminiPageUrl(page.url());

    report.stage = 'page-ready';
    await page.bringToFront();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_RELOAD_TIMEOUT_MS });
    await page.locator('[data-gwr-page-image-state=ready]').first().waitFor({
      state: 'attached',
      timeout: PAGE_READY_TIMEOUT_MS
    });
    await page.bringToFront();
    const copyButton = await resolveUniqueVisibleAction(page, COPY_ACTION_LABELS, 'copy');
    const downloadButton = await resolveUniqueVisibleAction(page, DOWNLOAD_ACTION_LABELS, 'download');

    requestListener = (request) => {
      const observation = classifyObservedRequest({
        url: request.url(),
        postData: request.postData() || '',
        phase,
        method: request.method()
      });
      if (observation) report.network.push(observation);
    };
    dialogListener = async (dialog) => {
      report.dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss().catch(() => {});
    };
    page.on('request', requestListener);
    page.on('dialog', dialogListener);

    report.stage = 'copy';
    await installClipboard(page);
    await copyButton.click();
    await page.waitForFunction(
      () => window.__gwrCopyDownloadProbe?.writes?.some((entry) => entry.completed),
      null,
      { timeout: CLIPBOARD_TIMEOUT_MS }
    );
    applyClipboardRecord(report, await readClipboard(page));

    report.stage = 'download';
    phase = 'download';
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
      downloadButton.click()
    ]);
    report.download.eventObserved = true;
    report.download.suggestedFilename = download.suggestedFilename();
    await download.saveAs(downloadPath);
    report.download.artifactPath = portablePath(downloadPath);
    const downloadedPng = inspectPngBuffer(await readFile(downloadPath));
    report.download = {
      ...report.download,
      validPng: true,
      ...downloadedPng,
      sawC8o8Fe: report.network.some((entry) => (
        entry.phase === 'download' && entry.kinds.includes('c8o8Fe')
      )),
      sawPhysicalRdGg: report.network.some((entry) => (
        entry.phase === 'download' && entry.kinds.includes('rd-gg')
      ))
    };

    report.stage = 'verify';
    const evaluation = evaluateCopyDownloadProbe(report);
    report.status = evaluation.status;
    report.failures = evaluation.failures;
    report.stage = report.status === 'pass' ? 'complete' : 'verify';
  } catch (error) {
    recordCaughtFailure(report, error);
  } finally {
    report.download.sawC8o8Fe = report.network.some((entry) => (
      entry.phase === 'download' && entry.kinds.includes('c8o8Fe')
    ));
    report.download.sawPhysicalRdGg = report.network.some((entry) => (
      entry.phase === 'download' && entry.kinds.includes('rd-gg')
    ));
    if (page) {
      if (requestListener) page.off('request', requestListener);
      if (dialogListener) page.off('dialog', dialogListener);
      try {
        await restoreClipboard(page);
      } catch (error) {
        report.failures.push({
          code: 'clipboard-restore-failed',
          message: String(error?.message || error)
        });
        report.status = 'fail';
        if (report.stage === 'complete') report.stage = 'verify';
      }
    }
    if (browser) await browser.close().catch(() => {});
  }

  await writeProbeReport(reportPath, report);
  return { reportPath, downloadPath, report };
}

export async function runRealPageCopyDownloadCli(argv = [], dependencies = {}) {
  const runProbe = dependencies.runProbe || runRealPageCopyDownloadProbe;
  let options;
  try {
    options = parseRealPageCopyDownloadCliArgs(argv);
  } catch (error) {
    const outputRoot = dependencies.fallbackOutputRoot || DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT;
    const reportPath = path.join(outputRoot, REPORT_FILENAME);
    const downloadPath = path.join(outputRoot, DOWNLOAD_FILENAME);
    const now = dependencies.now || (() => new Date());
    const report = createInitialProbeReport({}, now().toISOString());
    report.failures = [{ code: 'cli-invalid', message: String(error?.message || error) }];
    await mkdir(outputRoot, { recursive: true });
    await rm(downloadPath, { force: true });
    await writeProbeReport(reportPath, report);
    return { reportPath, downloadPath, report };
  }
  return runProbe(options);
}

async function runCli() {
  const result = await runRealPageCopyDownloadCli(process.argv.slice(2));
  console.log(`status: ${result.report.status}`);
  console.log(`stage: ${result.report.stage}`);
  console.log(`report: ${result.reportPath}`);
  if (result.report.download.artifactPath) {
    console.log(`download: ${result.report.download.artifactPath}`);
  }
  if (result.report.failures.length > 0) {
    console.error(result.report.failures.map((failure) => `${failure.code}: ${failure.message}`).join('\n'));
  }
  if (result.report.status !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
