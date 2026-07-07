import { describe, expect, it } from 'vitest';

import { generateJitterSequence, halton } from './halton';

describe('halton', () => {
    it('produces the known base-2 radical inverse sequence', () => {
        expect(halton(1, 2)).toBeCloseTo(1 / 2);
        expect(halton(2, 2)).toBeCloseTo(1 / 4);
        expect(halton(3, 2)).toBeCloseTo(3 / 4);
        expect(halton(4, 2)).toBeCloseTo(1 / 8);
        expect(halton(5, 2)).toBeCloseTo(5 / 8);
    });

    it('produces the known base-3 radical inverse sequence', () => {
        expect(halton(1, 3)).toBeCloseTo(1 / 3);
        expect(halton(2, 3)).toBeCloseTo(2 / 3);
        expect(halton(3, 3)).toBeCloseTo(1 / 9);
        expect(halton(4, 3)).toBeCloseTo(4 / 9);
    });
});

describe('generateJitterSequence', () => {
    it('stays inside the centered half-pixel box', () => {
        for (const [x, y] of generateJitterSequence(64)) {
            expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
            expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
        }
    });

    it('averages near zero (unbiased jitter)', () => {
        const seq = generateJitterSequence(128);
        const mean = seq.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
        expect(mean[0] / seq.length).toBeCloseTo(0, 1);
        expect(mean[1] / seq.length).toBeCloseTo(0, 1);
    });
});
