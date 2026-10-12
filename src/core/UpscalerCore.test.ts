import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpscalerCore } from './UpscalerCore.js';
import { getResourceDescriptors } from './resources.js';
import { DebugView } from './types.js';
import type { CoreConfiguration, CoreResources, FrameData, TextureResource } from './types.js';

function fixture(config: CoreConfiguration = { renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8 }) {
    const passes: string[] = [];
    const bindings: GPUBindGroupDescriptor[] = [];
    const uploads: { buffer: unknown; data: Float32Array }[] = [];
    const buffers: { label?: string; destroy: ReturnType<typeof vi.fn> }[] = [];
    let lose!: (v: GPUDeviceLostInfo) => void;
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(r => { lose = r; }),
        createBuffer: (d: GPUBufferDescriptor) => {
            const b = { label: d.label, getMappedRange: () => new ArrayBuffer(Number(d.size)), unmap() {}, destroy: vi.fn() };
            buffers.push(b); return b;
        },
        createSampler: () => ({}), createShaderModule: () => ({}),
        createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
        createBindGroup: (d: GPUBindGroupDescriptor) => { bindings.push(d); return {}; },
        createTexture: vi.fn(), createCommandEncoder: vi.fn(),
        queue: { submit: vi.fn(), writeBuffer: (buffer: unknown, _o: number, data: ArrayBuffer) => uploads.push({ buffer, data: new Float32Array(data.slice(0)) }) },
    };
    const encoder = {
        beginComputePass: (d: GPUComputePassDescriptor) => {
            passes.push(d.label!); return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        finish: vi.fn(), copyBufferToBuffer: vi.fn(), copyBufferToTexture: vi.fn(),
    };
    const texture = (width: number, height: number, format: GPUTextureFormat, usage = 12): TextureResource => {
        const raw = { width, height, format, usage, sampleCount: 1, destroy: vi.fn(), createView: () => ({}) };
        return { texture: raw as unknown as GPUTexture, view: raw.createView() as GPUTextureView };
    };
    const resources: CoreResources = { color: texture(config.renderWidth, config.renderHeight, 'rgba16float'), depth: texture(config.renderWidth, config.renderHeight, config.depthMode === 'linear' ? 'r32float' : 'depth32float'), velocity: texture(config.renderWidth, config.renderHeight, 'rgba16float') };
    for (const d of getResourceDescriptors(config)) {
        const create = () => texture(d.width, d.height, d.format, d.usage);
        resources[d.name] = d.history ? { read: create(), write: create() } : create();
    }
    const core = new UpscalerCore({ device: device as unknown as GPUDevice });
    core.configure(config);
    const frame: FrameData = { frameIndex: 0, jitter: { x: 0.25, y: -0.25 }, jitterPrevious: { x: 0, y: 0 }, near: 0.1, far: 100, perspective: true, settings: { debugView: DebugView.None, detectShadingChanges: false } };
    return { core, resources, frame, device, encoder: encoder as unknown as GPUCommandEncoder, passes, bindings, uploads, buffers, lose };
}

