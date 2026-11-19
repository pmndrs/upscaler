import { ScalarReduction } from '@pmndrs/downsampler/webgpu';

import {
    EXPOSURE_EVERY_QUAD_BINDINGS,
    EXPOSURE_EVERY_QUAD_LOAD,
    EXPOSURE_EVERY_TEXEL_BINDINGS,
    EXPOSURE_EVERY_TEXEL_LOAD,
    exposureEveryTexelFinish,
} from '../shaders/luminancePyramid';

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
    /** Render size: the texels that are metered (the color texture may be larger). */
    width: number;
    height: number;
}

/**
 * Auto-exposure metered over every render texel, FSR 3's luma-pyramid shape
 * (log-average luma to 1×1) on `@pmndrs/downsampler`'s `ScalarReduction`:
 * 64×64-texel workgroup partials, then one 256-invocation combine whose
 * `finish` is the production epilogue. Two dispatches into the caller's pass.
 * Production for renders up to 2^19 texels; the 1024 bilinear taps above
 * (UpscalerCore's EVERY_TEXEL_MAX_TEXELS, bench/docs/NEXT-STEPS.md §17).
 */
export class EveryTexelExposure {
    private constructor(
        private readonly _reduction: ScalarReduction,
        private readonly _form: EveryTexelExposureForm,
    ) {}

    /**
     * Builds and compiles the reduction. The library compiles synchronously,
     * so a validation error scope turns a WGSL failure into a rejection, as
     * the async pipelines of every other pass do.
     * @param device - The upscaler's device (256 invocations per workgroup, the WebGPU default)
     * @param form - Each render texel ('texel') or each 2×2 quad's box average ('quad')
     * @param deadband - Keep the 1/16-stop adaptation dead-band (production)
     * @returns The compiled metering
     */
    static async create(device: GPUDevice, form: EveryTexelExposureForm, deadband = true): Promise<EveryTexelExposure> {
        const quad = form === 'quad';
        device.pushErrorScope('validation');
        let reduction: ScalarReduction | null = null;
        let thrown: unknown = null;
        try {
            reduction = new ScalarReduction(device, {
                reduction: ['average', 'sum', 'sum', 'sum'],
                bindings: {
                    wgsl: quad ? EXPOSURE_EVERY_QUAD_BINDINGS : EXPOSURE_EVERY_TEXEL_BINDINGS,
                    entries: everyTexelExposureLayout(form),
                },
                load: quad ? EXPOSURE_EVERY_QUAD_LOAD : EXPOSURE_EVERY_TEXEL_LOAD,
                finish: exposureEveryTexelFinish(deadband),
            });
            reduction.kernel();
        } catch (error) {
            thrown = error;
        }
        const error = await device.popErrorScope();
        if (thrown) throw thrown;
        if (error) throw new Error(`@pmndrs/upscaler: every-texel exposure failed to compile: ${error.message}`);
        return new EveryTexelExposure(reduction!, form);
    }

    /**
     * Records both dispatches into a compute pass.
     * @param pass - The caller's open compute pass
     * @param frame - This frame's resources
     */
    encodePass(pass: GPUComputePassEncoder, frame: EveryTexelExposureFrame): void {
        const device = this._reduction.device;
        const quad = this._form === 'quad';
        const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: { buffer: frame.constants } },
            { binding: 1, resource: frame.color },
            { binding: 3, resource: frame.previous },
            { binding: 4, resource: frame.next },
            { binding: 5, resource: frame.external },
            { binding: 6, resource: frame.host },
            { binding: 7, resource: frame.reset },
        ];
        if (quad) entries.push({ binding: 2, resource: frame.sampler });
        const bindGroup = device.createBindGroup({
            label: 'upscale-exposure-every-texel',
            layout: this._reduction.bindGroupLayouts[1],
            entries,
        });
        // The quad form's grid: one load per 2×2 render-texel quad.
        const width = quad ? Math.ceil(frame.width / 2) : frame.width;
        const height = quad ? Math.ceil(frame.height / 2) : frame.height;
        this._reduction.encodePass(pass, { width, height, bindGroup });
    }

    /** Destroys the uniform and partials buffers the reduction created. */
    dispose(): void {
        this._reduction.release();
    }
}
