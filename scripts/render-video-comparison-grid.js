import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/video-comparison-grid/latest.mp4');
const DEFAULT_TILE_WIDTH = 640;
const DEFAULT_CRF = 22;
const DEFAULT_PRESET = 'medium';

function runProcess(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
            }
        });
    });
}

function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function parseCropBox(value) {
    if (value == null || value === '') return null;
    const parts = String(value).trim().split(/[,\s]+/).map((part) => toFiniteNumber(part.trim()));
    if (parts.length !== 4 || parts.some((part) => part === null)) {
        throw new Error('裁剪区域格式应为 --crop x,y,width,height');
    }
    const [x, y, width, height] = parts.map((part) => Math.round(part));
    if (width <= 0 || height <= 0) {
        throw new Error('裁剪区域 width/height 必须为正数');
    }
    return { x, y, width, height };
}

export function parseInputSpec(value) {
    const raw = String(value || '');
    const eqIndex = raw.indexOf('=');
    if (eqIndex <= 0 || eqIndex === raw.length - 1) {
        throw new Error('输入格式应为 --input label=path/to/video.mp4');
    }
    const label = raw.slice(0, eqIndex).trim();
    const inputPath = raw.slice(eqIndex + 1).trim();
    if (!label || !inputPath) {
        throw new Error('输入 label 和路径不能为空');
    }
    return {
        label,
        path: path.resolve(inputPath)
    };
}

function escapeDrawtext(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "\\'")
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function buildScaleFilter(tileWidth, cropBox) {
    const width = Math.max(64, Math.round(tileWidth || DEFAULT_TILE_WIDTH));
    if (cropBox) {
        return `scale=${width}:${width}:force_original_aspect_ratio=decrease,pad=${width}:${width}:(ow-iw)/2:(oh-ih)/2`;
    }
    return `scale=${width}:-2`;
}

export function buildComparisonGridFilter({
    inputs,
    cropBox = null,
    tileWidth = DEFAULT_TILE_WIDTH
}) {
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 4) {
        throw new Error('视频对比网格需要 2 到 4 个输入');
    }
    const panelFilters = inputs.map((input, index) => {
        const pieces = [];
        if (cropBox) {
            pieces.push(`crop=${cropBox.width}:${cropBox.height}:${cropBox.x}:${cropBox.y}`);
        }
        pieces.push(buildScaleFilter(tileWidth, cropBox));
        pieces.push('setsar=1');
        pieces.push(`drawtext=text='${escapeDrawtext(input.label)}':x=10:y=10:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`);
        return `[${index}:v]${pieces.join(',')}[v${index}]`;
    });
    const stackInputs = inputs.map((_, index) => `[v${index}]`).join('');
    const layout = inputs.length <= 2
        ? '0_0|w0_0'
        : '0_0|w0_0|0_h0|w0_h0';
    const stack = `${stackInputs}xstack=inputs=${inputs.length}:layout=${layout}:fill=black[v]`;
    return [...panelFilters, stack].join(';');
}

export function renderComparisonGridMarkdown(report) {
    const lines = [
        '# Video Comparison Grid Report',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        '## Output',
        '',
        `- Output: ${report.outputPath}`,
        `- Crop: ${report.cropBox ? `${report.cropBox.x},${report.cropBox.y},${report.cropBox.width},${report.cropBox.height}` : 'full-frame'}`,
        `- Tile width: ${report.tileWidth}`,
        '',
        '## Inputs',
        '',
        '| Label | Path |',
        '|---|---|'
    ];
    for (const input of report.inputs || []) {
        lines.push(`| ${String(input.label).replaceAll('|', '\\|')} | ${String(input.path).replaceAll('|', '\\|')} |`);
    }
    return `${lines.join('\n')}\n`;
}

