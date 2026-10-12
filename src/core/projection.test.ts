import { describe, expect, it } from 'vitest';
import { jitterProjection } from './projection.js';

describe('projection jitter composition', () => {
    it('preserves existing offsets in perspective projections and the caller matrix', () => {
        const p = new Float32Array([2,0,0,0, 0,3,0,0, 0.2,-0.3,1,1, 0,0,-1,0]);
        const before = p.slice(); const q = jitterProjection(p, { x: 0.25, y: -0.25 }, 100, 50);
        expect(p).toEqual(before);
        expect(q[8]).toBeCloseTo(0.195); expect(q[9]).toBeCloseTo(-0.31);
        expect(q[10]).toBe(p[10]); expect(q[11]).toBe(p[11]);
    });
    it('composes orthographic and asymmetric projections through clip-space translation', () => {
        const p = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0.3,0.4,0,1]);
        const q = jitterProjection(p, { x: -0.5, y: 0.25 }, 100, 50);
        expect(q[12]).toBeCloseTo(0.31); expect(q[13]).toBeCloseTo(0.41);
    });
});
