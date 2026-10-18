import { describe, expect, it } from 'vitest';

import { SHADING_CHANGE_SHADER } from '@pmndrs/upscaler-core/shaders/shadingChange';
import {
    buildShadingRecurrenceShader,
    SHADING_CHANGE_FRAME_PAIR_SHADER,
} from './shaders/shadingChangeRange';

const bindings = (source: string) =>
    [...source.matchAll(/@binding\((\d+)\)/g)]
        .map((match) => Number(match[1]))
        .sort((a, b) => a - b);

// Every identity plugs into production's shading-change bind group through
// Upscaler's bench-only `_shadingChangeShader`, so all must declare 0–10.
describe('shading-change memory candidates (NEXT-STEPS §14)', () => {
    const candidates = {
        range4: buildShadingRecurrenceShader({ mode: 'range', slots: 4 }),
        range8: buildShadingRecurrenceShader({ mode: 'range', slots: 8 }),
        nearest8: buildShadingRecurrenceShader({ mode: 'nearest', slots: 8 }),
        ema: buildShadingRecurrenceShader({ mode: 'ema', slots: 1 }),
        gated4: buildShadingRecurrenceShader({ mode: 'gated', slots: 4, jumpGain: 1.5 }),
        framePair: SHADING_CHANGE_FRAME_PAIR_SHADER,
    };

    it("declares production's bindings", () => {
        const expected = bindings(SHADING_CHANGE_SHADER);
        expect(expected).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        for (const source of Object.values(candidates)) expect(bindings(source)).toEqual(expected);
    });

    it('keeps the pass structure', () => {
        for (const source of Object.values(candidates)) {
            expect(source).toContain('@compute @workgroup_size(8, 8)');
            expect(source).toContain('fn main(');
            expect(source).toContain('if (any(vec2f(gid.xy) >= C.renderSize)) { return; }');
        }
    });

    it('keeps the frame-pair identity free of the memory', () => {
        expect(SHADING_CHANGE_FRAME_PAIR_SHADER).not.toContain('memoryDistance');
        expect(SHADING_CHANGE_FRAME_PAIR_SHADER).toContain('_ = textureDimensions(blockMemoryOut);');
    });
});