export async function renderVideoComparisonGrid({
    inputs,
    outputPath = DEFAULT_OUTPUT_PATH,
    reportPath = null,
    markdownPath = null,
    cropBox = null,
    tileWidth = DEFAULT_TILE_WIDTH,
    crf = DEFAULT_CRF,
    preset = DEFAULT_PRESET
}) {
    if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 4) {
        throw new Error('视频对比网格需要 2 到 4 个输入');
    }
    const resolvedOutputPath = path.resolve(outputPath);
    const resolvedReportPath = reportPath
        ? path.resolve(reportPath)
        : `${resolvedOutputPath}.json`;
    const resolvedMarkdownPath = markdownPath
        ? path.resolve(markdownPath)
        : `${resolvedOutputPath}.md`;
    const normalizedInputs = inputs.map((input) => ({
        label: input.label,
        path: path.resolve(input.path)
    }));
    const filter = buildComparisonGridFilter({
        inputs: normalizedInputs,
        cropBox,
        tileWidth
    });
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-y'
    ];
    for (const input of normalizedInputs) {
        args.push('-i', input.path);
    }
    args.push(
        '-filter_complex', filter,
        '-map', '[v]',
        '-an',
        '-c:v', 'libx264',
        '-preset', String(preset || DEFAULT_PRESET),
        '-crf', String(Number.isFinite(Number(crf)) ? Number(crf) : DEFAULT_CRF),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        resolvedOutputPath
    );

    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await runProcess('ffmpeg', args);

    const report = {
        generatedAt: new Date().toISOString(),
        outputPath: resolvedOutputPath,
        reportPath: resolvedReportPath,
        markdownPath: resolvedMarkdownPath,
        inputs: normalizedInputs,
        cropBox,
        tileWidth,
        crf,
        preset,
        ffmpegFilter: filter
    };
    await mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`);
    await mkdir(path.dirname(resolvedMarkdownPath), { recursive: true });
    await writeFile(resolvedMarkdownPath, renderComparisonGridMarkdown(report));
    return report;
}

function parseArgs(argv) {
    const args = {
        inputs: [],
        outputPath: DEFAULT_OUTPUT_PATH,
        cropBox: null,
        tileWidth: DEFAULT_TILE_WIDTH,
        crf: DEFAULT_CRF,
        preset: DEFAULT_PRESET
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            continue;
        } else if (arg === '--input') {
            args.inputs.push(parseInputSpec(argv[++i]));
        } else if (arg === '--output') {
            args.outputPath = path.resolve(argv[++i]);
        } else if (arg === '--report') {
            args.reportPath = path.resolve(argv[++i]);
        } else if (arg === '--markdown') {
            args.markdownPath = path.resolve(argv[++i]);
        } else if (arg === '--crop') {
            args.cropBox = parseCropBox(argv[++i]);
        } else if (arg === '--tile-width') {
            args.tileWidth = Number(argv[++i]);
        } else if (arg === '--crf') {
            args.crf = Number(argv[++i]);
        } else if (arg === '--preset') {
            args.preset = argv[++i];
        } else if (arg === '--help' || arg === '-h') {
            args.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }

    return args;
}

function printHelp() {
    console.log(`Usage:
  node scripts/render-video-comparison-grid.js --input original=a.mp4 --input current=b.mp4 --output out.mp4 [options]

Options:
  --input <label=path>      Add 2 to 4 video inputs
  --output <path>           Defaults to .artifacts/video-comparison-grid/latest.mp4
  --crop <x,y,w,h>          Optional crop before scaling
  --tile-width <px>         Defaults to 640
  --crf <n>                 Defaults to 22
  --preset <name>           Defaults to medium
  --report <json path>      Defaults to <output>.json
  --markdown <md path>      Defaults to <output>.md
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    renderVideoComparisonGrid(args)
        .then((report) => {
            console.log(`output: ${report.outputPath}`);
            console.log(`report: ${report.reportPath}`);
            console.log(`markdown: ${report.markdownPath}`);
        })
        .catch((error) => {
            console.error(error?.stack || error?.message || String(error));
            process.exit(1);
        });
}
