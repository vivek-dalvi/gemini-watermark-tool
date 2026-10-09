import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import {
    createVideoReviewDecisionReport,
    createVideoReviewDecisionSummary,
    renderVideoReviewDecisionMarkdown
} from '../../scripts/create-video-review-decision-report.js';

function baseDecision(overrides = {}) {
    return {
        exportedAt: '2026-06-11T00:00:00.000Z',
        deliveryStatus: 'ready-for-visual-review',
        temporalStatus: 'pass',
        candidate: 'canvas-temporal-match-delta-stabilize, strength=0.25',
        videos: [
            { caseId: 'deaee69b', kind: 'roi', currentTime: 4 },
            { caseId: 'deaee69b', kind: 'full', currentTime: 4 },
            { caseId: 'e1997e6e', kind: 'roi', currentTime: 4 },
            { caseId: 'e1997e6e', kind: 'full', currentTime: 4 }
        ],
        decision: 'accept',
        notes: 'Looks usable.',
        checklist: [
            { index: 0, checked: true, text: 'ROI clean' },
            { index: 1, checked: true, text: 'Full clean' }
        ],
        ...overrides
    };
}

test('createVideoReviewDecisionSummary should accept fully checked review decisions', () => {
    const report = createVideoReviewDecisionSummary(baseDecision());

    assert.equal(report.status, 'accepted-for-default-review');
    assert.equal(report.nextAction, 'promote-to-default-strategy-review');
    assert.equal(report.checklist.checked, 2);
    assert.equal(report.videoCoverage.hasRoi, true);
    assert.equal(report.videoCoverage.hasFull, true);
    assert.deepEqual(report.blockers, []);
});

test('createVideoReviewDecisionSummary should keep needs-polish decisions out of default review', () => {
    const report = createVideoReviewDecisionSummary(baseDecision({
        decision: 'needs-polish',
        notes: 'Need one more ROI pass.',
        checklist: [
            { index: 0, checked: true, text: 'ROI clean' },
            { index: 1, checked: false, text: 'Full clean' }
        ]
    }));

    assert.equal(report.status, 'needs-polish');
    assert.equal(report.nextAction, 'run-light-polish-pass-before-default-review');
    assert.ok(report.warnings.includes('decision-checklist-incomplete'));
});

test('createVideoReviewDecisionSummary should downgrade accept when checklist is incomplete', () => {
    const report = createVideoReviewDecisionSummary(baseDecision({
        checklist: [
            { index: 0, checked: true, text: 'ROI clean' },
            { index: 1, checked: false, text: 'Full clean' }
        ]
    }));
    const markdown = renderVideoReviewDecisionMarkdown(report);

    assert.equal(report.status, 'needs-polish');
    assert.ok(report.warnings.includes('accept-decision-with-incomplete-checklist'));
    assert.match(markdown, /Status: needs-polish/);
    assert.match(markdown, /Checklist \| 1\/2 checked/);
});

function polishDecision(overrides = {}) {
    return baseDecision({
        deliveryStatus: 'review-only',
        temporalStatus: 'available',
        candidate: 'strength=0.20 backup compared with current strength=0.25',
        decision: 'prefer-current',
        checklist: [
            { index: 0, checked: true, text: 'ROI comparable' },
            { index: 1, checked: true, text: 'No new flicker' },
            { index: 2, checked: true, text: 'Full frame ok' }
        ],
        ...overrides
    });
}

test('createVideoReviewDecisionSummary should keep current candidate from polish comparison decisions', () => {
    const report = createVideoReviewDecisionSummary(polishDecision());
    const markdown = renderVideoReviewDecisionMarkdown(report);

    assert.equal(report.reviewMode, 'polish-comparison');
    assert.equal(report.status, 'prefer-current-default-candidate');
    assert.equal(report.nextAction, 'keep-current-strength025-and-continue-default-review');
    assert.deepEqual(report.blockers, []);
    assert.ok(report.warnings.includes('review-only-polish-comparison'));
    assert.match(markdown, /Review mode: polish-comparison/);
});

test('createVideoReviewDecisionSummary should preserve checked prefer-light decisions as polish candidates', () => {
    const report = createVideoReviewDecisionSummary(polishDecision({
        decision: 'prefer-light'
    }));

    assert.equal(report.status, 'prefer-light-polish-candidate');
    assert.equal(report.nextAction, 'run-narrow-strength020-sweep-or-promote-light-polish-review');
    assert.deepEqual(report.blockers, []);
});

