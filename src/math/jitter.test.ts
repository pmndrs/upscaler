import { describe, expect, it } from 'vitest';

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
