import { describe, expect, it } from 'vitest';
import { getResourceDescriptors } from './resources.js';

describe('renderer-independent resource requirements', () => {
    it('rounds odd shading dimensions up and keeps history read/write allocations separate', () => {
        const d = getResourceDescriptors({ renderWidth: 13, renderHeight: 7, displayWidth: 25, displayHeight: 15, path: 'temporal' });
        expect(d.find(x => x.name === 'shadingSignal')).toMatchObject({ width: 7, height: 4, format: 'r32float', history: false });
        expect(d.find(x => x.name === 'shadingBlockMemory')).toMatchObject({ width: 4, height: 3, format: 'rgba32uint', history: true });
        expect(d.find(x => x.name === 'history')).toMatchObject({ width: 25, height: 15, history: true });
        expect(d.find(x => x.name === 'exposure')).toMatchObject({ width: 1, height: 1, format: 'rgba16float', history: true });
    });

    it('uses float32 exposure without metering in the provided mode', () => {
        expect(getResourceDescriptors({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, exposureMode: 'provided' })
            .find(x => x.name === 'exposure')?.format).toBe('rgba32float');
    });

    it('allocates only geometry products on the guides path', () => {
        const d = getResourceDescriptors({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, path: 'guides' });
        expect(d.map(x => x.name)).toEqual(['dilatedDepth', 'dilatedMotion', 'masks']);
    });

    it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid dimensions %s', size => {
        expect(() => getResourceDescriptors({ renderWidth: size, renderHeight: 4, displayWidth: 8, displayHeight: 8 })).toThrow('dimensions');
    });
});
