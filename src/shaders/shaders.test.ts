import { describe, expect, it } from 'vitest';

import { ACCUMULATE_SHADER } from './accumulate';
import { BLIT_SHADER } from './blit';
import { DEBUG_SHADER } from './debug';
import { EASU_SHADER } from './easu';
import { GENERATE_REACTIVE_SHADER } from './generateReactive';
import { LUMINANCE_PYRAMID_SHADER } from './luminancePyramid';
import { RCAS_SHADER } from './rcas';
import { RECONSTRUCT_SHADER } from './reconstruct';
import { assembleShader } from './wgsl';

const ALL_SHADERS: Record<string, string> = {
    blit: BLIT_SHADER,
    easu: EASU_SHADER,
    rcas: RCAS_SHADER,
    reconstruct: RECONSTRUCT_SHADER,
    accumulate: ACCUMULATE_SHADER,
    luminancePyramid: LUMINANCE_PYRAMID_SHADER,
    generateReactive: GENERATE_REACTIVE_SHADER,
    debug: DEBUG_SHADER,
};

describe('assembleShader', () => {
    it('deduplicates shared chunks', () => {
        const chunk = 'fn shared() -> f32 { return 1.0; }';
        const out = assembleShader(chunk, 'fn other() {}', chunk);
        expect(out.match(/fn shared/g)).toHaveLength(1);
    });

    it('drops empty parts', () => {
        expect(assembleShader('', 'fn a() {}', '  ')).toBe('fn a() {}\n');
    });
});

// Structural sanity for every assembled WGSL module — catches include
// mistakes (missing constants block, duplicate helpers, unbalanced braces)
// long before a GPU sees the source.
describe.each(Object.entries(ALL_SHADERS))('%s shader', (_name, source) => {
    it('has exactly one compute entry point named main', () => {
        expect(source.match(/@compute/g)).toHaveLength(1);
        expect(source).toMatch(/@compute @workgroup_size\(8, 8\)\s*\nfn main\(/);
    });

    it('binds the shared constants block at binding 0', () => {
        expect(source.match(/struct FsrConstants/g)).toHaveLength(1);
        expect(source).toContain('@group(0) @binding(0) var<uniform> C : FsrConstants;');
    });

    it('has balanced braces and parens', () => {
        const count = (re: RegExp) => (source.match(re) ?? []).length;
        expect(count(/\{/g)).toBe(count(/\}/g));
        expect(count(/\(/g)).toBe(count(/\)/g));
    });

    it('declares no duplicate function names', () => {
        const names = [...source.matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]);
        expect(new Set(names).size).toBe(names.length);
    });

    it('guards the dispatch grid against overrun', () => {
        expect(source).toMatch(
            /if \(any\(vec2f\(gid\.xy\) >= C\.(displaySize|renderSize)\)\) \{ return; \}/,
        );
    });
});
