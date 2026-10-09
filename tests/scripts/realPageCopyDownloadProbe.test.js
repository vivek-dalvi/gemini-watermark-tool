import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
  DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT,
  classifyObservedRequest,
  createInitialProbeReport,
  evaluateCopyDownloadProbe,
  inspectPngBuffer,
  parseExpectedImageSize,
  parseRealPageCopyDownloadCliArgs,
  runRealPageCopyDownloadCli,
  runRealPageCopyDownloadProbe,
  sanitizeGeminiPageUrl
} from '../../scripts/real-page-copy-download-probe.js';

function createPngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 4, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function createPassingReport({ expectedClipboardSize = null, expectedDownloadSize = null } = {}) {
  const report = createInitialProbeReport({
    cdpUrl: DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL,
    expectedClipboardSize,
    expectedDownloadSize
  }, '2026-07-18T00:00:00.000Z');
  report.freshness = { status: 'fresh', exactMatch: true, reportPath: 'freshness.json' };
  report.clipboard = {
    writeCalled: true,
    writeResolved: true,
    mimeType: 'image/png',
    validPng: true,
    bytes: 100,
    width: 2816,
    height: 1536,
    error: ''
  };
  report.download = {
    eventObserved: true,
    artifactPath: 'latest-download.png',
    suggestedFilename: 'image.png',
    validPng: true,
    bytes: 100,
    width: 2816,
    height: 1536,
    sawC8o8Fe: true,
    sawPhysicalRdGg: true
  };
  return report;
}

function createFakeBrowserFlow({ copyCount = 1, downloadCount = 1 } = {}) {
  const events = [];
  const listeners = new Map();
  const emitDownloadRequests = () => {
    const requestListener = listeners.get('request');
    requestListener?.({
      url: () => 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe',
      postData: () => 'f.req=c8o8Fe',
      method: () => 'POST'
    });
    requestListener?.({
      url: () => 'https://lh3.googleusercontent.com/rd-gg-dl/private-token/image.png?auth=secret',
      postData: () => null,
      method: () => 'GET'
    });
  };
  const createActionLocator = (name, count) => ({
    count: async () => count,
    nth: () => ({
      isVisible: async () => true,
      click: async () => {
        events.push(name);
        if (name === 'download') emitDownloadRequests();
      }
    })
  });
  const emptyLocator = createActionLocator('unused', 0);
  const page = {
    url: () => 'https://gemini.google.com/u/1/app/private-conversation?pageId=private',
    bringToFront: async () => { events.push('front'); },
    reload: async () => { events.push('reload'); },
    locator: () => ({
      first: () => ({ waitFor: async () => { events.push('ready'); } })
    }),
    getByRole: (_role, { name }) => {
      if (name === '复制图片') return createActionLocator('copy', copyCount);
      if (name === '下载完整尺寸的图片') return createActionLocator('download', downloadCount);
      return emptyLocator;
    },
    on: (eventName, listener) => { listeners.set(eventName, listener); },
    off: (eventName) => { listeners.delete(eventName); },
    waitForFunction: async () => {},
    waitForEvent: async (eventName) => {
      assert.equal(eventName, 'download');
      return {
        suggestedFilename: () => 'Gemini_Generated_Image.png',
        saveAs: async (downloadPath) => {
          await writeFile(downloadPath, createPngHeader(2816, 1536));
        }
      };
    }
  };
  const browser = {
    contexts: () => [{ pages: () => [page] }],
    close: async () => { events.push('close'); }
  };
  return { browser, events };
}

test('parseRealPageCopyDownloadCliArgs should use fixed-profile defaults', () => {
  const parsed = parseRealPageCopyDownloadCliArgs([]);

  assert.equal(parsed.cdpUrl, DEFAULT_REAL_PAGE_COPY_DOWNLOAD_CDP_URL);
  assert.equal(parsed.outputRoot, DEFAULT_REAL_PAGE_COPY_DOWNLOAD_OUTPUT_ROOT);
  assert.equal(parsed.pageUrlPrefix, 'https://gemini.google.com/');
  assert.equal(parsed.expectedClipboardSize, null);
  assert.equal(parsed.expectedDownloadSize, null);
});

