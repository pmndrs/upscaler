import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
    // Per compute pass: its label and the workgroup counts of its dispatches.
    const passes: Array<{ label?: string; dispatches: number[][] }> = [];
    const resource = (descriptor: { size?: number; label?: string } = {}) => ({
        label: descriptor.label,
        width: 16,
        height: 16,
        sampleCount: 1,
        format: 'rgba16float',
        getBindGroupLayout: () => ({}),
        createView: () => ({}),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4),
        unmap: () => {},
        destroy: vi.fn(),
    });
    const encoder = {
        beginComputePass: (descriptor: { label?: string } = {}) => {
            const pass = { label: descriptor.label, dispatches: [] as number[][] };
            passes.push(pass);
            return {
                setPipeline() {}, setBindGroup() {}, end() {},
                dispatchWorkgroups: (...counts: number[]) => { pass.dispatches.push(counts); },
            };
        },
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        limits: { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBindGroups: 4 },
        // The every-texel metering (@pmndrs/downsampler) compiles synchronously
        // inside a validation scope.
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        createBindGroupLayout: resource,
        createPipelineLayout: resource,
        createComputePipeline: vi.fn(resource),
        queue: {
            writeBuffer: vi.fn((_buffer: unknown, _offset: number, data: ArrayBuffer) => {
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: resource,
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, encoder, passes, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
        vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates the published set through the allocator and returns its handles', async () => {
        const { device } = mockDevice();
        const allocated: CoreTextureDescriptor[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            allocated.push(descriptor);
            return { gpu: device.createTexture() as unknown as GPUTexture, handle: { name: descriptor.label }, destroy: vi.fn() };
        };
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, allocateTexture });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        expect(core.output).toEqual({ name: 'upscale-output' });
        expect(core.guides.dilatedMotion).toEqual({ name: 'upscale-dilated-motion' });
        expect(core.guides.history).toEqual({ name: 'upscale-history-0' });
        const byLabel = new Map(allocated.map((d) => [d.label, d]));
        expect(byLabel.get('upscale-output')).toMatchObject({ width: 64, height: 32, format: 'rgba16float' });
        expect(byLabel.get('upscale-dilated-depth-0')).toMatchObject({ width: 32, height: 16, format: 'r32float' });
        expect(byLabel.get('upscale-masks')).toMatchObject({ format: 'rgba8unorm' });
    });

    it('defaults to raw GPUTexture handles', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.output).toMatchObject({ label: 'upscale-output' });
    });

    it('stages camera facts from plain frame data', async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET))
            .toBe(FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET);

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET)).toBe(0);
    });

    it("reads the projection type from a denoiser-style camera's matrix", async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        const perspective = new Float32Array(16);
        perspective[11] = -1; // w = −z
        const orthographic = new Float32Array(16);
        orthographic[15] = 1;

        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: perspective });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: orthographic });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(0);
        expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100 })).toThrow(/perspective/);
    });

    it('encodes into a host encoder without submitting', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
    });

    it('meters every texel up to 2^19 render texels and the taps above (NEXT-STEPS §17)', async () => {
        const { device, passes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        const camera = { near: 0.1, far: 100, perspective: true };
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
        const exposureDispatches = () => passes.filter((p) => p.label === 'upscale-exposure').at(-1)!.dispatches;

        // 1920×1080 at ratio 2: 960×540 renders, every texel. 64×64-texel
        // partials (15×9 workgroups), then the one-workgroup combine.
        core.configure({ displayWidth: 1920, displayHeight: 1080, customUpscaleRatio: 2 });
        await core.prepare();
        core.dispatch(inputs, camera);
        expect(exposureDispatches()).toEqual([[15, 9, 1], [1, 1, 1]]);
        expect(device.pushErrorScope).toHaveBeenCalledWith('validation');

        // 1280×720 renders (ratio 1.5): the taps' single 8×8 workgroup.
        core.configure({ displayWidth: 1920, displayHeight: 1080, customUpscaleRatio: 1.5 });
        await core.prepare();
        core.dispatch(inputs, camera);
        expect(exposureDispatches()).toEqual([[1, 1]]);
    });

    it('keeps the taps at every size without 256-invocation workgroups', async () => {
        const { device, passes, gpu } = mockDevice();
        device.limits.maxComputeInvocationsPerWorkgroup = 128;
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, { near: 0.1, far: 100, perspective: true });
        expect(passes.find((p) => p.label === 'upscale-exposure')!.dispatches).toEqual([[1, 1]]);
        expect(device.createComputePipeline).not.toHaveBeenCalled();
    });

    it('advances jitter only on the temporal path with jitter on', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        expect(core.beginFrame()).toBe(core.jitter);
        expect(core.jitterPhase).toBe(1);
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.beginFrame()).toBeNull();
    });
});
