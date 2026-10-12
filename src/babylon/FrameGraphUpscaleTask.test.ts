import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { FrameGraphUpscaleTask, getBabylonTextureOptions } from './FrameGraphUpscaleTask.js';
import { getResourceDescriptors } from '../core/resources.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraphTextureCreationOptions } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { resolveBabylonTexture } from './compatibility.js';

describe('Babylon Frame Graph recording', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('maps every history, storage format and odd-sized atlas to Babylon allocation options', () => {
        const descriptors = getResourceDescriptors({ renderWidth: 7, renderHeight: 5, displayWidth: 11, displayHeight: 9, exposureMode: 'provided' });
        for (const d of descriptors) {
            const options = getBabylonTextureOptions(d);
            expect(options.size).toEqual({ width: d.width, height: d.height });
            expect(options.isHistoryTexture).toBe(d.history);
            expect(options.options.creationFlags![0]).toBe(d.usage & 8 ? Constants.TEXTURE_CREATIONFLAG_STORAGE : 0);
        }
        expect(getBabylonTextureOptions(descriptors.find(d => d.name === 'shadingBlockMemory')!).options.formats).toEqual([Constants.TEXTUREFORMAT_RGBA_INTEGER]);
        expect(getBabylonTextureOptions(descriptors.find(d => d.name === 'exposure')!).options.types).toEqual([Constants.TEXTURETYPE_FLOAT]);
    });
    it.each(['temporal', 'spatial', 'bilinear'] as const)('records %s with only the inputs required by that path', path => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 });
        let handle = 10;
        const passes: { disabled: boolean; output?: number; dependencies: number[] }[] = [];
        const device = { lost: new Promise(() => {}), createBuffer: (d: { size: number }) => ({ getMappedRange: () => new ArrayBuffer(d.size), unmap() {}, destroy() {} }), createSampler: () => ({}) };
        const graph = {
            engine: { _device: device, _renderEncoder: {}, _endCurrentRenderPass() {} },
            textureManager: { createDanglingHandle: () => handle++, createRenderTargetTexture: () => handle++, resolveDanglingHandle: vi.fn() },
            addRenderPass: (_name: string, disabled: boolean) => {
                const p = { disabled, dependencies: [] as number[], output: undefined as number | undefined }; passes.push(p);
                return { setRenderTarget: (h: number) => { p.output = h; }, addDependencies: (h: number[]) => p.dependencies.push(...h), setExecuteFunc() {} };
            },
        };
        const task = new FrameGraphUpscaleTask('test', graph as unknown as FrameGraph, { configuration: { renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, path }, frame: () => ({ frameIndex: 0 }) });
        task.colorTexture = 1;
        if (path === 'temporal') { task.depthTexture = 2; task.velocityTexture = 3; task.reactiveTexture = 4; task.exposureTexture = 5; }
        task.record();
        expect(passes.map(p => p.disabled)).toEqual([false, true]);
        expect(passes[0].output).toBe(passes[1].output);
        expect(passes[0].dependencies).toEqual(passes[1].dependencies);
        const inputs = path === 'temporal' ? [1, 2, 3, 4, 5] : [1];
        expect(passes[0].dependencies.slice(0, inputs.length)).toEqual(inputs);
        expect(passes[0].dependencies).toHaveLength(inputs.length + getResourceDescriptors({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, path }).length);
        const projection = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]), clone() { return { ...this, fromArray() {} }; } };
        const camera = { getProjectionMatrix: () => projection, freezeProjectionMatrix() {}, unfreezeProjectionMatrix() {} };
        task.beginFrame(camera as unknown as Parameters<typeof task.beginFrame>[0]);
        if (path !== 'temporal') expect(task.jitter).toEqual({ x: 0, y: 0 });
        task.endFrame();
        expect(task.isReady()).toBe(false);
        task.disabled = true; expect(() => { task.disabled = false; }).toThrow('activate'); task.dispose();
    });
});

