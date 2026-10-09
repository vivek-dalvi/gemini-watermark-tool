import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_GOLD_PROPOSAL_PATH = path.resolve('.artifacts/visible-residual-crops/latest/gold-proposal.json');
const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/algorithm-admission-report.json');
const DEFAULT_GOLD_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/gold-manifest.json');
const PROPOSAL_INPUT_HASH_FIELDS = Object.freeze([
    {
        pathKey: 'alphaSweepPath',
        hashKey: 'alphaSweepSha256',
        reviewManifestHashKey: 'alphaSweepReviewManifestSha256',
        missingHashProblem: 'gold-proposal-alpha-sweep-hash-missing',
        missingReviewManifestHashProblem: 'gold-proposal-alpha-sweep-review-manifest-hash-missing',
        missingPathProblem: 'gold-proposal-alpha-sweep-path-missing',
        unreadableProblem: 'gold-proposal-alpha-sweep-unreadable',
        hashMismatchProblem: 'gold-proposal-alpha-sweep-hash-mismatch',
        reviewManifestHashMismatchProblem: 'gold-proposal-alpha-sweep-review-manifest-hash-mismatch'
    },
    {
        pathKey: 'profileReportPath',
        hashKey: 'profileReportSha256',
        reviewManifestHashKey: 'profileReportReviewManifestSha256',
        missingHashProblem: 'gold-proposal-profile-report-hash-missing',
        missingReviewManifestHashProblem: 'gold-proposal-profile-report-review-manifest-hash-missing',
        missingPathProblem: 'gold-proposal-profile-report-path-missing',
        unreadableProblem: 'gold-proposal-profile-report-unreadable',
        hashMismatchProblem: 'gold-proposal-profile-report-hash-mismatch',
        reviewManifestHashMismatchProblem: 'gold-proposal-profile-report-review-manifest-hash-mismatch'
    },
    {
        pathKey: 'profileGeneralizationPath',
        hashKey: 'profileGeneralizationSha256',
        reviewManifestHashKey: 'profileGeneralizationReviewManifestSha256',
        missingHashProblem: 'gold-proposal-profile-generalization-hash-missing',
        missingReviewManifestHashProblem: 'gold-proposal-profile-generalization-review-manifest-hash-missing',
        missingPathProblem: 'gold-proposal-profile-generalization-path-missing',
        unreadableProblem: 'gold-proposal-profile-generalization-unreadable',
        hashMismatchProblem: 'gold-proposal-profile-generalization-hash-mismatch',
        reviewManifestHashMismatchProblem: 'gold-proposal-profile-generalization-review-manifest-hash-mismatch'
    }
]);
const APPROVED_PRODUCTION_DECISIONS = new Set([
    'accept-production-wide-alpha-sweep',
    'accept-production-default-profile'
]);
const REQUIRED_PRODUCTION_CHANGE_GATE_MARKERS = Object.freeze([
    'human-confirmed-gold-manifest'
]);
const APPROVED_PRODUCTION_CHANGE_GATE_MARKERS_LIST = Object.freeze([
    'accepted-alpha-profile-decision',
    'accepted-alpha-gain-sweep-decision'
]);
const APPROVED_PRODUCTION_CHANGE_GATE_MARKERS = new Set(APPROVED_PRODUCTION_CHANGE_GATE_MARKERS_LIST);
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
const ALLOWED_FORMAL_VISIBLE_RESIDUAL_FIELD_KEYS = new Set([
    'allowVisibleResidual',
    'humanConfidence',
    'humanNotes',
    'maxGradientResidual',
    'maxPositiveHaloLum',
    'maxSpatialResidual',
    'metrics',
    'notes',
    'suggestedConfidence',
    'suggestedVerdict',
    'visibleResidualVerdict'
]);
const GOLD_SCHEMA_GATE_PROBLEM_CODES = Object.freeze([
    'gold-manifest-alpha-profile-variant-fields-present',
    'gold-manifest-unknown-visible-residual-field-present'
]);
const REQUIRED_DECISION_INPUT_ROOT_FIELDS = Object.freeze([
    'decisions',
    'instructions',
    'reviewManifestSha256',
    'schemaVersion'
]);
const REQUIRED_DECISION_FIELD_KEYS = Object.freeze([
    'clusterId',
    'cropPath',
    'file',
    'humanConfidence',
    'humanNotes',
    'humanVerdict',
    'sourceSet'
]);
const REQUIRED_DECISION_SCHEMA_GATE_PROBLEM_CODES = Object.freeze([
    'decision-input-alpha-profile-variant-fields-present',
    'decision-input-unknown-root-fields-present',
    'decision-alpha-profile-variant-fields-present',
    'decision-unknown-fields-present'
]);
const REQUIRED_DECISION_SCHEMA_GATE_FORBIDDEN_KEYS = Object.freeze([
    'alphagain',
    'profilevariant',
    'renderprofile'
]);

