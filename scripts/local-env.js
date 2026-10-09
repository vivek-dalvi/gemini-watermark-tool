import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadLocalEnv({
    env = process.env,
    envPath = path.resolve('.env')
} = {}) {
    if (!existsSync(envPath)) return false;

    const text = readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;

        const [, key, rawValue] = match;
        if (Object.prototype.hasOwnProperty.call(env, key)) continue;

        let value = rawValue.trim();
        const quote = value[0];
        if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }

    return true;
}
