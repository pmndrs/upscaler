import { HalfFloatType, NoColorSpace, RGBAFormat, type Texture } from 'three';
import { StorageTexture, type WebGPURenderer } from 'three/webgpu';

import { ComputePass } from './internal/ComputePass';
import { ConstantsBuffer } from './internal/ConstantsBuffer';
import { getDevice, getGPUTexture } from './internal/threeWebGPU';
import { FLAG_MOMENTS_YCOCG } from './shaders/common';
import { MOMENTS_SHADER } from './shaders/moments';

/** Which scalar the moments are computed over. */
export type MomentsSpace = 'linear' | 'ycocg';

/** Static configuration for {@link MomentsPass.configure}. */
export interface MomentsPassConfig {
    /** Source (and moments output) width in pixels. */
    width: number;
    /** Source (and moments output) height in pixels. */
    height: number;
    /**
     * Scalar definition: `'linear'` = Rec.709 luma of `.rgb` in the caller's
     * linear domain (a single-channel source reads through unchanged);
     * `'ycocg'` = YCoCg Y. Defaults to `'linear'`.
     */
    space?: MomentsSpace;
}

/**
 * Standalone signal-agnostic moments pass (`MomentPyramid` in
 * TEMPORAL-GUIDES-SPEC §5): per-pixel `(E[x], E[x²])` of a configurable
 * scalar over any float texture, plus one coarse level of 4×4 block means —
 * the statistics half an SVGF-class denoiser needs, decoupled from any
 * beauty/exposure assumption so it can run on pre-albedo GI irradiance as
 * readily as on scene color.
 *
 * Deliberately NOT part of the upscaling pipeline: the upscaler's variance
 * clip keeps its fused inline moments. This class owns its own constants,
 * pipeline, and outputs, and touches nothing in {@link Upscaler}.
 *
 * ```ts
 * const moments = new MomentsPass({ renderer });
 * moments.configure({ width, height, space: 'ycocg' });
 * moments.dispatch({ source: giTexture });   // per frame
 * // sample moments.moments (.rg) / moments.coarseMoments
 * ```
 * @experimental Contract frozen (spec M0) but pre-acceptance — may shift
 * until the first external consumer integration lands.
 */
export class MomentsPass {
    private readonly _renderer: WebGPURenderer;
    private _device: GPUDevice | null = null;
    private _constants: ConstantsBuffer | null = null;
    private _pass: ComputePass | null = null;
    private _space: MomentsSpace = 'linear';
    private _width = 0;
    private _height = 0;
    private _moments: StorageTexture | null = null;
    private _momentsGPU: GPUTexture | null = null;
    private _coarse: StorageTexture | null = null;
    private _coarseGPU: GPUTexture | null = null;

    /**
     * @param options.renderer - An initialized `WebGPURenderer`
     */
    constructor(options: { renderer: WebGPURenderer }) {
        this._renderer = options.renderer;
    }

    /**
     * (Re)configures size and scalar space; allocates the output textures
     * and (re)builds the pipeline when the space changes.
     * @param config - Source size and scalar space
     */
    configure(config: MomentsPassConfig): void {
        if (!this._device) {
            this._device = getDevice(this._renderer);
            this._constants = new ConstantsBuffer(this._device);
        }
        this._space = config.space ?? 'linear';
        this._pass ??= new ComputePass(this._device, 'moments', MOMENTS_SHADER);
        this._width = Math.max(1, Math.floor(config.width));
        this._height = Math.max(1, Math.floor(config.height));
        this._constants!.setRenderSize(this._width, this._height);
        // The space is a runtime flag in this pass's own constants buffer —
        // one pipeline serves both scalars.
        this._constants!.setFlags(this._space === 'ycocg' ? FLAG_MOMENTS_YCOCG : 0);
        this._constants!.upload();

        this._destroyOutputs();
        const make = (label: string, w: number, h: number): [StorageTexture, GPUTexture] => {
            const tex = new StorageTexture(w, h);
            tex.name = `upscale-${label}`;
            tex.colorSpace = NoColorSpace;
            tex.format = RGBAFormat;
            tex.type = HalfFloatType;
            tex.generateMipmaps = false;
            this._renderer.initTexture(tex);
            return [tex, getGPUTexture(this._renderer, tex)];
        };
        [this._moments, this._momentsGPU] = make('moments', this._width, this._height);
        [this._coarse, this._coarseGPU] = make(
            'moments-coarse',
            Math.max(1, Math.ceil(this._width / 4)),
            Math.max(1, Math.ceil(this._height / 4)),
        );
    }

    /** Per-pixel moments at source size (rgba16float; rg = E[x], E[x²]). */
    get moments(): Texture {
        if (!this._moments) throw new Error('@pmndrs/upscaler: MomentsPass.configure() first.');
        return this._moments;
    }

    /** 4×4 block-mean moments at ceil(source/4) (rgba16float; rg). */
    get coarseMoments(): Texture {
        if (!this._coarse) throw new Error('@pmndrs/upscaler: MomentsPass.configure() first.');
        return this._coarse;
    }

    /**
     * Encodes and submits the pass for this frame's source.
     * @param inputs - The texture to compute moments over (loaded per-texel,
     *   never filtered — any float format works)
     */
    dispatch(inputs: { source: Texture }): void {
        if (!this._pass || !this._momentsGPU || !this._coarseGPU) {
            throw new Error('@pmndrs/upscaler: MomentsPass.configure() must run before dispatch().');
        }
        const sourceGPU = getGPUTexture(this._renderer, inputs.source);
        const bindGroup = this._pass.createBindGroup([
            { buffer: this._constants!.buffer },
            sourceGPU.createView(),
            this._momentsGPU.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
            this._coarseGPU.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
        ]);
        const encoder = this._device!.createCommandEncoder({ label: 'upscale-moments' });
        const pass = encoder.beginComputePass({ label: 'upscale-moments' });
        this._pass.dispatch(pass, bindGroup, this._width, this._height);
        pass.end();
        this._device!.queue.submit([encoder.finish()]);
    }

    private _destroyOutputs(): void {
        this._moments?.dispose();
        this._moments = null;
        this._momentsGPU = null;
        this._coarse?.dispose();
        this._coarse = null;
        this._coarseGPU = null;
    }

    /** Releases the output textures and GPU resources. */
    dispose(): void {
        this._destroyOutputs();
        this._constants?.dispose();
        this._constants = null;
        this._pass = null;
        this._device = null;
    }
}
