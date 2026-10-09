import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_VALIDATION_PATH = path.resolve('.artifacts/visible-residual-crops/latest/human-review-pack/validation-report.json');
const DEFAULT_GOLD_PROPOSAL_PATH = path.resolve('.artifacts/visible-residual-crops/latest/gold-proposal.json');
const DEFAULT_REVIEW_MANIFEST_PATH = path.resolve('.artifacts/visible-residual-crops/latest/review-manifest.json');
const DEFAULT_OUTPUT_PATH = path.resolve('.artifacts/visible-residual-crops/latest/gold-manifest.json');
const ALLOW_VISIBLE_RESIDUAL_VERDICTS = Object.freeze([
    'backgroundStructure',
    'contentCollision',
    'acceptableResidual'
]);
const BLOCK_VISIBLE_RESIDUAL_VERDICTS = Object.freeze([
    'trueVisibleResidual',
    'needsModelInvestigation'
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
const ALLOWED_PROPOSED_GOLD_FIELD_KEYS = new Set([
    'allowVisibleResidual',
    'maxGradientResidual',
    'maxPositiveHaloLum',
    'maxSpatialResidual',
    'notes',
    'visibleResidualVerdict'
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

function parseArgs(argv) {
    const parsed = {
        validationPath: DEFAULT_VALIDATION_PATH,
        goldProposalPath: DEFAULT_GOLD_PROPOSAL_PATH,
        reviewManifestPath: DEFAULT_REVIEW_MANIFEST_PATH,
        outputPath: DEFAULT_OUTPUT_PATH,
        allowActiveLoopState: false
    };

    const args = [...argv];
    while (args.length > 0) {
        const arg = args.shift();
        if (arg === '--validation') {
            parsed.validationPath = path.resolve(args.shift() || parsed.validationPath);
            continue;
        }
        if (arg === '--proposal') {
            parsed.goldProposalPath = path.resolve(args.shift() || parsed.goldProposalPath);
            continue;
        }
        if (arg === '--manifest') {
            parsed.reviewManifestPath = path.resolve(args.shift() || parsed.reviewManifestPath);
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

async function readJson(filePath) {
    return JSON.parse(stripBom(await readFile(filePath, 'utf8')));
}

async function readActiveLoopRunState(statePath) {
    if (!existsSync(statePath)) return null;
    try {
        const state = await readJson(statePath);
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

function round(value, digits = 3) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
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

async function assessProposalInputHashes(proposal) {
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
        const inputPath = proposal.inputs?.[pathKey];
        const expectedHash = proposal.inputs?.[hashKey];
        const expectedReviewManifestHash = proposal.inputs?.[reviewManifestHashKey];
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
                expectedReviewManifestHash !== proposal.inputs?.reviewManifestSha256
            )
        ) {
            problems.push(reviewManifestHashMismatchProblem);
        }
    }
    return { problems, hashes };
}

function decisionSetByName(contract, name) {
    return (contract?.decisionSets ?? []).find((set) => set.name === name) ?? null;
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

function includesAll(actual, expected) {
    return expected.every((value) => (actual ?? []).includes(value));
}

function hasForbiddenAlphaProfileKey(values) {
    return (values ?? []).some((value) => FORBIDDEN_ALPHA_PROFILE_FIELD_KEYS.has(normalizeFieldKey(String(value))));
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
        return { problems, hashes };
    }

    let contract = null;
    try {
        const contractText = stripBom(await readFile(contractPath, 'utf8'));
        hashes.reviewInputContractSha256 = sha256Text(contractText);
        contract = JSON.parse(contractText);
    } catch {
        problems.push('validation-review-input-contract-unreadable');
        return { problems, hashes };
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

    return { problems, hashes };
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

function assertMigrationAllowed({
    validation,
    proposal,
    reviewManifest,
    reviewManifestSha256,
    proposalInputIntegrity,
    validationInputContractIntegrity,
    validationDecisionSchemaGateIntegrity
}) {
    const problems = [];
    const readyDecisions = validation.readyDecisions ?? [];
    const readyFiles = (validation.readyDecisions ?? []).map((decision) => decision.file);
    const proposalCandidates = flattenProposalCandidates(proposal);
    const proposalFiles = proposalCandidates.map((candidate) => candidate.file);
    const proposalByFile = new Map(proposalCandidates.map((candidate) => [candidate.file, candidate]));
    const forbiddenVariantFieldPaths = proposalCandidates.flatMap((candidate) => (
        collectForbiddenAlphaProfileFieldPaths(candidate.proposedGoldFields, candidate.file)
    ));
    const unknownGoldFieldPaths = proposalCandidates.flatMap((candidate) => (
        collectUnknownTopLevelFieldPaths(candidate.proposedGoldFields, ALLOWED_PROPOSED_GOLD_FIELD_KEYS, candidate.file)
    ));
    const expectedProposalCandidates = expectedProposalCandidatesFromManifest(reviewManifest);
    const expectedProposalByFile = new Map(expectedProposalCandidates.map((candidate) => [candidate.file, candidate]));
    const expectedReadyDecisionCount = (validation.pendingTotal ?? 0) + (validation.goldCandidateTotal ?? 0);
    if (validation.readyForGoldMigration !== true) {
        problems.push('validation-report-not-ready-for-gold-migration');
    }
    if (validation.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('validation-review-manifest-hash-mismatch');
    }
    if (proposal.inputs?.reviewManifestSha256 !== reviewManifestSha256) {
        problems.push('gold-proposal-review-manifest-hash-mismatch');
    }
    problems.push(...proposalInputIntegrity.problems);
    problems.push(...validationInputContractIntegrity.problems);
    problems.push(...validationDecisionSchemaGateIntegrity.problems);
    if (validation.readyForGoldMigration === true && validation.structuralErrorCount !== 0) {
        problems.push('validation-structural-errors-present');
    }
    if (validation.readyForGoldMigration === true && validation.unconfirmedCount !== 0) {
        problems.push('validation-unconfirmed-decisions-present');
    }
    if (
        validation.readyForGoldMigration === true &&
        validation.readyDecisionCount !== readyDecisions.length
    ) {
        problems.push('validation-ready-decision-count-mismatch');
    }
    if (
        validation.readyForGoldMigration === true &&
        readyDecisions.length !== expectedReadyDecisionCount
    ) {
        problems.push('validation-ready-decisions-do-not-cover-review-set');
    }
    if (validation.policy?.writesFormalGoldManifest !== false) {
        problems.push('validation-policy-must-remain-read-only');
    }
    if (validation.policy?.writesProductionAlgorithm !== false) {
        problems.push('validation-policy-must-not-write-production-algorithm');
    }
    if (proposal.policy?.writesFormalGoldManifest !== false) {
        problems.push('gold-proposal-policy-must-remain-proposal-only');
    }
    if (proposal.policy?.writesProductionAlgorithm !== false) {
        problems.push('gold-proposal-policy-must-not-write-production-algorithm');
    }
    if (proposal.policy?.requiresHumanConfirmationBeforeGoldMigration !== true) {
        problems.push('gold-proposal-must-require-human-confirmation');
    }
    if (
        proposal.proposedGoldSchemaGate?.armed !== true ||
        proposal.proposedGoldSchemaGate?.appliesToProposedGoldFields !== true ||
        proposal.proposedGoldSchemaGate?.rejectsAlphaProfileVariantFields !== true ||
        proposal.proposedGoldSchemaGate?.rejectsUnknownProposedGoldFields !== true ||
        !Array.isArray(proposal.proposedGoldSchemaGate?.failClosedProblemCodes)
    ) {
        problems.push('gold-proposal-schema-gate-missing');
    }
    if (proposal.proposedGoldSchemaGate?.ok !== true) {
        problems.push('gold-proposal-schema-gate-not-ready');
    }
    if (proposal.algorithmAdmission?.productionChangeAllowed !== false) {
        problems.push('algorithm-admission-must-block-production-change');
    }
    if ((validation.readyDecisions ?? []).length === 0) {
        problems.push('validation-ready-decisions-empty');
    }
    if ((validation.readyDecisions ?? []).some((decision) => (
        typeof decision.clusterId !== 'string' || decision.clusterId.length === 0
    ))) {
        problems.push('validation-ready-decisions-missing-cluster-id');
    }
    if (new Set(readyFiles).size !== readyFiles.length) {
        problems.push('validation-ready-decisions-duplicate-files');
    }
    if (new Set(proposalFiles).size !== proposalFiles.length) {
        problems.push('gold-proposal-duplicate-candidate-files');
    }
    if ((validation.readyDecisions ?? []).some((decision) => !proposalByFile.has(decision.file))) {
        problems.push('validation-ready-decisions-missing-gold-proposal-candidate');
    }
    if (proposalCandidates.some((candidate) => typeof candidate.sourceSet !== 'string' || candidate.sourceSet.length === 0)) {
        problems.push('gold-proposal-candidate-sourceSet-missing');
    }
    if (proposalCandidates.some((candidate) => typeof candidate.clusterId !== 'string' || candidate.clusterId.length === 0)) {
        problems.push('gold-proposal-candidate-clusterId-missing');
    }
    if (forbiddenVariantFieldPaths.length > 0) {
        problems.push('gold-proposal-alpha-profile-variant-fields-present');
    }
    if (unknownGoldFieldPaths.length > 0) {
        problems.push('gold-proposal-unknown-gold-field-present');
    }
    if (expectedProposalCandidates.length !== proposalCandidates.length) {
        problems.push('gold-proposal-candidate-count-mismatch');
    }
    if (proposalCandidates.some((candidate) => !expectedProposalByFile.has(candidate.file))) {
        problems.push('gold-proposal-candidate-unknown-review-manifest-file');
    }
    if (expectedProposalCandidates.some((expected) => !proposalByFile.has(expected.file))) {
        problems.push('gold-proposal-candidate-missing-review-manifest-file');
    }
    if (proposalCandidates.some((candidate) => {
        const expected = expectedProposalByFile.get(candidate.file);
        return expected && expected.sourceSet !== candidate.sourceSet;
    })) {
        problems.push('gold-proposal-candidate-sourceSet-mismatch');
    }
    if (proposalCandidates.some((candidate) => {
        const expected = expectedProposalByFile.get(candidate.file);
        return expected && expected.clusterId !== candidate.clusterId;
    })) {
        problems.push('gold-proposal-candidate-clusterId-mismatch');
    }
    if ((validation.readyDecisions ?? []).some((decision) => {
        const proposed = proposalByFile.get(decision.file);
        return proposed && proposed.clusterId !== decision.clusterId;
    })) {
        problems.push('validation-ready-decisions-proposal-cluster-mismatch');
    }
    if ((validation.readyDecisions ?? []).some((decision) => {
        const proposed = proposalByFile.get(decision.file);
        return proposed && proposed.sourceSet !== decision.sourceSet;
    })) {
        problems.push('validation-ready-decisions-proposal-sourceSet-mismatch');
    }
    if (
        validation.readyForGoldMigration === true &&
        proposalFiles.some((file) => !readyFiles.includes(file))
    ) {
        problems.push('gold-proposal-candidates-without-ready-decision');
    }
    return problems;
}

function defaultThresholds(metrics, multiplier = 1.25) {
    return {
        maxPositiveHaloLum: round(Math.max(0, metrics?.positiveHaloLum ?? 0) * multiplier, 3),
        maxGradientResidual: round(Math.max(0, metrics?.gradientResidual ?? 0) * multiplier, 3),
        maxSpatialResidual: round(Math.max(0, metrics?.spatialResidual ?? 0) * multiplier, 3)
    };
}

function fieldsFromHumanDecision(decision) {
    const verdict = decision.humanVerdict;
    const metrics = decision.metrics ?? {};
    if (BLOCK_VISIBLE_RESIDUAL_VERDICTS.includes(verdict)) {
        return {
            allowVisibleResidual: false,
            visibleResidualVerdict: verdict,
            maxPositiveHaloLum: Math.max(0, Math.min(6, round((metrics.positiveHaloLum ?? 0) * 0.75, 3))),
            maxGradientResidual: Math.max(0, Math.min(0.22, round((metrics.gradientResidual ?? 0) * 0.9, 3))),
            maxSpatialResidual: Math.max(0, Math.min(0.18, round((metrics.spatialResidual ?? 0) * 0.9, 3)))
        };
    }
    if (ALLOW_VISIBLE_RESIDUAL_VERDICTS.includes(verdict)) {
        return {
            allowVisibleResidual: true,
            visibleResidualVerdict: verdict,
            ...defaultThresholds(metrics, verdict === 'backgroundStructure' ? 1.5 : 1.25)
        };
    }
    return {
        allowVisibleResidual: null,
        visibleResidualVerdict: verdict,
        ...defaultThresholds(metrics)
    };
}

function flattenProposalCandidates(proposal) {
    return [
        ...proposal.goldCandidates?.readyForHumanConfirmation ?? [],
        ...proposal.goldCandidates?.pendingHumanReview ?? []
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

function buildSamples({ validation, proposal }) {
    const proposalByFile = new Map(flattenProposalCandidates(proposal).map((candidate) => [candidate.file, candidate]));
    const samples = {};
    for (const decision of validation.readyDecisions ?? []) {
        const proposed = proposalByFile.get(decision.file)?.proposedGoldFields ?? null;
        const humanFields = fieldsFromHumanDecision(decision);
        samples[decision.file] = {
            shouldProcess: true,
            sourceSet: decision.sourceSet,
            clusterId: decision.clusterId ?? null,
            profileLine: decision.profileLine,
            cropPath: decision.cropPath,
            visibleReasons: decision.visibleReasons ?? [],
            visibleResidual: {
                ...(proposed ?? humanFields),
                visibleResidualVerdict: decision.humanVerdict,
                humanConfidence: decision.humanConfidence,
                humanNotes: decision.humanNotes,
                suggestedVerdict: decision.suggestedVerdict ?? null,
                suggestedConfidence: decision.suggestedConfidence ?? null,
                metrics: decision.metrics ?? {}
            },
            tags: [
                'visible-residual-gold',
                decision.sourceSet,
                decision.clusterId,
                decision.profileLine,
                decision.humanVerdict
            ].filter(Boolean)
        };
    }
    return samples;
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
            remediation: 'Wait for pnpm visible-residual:loop to finish, then rerun pnpm visible-residual:create-gold-manifest.'
        }, null, 2));
        process.exitCode = 1;
        return;
    }
    const validationText = stripBom(await readFile(args.validationPath, 'utf8'));
    const proposalText = stripBom(await readFile(args.goldProposalPath, 'utf8'));
    const reviewManifestText = stripBom(await readFile(args.reviewManifestPath, 'utf8'));
    const validationReportSha256 = sha256Text(validationText);
    const goldProposalSha256 = sha256Text(proposalText);
    const reviewManifestSha256 = sha256Text(reviewManifestText);
    const validation = JSON.parse(validationText);
    const proposal = JSON.parse(proposalText);
    const reviewManifest = JSON.parse(reviewManifestText);
    const proposalInputIntegrity = await assessProposalInputHashes(proposal);
    const validationInputContractIntegrity = await assessValidationInputContract(validation);
    const validationDecisionSchemaGateIntegrity = assessValidationDecisionSchemaGate(validation);
    const proposalCandidates = flattenProposalCandidates(proposal);
    const proposalRejectedFieldPaths = {
        forbiddenAlphaProfileFieldPaths: proposalCandidates.flatMap((candidate) => (
            collectForbiddenAlphaProfileFieldPaths(candidate.proposedGoldFields, candidate.file)
        )),
        unknownGoldFieldPaths: proposalCandidates.flatMap((candidate) => (
            collectUnknownTopLevelFieldPaths(
                candidate.proposedGoldFields,
                ALLOWED_PROPOSED_GOLD_FIELD_KEYS,
                candidate.file
            )
        ))
    };
    const problems = assertMigrationAllowed({
        validation,
        proposal,
        reviewManifest,
        reviewManifestSha256,
        proposalInputIntegrity,
        validationInputContractIntegrity,
        validationDecisionSchemaGateIntegrity
    });
    if (problems.length > 0) {
        console.error(JSON.stringify({
            ok: false,
            outputPath: args.outputPath,
            skippedWrite: true,
            problems,
            readyForGoldMigration: validation.readyForGoldMigration,
            pendingTotal: validation.pendingTotal,
            goldCandidateTotal: validation.goldCandidateTotal,
            unconfirmedCount: validation.unconfirmedCount,
            structuralErrorCount: validation.structuralErrorCount,
            expectedReviewManifestSha256: reviewManifestSha256,
            actualReviewManifestSha256: validation.reviewManifestSha256 ?? null,
            proposalInputHashes: proposalInputIntegrity.hashes,
            validationInputContractHashes: validationInputContractIntegrity.hashes,
            validationDecisionSchemaGateIntegrity,
            proposalRejectedFieldPaths
        }, null, 2));
        process.exitCode = 1;
        return;
    }

    const samples = buildSamples({ validation, proposal });
    const manifest = {
        version: 1,
        description: 'Human-confirmed visible residual gold manifest generated from the visible residual review loop.',
        generatedAt: new Date().toISOString(),
        inputs: {
            validationPath: args.validationPath,
            reviewManifestPath: args.reviewManifestPath,
            reviewManifestSha256,
            validationReportSha256,
            reviewInputContractPath: validation.reviewInputContractPath ?? null,
            reviewInputContractSha256: validationInputContractIntegrity.hashes.reviewInputContractSha256 ?? null,
            goldProposalPath: args.goldProposalPath,
            goldProposalSha256,
            alphaSweepPath: proposal.inputs?.alphaSweepPath ?? null,
            alphaSweepSha256: proposalInputIntegrity.hashes.alphaSweepSha256 ?? null,
            alphaSweepReviewManifestSha256: proposalInputIntegrity.hashes.alphaSweepReviewManifestSha256 ?? null,
            profileReportPath: proposal.inputs?.profileReportPath ?? null,
            profileReportSha256: proposalInputIntegrity.hashes.profileReportSha256 ?? null,
            profileReportReviewManifestSha256: proposalInputIntegrity.hashes.profileReportReviewManifestSha256 ?? null,
            profileGeneralizationPath: proposal.inputs?.profileGeneralizationPath ?? null,
            profileGeneralizationSha256: proposalInputIntegrity.hashes.profileGeneralizationSha256 ?? null,
            profileGeneralizationReviewManifestSha256:
                proposalInputIntegrity.hashes.profileGeneralizationReviewManifestSha256 ?? null
        },
        policy: {
            generatedOnlyAfterHumanConfirmation: true,
            writesProductionAlgorithm: false,
            containsAlphaProfileVariants: false
        },
        summary: {
            total: Object.keys(samples).length,
            pendingTotal: validation.pendingTotal,
            goldCandidateTotal: validation.goldCandidateTotal,
            verdictCounts: countBy(validation.readyDecisions ?? [], (decision) => decision.humanVerdict),
            profileCounts: countBy(validation.readyDecisions ?? [], (decision) => decision.profileLine)
        },
        samples
    };

    await mkdir(path.dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
        ok: true,
        outputPath: args.outputPath,
        summary: manifest.summary
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
