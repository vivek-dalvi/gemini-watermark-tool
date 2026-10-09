import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_BATCH_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-focused-batch.json');
const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_REVIEW_CLUSTER_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-clusters.json');
const DEFAULT_DECISIONS_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-decisions.json');
const DEFAULT_CANDIDATE_DECISIONS_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidate-confirmations.json');
const VALID_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'backgroundStructure',
    'contentCollision',
    'acceptableResidual',
    'needsModelInvestigation'
]);
const VALID_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
const NOTE_REQUIRED_VERDICTS = Object.freeze(['trueVisibleResidual', 'needsModelInvestigation']);
const ALLOWED_BATCH_ROOT_KEYS = new Set([
    'schemaVersion',
    'generatedAt',
    'policy',
    'provenance',
    'sourceBatches',
    'decisions',
    'blockedActions'
]);
const ALLOWED_BATCH_DECISION_KEYS = new Set([
    'sourceSet',
    'file',
    'clusterId',
    'decisionInputPath',
    'decisionJsonPath',
    'decisionArrayIndex',
    'cropPath',
    'profileLine',
    'visibleReasons',
    'suggestedVerdict',
    'suggestedConfidence',
    'problems',
    'humanVerdict',
    'humanConfidence',
    'humanNotes'
]);
const FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS = new Set([
    'alphagain',
    'alphagainsweep',
    'alphamap',
    'alphamappath',
    'alphaprofile',
    'alphaprofilemidboost124',
    'midboost',
    'productionprofile',
    'profileadjustment',
    'profilecandidate',
    'profileoverride',
    'profilevariant',
    'renderprofile',
    'watermarkprofile'
]);

function parseArgs(argv) {
    const parsed = {
        batchPath: DEFAULT_BATCH_PATH,
        validationPath: DEFAULT_VALIDATION_PATH,
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        reviewClusterPath: DEFAULT_REVIEW_CLUSTER_PATH,
        decisionsPath: DEFAULT_DECISIONS_PATH,
        candidateDecisionsPath: DEFAULT_CANDIDATE_DECISIONS_PATH,
        dryRun: false,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--batch') {
            parsed.batchPath = path.resolve(args.shift() || parsed.batchPath);
            continue;
        }
        if (arg === '--validation') {
            parsed.validationPath = path.resolve(args.shift() || parsed.validationPath);
            continue;
        }
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--clusters') {
            parsed.reviewClusterPath = path.resolve(args.shift() || parsed.reviewClusterPath);
            continue;
        }
        if (arg === '--decisions') {
            parsed.decisionsPath = path.resolve(args.shift() || parsed.decisionsPath);
            continue;
        }
        if (arg === '--candidate-decisions') {
            parsed.candidateDecisionsPath = path.resolve(args.shift() || parsed.candidateDecisionsPath);
            continue;
        }
        if (arg === '--dry-run') {
            parsed.dryRun = true;
            continue;
        }
        if (arg === '--allow-active-loop-state') {
            parsed.allowActiveLoopState = true;
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

function normalizeFieldKey(key) {
    return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unknownKeys(value, allowedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    return Object.keys(value).filter((key) => !allowedKeys.has(key));
}

function forbiddenAlphaProfileFieldPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const out = [];
    for (const [key, child] of Object.entries(value)) {
        const currentPath = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(key))) out.push(currentPath);
        if (child && typeof child === 'object') {
            out.push(...forbiddenAlphaProfileFieldPaths(child, currentPath));
        }
    }
    return out;
}

async function readJsonWithText(filePath) {
    const text = stripBom(await readFile(filePath, 'utf8'));
    return {
        text,
        json: JSON.parse(text),
        sha256: sha256Text(text)
    };
}

async function readActiveLoopRunState(statePath) {
    if (!existsSync(statePath)) return null;
    try {
        const state = JSON.parse(stripBom(await readFile(statePath, 'utf8')));
        if (state?.status !== 'running') return null;
        return state;
    } catch (error) {
        return {
            status: 'running',
            unreadable: true,
            error: error.message
        };
    }
}

function decisionInputForSource(sourceSet, paths) {
    if (sourceSet === 'visibleTopPending') return paths.decisionsPath;
    if (sourceSet === 'metricPassVisible') return paths.candidateDecisionsPath;
    return null;
}

