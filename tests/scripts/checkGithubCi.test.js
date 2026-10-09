import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkGithubCi,
    classifyCiRun,
    formatCiCheckResult,
    selectRunForCommit,
    summarizeFailedJobs,
    trimLogSnippet
} from '../../scripts/check-github-ci.js';

function createMockExecFile(fixtures) {
    const calls = [];
    const execFile = async (command, args) => {
        calls.push({ command, args });
        const key = `${command} ${args.join(' ')}`;
        const value = fixtures[key];
        if (value instanceof Error) throw value;
        if (value === undefined) {
            throw new Error(`unexpected command: ${key}`);
        }
        return { stdout: value, stderr: '' };
    };
    execFile.calls = calls;
    return execFile;
}

test('selectRunForCommit picks the target commit run instead of a newer unrelated run', () => {
    const run = selectRunForCommit([
        {
            databaseId: 2,
            headSha: 'other',
            createdAt: '2026-06-16T12:00:00Z',
            status: 'completed',
            conclusion: 'success'
        },
        {
            databaseId: 1,
            headSha: 'target',
            createdAt: '2026-06-16T10:00:00Z',
            status: 'completed',
            conclusion: 'failure'
        }
    ], 'target');

    assert.equal(run.databaseId, 1);
});

test('classifyCiRun fails closed for missing or incomplete CI runs', () => {
    assert.deepEqual(classifyCiRun(null), {
        ok: false,
        status: 'missing',
        blocker: 'ci-run-missing'
    });
    assert.deepEqual(classifyCiRun({ status: 'in_progress', conclusion: null }), {
        ok: false,
        status: 'pending',
        blocker: 'ci-run-not-completed'
    });
});

test('classifyCiRun accepts completed successful CI runs', () => {
    assert.deepEqual(classifyCiRun({ status: 'completed', conclusion: 'success' }), {
        ok: true,
        status: 'success',
        blocker: null
    });
});

test('summarizeFailedJobs reports failed jobs and steps', () => {
    const failedJobs = summarizeFailedJobs([
        {
            name: 'build-and-test',
            status: 'completed',
            conclusion: 'failure',
            url: 'https://example.test/job',
            steps: [
                { number: 1, name: 'Checkout', conclusion: 'success' },
                { number: 2, name: 'Test', conclusion: 'failure' }
            ]
        },
        {
            name: 'post',
            status: 'completed',
            conclusion: 'success',
            steps: []
        }
    ]);

    assert.deepEqual(failedJobs, [
        {
            name: 'build-and-test',
            status: 'completed',
            conclusion: 'failure',
            url: 'https://example.test/job',
            failedSteps: [
                { number: 2, name: 'Test', conclusion: 'failure' }
            ]
        }
    ]);
});

test('trimLogSnippet keeps actionable CI failure lines', () => {
    const snippet = trimLogSnippet([
        'noise',
        'not ok 1 - test failed',
        '  error: expected true',
        '  code: ERR_ASSERTION',
        '# fail 1',
        'Process completed with exit code 1.'
    ].join('\n'));

    assert.deepEqual(snippet, [
        'not ok 1 - test failed',
        '  error: expected true',
        '  code: ERR_ASSERTION',
        '# fail 1',
        'Process completed with exit code 1.'
    ]);
});

test('checkGithubCi fails closed when the target commit has no CI run', async () => {
    const execFile = createMockExecFile({
        'gh run list --workflow ci.yml --commit target --limit 20 --json databaseId,name,workflowName,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,url': JSON.stringify([
            {
                databaseId: 1,
                headSha: 'other',
                status: 'completed',
                conclusion: 'success',
                createdAt: '2026-06-16T12:00:00Z'
            }
        ])
    });

    const result = await checkGithubCi({
        workflow: 'ci.yml',
        commitSha: 'target',
        execFile
    });

    assert.equal(result.classification.ok, false);
    assert.equal(result.classification.blocker, 'ci-run-missing');
    assert.equal(result.run, null);
});

test('checkGithubCi returns failed job and log evidence for failed CI', async () => {
    const execFile = createMockExecFile({
        'gh run list --workflow ci.yml --commit target --limit 20 --json databaseId,name,workflowName,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,url': JSON.stringify([
            {
                databaseId: 42,
                displayTitle: 'Release v1.0.24',
                headSha: 'target',
                status: 'completed',
                conclusion: 'failure',
                createdAt: '2026-06-16T12:00:00Z',
                url: 'https://example.test/run'
            }
        ]),
        'gh run view 42 --json jobs': JSON.stringify({
            jobs: [
                {
                    name: 'build-and-test',
                    status: 'completed',
                    conclusion: 'failure',
                    steps: [
                        { number: 3, name: 'Test', conclusion: 'failure' }
                    ]
                }
            ]
        }),
        'gh run view 42 --log-failed': 'noise\nnot ok 1 - failing test\n# fail 1\n'
    });

    const result = await checkGithubCi({
        workflow: 'ci.yml',
        commitSha: 'target',
        execFile
    });

    assert.equal(result.classification.ok, false);
    assert.equal(result.classification.status, 'failed');
    assert.equal(result.failedJobs[0].name, 'build-and-test');
    assert.deepEqual(result.logSnippet, [
        'not ok 1 - failing test',
        '# fail 1'
    ]);
    assert.match(formatCiCheckResult(result), /Failure log snippet:/);
});

test('checkGithubCi accepts the target commit when CI succeeded', async () => {
    const execFile = createMockExecFile({
        'gh run list --workflow ci.yml --commit target --limit 20 --json databaseId,name,workflowName,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,url': JSON.stringify([
            {
                databaseId: 42,
                displayTitle: 'Release v1.0.24',
                headSha: 'target',
                status: 'completed',
                conclusion: 'success',
                createdAt: '2026-06-16T12:00:00Z',
                url: 'https://example.test/run'
            }
        ])
    });

    const result = await checkGithubCi({
        workflow: 'ci.yml',
        commitSha: 'target',
        execFile
    });

    assert.equal(result.classification.ok, true);
    assert.equal(result.classification.status, 'success');
    assert.equal(result.failedJobs.length, 0);
});
