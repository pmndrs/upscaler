import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import { TAAMaterialManager } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaMaterialManager.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { notReadyError } from '@pmndrs/upscaler-core/initializationError';
import { getJitterPhaseCount } from '@pmndrs/upscaler-core/math/jitter';
import { UpscalerCore } from '@pmndrs/upscaler-core/UpscalerCore';
import type {
    DispatchInputs as CoreDispatchInputs,
    FrameCamera,
} from '@pmndrs/upscaler-core/types';
import { asWebGPUEngine, getDevice, getGPUTexture } from './internal/babylonWebGPU';
import { BABYLON_MOTION_SCALE, jitterToClip, toFrameCamera } from './internal/conventions';
import { createBabylonTextureAllocator } from './internal/textureAllocator';
import {
    DebugView,
    type DispatchInputs,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalerConfig,
} from './types';

const EMPTY_TIMINGS: ReadonlyMap<string, number> = new Map();
const NO_JITTER: JitterOffset = Object.freeze({ x: 0, y: 0 });

/** Construction options for the Babylon {@link Upscaler}. */
export interface UpscalerOptions {
    /** An initialized `WebGPUEngine` (after `await engine.initAsync()`). */
    engine: AbstractEngine;
    /**
     * The scene whose materials render the inputs. The jitter is applied per
     * material (see {@link Upscaler.beginFrame}), so it must be this scene.
     */
    scene: Scene;
    /**
     * Collect per-pass GPU times into {@link Upscaler.gpuTimings}. Defaults to
     * `false` — a debugging aid with a per-frame cost.
     */
    gpuTiming?: boolean;
}

