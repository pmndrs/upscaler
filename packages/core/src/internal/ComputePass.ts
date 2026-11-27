/**
 * Small wrapper around a WGSL compute pipeline with a single bind group.
 *
 * All FSR passes share the shape: one shader module, one auto-derived bind
 * group layout, 8×8 workgroups over a 2D grid. Bind groups are (re)built by
 * the upscaler whenever textures resize or ping-pong, so `dispatch` takes
 * the group per call instead of caching it here.
 */
export interface ComputePassOptions {
    /** Compile-time values for WGSL `override` declarations. */
    constants?: Record<string, GPUPipelineConstantValue>;
    /** Stable shader identity included in benchmark evidence. */
    shaderKey?: string;
    /** Ordered TypeScript-assembled WGSL chunk identities. */
    assembledChunks?: readonly string[];
}

/** Immutable pipeline construction metadata used by benchmark evidence. */
export interface ComputePassMetadata {
    shaderKey: string;
    constants: Readonly<Record<string, GPUPipelineConstantValue>>;
    assembledChunks: readonly string[];
}

interface DeviceCache {
    modules: Map<string, GPUShaderModule>;
    pipelines: Map<string, Promise<GPUComputePipeline>>;
    queue: Array<() => void>;
    active: number;
    lost: boolean;
}

const caches = new WeakMap<GPUDevice, DeviceCache>();
const COMPILE_CONCURRENCY = 4;

function deviceCache(device: GPUDevice): DeviceCache {
    let cache = caches.get(device);
    if (cache) return cache;
    cache = { modules: new Map(), pipelines: new Map(), queue: [], active: 0, lost: false };
    caches.set(device, cache);
    const current = cache;
    void device.lost.then(() => {
        current.lost = true;
        current.modules.clear();
        current.pipelines.clear();
        // Drain queued tasks so their promises reject rather than hang forever.
        for (const task of current.queue.splice(0)) task();
    });
    return cache;
}

/** An explicit pipeline layout and entry point, for kernels another generator emits. */
export interface ExplicitPipelineOptions {
    entryPoint: string;
    layout: GPUPipelineLayout;
    /** Names the layout in the cache key: equal keys must mean group-equivalent layouts. */
    layoutKey: string;
}

function compile(
    device: GPUDevice, label: string, code: string,
    options: ComputePassOptions & Partial<ExplicitPipelineOptions>,
): Promise<GPUComputePipeline> {
    const cache = deviceCache(device);
    if (cache.lost) return Promise.reject(new Error('@pmndrs/upscaler: GPU device lost.'));
    const entryPoint = options.entryPoint ?? 'main';
    const layout = options.layout ?? 'auto';
    const constants = Object.fromEntries(Object.entries(options.constants ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const key = JSON.stringify([code, entryPoint, options.layoutKey ?? 'auto', Object.entries(constants).map(
        ([name, value]) => [name, typeof value, Object.is(value, -0) ? '-0' : String(value)],
    )]);
    const existing = cache.pipelines.get(key);
    if (existing) return existing;
    const pipeline = new Promise<GPUComputePipeline>((resolve, reject) => {
        const start = (): void => {
            if (cache.lost) { reject(new Error('@pmndrs/upscaler: GPU device lost.')); return; }
            cache.active++;
            void (async () => {
                try {
                    let module = cache.modules.get(code);
                    if (!module) {
                        module = device.createShaderModule({ label: `upscale-${label}`, code });
                        cache.modules.set(code, module);
                    }
                    const result = await device.createComputePipelineAsync({
                        label: `upscale-${label}`, layout,
                        compute: { module, entryPoint, constants },
                    });
                    if (cache.lost) throw new Error('@pmndrs/upscaler: GPU device lost.');
                    resolve(result);
                } catch (error) { reject(error); }
                finally {
                    cache.active--;
                    if (!cache.lost) cache.queue.shift()?.();
                }
            })();
        };
        if (cache.active < COMPILE_CONCURRENCY) start();
        else cache.queue.push(start);
    });
    cache.pipelines.set(key, pipeline);
    void pipeline.catch(() => {
        if (cache.pipelines.get(key) === pipeline) cache.pipelines.delete(key);
        cache.modules.delete(code);
    });
    return pipeline;
}

/**
 * Compiles a pipeline with an explicit layout and entry point through the same
 * per-device async queue and cache as every {@link ComputePass}: never a
 * synchronous `createComputePipeline` (docs/windows-cross-device.md).
 * @param device - The upscaler's device
 * @param label - Pipeline label (prefixed `upscale-`)
 * @param code - WGSL
 * @param options - Entry point, explicit layout and its cache key
 * @returns The compiled pipeline; rejects on a compile or validation failure
 */
export function compileComputePipeline(
    device: GPUDevice, label: string, code: string, options: ExplicitPipelineOptions,
): Promise<GPUComputePipeline> {
    return compile(device, label, code, options);
}

export class ComputePass {
    static readonly WORKGROUP_SIZE = 8;

    readonly label: string;
    readonly pipeline: GPUComputePipeline;
    readonly metadata: ComputePassMetadata;

    private readonly _device: GPUDevice;

    static async create(device: GPUDevice, label: string, code: string, options: ComputePassOptions = {}): Promise<ComputePass> {
        const snapshot = {
            ...options, constants: { ...options.constants },
            assembledChunks: [...(options.assembledChunks ?? [])],
        };
        return new ComputePass(device, label, await compile(device, label, code, snapshot), snapshot);
    }

    private constructor(device: GPUDevice, label: string, pipeline: GPUComputePipeline, options: ComputePassOptions = {}) {
        this._device = device;
        this.label = label;
        this.metadata = Object.freeze({
            shaderKey: options.shaderKey ?? `baseline:${label}`,
            constants: Object.freeze({ ...options.constants }),
            assembledChunks: Object.freeze([...(options.assembledChunks ?? [])]),
        });
        this.pipeline = pipeline;
    }

    /**
     * Creates a bind group for this pass's group 0.
     * @param entries - Resources in binding order (buffer/view/sampler)
     * @returns The bind group, valid until any bound resource is destroyed
     */
    createBindGroup(entries: Array<GPUBindingResource>): GPUBindGroup {
        return this._device.createBindGroup({
            label: `upscale-${this.label}`,
            layout: this.pipeline.getBindGroupLayout(0),
            entries: entries.map((resource, binding) => ({ binding, resource })),
        });
    }

    /**
     * Encodes this pass covering `width`×`height` invocations.
     * @param encoder - Active compute pass encoder
     * @param bindGroup - Bind group created via {@link createBindGroup}
     * @param width - Grid width in pixels
     * @param height - Grid height in pixels
     */
    dispatch(
        encoder: GPUComputePassEncoder,
        bindGroup: GPUBindGroup,
        width: number,
        height: number,
    ): void {
        const wg = ComputePass.WORKGROUP_SIZE;
        encoder.setPipeline(this.pipeline);
        encoder.setBindGroup(0, bindGroup);
        encoder.dispatchWorkgroups(Math.ceil(width / wg), Math.ceil(height / wg));
    }
}
