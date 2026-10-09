import * as esbuild from 'esbuild';
import { cpSync, rmSync, existsSync, mkdirSync, watch, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const EXTENSION_DIR = 'dist/extension';

let _commitHash = null;
const getCommitHash = () => {
  if (_commitHash) return _commitHash;
  try {
    _commitHash = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    _commitHash = 'unknown';
  }
  return _commitHash;
};

const jsBanner = `/*!
 * ${pkg.name} v${pkg.version}+${getCommitHash()}
 * ${pkg.description}
 * (c) ${new Date().getFullYear()} ${pkg.author}
 * ${pkg.repository.url?.replace(/\.git$/, '')}
 * Released under the ${pkg.license} License.
 */`;

const userscriptBanner = `// ==UserScript==
// @name         Gemini NanoBanana Watermark Remover
// @name:zh-CN   Gemini NanoBanana 图片水印移除
// @namespace    https://github.com/GargantuaX
// @version      ${pkg.version}
// @description  Automatically removes watermarks from Gemini AI generated images
// @description:zh-CN 自动移除 Gemini AI 生成图像中的水印
// @icon         https://www.google.com/s2/favicons?domain=gemini.google.com
// @author       GargantuaX
// @license      MIT
// @downloadURL  https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js
// @updateURL    https://github.com/GargantuaX/gemini-watermark-remover/releases/latest/download/gemini-watermark-remover.user.js
// @match        https://gemini.google.com/app
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/*
// @match        https://business.gemini.google/app
// @match        https://business.gemini.google/app/*
// @match        https://business.gemini.google/*
// @connect      googleusercontent.com
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==
`;

function createExtensionManifest({ profile = 'official' } = {}) {
  const isOfficial = profile === 'official';
  const displayName = isOfficial ? 'Gemini Watermark Remover' : 'Gemini Watermark Remover Local';
  const manifest = {
    manifest_version: 3,
    name: displayName,
    short_name: isOfficial ? 'GWR' : 'GWR Local',
    version: pkg.version,
    description: isOfficial ? pkg.description : `${pkg.description} (local test build)`,
    author: pkg.author,
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png'
    },
    permissions: [
      'storage',
      'activeTab'
    ],
    action: {
      default_title: displayName,
      default_icon: {
        16: 'assets/icon-16.png',
        32: 'assets/icon-32.png',
        48: 'assets/icon-48.png',
        128: 'assets/icon-128.png'
      },
      default_popup: 'popup.html'
    },
    host_permissions: [
      'https://gemini.google.com/*',
      'https://business.gemini.google/*',
      'https://*.googleusercontent.com/*',
      'https://googleusercontent.com/*',
      'https://*.google.com/*'
    ],
    background: {
      service_worker: 'service-worker.js'
    },
    content_scripts: [
      {
        matches: [
          'https://gemini.google.com/app',
          'https://gemini.google.com/app/*',
          'https://gemini.google.com/*',
          'https://business.gemini.google/app',
          'https://business.gemini.google/app/*',
          'https://business.gemini.google/*'
        ],
        js: ['content-main.js'],
        run_at: 'document_start',
        world: 'MAIN'
      },
      {
        matches: [
          'https://gemini.google.com/app',
          'https://gemini.google.com/app/*',
          'https://gemini.google.com/*',
          'https://business.gemini.google/app',
          'https://business.gemini.google/app/*',
          'https://business.gemini.google/*'
        ],
        js: ['isolated-bridge.js'],
        run_at: 'document_start'
      }
    ]
  };

  if (!isOfficial) {
    manifest.version_name = `${pkg.version}+local.${getCommitHash()}`;
  }

  return manifest;
}

