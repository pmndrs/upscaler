import { describe, expect, it } from 'vitest';
import { inputParameters } from '../examples/shared/babylon/inputs';

describe('Babylon scene input contract', () => {
    it('removes jitter in render-pixel units even at odd, nonuniform dimensions', () => {
        const values = inputParameters(641, 359, { x: 0.25, y: -0.5 }, { x: -0.25, y: 0.25 }, 100, true, false);
        expect(values[0]).toBeCloseTo(0.5 / 641);
        expect(values[1]).toBeCloseTo(-0.75 / 359);
        expect([...values.slice(2, 6)]).toEqual([100, 1, 0, 0]);
    });
    it('marks the first frame after resets and allows reactive masking to be disabled', () => {
        const values = inputParameters(800, 450, { x: 0, y: 0 }, { x: 0, y: 0 }, 200, false, true);
        expect([...values]).toEqual([0, 0, 200, 0, 1, 0, 0, 0]);
    });
});