function parseArgs(argv) {
    const parsed = {
        goldProposalPath: DEFAULT_GOLD_PROPOSAL_PATH,
        validationPath: DEFAULT_VALIDATION_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        goldManifestPath: DEFAULT_GOLD_MANIFEST_PATH,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--proposal') {
            parsed.goldProposalPath = path.resolve(args.shift() || parsed.goldProposalPath);
            continue;
        }
        if (arg === '--validation') {
            parsed.validationPath = path.resolve(args.shift() || parsed.validationPath);
            continue;
        }
        if (arg === '--output') {
            parsed.outputPath = path.resolve(args.shift() || parsed.outputPath);
            continue;
        }
        if (arg === '--gold-manifest') {
            parsed.goldManifestPath = path.resolve(args.shift() || parsed.goldManifestPath);
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

async function assessProposalInputHashes(goldProposal) {
    const problems = [];
    const hashes = {};
    for (const {
        pathKey,
        hashKey,
        reviewManifestHashKey,
        missingHashProblem,
        missingReviewManifestHashProblem,
        missingPathProblem,
        unreadableProblem,
        hashMismatchProblem,
        reviewManifestHashMismatchProblem
    } of PROPOSAL_INPUT_HASH_FIELDS) {
        const inputPath = goldProposal.inputs?.[pathKey];
        const expectedHash = goldProposal.inputs?.[hashKey];
        const expectedReviewManifestHash = goldProposal.inputs?.[reviewManifestHashKey];
        if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
            problems.push(missingHashProblem);
        }
        if (typeof expectedReviewManifestHash !== 'string' || expectedReviewManifestHash.length === 0) {
            problems.push(missingReviewManifestHashProblem);
        }
        if (typeof inputPath !== 'string' || inputPath.length === 0) {
            problems.push(missingPathProblem);
            continue;
        }
        let actualHash = null;
        let payload = null;
        try {
            const inputText = stripBom(await readFile(inputPath, 'utf8'));
            actualHash = sha256Text(inputText);
            payload = JSON.parse(inputText);
        } catch {
            problems.push(unreadableProblem);
            continue;
        }
        hashes[hashKey] = actualHash;
        hashes[reviewManifestHashKey] = payload?.inputs?.reviewManifestSha256 ?? null;
        if (typeof expectedHash === 'string' && expectedHash.length > 0 && expectedHash !== actualHash) {
            problems.push(hashMismatchProblem);
        }
        if (
            typeof expectedReviewManifestHash === 'string' &&
            expectedReviewManifestHash.length > 0 &&
            (
                expectedReviewManifestHash !== payload?.inputs?.reviewManifestSha256 ||
                expectedReviewManifestHash !== goldProposal.inputs?.reviewManifestSha256
            )
        ) {
            problems.push(reviewManifestHashMismatchProblem);
        }
    }
    return {
        ok: problems.length === 0,
        problems,
        hashes
    };
}

function decisionSetByName(contract, name) {
    return (contract?.decisionSets ?? []).find((set) => set.name === name) ?? null;
}

function flattenProposalCandidates(goldProposal) {
    return [
        ...goldProposal.goldCandidates?.readyForHumanConfirmation ?? [],
        ...goldProposal.goldCandidates?.pendingHumanReview ?? []
    ];
}

function normalizeFieldKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectForbiddenAlphaProfileFieldPaths(value, prefix = '') {
    if (!value || typeof value !== 'object') {
        return [];
    }
    const out = [];
    for (const [key, child] of Object.entries(value)) {
        const pathKey = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(key))) {
            out.push(pathKey);
        }
        out.push(...collectForbiddenAlphaProfileFieldPaths(child, pathKey));
    }
    return out;
}

function collectUnknownTopLevelFieldPaths(value, allowedKeys, prefix = '') {
    if (!value || typeof value !== 'object') {
        return [];
    }
    return Object.keys(value)
        .filter((key) => !allowedKeys.has(key))
        .map((key) => (prefix ? `${prefix}.${key}` : key));
}

function includesAll(actual, expected) {
    return expected.every((value) => (actual ?? []).includes(value));
}

function hasForbiddenAlphaProfileKey(values) {
    return (values ?? []).some((value) => FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(String(value))));
}

function normalizeReasons(reasons) {
    return [...new Set(reasons ?? [])].sort((left, right) => left.localeCompare(right));
}

function clusterIdFor({ sourceSet, profileLine, visibleReasons }) {
    return `${sourceSet}::${profileLine}::${normalizeReasons(visibleReasons).join('+')}`;
}