function validateBatch({ batch, hashes, paths }) {
    const problems = [];
    const seenTargets = new Map();
    for (const key of unknownKeys(batch, ALLOWED_BATCH_ROOT_KEYS)) {
        problems.push({ type: 'focused-batch-unknown-root-field', field: key });
    }
    for (const fieldPath of forbiddenAlphaProfileFieldPaths(batch)) {
        problems.push({ type: 'focused-batch-alpha-profile-field-present', fieldPath });
    }
    if (batch.policy?.writesFormalGoldManifest !== false) {
        problems.push({ type: 'focused-batch-policy-may-write-formal-gold' });
    }
    if (batch.policy?.writesProductionAlgorithm !== false) {
        problems.push({ type: 'focused-batch-policy-may-write-production-algorithm' });
    }
    if (batch.policy?.allowsAlphaProfileProduction !== false) {
        problems.push({ type: 'focused-batch-policy-may-productionize-alpha-profile' });
    }
    if (batch.provenance?.validationReportSha256 !== hashes.validationReportSha256) {
        problems.push({ type: 'focused-batch-validation-hash-mismatch' });
    }
    if (batch.provenance?.reviewManifestSha256 !== hashes.reviewManifestSha256) {
        problems.push({ type: 'focused-batch-review-manifest-hash-mismatch' });
    }
    if (batch.provenance?.reviewClusterSha256 !== hashes.reviewClusterSha256) {
        problems.push({ type: 'focused-batch-review-cluster-hash-mismatch' });
    }
    if (!Array.isArray(batch.decisions) || batch.decisions.length === 0) {
        problems.push({ type: 'focused-batch-decisions-empty' });
    }

    (batch.decisions ?? []).forEach((decision, index) => {
        for (const key of unknownKeys(decision, ALLOWED_BATCH_DECISION_KEYS)) {
            problems.push({ type: 'focused-batch-decision-unknown-field', index, field: key, file: decision.file ?? null });
        }
        const expectedInputPath = decisionInputForSource(decision.sourceSet, paths);
        if (!expectedInputPath) {
            problems.push({ type: 'focused-batch-unknown-source-set', index, sourceSet: decision.sourceSet ?? null });
        } else if (path.resolve(decision.decisionInputPath ?? '') !== expectedInputPath) {
            problems.push({
                type: 'focused-batch-decision-input-path-mismatch',
                index,
                file: decision.file ?? null,
                expectedInputPath,
                actualInputPath: decision.decisionInputPath ?? null
            });
        }
        if (Number.isInteger(decision.decisionArrayIndex)) {
            const expectedDecisionJsonPath = `decisions[${decision.decisionArrayIndex}]`;
            if (decision.decisionJsonPath !== expectedDecisionJsonPath) {
                problems.push({
                    type: 'focused-batch-decision-json-path-mismatch',
                    index,
                    file: decision.file ?? null,
                    expectedDecisionJsonPath,
                    actualDecisionJsonPath: decision.decisionJsonPath ?? null
                });
            }
        }
        const targetKey = expectedInputPath && Number.isInteger(decision.decisionArrayIndex)
            ? `${expectedInputPath}#${decision.decisionArrayIndex}`
            : null;
        if (targetKey) {
            const previousIndex = seenTargets.get(targetKey);
            if (previousIndex !== undefined) {
                problems.push({
                    type: 'focused-batch-duplicate-target',
                    index,
                    previousIndex,
                    file: decision.file ?? null,
                    decisionInputPath: decision.decisionInputPath ?? null,
                    decisionArrayIndex: decision.decisionArrayIndex,
                    decisionJsonPath: decision.decisionJsonPath ?? null
                });
            } else {
                seenTargets.set(targetKey, index);
            }
        }
        if (!VALID_VERDICTS.includes(decision.humanVerdict)) {
            problems.push({ type: 'focused-batch-invalid-or-missing-humanVerdict', index, file: decision.file ?? null });
        }
        if (!VALID_CONFIDENCE.includes(decision.humanConfidence)) {
            problems.push({ type: 'focused-batch-invalid-or-missing-humanConfidence', index, file: decision.file ?? null });
        }
        if (NOTE_REQUIRED_VERDICTS.includes(decision.humanVerdict) && String(decision.humanNotes ?? '').trim().length === 0) {
            problems.push({ type: 'focused-batch-humanNotes-required', index, file: decision.file ?? null });
        }
    });
    return problems;
}

function validateLocator({ decision, fullDecision, index }) {
    const problems = [];
    if (!fullDecision) {
        problems.push({ type: 'focused-batch-target-missing', index, file: decision.file ?? null });
        return problems;
    }
    for (const key of ['sourceSet', 'file', 'clusterId', 'cropPath', 'profileLine']) {
        if (decision[key] !== fullDecision[key]) {
            problems.push({
                type: `focused-batch-${key}-mismatch`,
                index,
                file: decision.file ?? null,
                expected: fullDecision[key] ?? null,
                actual: decision[key] ?? null
            });
        }
    }
    if (Number.isInteger(decision.decisionArrayIndex) && decision.decisionArrayIndex !== fullDecision.index) {
        problems.push({
            type: 'focused-batch-decision-index-mismatch',
            index,
            file: decision.file ?? null,
            expected: fullDecision.index,
            actual: decision.decisionArrayIndex
        });
    }
    if (JSON.stringify(decision.visibleReasons ?? []) !== JSON.stringify(fullDecision.visibleReasons ?? [])) {
        problems.push({
            type: 'focused-batch-visibleReasons-mismatch',
            index,
            file: decision.file ?? null
        });
    }
    return problems;
}

