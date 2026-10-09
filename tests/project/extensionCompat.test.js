import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readText(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

test('extension main world compat should expose the userscript globals used by the shared userscript entry', async () => {
  const compatSource = await readText('src/extension/tampermonkeyCompat.js');
  const contentMainSource = await readText('src/extension/contentMain.js');

  assert.match(compatSource, /unsafeWindow/);
  assert.match(compatSource, /GM_xmlhttpRequest/);
  assert.match(compatSource, /GWR_EXTENSION_GM_XHR_REQUEST/);
  assert.match(compatSource, /GWR_EXTENSION_GM_XHR_RESPONSE/);
  assert.match(contentMainSource, /GWR_EXTENSION_STATE_REQUEST/);
  assert.match(contentMainSource, /installTampermonkeyCompat/);
  assert.match(contentMainSource, /tampermonkeyCompat/);
  assert.match(contentMainSource, /userscript\/index\.js/);
});

test('extension isolated bridge should forward GM_xmlhttpRequest messages and enabled state', async () => {
  const isolatedSource = await readText('src/extension/isolatedBridge.js');
  const serviceWorkerSource = await readText('src/extension/serviceWorker.js');

  assert.match(isolatedSource, /chrome\.runtime\.sendMessage/);
  assert.match(isolatedSource, /chrome\.storage\.local\.get/);
  assert.match(isolatedSource, /GWR_EXTENSION_GM_XHR_REQUEST/);
  assert.match(isolatedSource, /GWR_EXTENSION_STATE_REQUEST/);
  assert.match(isolatedSource, /GWR_EXTENSION_STATE_RESPONSE/);
  assert.match(serviceWorkerSource, /fetch\(/);
  assert.match(serviceWorkerSource, /credentials:\s*'omit'/);
  assert.match(serviceWorkerSource, /arrayBuffer\(\)/);
});
