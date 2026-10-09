import test from 'node:test';
import assert from 'node:assert/strict';

import { WatermarkEngine } from '../../src/core/watermarkEngine.js';

function createLoggerSink() {
  const logs = [];
  return {
    logs,
    logger: {
      log(...args) {
        logs.push(['log', ...args]);
      },
      warn(...args) {
        logs.push(['warn', ...args]);
      },
      info(...args) {
        logs.push(['info', ...args]);
      }
    }
  };
}

function installWorkerGlobals(workerImplementation) {
  const originalWorker = globalThis.Worker;
  const originalBlob = globalThis.Blob;
  const originalURL = globalThis.URL;
  const originalCreateObjectURL = globalThis.URL?.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL;
  const revokedUrls = [];

  globalThis.Worker = workerImplementation;
  globalThis.Blob = originalBlob;
  globalThis.URL = originalURL;
  globalThis.URL.createObjectURL = () => 'blob:userscript-runtime-test';
  globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);

  return {
    revokedUrls,
    restore() {
      globalThis.Worker = originalWorker;
      globalThis.Blob = originalBlob;
      globalThis.URL = originalURL;
      if (globalThis.URL) {
        globalThis.URL.createObjectURL = originalCreateObjectURL;
        globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
      }
    }
  };
}

function installMainThreadProcessingStubs({
  processedText = 'main-thread-processed',
  processedType = 'image/png',
  meta = { source: 'main-thread' }
} = {}) {
  const originalEngineCreate = WatermarkEngine.create;
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
      this.width = 768;
      this.height = 768;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  }

  WatermarkEngine.create = async () => ({
    async removeWatermarkFromImage() {
      return {
        __watermarkMeta: meta,
        toBlob(callback) {
          callback(new Blob([processedText], { type: processedType }));
        }
      };
    }
  });

  globalThis.Image = MockImage;
  globalThis.URL = originalURL;
  globalThis.URL.createObjectURL = () => 'blob:userscript-runtime-main-thread';
  globalThis.URL.revokeObjectURL = (url) => revokedUrls.push(url);

  return {
    revokedUrls,
    restore() {
      WatermarkEngine.create = originalEngineCreate;
      globalThis.Image = originalImage;
      globalThis.URL = originalURL;
      if (globalThis.URL) {
        globalThis.URL.createObjectURL = originalCreateObjectURL;
        globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
      }
    }
  };
}

test('public userscript wrappers should expose a narrow runtime processor surface', async () => {
  const runtimeModule = await import('../../src/runtime/userscript.js');
  const sdkModule = await import('../../src/sdk/runtime-userscript.js');

  assert.equal(typeof runtimeModule.createUserscriptRuntimeProcessor, 'function');
  assert.equal(typeof sdkModule.createUserscriptRuntimeProcessor, 'function');

  const runtime = runtimeModule.createUserscriptRuntimeProcessor();

  assert.deepEqual(
    Object.keys(runtime).sort(),
    ['dispose', 'initialize', 'processWatermarkBlob', 'removeWatermarkFromBlob']
  );
  assert.equal(typeof runtime.initialize, 'function');
  assert.equal(typeof runtime.processWatermarkBlob, 'function');
  assert.equal(typeof runtime.removeWatermarkFromBlob, 'function');
  assert.equal(typeof runtime.dispose, 'function');
});