function writeExtensionManifest(outputDir = EXTENSION_DIR, options = { profile: 'local' }) {
  const manifest = createExtensionManifest(options);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyExtensionStaticAssets(outputDir = EXTENSION_DIR) {
  mkdirSync(join(outputDir, 'assets'), { recursive: true });
  cpSync('src/extension/assets', join(outputDir, 'assets'), { recursive: true });
  cpSync('src/extension/popup.html', join(outputDir, 'popup.html'));
  cpSync('src/extension/popup.css', join(outputDir, 'popup.css'));
  cpSync('src/extension/popup.js', join(outputDir, 'popup.js'));
}

function cleanDistBuildOutputs() {
  if (!existsSync('dist')) return;
  for (const entry of [
    'app.js',
    'dev-preview.html',
    'extension',
    'extension-local',
    'index.html',
    'tampermonkey-worker-probe.html',
    'tampermonkey-worker-probe.user.js',
    'video-app.js',
    'video-preview.html',
    'userscript',
    'workers'
  ]) {
    const target = join('dist', entry);
    if (existsSync(target)) rmSync(target, { recursive: true });
  }
}

const copyAssetsPlugin = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(() => {
      console.log('📂 Syncing static assets...');
      try {
        cpSync('public', 'dist', { recursive: true });
      } catch (err) {
        console.error('❌ Asset copy failed:', err);
      }
    });
  },
};

const commonConfig = {
  bundle: true,
  loader: { '.png': 'dataurl' },
  minify: isProd,
  logLevel: 'info',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const findAvailablePort = (startPort, maxAttempts = 20) => new Promise((resolvePort, reject) => {
  const tryPort = (port, remaining) => {
    const probe = createNetServer();
    probe.once('error', (err) => {
      probe.close();
      if (err.code === 'EADDRINUSE' && remaining > 0) {
        tryPort(port + 1, remaining - 1);
        return;
      }
      reject(err);
    });
    probe.once('listening', () => {
      probe.close(() => resolvePort(port));
    });
    probe.listen(port);
  };
  tryPort(startPort, maxAttempts);
});

async function serveStaticDevDist(rootDir = 'dist', defaultPort = 4173) {
  const distRoot = resolve(rootDir);
  const startPort = Number(process.env.PORT || defaultPort);
  const port = await findAvailablePort(startPort);

  const server = createServer((req, res) => {
    let urlPath = '/';
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }
    // In dev mode, expose the internal single-image debug harness at `/`
    // instead of the public landing entry. The landing page still ships to
    // `dist/index.html` for prod deploys and can be reached at `/index.html`.
    const devHarnessPath = '/dev-preview.html';
    const requestPath =
      urlPath === '/' || urlPath === ''
        ? devHarnessPath
        : urlPath;
    const fsPath = resolve(join(distRoot, normalize(requestPath)));

    if (!fsPath.startsWith(distRoot)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const requestedExt = extname(requestPath).toLowerCase();
    const isSpaRoute = requestedExt === '';
    let targetPath = fsPath;
    const targetExists = existsSync(targetPath);
    const targetIsDir = targetExists && statSync(targetPath).isDirectory();

    if ((!targetExists || targetIsDir) && isSpaRoute) {
      targetPath = resolve(join(distRoot, 'dev-preview.html'));
    }

    if (!existsSync(targetPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = extname(targetPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin'
    });
    createReadStream(targetPath).pipe(res);
  });

  server.listen(port, () => {
    console.log(`🌐 Dev server running at http://localhost:${port}`);
    console.log(`   ↳ internal debug harness: http://localhost:${port}/ (dev-preview.html)`);
    console.log(`   ↳ public landing entry:   http://localhost:${port}/index.html`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Build website - app.js
const websiteCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/app.js'],
  outfile: 'dist/app.js',
  platform: 'browser',
  target: ['es2020'],
  banner: { js: jsBanner },
  sourcemap: !isProd,
  plugins: [copyAssetsPlugin],
});

const videoWebsiteCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/video-app.js'],
  outfile: 'dist/video-app.js',
  platform: 'browser',
  target: ['es2022'],
  banner: { js: jsBanner },
  sourcemap: !isProd,
});

// Build website worker
const workerCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/workers/watermarkWorker.js'],
  outfile: 'dist/workers/watermark-worker.js',
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  sourcemap: !isProd,
});

// Build inline worker code for userscript (Blob Worker)
const userscriptWorkerBuild = await esbuild.build({
  ...commonConfig,
  entryPoints: ['src/workers/watermarkWorker.js'],
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  write: false,
  sourcemap: false,
});
const userscriptWorkerCode = userscriptWorkerBuild.outputFiles?.[0]?.text || '';