function expectedProposalCandidatesFromManifest(reviewManifest) {
    const out = [];
    for (const sourceSet of ['metricPassVisible', 'visibleTopPending']) {
        for (const record of reviewManifest.groups?.[sourceSet] ?? []) {
            const profileLine = record.review?.profileLine ?? 'unknown';
            const visibleReasons = record.metrics?.visibleReasons ?? [];
            out.push({
                file: record.file,
                sourceSet,
                clusterId: clusterIdFor({ sourceSet, profileLine, visibleReasons })
            });
        }
    }
    return out;
}

async function assessProposalCandidateProvenance(goldProposal) {
    const problems = [];
    const hashes = {};
    const candidates = flattenProposalCandidates(goldProposal);
    if (candidates.some((candidate) => typeof candidate.sourceSet !== 'string' || candidate.sourceSet.length === 0)) {
        problems.push('gold-proposal-candidate-sourceSet-missing');
    }
    if (candidates.some((candidate) => typeof candidate.clusterId !== 'string' || candidate.clusterId.length === 0)) {
        problems.push('gold-proposal-candidate-clusterId-missing');
    }
    const reviewManifestPath = goldProposal.inputs?.reviewManifestPath;
    const expectedReviewManifestSha256 = goldProposal.inputs?.reviewManifestSha256;
    if (typeof expectedReviewManifestSha256 !== 'string' || expectedReviewManifestSha256.length === 0) {
        problems.push('gold-proposal-review-manifest-hash-missing');
    }
    if (typeof reviewManifestPath !== 'string' || reviewManifestPath.length === 0) {
        problems.push('gold-proposal-review-manifest-path-missing');
        return {
            ok: problems.length === 0,
            problems,
            candidateCount: candidates.length,
            hashes
        };
    }

    let expectedCandidates = [];
    try {
        const reviewManifestText = stripBom(await readFile(reviewManifestPath, 'utf8'));
        hashes.reviewManifestSha256 = sha256Text(reviewManifestText);
        const reviewManifest = JSON.parse(reviewManifestText);
        expectedCandidates = expectedProposalCandidatesFromManifest(reviewManifest);
    } catch {
        problems.push('gold-proposal-review-manifest-unreadable');
    }
    if (
        typeof expectedReviewManifestSha256 === 'string' &&
        expectedReviewManifestSha256.length > 0 &&
        hashes.reviewManifestSha256 !== expectedReviewManifestSha256
    ) {
        problems.push('gold-proposal-review-manifest-hash-mismatch');
    }
    if (expectedCandidates.length !== candidates.length) {
        problems.push('gold-proposal-candidate-count-mismatch');
    }
    const candidatesByFile = new Map(candidates.map((candidate) => [candidate.file, candidate]));
    for (const expected of expectedCandidates) {
        const actual = candidatesByFile.get(expected.file);
        if (!actual) {
            problems.push('gold-proposal-candidate-missing-review-manifest-file');
            break;
        }
        if (actual.sourceSet !== expected.sourceSet) {
            problems.push('gold-proposal-candidate-sourceSet-mismatch');
            break;
        }
        if (actual.clusterId !== expected.clusterId) {
            problems.push('gold-proposal-candidate-clusterId-mismatch');
            break;
        }
    }
    return {
        ok: problems.length === 0,
        problems,
        candidateCount: candidates.length,
        expectedCandidateCount: expectedCandidates.length,
        hashes
    };
}