test('parseRealPageCopyDownloadCliArgs should normalize overrides and exact sizes', () => {
  const parsed = parseRealPageCopyDownloadCliArgs([
    '--cdp', '9333',
    '--output-root', '.artifacts/custom-copy-download',
    '--page-prefix', 'https://gemini.google.com/u/1/app',
    '--expected-clipboard-size', '1408x768',
    '--expected-download-size', '2816X1536'
  ]);

  assert.equal(parsed.cdpUrl, 'http://127.0.0.1:9333');
  assert.match(parsed.outputRoot, /custom-copy-download$/);
  assert.equal(parsed.pageUrlPrefix, 'https://gemini.google.com/u/1/app');
  assert.deepEqual(parsed.expectedClipboardSize, { width: 1408, height: 768 });
  assert.deepEqual(parsed.expectedDownloadSize, { width: 2816, height: 1536 });
});

test('parseRealPageCopyDownloadCliArgs should ignore a forwarded pnpm separator', () => {
  const parsed = parseRealPageCopyDownloadCliArgs([
    '--',
    '--expected-clipboard-size', '1408x768',
    '--expected-download-size', '2816x1536'
  ]);

  assert.deepEqual(parsed.expectedClipboardSize, { width: 1408, height: 768 });
  assert.deepEqual(parsed.expectedDownloadSize, { width: 2816, height: 1536 });
});

test('parseExpectedImageSize should reject malformed or zero dimensions', () => {
  for (const value of ['1408', '0x768', '1408x0', '-1x768', '1408.5x768']) {
    assert.throws(
      () => parseExpectedImageSize(value, '--expected-clipboard-size'),
      /--expected-clipboard-size must use WIDTHxHEIGHT with positive integers/
    );
  }
});

test('parseRealPageCopyDownloadCliArgs should reject unknown flags', () => {
  assert.throws(
    () => parseRealPageCopyDownloadCliArgs(['--unexpected']),
    /Unknown argument: --unexpected/
  );
});

test('inspectPngBuffer should validate signature and read IHDR dimensions', () => {
  assert.deepEqual(inspectPngBuffer(createPngHeader(2816, 1536)), {
    bytes: 24,
    width: 2816,
    height: 1536
  });

  assert.throws(() => inspectPngBuffer(Buffer.from('not a png')), /Invalid PNG/);
  assert.throws(() => inspectPngBuffer(createPngHeader(0, 1536)), /Invalid PNG dimensions/);
});

test('classifyObservedRequest should identify a sanitized c8o8Fe request', () => {
  assert.deepEqual(
    classifyObservedRequest({
      url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=c8o8Fe&token=secret',
      postData: 'f.req=contains-c8o8Fe-and-private-data',
      phase: 'download',
      method: 'POST'
    }),
    {
      phase: 'download',
      kinds: ['c8o8Fe'],
      method: 'POST',
      hostname: 'gemini.google.com',
      pathname: '/_/BardChatUi/data/batchexecute'
    }
  );
});

test('classifyObservedRequest should identify only physical Google rd-gg assets', () => {
  assert.deepEqual(
    classifyObservedRequest({
      url: 'https://lh3.googleusercontent.com/rd-gg-dl/private-generated-token/image.png?auth=secret',
      phase: 'download',
      method: 'GET'
    }),
    {
      phase: 'download',
      kinds: ['rd-gg'],
      method: 'GET',
      hostname: 'lh3.googleusercontent.com',
      pathname: '/rd-gg-dl/<redacted>'
    }
  );
  assert.equal(classifyObservedRequest({ url: 'https://example.com/rd-gg/fake-token/image.png' }), null);
  assert.equal(classifyObservedRequest({ url: 'https://example.com/app.js' }), null);
});

test('sanitizeGeminiPageUrl should remove account and conversation identifiers', () => {
  assert.equal(
    sanitizeGeminiPageUrl('https://gemini.google.com/u/1/app/private-conversation?pageId=private'),
    'https://gemini.google.com/u/<account>/app/<conversation>'
  );
  assert.equal(
    sanitizeGeminiPageUrl('https://gemini.google.com/app'),
    'https://gemini.google.com/app'
  );
});

test('evaluateCopyDownloadProbe should pass generic evidence without comparing dimensions', () => {
  assert.deepEqual(evaluateCopyDownloadProbe(createPassingReport()), { status: 'pass', failures: [] });
});

