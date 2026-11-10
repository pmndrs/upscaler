import { describe, expect, test } from 'vitest';

import { ACCUMULATE_SHADER } from '@pmndrs/upscaler-core/shaders/accumulate';

import { ACCUMULATE_VARIANTS, buildMotionCapAccumulateShader } from './shaders/accumulateVariants';

const bindings = (code: string) => code.match(/@group\(0\) @binding\(\d+\) var[^;]*;/g) ?? [];

describe('accumulate motion-gap candidates', () => {
    test('each rewrites production and keeps its bindings, so the pass can bind it', () => {
        for (const [id, code] of Object.entries(ACCUMULATE_VARIANTS)) {
            expect(code, id).not.toBe(ACCUMULATE_SHADER);
            expect(bindings(code), id).toEqual(bindings(ACCUMULATE_SHADER));
        }
    });

    test('the motion cap rewrites every use of maxAccumulation in the blend', () => {
        const code = buildMotionCapAccumulateShader({ cap: 2, lo: 0.05, hi: 0.5 });
        const blend = code.slice(code.indexOf('let motionCap'), code.indexOf('let result = mix('));
        expect(blend).toContain('smoothstep(0.0500, 0.5000, motionTexels)');
        expect(blend.match(/C\.maxAccumulation/g)).toHaveLength(2);
    });
});