async function assessValidationInputContract(validation) {
    const problems = [];
    const hashes = {};
    const contractPath = validation.reviewInputContractPath;
    const expectedHash = validation.reviewInputContractSha256;
    if (typeof expectedHash !== 'string' || expectedHash.length === 0) {
        problems.push('validation-review-input-contract-hash-missing');
    }
    if (typeof contractPath !== 'string' || contractPath.length === 0) {
        problems.push('validation-review-input-contract-path-missing');
        return {
            ok: false,
            problems,
            hashes
        };
    }

    let contract = null;
    try {
        const contractText = stripBom(await readFile(contractPath, 'utf8'));
        hashes.reviewInputContractSha256 = sha256Text(contractText);
        contract = JSON.parse(contractText);
    } catch {
        problems.push('validation-review-input-contract-unreadable');
        return {
            ok: false,
            problems,
            hashes
        };
    }

    hashes.reviewInputContractReviewManifestSha256 = contract?.reviewManifestSha256 ?? null;
    if (typeof expectedHash === 'string' && expectedHash.length > 0 && expectedHash !== hashes.reviewInputContractSha256) {
        problems.push('validation-review-input-contract-hash-mismatch');
    }
    if (contract?.reviewManifestSha256 !== validation.reviewManifestSha256) {
        problems.push('validation-review-input-contract-manifest-hash-mismatch');
    }
    if (!includesAll(contract?.allowedDecisionInputRootFields, REQUIRED_DECISION_INPUT_ROOT_FIELDS)) {
        problems.push('validation-review-input-contract-root-fields-missing');
    }
    if (!includesAll(contract?.allowedDecisionFields, REQUIRED_DECISION_FIELD_KEYS)) {
        problems.push('validation-review-input-contract-decision-fields-missing');
    }
    if (hasForbiddenAlphaProfileKey(contract?.allowedDecisionFields)) {
        problems.push('validation-review-input-contract-allows-alpha-profile-decision-fields');
    }
    if (hasForbiddenAlphaProfileKey(contract?.allowedDecisionInputRootFields)) {
        problems.push('validation-review-input-contract-allows-alpha-profile-root-fields');
    }
    if (!includesAll(contract?.forbiddenAlphaProfileFieldKeys, REQUIRED_DECISION_SCHEMA_GATE_FORBIDDEN_KEYS)) {
        problems.push('validation-review-input-contract-forbidden-alpha-profile-fields-missing');
    }

    const pendingSet = decisionSetByName(contract, 'visibleTopPending');
    const candidateSet = decisionSetByName(contract, 'metricPassVisible');
    if (!pendingSet) {
        problems.push('validation-review-input-contract-missing-visibleTopPending-set');
    } else {
        if (pendingSet.expectedCount !== validation.pendingTotal) {
            problems.push('validation-review-input-contract-visibleTopPending-count-mismatch');
        }
        if (path.resolve(pendingSet.inputPath ?? '') !== path.resolve(validation.decisionsPath ?? '')) {
            problems.push('validation-review-input-contract-visibleTopPending-input-path-mismatch');
        }
    }
    if (!candidateSet) {
        problems.push('validation-review-input-contract-missing-metricPassVisible-set');
    } else {
        if (candidateSet.expectedCount !== validation.goldCandidateTotal) {
            problems.push('validation-review-input-contract-metricPassVisible-count-mismatch');
        }
        if (path.resolve(candidateSet.inputPath ?? '') !== path.resolve(validation.candidateDecisionsPath ?? '')) {
            problems.push('validation-review-input-contract-metricPassVisible-input-path-mismatch');
        }
    }

    return {
        ok: problems.length === 0,
        problems,
        hashes
    };
}

function assessValidationDecisionSchemaGate(validation) {
    const gate = validation.decisionSchemaGate;
    const problems = [];
    if (!gate || typeof gate !== 'object') {
        return {
            ok: false,
            problems: ['validation-decision-schema-gate-missing'],
            gate: null
        };
    }
    if (
        gate.armed !== true ||
        gate.appliesToHumanReviewDecisionInputs !== true ||
        gate.rejectsAlphaProfileVariantFields !== true ||
        gate.rejectsUnknownDecisionFields !== true ||
        gate.rejectsUnknownDecisionInputRootFields !== true
    ) {
        problems.push('validation-decision-schema-gate-incomplete');
    }
    if (!includesAll(gate.allowedDecisionInputRootFields, REQUIRED_DECISION_INPUT_ROOT_FIELDS)) {
        problems.push('validation-decision-schema-gate-root-fields-missing');
    }
    if (!includesAll(gate.failClosedProblemCodes, REQUIRED_DECISION_SCHEMA_GATE_PROBLEM_CODES)) {
        problems.push('validation-decision-schema-gate-problem-codes-missing');
    }
    if (!includesAll(gate.forbiddenAlphaProfileFieldKeys, REQUIRED_DECISION_SCHEMA_GATE_FORBIDDEN_KEYS)) {
        problems.push('validation-decision-schema-gate-forbidden-fields-missing');
    }
    if (gate.ok !== true) {
        problems.push('validation-decision-schema-gate-not-ready');
    }
    return {
        ok: problems.length === 0,
        problems,
        gate
    };
}

function assessProposalValidationCoverage({ goldProposal, validation, proposalCandidateProvenance }) {
    const expectedTotal = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    const problems = [];
    if (proposalCandidateProvenance.candidateCount !== expectedTotal) {
        problems.push('gold-proposal-candidate-count-validation-mismatch');
    }
    if (proposalCandidateProvenance.expectedCandidateCount !== expectedTotal) {
        problems.push('gold-proposal-review-manifest-candidate-count-validation-mismatch');
    }
    if (goldProposal.summary?.readyForHumanConfirmation !== (validation.goldCandidateTotal ?? 0)) {
        problems.push('gold-proposal-ready-count-validation-mismatch');
    }
    if (goldProposal.summary?.pendingHumanReview !== (validation.pendingTotal ?? 0)) {
        problems.push('gold-proposal-pending-count-validation-mismatch');
    }
    return {
        ok: problems.length === 0,
        problems,
        expectedTotal,
        candidateCount: proposalCandidateProvenance.candidateCount ?? null,
        expectedCandidateCount: proposalCandidateProvenance.expectedCandidateCount ?? null,
        readyForHumanConfirmation: goldProposal.summary?.readyForHumanConfirmation ?? null,
        pendingHumanReview: goldProposal.summary?.pendingHumanReview ?? null
    };
}