test('createUserscriptRuntimeProcessor should initialize on worker path when available', async () => {
  const workerEvents = [];

  class WorkerStub {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.terminated = false;
      workerEvents.push(['construct', url]);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    terminate() {
      this.terminated = true;
      workerEvents.push(['terminate']);
    }

    postMessage(message) {
      workerEvents.push(['postMessage', message.type]);
      queueMicrotask(() => {
        const handler = this.listeners.get('message');
        if (!handler) return;
        if (message.type === 'ping') {
          handler({ data: { id: message.id, ok: true, result: null } });
          return;
        }
        if (message.type === 'process-image') {
          handler({
            data: {
              id: message.id,
              ok: true,
              result: {
                processedBuffer: new TextEncoder().encode('worker-processed').buffer,
                mimeType: 'image/png',
                meta: { source: 'worker' }
              }
            }
          });
        }
      });
    }
  }

  const globals = installWorkerGlobals(WorkerStub);
  const { logs, logger } = createLoggerSink();

  try {
    const { createUserscriptRuntimeProcessor } = await import('../../src/runtime/userscript.js');
    const runtime = createUserscriptRuntimeProcessor({
      workerCode: 'self.onmessage = () => {}',
      env: {
        __GWR_FORCE_INLINE_WORKER__: true,
        Worker: WorkerStub,
        Blob: globalThis.Blob
      },
      logger
    });

    assert.equal(await runtime.initialize(), true);

    const result = await runtime.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));
    assert.equal(await result.processedBlob.text(), 'worker-processed');
    assert.deepEqual(result.processedMeta, { source: 'worker' });
    assert.ok(logs.some((entry) => entry[0] === 'log' && entry[1] === '[Gemini Watermark Remover] Worker acceleration enabled'));

    runtime.dispose('test-done');
    assert.deepEqual(workerEvents, [
      ['construct', 'blob:userscript-runtime-test'],
      ['postMessage', 'ping'],
      ['postMessage', 'process-image'],
      ['terminate']
    ]);
    assert.deepEqual(globals.revokedUrls, ['blob:userscript-runtime-test']);
  } finally {
    globals.restore();
  }
});

test('createUserscriptRuntimeProcessor should fall back after worker initialization failure and stay usable', async () => {
  class WorkerStub {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    removeEventListener(type) {
      this.listeners.delete(type);
    }

    terminate() {}

    postMessage(message) {
      queueMicrotask(() => {
        if (message.type !== 'ping') return;
        const handler = this.listeners.get('error');
        handler?.({ message: 'worker handshake failed' });
      });
    }
  }

  const workerGlobals = installWorkerGlobals(WorkerStub);
  const mainThread = installMainThreadProcessingStubs();
  const { logs, logger } = createLoggerSink();

  try {
    const { createUserscriptRuntimeProcessor } = await import('../../src/runtime/userscript.js');
    const runtime = createUserscriptRuntimeProcessor({
      workerCode: 'self.onmessage = () => {}',
      env: {
        __GWR_FORCE_INLINE_WORKER__: true,
        Worker: WorkerStub,
        Blob: globalThis.Blob
      },
      logger
    });

    assert.equal(await runtime.initialize(), false);

    const result = await runtime.processWatermarkBlob(new Blob(['raw'], { type: 'image/png' }));
    assert.equal(await result.processedBlob.text(), 'main-thread-processed');
    assert.deepEqual(result.processedMeta, { source: 'main-thread' });
    assert.ok(
      logs.some(
        (entry) => entry[0] === 'warn'
          && entry[1] === '[Gemini Watermark Remover] Worker initialization failed, using main thread:'
      )
    );
    assert.deepEqual(mainThread.revokedUrls, [
      'blob:userscript-runtime-main-thread',
      'blob:userscript-runtime-main-thread'
    ]);
  } finally {
    mainThread.restore();
    workerGlobals.restore();
  }
});

test('createUserscriptRuntimeProcessor should allow detached removeWatermarkFromBlob calls', async () => {
  const { createUserscriptRuntimeProcessor } = await import('../../src/runtime/userscript.js');
  const runtime = createUserscriptRuntimeProcessor();

  let receivedOptions = null;
  runtime.processWatermarkBlob = async (_blob, options = {}) => {
    receivedOptions = options;
    return {
      processedBlob: new Blob(['processed'], { type: 'image/png' }),
      processedMeta: { source: 'stub' }
    };
  };

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