// Keep the real adapter and core; only replace the unavailable GPU/host allocation boundary.
function splitFixture() {
    let nextHandle = 10;
    let frameIndex = 0;
    const events: string[] = [];
    const uploads: Float32Array[] = [];
    const aliases = new Map<number, number>();
    const allocations = new Map<number, { name: string; read: object; write: object }>();
    const unavailable = new Set<number>();
    const passes: { name: string; disabled: boolean; output?: number | number[]; dependencies: number[]; execute: () => void }[] = [];
    const device = {
        lost: new Promise(() => {}),
        createBuffer: (d: GPUBufferDescriptor) => ({ getMappedRange: () => new ArrayBuffer(Number(d.size)), unmap() {}, destroy() {} }),
        createSampler: () => ({}), createShaderModule: () => ({}),
        createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }), createBindGroup: () => ({}),
        queue: { writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer) => uploads.push(new Float32Array(data.slice(0))) },
    };
    const encoder = { beginComputePass: (d: GPUComputePassDescriptor) => { events.push(d.label!); return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }; }, copyBufferToBuffer() {}, copyBufferToTexture() {} };
    const texture = (width: number, height: number, format: string, usage = 12) => {
        const raw = { width, height, format, usage, sampleCount: 1, createView: () => ({}) };
        return { _hardwareTexture: { underlyingResource: raw } };
    };
    const manager = {
        createDanglingHandle: () => nextHandle++,
        createRenderTargetTexture: (name: string, options: FrameGraphTextureCreationOptions) => {
            const handle = nextHandle++;
            const size = options.size as { width: number; height: number };
            const format = options.options.formats![0] === Constants.TEXTUREFORMAT_RED ? options.options.types![0] === Constants.TEXTURETYPE_FLOAT ? 'r32float' : 'r8unorm'
                : options.options.types![0] === Constants.TEXTURETYPE_UNSIGNED_INTEGER ? 'rgba32uint'
                    : options.options.types![0] === Constants.TEXTURETYPE_HALF_FLOAT ? 'rgba16float' : 'rgba8unorm';
            const create = () => texture(size.width, size.height, format, name.endsWith('dummy') ? 4 : name.endsWith('shadingBlockMemory') ? 14 : 12);
            const write = create(); allocations.set(handle, { name, read: options.isHistoryTexture ? create() : write, write }); return handle;
        },
        resolveDanglingHandle: (handle: number, target: number) => aliases.set(handle, target),
        getTextureFromHandle: (handle: number, write = false) => {
            if (unavailable.has(handle)) throw new Error('final color is not available before its consumer executes');
            return allocations.get(aliases.get(handle) ?? handle)?.[write ? 'write' : 'read'];
        },
    };
    for (const [handle, name, format] of [[1, 'color', 'rgba16float'], [2, 'depth', 'r32float'], [3, 'velocity', 'rgba16float']] as const) {
        const value = texture(4, 4, format); allocations.set(handle, { name, read: value, write: value });
    }
    const graph = {
        tasks: [] as FrameGraphTask[], engine: { _device: device, _renderEncoder: encoder, _endCurrentRenderPass() {} }, textureManager: manager,
        addRenderPass: (name: string, disabled = false) => {
            const pass = { name, disabled, dependencies: [] as number[], output: undefined as number | number[] | undefined, execute: () => {} }; passes.push(pass);
            return { setRenderTarget: (h: number | number[]) => { pass.output = h; }, addDependencies: (h: number[]) => pass.dependencies.push(...h), setExecuteFunc: (f: () => void) => { pass.execute = f; } };
        },
    };
    const configuration = { renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, depthMode: 'linear' as const };
    const task = new FrameGraphUpscaleTask('split', graph as unknown as FrameGraph, { configuration, frame: () => ({ frameIndex, jitter: { x: 0.25, y: -0.25 } }), settings: { detectShadingChanges: false } });
    task.colorTexture = 1; task.depthTexture = 2; task.velocityTexture = 3;
    const split = () => { const early = task.createGuidesTask(); graph.tasks.push(early, task); early.record(); task.record(); return early; };
    return { task, graph, manager, device, aliases, allocations, unavailable, passes, events, uploads, configuration, split, nextFrame: () => frameIndex++ };
}

