import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_VERDICTS = new Set([
    'alternative-better',
    'tie',
    'current-better',
    'unclear'
]);

function emptyVerdicts() {
    return {
        'alternative-better': 0,
        tie: 0,
        'current-better': 0,
        unclear: 0
    };
}

function incrementGroup(groups, key, verdict) {
    if (!groups[key]) groups[key] = emptyVerdicts();
    groups[key][verdict] += 1;
}

export function summarizeReview({ report, review }) {
    if (report.sourceReportSha256 !== review.sourceReportSha256) {
        throw new Error('review/report hash mismatch');
    }
    const matched = (report.records ?? []).filter(
        (record) => record.status === 'matched'
    );
    const decisionByFile = new Map();
    for (const decision of review.decisions ?? []) {
        if (decisionByFile.has(decision.fileName)) {
            throw new Error(`duplicate review decision: ${decision.fileName}`);
        }
        if (!ALLOWED_VERDICTS.has(decision.verdict)) {
            throw new Error(`invalid review verdict: ${decision.verdict}`);
        }
        decisionByFile.set(decision.fileName, decision);
    }
    const matchedFiles = new Set(matched.map((record) => record.fileName));
    for (const fileName of decisionByFile.keys()) {
        if (!matchedFiles.has(fileName)) {
            throw new Error(`unknown review file: ${fileName}`);
        }
    }

    const verdicts = emptyVerdicts();
    const byWidth = {};
    const byFamilyTransition = {};
    const bySelectedImperfectionType = {};
    for (const record of matched) {
        const decision = decisionByFile.get(record.fileName);
        if (!decision) {
            throw new Error(`missing review decision: ${record.fileName}`);
        }
        verdicts[decision.verdict] += 1;
        incrementGroup(
            byWidth,
            String(record.selected.position.width),
            decision.verdict
        );
        incrementGroup(
            byFamilyTransition,
            `${record.selected.family}>${record.alternative.family}`,
            decision.verdict
        );
        const typeKey =
            record.selected.imperfections?.types?.join('+') || 'none';
        incrementGroup(bySelectedImperfectionType, typeKey, decision.verdict);
    }
    return {
        matched: matched.length,
        verdicts,
        byWidth,
        byFamilyTransition,
        bySelectedImperfectionType,
        requiresSeparateProductionDesign: true
    };
}

export async function runSummary({ root }) {
    const report = JSON.parse(
        await readFile(path.join(root, 'report.json'), 'utf8')
    );
    const review = JSON.parse(
        await readFile(path.join(root, 'review.json'), 'utf8')
    );
    const summary = summarizeReview({ report, review });
    const outputPath = path.join(root, 'summary.json');
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return { summary, outputPath };
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    const argv = process.argv.slice(2);
    const rootIndex = argv.indexOf('--root');
    const root = path.resolve(
        rootIndex >= 0
            ? argv[rootIndex + 1]
            : '.artifacts/same-anchor-imperfection-review'
    );
    runSummary({ root })
        .then(({ outputPath }) => console.log(outputPath))
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
