import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

export function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

function resolveContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
    if (ext === '.wasm') return 'application/wasm';
    if (ext === '.onnx') return 'application/octet-stream';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.png') return 'image/png';
    if (ext === '.svg') return 'image/svg+xml';
    return 'application/octet-stream';
}

function isPathInsideRoot(targetPath, rootPath) {
    const relative = path.relative(rootPath, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function createLocalStaticPreviewServer(rootDir) {
    const rootPath = path.resolve(rootDir);
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            const requestPath = decodeURIComponent(url.pathname === '/' ? '/video-preview.html' : url.pathname);
            const targetPath = path.resolve(rootPath, `.${requestPath}`);
            if (!isPathInsideRoot(targetPath, rootPath)) {
                response.writeHead(403);
                response.end('Forbidden');
                return;
            }

            const fileInfo = await stat(targetPath);
            if (!fileInfo.isFile()) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }

            response.writeHead(200, {
                'content-type': resolveContentType(targetPath),
                'content-length': String(fileInfo.size),
                'cross-origin-opener-policy': 'same-origin',
                'cross-origin-embedder-policy': 'require-corp'
            });
            createReadStream(targetPath).pipe(response);
        } catch {
            response.writeHead(404);
            response.end('Not found');
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return {
        url: `http://127.0.0.1:${address.port}/`,
        close() {
            return new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        }
    };
}

export async function withLocalStaticPreviewPage(pagePath, callback) {
    if (isHttpUrl(pagePath)) {
        return await callback(pagePath, { served: false, server: null });
    }

    const resolvedPagePath = path.resolve(pagePath);
    const rootDir = path.dirname(resolvedPagePath);
    const pageName = path.basename(resolvedPagePath);
    const server = await createLocalStaticPreviewServer(rootDir);
    try {
        const pageUrl = new URL(pageName, server.url).href;
        return await callback(pageUrl, { served: true, server });
    } finally {
        await server.close();
    }
}
