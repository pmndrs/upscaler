import type { Texture } from 'three';
import type { StorageTexture, WebGPURenderer } from 'three/webgpu';

import { notReadyError } from '@pmndrs/upscaler-core/initializationError';
import { MomentsCore, type MomentsPassConfig } from '@pmndrs/upscaler-core/MomentsCore';
import { getDevice, getGPUTexture } from './internal/threeWebGPU';
import { createThreeTextureAllocator } from './internal/textureAllocator';

export type { MomentsPassConfig, MomentsSpace } from '@pmndrs/upscaler-core/MomentsCore';

/**
 * Standalone signal-agnostic moments pass (contract: docs/temporal-guides.md,
 * "MomentsPass"): per-pixel `(E[x], E[x²])` of a configurable
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
 * await moments.init();
 * moments.dispatch({ source: giTexture });   // per frame
 * // sample moments.moments (.rg) / moments.coarseMoments
 * ```
 */
export class MomentsPass {
    private readonly _renderer: WebGPURenderer;
    // Created on first use: the renderer may not have its device yet.
    private _core: MomentsCore<StorageTexture> | null = null;

    /**
     * @param options.renderer - An initialized `WebGPURenderer`
     */
    constructor(options: { renderer: WebGPURenderer }) {
        this._renderer = options.renderer;
    }

    private _ensureCore(): MomentsCore<StorageTexture> {
        this._core ??= new MomentsCore({
            device: getDevice(this._renderer),
            allocateTexture: createThreeTextureAllocator(this._renderer),
        });
        return this._core;
    }

    /** Compile asynchronously. Configure first, then await before dispatch. */
    init(): Promise<void> {
        return this._ensureCore().prepare();
    }

    /** Mandatory pipeline readiness. */
    get isReady(): boolean { return this._core?.isReady ?? false; }

    /**
     * (Re)configures size and scalar space and allocates the output
     * textures. The space is a runtime flag, so one pipeline serves both.
     * @param config - Source size and scalar space
     */
    configure(config: MomentsPassConfig): void {
        this._ensureCore().configure(config);
    }

    /** Per-pixel moments at source size (rgba16float; rg = E[x], E[x²]). */
    get moments(): Texture {
        if (!this._core) throw new Error('@pmndrs/upscaler: MomentsPass.configure() first.');
        return this._core.moments;
    }

    /** 4×4 block-mean moments at ceil(source/4) (rgba16float; rg). */
    get coarseMoments(): Texture {
        if (!this._core) throw new Error('@pmndrs/upscaler: MomentsPass.configure() first.');
        return this._core.coarseMoments;
    }

    /**
     * Encodes and submits the pass for this frame's source.
     * @param inputs - The texture to compute moments over (loaded per-texel,
     *   never filtered — any float format works)
     */
    dispatch(inputs: { source: Texture }): void {
        if (!this._core) throw notReadyError(this, 'MomentsPass', 'preparing');
        this._core.dispatch({ source: getGPUTexture(this._renderer, inputs.source) });
    }

    /** Releases the output textures and GPU resources. */
    dispose(): void {
        this._core?.dispose();
        this._core = null;
    }
}
