import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { applyVideoResidualCleanup, VIDEO_DENOISE_BACKENDS } from '../src/video/videoCleanupBackends.js';
import { summarizeWatermarkResidual } from './analyze-video-residual.js';
import { calculateBucketDeltas, renderVideoFrameBackendLabMarkdown } from './run-video-frame-backend-lab.js';

const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/allenk-fdncnn/runtime-seam');
const DEFAULT_SIZE = 48;
const DEFAULT_ROI_SIZE = 16;

function createImageData(width, height, fill = [0, 0, 0, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = fill[0];
        data[i + 1] = fill[1];
        data[i + 2] = fill[2];
        data[i + 3] = fill[3];
    }
    return { width, height, data };
}

function cloneImageData(imageData) {
    return {
        width: imageData.width,
        height: imageData.height,
        data: new Uint8ClampedArray(imageData.data)
    };
}

function createContext(imageData) {
    return {
        canvas: {
            width: imageData.width,
            height: imageData.height
        },
        getImageData(x, y, width, height) {
            const output = createImageData(width, height);
            for (let row = 0; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    const sourceIdx = ((y + row) * imageData.width + x + col) * 4;
                    const targetIdx = (row * width + col) * 4;
                    output.data[targetIdx] = imageData.data[sourceIdx];
                    output.data[targetIdx + 1] = imageData.data[sourceIdx + 1];
                    output.data[targetIdx + 2] = imageData.data[sourceIdx + 2];
                    output.data[targetIdx + 3] = imageData.data[sourceIdx + 3];
                }
            }
            return output;
        },
        putImageData(patch, x, y) {
            for (let row = 0; row < patch.height; row++) {
                for (let col = 0; col < patch.width; col++) {
                    const sourceIdx = (row * patch.width + col) * 4;
                    const targetIdx = ((y + row) * imageData.width + x + col) * 4;
                    imageData.data[targetIdx] = patch.data[sourceIdx];
                    imageData.data[targetIdx + 1] = patch.data[sourceIdx + 1];
                    imageData.data[targetIdx + 2] = patch.data[sourceIdx + 2];
                    imageData.data[targetIdx + 3] = patch.data[sourceIdx + 3];
                }
            }
        }
    };
}

function createSyntheticAlphaMap(size) {
    const alphaMap = new Float32Array(size * size);
    const center = (size - 1) / 2;
    const radius = size * 0.42;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const distance = Math.sqrt((x - center) ** 2 + (y - center) ** 2);
            alphaMap[y * size + x] = Math.max(0, 0.75 * (1 - distance / radius));
        }
    }
    return alphaMap;
}

function drawSyntheticWatermark(current, reference, position, alphaMap) {
    for (let y = 0; y < position.height; y++) {
        for (let x = 0; x < position.width; x++) {
            const alpha = alphaMap[y * position.width + x];
            if (alpha <= 0) continue;
            const idx = ((position.y + y) * current.width + position.x + x) * 4;
            for (let c = 0; c < 3; c++) {
                current.data[idx + c] = Math.round(
                    reference.data[idx + c] * (1 - alpha * 0.72) + 245 * alpha * 0.72
                );
            }
        }
    }
}

function createReferenceRepairRuntime(reference, outputSize) {
    return {
        id: 'allenk-fdncnn-runtime-seam-fixture',
        denoiseImageData({ imageData }) {
            const data = new Uint8ClampedArray(imageData.data);
            for (let y = 0; y < imageData.height; y++) {
                for (let x = 0; x < imageData.width; x++) {
                    const idx = (y * imageData.width + x) * 4;
                    data[idx] = reference.data[idx];
                    data[idx + 1] = reference.data[idx + 1];
                    data[idx + 2] = reference.data[idx + 2];
                }
            }
            return {
                runtime: 'allenk-fdncnn-runtime-seam-fixture',
                macs: imageData.width * imageData.height * 12,
                imageData: {
                    width: imageData.width,
                    height: imageData.height,
                    data
                }
            };
        }
    };
}

function createSyntheticCase({ size = DEFAULT_SIZE, roiSize = DEFAULT_ROI_SIZE } = {}) {
    const reference = createImageData(size, size, [72, 88, 102, 255]);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            reference.data[idx] = 60 + x;
            reference.data[idx + 1] = 82 + Math.round(y * 0.5);
            reference.data[idx + 2] = 98 + Math.round((x + y) * 0.25);
        }
    }
    const current = cloneImageData(reference);
    const position = {
        x: Math.round((size - roiSize) / 2),
        y: Math.round((size - roiSize) / 2),
        width: roiSize,
        height: roiSize
    };
    const alphaMap = createSyntheticAlphaMap(roiSize);
    drawSyntheticWatermark(current, reference, position, alphaMap);
    const variant = cloneImageData(current);
    const runtime = createReferenceRepairRuntime(reference, size);
    const cleanup = applyVideoResidualCleanup(createContext(variant), position, alphaMap, {
        residualCleanupStrength: 0,
        denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
        edgeDenoiseStrength: 1,
        allenkFdncnnRuntime: runtime,
        allenkFdncnnSigma: 25
    });

    return {
        reference,
        current,
        variant,
        position,
        alphaMap,
        cleanup
    };
}