test('evaluateCopyDownloadProbe should report missing clipboard write', () => {
  const report = createPassingReport();
  report.clipboard.writeCalled = false;

  assert.ok(
    evaluateCopyDownloadProbe(report).failures.some((failure) => failure.code === 'clipboard-write-not-called')
  );
});

test('evaluateCopyDownloadProbe should report rejected clipboard write', () => {
  const report = createPassingReport();
  report.clipboard.writeResolved = false;

  assert.ok(
    evaluateCopyDownloadProbe(report).failures.some((failure) => failure.code === 'clipboard-write-failed')
  );
});

test('evaluateCopyDownloadProbe should report invalid clipboard PNG', () => {
  const report = createPassingReport();
  report.clipboard.validPng = false;

  assert.ok(
    evaluateCopyDownloadProbe(report).failures.some((failure) => failure.code === 'clipboard-png-invalid')
  );
});

test('evaluateCopyDownloadProbe should report invalid download PNG', () => {
  const report = createPassingReport();
  report.download.eventObserved = false;

  assert.ok(
    evaluateCopyDownloadProbe(report).failures.some((failure) => failure.code === 'download-png-invalid')
  );
});

test('evaluateCopyDownloadProbe should report native-chain, dialog, and exact-size failures', () => {
  const report = createPassingReport({
    expectedClipboardSize: { width: 1408, height: 768 },
    expectedDownloadSize: { width: 2816, height: 1536 }
  });
  Object.assign(report.clipboard, { width: 1024, height: 1024 });
  Object.assign(report.download, {
    artifactPath: null,
    validPng: true,
    bytes: 0,
    width: 0,
    height: 0,
    sawC8o8Fe: false,
    sawPhysicalRdGg: false
  });
  report.dialogs.push({ type: 'alert', message: 'failed' });

  assert.deepEqual(
    evaluateCopyDownloadProbe(report).failures.map((failure) => failure.code),
    [
      'clipboard-size-mismatch',
      'download-png-invalid',
      'download-c8o8fe-missing',
      'download-rd-gg-missing',
      'failure-dialog',
      'download-size-mismatch'
    ]
  );
});

