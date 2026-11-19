import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore, everyTexelGate, everyTexelSupported, optionalPassTransition, type OptionalPass } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH, FLAG_SHADING_CHANGE, FLAG_SHADING_PRIME } from './shaders/common';
import { DebugView } from './types';
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
        // The every-texel metering creates its layouts and buffers inside error
        // scopes; its pipelines go through createComputePipelineAsync.
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async (): Promise<GPUError | null> => null),
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
        createComputePipelineAsync: vi.fn(async (descriptor: { label?: string } = {}) => resource(descriptor)),
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

    describe('every-texel exposure metering (NEXT-STEPS §17)', () => {
        const camera = { near: 0.1, far: 100, perspective: true };
        type Passes = Array<{ label?: string; dispatches: number[][] }>;
        const exposureDispatches = (passes: Passes) =>
            passes.filter((p) => p.label === 'upscale-exposure').at(-1)!.dispatches;
        const everyTexelLabels = (device: ReturnType<typeof mockDevice>['device']) =>
            device.createComputePipelineAsync.mock.calls
                .map(([d]) => d?.label)
                .filter((label) => label?.includes('every-texel'));

        it('gates on 2^19 render texels (≈960×540)', () => {
            expect(everyTexelGate(960, 540)).toBe(true);
            expect(everyTexelGate(1024, 512)).toBe(true); // exactly 2^19
            expect(everyTexelGate(1025, 512)).toBe(false);
            expect(everyTexelGate(1280, 720)).toBe(false);
        });

        it('needs 256-invocation, 256-wide workgroups and a second bind group', () => {
            const limits = { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBindGroups: 4 };
            const supported = (patch: Partial<typeof limits>) =>
                everyTexelSupported({ limits: { ...limits, ...patch } } as unknown as GPUDevice);
            expect(supported({})).toBe(true);
            expect(supported({ maxComputeInvocationsPerWorkgroup: 128 })).toBe(false);
            expect(supported({ maxComputeWorkgroupSizeX: 128 })).toBe(false);
            expect(supported({ maxBindGroups: 1 })).toBe(false);
        });

        it('meters every texel within the gate and the taps above, compiling only when gated in', async () => {
            const { device, passes, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

            // 1280×720 renders: the taps' single 8×8 workgroup, nothing compiled for the gate.
            core.configure({ displayWidth: 1920, displayHeight: 1080, customUpscaleRatio: 1.5 });
            await core.prepare();
            core.dispatch(inputs, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1]]);
            expect(everyTexelLabels(device)).toEqual([]);

            // 960×540: 64×64-texel partials (15×9 workgroups), then the combine.
            core.configure({ displayWidth: 1920, displayHeight: 1080, customUpscaleRatio: 2 });
            await core.prepare();
            core.dispatch(inputs, camera);
            expect(exposureDispatches(passes)).toEqual([[15, 9, 1], [1, 1, 1]]);
            expect(everyTexelLabels(device).sort()).toEqual([
                'upscale-exposure-every-texel-combine', 'upscale-exposure-every-texel-partials',
            ]);
            // Every pipeline is created asynchronously (docs/windows-cross-device.md).
            expect(device.createComputePipeline).not.toHaveBeenCalled();
            expect(device.pushErrorScope.mock.calls.map(([filter]) => filter))
                .toEqual(expect.arrayContaining(['validation', 'internal', 'out-of-memory']));
        });

        it('meters with the taps until the every-texel metering is ready, then switches without a reset', async () => {
            const { device, passes, gpu, writes } = mockDevice();
            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const original = device.createComputePipelineAsync.getMockImplementation()!;
            device.createComputePipelineAsync.mockImplementation(async (d = {}) => {
                if (d.label?.includes('every-texel')) await gate;
                return original(d);
            });
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await vi.waitFor(() => expect(core.isReady).toBe(true));
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            core.dispatch(inputs, camera);
            core.dispatch(inputs, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1]]);
            release();
            await core.prepare();
            core.dispatch(inputs, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1, 1], [1, 1, 1]]);
            // Switching forms eases the stored exposure; history keeps going.
            expect(lastFlags(writes) & FLAG_RESET).toBe(0);
        });

        it('falls back to the taps for good, warning once, when the compile fails', async () => {
            const { device, passes, gpu } = mockDevice();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const original = device.createComputePipelineAsync.getMockImplementation()!;
            device.createComputePipelineAsync.mockImplementation(async (d = {}) => {
                if (d.label?.includes('every-texel')) throw new Error('compile failed');
                return original(d);
            });
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            expect(core.isReady).toBe(true);
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            core.dispatch(inputs, camera);
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 3 });
            await core.prepare();
            core.dispatch(inputs, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1]]);
            expect(warn).toHaveBeenCalledTimes(1);
            // Both entry points were tried once, and never again.
            expect(everyTexelLabels(device)).toHaveLength(2);
        });

        it('falls back to the taps when an allocation scope reports an error', async () => {
            const { device, passes, gpu } = mockDevice();
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // The layout scopes (pops 1–3) pop clean; the buffers' first pop
            // (out-of-memory) does not.
            let pops = 0;
            device.popErrorScope.mockImplementation(async () =>
                (++pops === 4 ? ({ message: 'out of memory' } as GPUError) : null));
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1]]);
            expect(warn).toHaveBeenCalledTimes(1);
        });

        it('keeps the taps at every size without 256-invocation workgroups', async () => {
            const { device, passes, gpu } = mockDevice();
            device.limits.maxComputeInvocationsPerWorkgroup = 128;
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, camera);
            expect(exposureDispatches(passes)).toEqual([[1, 1]]);
            expect(everyTexelLabels(device)).toEqual([]);
        });
    });

    describe('optional passes turning on mid-history (NEXT-STEPS §18)', () => {
        const camera = { near: 0.1, far: 100, perspective: true };
        const shadingFlags = (writes: Uint32Array[]) => lastFlags(writes) & (FLAG_RESET | FLAG_SHADING_CHANGE | FLAG_SHADING_PRIME);
        const ran = (passes: Array<{ label?: string }>, label: string) => passes.some((p) => p.label === label);

        // A core whose optional passes stay inactive while `held` names them
        // (the bench's late-readiness hook), past one reset first frame.
        async function running(held: Set<OptionalPass>) {
            const mock = mockDevice();
            const core = new UpscalerCore({
                device: mock.device as unknown as GPUDevice,
                _holdOptionalPass: (pass: OptionalPass) => held.has(pass),
            } as ConstructorParameters<typeof UpscalerCore>[0]);
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            const inputs = { color: mock.gpu('color'), depth: mock.gpu('depth'), velocity: mock.gpu('velocity') };
            core.dispatch(inputs, camera);
            expect(lastFlags(mock.writes) & FLAG_RESET).toBe(FLAG_RESET);
            return { ...mock, core, inputs };
        }

        it('primes only on the frame a stage turns on', () => {
            const off = { shading: false, debug: false, everyTexel: false };
            const on = { shading: true, debug: true, everyTexel: true };
            expect(optionalPassTransition(off, { ...off, shading: true })).toEqual({ primeShading: true });
            expect(optionalPassTransition(on, on)).toEqual({ primeShading: false });
            expect(optionalPassTransition(on, off)).toEqual({ primeShading: false });
            expect(optionalPassTransition(off, { ...off, debug: true, everyTexel: true })).toEqual({ primeShading: false });
        });

        it('primes a late shading-change detector instead of restarting history', async () => {
            const held = new Set<OptionalPass>(['shadingChange']);
            const { core, inputs, writes, passes } = await running(held);
            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(0);
            expect(ran(passes, 'upscale-shading-change')).toBe(false);

            held.clear();
            passes.length = 0;
            core.dispatch(inputs, camera);
            // Runs (seeding its history) but nothing consults it, and no reset.
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_PRIME);
            expect(ran(passes, 'upscale-shading-change')).toBe(true);

            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_CHANGE);
        });

        it('primes the same way when detectShadingChanges is toggled back on', async () => {
            const { core, inputs, writes } = await running(new Set());
            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_CHANGE);
            core.settings.detectShadingChanges = false;
            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(0);
            core.settings.detectShadingChanges = true;
            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_PRIME);
            core.dispatch(inputs, camera);
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_CHANGE);
        });

        it('keeps a split frame primed from its guides stage through its upscale stage', async () => {
            const held = new Set<OptionalPass>(['shadingChange']);
            const { core, inputs, writes } = await running(held);
            held.clear();
            core.dispatchGuides({ depth: inputs.depth, velocity: inputs.velocity }, camera);
            held.add('shadingChange'); // frozen at the guides stage
            core.dispatchUpscale({ color: inputs.color }, camera);
            expect(shadingFlags(writes)).toBe(FLAG_SHADING_PRIME);
        });

        it('turns a late debug view or every-texel metering on without a reset', async () => {
            const held = new Set<OptionalPass>(['debug', 'everyTexel']);
            const { core, inputs, writes, passes } = await running(held);
            core.settings.debugView = DebugView.MotionVectors;
            await core.prepare();
            core.dispatch(inputs, camera);
            expect(core.activeDebugView).toBe(DebugView.None);
            held.clear();
            passes.length = 0;
            core.dispatch(inputs, camera);
            expect(core.activeDebugView).toBe(DebugView.MotionVectors);
            expect(ran(passes, 'upscale-debug')).toBe(true);
            expect(passes.find((p) => p.label === 'upscale-exposure')!.dispatches).toHaveLength(2);
            expect(lastFlags(writes) & FLAG_RESET).toBe(0);
        });
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
