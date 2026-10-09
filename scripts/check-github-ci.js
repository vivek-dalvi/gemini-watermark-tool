import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFileCallback);

const DEFAULT_WORKFLOW = 'ci.yml';
const TERMINAL_FAILURE_CONCLUSIONS = new Set([
    'failure',
    'cancelled',
    'timed_out',
    'action_required',
    'startup_failure'
]);

function normalizeSha(value) {
    const sha = String(value || '').trim();
    if (!sha || sha.toUpperCase() === 'HEAD') return null;
    return sha;
}

function parseJson(text, label) {
    try {
        return JSON.parse(text || 'null');
    } catch (error) {
        throw new Error(`无法解析 ${label} JSON: ${error?.message || String(error)}`);
    }
}

function normalizeRun(run = {}) {
    return {
        databaseId: run.databaseId ?? null,
        name: run.name || run.workflowName || null,
        workflowName: run.workflowName || run.name || null,
        displayTitle: run.displayTitle || null,
        headBranch: run.headBranch || null,
        headSha: run.headSha || null,
        status: run.status || null,
        conclusion: run.conclusion || null,
        event: run.event || null,
        createdAt: run.createdAt || null,
        url: run.url || null
    };
}

function compareRunCreatedAt(left, right) {
    return Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0);
}

export function selectRunForCommit(runs = [], commitSha = null) {
    const normalizedCommit = normalizeSha(commitSha);
    const normalizedRuns = runs.map(normalizeRun).sort(compareRunCreatedAt);
    if (!normalizedCommit) return normalizedRuns[0] || null;
    return normalizedRuns.find((run) => run.headSha === normalizedCommit) || null;
}

export function classifyCiRun(run = null) {
    if (!run) {
        return {
            ok: false,
            status: 'missing',
            blocker: 'ci-run-missing'
        };
    }
    if (run.status !== 'completed') {
        return {
            ok: false,
            status: 'pending',
            blocker: 'ci-run-not-completed'
        };
    }
    if (run.conclusion === 'success') {
        return {
            ok: true,
            status: 'success',
            blocker: null
        };
    }
    if (TERMINAL_FAILURE_CONCLUSIONS.has(run.conclusion)) {
        return {
            ok: false,
            status: 'failed',
            blocker: `ci-run-${run.conclusion}`
        };
    }
    return {
        ok: false,
        status: 'unknown',
        blocker: `ci-run-${run.conclusion || 'unknown'}`
    };
}

export function summarizeFailedJobs(jobs = []) {
    return jobs
        .filter((job) => job.conclusion && job.conclusion !== 'success' && job.conclusion !== 'skipped')
        .map((job) => ({
            name: job.name || null,
            status: job.status || null,
            conclusion: job.conclusion || null,
            url: job.url || null,
            failedSteps: (job.steps || [])
                .filter((step) => step.conclusion && step.conclusion !== 'success' && step.conclusion !== 'skipped')
                .map((step) => ({
                    number: step.number ?? null,
                    name: step.name || null,
                    conclusion: step.conclusion || null
                }))
        }));
}

export function trimLogSnippet(logText = '', maxLines = 80) {
    const lines = String(logText || '')
        .split(/\r?\n/)
        .filter((line) => {
            const lower = line.toLowerCase();
            return lower.includes('not ok') ||
                lower.includes('error:') ||
                lower.includes('assertionerror') ||
                lower.includes('err_') ||
                lower.includes('# fail') ||
                lower.includes('process completed with exit code') ||
                lower.includes('elifecycle');
        });
    return lines.slice(-maxLines);
}

export function formatCiCheckResult(result) {
    const lines = [];
    const run = result.run;
    lines.push(`CI check: ${result.classification.status}`);
    lines.push(`workflow: ${result.workflow}`);
    lines.push(`commit: ${result.commitSha || '-'}`);
    if (run) {
        lines.push(`run: ${run.displayTitle || run.name || run.databaseId}`);
        lines.push(`status: ${run.status || '-'} / ${run.conclusion || '-'}`);
        lines.push(`url: ${run.url || '-'}`);
    }
    if (result.classification.blocker) lines.push(`blocker: ${result.classification.blocker}`);
    if (result.failedJobs?.length) {
        lines.push('');
        lines.push('Failed jobs:');
        for (const job of result.failedJobs) {
            lines.push(`- ${job.name || '-'}: ${job.conclusion || job.status || '-'}`);
            for (const step of job.failedSteps || []) {
                lines.push(`  - step ${step.number ?? '-'} ${step.name || '-'}: ${step.conclusion || '-'}`);
            }
            if (job.url) lines.push(`  ${job.url}`);
        }
    }
    if (result.logSnippet?.length) {
        lines.push('');
        lines.push('Failure log snippet:');
        for (const line of result.logSnippet) lines.push(line);
    }
    return `${lines.join('\n')}\n`;
}

