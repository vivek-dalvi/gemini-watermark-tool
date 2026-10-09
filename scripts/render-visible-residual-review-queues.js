import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import sharp from 'sharp';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_DIR = path.resolve('.artifacts/visible-residual-crops/latest/review-queues');
const BACKGROUND = '#171717';
const ROW_GAP = 14;

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        outputDir: DEFAULT_OUTPUT_DIR
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--out-dir') {
            parsed.outputDir = path.resolve(args.shift() || parsed.outputDir);
        }
    }

    return parsed;
}

function stripBom(text) {
    return text.replace(/^\uFEFF/, '');
}

function sha256Text(text) {
    return createHash('sha256').update(text).digest('hex');
}

async function renderQueueSheet({ records, outputPath }) {
    if (!Array.isArray(records) || records.length === 0) return null;

    const rows = [];
    for (const record of records) {
        if (!record.cropPath) continue;
        const metadata = await sharp(record.cropPath).metadata();
        rows.push({
            input: record.cropPath,
            width: metadata.width,
            height: metadata.height
        });
    }

    if (rows.length === 0) return null;

    const width = Math.max(...rows.map((row) => row.width));
    const height = rows.reduce((sum, row) => sum + row.height, 0) + ROW_GAP * (rows.length - 1);
    const composites = [];
    let top = 0;
    for (const row of rows) {
        composites.push({ input: row.input, left: 0, top });
        top += row.height + ROW_GAP;
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: BACKGROUND
        }
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return {
        outputPath,
        count: rows.length,
        width,
        height
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const reviewManifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const manifest = JSON.parse(reviewManifestText);
    await mkdir(args.outputDir, { recursive: true });

    const queues = {};
    for (const [queueName, records] of Object.entries(manifest.workQueues ?? {})) {
        queues[queueName] = await renderQueueSheet({
            records,
            outputPath: path.join(args.outputDir, `${queueName}.png`)
        });
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        inputs: {
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256
        },
        outputDir: args.outputDir,
        queues
    };
    const summaryPath = path.join(args.outputDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify({
        summaryPath,
        queues: Object.fromEntries(
            Object.entries(queues).map(([name, queue]) => [name, queue ? {
                count: queue.count,
                outputPath: queue.outputPath
            } : null])
        )
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
