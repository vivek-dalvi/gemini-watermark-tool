import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadVideoCropBenchmarkManifest } from './video-crop-benchmark.js';

const DEFAULT_BENCHMARK_MANIFEST = path.resolve('scripts/video-crop-benchmark-manifest.json');
const DEFAULT_EXPORT_REPORT = path.resolve('.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025/4d420881-pad16-strength025-report.json');
const DEFAULT_OUTPUT = path.resolve('.artifacts/allenk-fdncnn/video-frame-export-4d420881-pad16-strength025/benchmark-manifest.json');

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        benchmarkManifest: DEFAULT_BENCHMARK_MANIFEST,
        exportReport: DEFAULT_EXPORT_REPORT,
        output: DEFAULT_OUTPUT
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--benchmark-manifest') {
            args.benchmarkManifest = path.resolve(argv[++i]);
        } else if (arg === '--export-report') {
            args.exportReport = path.resolve(argv[++i]);
        } else if (arg === '--output') {
            args.output = path.resolve(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return args;
}

async function createAllenkFdncnnOnnxVideoEvidenceManifest({
    benchmarkManifest = DEFAULT_BENCHMARK_MANIFEST,
    exportReport = DEFAULT_EXPORT_REPORT,
    output = DEFAULT_OUTPUT
} = {}) {
    const sourceManifest = await loadVideoCropBenchmarkManifest(benchmarkManifest);
    const report = JSON.parse(await readFile(exportReport, 'utf8'));
    const caseItem = sourceManifest.cases.find((item) => item.id === report.caseId);
    if (!caseItem) throw new Error(`Unable to find benchmark case ${report.caseId}`);

    const manifest = {
        version: 1,
        timestamps: [1, 2],
        cases: [
            {
                id: `${report.caseId}-baseline`,
                label: `${report.caseId} baseline current vs allenk reference`,
                originalPath: caseItem.originalPath,
                currentPath: caseItem.currentPath,
                currentProfile: caseItem.currentProfile,
                referencePath: caseItem.referencePath,
                referenceProfile: caseItem.referenceProfile,
                expected: caseItem.expected,
                tags: ['baseline', 'has-allenk']
            },
            {
                id: `${report.caseId}-allenk-fdncnn-onnx-video`,
                label: `${report.caseId} ONNX video export vs allenk reference`,
                originalPath: caseItem.originalPath,
                currentPath: report.output,
                currentProfile: {
                    algorithm: 'gwr-video-mvp+allenk-fdncnn-onnx',
                    denoiseBackend: 'allenk-fdncnn-browser-spike',
                    runtime: report.profile.runtime,
                    roiSize: report.profile.onnx?.path?.includes('104') ? 104 : null,
                    padding: report.profile.padding,
                    sigma: report.profile.sigma,
                    edgeDenoiseStrength: report.profile.strength
                },
                referencePath: caseItem.referencePath,
                referenceProfile: caseItem.referenceProfile,
                expected: caseItem.expected,
                tags: ['variant', 'video-export', 'allenk-fdncnn-onnx', 'has-allenk']
            }
        ]
    };

    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, output };
}

function printHelp() {
    console.log(`Usage: node scripts/create-allenk-fdncnn-onnx-video-evidence.js [--export-report report.json] [--output manifest.json]`);
}

async function main() {
    const args = parseArgs();
    if (args.help) {
        printHelp();
        return;
    }
    const result = await createAllenkFdncnnOnnxVideoEvidenceManifest(args);
    console.log(`manifest: ${path.relative(process.cwd(), result.output)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

export {
    DEFAULT_BENCHMARK_MANIFEST,
    DEFAULT_EXPORT_REPORT,
    DEFAULT_OUTPUT,
    createAllenkFdncnnOnnxVideoEvidenceManifest,
    parseArgs
};
