import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_DECISIONS_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-decisions.json');
const DEFAULT_DECISIONS_TEMPLATE_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-decisions.template.json');
const DEFAULT_CANDIDATE_DECISIONS_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidate-confirmations.json');
const DEFAULT_CANDIDATE_DECISIONS_TEMPLATE_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/gold-candidate-confirmations.template.json');
const DEFAULT_REVIEW_INPUT_CONTRACT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/review-input-contract.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const VALID_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'backgroundStructure',
    'contentCollision',
    'acceptableResidual',
    'needsModelInvestigation'
]);
const VALID_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
const GOLD_BLOCKING_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'needsModelInvestigation'
]);
const STRUCTURAL_DECISION_PROBLEMS = Object.freeze([
    'sourceSet-mismatch',
    'clusterId-mismatch',
    'cropPath-mismatch',
    'decision-index-mismatch',
    'decision-input-alpha-profile-variant-fields-present',
    'decision-input-unknown-root-fields-present',
    'decision-alpha-profile-variant-fields-present',
    'decision-unknown-fields-present'
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
const ALLOWED_DECISION_FIELD_KEYS = new Set([
    'clusterId',
    'cropPath',
    'decisionArrayIndex',
    'file',
    'humanConfidence',
    'humanNotes',
    'humanVerdict',
    'index',
    'metrics',
    'profileLine',
    'reviewStatus',
    'sourceSet',
    'suggestedConfidence',
    'suggestedNotes',
    'suggestedVerdict',
    'visibleReasons'
]);
const ALLOWED_DECISION_INPUT_ROOT_KEYS = new Set([
    'decisions',
    'instructions',
    'reviewManifestSha256',
    'schemaVersion'
]);

function parseArgs(argv) {
    const parsed = {
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        decisionsPath: DEFAULT_DECISIONS_PATH,
        candidateDecisionsPath: DEFAULT_CANDIDATE_DECISIONS_PATH,
        candidateDecisionsProvided: false,
        reviewInputContractPath: DEFAULT_REVIEW_INPUT_CONTRACT_PATH,
        reviewInputContractProvided: false,
        outputPath: DEFAULT_OUTPUT_PATH,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
            continue;
        }
        if (arg === '--decisions') {
            parsed.decisionsPath = path.resolve(args.shift() || parsed.decisionsPath);
            continue;
        }
        if (arg === '--candidate-decisions') {
            parsed.candidateDecisionsPath = path.resolve(args.shift() || parsed.candidateDecisionsPath);
            parsed.candidateDecisionsProvided = true;
            continue;
        }
        if (arg === '--contract') {
            parsed.reviewInputContractPath = path.resolve(args.shift() || parsed.reviewInputContractPath);
            parsed.reviewInputContractProvided = true;
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
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

function normalizeFieldKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectForbiddenAlphaProfileFieldPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const paths = [];
    for (const [key, nested] of Object.entries(value)) {
        const currentPath = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(key))) {
            paths.push(currentPath);
        }
        paths.push(...collectForbiddenAlphaProfileFieldPaths(nested, currentPath));
    }
    return paths;
}

function collectForbiddenDecisionInputMetadataFieldPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    const paths = [];
    for (const [key, nested] of Object.entries(value)) {
        if (key === 'decisions') continue;
        const currentPath = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(key))) {
            paths.push(currentPath);
        }
        paths.push(...collectForbiddenDecisionInputMetadataFieldPaths(nested, currentPath));
    }
    return paths;
}

function collectUnknownTopLevelFieldPaths(value, allowedKeys, prefix = '') {
    if (!value || typeof value !== 'object') return [];
    return Object.keys(value)
        .filter((key) => !allowedKeys.has(key))
        .map((key) => (prefix ? `${prefix}.${key}` : key));
}

async function readJson(filePath) {
    return JSON.parse(stripBom(await readFile(filePath, 'utf8')));
}

async function readOptionalJsonText(filePath) {
    if (!existsSync(filePath)) {
        return {
            payload: null,
            text: null,
            sha256: null
        };
    }
    const text = stripBom(await readFile(filePath, 'utf8'));
    return {
        payload: JSON.parse(text),
        text,
        sha256: sha256Text(text)
    };
}

