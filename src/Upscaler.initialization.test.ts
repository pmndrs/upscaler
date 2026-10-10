import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Texture, DepthTexture, FloatType, HalfFloatType, RedFormat } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { Upscaler } from './Upscaler.js';
import { UpscalerNotReadyError } from './initializationError.js';
import { MomentsPass } from './MomentsPass.js';
import { DebugView } from './types.js';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
function fixture() {
    const lost = deferred<GPUDeviceLostInfo>();
    const jobs: Array<{ label: string; resolve(value: GPUComputePipeline): void; reject(error: unknown): void }> = [];
    const resource = (descriptor: { size?: number | { width: number; height: number }; width?: number; height?: number; format?: string; usage?: number } = {}) => ({
        width: descriptor.width ?? (typeof descriptor.size === 'object' ? descriptor.size.width : 16),
        height: descriptor.height ?? (typeof descriptor.size === 'object' ? descriptor.size.height : 16), sampleCount: 1,
        format: descriptor.format ?? 'rgba16float', usage: descriptor.usage ?? 12, createView: () => ({}), destroy: vi.fn(),
        getMappedRange: () => new ArrayBuffer(typeof descriptor.size === 'number' ? descriptor.size : 4), unmap: vi.fn(),
        getBindGroupLayout: () => ({}),
    });
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}), copyBufferToBuffer() {}, copyBufferToTexture() {},
    };
    const device = {
        lost: lost.promise, features: new Set(),
        limits: {
            maxBindGroups: 4, maxBindingsPerBindGroup: 1000, maxSampledTexturesPerShaderStage: 16,
            maxStorageTexturesPerShaderStage: 8, maxStorageBuffersPerShaderStage: 8,
            maxUniformBuffersPerShaderStage: 12, maxSamplersPerShaderStage: 16,
            maxUniformBufferBindingSize: 65536, maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256, maxComputeInvocationsPerWorkgroup: 256,
            maxComputeWorkgroupStorageSize: 16384,
        },
        queue: { writeBuffer: vi.fn(), writeTexture: vi.fn(), submit: vi.fn() },
        createShaderModule: vi.fn(resource),
        createComputePipelineAsync: vi.fn((descriptor: GPUComputePipelineDescriptor) =>
            new Promise<GPUComputePipeline>((resolve, reject) => jobs.push({ label: descriptor.label!, resolve, reject }))),
        createBuffer: resource, createSampler: resource, createTexture: resource,
        createBindGroup: resource, createCommandEncoder: vi.fn(() => encoder),
    };
    const renderer = {
        backend: { device, get: (texture: Texture) => ({ texture: resource({
            width: (texture.image as { width?: number } | null)?.width ?? 21, height: (texture.image as { height?: number } | null)?.height ?? 21,
            format: (texture as DepthTexture).isDepthTexture ? 'depth32float' : texture.format === RedFormat ? 'r32float' : texture.type === HalfFloatType ? 'rgba16float' : texture.type === FloatType ? 'rgba32float' : 'rgba8unorm',
        }) }) }, initTexture() {},
    } as unknown as WebGPURenderer;
    const upscaler = new Upscaler({ renderer });
    const finish = async () => {
        for (let i = 0; i < 30; i++) {
            jobs.splice(0).forEach(job => job.resolve(resource() as unknown as GPUComputePipeline));
            await Promise.resolve();
        }
    };
    return { upscaler, device, renderer, jobs, lost, finish };
}

