import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/manifest.json');
const DEFAULT_ONNX_MANIFEST = path.resolve('.artifacts/allenk-fdncnn/onnx-manifest.json');
const DEFAULT_RUNTIME_SMOKE = path.resolve('.artifacts/allenk-fdncnn/onnx-runtime-smoke.json');
const DEFAULT_OUTPUT = path.resolve('.artifacts/allenk-fdncnn/browser-spike-report.json');
const DEFAULT_MARKDOWN = path.resolve('.artifacts/allenk-fdncnn/browser-spike-report.md');
const DEFAULT_ROI_SIZES = Object.freeze([72, 96, 200]);

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        manifest: DEFAULT_MANIFEST,
        onnxManifest: DEFAULT_ONNX_MANIFEST,
        runtimeSmoke: DEFAULT_RUNTIME_SMOKE,
        output: DEFAULT_OUTPUT,
        markdown: DEFAULT_MARKDOWN,
        roiSizes: [...DEFAULT_ROI_SIZES]
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--manifest') {
            args.manifest = path.resolve(argv[++i]);
        } else if (arg === '--onnx-manifest') {
            args.onnxManifest = path.resolve(argv[++i]);
        } else if (arg === '--runtime-smoke') {
            args.runtimeSmoke = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.output = path.resolve(argv[++i]);
        } else if (arg === '--markdown') {
            args.markdown = path.resolve(argv[++i]);
        } else if (arg === '--roi-sizes') {
            args.roiSizes = String(argv[++i])
                .split(',')
                .map((value) => Number.parseInt(value.trim(), 10))
                .filter((value) => Number.isFinite(value) && value > 0);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

function calculateMacsForRoi(segments, roiSize) {
    return segments.reduce((sum, segment) => {
        return sum + roiSize * roiSize *
            segment.outputChannels *
            segment.inputChannels *
            segment.kernelW *
            segment.kernelH;
    }, 0);
}

function formatNumber(value) {
    return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function createAllenkFdncnnBrowserSpikeReport({ manifest, roiSizes = DEFAULT_ROI_SIZES } = {}) {
    const segments = manifest?.model?.weightLayout?.segments || [];
    const summary = manifest?.model?.summary || {};
    if (!segments.length) {
        throw new Error('allenk FDnCNN manifest is missing model.weightLayout.segments');
    }

    const roiEstimates = roiSizes.map((size) => {
        const macs = calculateMacsForRoi(segments, size);
        return {
            roiSize: size,
            pixels: size * size,
            macs,
            gigaMacs: macs / 1_000_000_000,
            pureJsRisk: macs >= 1_000_000_000 ? 'high' : 'medium'
        };
    });

    const hasOnnxSource = Boolean(manifest?.model?.onnx?.path || manifest?.model?.pytorch?.path);
    const hasRuntimeSmoke = Boolean(manifest?.model?.onnxRuntimeSmoke?.decision?.onnxRuntimeWebExecutable);
    const candidates = [
        {
            id: 'onnxruntime-web-webgpu',
            status: hasRuntimeSmoke ? 'runtime-smoke-passed' : (hasOnnxSource ? 'prototype-ready' : 'needs-conversion'),
            fit: 'recommended',
            reason: hasRuntimeSmoke
                ? 'ONNX Runtime Web can load and execute the exported fixed-shape model; the remaining gap is WebGPU/video ROI gate evidence.'
                : hasOnnxSource
                ? 'ONNX/WebGPU can run the fixed 20-layer convolution graph in-browser.'
                : 'Best browser fit, but current allenk repo snapshot only provides NCNN param/bin, so conversion remains the next spike.'
        },
        {
            id: 'web-ncnn',
            status: 'research',
            fit: 'possible',
            reason: 'Would reuse NCNN param/bin directly if a maintained browser/WASM/WebGPU NCNN runtime is selected.'
        },
        {
            id: 'pure-js-reference',
            status: 'implemented-debug-only',
            fit: 'not-production',
            reason: 'A browser-compatible reference runtime can execute tiny fixtures and injected ROI tests, but ROI MAC counts make real video inference too slow without GPU acceleration.'
        },
        {
            id: 'webnn',
            status: 'experimental',
            fit: 'later',
            reason: 'Potential browser-native path, but should remain behind WebGPU/ONNX until support is stable enough for userscript delivery.'
        }
    ];

    return {
        generatedAt: new Date().toISOString(),
        sourceManifest: manifest?.model?.param?.path ? manifest.source : null,
        model: {
            upstream: manifest.upstream,
            license: manifest.license,
            name: manifest.model.name,
            runtime: manifest.model.runtime,
            input: manifest.model.input,
            output: manifest.model.output,
            summary
        },
        assets: {
            param: manifest.model.param,
            bin: manifest.model.bin,
            onnx: manifest.model.onnx || null,
            onnxRuntimeSmoke: manifest.model.onnxRuntimeSmoke || null
        },
        roiEstimates,
        browserRuntimeCandidates: candidates,
        decision: {
            selectedNextSpike: 'onnxruntime-web-webgpu',
            fallback: 'web-ncnn',
            keepCanvasFallback: true,
            referenceRuntime: 'allenk-fdncnn-pure-js-reference',
            reason: 'The allenk algorithm contract, NCNN weight layout, and injectable video ROI runtime seam are decoded. The remaining production gap is a browser GPU inference runtime or model conversion path, not more Canvas tuning.'
        }
    };
}

function renderMarkdown(report) {
    const rows = report.roiEstimates
        .map((item) => `| ${item.roiSize}x${item.roiSize} | ${formatNumber(item.pixels)} | ${item.gigaMacs.toFixed(2)} | ${item.pureJsRisk} |`)
        .join('\n');
    const candidates = report.browserRuntimeCandidates
        .map((item) => `- \`${item.id}\`: ${item.status}, ${item.fit}. ${item.reason}`)
        .join('\n');

    return `# allenk FDnCNN Browser Spike Report

Generated: ${report.generatedAt}

## Model

- Upstream: ${report.model.upstream}
- License: ${report.model.license}
- Runtime: ${report.model.runtime}
- Layers: ${report.model.summary.convolutionLayerCount} convolution, ${report.model.summary.reluConvolutionLayerCount} ReLU convolution
- Channels: ${report.model.summary.inputChannels} -> ${report.model.summary.hiddenChannels} -> ${report.model.summary.outputChannels}
- Kernel: ${report.model.summary.kernel}
- Weight bin: ${formatNumber(report.assets.bin.bytes)} bytes
${report.assets.onnx ? `- ONNX: \`${report.assets.onnx.path}\`, ${formatNumber(report.assets.onnx.bytes)} bytes` : '- ONNX: not exported yet'}
${report.assets.onnxRuntimeSmoke ? `- ONNX Runtime smoke: ${report.assets.onnxRuntimeSmoke.executionProvider}, create ${report.assets.onnxRuntimeSmoke.session.createMs.toFixed(1)}ms, run ${report.assets.onnxRuntimeSmoke.inference.runMs.toFixed(1)}ms` : '- ONNX Runtime smoke: not run yet'}

## ROI Cost Estimate

| ROI | Pixels | MACs | Pure JS risk |
|---|---:|---:|---|
${rows}

## Browser Runtime Candidates

${candidates}

## Decision

- Selected next spike: \`${report.decision.selectedNextSpike}\`
- Fallback: \`${report.decision.fallback}\`
- Reference runtime: \`${report.decision.referenceRuntime}\`
- Keep Canvas fallback: ${report.decision.keepCanvasFallback}
- Reason: ${report.decision.reason}
`;
}

async function writeReportFiles(report, { output = DEFAULT_OUTPUT, markdown = DEFAULT_MARKDOWN } = {}) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    if (markdown) {
        await mkdir(path.dirname(markdown), { recursive: true });
        await writeFile(markdown, renderMarkdown(report));
    }
}

