import { describe, expect, it } from 'vitest';
import { buildReconstructShader, RECONSTRUCT_SHADER } from '../shaders/reconstruct.js';
import { buildAccumulateShader, ACCUMULATE_SHADER } from '../shaders/accumulate.js';
import { buildRcasShader, RCAS_SHADER } from '../shaders/rcas.js';
import { PROVIDED_EXPOSURE_SHADER } from '../shaders/providedExposure.js';

describe('engine-independent shader variants', () => {
    it('preserves default shader identities', () => {
        expect(buildReconstructShader(false)).toBe(RECONSTRUCT_SHADER);
        expect(buildAccumulateShader(false)).toBe(ACCUMULATE_SHADER);
        expect(buildRcasShader(0)).toBe(RCAS_SHADER);
    });
    it('loads positive linear depth directly', () => {
        const source = buildReconstructShader(true);
        expect(source).toContain('var sceneDepth : texture_2d<f32>');
        expect(source).toContain('textureLoad(sceneDepth, center, 0).r');
        expect(source).toContain('return depth;');
        expect(source).not.toContain('near * far');
    });
    it('combines both exposure ratios before history conditioning', () => {
        expect(buildAccumulateShader(true)).toContain('hostRatio *= exposure / conditioningPrev');
        expect(ACCUMULATE_SHADER).not.toContain('conditioningPrev');
        expect(PROVIDED_EXPOSURE_SHADER).toContain('rgba32float');
        expect(PROVIDED_EXPOSURE_SHADER).not.toContain('inputColor');
    });
    it('ramps the temporal lobe from normalized age and leaves spatial sharpening alone', () => {
        expect(buildRcasShader(0.5)).toContain('smoothstep(0.0, 0.500000000, textureLoad(inputColor, sp, 0).a)');
        expect(buildRcasShader(0.5)).toContain('if (hasFlag(FLAG_INPUT_REINHARD)) { lobe *=');
        expect(RCAS_SHADER).not.toContain('smoothstep(0.0,');
        expect(buildRcasShader(1e-10)).toContain('1.00000000e-10');
    });
});
