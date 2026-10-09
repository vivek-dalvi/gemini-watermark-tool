import test from 'node:test';
import assert from 'node:assert/strict';

function installImageDecodeGlobals() {
  const originalImage = globalThis.Image;
  const originalURL = globalThis.URL;
  const originalCreateObjectURL = globalThis.URL?.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL;
  const revokedUrls = [];

  class MockImage {
    constructor() {
      this.width = 0;
      this.height = 0;
      this.onload = null;
      this.onerror = null;
    }

    set src(value) {
      this._src = value;
      this.width = 512;
      this.height = 512;
      queueMicrotask(() => this.onload?.());
    }
  }

  globalThis.Image = MockImage;
  globalThis.URL = originalURL;
  globalThis.URL.createObjectURL = () => 'blob:browser-runtime-test';
  globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);

  return {
    revokedUrls,
    restore() {
      globalThis.Image = originalImage;
      globalThis.URL = originalURL;
      if (globalThis.URL) {
        globalThis.URL.createObjectURL = originalCreateObjectURL;
        globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
      }
    }
  };
}

test('browser runtime module import should be side-effect free for page globals', async () => {
  const originalWindow = globalThis.window;
  const originalFlag = globalThis.__gwrPageProcessRuntimeInstalled__;

  globalThis.window = {
    __gwrPageProcessRuntimeInstalled__: 'keep-existing'
  };
  globalThis.__gwrPageProcessRuntimeInstalled__ = 'global-flag';

  try {
    const module = await import(`../../src/runtime/browser.js?side-effect-free=${Date.now()}`);
    assert.equal(typeof module.createBrowserRuntimeProcessor, 'function');
    assert.equal(globalThis.window.__gwrPageProcessRuntimeInstalled__, 'keep-existing');
    assert.equal(globalThis.__gwrPageProcessRuntimeInstalled__, 'global-flag');
  } finally {
    globalThis.window = originalWindow;
    globalThis.__gwrPageProcessRuntimeInstalled__ = originalFlag;
  }
});

test('createBrowserRuntimeProcessor should construct without touching page globals', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?construct=${Date.now()}`);
  const originalWindow = globalThis.window;

  globalThis.window = {
    touched: false
  };

  try {
    const runtime = createBrowserRuntimeProcessor();
    assert.equal(typeof runtime.processWatermarkBlob, 'function');
    assert.equal(typeof runtime.removeWatermarkFromBlob, 'function');
    assert.equal(globalThis.window.touched, false);
    assert.equal(globalThis.window.__gwrPageProcessRuntimeInstalled__, undefined);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('createBrowserRuntimeProcessor should default adaptiveMode to always', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?default-options=${Date.now()}`);
  const inputBlob = new Blob(['raw'], { type: 'image/png' });
  const calls = [];

  const runtime = createBrowserRuntimeProcessor({
    processBlob: async (blob, options) => {
      calls.push({ blob, options });
      return {
        processedBlob: new Blob(['processed'], { type: 'image/png' }),
        processedMeta: { source: 'stub', processorPath: 'main-thread' }
      };
    }
  });

  const result = await runtime.processWatermarkBlob(inputBlob);

  assert.equal(result.processedBlob.type, 'image/png');
  assert.deepEqual(calls, [
    {
      blob: inputBlob,
      options: { adaptiveMode: 'always' }
    }
  ]);
});

test('createBrowserRuntimeProcessor should allow adaptiveMode override', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?override-options=${Date.now()}`);
  const inputBlob = new Blob(['raw'], { type: 'image/png' });
  const calls = [];

  const runtime = createBrowserRuntimeProcessor({
    processBlob: async (blob, options) => {
      calls.push({ blob, options });
      return {
        processedBlob: new Blob(['processed'], { type: 'image/png' }),
        processedMeta: { source: 'stub', processorPath: 'main-thread' }
      };
    }
  });

  await runtime.processWatermarkBlob(inputBlob, { adaptiveMode: 'never', maxPasses: 1 });

  assert.deepEqual(calls, [
    {
      blob: inputBlob,
      options: { adaptiveMode: 'never' }
    }
  ]);
});

test('createBrowserRuntimeProcessor should allow detached removeWatermarkFromBlob calls', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?detached=${Date.now()}`);
  let receivedOptions = null;

  const runtime = createBrowserRuntimeProcessor({
    processBlob: async (_blob, options) => {
      receivedOptions = options;
      return {
        processedBlob: new Blob(['processed'], { type: 'image/png' }),
        processedMeta: { source: 'stub' }
      };
    }
  });

  const detachedRemoveWatermarkFromBlob = runtime.removeWatermarkFromBlob;
  const processedBlob = await detachedRemoveWatermarkFromBlob(
    new Blob(['raw'], { type: 'image/png' }),
    { adaptiveMode: 'never', maxPasses: 2 }
  );

  assert.equal(await processedBlob.text(), 'processed');
  assert.deepEqual(receivedOptions, {
    adaptiveMode: 'never'
  });
});

test('createBrowserRuntimeProcessor should preserve processorPath in processedMeta when provided', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?processor-path=${Date.now()}`);

  const runtime = createBrowserRuntimeProcessor({
    processBlob: async () => ({
      processedBlob: new Blob(['processed'], { type: 'image/png' }),
      processedMeta: {
        source: 'worker',
        processorPath: 'worker'
      }
    })
  });

  const result = await runtime.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));

  assert.deepEqual(result.processedMeta, {
    source: 'worker',
    processorPath: 'worker'
  });
});

test('createBrowserRuntimeProcessor should add main-thread processorPath when processedMeta omits it', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?processor-path-default=${Date.now()}`);

  const runtime = createBrowserRuntimeProcessor({
    processBlob: async () => ({
      processedBlob: new Blob(['processed'], { type: 'image/png' }),
      processedMeta: {
        source: 'engine'
      }
    })
  });

  const result = await runtime.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));

  assert.deepEqual(result.processedMeta, {
    source: 'engine',
    processorPath: 'main-thread'
  });
});

test('createBrowserRuntimeProcessor should honor createEngine and defaultOptions in shared path', async () => {
  const { createBrowserRuntimeProcessor } = await import(`../../src/runtime/browser.js?create-engine=${Date.now()}`);
  const globals = installImageDecodeGlobals();
  let createEngineCalls = 0;
  const removeCalls = [];

  try {
    const runtime = createBrowserRuntimeProcessor({
      createEngine: async () => {
        createEngineCalls += 1;
        return {
          async removeWatermarkFromImage(image, options) {
            removeCalls.push({ image, options });
            return {
              __watermarkMeta: { source: 'engine' },
              toBlob(callback) {
                callback(new Blob(['processed'], { type: 'image/png' }));
              }
            };
          }
        };
      },
      defaultOptions: {
        maxPasses: 3
      }
    });

    const result = await runtime.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));

    assert.equal(await result.processedBlob.text(), 'processed');
    assert.equal(createEngineCalls, 1);
    assert.deepEqual(removeCalls, [
      {
        image: removeCalls[0].image,
        options: {
          adaptiveMode: 'always'
        }
      }
    ]);
    assert.deepEqual(result.processedMeta, {
      source: 'engine',
      processorPath: 'main-thread'
    });
    assert.deepEqual(globals.revokedUrls, ['blob:browser-runtime-test']);
  } finally {
    globals.restore();
  }
});
