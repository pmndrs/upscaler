import { createScalarKernel, scalarLayoutEntries, type ScalarKernelOptions } from '@pmndrs/downsampler/webgpu';

import {
    EXPOSURE_EVERY_QUAD_BINDINGS,
    EXPOSURE_EVERY_QUAD_LOAD,
    EXPOSURE_EVERY_TEXEL_BINDINGS,
    EXPOSURE_EVERY_TEXEL_LOAD,
    exposureEveryTexelFinish,
} from '../shaders/luminancePyramid';
import { compileComputePipeline } from './ComputePass';

const COMPUTE = 0x4; // GPUShaderStage.COMPUTE (no global in Node, where the tests import this)

// Group 1 of the scalar, in the production pass's binding numbers. Textures
// other than a sampled color are read with textureLoad only, so
// 'unfilterable-float' also admits an r32float external exposure without the
// float32-filterable feature.
const SHARED_ENTRIES: GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
    { binding: 3, visibility: COMPUTE, texture: { sampleType: 'unfilterable-float' } },
    { binding: 4, visibility: COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
    { binding: 5, visibility: COMPUTE, texture: { sampleType: 'unfilterable-float' } },
    { binding: 6, visibility: COMPUTE, texture: { sampleType: 'unfilterable-float' } },
    // The GPU reset signal (issue #102): the shared epilogue folds it into .a.
    { binding: 7, visibility: COMPUTE, texture: { sampleType: 'unfilterable-float' } },
];
const TEXEL_ENTRIES: GPUBindGroupLayoutEntry[] = [
    ...SHARED_ENTRIES,
    { binding: 1, visibility: COMPUTE, texture: { sampleType: 'unfilterable-float' } },
];
// The quad form samples the color (bilinear at quad corners), like the taps.
const QUAD_ENTRIES: GPUBindGroupLayoutEntry[] = [
    ...SHARED_ENTRIES,
    { binding: 1, visibility: COMPUTE, texture: { sampleType: 'float' } },
    { binding: 2, visibility: COMPUTE, sampler: { type: 'filtering' } },
];

// The scalar's tile: 16×16 invocations of BLOCK×BLOCK texels each. Our own
// dispatch mirrors the library's ScalarReduction (scalarWorkgroups) and its
// `DsParams` uniform, which shaders.test.ts pins against the generated WGSL.
const BLOCK = 4;
const TILE = 16 * BLOCK;
const PARAMS_BYTES = 32;
const PARTIAL_BYTES = 16; // one vec4f per workgroup
const SCOPES: GPUErrorFilter[] = ['validation', 'internal', 'out-of-memory'];

/** Which texels the scalar reads: each render texel, or each 2×2 quad's box average. */
export type EveryTexelExposureForm = 'texel' | 'quad';

/**
 * The scalar's `@group(1)` layout for a form (also what the WGSL declares).
 * @param form - 'texel' or 'quad'
 * @returns The layout entries
 */
export function everyTexelExposureLayout(form: EveryTexelExposureForm): GPUBindGroupLayoutEntry[] {
    return form === 'quad' ? QUAD_ENTRIES : TEXEL_ENTRIES;
}

/**
 * The generator options of a form: the average of the per-texel log luma in
 * channel x (y–w summed as 0), our bindings in group 1, our epilogue as `finish`.
 * @param form - 'texel' or 'quad'
 * @param deadband - Keep the 1/16-stop adaptation dead-band (production)
 * @returns Options for `createScalarKernel` / `scalarLayoutEntries`
 */
export function everyTexelKernelOptions(form: EveryTexelExposureForm, deadband = true): ScalarKernelOptions {
    const quad = form === 'quad';
    return {
        reduction: ['average', 'sum', 'sum', 'sum'],
        block: BLOCK,
        bindings: {
            wgsl: quad ? EXPOSURE_EVERY_QUAD_BINDINGS : EXPOSURE_EVERY_TEXEL_BINDINGS,
            entries: everyTexelExposureLayout(form),
        },
        load: quad ? EXPOSURE_EVERY_QUAD_LOAD : EXPOSURE_EVERY_TEXEL_LOAD,
        finish: exposureEveryTexelFinish(deadband),
    };
}

/**
 * Workgroups of the partials dispatch and the `DsParams` words for a metered
 * grid (the render, or its ⌈w/2⌉×⌈h/2⌉ quads).
 * @param width - Metered grid width
 * @param height - Metered grid height
 * @returns `[groupsX, groupsY]` and the uniform's six u32 words
 */