describe('Babylon shared guides and split encoding', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2 });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('shares in-flight preparation and retries a transient compilation failure', async () => {
        const f = splitFixture();
        const failure = new Error('transient compilation failure');
        const compile = vi.spyOn(f.device, 'createComputePipelineAsync').mockRejectedValueOnce(failure);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const first = f.task.prepare();
            expect(f.task.prepare()).toBe(first);
            await expect(first).rejects.toBe(failure);
            const calls = compile.mock.calls.length;
            await expect(f.task.prepare()).resolves.toBeUndefined();
            expect(compile.mock.calls.length).toBeGreaterThan(calls);
            expect(f.task.isReady()).toBe(true);
        } finally { log.mockRestore(); f.task.dispose(); }
    });

    it('keeps new preparation cached when obsolete compilation rejects after reconfiguration', async () => {
        const f = splitFixture();
        let rejectOld!: (reason: Error) => void;
        const compile = vi.spyOn(f.device, 'createComputePipelineAsync');
        compile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
        const obsolete = f.task.prepare();
        const obsoleteResult = expect(obsolete).rejects.toThrow();
        f.task.configure({ ...f.configuration, depthMode: 'hardware' });
        const current = f.task.prepare();
        rejectOld(new Error('obsolete compilation failed'));
        await obsoleteResult;
        await current;
        expect(f.task.prepare()).toBe(current);
        expect(f.task.isReady()).toBe(true);
        f.task.dispose();
    });

    it('publishes the current depth history and reuses one allocation set across both phases', () => {
        const f = splitFixture(); const early = f.split();
        const guides = { ...f.task.guides };
        expect(f.allocations.size).toBe(15); // 3 inputs + 12 temporal working resources.
        for (const [name, handle] of Object.entries(guides)) {
            const entry = f.allocations.get(f.aliases.get(handle)!)!;
            expect(entry.name).toBe(`split-${name === 'disocclusion' ? 'masks' : name}`);
        }
        const current = resolveBabylonTexture(f.manager as never, guides.dilatedDepth, true);
        const previous = resolveBabylonTexture(f.manager as never, guides.dilatedDepth);
        expect(current.texture).not.toBe(previous.texture);
        expect(f.passes[0].dependencies).not.toContain(1);
        expect(f.passes[0].dependencies).toEqual(expect.arrayContaining([2, 3, ...[...f.allocations.keys()].filter(handle => handle > 3)]));
        expect(f.passes[1].dependencies).toEqual(expect.arrayContaining([...f.allocations.keys()]));
        early.record(); f.task.record();
        expect(f.task.guides).toEqual(guides);
    });

    it('runs guides, an external consumer, then upscale exactly once with final color available only late', async () => {
        const f = splitFixture(); f.split(); await f.task.prepare(); f.unavailable.add(1);
        f.passes[0].execute(); f.events.push('consumer'); f.unavailable.delete(1); f.passes[1].execute();
        expect(f.events).toEqual(['upscale-reconstruct', 'upscale-depth-clip', 'consumer', 'upscale-exposure', 'upscale-accumulate', 'upscale-rcas']);
        f.nextFrame(); f.passes[0].execute(); f.passes[1].execute();
        const constants = f.uploads.filter(data => data.length === 64);
        expect(new Uint32Array(constants.at(-1)!.buffer)[20] & 1).toBe(0);
    });

    it('keeps the unsplit path intact and publishes guides from its full dispatch', async () => {
        const f = splitFixture(); f.task.record(); await f.task.prepare(); f.passes[0].execute();
        expect(f.events).toEqual(['upscale-reconstruct', 'upscale-depth-clip', 'upscale-exposure', 'upscale-accumulate', 'upscale-rcas']);
        expect(f.aliases.has(f.task.guides.disocclusion)).toBe(true);
    });

    it('rejects a missing or misplaced guides task and a late phase executed without guides', async () => {
        const f = splitFixture(); const early = f.task.createGuidesTask();
        f.graph.tasks.push(f.task);
        expect(() => f.task.record()).toThrow(/guides.*before/i);
        f.graph.tasks.push(early);
        expect(() => early.record()).toThrow(/guides.*before/i);
        f.graph.tasks.reverse(); early.record(); f.task.record(); await f.task.prepare();
        expect(() => f.passes[1].execute()).toThrow(/guides/i);
    });

    it('encodes valid guides while disabled, cancels pending temporal work for bilinear, and resets on reactivation', async () => {
        const f = splitFixture(); f.split(); await f.task.prepare(); f.task.disabled = true;
        f.passes[0].execute(); f.passes[2].execute();
        expect(f.events).toEqual(['upscale-reconstruct', 'upscale-depth-clip', 'upscale-blit']);
        expect([...f.uploads.find(data => data.length === 64)!.slice(8, 12)]).toEqual([0, 0, 0, 0]);
        f.task.disabled = false; f.nextFrame(); f.passes[0].execute(); f.passes[1].execute();
        const constants = f.uploads.filter(data => data.length === 64);
        expect(new Uint32Array(constants.at(-1)!.buffer)[20] & 1).toBe(1);
    });

    it('rejects reconfiguration or repeated early dispatch during a split frame and allows explicit abandonment', async () => {
        const f = splitFixture(); f.split(); await f.task.prepare(); f.passes[0].execute();
        expect(() => f.task.configure(f.configuration)).toThrow(/split frame/i);
        expect(() => f.passes[0].execute()).toThrow(/split frame/i);
        f.task.resetHistory(); f.task.configure(f.configuration);
        expect(f.task.isReady()).toBe(false);
    });

    it('rejects geometry changes between phases and cancels abandoned work at endFrame', async () => {
        const f = splitFixture(); f.split(); await f.task.prepare(); f.passes[0].execute(); f.nextFrame();
        expect(() => f.passes[1].execute()).toThrow(/geometry/i);
        f.task.endFrame(); f.passes[0].execute(); f.passes[1].execute();
    });

    it('restricts split guides to the temporal path', () => {
        const f = splitFixture(); f.task.configure({ ...f.configuration, path: 'spatial' });
        expect(() => f.task.createGuidesTask()).toThrow(/temporal/i);
    });
});
