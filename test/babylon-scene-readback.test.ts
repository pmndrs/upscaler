import { afterEach, expect, it, vi } from 'vitest';
import { readTexture } from '../examples/shared/babylon/readback';
import type { TextureResource } from '../src/core/types';

afterEach(() => vi.unstubAllGlobals());

it('does not mistake opaque black or row padding for a rendered RGB scene', async () => {
    vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, MAP_READ: 1 });
    vi.stubGlobal('GPUMapMode', { READ: 1 });
    const pixels = new Uint16Array(128).fill(0x3c00); // padding and alpha = 1
    pixels.set([0, 0, 0, 0x3c00, 0, 0, 0, 0x3c00]);
    const destroy = vi.fn();
    const device = {
        createBuffer: () => ({ mapAsync: async () => {}, getMappedRange: () => pixels.buffer, destroy }),
        createCommandEncoder: () => ({ copyTextureToBuffer() {}, finish() {} }),
        queue: { submit() {} },
    } as unknown as GPUDevice;
    const resource = { texture: { format: 'rgba16float', width: 2, height: 1 } } as TextureResource;
    const result = await readTexture(device, resource);
    expect(result).toEqual({ finite: true, min: 0, max: 0, meanAbs: 0, regions: new Array(192).fill(0), cyanY: -1, amberY: -1, alpha: { min: 1, max: 1, fractional: 0 } });
    expect(destroy).toHaveBeenCalledOnce();
});
