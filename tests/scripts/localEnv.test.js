import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { loadLocalEnv } from '../../scripts/local-env.js';

test('loadLocalEnv should read local dotenv values without overriding existing env', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'gwr-local-env-'));
    const envPath = path.join(tempDir, '.env');
    try {
        await writeFile(
            envPath,
            [
                '# comment',
                'GWR_SAMPLE_ROOT=/tmp/samples',
                'GWR_ALLENK_ROOT=\"/tmp/allenk\"',
                'EXISTING=from-file'
            ].join('\n'),
            'utf8'
        );

        const env = { EXISTING: 'already-set' };
        assert.equal(loadLocalEnv({ env, envPath }), true);
        assert.equal(env.GWR_SAMPLE_ROOT, '/tmp/samples');
        assert.equal(env.GWR_ALLENK_ROOT, '/tmp/allenk');
        assert.equal(env.EXISTING, 'already-set');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('loadLocalEnv should return false when the env file is missing', () => {
    const env = {};
    assert.equal(loadLocalEnv({ env, envPath: path.join(tmpdir(), 'gwr-missing.env') }), false);
    assert.deepEqual(env, {});
});
