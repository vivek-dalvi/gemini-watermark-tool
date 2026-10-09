import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PIPELINE_LAYER_CONTRACTS,
    PIPELINE_LAYER_ORDER,
    createPipelineLayerContractSummary,
    getPipelineLayerContract
} from '../../src/core/pipelineLayerContracts.js';

test('pipeline layer contracts should define the canonical layered order', () => {
    assert.deepEqual(PIPELINE_LAYER_ORDER, [
        'detection',
        'alpha',
        'repair',
        'evaluation'
    ]);

    assert.deepEqual(
        Object.keys(PIPELINE_LAYER_CONTRACTS),
        PIPELINE_LAYER_ORDER
    );
});

test('pipeline layer contracts should expose stable anchors for every layer', () => {
    for (const layer of PIPELINE_LAYER_ORDER) {
        const contract = getPipelineLayerContract(layer);

        assert.equal(contract.layer, layer);
        assert.ok(contract.owns.length > 0, `${layer} should describe ownership`);
        assert.ok(contract.inputFields.length > 0, `${layer} should list inputs`);
        assert.ok(contract.outputFields.length > 0, `${layer} should list outputs`);
        assert.ok(contract.moduleAnchors.length > 0, `${layer} should list module anchors`);
        assert.ok(contract.testAnchors.length > 0, `${layer} should list test anchors`);
    }

    assert.ok(getPipelineLayerContract('detection').outputFields.includes('selectedTrial'));
    assert.ok(getPipelineLayerContract('detection').moduleAnchors.includes('pipelineDetectionCandidate'));
    assert.ok(getPipelineLayerContract('detection').testAnchors.includes('pipelineDetectionCandidate.test'));
    assert.ok(getPipelineLayerContract('alpha').moduleAnchors.includes('pipelineAlphaTraceContract'));
    assert.ok(getPipelineLayerContract('alpha').testAnchors.includes('pipelineAlphaTraceContract.test'));
    assert.ok(getPipelineLayerContract('alpha').moduleAnchors.includes('pipelineAlphaTrial'));
    assert.ok(getPipelineLayerContract('alpha').testAnchors.includes('pipelineAlphaTrial.test'));
    assert.ok(getPipelineLayerContract('alpha').outputFields.includes('alphaTrialEvents'));
    assert.ok(getPipelineLayerContract('repair').moduleAnchors.includes('pipelineRepairTrial'));
    assert.ok(getPipelineLayerContract('repair').testAnchors.includes('pipelineRepairTrial.test'));
    assert.ok(getPipelineLayerContract('repair').outputFields.includes('repairTrial'));
    assert.ok(getPipelineLayerContract('evaluation').moduleAnchors.includes('pipelineDecisionPath'));
    assert.ok(getPipelineLayerContract('evaluation').testAnchors.includes('pipelineDecisionPath.test'));
    assert.ok(getPipelineLayerContract('evaluation').outputFields.includes('decisionPath'));
});

test('getPipelineLayerContract should return null for unknown layers', () => {
    assert.equal(getPipelineLayerContract('unknown'), null);
});

test('createPipelineLayerContractSummary should expose counts and anchors only', () => {
    const summary = createPipelineLayerContractSummary();

    assert.equal(summary.length, PIPELINE_LAYER_ORDER.length);
    assert.deepEqual(summary.map((entry) => entry.layer), PIPELINE_LAYER_ORDER);
    assert.deepEqual(summary[0], {
        layer: 'detection',
        owns: 'candidate-localization-and-evidence',
        inputCount: getPipelineLayerContract('detection').inputFields.length,
        outputCount: getPipelineLayerContract('detection').outputFields.length,
        moduleAnchors: [...getPipelineLayerContract('detection').moduleAnchors],
        testAnchors: [...getPipelineLayerContract('detection').testAnchors]
    });
    assert.equal(Object.hasOwn(summary[0], 'inputFields'), false);
    assert.equal(Object.hasOwn(summary[0], 'outputFields'), false);
});