function applyBatchToPayloads({ batch, decisionsPayload, candidateDecisionsPayload, paths }) {
    const problems = [];
    const changed = {
        visibleTopPending: 0,
        metricPassVisible: 0
    };
    const changedTargets = [];
    const bySource = {
        visibleTopPending: decisionsPayload,
        metricPassVisible: candidateDecisionsPayload
    };

    (batch.decisions ?? []).forEach((decision, index) => {
        const payload = bySource[decision.sourceSet];
        const targetIndex = decision.decisionArrayIndex;
        const fullDecision = Number.isInteger(targetIndex) ? payload?.decisions?.[targetIndex] : null;
        problems.push(...validateLocator({ decision, fullDecision, index }));
        if (!fullDecision) return;
        changedTargets.push({
            sourceSet: decision.sourceSet,
            file: decision.file,
            clusterId: decision.clusterId,
            decisionInputPath: decision.decisionInputPath,
            decisionJsonPath: decision.decisionJsonPath,
            decisionArrayIndex: decision.decisionArrayIndex,
            previousHumanVerdict: fullDecision.humanVerdict ?? null,
            previousHumanConfidence: fullDecision.humanConfidence ?? null,
            previousHumanNotes: fullDecision.humanNotes ?? '',
            nextHumanVerdict: decision.humanVerdict,
            nextHumanConfidence: decision.humanConfidence,
            nextHumanNotes: String(decision.humanNotes ?? '')
        });
        fullDecision.humanVerdict = decision.humanVerdict;
        fullDecision.humanConfidence = decision.humanConfidence;
        fullDecision.humanNotes = String(decision.humanNotes ?? '');
        changed[decision.sourceSet] += 1;
    });

    return {
        problems,
        changed,
        changedTargets,
        outputs: {
            decisionsPath: paths.decisionsPath,
            candidateDecisionsPath: paths.candidateDecisionsPath
        }
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.resolve(path.dirname(args.decisionsPath), '..', 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            skippedWrite: true,
            dryRun: args.dryRun,
            decisionsPath: args.decisionsPath,
            candidateDecisionsPath: args.candidateDecisionsPath,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:apply-focused-batch.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const paths = {
        decisionsPath: args.decisionsPath,
        candidateDecisionsPath: args.candidateDecisionsPath
    };
    const batchRead = await readJsonWithText(args.batchPath);
    const validationRead = await readJsonWithText(args.validationPath);
    const manifestRead = await readJsonWithText(args.reviewManifestPath);
    const clusterRead = await readJsonWithText(args.reviewClusterPath);
    const decisionsRead = await readJsonWithText(args.decisionsPath);
    const candidateDecisionsRead = await readJsonWithText(args.candidateDecisionsPath);
    const hashes = {
        validationReportSha256: validationRead.sha256,
        reviewManifestSha256: manifestRead.sha256,
        reviewClusterSha256: clusterRead.sha256
    };
    const problems = validateBatch({
        batch: batchRead.json,
        hashes,
        paths
    });
    const applyResult = problems.length === 0
        ? applyBatchToPayloads({
            batch: batchRead.json,
            decisionsPayload: decisionsRead.json,
            candidateDecisionsPayload: candidateDecisionsRead.json,
            paths
        })
        : {
            problems: [],
            changed: { visibleTopPending: 0, metricPassVisible: 0 },
            changedTargets: [],
            outputs: paths
        };
    problems.push(...applyResult.problems);
    const decisionsAfterText = `${JSON.stringify(decisionsRead.json, null, 2)}\n`;
    const candidateDecisionsAfterText = `${JSON.stringify(candidateDecisionsRead.json, null, 2)}\n`;

    const report = {
        ok: problems.length === 0,
        skippedWrite: problems.length > 0 || args.dryRun,
        dryRun: args.dryRun,
        batchPath: args.batchPath,
        policy: {
            writesHumanReviewInputs: !args.dryRun && problems.length === 0,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            allowsAlphaProfileProduction: false
        },
        hashes: {
            batchSha256: batchRead.sha256,
            ...hashes,
            decisionsBeforeSha256: decisionsRead.sha256,
            candidateDecisionsBeforeSha256: candidateDecisionsRead.sha256,
            decisionsAfterSha256: sha256Text(decisionsAfterText),
            candidateDecisionsAfterSha256: sha256Text(candidateDecisionsAfterText)
        },
        changed: applyResult.changed,
        changedTargets: applyResult.changedTargets,
        outputs: applyResult.outputs,
        problems
    };

    if (problems.length > 0) {
        console.error(JSON.stringify(report, null, 2));
        process.exitCode = 1;
        return;
    }
    if (!args.dryRun) {
        await mkdir(path.dirname(args.decisionsPath), { recursive: true });
        await writeFile(args.decisionsPath, decisionsAfterText, 'utf8');
        await writeFile(args.candidateDecisionsPath, candidateDecisionsAfterText, 'utf8');
    }
    console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
