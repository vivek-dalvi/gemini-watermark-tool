import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRankingKey,
    compareRankingKey,
    scoreBalancedVisualCandidate,
    scoreDamage,
    scoreOriginalEvidence,
    scoreResidual,
    shouldEarlyAccept
} from '../../src/core/watermarkScoring.js';

test('scoreOriginalEvidence should separate strong medium weak and none tiers', () => {
    assert.equal(scoreOriginalEvidence({ spatial: 0.4, gradient: 0.2 }).tier, 'strong');
    assert.equal(scoreOriginalEvidence({ spatial: 0.18, gradient: 0.02 }).tier, 'medium');
    assert.equal(scoreOriginalEvidence({ spatial: 0.06, gradient: 0.01 }).tier, 'weak');
    assert.equal(scoreOriginalEvidence({ spatial: 0.01, gradient: 0.01 }).tier, 'none');
});

test('scoreResidual should combine after-image residual and artifact cost', () => {
    const residual = scoreResidual({
        processedSpatial: -0.03,
        processedGradient: 0.1,
        suppressionGain: 0.5,
        artifactCost: 0.2
    });

    assert.equal(residual.cleared, true);
    assert.equal(residual.spatialResidual, 0.03);
    assert.equal(residual.gradientResidual, 0.1);
    assert.equal(residual.suppressionGain, 0.5);
    assert.equal(residual.score, 0.14);
});

test('scoreDamage should mark texture and clipping damage as unsafe', () => {
    const damage = scoreDamage({
        nearBlackIncrease: 0.01,
        texturePenalty: 0.3,
        newlyClippedRatio: 0.04
    });

    assert.equal(damage.safe, false);
    assert.equal(damage.reason, 'texture,clipping');
    assert.ok(damage.penalty > 0.6, `penalty=${damage.penalty}`);
});

test('scoreBalancedVisualCandidate should trade residual improvement against visible damage', () => {
    const cleanResidualWithDamage = scoreBalancedVisualCandidate({
        processedSpatial: 0.02,
        processedGradient: 0.02,
        newlyClippedRatio: 0.04,
        darkHaloLum: 8,
        visualArtifactCost: 0.2
    });
    const slightlyHigherResidualClean = scoreBalancedVisualCandidate({
        processedSpatial: 0.08,
        processedGradient: 0.04,
        newlyClippedRatio: 0,
        darkHaloLum: 0,
        visualArtifactCost: 0.02
    });

    assert.ok(
        slightlyHigherResidualClean.score < cleanResidualWithDamage.score,
        `expected balanced score to prefer the visually safer candidate, clean=${slightlyHigherResidualClean.score}, damaged=${cleanResidualWithDamage.score}`
    );
});

test('buildRankingKey and compareRankingKey should rank source priority before residual score', () => {
    const highPriorityWeakResidual = buildRankingKey({
        sourcePriority: 0,
        originalEvidenceTier: 'medium',
        damageSafe: true,
        residualScore: 0.8,
        alphaPriorityIndex: 1,
        damagePenalty: 0
    });
    const lowerPriorityCleanResidual = buildRankingKey({
        sourcePriority: 1,
        originalEvidenceTier: 'strong',
        damageSafe: true,
        residualScore: 0.1,
        alphaPriorityIndex: 0,
        damagePenalty: 0
    });

    assert.ok(compareRankingKey(highPriorityWeakResidual, lowerPriorityCleanResidual) < 0);
});

test('shouldEarlyAccept should require strong evidence clean residual and safe damage', () => {
    const originalEvidence = scoreOriginalEvidence({ spatial: 0.4, gradient: 0.2 });
    const residual = scoreResidual({
        processedSpatial: 0.01,
        processedGradient: 0.02,
        suppressionGain: 0.35
    });
    const damage = scoreDamage({
        nearBlackIncrease: 0.01,
        texturePenalty: 0.02
    });

    assert.equal(shouldEarlyAccept({
        sourcePriority: 1,
        originalEvidence,
        residual,
        damage
    }), true);
    assert.equal(shouldEarlyAccept({
        sourcePriority: 8,
        originalEvidence,
        residual,
        damage
    }), false);
});