function assessValidationReadinessIntegrity(validation) {
    const expectedTotal = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    const readyDecisions = validation.readyDecisions ?? [];
    const problems = [];
    if (validation.readyForGoldMigration === true) {
        if ((validation.unconfirmedCount ?? 0) !== 0) {
            problems.push('validation-ready-unconfirmed-decisions-present');
        }
        if ((validation.structuralErrorCount ?? 0) !== 0) {
            problems.push('validation-ready-structural-errors-present');
        }
        if ((validation.readyDecisionCount ?? 0) !== expectedTotal) {
            problems.push('validation-ready-decision-count-does-not-cover-review-set');
        }
        if ((validation.readyDecisionCount ?? 0) !== readyDecisions.length) {
            problems.push('validation-ready-decision-count-mismatch');
        }
        if (expectedTotal > 0 && readyDecisions.length === 0) {
            problems.push('validation-ready-decisions-empty');
        }
    }
    return {
        ok: problems.length === 0,
        problems,
        readyForGoldMigration: validation.readyForGoldMigration === true,
        expectedTotal,
        readyDecisionCount: validation.readyDecisionCount ?? 0,
        readyDecisionsLength: readyDecisions.length,
        unconfirmedCount: validation.unconfirmedCount ?? 0,
        structuralErrorCount: validation.structuralErrorCount ?? 0
    };
}

function assessAlgorithmAdmissionIntegrity(goldProposal) {
    const admission = goldProposal.algorithmAdmission ?? {};
    const alphaGainSweepDecision = admission.alphaGainSweep?.decision ?? 'unknown';
    const alphaProfileDecision = admission.alphaProfileMidBoost124?.decision ?? 'unknown';
    const decisions = [alphaGainSweepDecision, alphaProfileDecision];
    const productionChangeAllowed = admission.productionChangeAllowed === true;
    const productionChangeGate = Array.isArray(admission.productionChangeGate)
        ? admission.productionChangeGate
        : [];
    const hasHumanConfirmedGoldManifestGate = productionChangeGate.includes('human-confirmed-gold-manifest');
    const hasApprovedProductionDecisionGate = productionChangeGate.some((marker) => (
        APPROVED_PRODUCTION_CHANGE_GATE_MARKERS.has(marker)
    ));
    const problems = [];

    if (productionChangeAllowed) {
        if (decisions.some((decision) => decision.startsWith('reject-production'))) {
            problems.push('algorithm-admission-rejected-production-decision-present');
        }
        if (!decisions.some((decision) => APPROVED_PRODUCTION_DECISIONS.has(decision))) {
            problems.push('algorithm-admission-no-approved-production-decision');
        }
        if (productionChangeGate.length === 0) {
            problems.push('algorithm-admission-production-change-gate-missing');
        }
        if (!hasHumanConfirmedGoldManifestGate) {
            problems.push('algorithm-admission-human-confirmed-gold-gate-missing');
        }
        if (!hasApprovedProductionDecisionGate) {
            problems.push('algorithm-admission-approved-decision-gate-missing');
        }
    }

    return {
        ok: problems.length === 0,
        problems,
        productionChangeAllowed,
        productionChangeGate,
        requiredProductionChangeGateMarkers: REQUIRED_PRODUCTION_CHANGE_GATE_MARKERS,
        approvedProductionChangeGateMarkers: APPROVED_PRODUCTION_CHANGE_GATE_MARKERS_LIST,
        hasHumanConfirmedGoldManifestGate,
        hasApprovedProductionDecisionGate,
        alphaGainSweepDecision,
        alphaProfileDecision,
        approvedProductionDecisionCount: decisions.filter((decision) => (
            APPROVED_PRODUCTION_DECISIONS.has(decision)
        )).length
    };
}

