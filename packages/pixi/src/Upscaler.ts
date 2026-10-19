import type { Renderer, Texture, WebGPURenderer } from 'pixi.js';

import { notReadyError } from '@pmndrs/upscaler-core/initializationError';
import { getJitterPhaseCount } from '@pmndrs/upscaler-core/math/jitter';
import { UpscalerCore } from '@pmndrs/upscaler-core/UpscalerCore';
import type { DispatchInputs as CoreDispatchInputs } from '@pmndrs/upscaler-core/types';
import { asWebGPURenderer, getDevice, getGPUTexture } from './internal/pixiWebGPU';
import { createPixiTextureAllocator } from './internal/textureAllocator';
import {
    DebugView,
    type DispatchInputs,
    type FrameCamera,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
    type UpscalerConfig,
} from './types';

const EMPTY_TIMINGS: ReadonlyMap<string, number> = new Map();
const NO_JITTER: JitterOffset = Object.freeze({ x: 0, y: 0 });
// The spatial and bilinear paths read no camera, but the constants stay finite.
const NO_CAMERA: FrameCamera = Object.freeze({ near: 0.1, far: 1000, perspective: true });

/** Construction options for the pixi {@link Upscaler}. */
export interface UpscalerOptions {
    /** The application's renderer — a WebGPU one (`preference: 'webgpu'`), after init. */
    renderer: Renderer;
    /**
     * Collect per-pass GPU times into {@link Upscaler.gpuTimings}. Defaults to
     * `false` — a debugging aid with a per-frame cost.
     */
    gpuTiming?: boolean;
    /**
     * Converts the app's motion vectors to a UV delta, for the temporal path
     * (see docs/engine-contract.md). Defaults to the core's `[0.5, -0.5]`:
     * an NDC delta, current − previous, y up.
     */
    motionScale?: readonly [number, number];
}

/**
 * The upscaler for pixi.js v8's `WebGPURenderer` — **experimental**. The pixi
 * adapter over the engine-agnostic `UpscalerCore`: it resolves pixi textures
 * to their GPU handles and allocates the output and guides as pixi `storage`
 * textures, so a `Sprite` or filter samples the result like any texture.
 *
 * pixi submits one command encoder per `renderer.render()`, so dispatch
 * between renders: render the scene into a reduced-size `RenderTexture`,
 * dispatch, then render whatever presents {@link outputTexture}.
 * ```ts
 * renderer.render({ container: scene, target: lowRes });
 * upscaler.dispatch({ color: lowRes });            // spatial (FSR1)
 * renderer.render({ container: presentation });    // a Sprite of upscaler.outputTexture
 * ```
 * pixi has no 3D camera, so the temporal path needs the app (or a 3D layer
 * such as pixi-3d) to supply depth, motion, the jitter and a
 * {@link FrameCamera}. Spatial needs only color. Details: docs/pixi.md.
 */
export class Upscaler {
    //* Public State

    /** Runtime tuning knobs — mutate freely between frames. */
    readonly settings: RuntimeSettings = {
        sharpness: 0.8,
        rcasDenoise: false,
        maxAccumulation: 24,
        exposure: 1.0,
        autoExposure: true,
        lockThinFeatures: true,
        detectShadingChanges: true,
        debugView: DebugView.None,
    };

    //* Internals

    private readonly _renderer: WebGPURenderer;
    private readonly _motionScale: readonly [number, number] | undefined;
    // Created on first use: the renderer may not have its device yet.
    private _core: UpscalerCore<Texture> | null = null;
    private _gpuTiming: boolean;
    private _path: UpscalePath = 'temporal';

    constructor(options: UpscalerOptions) {
        this._renderer = asWebGPURenderer(options.renderer);
        this._gpuTiming = options.gpuTiming ?? false;
        this._motionScale = options.motionScale;
    }

    /** Baseline device capability only; does not compile or allocate anything. */
    static isSupported(device: GPUDevice): boolean {
        return UpscalerCore.isSupported(device);
    }

    /** Prepares the configured path. Await before the first dispatch. */
    init(): Promise<void> {
        return this.prepare();
    }

