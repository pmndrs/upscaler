import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, DepthTexture, Texture, FloatType, HalfFloatType, RedFormat } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler.js';
import { generateJitterSequence } from './math/halton.js';
import type { UpscalePath } from './types.js';

//* Mock Renderer — answers every create* call with a stub (shape of
// Upscaler.timing.test.ts) plus the texture plumbing configure() needs, so the
// jitter contract is testable without a GPU (issue #68).

function mockRenderer() {
    const writes: Float32Array[] = [];
    const resource = (descriptor: { size?: number | { width: number; height: number }; width?: number; height?: number; format?: string } = {}) => ({
        width: descriptor.width ?? (typeof descriptor.size === 'object' ? descriptor.size.width : 640), height: descriptor.height ?? (typeof descriptor.size === 'object' ? descriptor.size.height : 360),
        format: descriptor.format ?? 'rgba16float', sampleCount: 1, usage: 14,
        getBindGroupLayout: () => ({}),
        createView: () => ({}),
        getMappedRange: () => new ArrayBuffer(typeof descriptor.size === 'number' ? descriptor.size : 4),
        unmap: () => {},
        destroy: () => {},
    });
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Float32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: resource,
        createCommandEncoder: () => ({ beginComputePass() { throw new Error('GPU encoding is outside this constants test.'); } }),
    };
    const backing = new WeakMap<object, object>();
    const renderer = {
        backend: {
            device,
            get: (texture: Texture) => {
                if (!backing.has(texture)) backing.set(texture, { texture: resource({
                    width: (texture.image as { width?: number } | null)?.width ?? 640, height: (texture.image as { height?: number } | null)?.height ?? 360,
                    format: (texture as DepthTexture).isDepthTexture ? 'depth32float' : texture.format === RedFormat ? 'r32float' : texture.type === HalfFloatType ? 'rgba16float' : texture.type === FloatType ? 'rgba32float' : 'rgba8unorm',
                }) });
                return backing.get(texture);
            },
        },
        initTexture: () => {},
    } as unknown as WebGPURenderer;
    return { renderer, writes };
}

async function configured(path: UpscalePath = 'temporal', jitter = true) {
    const { renderer, writes } = mockRenderer();
    const upscaler = new Upscaler({ renderer });

    upscaler.configure({ displayWidth: 1280, displayHeight: 720, customUpscaleRatio: 2, path, jitter });
    await upscaler.init();
    return { upscaler, writes };
}

const camera = () => {
    const c = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    c.updateMatrixWorld();
    return c;
};

describe('Upscaler jitter accessors', async () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('follows generateJitterSequence over a full cycle, phase by phase', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        let previous = sequence[0];
        for (let frame = 1; frame <= upscaler.jitterPhaseCount; frame++) {
            upscaler.beginFrame(cam);
            // beginFrame advances before applying: phase 1 first, 0 closes the cycle.
            expect(upscaler.jitterPhase).toBe(frame % upscaler.jitterPhaseCount);
            const [x, y] = sequence[upscaler.jitterPhase];
            expect(upscaler.jitter).toEqual({ x, y });
            expect(upscaler.jitterPrevious).toEqual({ x: previous[0], y: previous[1] });
            previous = [x, y];
            upscaler.endFrame(cam);
        }
    });

    it('matches the offset beginFrame applies to the camera view', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        upscaler.beginFrame(cam);
        expect(cam.view?.offsetX).toBe(upscaler.jitter.x);
        expect(cam.view?.offsetY).toBe(upscaler.jitter.y);
        upscaler.endFrame(cam);
    });

    it('reports the pure jitter under an app-set view offset', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        // A tiled setup: this camera renders the right half of a 2× wider wall
        // at twice the render resolution, so one render pixel is 2 view units.
        cam.setViewOffset(2560, 720, 1280, 0, 1280, 720);
        upscaler.beginFrame(cam);
        const sequence = generateJitterSequence(upscaler.jitterPhaseCount);
        const [x, y] = sequence[upscaler.jitterPhase];
        expect(upscaler.jitter).toEqual({ x, y });
        // The camera carries app offset + scaled jitter; the getter does not.
        expect(cam.view?.offsetX).toBeCloseTo(1280 + (x * 1280) / 640);
        upscaler.endFrame(cam);
        expect(cam.view?.offsetX).toBe(1280);
    });

    it('agrees with the jitter staged into the constants buffer', async () => {
        const { upscaler, writes } = await configured();
        const cam = camera();
        upscaler.beginFrame(cam);
        writes.length = 0;
        // The constants upload runs before any GPU texture lookup in dispatch.
        try {
            upscaler.dispatchGuides({ depth: new DepthTexture(640, 360), velocity: new Texture() }, cam);
        } catch {
            // The mock can't encode passes; the constants were already written.
        }
        const constants = writes.find((data) => data.length === 64);
        expect(constants).toBeDefined();
        // Exposure reads the fixed metering bound from the final reserved UBO slot.
        expect(new Uint32Array(constants!.buffer)[23]).toBe(32);
        expect([constants![8], constants![9]]).toEqual([
            Math.fround(upscaler.jitter.x),
            Math.fround(upscaler.jitter.y),
        ]);
        expect([constants![10], constants![11]]).toEqual([
            Math.fround(upscaler.jitterPrevious.x),
            Math.fround(upscaler.jitterPrevious.y),
        ]);
    });

    it('restarts the phase on resetHistory()', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        for (let i = 0; i < 5; i++) {
            upscaler.beginFrame(cam);
            upscaler.endFrame(cam);
        }
        expect(upscaler.jitterPhase).toBe(5);
        upscaler.resetHistory();
        upscaler.beginFrame(cam);
        expect(upscaler.jitterPhase).toBe(1);
        upscaler.endFrame(cam);
    });

    it.each([
        ['temporal with jitter: false', 'temporal', false],
        ['spatial', 'spatial', true],
        ['bilinear', 'bilinear', true],
    ] as const)('reads (0, 0) and phase 0 on %s', async (_label, path, jitter) => {
        const { upscaler } = await configured(path, jitter);
        const cam = camera();
        upscaler.beginFrame(cam);
        expect(upscaler.jitter).toEqual({ x: 0, y: 0 });
        expect(upscaler.jitterPrevious).toEqual({ x: 0, y: 0 });
        expect(upscaler.jitterPhase).toBe(0);
        expect(cam.view).toBeNull();
        upscaler.endFrame(cam);
    });

    it('returns stable objects', async () => {
        const { upscaler } = await configured();
        const cam = camera();
        const first = upscaler.jitter;
        upscaler.beginFrame(cam);
        expect(upscaler.jitter).toBe(first);
        upscaler.endFrame(cam);
    });
});