async function assessGoldManifestIntegrity({
    goldManifestPath,
    goldManifestExists,
    validation,
    reviewManifestSha256,
    goldProposalSha256,
    validationReportSha256,
    proposalInputIntegrity,
    validationInputContractIntegrity
}) {
    if (!goldManifestExists) {
        return {
            ok: validation.readyForGoldMigration !== true,
            required: validation.readyForGoldMigration === true,
            exists: false,
            problems: validation.readyForGoldMigration === true ? ['gold-manifest-missing'] : []
        };
    }

    const problems = [];
    let goldManifest = null;
    try {
        goldManifest = JSON.parse(stripBom(await readFile(goldManifestPath, 'utf8')));
    } catch {
        return {
            ok: false,
            required: true,
            exists: true,
            problems: ['gold-manifest-unreadable']
        };
    }

    if (goldManifest.policy?.generatedOnlyAfterHumanConfirmation !== true) {
        problems.push('gold-manifest-policy-not-human-confirmed');
    }
    if (goldManifest.policy?.writesProductionAlgorithm !== false) {
        problems.push('gold-manifest-policy-writes-production');
    }
    if (goldManifest.policy?.containsAlphaProfileVariants !== false) {
        problems.push('gold-manifest-policy-allows-alpha-profile-variants');
    }
    if (goldManifest.inputs?.validationReportSha256 !== validationReportSha256) {
        problems.push('gold-manifest-validation-hash-mismatch');
    }
    if (goldManifest.inputs?.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('gold-manifest-review-manifest-hash-mismatch');
    }
    if (goldManifest.inputs?.goldProposalSha256 !== goldProposalSha256) {
        problems.push('gold-manifest-proposal-hash-mismatch');
    }
    if (
        goldManifest.inputs?.reviewInputContractSha256 !==
        validationInputContractIntegrity.hashes.reviewInputContractSha256
    ) {
        problems.push('gold-manifest-review-input-contract-hash-mismatch');
    }
    for (const { hashKey, reviewManifestHashKey, hashMismatchProblem, reviewManifestHashMismatchProblem } of PROPOSAL_INPUT_HASH_FIELDS) {
        if (goldManifest.inputs?.[hashKey] !== proposalInputIntegrity.hashes[hashKey]) {
            problems.push(hashMismatchProblem.replace('gold-proposal-', 'gold-manifest-'));
        }
        if (goldManifest.inputs?.[reviewManifestHashKey] !== proposalInputIntegrity.hashes[reviewManifestHashKey]) {
            problems.push(reviewManifestHashMismatchProblem.replace('gold-proposal-', 'gold-manifest-'));
        }
    }

    const readyDecisions = validation.readyDecisions ?? [];
    const samples = Array.isArray(goldManifest.samples)
        ? Object.fromEntries(goldManifest.samples.map((sample) => [sample.file, sample]))
        : (goldManifest.samples ?? {});
    const sampleFiles = Object.keys(samples);
    const readyFiles = readyDecisions.map((decision) => decision.file);
    if (goldManifest.summary?.total !== readyDecisions.length || sampleFiles.length !== readyDecisions.length) {
        problems.push('gold-manifest-sample-count-mismatch');
    }
    for (const decision of readyDecisions) {
        if (!samples[decision.file]) {
            problems.push('gold-manifest-missing-ready-sample');
            break;
        }
        if (samples[decision.file]?.sourceSet !== decision.sourceSet) {
            problems.push('gold-manifest-sourceSet-mismatch');
            break;
        }
        if (samples[decision.file]?.clusterId !== decision.clusterId) {
            problems.push('gold-manifest-cluster-id-mismatch');
            break;
        }
    }
    if (sampleFiles.some((file) => !readyFiles.includes(file))) {
        problems.push('gold-manifest-extra-sample');
    }
    const forbiddenVariantFieldPaths = Object.entries(samples).flatMap(([file, sample]) => (
        collectForbiddenAlphaProfileFieldPaths(sample.visibleResidual, file)
    ));
    if (forbiddenVariantFieldPaths.length > 0) {
        problems.push('gold-manifest-alpha-profile-variant-fields-present');
    }
    const unknownVisibleResidualFieldPaths = Object.entries(samples).flatMap(([file, sample]) => (
        collectUnknownTopLevelFieldPaths(
            sample.visibleResidual,
            ALLOWED_FORMAL_VISIBLE_RESIDUAL_FIELD_KEYS,
            file
        )
    ));
    if (unknownVisibleResidualFieldPaths.length > 0) {
        problems.push('gold-manifest-unknown-visible-residual-field-present');
    }

    return {
        ok: problems.length === 0,
        required: validation.readyForGoldMigration === true,
        exists: true,
        problems,
        forbiddenAlphaProfileFieldPaths: forbiddenVariantFieldPaths,
        unknownVisibleResidualFieldPaths,
        sampleCount: sampleFiles.length,
        readyDecisionCount: readyDecisions.length
    };
}