    /** Explicitly warms the current path and optional settings; also retries failed requests. */
    prepare(): Promise<void> {
        return this._ensureCore().prepare();
    }

    /** Mandatory passes are ready; newly requested optional passes may still be preparing. */
    get isReady(): boolean {
        return this._core?.isReady ?? false;
    }

    /** The debug view actually used by the most recent frame (None while preparing). */
    get activeDebugView(): DebugView {
        return this._core?.activeDebugView ?? DebugView.None;
    }

    private _ensureCore(): UpscalerCore<Texture> {
        this._core ??= new UpscalerCore({
            device: getDevice(this._renderer),
            allocateTexture: createPixiTextureAllocator(this._renderer),
            gpuTiming: this._gpuTiming,
            settings: this.settings,
            motionScale: this._motionScale,
        });
        return this._core;
    }

    /**
     * (Re)configures resolutions and the active pipeline. Allocates the
     * working texture set — call on startup, resize, or mode change, then
     * re-read {@link outputTexture}.
     * @param config - Display size, quality mode/ratio, and pipeline path
     */
    configure(config: UpscalerConfig): void {
        this._ensureCore().configure(config);
        this._path = config.path ?? 'temporal';
    }

    //* Accessors

    /** Render (input) resolution in pixels. */
    get renderWidth(): number {
        return this._core?.renderWidth ?? 0;
    }

    get renderHeight(): number {
        return this._core?.renderHeight ?? 0;
    }

    /** Display (output) resolution in pixels. */
    get displayWidth(): number {
        return this._core?.displayWidth ?? 0;
    }

    get displayHeight(): number {
        return this._core?.displayHeight ?? 0;
    }

    /** Current upscale ratio (display / render). */
    get upscaleRatio(): number {
        return this._core?.upscaleRatio ?? 1;
    }

    /** Number of jitter phases at the current ratio. */
    get jitterPhaseCount(): number {
        return this._core?.jitterPhaseCount ?? getJitterPhaseCount(1);
    }

    /** This frame's jitter in render pixels (docs/engine-contract.md#jitter). The object is reused. */
    get jitter(): JitterOffset {
        return this._core?.jitter ?? NO_JITTER;
    }

    /** The previous frame's jitter, same convention as {@link jitter}. */
    get jitterPrevious(): JitterOffset {
        return this._core?.jitterPrevious ?? NO_JITTER;
    }

    /** Index of this frame's {@link jitter} in the Halton sequence. */
    get jitterPhase(): number {
        return this._core?.jitterPhase ?? 0;
    }

    /**
     * The upscaled result as a pixi `Texture` (display size, rgba16float, in
     * the input's color domain). Show it with a `Sprite`. Reallocated by
     * {@link configure}.
     */
    get outputTexture(): Texture {
        if (!this._core) throw new Error('@pmndrs/upscaler/pixi: configure() must run before outputTexture is used.');
        return this._core.output;
    }

    /** The published temporal guides as pixi `Texture`s (temporal and guides paths). */
    get guides(): TemporalGuides {
        if (!this._core) throw new Error('@pmndrs/upscaler/pixi: guides are available after configure().');
        return this._core.guides;
    }

    /** True between {@link dispatchGuides} and {@link dispatchUpscale}. */
    get guidesPending(): boolean {
        return this._core?.guidesPending ?? false;
    }

    /** Per-pass GPU times (ms) of the latest timed frame. Empty while {@link gpuTiming} is off. */
    get gpuTimings(): ReadonlyMap<string, number> {
        return this._core?.gpuTimings ?? EMPTY_TIMINGS;
    }

    /** Whether per-pass GPU timing is collected (off by default; costs GPU time). */
    get gpuTiming(): boolean {
        return this._gpuTiming;
    }

    set gpuTiming(enabled: boolean) {
        this._gpuTiming = enabled;
        if (this._core) this._core.gpuTiming = enabled;
    }

    /** Drops all temporal history on the next dispatch (camera cut etc.). */
    resetHistory(): void {
        this._core?.resetHistory();
    }

    //* Frame Lifecycle