describe('Upscaler preparation', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2 });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('checks capability without allocating, including absent optional timestamps', () => {
        const { device } = fixture();
        expect(Upscaler.isSupported(device as unknown as GPUDevice)).toBe(true);
        device.limits.maxComputeInvocationsPerWorkgroup = 32;
        expect(Upscaler.isSupported(device as unknown as GPUDevice)).toBe(false);
        expect(device.createShaderModule).not.toHaveBeenCalled();
        expect(device.createComputePipelineAsync).not.toHaveBeenCalled();
    });

    it('allocates synchronously but refuses dispatch until mandatory pipelines resolve', async () => {
        const { upscaler, device, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        expect(upscaler.outputTexture).toBeDefined();
        expect(upscaler.isReady).toBe(false);
        expect(() => upscaler.dispatch({ color: new Texture() }, new PerspectiveCamera())).toThrow('await init()');
        expect(() => upscaler.dispatch({ color: new Texture() }, new PerspectiveCamera())).toThrow(UpscalerNotReadyError);
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        const ready = upscaler.init();
        await finish(); await ready;
        expect(upscaler.isReady).toBe(true);
    });

    it('does not warn for correctly awaited initialization', async () => {
        const { upscaler, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        const ready = upscaler.init(); await finish(); await ready;
        upscaler.dispatch({ color: new Texture() }, new PerspectiveCamera());
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('handles an ignored preparation rejection while preserving rejection for awaiters', async () => {
        const { upscaler, jobs } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        const ignored = upscaler.init();
        jobs.splice(0).forEach(job => job.reject(new Error('ignored compile failure')));
        // Allow the unhandled-rejection checkpoint before attaching the consumer catch.
        await new Promise(resolve => setTimeout(resolve, 0));
        await expect(ignored).rejects.toThrow('ignored compile failure');
        expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('compiles only the configured path and preserves sharing across disposal', async () => {
        const { upscaler, device, renderer, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'spatial' });
        const ready = upscaler.init();
        await finish(); await ready;
        expect(device.createComputePipelineAsync.mock.calls.map(([d]) => d.label).sort())
            .toEqual(['upscale-blit', 'upscale-easu', 'upscale-rcas']);
        const other = new Upscaler({ renderer });
        other.configure({ displayWidth: 64, displayHeight: 64, path: 'spatial' });
        await other.init();
        upscaler.dispose();
        expect(other.isReady).toBe(true);
        expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(3);
    });

    it('does not revive a disposed instance when compilation resolves', async () => {
        const { upscaler, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        const ready = upscaler.init();
        const rejected = expect(ready).rejects.toThrow('cancelled');
        upscaler.dispose();
        await finish(); await rejected;
        expect(upscaler.isReady).toBe(false);
    });

    it('keeps newly enabled optional features inactive until a later frame, freezing split settings', async () => {
        const { upscaler, finish, jobs } = fixture();
        upscaler.settings.detectShadingChanges = false;
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'temporal' });
        const ready = upscaler.init(); await finish(); await ready;
        const color = new Texture(), depth = new DepthTexture(21, 21), velocity = new Texture();
        const camera = new PerspectiveCamera();
        upscaler.settings.debugView = DebugView.MotionVectors;
        upscaler.dispatch({ color, depth, velocity }, camera);
        expect(upscaler.activeDebugView).toBe(DebugView.None);
        expect(jobs.some(job => job.label === 'upscale-debug')).toBe(true);
        await finish();
        upscaler.beginFrame(camera);
        const appliedJitter = { ...upscaler.jitter };
        upscaler.endFrame(camera);
        upscaler.dispatchGuides({ depth, velocity }, camera);
        expect(upscaler.jitter).toEqual(appliedJitter);
        expect(upscaler.activeDebugView).toBe(DebugView.MotionVectors);
        upscaler.settings.debugView = DebugView.None;
        upscaler.dispatchUpscale({ color }, camera);
        expect(upscaler.activeDebugView).toBe(DebugView.MotionVectors);
        upscaler.dispatch({ color, depth, velocity }, camera);
        expect(upscaler.activeDebugView).toBe(DebugView.None);
    });

    it('prepares only geometry for guides-only consumers', async () => {
        const { upscaler, device, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'guides' });
        const ready = upscaler.init(); await finish(); await ready;
        expect(device.createComputePipelineAsync.mock.calls.map(([d]) => d.label).sort())
            .toEqual(['upscale-depth-clip', 'upscale-reconstruct']);
        expect(upscaler.guides.dilatedDepth).toBeDefined();
    });

    it('passes independent core variants through the Three facade', async () => {
        const { upscaler, device, finish } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, depthMode: 'linear', exposureMode: 'provided', correctConditioningExposure: true, rcasAgeKnee: 0.5 });
        const ready = upscaler.prepare(); await finish(); await ready;
        const shaders = device.createShaderModule.mock.calls.map(([d]) => (d as unknown as GPUShaderModuleDescriptor).code).join('\n');
        expect(shaders).toContain('smoothstep(0.0, 0.500000000');
        expect(shaders).toContain('var sceneDepth : texture_2d<f32>');
        expect(shaders).toContain('hostRatio *= exposure / conditioningPrev');
        expect(shaders).toContain('var published : texture_storage_2d<rgba32float');
        expect(upscaler.guides.exposure?.type).toBe(FloatType);
    });

    it('retries failures only through explicit preparation', async () => {
        const { upscaler, device, finish, jobs } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        const rejected = expect(upscaler.init()).rejects.toThrow('injected failure');
        jobs.splice(0).forEach(job => job.reject(new Error('injected failure')));
        await rejected;
        upscaler.configure({ displayWidth: 64, displayHeight: 64, path: 'bilinear' });
        await Promise.resolve();
        expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
        const retry = upscaler.prepare(); await finish(); await retry;
        expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
        expect(upscaler.isReady).toBe(true);
    });

    it('invalidates readiness on device loss', async () => {
        const { upscaler, finish, lost } = fixture();
        upscaler.configure({ displayWidth: 32, displayHeight: 32, path: 'bilinear' });
        const ready = upscaler.init(); await finish(); await ready;
        lost.resolve({} as GPUDeviceLostInfo); await Promise.resolve();
        expect(upscaler.isReady).toBe(false);
    });

    it('rejects MomentsPass initialization after device loss instead of returning its old ready promise', async () => {
        const { renderer, lost, finish } = fixture();
        const moments = new MomentsPass({ renderer });
        moments.configure({ width: 16, height: 16 });
        const ready = moments.init(); await finish(); await ready;
        lost.resolve({} as GPUDeviceLostInfo); await Promise.resolve();
        expect(moments.isReady).toBe(false);
        await expect(moments.init()).rejects.toThrow('GPU device lost');
    });
});