/**
 * FSR3-style upscaler for Babylon.js's `WebGPUEngine` — **experimental**.
 * The Babylon adapter over the engine-agnostic `UpscalerCore`: it resolves
 * Babylon textures to their GPU handles, allocates the output and guides as
 * Babylon `InternalTexture`s, and applies the jitter through Babylon's own
 * `TAAMaterialManager`, which offsets each material's clip position and so
 * leaves the camera — and the velocity buffer — jitter-free.
 *
 * Usage per frame (temporal path):
 * ```ts
 * upscaler.beginFrame();      // jitters every material in the scene
 * // render color + depth + linear velocity at renderWidth × renderHeight
 * upscaler.endFrame();        // later renders this frame are unjittered
 * upscaler.dispatch({ color, depth, velocity, deltaTime }, camera);
 * // upscaler.outputTexture is linear/HDR in Babylon's render-target orientation
 * ```
 * `FrameGraphUpscaleTask` packages this for a frame graph. Inputs, the
 * velocity requirement and the limits: docs/babylon.md.
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

    private readonly _engine: AbstractEngine;
    private readonly _scene: Scene;
    // Created on first use: the engine may not have its device yet.
    private _core: UpscalerCore<InternalTexture> | null = null;
    private _gpuTiming: boolean;
    // Babylon's TAA jitter plugin, shared by every material in the scene.
    // Created when a jittering path is configured.
    private _jitterMaterials: TAAMaterialManager | null = null;
    private readonly _frame: FrameCamera = { near: 0.1, far: 1000, perspective: true, reversedDepth: false };

    constructor(options: UpscalerOptions) {
        asWebGPUEngine(options.engine);
        this._engine = options.engine;
        this._scene = options.scene;
        this._gpuTiming = options.gpuTiming ?? false;
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

    private _ensureCore(): UpscalerCore<InternalTexture> {
        if (this._core) return this._core;
        const device = getDevice(this._engine);
        this._core = new UpscalerCore({
            device,
            allocateTexture: createBabylonTextureAllocator(this._engine, device),
            gpuTiming: this._gpuTiming,
            settings: this.settings,
            motionScale: BABYLON_MOTION_SCALE,
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
        const jittering = (config.path ?? 'temporal') === 'temporal' && config.jitter !== false;
        // Adding the plugin recompiles the scene's materials, so it happens
        // once, on the first jittering configuration, and then stays.
        if (jittering && !this._jitterMaterials) this._jitterMaterials = new TAAMaterialManager(this._scene);
        this._setMaterialJitter(null);
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

    /**
     * This frame's sub-pixel jitter in render pixels — the core's convention
     * (docs/engine-contract.md), measured along the texel rows of Babylon's
     * flipped render targets. `(0, 0)` when jitter is off or the path isn't
     * `temporal`. The object is reused across reads.
     */
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
     * The upscaled result as a Babylon `InternalTexture` (display size,
     * rgba16float, linear/HDR, in Babylon's render-target orientation). Bind it
     * to a post process or `importTexture()` it into a frame graph.
     * Reallocated by {@link configure}.
     */
    get outputTexture(): InternalTexture {
        if (!this._core) throw new Error('@pmndrs/upscaler/babylon: configure() must run before outputTexture is used.');
        return this._core.output;
    }

    /**
     * The published temporal guides as Babylon `InternalTexture`s, on the
     * `temporal` and `guides` paths after `configure()`. See
     * {@link TemporalGuides}.
     */
    get guides(): TemporalGuides {
        if (!this._core) throw new Error('@pmndrs/upscaler/babylon: guides are available after configure().');
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
     * Starts a frame: advances the jitter sequence and applies it to every
     * material in the scene through `TAAMaterialManager`. The camera is not
     * touched, so the velocity Babylon writes stays jitter-free. Render the
     * inputs after this; no-op off the jittering temporal path.
     * @returns This frame's jitter, or `null` when nothing is applied
     */
    beginFrame(): JitterOffset | null {
        const jitter = this._core?.beginFrame() ?? null;
        this._setMaterialJitter(jitter);
        return jitter;
    }

    /**
     * Ends the jitter window: anything else the scene renders this frame
     * (a native reference, a minimap) draws unjittered again. The jitter
     * values stay readable until the next {@link beginFrame}.
     */
    endFrame(): void {
        this._setMaterialJitter(null);
    }

    private _setMaterialJitter(jitter: JitterOffset | null): void {
        const materials = this._jitterMaterials;
        if (!materials) return;
        if (jitter && this._core) jitterToClip(jitter, this._core.renderWidth, this._core.renderHeight, materials.jitter);
        else materials.jitter.set(0, 0);
    }

    /**
     * Encodes and submits the upscaling passes for this frame. Flushes the
     * engine first, so everything Babylon has recorded so far (the input
     * renders) precedes the upscale on the queue; Babylon's later work this
     * frame (presenting the output) follows it.
     * @param inputs - Scene color (+ depth and linear velocity for the temporal path)
     * @param camera - The camera the inputs were rendered with
     */
    dispatch(inputs: DispatchInputs, camera: Camera): void {
        const core = this._readyCore();
        const resolved = this._resolveInputs(inputs);
        const frame = this._frameInfo(camera);
        asWebGPUEngine(this._engine).flushFramebuffer();
        core.dispatch(resolved, frame);
    }

    /**
     * Encodes and submits only the early geometry stage (see the core's
     * `dispatchGuides`). Flushes the engine first, like {@link dispatch}.
     * @param inputs - Depth + linear velocity (+ optional reset/deltaTime)
     * @param camera - The camera the inputs were rendered with
     */
    dispatchGuides(inputs: GuideDispatchInputs, camera: Camera): void {
        const core = this._readyCore();
        const resolved = {
            depth: getGPUTexture(inputs.depth),
            velocity: getGPUTexture(inputs.velocity),
            reset: inputs.reset,
            deltaTime: inputs.deltaTime,
        };
        const frame = this._frameInfo(camera);
        asWebGPUEngine(this._engine).flushFramebuffer();
        core.dispatchGuides(resolved, frame);
    }

    /**
     * Finishes a split frame (see the core's `dispatchUpscale`). Flushes the
     * engine first, like {@link dispatch}.
     * @param inputs - Scene color (+ optional reactive/exposure inputs)
     * @param camera - The camera passed to {@link dispatchGuides}
     */
    dispatchUpscale(inputs: DispatchInputs, camera: Camera): void {
        const core = this._readyCore();
        const resolved = this._resolveInputs(inputs);
        const frame = this._frameInfo(camera);
        asWebGPUEngine(this._engine).flushFramebuffer();
        core.dispatchUpscale(resolved, frame);
    }

    /** Releases the GPU resources and removes the jitter plugin from the scene's materials. */
    dispose(): void {
        this._core?.dispose();
        this._core = null;
        this._jitterMaterials?.dispose();
        this._jitterMaterials = null;
    }

    //* Babylon Bridge

    private _readyCore(): UpscalerCore<InternalTexture> {
        if (!this._core) throw notReadyError(this, 'Upscaler', 'preparing');
        return this._core;
    }

    private _resolveInputs(inputs: DispatchInputs): CoreDispatchInputs {
        return {
            color: getGPUTexture(inputs.color),
            depth: inputs.depth && getGPUTexture(inputs.depth),
            velocity: inputs.velocity && getGPUTexture(inputs.velocity),
            reactive: inputs.reactive && getGPUTexture(inputs.reactive),
            reactiveOpaqueColor: inputs.reactiveOpaqueColor && getGPUTexture(inputs.reactiveOpaqueColor),
            exposureTexture: inputs.exposureTexture && getGPUTexture(inputs.exposureTexture),
            preExposureTexture: inputs.preExposureTexture && getGPUTexture(inputs.preExposureTexture),
            reset: inputs.reset,
            deltaTime: inputs.deltaTime,
        };
    }

    private _frameInfo(camera: Camera): FrameCamera {
        return toFrameCamera(camera, this._engine.useReverseDepthBuffer, this._frame);
    }
}
