import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
    // The label of each writeBuffer target, parallel to `writes`.
    const writeTargets: Array<string | undefined> = [];
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
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((buffer: { label?: string }, _offset: number, data: ArrayBuffer) => {
                writeTargets.push(buffer.label);
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
        createBindGroup: vi.fn(resource),
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, writeTargets, encoder, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
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

    // Issue #96: `queue.writeBuffer` lands before anything in the encoder
    // executes, so a split frame recorded into one encoder is only correct if
    // each stage reads constants the other stage's write cannot touch.
    it('gives each stage of a split frame its own constants buffer', async () => {
        const { device, writes, writeTargets, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };
        const constantsOf = (call: unknown[]) => {
            const { label, entries } = call[0] as {
                label: string; entries: Array<{ resource: { buffer?: { label?: string } } }>;
            };
            return [label, entries[0].resource.buffer?.label] as const;
        };
        const early = ['upscale-reconstruct', 'upscale-depth-clip'];

        const run = (stage: () => void) => {
            writes.length = 0;
            writeTargets.length = 0;
            device.createBindGroup.mockClear();
            stage();
            return device.createBindGroup.mock.calls.map(constantsOf);
        };

        //* Split frame, both stages in the host's one encoder.
        const guides = run(() => core.encodeGuides(
            encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera,
        ));
        expect(guides.map(([label]) => label)).toEqual(early);
        expect(guides.every(([, buffer]) => buffer === 'upscale-constants-early')).toBe(true);
        expect(writeTargets).toEqual(['upscale-constants-early']);

        const late = run(() => core.encodeUpscale(
            encoder as unknown as GPUCommandEncoder, { color: gpu('color'), reactive: gpu('reactive') }, camera,
        ));
        expect(late.length).toBeGreaterThan(0);
        expect(late.every(([, buffer]) => buffer === 'upscale-constants-late')).toBe(true);
        // The late write must not touch what the still-unsubmitted guides read.
        expect(writeTargets).toEqual(['upscale-constants-late']);

        //* Monolithic frame: same split per pass, each buffer written once.
        const frame = run(() => core.dispatch(
            { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, camera,
        ));
        for (const [label, buffer] of frame) {
            expect(buffer).toBe(early.includes(label) ? 'upscale-constants-early' : 'upscale-constants-late');
        }
        expect(writeTargets).toEqual(['upscale-constants-early', 'upscale-constants-late']);
        expect(writes[0]).toEqual(writes[1]);
        expect(device.queue.submit).toHaveBeenCalledTimes(1);
    });

    it('writes only the late constants on the paths with no guides stage', async () => {
        const { device, writeTargets, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, perspective: true });
        expect(writeTargets).toEqual(['upscale-constants-late']);
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
