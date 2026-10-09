import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createLocalStaticPreviewServer,
  withLocalStaticPreviewPage
} from '../../scripts/local-static-preview-server.js';

test('createLocalStaticPreviewServer should serve local preview assets over loopback HTTP', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-static-preview-'));
  try {
    await writeFile(path.join(tempDir, 'video-preview.html'), '<h1>preview</h1>');
    await writeFile(path.join(tempDir, 'model.onnx'), 'model-bytes');
    const server = await createLocalStaticPreviewServer(tempDir);
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

      const pageResponse = await fetch(new URL('video-preview.html', server.url));
      assert.equal(pageResponse.status, 200);
      assert.equal(await pageResponse.text(), '<h1>preview</h1>');

      const modelResponse = await fetch(new URL('model.onnx', server.url));
      assert.equal(modelResponse.headers.get('content-type'), 'application/octet-stream');
      assert.equal(await modelResponse.text(), 'model-bytes');
    } finally {
      await server.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('withLocalStaticPreviewPage should convert file pages to temporary HTTP URLs and close the server', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gwr-static-preview-page-'));
  try {
    const pagePath = path.join(tempDir, 'video-preview.html');
    await writeFile(pagePath, '<h1>page</h1>');

    let callbackUrl = null;
    await withLocalStaticPreviewPage(pagePath, async (pageUrl) => {
      callbackUrl = pageUrl;
      const response = await fetch(pageUrl);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '<h1>page</h1>');
      return 'ok';
    });

    assert.match(callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/video-preview\.html$/);
    await assert.rejects(fetch(callbackUrl), /fetch failed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