function buildBlockedReasons({
    goldProposal,
    validation,
    goldManifestExists,
    proposalInputIntegrity,
    validationInputContractIntegrity,
    proposalCandidateProvenance,
    proposalValidationCoverage,
    validationReadinessIntegrity,
    validationDecisionSchemaGateIntegrity,
    goldManifestIntegrity,
    algorithmAdmissionIntegrity
}) {
    const reasons = [];
    if (validation.readyForGoldMigration !== true) {
        reasons.push('human-review-not-ready-for-gold-migration');
    }
    if ((validation.unconfirmedCount ?? 0) > 0) {
        reasons.push('human-review-unconfirmed-decisions');
    }
    if ((validation.structuralErrorCount ?? 0) > 0) {
        reasons.push('human-review-structural-errors');
    }
    if (goldProposal.algorithmAdmission?.productionChangeAllowed !== true) {
        reasons.push('algorithm-admission-production-change-blocked');
    }
    if (proposalInputIntegrity.ok !== true) {
        reasons.push('algorithm-admission-stale-proposal-inputs');
    }
    if (validationInputContractIntegrity.ok !== true) {
        reasons.push('human-review-stale-input-contract');
    }
    if (proposalCandidateProvenance.ok !== true) {
        reasons.push('gold-proposal-candidate-provenance-incomplete');
    }
    if (proposalValidationCoverage.ok !== true) {
        reasons.push('gold-proposal-candidates-do-not-cover-validation-set');
    }
    if (validationReadinessIntegrity.ok !== true) {
        reasons.push('human-review-readiness-integrity-incomplete');
    }
    if (validationDecisionSchemaGateIntegrity.ok !== true) {
        reasons.push('human-review-decision-schema-gate-incomplete');
    }
    if (validation.readyForGoldMigration === true && !goldManifestExists && reasons.length === 0) {
        reasons.push('formal-gold-manifest-missing');
    }
    if (
        validation.readyForGoldMigration === true &&
        goldManifestExists &&
        goldManifestIntegrity.ok !== true &&
        reasons.length === 0
    ) {
        reasons.push('formal-gold-manifest-integrity-incomplete');
    }
    if (goldManifestExists && validation.readyForGoldMigration !== true) {
        reasons.push('gold-manifest-exists-before-human-gate');
    }
    if (
        validation.readyForGoldMigration === true &&
        goldManifestExists &&
        goldManifestIntegrity.ok === true &&
        algorithmAdmissionIntegrity.ok !== true &&
        reasons.length === 0
    ) {
        reasons.push('algorithm-admission-production-decision-incomplete');
    }
    return reasons;
}

function buildGoldSchemaGate(goldManifestIntegrity) {
    const forbiddenAlphaProfileFieldPaths = goldManifestIntegrity.forbiddenAlphaProfileFieldPaths ?? [];
    const unknownVisibleResidualFieldPaths = goldManifestIntegrity.unknownVisibleResidualFieldPaths ?? [];
    return {
        armed: true,
        appliesToFormalGoldManifest: true,
        rejectsAlphaProfileVariantFields: true,
        rejectsUnknownFormalVisibleResidualFields: true,
        allowedFormalVisibleResidualFields: [...ALLOWED_FORMAL_VISIBLE_RESIDUAL_FIELD_KEYS].sort(),
        forbiddenAlphaProfileFieldKeys: [...FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS].sort(),
        failClosedProblemCodes: GOLD_SCHEMA_GATE_PROBLEM_CODES,
        forbiddenAlphaProfileFieldPaths,
        unknownVisibleResidualFieldPaths,
        ok: forbiddenAlphaProfileFieldPaths.length === 0 && unknownVisibleResidualFieldPaths.length === 0
    };
}

