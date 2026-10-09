import { strict as assert } from 'node:assert';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    classifyVectorRepairOutcome,
    createIssue103VectorRepairFixturePack,
    createIssue103VectorRepairFixtureCases,
    summarizeVectorRepairFixtureResults
} from '../../scripts/create-issue103-vector-repair-fixture-pack.js';

test('createIssue103VectorRepairFixtureCases should include recoverable and protected vector cases', () => {
    const cases = createIssue103VectorRepairFixtureCases();

    assert.ok(
        cases.some((caseItem) => caseItem.id === 'large-blocks-recoverable' && caseItem.expected === 'repairable'),
        'expected a simple connected large-block case'
    );
    assert.ok(
        cases.some((caseItem) => caseItem.id === 'nested-shapes-protected' && caseItem.expected === 'protect'),
        'expected a hidden local shape case that must not be promoted'
    );
});

test('classifyVectorRepairOutcome should require improvement on repairable cases', () => {
    assert.equal(
        classifyVectorRepairOutcome({
            expected: 'repairable',
            inverse: { rmse: 5, maxError: 18 },
            repair: { rmse: 1.2, maxError: 8 }
        }).label,
        'repairable-improved'
    );

    assert.equal(
        classifyVectorRepairOutcome({
            expected: 'repairable',
            inverse: { rmse: 5, maxError: 18 },
            repair: { rmse: 4.8, maxError: 18 }
        }).label,
        'repairable-not-improved'
    );
});

test('classifyVectorRepairOutcome should block protected cases when repair worsens hidden structure', () => {
    assert.equal(
        classifyVectorRepairOutcome({
            expected: 'protect',
            inverse: { rmse: 3.8, maxError: 12 },
            repair: { rmse: 15.4, maxError: 80 }
        }).label,
        'protected-regression'
    );

    assert.equal(
        classifyVectorRepairOutcome({
            expected: 'protect',
            inverse: { rmse: 3.8, maxError: 12 },
            repair: { rmse: 3.7, maxError: 12 }
        }).label,
        'protected-not-worse'
    );
});

test('summarizeVectorRepairFixtureResults should fail production readiness on protected regressions', () => {
    const summary = summarizeVectorRepairFixtureResults([
        {
            id: 'large-blocks-recoverable',
            expected: 'repairable',
            outcome: { label: 'repairable-improved' }
        },
        {
            id: 'nested-shapes-protected',
            expected: 'protect',
            outcome: { label: 'protected-regression' }
        }
    ]);

    assert.equal(summary.productionReady, false);
    assert.deepEqual(summary.labels, {
        'repairable-improved': 1,
        'protected-regression': 1
    });
    assert.deepEqual(summary.blockers, ['protected-regression']);
});

test('createIssue103VectorRepairFixturePack should write reviewable report and image artifacts', async () => {
    const tempRoot = path.resolve('.artifacts/test-tmp');
    await mkdir(tempRoot, { recursive: true });
    const outputDir = path.join(tempRoot, `issue103-vector-${Date.now()}`);

    try {
        const { reportPath, sheetPath, report } = await createIssue103VectorRepairFixturePack({ outputDir });

        assert.equal(report.summary.productionReady, false);
        assert.equal(report.summary.labels['repairable-improved'], 1);
        assert.equal(report.summary.labels['protected-regression'], 1);
        assert.ok(report.summary.blockers.includes('protected-regression'));
        assert.equal(report.summary.blockers.includes('repairable-not-improved'), false);
        assert.equal(report.gatedSummary.productionReady, true);
        assert.equal(report.gatedSummary.labels['repairable-improved'], 1);
        assert.equal(report.gatedSummary.labels['protected-not-worse'], 4);
        assert.deepEqual(report.gatedSummary.blockers, []);
        assert.deepEqual(report.columns, ['truth', 'watermarked', 'inverse', 'palette-snap-repair', 'gated-palette-repair']);

        const mixedCase = report.results.find((result) => result.id === 'mixed-safe-component-protected');
        assert.equal(mixedCase.gatedDecision.adopted, true);
        assert.ok(mixedCase.gatedRepair.rmse < mixedCase.inverse.rmse);
        assert.equal(mixedCase.gatedOutcome.label, 'protected-not-worse');

        await stat(reportPath);
        await stat(sheetPath);
        for (const result of report.results) {
            await stat(result.files.truth);
            await stat(result.files.watermarked);
            await stat(result.files.inverse);
            await stat(result.files.repair);
            await stat(result.files.gatedRepair);
        }
    } finally {
        await rm(outputDir, { recursive: true, force: true });
    }
});