    /**
     * Starts a temporal frame: advances the jitter sequence. pixi has no
     * camera to offset, so the caller applies the returned jitter to its own
     * projection (docs/engine-contract.md#jitter). No-op off the temporal path.
     * @returns This frame's jitter, or `null` when there is nothing to apply
     */
    beginFrame(): JitterOffset | null {
        return this._core?.beginFrame() ?? null;
    }

    /**
     * Encodes and submits the upscaling passes. Call between
     * `renderer.render()` calls: after the one that fills the inputs, before
     * the one that presents {@link outputTexture}.
     * @param inputs - Color (+ depth and motion for the temporal path)
     * @param camera - The camera facts the inputs were rendered with; required
     *   on the temporal path, ignored by spatial and bilinear
     */
    dispatch(inputs: DispatchInputs, camera?: FrameCamera): void {
        const core = this._readyCore();
        core.dispatch(this._resolveInputs(inputs), camera ?? this._noCamera());
    }

    /**
     * {@link dispatch} into pixi's own frame encoder, for use *inside* a
     * render (a custom render pass or a 3D layer's post stage), where a
     * separate submit would run before pixi's frame. Closes pixi's open
     * render pass first; the caller's engine must rebind its target for
     * anything it draws afterwards. Not GPU-timed.
     * @param inputs - As {@link dispatch}
     * @param camera - As {@link dispatch}
     */
    encode(inputs: DispatchInputs, camera?: FrameCamera): void {
        const core = this._readyCore();
        const resolved = this._resolveInputs(inputs);
        const frame = camera ?? this._noCamera();
        const r = this._renderer;
        r.renderTarget.finishRenderPass();
        core.encode(r.encoder.commandEncoder, resolved, frame);
    }

    /**
     * Encodes and submits only the early geometry stage (the core's
     * `dispatchGuides`).
     * @param inputs - Depth + motion (+ optional reset/deltaTime)
     * @param camera - The camera facts the inputs were rendered with
     */
    dispatchGuides(inputs: GuideDispatchInputs, camera: FrameCamera): void {
        const core = this._readyCore();
        const r = this._renderer;
        core.dispatchGuides(
            {
                depth: getGPUTexture(r, inputs.depth),
                velocity: getGPUTexture(r, inputs.velocity),
                reset: inputs.reset,
                deltaTime: inputs.deltaTime,
            },
            camera,
        );
    }

    /**
     * Finishes a split frame (the core's `dispatchUpscale`).
     * @param inputs - Color (+ optional reactive/exposure inputs)
     * @param camera - The camera facts passed to {@link dispatchGuides}
     */
    dispatchUpscale(inputs: DispatchInputs, camera: FrameCamera): void {
        this._readyCore().dispatchUpscale(this._resolveInputs(inputs), camera);
    }

    /** Releases the GPU resources. */
    dispose(): void {
        this._core?.dispose();
        this._core = null;
    }

    //* pixi Bridge

    private _readyCore(): UpscalerCore<Texture> {
        if (!this._core) throw notReadyError(this, 'Upscaler', 'preparing');
        return this._core;
    }

    private _noCamera(): FrameCamera {
        if (this._path === 'temporal') {
            throw new Error('@pmndrs/upscaler/pixi: the temporal path needs a FrameCamera (near, far, projection).');
        }
        return NO_CAMERA;
    }

    private _resolveInputs(inputs: DispatchInputs): CoreDispatchInputs {
        const r = this._renderer;
        return {
            color: getGPUTexture(r, inputs.color),
            depth: inputs.depth && getGPUTexture(r, inputs.depth),
            velocity: inputs.velocity && getGPUTexture(r, inputs.velocity),
            reactive: inputs.reactive && getGPUTexture(r, inputs.reactive),
            reactiveOpaqueColor: inputs.reactiveOpaqueColor && getGPUTexture(r, inputs.reactiveOpaqueColor),
            exposureTexture: inputs.exposureTexture && getGPUTexture(r, inputs.exposureTexture),
            preExposureTexture: inputs.preExposureTexture && getGPUTexture(r, inputs.preExposureTexture),
            reset: inputs.reset,
            deltaTime: inputs.deltaTime,
        };
    }
}