function buildReport({
    goldProposal,
    validation,
    paths,
    goldManifestExists,
    goldProposalSha256,
    validationReportSha256,
    proposalInputIntegrity,
    validationInputContractIntegrity,
    proposalCandidateProvenance,
    proposalValidationCoverage,
    validationReadinessIntegrity,
    validationDecisionSchemaGateIntegrity,
    goldManifestIntegrity,
    algorithmAdmissionIntegrity
}) {
    const blockedReasons = buildBlockedReasons({
        goldProposal,
        validation,
        goldManifestExists,
        proposalInputIntegrity,
        validationInputContractIntegrity,
        proposalCandidateProvenance,
        proposalValidationCoverage,
        validationReadinessIntegrity,
        validationDecisionSchemaGateIntegrity,
        goldManifestIntegrity,
        algorithmAdmissionIntegrity
    });
    const productionProfileAllowed = validation.readyForGoldMigration === true &&
        goldProposal.algorithmAdmission?.productionChangeAllowed === true &&
        blockedReasons.length === 0;
    const goldSchemaGate = buildGoldSchemaGate(goldManifestIntegrity);

    return {
        generatedAt: new Date().toISOString(),
        inputs: {
            goldProposalPath: paths.goldProposalPath,
            goldProposalSha256,
            validationPath: paths.validationPath,
            validationReportSha256,
            reviewInputContractPath: validation.reviewInputContractPath ?? null,
            reviewInputContractSha256: validationInputContractIntegrity.hashes.reviewInputContractSha256 ?? null,
            goldManifestPath: paths.goldManifestPath
        },
        policy: {
            reportOnly: true,
            writesFormalGoldManifest: false,
            writesProductionAlgorithm: false,
            requiresHumanConfirmationBeforeGoldMigration: true,
            requiresHumanConfirmationBeforeProductionProfile: true
        },
        humanGate: {
            readyForGoldMigration: validation.readyForGoldMigration === true,
            pendingTotal: validation.pendingTotal ?? 0,
            goldCandidateTotal: validation.goldCandidateTotal ?? 0,
            unconfirmedCount: validation.unconfirmedCount ?? 0,
            structuralErrorCount: validation.structuralErrorCount ?? 0,
            readyDecisionCount: validation.readyDecisionCount ?? 0
        },
        goldManifestGate: {
            outputPath: paths.goldManifestPath,
            exists: goldManifestExists,
            integrityReady: goldManifestIntegrity.ok === true,
            writeAllowed: validation.readyForGoldMigration === true,
            blockedBeforeHumanConfirmation: validation.readyForGoldMigration !== true
        },
        algorithmAdmission: goldProposal.algorithmAdmission ?? null,
        proposalInputIntegrity,
        validationInputContractIntegrity,
        validationReadinessIntegrity,
        validationDecisionSchemaGateIntegrity,
        proposalCandidateProvenance,
        proposalValidationCoverage,
        goldSchemaGate,
        goldManifestIntegrity,
        algorithmAdmissionIntegrity,
        productionProfileAdmission: {
            allowed: productionProfileAllowed,
            blockedReasons,
            alphaGainSweepDecision: goldProposal.algorithmAdmission?.alphaGainSweep?.decision ?? 'unknown',
            alphaProfileDecision: goldProposal.algorithmAdmission?.alphaProfileMidBoost124?.decision ?? 'unknown',
            productionChangeAllowed: goldProposal.algorithmAdmission?.productionChangeAllowed === true
        },
        summary: {
            readyForHumanConfirmation: goldProposal.summary?.readyForHumanConfirmation ?? 0,
            pendingHumanReview: goldProposal.summary?.pendingHumanReview ?? 0,
            totalReviewDecisions: (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0),
            currentState: productionProfileAllowed ? 'ready-for-production-review' : 'human-gated-blocked'
        }
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const loopRunStatePath = path.join(path.dirname(args.outputPath), 'loop-run-state.json');
    const activeLoopRunState = await readActiveLoopRunState(loopRunStatePath);
    if (activeLoopRunState && !args.allowActiveLoopState) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath,
            skippedWrite: true,
            problems: ['active-visible-residual-loop'],
            loopRunStatePath,
            activeLoopRunState,
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:admission-report.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const goldProposalText = stripBom(await readFile(args.goldProposalPath, 'utf8'));
    const validationText = stripBom(await readFile(args.validationPath, 'utf8'));
    const goldProposal = JSON.parse(goldProposalText);
    const validation = JSON.parse(validationText);
    const goldManifestExists = existsSync(args.goldManifestPath);
    const proposalInputIntegrity = await assessProposalInputHashes(goldProposal);
    const validationInputContractIntegrity = await assessValidationInputContract(validation);
    const proposalCandidateProvenance = await assessProposalCandidateProvenance(goldProposal);
    const proposalValidationCoverage = assessProposalValidationCoverage({
        goldProposal,
        validation,
        proposalCandidateProvenance
    });
    const validationReadinessIntegrity = assessValidationReadinessIntegrity(validation);
    const validationDecisionSchemaGateIntegrity = assessValidationDecisionSchemaGate(validation);
    const algorithmAdmissionIntegrity = assessAlgorithmAdmissionIntegrity(goldProposal);
    const goldManifestIntegrity = await assessGoldManifestIntegrity({
        goldManifestPath: args.goldManifestPath,
        goldManifestExists,
        validation,
        reviewManifestSha256: proposalCandidateProvenance.hashes.reviewManifestSha256 ?? goldProposal.inputs?.reviewManifestSha256,
        goldProposalSha256: sha256Text(goldProposalText),
        validationReportSha256: sha256Text(validationText),
        proposalInputIntegrity,
        validationInputContractIntegrity
    });
    const report = buildReport({
        goldProposal,
        validation,
        paths: args,
        goldManifestExists,
        goldProposalSha256: sha256Text(goldProposalText),
        validationReportSha256: sha256Text(validationText),
        proposalInputIntegrity,
        validationInputContractIntegrity,
        proposalCandidateProvenance,
        proposalValidationCoverage,
        validationReadinessIntegrity,
        validationDecisionSchemaGateIntegrity,
        goldManifestIntegrity,
        algorithmAdmissionIntegrity
    });

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        outputPath: args.outputPath,
        humanGate: report.humanGate,
        productionProfileAdmission: report.productionProfileAdmission,
        currentState: report.summary.currentState
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