async function encodePng(imageData, outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(imageData.data, {
        raw: {
            width: imageData.width,
            height: imageData.height,
            channels: 4
        }
    }).png().toFile(outputPath);
}

async function createComparisonSheet({ referencePath, currentPath, variantPath, outputPath }) {
    const metadata = await sharp(referencePath).metadata();
    const tileWidth = metadata.width;
    const tileHeight = metadata.height;
    const labelHeight = 24;
    const gap = 8;
    const padding = 12;
    const labels = ['baseline', 'allenk runtime seam', 'reference'];
    const paths = [currentPath, variantPath, referencePath];
    const composites = [];

    for (let i = 0; i < paths.length; i++) {
        const left = padding + i * (tileWidth + gap);
        composites.push({
            input: Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="8" y="16" fill="#e5e7eb" font-family="Arial" font-size="12">${labels[i]}</text></svg>`),
            left,
            top: padding
        });
        composites.push({
            input: paths[i],
            left,
            top: padding + labelHeight
        });
    }

    await sharp({
        create: {
            width: padding * 2 + tileWidth * 3 + gap * 2,
            height: padding * 2 + labelHeight + tileHeight,
            channels: 4,
            background: '#0b1020'
        }
    }).composite(composites).png().toFile(outputPath);
}

export async function createAllenkFdncnnRuntimeSeamReport({
    outputDir = DEFAULT_OUTPUT_DIR
} = {}) {
    const resolvedOutputDir = path.resolve(outputDir);
    await mkdir(resolvedOutputDir, { recursive: true });
    const synthetic = createSyntheticCase();
    const referencePath = path.join(resolvedOutputDir, 'reference.png');
    const currentPath = path.join(resolvedOutputDir, 'baseline.png');
    const variantPath = path.join(resolvedOutputDir, 'allenk-runtime-seam.png');
    const sheetPath = path.join(resolvedOutputDir, 'comparison-sheet.png');
    await encodePng(synthetic.reference, referencePath);
    await encodePng(synthetic.current, currentPath);
    await encodePng(synthetic.variant, variantPath);
    await createComparisonSheet({ referencePath, currentPath, variantPath, outputPath: sheetPath });

    const baselineResidual = summarizeWatermarkResidual({
        currentImage: synthetic.current,
        referenceImage: synthetic.reference,
        alphaMap: synthetic.alphaMap,
        watermarkPosition: synthetic.position
    });
    const variantResidual = summarizeWatermarkResidual({
        currentImage: synthetic.variant,
        referenceImage: synthetic.reference,
        alphaMap: synthetic.alphaMap,
        watermarkPosition: synthetic.position
    });
    const baselineAggregate = {
        active: baselineResidual.buckets.active,
        edge: baselineResidual.buckets.edge,
        lowBody: baselineResidual.buckets.lowBody,
        highBody: baselineResidual.buckets.highBody
    };
    const variantAggregate = {
        active: variantResidual.buckets.active,
        edge: variantResidual.buckets.edge,
        lowBody: variantResidual.buckets.lowBody,
        highBody: variantResidual.buckets.highBody
    };

    const report = {
        generatedAt: new Date().toISOString(),
        outputDir: resolvedOutputDir,
        profile: {
            denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
            edgeDenoiseStrength: 1,
            residualCleanupStrength: 0,
            runtime: synthetic.cleanup.denoiseRuntime,
            runtimeStatus: synthetic.cleanup.denoiseRuntimeStatus,
            syntheticSeamFixture: true
        },
        cases: [
            {
                id: 'synthetic-allenk-runtime-seam',
                label: 'Synthetic allenk runtime seam',
                sheetPath,
                referencePath,
                currentPath,
                variantPath,
                localWatermarkPosition: synthetic.position,
                profile: {
                    denoiseBackend: VIDEO_DENOISE_BACKENDS.ALLENK_FDNCNN_BROWSER_SPIKE,
                    edgeDenoiseStrength: 1,
                    residualCleanupStrength: 0
                },
                baselineAggregate,
                variantAggregate,
                deltas: calculateBucketDeltas(variantAggregate, baselineAggregate),
                runtime: synthetic.cleanup
            }
        ]
    };
    const jsonPath = path.join(resolvedOutputDir, 'latest-report.json');
    const markdownPath = path.join(resolvedOutputDir, 'latest-report.md');
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(markdownPath, renderVideoFrameBackendLabMarkdown(report));
    return {
        ...report,
        jsonPath,
        markdownPath
    };
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = { outputDir: DEFAULT_OUTPUT_DIR };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--output-dir') {
            args.outputDir = path.resolve(argv[++i]);
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs();
    if (args.help) {
        console.log('Usage: pnpm report:allenk-fdncnn-runtime-seam [--output-dir <dir>]');
        process.exit(0);
    }

    createAllenkFdncnnRuntimeSeamReport(args)
        .then((report) => {
            console.log(`json: ${report.jsonPath}`);
            console.log(`markdown: ${report.markdownPath}`);
            console.log(`sheet: ${report.cases[0].sheetPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