test('runRealPageCopyDownloadProbe should fail stale freshness without connecting to Gemini', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-copy-download-stale-'));
  const oldDownloadPath = path.join(outputRoot, 'latest-download.png');
  await writeFile(oldDownloadPath, 'old artifact');
  let connected = false;

  try {
    const result = await runRealPageCopyDownloadProbe(
      { outputRoot },
      {
        now: () => new Date('2026-07-18T00:00:00.000Z'),
        runFreshnessCheck: async () => ({
          reportPath: path.join(outputRoot, 'freshness.json'),
          report: { freshness: { status: 'stale', exactMatch: false } }
        }),
        connectOverCDP: async () => {
          connected = true;
        }
      }
    );

    assert.equal(connected, false);
    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.stage, 'freshness');
    assert.deepEqual(result.report.failures.map((failure) => failure.code), ['freshness-not-fresh']);
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).status, 'fail');
    await assert.rejects(() => readFile(oldDownloadPath), { code: 'ENOENT' });
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('runRealPageCopyDownloadProbe should report unavailable freshness without connecting to Gemini', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-copy-download-unavailable-'));
  let connected = false;

  try {
    const result = await runRealPageCopyDownloadProbe(
      { outputRoot },
      {
        runFreshnessCheck: async () => {
          throw new Error('Tampermonkey editor unavailable');
        },
        connectOverCDP: async () => {
          connected = true;
        }
      }
    );

    assert.equal(connected, false);
    assert.equal(result.report.freshness.status, 'unavailable');
    assert.deepEqual(result.report.failures.map((failure) => failure.code), ['freshness-unavailable']);
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).status, 'fail');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('runRealPageCopyDownloadProbe should complete copy then native download in one browser session', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-copy-download-pass-'));
  const flow = createFakeBrowserFlow();

  try {
    const result = await runRealPageCopyDownloadProbe(
      {
        outputRoot,
        expectedClipboardSize: { width: 1408, height: 768 },
        expectedDownloadSize: { width: 2816, height: 1536 }
      },
      {
        runFreshnessCheck: async () => ({
          reportPath: path.join(outputRoot, 'freshness.json'),
          report: { freshness: { status: 'fresh', exactMatch: true } }
        }),
        connectOverCDP: async () => flow.browser,
        installClipboardObserver: async () => { flow.events.push('install'); },
        readClipboardRecord: async () => ({
          writeCalled: true,
          writeResolved: true,
          completed: true,
          mimeType: 'image/png',
          bytes: 2_787_523,
          width: 1408,
          height: 768,
          header: Array.from(createPngHeader(1408, 768)),
          error: ''
        }),
        restoreClipboardObserver: async () => { flow.events.push('restore'); }
      }
    );

    assert.equal(result.report.status, 'pass');
    assert.equal(result.report.stage, 'complete');
    assert.equal(result.report.pageUrl, 'https://gemini.google.com/u/<account>/app/<conversation>');
    assert.deepEqual(result.report.dialogs, []);
    assert.deepEqual(result.report.failures, []);
    assert.deepEqual(
      {
        writeResolved: result.report.clipboard.writeResolved,
        validPng: result.report.clipboard.validPng,
        width: result.report.clipboard.width,
        height: result.report.clipboard.height
      },
      { writeResolved: true, validPng: true, width: 1408, height: 768 }
    );
    assert.deepEqual(
      {
        eventObserved: result.report.download.eventObserved,
        validPng: result.report.download.validPng,
        width: result.report.download.width,
        height: result.report.download.height,
        sawC8o8Fe: result.report.download.sawC8o8Fe,
        sawPhysicalRdGg: result.report.download.sawPhysicalRdGg
      },
      {
        eventObserved: true,
        validPng: true,
        width: 2816,
        height: 1536,
        sawC8o8Fe: true,
        sawPhysicalRdGg: true
      }
    );
    assert.deepEqual(flow.events, [
      'front', 'reload', 'ready', 'front', 'install', 'copy', 'download', 'restore', 'close'
    ]);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('runRealPageCopyDownloadProbe should fail instead of guessing among multiple copy actions', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-copy-download-ambiguous-'));
  const flow = createFakeBrowserFlow({ copyCount: 2 });

  try {
    const result = await runRealPageCopyDownloadProbe(
      { outputRoot },
      {
        runFreshnessCheck: async () => ({
          reportPath: path.join(outputRoot, 'freshness.json'),
          report: { freshness: { status: 'fresh', exactMatch: true } }
        }),
        connectOverCDP: async () => flow.browser,
        restoreClipboardObserver: async () => { flow.events.push('restore'); }
      }
    );

    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.stage, 'page-ready');
    assert.deepEqual(result.report.failures.map((failure) => failure.code), ['copy-action-ambiguous']);
    assert.equal(flow.events.includes('copy'), false);
    assert.equal(flow.events.at(-1), 'close');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('runRealPageCopyDownloadCli should forward parsed options to the probe runner', async () => {
  let observedOptions = null;
  const passingReport = createPassingReport();
  passingReport.status = 'pass';
  passingReport.stage = 'complete';

  const result = await runRealPageCopyDownloadCli(
    ['--cdp', '9333', '--expected-download-size', '2816x1536'],
    {
      runProbe: async (options) => {
        observedOptions = options;
        return { reportPath: 'report.json', downloadPath: 'download.png', report: passingReport };
      }
    }
  );

  assert.equal(result.report.status, 'pass');
  assert.equal(observedOptions.cdpUrl, 'http://127.0.0.1:9333');
  assert.deepEqual(observedOptions.expectedDownloadSize, { width: 2816, height: 1536 });
});

test('runRealPageCopyDownloadCli should write a structured report for invalid arguments', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'gwr-copy-download-cli-'));

  try {
    const result = await runRealPageCopyDownloadCli(
      ['--unexpected'],
      { fallbackOutputRoot: outputRoot }
    );

    assert.equal(result.report.status, 'fail');
    assert.equal(result.report.stage, 'freshness');
    assert.deepEqual(result.report.failures.map((failure) => failure.code), ['cli-invalid']);
    assert.equal(JSON.parse(await readFile(result.reportPath, 'utf8')).failures[0].code, 'cli-invalid');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('runRealPageCopyDownloadCli should not mislabel probe execution errors as invalid arguments', async () => {
  await assert.rejects(
    () => runRealPageCopyDownloadCli([], {
      runProbe: async () => {
        throw new Error('probe report path is unwritable');
      }
    }),
    /probe report path is unwritable/
  );
});
