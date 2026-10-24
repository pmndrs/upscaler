import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler';

//* Mock Renderer — a device that answers every create* call with a stub and
// records which ones ran, so init() completes without a GPU (issue #70).

function mockRenderer(features: string[] = ['timestamp-query']) {
    const calls: string[] = [];
    const destroyed: string[] = [];
    const stub = (kind: string) => (descriptor: { label?: string } = {}) => {
        calls.push(kind);
        return {
            label: descriptor.label,
            getBindGroupLayout: () => ({}),
            destroy: () => destroyed.push(kind),
        };
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set(features),
        queue: { writeBuffer: vi.fn(), submit: vi.fn() },
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        createShaderModule: stub('createShaderModule'),
        createComputePipelineAsync: async (...args: Parameters<ReturnType<typeof stub>>) => stub('createComputePipelineAsync')(...args),
        createSampler: stub('createSampler'),
        createBuffer: stub('createBuffer'),
        createQuerySet: stub('createQuerySet'),
    };
    const renderer = { backend: { device } } as unknown as WebGPURenderer;
    return { renderer, calls, destroyed, device };
}

const timerCalls = (calls: string[]) => calls.filter((kind) => kind === 'createQuerySet').length;

describe('Upscaler GPU timing switch', async () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', {
            MAP_READ: 1,
            COPY_SRC: 4,
            COPY_DST: 8,
            UNIFORM: 64,
            QUERY_RESOLVE: 512,
        });
        vi.stubGlobal('GPUMapMode', { READ: 1 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates no timer resources and opens no error scopes when off', async () => {
        const { renderer, calls, device } = mockRenderer();
        const upscaler = new Upscaler({ renderer, gpuTiming: false });
        await upscaler.init();
        expect(timerCalls(calls)).toBe(0);
        expect(device.pushErrorScope).not.toHaveBeenCalled();
        expect(upscaler.gpuTiming).toBe(false);
        expect(upscaler.gpuTimings.size).toBe(0);
    });

    it('is off by default', async () => {
        const { renderer, calls } = mockRenderer();
        const upscaler = new Upscaler({ renderer });
        await upscaler.init();
        expect(upscaler.gpuTiming).toBe(false);
        expect(timerCalls(calls)).toBe(0);
    });

    it('allocates the timer at init when on', async () => {
        const { renderer, calls } = mockRenderer();
        const upscaler = new Upscaler({ renderer, gpuTiming: true });
        await upscaler.init();
        expect(timerCalls(calls)).toBeGreaterThan(0);
    });

    it('allocates on enable and frees everything on disable', async () => {
        const { renderer, calls, destroyed } = mockRenderer();
        const upscaler = new Upscaler({ renderer, gpuTiming: false });
        await upscaler.init();

        upscaler.gpuTiming = true;
        const allocated = timerCalls(calls);
        expect(allocated).toBeGreaterThan(0);

        upscaler.gpuTiming = false;
        expect(destroyed.filter((kind) => kind === 'createQuerySet')).toHaveLength(allocated);
        expect(upscaler.gpuTimings.size).toBe(0);
    });

    it('defers allocation to init when toggled on before it', async () => {
        const { renderer, calls } = mockRenderer();
        const upscaler = new Upscaler({ renderer, gpuTiming: false });
        upscaler.gpuTiming = true;
        expect(calls).toEqual([]);
        await upscaler.init();
        expect(timerCalls(calls)).toBeGreaterThan(0);
    });
});