async function readOptionalJson(filePath) {
    if (!filePath) return null;
    try {
        await access(filePath);
    } catch {
        return null;
    }
    return JSON.parse(await readFile(filePath, 'utf8'));
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        console.log(`Usage: pnpm report:allenk-fdncnn-browser-spike [--manifest <path>] [--onnx-manifest <path>] [--runtime-smoke <path>] [--output <json>] [--markdown <md>] [--roi-sizes 72,96,200]`);
        return;
    }

    const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
    const onnxManifest = await readOptionalJson(args.onnxManifest);
    if (onnxManifest?.model?.onnx) {
        manifest.model.onnx = onnxManifest.model.onnx;
        manifest.model.onnxMetadata = onnxManifest.model.metadata;
    }
    const runtimeSmoke = await readOptionalJson(args.runtimeSmoke);
    if (runtimeSmoke?.decision?.onnxRuntimeWebExecutable) {
        manifest.model.onnxRuntimeSmoke = runtimeSmoke;
    }
    const report = createAllenkFdncnnBrowserSpikeReport({
        manifest,
        roiSizes: args.roiSizes
    });
    await writeReportFiles(report, args);
    console.log(`report: ${path.relative(process.cwd(), args.output)}`);
    console.log(`markdown: ${path.relative(process.cwd(), args.markdown)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_MANIFEST,
    DEFAULT_MARKDOWN,
    DEFAULT_OUTPUT,
    calculateMacsForRoi,
    createAllenkFdncnnBrowserSpikeReport,
    parseArgs,
    renderMarkdown,
    writeReportFiles
};