test('createVideoReviewDecisionSummary should preserve checked narrow sweep decisions', () => {
    const strength018 = createVideoReviewDecisionSummary(polishDecision({
        decision: 'prefer-strength018'
    }));
    const strength022 = createVideoReviewDecisionSummary(polishDecision({
        decision: 'prefer-strength022'
    }));

    assert.equal(strength018.status, 'prefer-strength018-polish-candidate');
    assert.equal(strength018.nextAction, 'promote-strength018-to-polish-review');
    assert.deepEqual(strength018.blockers, []);
    assert.equal(strength022.status, 'prefer-strength022-polish-candidate');
    assert.equal(strength022.nextAction, 'promote-strength022-to-polish-review');
    assert.deepEqual(strength022.blockers, []);
});

test('createVideoReviewDecisionSummary should preserve checked alpha policy decisions', () => {
    const report = createVideoReviewDecisionSummary(polishDecision({
        candidate: 'alphaEdgePolicy=standard045-inset035',
        decision: 'prefer-alpha-policy035'
    }));

    assert.equal(report.reviewMode, 'polish-comparison');
    assert.equal(report.status, 'prefer-alpha-policy035-candidate');
    assert.equal(report.nextAction, 'promote-alpha-policy035-to-default-candidate-review');
    assert.deepEqual(report.blockers, []);
});

test('createVideoReviewDecisionSummary should downgrade incomplete prefer-light smoke decisions', () => {
    const report = createVideoReviewDecisionSummary(polishDecision({
        decision: 'prefer-light',
        checklist: [
            { index: 0, checked: false, text: 'ROI comparable' },
            { index: 1, checked: false, text: 'No new flicker' }
        ]
    }));

    assert.equal(report.status, 'needs-polish');
    assert.equal(report.nextAction, 'run-narrow-polish-sweep-before-default-review');
    assert.deepEqual(report.blockers, []);
    assert.ok(report.warnings.includes('prefer-light-decision-with-incomplete-checklist'));
});

test('createVideoReviewDecisionSummary should downgrade incomplete alpha policy decisions', () => {
    const report = createVideoReviewDecisionSummary(polishDecision({
        candidate: 'alphaEdgePolicy=standard045-inset035',
        decision: 'prefer-alpha-policy035',
        checklist: [
            { index: 0, checked: true, text: 'ROI comparable' },
            { index: 1, checked: false, text: 'No new flicker' }
        ]
    }));

    assert.equal(report.status, 'needs-polish');
    assert.equal(report.nextAction, 'run-narrow-polish-sweep-before-default-review');
    assert.deepEqual(report.blockers, []);
    assert.ok(report.warnings.includes('prefer-alpha-policy035-decision-with-incomplete-checklist'));
});

test('createVideoReviewDecisionReport should apply explicit human-review CLI overrides', async () => {
    const root = path.resolve('.artifacts/test-tmp/video-review-decision-overrides');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const decisionPath = path.join(root, 'alpha.template.json');
    const outputPath = path.join(root, 'alpha.report.json');
    const markdownPath = path.join(root, 'alpha.report.md');
    await writeFile(decisionPath, `${JSON.stringify(polishDecision({
        decision: 'pending',
        notes: '',
        checklist: [
            { index: 0, checked: false, text: 'ROI comparable' },
            { index: 1, checked: false, text: 'No new flicker' }
        ]
    }), null, 2)}\n`, 'utf8');

    const report = await createVideoReviewDecisionReport({
        decisionPath,
        outputPath,
        markdownPath,
        setDecision: 'prefer-alpha-policy035',
        checkAll: true,
        notes: 'Human reviewed the quickstart videos.'
    });
    const saved = JSON.parse(await readFile(outputPath, 'utf8'));
    const markdown = await readFile(markdownPath, 'utf8');

    assert.equal(report.status, 'prefer-alpha-policy035-candidate');
    assert.equal(saved.appliedOverrides.setDecision, 'prefer-alpha-policy035');
    assert.equal(saved.appliedOverrides.checkAll, true);
    assert.equal(saved.checklist.checked, 2);
    assert.match(markdown, /Human reviewed the quickstart videos/);
});