const userscriptPageProcessorBuild = await esbuild.build({
  ...commonConfig,
  entryPoints: ['src/page/pageProcessorBootstrap.js'],
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  write: false,
  sourcemap: false,
});
const userscriptPageProcessorCode = userscriptPageProcessorBuild.outputFiles?.[0]?.text || '';

// Build userscript
const userscriptCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/userscript/index.js'],
  format: 'iife',
  outfile: 'dist/userscript/gemini-watermark-remover.user.js',
  banner: { js: userscriptBanner },
  minify: false,
  define: {
    __US_WORKER_CODE__: JSON.stringify(userscriptWorkerCode),
    __US_PAGE_PROCESSOR_CODE__: JSON.stringify(userscriptPageProcessorCode),
    __US_INLINE_WORKER_ENABLED__: 'false',
    __GWR_AUTO_INIT_USERSCRIPT__: 'true'
  }
});

const extensionMainCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/extension/contentMain.js'],
  format: 'iife',
  outfile: 'dist/extension/content-main.js',
  platform: 'browser',
  target: ['es2020'],
  minify: isProd,
  define: {
    __US_WORKER_CODE__: JSON.stringify(userscriptWorkerCode),
    __US_PAGE_PROCESSOR_CODE__: JSON.stringify(userscriptPageProcessorCode),
    __US_INLINE_WORKER_ENABLED__: 'false',
    __GWR_AUTO_INIT_USERSCRIPT__: 'false'
  }
});

const extensionIsolatedCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/extension/isolatedBridge.js'],
  format: 'iife',
  outfile: 'dist/extension/isolated-bridge.js',
  platform: 'browser',
  target: ['es2020'],
  minify: isProd
});

const extensionServiceWorkerCtx = await esbuild.context({
  ...commonConfig,
  entryPoints: ['src/extension/serviceWorker.js'],
  format: 'iife',
  outfile: 'dist/extension/service-worker.js',
  platform: 'browser',
  target: ['es2020'],
  minify: isProd
});

console.log(`🚀 Starting build process... [${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}]`);

cleanDistBuildOutputs();
mkdirSync('dist/userscript', { recursive: true });
mkdirSync('dist/workers', { recursive: true });
mkdirSync(join(EXTENSION_DIR, 'assets'), { recursive: true });
writeExtensionManifest();
copyExtensionStaticAssets();

if (isProd) {
  await Promise.all([
    websiteCtx.rebuild(),
    videoWebsiteCtx.rebuild(),
    workerCtx.rebuild(),
    userscriptCtx.rebuild(),
    extensionMainCtx.rebuild(),
    extensionIsolatedCtx.rebuild(),
    extensionServiceWorkerCtx.rebuild()
  ]);
  writeExtensionManifest();
  copyExtensionStaticAssets();
  console.log('✅ Build complete!');
  process.exit(0);
} else {
  await Promise.all([
    websiteCtx.watch(),
    videoWebsiteCtx.watch(),
    workerCtx.watch(),
    userscriptCtx.watch(),
    extensionMainCtx.watch(),
    extensionIsolatedCtx.watch(),
    extensionServiceWorkerCtx.watch()
  ]);

  const watchDir = (dir, dest) => {
    let debounceTimer = null;

    watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (debounceTimer) clearTimeout(debounceTimer);

      debounceTimer = setTimeout(() => {
        console.log(`📂 Asset changed: ${filename}`);
        try {
          cpSync(dir, dest, { recursive: true });
        } catch (e) {
          console.error('Sync failed:', e);
        }
      }, 100);
    });
  };
  watchDir('public', 'dist');
  watch('src/extension', (eventType, filename) => {
    if (
      filename === 'popup.html' ||
      filename === 'popup.css' ||
      filename === 'popup.js' ||
      filename?.startsWith('assets')
    ) {
      copyExtensionStaticAssets();
      writeExtensionManifest();
    }
  });

  await serveStaticDevDist('dist');

  console.log('👀 Watching for changes...');
}