export function everyTexelDispatchShape(width: number, height: number): { groups: [number, number]; params: number[] } {
    const groupsX = Math.ceil(width / TILE);
    const groupsY = Math.ceil(height / TILE);
    // size, firstLayer, groupsX, partialCount, count (the texels averaged).
    return { groups: [groupsX, groupsY], params: [width, height, 0, groupsX, groupsX * groupsY, width * height] };
}

/**
 * Runs synchronous resource creation inside validation, internal and
 * out-of-memory scopes and rejects if any of them caught an error, so nothing
 * created here is ever bound while invalid (the #31 GpuTimer pattern).
 * @param device - The device the work creates on
 * @param work - The creation calls
 * @returns What `work` returned, once every scope popped clean
 */
async function scoped<T>(device: GPUDevice, work: () => T): Promise<T> {
    for (const filter of SCOPES) device.pushErrorScope(filter);
    let value: T | undefined;
    let thrown: unknown = null;
    try { value = work(); } catch (error) { thrown = error; }
    const errors: Array<GPUError | null> = [];
    for (let i = 0; i < SCOPES.length; i++) errors.push(await device.popErrorScope());
    if (thrown) throw thrown;
    const error = errors.find(Boolean);
    if (error) throw new Error(`@pmndrs/upscaler: every-texel exposure: ${error.message}`);
    return value as T;
}

interface Layouts {
    group0: GPUBindGroupLayout;
    group1: GPUBindGroupLayout;
    pipeline: GPUPipelineLayout;
}

// Layouts per device and form, shared by every instance, so the pipeline
// cache's layout key always names the same layout.
const layoutCache = new WeakMap<GPUDevice, Map<EveryTexelExposureForm, Layouts>>();

interface SizeState {
    key: string;
    ready: boolean;
    groups: [number, number];
    params: GPUBuffer | null;
    partials: GPUBuffer | null;
    group0: GPUBindGroup | null;
}

/** The resources of one frame's metering, in the production pass's terms. */
export interface EveryTexelExposureFrame {
    constants: GPUBuffer;
    color: GPUTextureView;
    /** Linear clamp sampler (the quad form). */
    sampler: GPUSampler;
    previous: GPUTextureView;
    next: GPUTextureView;
    external: GPUTextureView;
    host: GPUTextureView;
    /** GPU reset signal (`.r > 0.5` = reset), or the zero dummy. */
    reset: GPUTextureView;
}

/**
 * Auto-exposure metered over every render texel, FSR 3's luma-pyramid shape
 * (log-average luma to 1×1): the WGSL of `@pmndrs/downsampler`'s scalar
 * reduction (64×64-texel workgroup partials, then one 256-invocation combine
 * whose `finish` is the production epilogue), compiled through our async
 * pipeline queue and dispatched here, two dispatches into the caller's pass.
 * (The library's ScalarReduction class would build its pipelines with the
 * synchronous `createComputePipeline`.) Production for renders up to 2^19
 * texels (≈960×540); the 1024 bilinear taps above, and until this is ready
 * (UpscalerCore, bench/docs/NEXT-STEPS.md §17).
 */
export class EveryTexelExposure {
    private _size: SizeState | null = null;
    private _sizing: Promise<void> | null = null;

    private constructor(
        private readonly _device: GPUDevice,
        private readonly _form: EveryTexelExposureForm,
        private readonly _layouts: Layouts,
        private readonly _partials: GPUComputePipeline,
        private readonly _combine: GPUComputePipeline,
    ) {}