describe('host-controlled compute encoding', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2 });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('encodes the temporal dispatch order without allocating textures or submitting the host encoder', async () => {
        const f = fixture(); await f.core.prepare(); f.core.encode(f.encoder, f.resources, f.frame);
        expect(f.passes.filter(x => !x.includes('clear'))).toEqual(['upscale-reconstruct', 'upscale-depth-clip', 'upscale-exposure', 'upscale-accumulate', 'upscale-rcas']);
        expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.device.createCommandEncoder).not.toHaveBeenCalled(); expect(f.device.queue.submit).not.toHaveBeenCalled();
    });

    it('keeps early and late constants independent on one encoder and freezes geometry', async () => {
        const f = fixture(); await f.core.prepare(); f.core.encodeGuides(f.encoder, f.resources, f.frame);
        expect(() => f.core.encodeGuides(f.encoder, f.resources, f.frame)).toThrow('split');
        expect(() => f.core.configure({ renderWidth: 8, renderHeight: 8, displayWidth: 8, displayHeight: 8 })).toThrow('split');
        expect(() => f.core.encodeUpscale(f.encoder, f.resources, { ...f.frame, jitter: { x: 1, y: 0 } })).toThrow('geometry');
        expect(() => f.core.encodeUpscale(f.encoder, f.resources, { ...f.frame, reset: true })).toThrow('geometry');
        // Separate Three nodes measure their own elapsed time. It is not geometry.
        f.core.encodeUpscale(f.encoder, f.resources, { ...f.frame, deltaTime: 0.02 });
        const writes = f.uploads.filter(w => w.data.length === 64);
        expect(writes[0].buffer).not.toBe(writes[1].buffer);
        expect(writes[0].data[8]).toBe(0.25); expect(writes[1].data[8]).toBe(0.25);
        expect(() => f.core.encodeUpscale(f.encoder, f.resources, f.frame)).toThrow('guides');
    });

    it('rejects aliased history and multisampled input before dispatch', async () => {
        const f = fixture(); await f.core.prepare();
        const history = f.resources.history as { read: TextureResource; write: TextureResource }; history.write = history.read;
        expect(() => f.core.encode(f.encoder, f.resources, f.frame)).toThrow('alias');
        expect(f.passes).toEqual([]);
    });

    it('reset cancels an abandoned split frame and preserves borrowed texture ownership', async () => {
        const f = fixture(); await f.core.prepare(); f.core.encodeGuides(f.encoder, f.resources, f.frame); f.core.resetHistory();
        f.core.encode(f.encoder, f.resources, f.frame); f.core.dispose();
        expect(f.buffers.every(b => b.destroy.mock.calls.length === 1)).toBe(true);
        expect(f.resources.color!.texture.destroy).not.toHaveBeenCalled();
    });

    it('invalidates initialization when disposal races compilation', async () => {
        const f = fixture(); let resolve!: (v: { getBindGroupLayout: () => object }) => void;
        f.device.createComputePipelineAsync = () => new Promise(r => { resolve = r; });
        const ready = f.core.prepare(); f.core.dispose();
        resolve({ getBindGroupLayout: () => ({}) });
        // Queued compiles are also allowed to settle; the generation must never publish readiness.
        f.lose({ reason: 'destroyed', message: '' } as GPUDeviceLostInfo);
        await expect(ready).rejects.toThrow(); expect(f.core.isReady).toBe(false);
    });

    it('prepares the default shading detector for frames without explicit settings', async () => {
        const f = fixture(); await f.core.prepare({ sharpness: 0.5 });
        f.core.encode(f.encoder, f.resources, { frameIndex: 0 });
        expect(f.passes).toContain('upscale-shading-change');
        expect(f.encoder.copyBufferToTexture).toHaveBeenCalledTimes(2);
    });

    it('accepts a host-written published reactive guide when generation is disabled', async () => {
        const f = fixture(); await f.core.prepare();
        f.resources.reactive = f.resources.reactiveGenerated as TextureResource;
        expect(() => f.core.encode(f.encoder, f.resources, f.frame)).not.toThrow();
        expect(f.passes).not.toContain('upscale-gen-reactive');
    });

    it('snapshots geometry identities even if the caller mutates its wrappers', async () => {
        const f = fixture(); await f.core.prepare(); f.core.encodeGuides(f.encoder, f.resources, f.frame);
        const replacement = fixture().resources.masks as TextureResource;
        Object.assign(f.resources.masks!, replacement);
        expect(() => f.core.encodeUpscale(f.encoder, f.resources, f.frame)).toThrow('geometry resources');
    });

    it('preserves history through a normal swap and resets scratch replacements and accumulation changes', async () => {
        const f = fixture(); await f.core.prepare(); f.core.encode(f.encoder, f.resources, f.frame);
        const lastFlags = () => {
            const writes = f.uploads.filter(w => w.data.length === 64);
            return new Uint32Array(writes.at(-1)!.data.buffer)[20];
        };
        expect(lastFlags() & 1).toBe(1);
        const history = f.resources.history as { read: TextureResource; write: TextureResource };
        [history.read, history.write] = [history.write, history.read];
        f.core.encode(f.encoder, f.resources, { ...f.frame, frameIndex: 1 });
        expect(lastFlags() & 1).toBe(0);
        f.resources.output = fixture().resources.output;
        f.core.encode(f.encoder, f.resources, { ...f.frame, frameIndex: 2 });
        expect(lastFlags() & 1).toBe(1);
        expect(f.encoder.copyBufferToBuffer).toHaveBeenCalledTimes(2);
        f.core.encode(f.encoder, f.resources, { ...f.frame, frameIndex: 3, settings: { ...f.frame.settings, maxAccumulation: 8 } });
        expect(lastFlags() & 1).toBe(1);
        expect(f.encoder.copyBufferToBuffer).toHaveBeenCalledTimes(4);
    });

    it('publishes CPU provided exposure without binding or metering the scene', async () => {
        const f = fixture({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, depthMode: 'linear', exposureMode: 'provided', correctConditioningExposure: true, rcasAgeKnee: 0.5 });
        await f.core.prepare(); f.core.encode(f.encoder, f.resources, { ...f.frame, hostPreExposure: 2, settings: { ...f.frame.settings, exposure: 0.75 } });
        const upload = f.uploads.find(w => w.data.length === 4)!;
        expect(upload.data[0]).toBe(0.75); expect(upload.data[1]).toBe(2);
        const exposureGroup = f.bindings.find(b => b.label === 'upscale-exposure')!;
        expect(exposureGroup.entries).toHaveLength(4);
        expect(Array.from(exposureGroup.entries, e => e.resource)).not.toContain(f.resources.color!.view);
    });

    it('rejects cross-resource aliases and multisampled depth before dispatch', async () => {
        const f = fixture(); await f.core.prepare();
        (f.resources.depth!.texture as unknown as { sampleCount: number }).sampleCount = 4;
        expect(() => f.core.encode(f.encoder, f.resources, f.frame)).toThrow('single-sample');
        (f.resources.depth!.texture as unknown as { sampleCount: number }).sampleCount = 1;
        f.resources.color = (f.resources.history as { write: TextureResource }).write;
        // Restore matching render dimensions for a NativeAA alias test.
        const g = fixture({ renderWidth: 4, renderHeight: 4, displayWidth: 4, displayHeight: 4 }); await g.core.prepare();
        g.resources.color = (g.resources.history as { write: TextureResource }).write;
        expect(() => g.core.encode(g.encoder, g.resources, g.frame)).toThrow('alias');
        expect(g.passes).toEqual([]);
    });

    it('requires new variant compilation and invalidates stale asynchronous preparation', async () => {
        const f = fixture(); let resolve!: (v: { getBindGroupLayout: () => object }) => void;
        f.device.createComputePipelineAsync = () => new Promise(r => { resolve = r; });
        const old = f.core.prepare();
        f.core.configure({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, depthMode: 'linear' });
        resolve({ getBindGroupLayout: () => ({}) });
        await expect(old).rejects.toThrow('cancelled'); expect(f.core.isReady).toBe(false);
        f.core.dispose();
    });
});
