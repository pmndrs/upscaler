import { describe, expect, it } from 'vitest';

import { generateJitterSequence } from './halton';
import { getJitterPhaseCount, JitterSequence } from './jitter';

describe('getJitterPhaseCount', () => {
    it('follows the FidelityFX 8·ratio² formula', () => {
        expect(getJitterPhaseCount(1.0)).toBe(8);
        expect(getJitterPhaseCount(1.5)).toBe(18);
        expect(getJitterPhaseCount(2.0)).toBe(32);
        expect(getJitterPhaseCount(3.0)).toBe(72);
    });
});

describe('JitterSequence', () => {
    it('cycles through the full phase count', () => {
        const jitter = new JitterSequence(2.0);
        expect(jitter.phaseCount).toBe(32);

        const first = jitter.current;
        for (let i = 0; i < jitter.phaseCount; i++) jitter.advance();
        // A full cycle lands back on the same offset.
        expect(jitter.current).toEqual(first);
    });

    it('reports the phase index of the current offset', () => {
        const jitter = new JitterSequence(2.0);
        const sequence = generateJitterSequence(jitter.phaseCount);
        expect(jitter.phaseIndex).toBe(0);
        for (let i = 1; i <= jitter.phaseCount; i++) {
            jitter.advance();
            expect(jitter.phaseIndex).toBe(i % jitter.phaseCount);
            expect(jitter.current).toEqual(sequence[jitter.phaseIndex]);
        }
        jitter.reset();
        expect(jitter.phaseIndex).toBe(0);
    });

    it('tracks the previous offset across advances', () => {
        const jitter = new JitterSequence(1.5);
        const before = jitter.current;
        jitter.advance();
        expect(jitter.previous).toEqual(before);
    });

    it('rebuilds when the ratio changes', () => {
        const jitter = new JitterSequence(1.0);
        jitter.setRatio(3.0);
        expect(jitter.phaseCount).toBe(72);
    });
});
