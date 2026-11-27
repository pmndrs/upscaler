import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, test } from 'vitest';

import { parseFlags } from './cli-flags.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('parseFlags', () => {
    test('parses values, booleans and help', () => {
        expect(parseFlags(['--ratio', '2', '--settings', '{"a":1}', '--dry'], ['ratio', 'settings', 'dry'])).toEqual({
            ratio: '2',
            settings: '{"a":1}',
            dry: true,
        });
        expect(parseFlags(['--help'], [])).toEqual({ help: true });
        expect(parseFlags(['-h'], [])).toEqual({ help: true });
    });

    test('rejects unknown flags and stray positionals', () => {
        expect(() => parseFlags(['--ratoi', '2'], ['ratio'])).toThrowError(/Unknown option --ratoi/);
        expect(() => parseFlags(['--ratio', '2', '3'], ['ratio'])).toThrowError(/Unexpected argument 3/);
    });
});

// GPU-free: both paths exit during argument parsing, before any server or
// browser is started.
describe.each(['measure-drift-lag.mjs', 'measure-exposure-ceiling.mjs', 'measure-motion-stability.mjs', 'measure-receding-disocclusion.mjs'])(
    '%s CLI', (script) => {
    const run = (...args) =>
        spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
            encoding: 'utf8',
            timeout: 20_000,
        });

    test('--help prints usage and exits 0', () => {
        const result = run('--help');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Usage: node scripts/${script}`);
    });

    test('an unknown flag prints usage and exits 1', () => {
        const result = run('--bogus', '1');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Unknown option --bogus.');
        expect(result.stderr).toContain(`Usage: node scripts/${script}`);
    });
});

// #75 added --variant to the drift-lag meter; the strict parser must declare it,
// or every candidate A/B (`--variant shading-frame-pair-v1`) exits with usage.
test('measure-drift-lag.mjs declares --variant', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'measure-drift-lag.mjs'), '--help'], {
        encoding: 'utf8',
        timeout: 20_000,
    });
    expect(result.stdout).toContain('--variant <id>');
    const source = readFileSync(join(ROOT, 'scripts', 'measure-drift-lag.mjs'), 'utf8');
    expect(source).toMatch(/parseCliOrExit\([\s\S]*?'variant'[\s\S]*?USAGE/);
});