async function readJsonWithFallback(filePath, fallbackPath = null) {
    if (existsSync(filePath)) {
        return {
            payload: await readJson(filePath),
            actualPath: filePath,
            usedFallback: false
        };
    }
    if (fallbackPath && existsSync(fallbackPath)) {
        return {
            payload: await readJson(fallbackPath),
            actualPath: fallbackPath,
            usedFallback: true
        };
    }
    return {
        payload: { decisions: [] },
        actualPath: filePath,
        usedFallback: false
    };
}

function countBy(items, getKey) {
    const counts = {};
    for (const item of items) {
        const key = getKey(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.fromEntries(
        Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    );
}

function normalizeReasons(reasons) {
    return [...new Set(reasons ?? [])].sort((left, right) => left.localeCompare(right));
}

function clusterIdFor({ sourceSet, profileLine, visibleReasons }) {
    return `${sourceSet}::${profileLine}::${normalizeReasons(visibleReasons).join('+')}`;
}

function normalizeDecision(decision, decisionArrayIndex) {
    return {
        ...decision,
        decisionArrayIndex,
        humanVerdict: typeof decision.humanVerdict === 'string' && decision.humanVerdict.length > 0
            ? decision.humanVerdict
            : null,
        humanConfidence: typeof decision.humanConfidence === 'string' && decision.humanConfidence.length > 0
            ? decision.humanConfidence
            : null,
        humanNotes: typeof decision.humanNotes === 'string' ? decision.humanNotes : ''
    };
}

function decisionLocator({ decision, decisionInputPath }) {
    return {
        decisionInputPath,
        decisionArrayIndex: decision.decisionArrayIndex,
        decisionIndex: Number.isInteger(decision.index) ? decision.index : null,
        decisionJsonPath: `decisions[${decision.decisionArrayIndex}]`
    };
}

function hasStructuralDecisionProblem(problems) {
    return problems.some((problem) => STRUCTURAL_DECISION_PROBLEMS.includes(problem));
}

function arraysEqual(left, right) {
    return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function decisionSetByName(contract, name) {
    return (contract?.decisionSets ?? []).find((set) => set.name === name) ?? null;
}

function validateReviewInputContract({
    contract,
    reviewManifestSha256,
    pendingTotal,
    goldCandidateTotal,
    decisionsPath,
    candidateDecisionsPath
}) {
    if (!contract) return [];
    const problems = [];
    if (contract.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('review-input-contract-manifest-hash-mismatch');
    }
    if (!arraysEqual(contract.allowedHumanVerdicts, VALID_VERDICTS)) {
        problems.push('review-input-contract-verdicts-mismatch');
    }
    if (!arraysEqual(contract.allowedHumanConfidence, VALID_CONFIDENCE)) {
        problems.push('review-input-contract-confidence-mismatch');
    }
    if (!arraysEqual(contract.allowedDecisionFields, [...ALLOWED_DECISION_FIELD_KEYS].sort())) {
        problems.push('review-input-contract-decision-fields-mismatch');
    }
    if (!arraysEqual(contract.allowedDecisionInputRootFields, [...ALLOWED_DECISION_INPUT_ROOT_KEYS].sort())) {
        problems.push('review-input-contract-decision-input-root-fields-mismatch');
    }
    if (!arraysEqual(contract.forbiddenAlphaProfileFieldKeys, [...FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS].sort())) {
        problems.push('review-input-contract-forbidden-alpha-profile-fields-mismatch');
    }
    if (!arraysEqual(contract.blockingVerdictsRequireHumanNotes, GOLD_BLOCKING_VERDICTS)) {
        problems.push('review-input-contract-blocking-verdicts-mismatch');
    }
    if (contract.policy?.writesFormalGoldManifest !== false) {
        problems.push('review-input-contract-policy-allows-gold-write');
    }
    if (contract.policy?.writesProductionAlgorithm !== false) {
        problems.push('review-input-contract-policy-allows-production-write');
    }
    const pendingSet = decisionSetByName(contract, 'visibleTopPending');
    const candidateSet = decisionSetByName(contract, 'metricPassVisible');
    if (!pendingSet) {
        problems.push('review-input-contract-missing-visibleTopPending-set');
    } else {
        if (pendingSet.expectedCount !== pendingTotal) {
            problems.push('review-input-contract-visibleTopPending-count-mismatch');
        }
        if (path.resolve(pendingSet.inputPath ?? '') !== path.resolve(decisionsPath)) {
            problems.push('review-input-contract-visibleTopPending-input-path-mismatch');
        }
    }
    if (!candidateSet) {
        problems.push('review-input-contract-missing-metricPassVisible-set');
    } else {
        if (candidateSet.expectedCount !== goldCandidateTotal) {
            problems.push('review-input-contract-metricPassVisible-count-mismatch');
        }
        if (path.resolve(candidateSet.inputPath ?? '') !== path.resolve(candidateDecisionsPath)) {
            problems.push('review-input-contract-metricPassVisible-input-path-mismatch');
        }
    }
    return problems;
}

function validateDecisionSet({ records, decisionsPayload, setName, reviewManifestSha256, decisionInputPath }) {
    const recordsByFile = new Map(records.map((record) => [record.file, record]));
    const decisions = (decisionsPayload.decisions ?? []).map((decision, index) => normalizeDecision(decision, index));
    const decisionByFile = new Map();
    const duplicateFiles = [];
    const unknownFiles = [];
    const missingDecisions = [];
    const incompleteDecisions = [];
    const invalidDecisions = [];
    const readyDecisions = [];
    const metadataErrors = [];
    const decisionInputLabel = path.basename(decisionInputPath);

    if (
        typeof decisionsPayload.reviewManifestSha256 === 'string' &&
        decisionsPayload.reviewManifestSha256 !== reviewManifestSha256
    ) {
        metadataErrors.push({
            type: 'review-manifest-sha256-mismatch',
            expectedReviewManifestSha256: reviewManifestSha256,
            actualReviewManifestSha256: decisionsPayload.reviewManifestSha256
        });
    }
    const forbiddenInputMetadataFieldPaths = collectForbiddenDecisionInputMetadataFieldPaths(
        decisionsPayload,
        decisionInputLabel
    );
    const unknownDecisionInputRootFieldPaths = collectUnknownTopLevelFieldPaths(
        decisionsPayload,
        ALLOWED_DECISION_INPUT_ROOT_KEYS,
        decisionInputLabel
    );
    if (forbiddenInputMetadataFieldPaths.length > 0) {
        metadataErrors.push({
            type: 'decision-input-alpha-profile-variant-fields-present',
            decisionInputPath,
            problems: ['decision-input-alpha-profile-variant-fields-present'],
            forbiddenAlphaProfileFieldPaths: forbiddenInputMetadataFieldPaths
        });
    }
    if (unknownDecisionInputRootFieldPaths.length > 0) {
        metadataErrors.push({
            type: 'decision-input-unknown-root-fields-present',
            decisionInputPath,
            problems: ['decision-input-unknown-root-fields-present'],
            unknownDecisionInputRootFieldPaths
        });
    }

    for (const decision of decisions) {
        if (decisionByFile.has(decision.file)) {
            duplicateFiles.push(decision.file);
            continue;
        }
        decisionByFile.set(decision.file, decision);
        const record = recordsByFile.get(decision.file);
        if (!record) {
            unknownFiles.push(decision.file);
            continue;
        }
        const profileLine = record.review?.profileLine ?? 'unknown';
        const visibleReasons = record.metrics?.visibleReasons ?? [];
        const clusterId = clusterIdFor({
            sourceSet: setName,
            profileLine,
            visibleReasons
        });
        const problems = [];
        const forbiddenAlphaProfileFieldPaths = collectForbiddenAlphaProfileFieldPaths(decision, decision.file);
        const unknownDecisionFieldPaths = collectUnknownTopLevelFieldPaths(
            decision,
            ALLOWED_DECISION_FIELD_KEYS,
            decision.file
        );
        if (forbiddenAlphaProfileFieldPaths.length > 0) {
            problems.push('decision-alpha-profile-variant-fields-present');
        }
        if (unknownDecisionFieldPaths.length > 0) {
            problems.push('decision-unknown-fields-present');
        }
        if (!VALID_VERDICTS.includes(decision.humanVerdict)) {
            problems.push('invalid-or-missing-humanVerdict');
        }
        if (!VALID_CONFIDENCE.includes(decision.humanConfidence)) {
            problems.push('invalid-or-missing-humanConfidence');
        }
        if (GOLD_BLOCKING_VERDICTS.includes(decision.humanVerdict) && decision.humanNotes.trim().length === 0) {
            problems.push('blocking-verdict-requires-humanNotes');
        }
        if (Number.isInteger(decision.index) && decision.index !== decision.decisionArrayIndex) {
            problems.push('decision-index-mismatch');
        }
        if (typeof decision.sourceSet === 'string' && decision.sourceSet !== setName) {
            problems.push('sourceSet-mismatch');
        }
        if (typeof decision.clusterId === 'string' && decision.clusterId !== clusterId) {
            problems.push('clusterId-mismatch');
        }
        if (decision.cropPath !== record.cropPath) {
            problems.push('cropPath-mismatch');
        }
        if (problems.length > 0) {
            const entry = {
                file: decision.file,
                ...decisionLocator({ decision, decisionInputPath }),
                clusterId,
                expectedSourceSet: setName,
                actualSourceSet: typeof decision.sourceSet === 'string' ? decision.sourceSet : null,
                expectedClusterId: clusterId,
                actualClusterId: typeof decision.clusterId === 'string' ? decision.clusterId : null,
                problems,
                forbiddenAlphaProfileFieldPaths,
                unknownDecisionFieldPaths,
                humanVerdict: decision.humanVerdict,
                humanConfidence: decision.humanConfidence
            };
            if (hasStructuralDecisionProblem(problems)) {
                invalidDecisions.push(entry);
            } else if (decision.humanVerdict === null || decision.humanConfidence === null) {
                incompleteDecisions.push(entry);
            } else {
                invalidDecisions.push(entry);
            }
            continue;
        }
        readyDecisions.push({
            file: decision.file,
            ...decisionLocator({ decision, decisionInputPath }),
            sourceSet: setName,
            profileLine,
            visibleReasons,
            clusterId,
            suggestedVerdict: decision.suggestedVerdict ?? record.review?.verdict ?? null,
            suggestedConfidence: decision.suggestedConfidence ?? record.review?.confidence ?? null,
            humanVerdict: decision.humanVerdict,
            humanConfidence: decision.humanConfidence,
            humanNotes: decision.humanNotes,
            metrics: record.metrics,
            cropPath: record.cropPath
        });
    }

    for (const record of records) {
        if (!decisionByFile.has(record.file)) {
            missingDecisions.push({
                file: record.file,
                sourceSet: setName,
                decisionInputPath,
                decisionArrayIndex: null,
                decisionIndex: null,
                decisionJsonPath: null
            });
        }
    }

    const structuralErrors = [
        ...metadataErrors,
        ...duplicateFiles.map((file) => ({ type: 'duplicate-file', file })),
        ...unknownFiles.map((file) => ({ type: 'unknown-file', file })),
        ...missingDecisions.map((entry) => ({ type: 'missing-decision-entry', ...entry })),
        ...invalidDecisions.map((entry) => ({ type: 'invalid-decision', ...entry }))
    ];
    const unconfirmedCount = incompleteDecisions.length + missingDecisions.length;
    const ready = structuralErrors.length === 0 &&
        unconfirmedCount === 0 &&
        readyDecisions.length === records.length;

    return {
        total: records.length,
        decisionTotal: decisions.length,
        ready,
        unconfirmedCount,
        structuralErrorCount: structuralErrors.length,
        readyDecisionCount: readyDecisions.length,
        verdictCounts: countBy(readyDecisions, (decision) => decision.humanVerdict),
        confidenceCounts: countBy(readyDecisions, (decision) => decision.humanConfidence),
        profileCounts: countBy(readyDecisions, (decision) => decision.profileLine),
        incompleteDecisions,
        structuralErrors,
        readyDecisions
    };
}

function buildDecisionSchemaGate({ pendingValidation, goldCandidateValidation }) {
    const structuralErrors = [
        ...pendingValidation.structuralErrors,
        ...goldCandidateValidation.structuralErrors
    ];
    const forbiddenAlphaProfileFieldPaths = structuralErrors.flatMap((entry) => (
        entry.forbiddenAlphaProfileFieldPaths ?? []
    ));
    const unknownDecisionFieldPaths = structuralErrors.flatMap((entry) => (
        entry.unknownDecisionFieldPaths ?? []
    ));
    const unknownDecisionInputRootFieldPaths = structuralErrors.flatMap((entry) => (
        entry.unknownDecisionInputRootFieldPaths ?? []
    ));
    return {
        armed: true,
        appliesToHumanReviewDecisionInputs: true,
        rejectsAlphaProfileVariantFields: true,
        rejectsUnknownDecisionFields: true,
        rejectsUnknownDecisionInputRootFields: true,
        allowedDecisionFields: [...ALLOWED_DECISION_FIELD_KEYS].sort(),
        allowedDecisionInputRootFields: [...ALLOWED_DECISION_INPUT_ROOT_KEYS].sort(),
        forbiddenAlphaProfileFieldKeys: [...FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS].sort(),
        failClosedProblemCodes: [
            'decision-input-alpha-profile-variant-fields-present',
            'decision-input-unknown-root-fields-present',
            'decision-alpha-profile-variant-fields-present',
            'decision-unknown-fields-present'
        ],
        forbiddenAlphaProfileFieldPaths,
        unknownDecisionFieldPaths,
        unknownDecisionInputRootFieldPaths,
        ok: forbiddenAlphaProfileFieldPaths.length === 0 &&
            unknownDecisionFieldPaths.length === 0 &&
            unknownDecisionInputRootFieldPaths.length === 0
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.resolve(path.dirname(args.outputPath), '..', 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath,
            skippedWrite: true,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:validate-human-review.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const manifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const reviewManifestSha256 = sha256Text(manifestText);
    const manifest = JSON.parse(manifestText);
    const shouldReadContract = args.reviewInputContractProvided ||
        path.resolve(args.reviewManifestPath) === DEFAULT_REVIEW_MANIFEST_PATH;
    const contractRead = shouldReadContract
        ? await readOptionalJsonText(args.reviewInputContractPath)
        : {
            payload: null,
            text: null,
            sha256: null
        };
    const decisionsRead = await readJsonWithFallback(
        args.decisionsPath,
        args.decisionsPath === DEFAULT_DECISIONS_PATH ? DEFAULT_DECISIONS_TEMPLATE_PATH : null
    );
    const shouldReadCandidateDecisions = args.candidateDecisionsProvided ||
        path.resolve(args.reviewManifestPath) === DEFAULT_REVIEW_MANIFEST_PATH;
    const candidateDecisionsRead = shouldReadCandidateDecisions
        ? await readJsonWithFallback(
            args.candidateDecisionsPath,
            args.candidateDecisionsPath === DEFAULT_CANDIDATE_DECISIONS_PATH
                ? DEFAULT_CANDIDATE_DECISIONS_TEMPLATE_PATH
                : null
        )
        : {
            payload: { decisions: [] },
            actualPath: args.candidateDecisionsPath,
            usedFallback: false
        };
    const pendingRecords = manifest.groups?.visibleTopPending ?? [];
    const goldCandidateRecords = manifest.groups?.metricPassVisible ?? [];
    const reviewInputContractProblems = validateReviewInputContract({
        contract: contractRead.payload,
        reviewManifestSha256,
        pendingTotal: pendingRecords.length,
        goldCandidateTotal: goldCandidateRecords.length,
        decisionsPath: decisionsRead.actualPath,
        candidateDecisionsPath: candidateDecisionsRead.actualPath
    });
    const pendingValidation = validateDecisionSet({
        records: pendingRecords,
        decisionsPayload: decisionsRead.payload,
        setName: 'visibleTopPending',
        reviewManifestSha256,
        decisionInputPath: decisionsRead.actualPath
    });
    const goldCandidateValidation = validateDecisionSet({
        records: goldCandidateRecords,
        decisionsPayload: candidateDecisionsRead.payload,
        setName: 'metricPassVisible',
        reviewManifestSha256,
        decisionInputPath: candidateDecisionsRead.actualPath
    });
    const structuralErrorCount = pendingValidation.structuralErrorCount +
        goldCandidateValidation.structuralErrorCount +
        reviewInputContractProblems.length;
    const unconfirmedCount = pendingValidation.unconfirmedCount + goldCandidateValidation.unconfirmedCount;
    const readyDecisions = [
        ...pendingValidation.readyDecisions,
        ...goldCandidateValidation.readyDecisions
    ];
    const decisionSchemaGate = buildDecisionSchemaGate({
        pendingValidation,
        goldCandidateValidation
    });
    const readyForGoldMigration = pendingValidation.ready &&
        goldCandidateValidation.ready &&
        structuralErrorCount === 0 &&
        unconfirmedCount === 0;
    const report = {
        generatedAt: new Date().toISOString(),
        reviewManifestPath: args.reviewManifestPath,
        reviewManifestSha256,
        decisionsPath: decisionsRead.actualPath,
        requestedDecisionsPath: args.decisionsPath,
        decisionsUsedFallbackTemplate: decisionsRead.usedFallback,
        candidateDecisionsPath: candidateDecisionsRead.actualPath,
        requestedCandidateDecisionsPath: args.candidateDecisionsPath,
        candidateDecisionsUsedFallbackTemplate: candidateDecisionsRead.usedFallback,
        reviewInputContractPath: contractRead.payload ? args.reviewInputContractPath : null,
        reviewInputContractSha256: contractRead.sha256,
        outputPath: args.outputPath,
        policy: {
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            readyForGoldMigrationRequiresAllPendingHumanConfirmed: true,
            readyForGoldMigrationRequiresGoldCandidatesHumanConfirmed: true
        },
        decisionSchemaGate,
        readyForGoldMigration,
        pendingTotal: pendingValidation.total,
        goldCandidateTotal: goldCandidateValidation.total,
        decisionTotal: pendingValidation.decisionTotal,
        candidateDecisionTotal: goldCandidateValidation.decisionTotal,
        unconfirmedCount,
        pendingUnconfirmedCount: pendingValidation.unconfirmedCount,
        goldCandidateUnconfirmedCount: goldCandidateValidation.unconfirmedCount,
        structuralErrorCount,
        pendingStructuralErrorCount: pendingValidation.structuralErrorCount,
        goldCandidateStructuralErrorCount: goldCandidateValidation.structuralErrorCount,
        readyDecisionCount: readyDecisions.length,
        pendingReadyDecisionCount: pendingValidation.readyDecisionCount,
        goldCandidateReadyDecisionCount: goldCandidateValidation.readyDecisionCount,
        verdictCounts: countBy(readyDecisions, (decision) => decision.humanVerdict),
        confidenceCounts: countBy(readyDecisions, (decision) => decision.humanConfidence),
        profileCounts: countBy(readyDecisions, (decision) => decision.profileLine),
        incompleteDecisions: [
            ...pendingValidation.incompleteDecisions.map((entry) => ({ sourceSet: 'visibleTopPending', ...entry })),
            ...goldCandidateValidation.incompleteDecisions.map((entry) => ({ sourceSet: 'metricPassVisible', ...entry }))
        ],
        structuralErrors: [
            ...reviewInputContractProblems.map((type) => ({ sourceSet: 'reviewInputContract', type })),
            ...pendingValidation.structuralErrors.map((entry) => ({ sourceSet: 'visibleTopPending', ...entry })),
            ...goldCandidateValidation.structuralErrors.map((entry) => ({ sourceSet: 'metricPassVisible', ...entry }))
        ],
        readyDecisions
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        readyForGoldMigration: report.readyForGoldMigration,
        pendingTotal: report.pendingTotal,
        goldCandidateTotal: report.goldCandidateTotal,
        decisionTotal: report.decisionTotal,
        candidateDecisionTotal: report.candidateDecisionTotal,
        unconfirmedCount: report.unconfirmedCount,
        structuralErrorCount: report.structuralErrorCount,
        readyDecisionCount: report.readyDecisionCount
    }, null, 2));

    if (report.structuralErrorCount > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