    /**
     * Compiles both entry points with `createComputePipelineAsync`, never
     * synchronously. Rejects on any compile or layout error.
     * @param device - The upscaler's device (256 invocations per workgroup, the WebGPU default)
     * @param form - Each render texel ('texel') or each 2×2 quad's box average ('quad')
     * @param deadband - Keep the 1/16-stop adaptation dead-band (production)
     * @returns The compiled metering, without size resources (see {@link resize})
     */
    static async create(device: GPUDevice, form: EveryTexelExposureForm, deadband = true): Promise<EveryTexelExposure> {
        const options = everyTexelKernelOptions(form, deadband);
        const code = createScalarKernel(options);
        let byForm = layoutCache.get(device);
        if (!byForm) layoutCache.set(device, byForm = new Map());
        let layouts = byForm.get(form);
        if (!layouts) {
            layouts = await scoped(device, () => {
                const group0 = device.createBindGroupLayout({
                    label: 'upscale-exposure-every-texel-0', entries: scalarLayoutEntries(options),
                });
                const group1 = device.createBindGroupLayout({
                    label: 'upscale-exposure-every-texel-1', entries: everyTexelExposureLayout(form),
                });
                const pipeline = device.createPipelineLayout({
                    label: 'upscale-exposure-every-texel', bindGroupLayouts: [group0, group1],
                });
                return { group0, group1, pipeline };
            });
            byForm.set(form, layouts);
        }
        const pipelineLayout = layouts.pipeline;
        const compile = (entryPoint: 'partials' | 'combine') => compileComputePipeline(
            device, `exposure-every-texel-${entryPoint}`, code,
            { entryPoint, layout: pipelineLayout, layoutKey: `exposure-every-texel-${form}` },
        );
        const [partials, combine] = await Promise.all([compile('partials'), compile('combine')]);
        return new EveryTexelExposure(device, form, layouts, partials, combine);
    }

    /** True once the current size's buffers exist and allocated cleanly. */
    get ready(): boolean {
        return this._size?.ready === true;
    }

    /**
     * Allocates the uniform and partials buffers for a render size inside
     * error scopes; {@link ready} stays false until they pop clean. Repeat
     * calls for the same size return the same promise.
     * @param renderWidth - Render width in texels
     * @param renderHeight - Render height in texels
     * @returns Resolves when ready; rejects if allocation failed
     */
    resize(renderWidth: number, renderHeight: number): Promise<void> {
        const quad = this._form === 'quad';
        const width = quad ? Math.ceil(renderWidth / 2) : renderWidth;
        const height = quad ? Math.ceil(renderHeight / 2) : renderHeight;
        const key = `${width}x${height}`;
        if (this._size?.key === key && this._sizing) return this._sizing;
        this._releaseSize();
        const { groups, params: words } = everyTexelDispatchShape(width, height);
        const size: SizeState = { key, ready: false, groups, params: null, partials: null, group0: null };
        this._size = size;
        const device = this._device;
        this._sizing = scoped(device, () => {
            size.params = device.createBuffer({
                label: 'upscale-exposure-every-texel-params', size: PARAMS_BYTES,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(size.params, 0, new Uint32Array([...words, 0, 0]));
            size.partials = device.createBuffer({
                label: 'upscale-exposure-every-texel-partials', size: groups[0] * groups[1] * PARTIAL_BYTES,
                usage: GPUBufferUsage.STORAGE,
            });
            size.group0 = device.createBindGroup({
                label: 'upscale-exposure-every-texel-0', layout: this._layouts.group0,
                entries: [
                    { binding: 0, resource: { buffer: size.params } },
                    { binding: 1, resource: { buffer: size.partials } },
                ],
            });
        }).then(() => { size.ready = true; });
        return this._sizing;
    }

    /**
     * Records both dispatches into a compute pass. Only call while {@link ready}.
     * @param pass - The caller's open compute pass
     * @param frame - This frame's resources
     */
    encodePass(pass: GPUComputePassEncoder, frame: EveryTexelExposureFrame): void {
        const size = this._size!;
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: frame.constants } },
            { binding: 1, resource: frame.color },
            { binding: 3, resource: frame.previous },
            { binding: 4, resource: frame.next },
            { binding: 5, resource: frame.external },
            { binding: 6, resource: frame.host },
            { binding: 7, resource: frame.reset },
        ];
        if (this._form === 'quad') entries.push({ binding: 2, resource: frame.sampler });
        const group1 = this._device.createBindGroup({
            label: 'upscale-exposure-every-texel-1', layout: this._layouts.group1, entries,
        });
        pass.setBindGroup(0, size.group0!);
        pass.setBindGroup(1, group1);
        pass.setPipeline(this._partials);
        pass.dispatchWorkgroups(size.groups[0], size.groups[1], 1);
        pass.setPipeline(this._combine);
        pass.dispatchWorkgroups(1, 1, 1);
    }

    /** Destroys the size buffers. */
    dispose(): void {
        this._releaseSize();
    }

    private _releaseSize(): void {
        this._size?.params?.destroy();
        this._size?.partials?.destroy();
        this._size = null;
        this._sizing = null;
    }
}