async function runCommand(execFile, command, args, options = {}) {
    const { stdout } = await execFile(command, args, {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        ...options
    });
    return stdout;
}

async function resolveHeadCommit(execFile, cwd) {
    const stdout = await runCommand(execFile, 'git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
}

async function fetchWorkflowRuns(execFile, { workflow, commitSha, cwd }) {
    const args = [
        'run',
        'list',
        '--workflow',
        workflow,
        '--limit',
        '20',
        '--json',
        'databaseId,name,workflowName,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,url'
    ];
    if (commitSha) args.splice(4, 0, '--commit', commitSha);
    const stdout = await runCommand(execFile, 'gh', args, { cwd });
    const runs = parseJson(stdout, 'gh run list');
    return Array.isArray(runs) ? runs : [];
}

async function fetchRunJobs(execFile, { runId, cwd }) {
    const stdout = await runCommand(execFile, 'gh', ['run', 'view', String(runId), '--json', 'jobs'], { cwd });
    const payload = parseJson(stdout, 'gh run view jobs');
    return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

async function fetchFailedLogSnippet(execFile, { runId, cwd }) {
    try {
        const stdout = await runCommand(execFile, 'gh', ['run', 'view', String(runId), '--log-failed'], { cwd });
        return trimLogSnippet(stdout);
    } catch (error) {
        const message = error?.stderr || error?.stdout || error?.message || String(error);
        return [`无法获取失败日志: ${String(message).trim()}`];
    }
}

export async function checkGithubCi({
    workflow = DEFAULT_WORKFLOW,
    commitSha = null,
    cwd = process.cwd(),
    execFile = execFileAsync
} = {}) {
    const resolvedCommit = normalizeSha(commitSha) || await resolveHeadCommit(execFile, cwd);
    const runs = await fetchWorkflowRuns(execFile, { workflow, commitSha: resolvedCommit, cwd });
    const run = selectRunForCommit(runs, resolvedCommit);
    const classification = classifyCiRun(run);
    const result = {
        workflow,
        commitSha: resolvedCommit,
        run,
        classification,
        failedJobs: [],
        logSnippet: []
    };

    if (run?.databaseId && classification.ok === false) {
        const jobs = await fetchRunJobs(execFile, { runId: run.databaseId, cwd });
        result.failedJobs = summarizeFailedJobs(jobs);
        if (classification.status === 'failed') {
            result.logSnippet = await fetchFailedLogSnippet(execFile, { runId: run.databaseId, cwd });
        }
    }
    return result;
}

function parseCliArgs(argv) {
    const parsed = {
        workflow: DEFAULT_WORKFLOW,
        commitSha: null,
        failClosed: true
    };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--') continue;
        if (arg === '--workflow') {
            parsed.workflow = argv[++index] || parsed.workflow;
        } else if (arg === '--commit') {
            parsed.commitSha = argv[++index] || parsed.commitSha;
        } else if (arg === '--allow-missing') {
            parsed.failClosed = false;
        } else if (arg === '--fail-closed') {
            parsed.failClosed = true;
        } else if (arg === '--help' || arg === '-h') {
            parsed.help = true;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return parsed;
}

function printHelp() {
    console.log(`Usage:
  node scripts/check-github-ci.js [--workflow ci.yml] [--commit <sha|HEAD>] [--fail-closed]

Checks the GitHub Actions workflow for the target commit through gh.
By default this fails closed when no completed successful CI run exists.
`);
}

async function main() {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }
    const result = await checkGithubCi({
        workflow: args.workflow,
        commitSha: args.commitSha
    });
    process.stdout.write(formatCiCheckResult(result));
    const missingAllowed = result.classification.status === 'missing' && args.failClosed === false;
    if (!result.classification.ok && !missingAllowed) {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error?.stack || error?.message || String(error));
        process.exitCode = 1;
    });
}
