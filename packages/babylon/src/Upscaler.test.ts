import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { describe, expect, it, vi } from 'vitest';

import { BABYLON_MOTION_SCALE, jitterToClip, toFrameCamera } from './internal/conventions';
import { createBabylonTextureAllocator } from './internal/textureAllocator';
import { Upscaler } from './Upscaler';

// GPU-free: a stand-in engine and core, checking only the adapter's wiring.
function fakeGPUTexture(label: string): GPUTexture {
    return { label, destroy: vi.fn(), createView: vi.fn() } as unknown as GPUTexture;
}

function fakeInternal(gpu: GPUTexture): InternalTexture {
    return { _hardwareTexture: { underlyingResource: gpu } } as unknown as InternalTexture;
}

function fakeEngine(log: string[] = []) {
    return {
        isWebGPU: true,
        useReverseDepthBuffer: false,
        _device: { createCommandEncoder: () => ({}) },
        flushFramebuffer: () => log.push('flush'),
        wrapWebGPUTexture: (gpu: GPUTexture) => ({ gpu, generateMipMaps: true, samplingMode: 3, dispose: vi.fn() }),
        updateWrappedWebGPUTexture: vi.fn(),
    };
}

function camera(overrides: Partial<Camera> = {}): Camera {
    return { minZ: 0.1, maxZ: 100, mode: 0, ignoreCameraMaxZ: false, ...overrides } as Camera;
}

describe('Babylon conventions', () => {
    it('reads linear velocity as current − previous on flipped render targets', () => {
        // 0.5·(prev − cur) NDC → texel-row UV delta (cur − prev) is −velocity.
        expect(BABYLON_MOTION_SCALE).toEqual([-1, -1]);
    });

    it('shifts the projection opposite the sample, along flipped texel rows', () => {
        const out = jitterToClip({ x: 0.25, y: -0.125 }, 640, 360, { x: 0, y: 0 });
        expect(out.x).toBeCloseTo((-2 * 0.25) / 640);
        expect(out.y).toBeCloseTo((-2 * -0.125) / 360);
    });

    it('fills FrameCamera from minZ/maxZ, mode and the reverse-depth flag', () => {
        const out = { near: 0, far: 0, perspective: false };
        expect(toFrameCamera(camera(), true, out)).toEqual({ near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(toFrameCamera(camera({ mode: 1 }), false, out).perspective).toBe(false);
    });

    it('rejects an infinite far plane', () => {
        const out = { near: 0, far: 0, perspective: true };
        expect(() => toFrameCamera(camera({ maxZ: 0 }), false, out)).toThrow(/finite far plane/);
        expect(() => toFrameCamera(camera({ ignoreCameraMaxZ: true }), false, out)).toThrow(/finite far plane/);
    });
});

describe('Babylon texture allocator', () => {
    it('wraps the core allocation, builds its view, and samples r32float nearest', () => {
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
        const engine = fakeEngine();
        const device = { createTexture: vi.fn((d: GPUTextureDescriptor) => fakeGPUTexture(d.label!)) } as unknown as GPUDevice;
        const allocate = createBabylonTextureAllocator(engine as unknown as AbstractEngine, device);

        const depth = allocate({ label: 'upscale-depth', width: 4, height: 2, format: 'r32float' });
        const handle = depth.handle as unknown as { gpu: GPUTexture; generateMipMaps: boolean; samplingMode: number; dispose: () => void };
        expect(handle.gpu).toBe(depth.gpu);
        expect(handle.generateMipMaps).toBe(false);
        expect(handle.samplingMode).toBe(1);
        expect(engine.updateWrappedWebGPUTexture).toHaveBeenCalledWith(depth.handle, depth.gpu);

        const color = allocate({ label: 'upscale-output', width: 4, height: 2, format: 'rgba16float' });
        expect((color.handle as unknown as { samplingMode: number }).samplingMode).toBe(3);

        depth.destroy();
        expect(handle.dispose).toHaveBeenCalled();
        expect(depth.gpu.destroy).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('Babylon Upscaler', () => {
    function upscalerWithCore(log: string[]) {
        const upscaler = new Upscaler({ engine: fakeEngine(log) as unknown as AbstractEngine, scene: {} as Scene });
        const core = {
            renderWidth: 640,
            renderHeight: 360,
            beginFrame: () => ({ x: 0.25, y: -0.125 }),
            dispatch: vi.fn(() => log.push('dispatch')),
        };
        const jitter = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
        Object.assign(upscaler as unknown as object, { _core: core, _jitterMaterials: { jitter } });
        return { upscaler, core, jitter };
    }

    it('applies the jitter to the materials between beginFrame and endFrame', () => {
        const { upscaler, jitter } = upscalerWithCore([]);
        expect(upscaler.beginFrame()).toEqual({ x: 0.25, y: -0.125 });
        expect(jitter.x).toBeCloseTo((-2 * 0.25) / 640);
        expect(jitter.y).toBeCloseTo((-2 * -0.125) / 360);
        upscaler.endFrame();
        expect(jitter).toMatchObject({ x: 0, y: 0 });
    });

    it('flushes the engine before submitting, with the GPU textures behind the inputs', () => {
        const log: string[] = [];
        const { upscaler, core } = upscalerWithCore(log);
        const color = fakeGPUTexture('color');
        upscaler.dispatch({ color: fakeInternal(color) }, camera());
        expect(log).toEqual(['flush', 'dispatch']);
        expect(core.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ color }),
            expect.objectContaining({ near: 0.1, far: 100, perspective: true, reversedDepth: false }),
        );
    });
});
