import type { Renderer, Texture } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

import { createPixiTextureAllocator } from './internal/textureAllocator';
import { Upscaler } from './Upscaler';

// GPU-free: a stand-in renderer and core, checking only the adapter's wiring.
function fakeRenderer(log: string[] = []) {
    const gpuOf = new Map<unknown, GPUTexture>();
    return {
        type: 2, // RendererType.WEBGPU
        gpu: { device: {} },
        encoder: { commandEncoder: { label: 'frame' } },
        renderTarget: { finishRenderPass: () => log.push('finishRenderPass') },
        texture: {
            getGpuSource: (source: unknown) => {
                if (!gpuOf.has(source)) gpuOf.set(source, { label: `gpu-${gpuOf.size}` } as GPUTexture);
                return gpuOf.get(source)!;
            },
        },
    };
}

function fakeTexture(): Texture {
    const source = {};
    return { source } as unknown as Texture;
}

function upscalerWithCore(log: string[]) {
    const renderer = fakeRenderer(log);
    const upscaler = new Upscaler({ renderer: renderer as unknown as Renderer });
    const core = {
        configure: vi.fn(),
        dispatch: vi.fn(() => log.push('dispatch')),
        encode: vi.fn((_encoder: unknown) => log.push('encode')),
    };
    Object.assign(upscaler as unknown as object, { _core: core });
    return { upscaler, core, renderer };
}

describe('pixi Upscaler', () => {
    it('rejects a WebGL renderer', () => {
        expect(() => new Upscaler({ renderer: { type: 1 } as unknown as Renderer })).toThrow(/WebGPURenderer/);
    });

    it('resolves pixi textures to their GPU sources, with a stand-in camera on spatial', () => {
        const { upscaler, core, renderer } = upscalerWithCore([]);
        upscaler.configure({ displayWidth: 8, displayHeight: 8, path: 'spatial' });
        const color = fakeTexture();
        upscaler.dispatch({ color });
        expect(core.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ color: renderer.texture.getGpuSource(color.source) }),
            expect.objectContaining({ perspective: true }),
        );
    });

    it('requires camera facts on the temporal path', () => {
        const { upscaler } = upscalerWithCore([]);
        upscaler.configure({ displayWidth: 8, displayHeight: 8, path: 'temporal' });
        expect(() => upscaler.dispatch({ color: fakeTexture() })).toThrow(/FrameCamera/);
    });

    it("encodes into pixi's frame encoder after closing its render pass", () => {
        const log: string[] = [];
        const { upscaler, core, renderer } = upscalerWithCore(log);
        upscaler.configure({ displayWidth: 8, displayHeight: 8, path: 'spatial' });
        upscaler.encode({ color: fakeTexture() });
        expect(log).toEqual(['finishRenderPass', 'encode']);
        expect(core.encode.mock.calls[0][0]).toBe(renderer.encoder.commandEncoder);
    });
});

describe('pixi texture allocator', () => {
    it('allocates storage sources outside the GC, nearest for r32float, freed by unload', () => {
        const renderer = fakeRenderer();
        const allocate = createPixiTextureAllocator(renderer as never);
        const depth = allocate({ label: 'upscale-depth', width: 4, height: 2, format: 'r32float' });
        const source = depth.handle.source;
        expect(source.format).toBe('r32float');
        expect(source.storage).toBe(true);
        expect(source.autoGarbageCollect).toBe(false);
        expect(source.autoGenerateMipmaps).toBe(false);
        expect(source.scaleMode).toBe('nearest');
        expect([source.pixelWidth, source.pixelHeight]).toEqual([4, 2]);
        expect(depth.gpu).toBe(renderer.texture.getGpuSource(source));

        const color = allocate({ label: 'upscale-output', width: 4, height: 2, format: 'rgba16float' });
        expect(color.handle.source.scaleMode).toBe('linear');

        const unload = vi.spyOn(source, 'unload');
        depth.destroy();
        expect(unload).toHaveBeenCalled();
    });
});
