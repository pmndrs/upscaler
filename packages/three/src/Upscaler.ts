import { Matrix4, type OrthographicCamera, type PerspectiveCamera } from 'three';
import type { StorageTexture, Texture, WebGPURenderer } from 'three/webgpu';

import { notReadyError } from '@pmndrs/upscaler-core/initializationError';
import { getJitterPhaseCount } from '@pmndrs/upscaler-core/math/jitter';
import {
    UpscalerCore,
    type UpscalerCoreInternalOptions,
    type UpscalerCoreOptions,
} from '@pmndrs/upscaler-core/UpscalerCore';
import type {
    DispatchInputs as CoreDispatchInputs,
    FrameCamera,
    GuideDispatchInputs as CoreGuideDispatchInputs,
} from '@pmndrs/upscaler-core/types';
import { getDevice, getGPUTexture } from './internal/threeWebGPU';
import { createThreeTextureAllocator } from './internal/textureAllocator';
import { applyJitterViewOffset, restoreViewOffset, type ViewOffsetSnapshot } from './math/viewOffset';
import {
    DebugView,
    type UpscalerConfig,
    type DispatchInputs,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
} from './types';

type JitterableCamera = PerspectiveCamera | OrthographicCamera;

const EMPTY_TIMINGS: ReadonlyMap<string, number> = new Map();
const NO_JITTER: JitterOffset = Object.freeze({ x: 0, y: 0 });

/** Construction options for {@link Upscaler}. */
export interface UpscalerOptions {
    /** The initialized `WebGPURenderer` whose device the passes run on. */
    renderer: WebGPURenderer;
    /**
     * Collect per-pass GPU times into {@link Upscaler.gpuTimings}. Defaults to
     * `false` — a debugging aid with a per-frame cost. See {@link Upscaler.gpuTiming}.
     */
    gpuTiming?: boolean;
}

// Bench-only knobs, forwarded to the core (see UpscalerCoreInternalOptions).
type UpscalerInternalOptions = UpscalerOptions & {
    _rcasShader?: string;
    _spatialRcasShader?: string;
    _shadingChangeShader?: string;
    _depthClipShader?: string;
    _crossFrameReconstruct?: { shader: string; cameraCompensated: boolean };
};

/**
 * FSR3-style upscaler for three's `WebGPURenderer`, implemented as raw WGSL
 * compute passes on the renderer's GPU device.
 *
 * Pipelines:
 * - `bilinear` — blit (comparison baseline / native passthrough)
 * - `spatial`  — EASU → RCAS (FSR1)
 * - `temporal` — reconstruct (dilate + depth scatter) → depth clip → exposure →
 *   shading change → accumulate → RCAS (FSR2/3-style)
 * - `guides`   — reconstruct + depth clip only (see {@link dispatchGuides})
 *
 * Usage per frame (temporal path):
 * ```ts
 * upscaler.beginFrame(camera);                 // applies sub-pixel jitter
 * renderer.setRenderTarget(sceneRT);           // color+velocity MRT, depth
 * renderer.render(scene, camera);
 * renderer.setRenderTarget(null);
 * upscaler.endFrame(camera);                   // removes jitter, restores the camera's view
 * upscaler.dispatch({ color, depth, velocity, deltaTime }, camera);
 * // upscaler.outputTexture is linear/HDR — present or post-process it
 * ```
 * Feed `upscaler.unjitteredProjectionMatrix` to the scene's `velocity` node
 * via `setProjectionMatrix` so motion vectors stay jitter-free. The full
 * recipe and input contracts: docs/getting-started.md and
 * docs/inputs-and-contracts.md.
 *
 * The three adapter over the engine-agnostic `UpscalerCore`: this class
 * resolves three textures to their GPU handles, allocates the output and
 * guides as three `StorageTexture`s, and owns the camera jitter.
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

    /**
     * Jitter-free projection matrix for the current frame. Pass to the
     * scene velocity node (`velocity.setProjectionMatrix(...)`) — the
     * instance is stable, its contents update in `beginFrame`.
     */
    readonly unjitteredProjectionMatrix = new Matrix4();

    //* Internals

    private readonly _renderer: WebGPURenderer;
    private readonly _internal: Omit<UpscalerInternalOptions, 'renderer' | 'gpuTiming'>;
    // Created on first use (configure/init), not in the constructor: the
    // renderer may not have its device yet. Dropped on dispose, so a later
    // configure starts over on the renderer's current device.
    private _core: UpscalerCore<StorageTexture> | null = null;
    private _gpuTiming: boolean;
    // The camera's view state from before this frame's jitter, held while the
    // jitter is applied (beginFrame → endFrame). Restoring from it, rather
    // than clearing, keeps an app-set view offset (tiled/multi-screen) intact.
    private _viewSnapshot: ViewOffsetSnapshot | null = null;
    // Reused per dispatch: the core reads it synchronously.
    private readonly _frame: FrameCamera = { near: 0.1, far: 1000, perspective: true, reversedDepth: false };
    // Bench-only `camera` identity state (unused in production).
    private readonly _reprojectData = new Float32Array(8);
    private readonly _prevViewMatrix = new Matrix4();
    private readonly _relativeView = new Matrix4();
    private _hasPrevView = false;
    private _frameCamera: JitterableCamera | null = null;

    constructor(options: UpscalerOptions);
    constructor(options: UpscalerInternalOptions) {
        const { renderer, gpuTiming, ...internal } = options;
        this._renderer = renderer;
        this._gpuTiming = gpuTiming ?? false;
        this._internal = internal;
    }

    /** Baseline device capability only; does not compile or allocate anything. */
    static isSupported(device: GPUDevice): boolean {
        return UpscalerCore.isSupported(device);
    }

    /** Prepare the configured path. Call after renderer.init(); await before raw dispatch. */
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

    private _ensureCore(): UpscalerCore<StorageTexture> {
        if (this._core) return this._core;
        const renderer = this._renderer;
        const options: UpscalerCoreInternalOptions<StorageTexture> = {
            ...this._internal,
            device: getDevice(renderer),
            allocateTexture: createThreeTextureAllocator(renderer),
            gpuTiming: this._gpuTiming,
            settings: this.settings,
            _reprojectData: this._internal._crossFrameReconstruct?.cameraCompensated
                ? () => this._writeReproject()
                : undefined,
        };
        this._core = new UpscalerCore(options as UpscalerCoreOptions<StorageTexture>);
        return this._core;
    }

    /**
     * (Re)configures resolutions and the active pipeline. Allocates the
     * working texture set — call on startup, resize, or mode change.
     * @param config - Display size, quality mode/ratio, and pipeline path
     */
    configure(config: UpscalerConfig): void {
        this._ensureCore().configure(config);
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
     * This frame's sub-pixel jitter, in render pixels (`[-0.5, 0.5]` per axis).
     * x right, y down: the sample for render texel `(i, j)` sits at
     * `(i + 0.5 + x, j + 0.5 + y)` in the unjittered image's pixels, so a UV
     * offset is `(x / renderWidth, y / renderHeight)` and an NDC offset is
     * `(2x / renderWidth, −2y / renderHeight)`. It is exactly the offset
     * {@link beginFrame} applies to the camera's view (before scaling into an
     * app-set view offset's units) and the value the shaders reconcile history
     * against. `(0, 0)` when jitter is disabled or the path isn't `temporal`.
     * Valid from `beginFrame()` until the next one. The object is reused across
     * reads; copy it to keep a value.
     */
    get jitter(): JitterOffset {
        return this._core?.jitter ?? NO_JITTER;
    }

    /**
     * The previous frame's jitter, same convention as {@link jitter}: the
     * offset reprojection compensates against. On the first frame after a
     * reset history is discarded, so nothing uses it there.
     */
    get jitterPrevious(): JitterOffset {
        return this._core?.jitterPrevious ?? NO_JITTER;
    }

    /**
     * Index of this frame's {@link jitter} in
     * `generateJitterSequence(jitterPhaseCount)`, `0 … jitterPhaseCount − 1`.
     * `beginFrame()` advances before applying, so the first frame after
     * `configure()` or `resetHistory()` is phase 1, and phase 0 ends the cycle.
     * `0` when jitter is disabled or the path isn't `temporal`.
     */
    get jitterPhase(): number {
        return this._core?.jitterPhase ?? 0;
    }

    /**
     * The upscaled result as a three texture — sample it on a fullscreen
     * quad or feed it into later post-processing. Values remain in the
     * caller's linear/HDR domain; presentation is the caller's responsibility.
     */
    get outputTexture(): Texture {
        if (!this._core) throw new Error('@pmndrs/upscaler: configure() must run before outputTexture is used.');
        return this._core.output;
    }

    /**
     * The published temporal-guides bundle (dilated motion/depth,
     * disocclusion, and the late data products) as ordinary three textures.
     * Available on the `temporal` and `guides` paths after `configure()`.
     * See {@link TemporalGuides} for each product's contract, and
     * docs/temporal-guides.md for the frame stages and consumer rules.
     */
    get guides(): TemporalGuides {
        if (!this._core) {
            throw new Error(
                '@pmndrs/upscaler: guides are only available on the temporal or guides ' +
                    'paths, after configure().',
            );
        }
        return this._core.guides;
    }

    /**
     * True while a split frame is in flight — {@link dispatchGuides} has run
     * this frame and {@link dispatchUpscale} hasn't yet. Lets a driver decide
     * between finishing the split frame and the monolithic {@link dispatch}.
     */
    get guidesPending(): boolean {
        return this._core?.guidesPending ?? false;
    }

    /**
     * Per-pass GPU times (ms) of the latest timed frame, keyed by pass label.
     * Holds only the passes that frame ran, so summing it gives the frame's
     * upscale cost. Empty while {@link gpuTiming} is off, without
     * `timestamp-query` support, and for the first frame or so after timing
     * starts.
     */
    get gpuTimings(): ReadonlyMap<string, number> {
        return this._core?.gpuTimings ?? EMPTY_TIMINGS;
    }

    /**
     * Whether per-pass GPU timing is collected. Off by default: nothing in the
     * pipeline reads the timings, they exist for profiling. Each timed frame
     * attaches timestamp writes to every pass, resolves the queries and maps a
     * readback buffer; a timer holds 8 query sets and 16 buffers. Turning it
     * off frees all of that and empties {@link gpuTimings}; turning it on
     * allocates on the spot (or at `init()`), and timings start a frame or so
     * later.
     */
    get gpuTiming(): boolean {
        return this._gpuTiming;
    }

    set gpuTiming(enabled: boolean) {
        this._gpuTiming = enabled;
        if (this._core) this._core.gpuTiming = enabled;
    }

    // The bench's timer bridge (bench/src/benchmark/BenchmarkResolver.ts)
    // reaches the core's GpuTimer through here.
    private get _timer(): unknown {
        return this._core ? (this._core as unknown as { _timer: unknown })._timer : null;
    }

    /** Drops all temporal history on the next dispatch (camera cut etc.). */
    resetHistory(): void {
        this._core?.resetHistory();
    }

    //* Frame Lifecycle

    /**
     * Starts a frame: advances the jitter sequence and applies it to the
     * camera as a sub-pixel view offset (same mechanism as three's TRAA).
     * The jitter composes with any view offset the app already set on the
     * camera (tiled or multi-screen rendering); {@link endFrame} restores
     * that offset exactly. No-op on non-temporal paths, or when jitter is
     * disabled (see the `jitter` config flag — the temporal path still
     * reprojects and accumulates, it just doesn't add the sub-pixel offset).
     * @param camera - The scene camera (perspective or orthographic)
     */
    beginFrame(camera: JitterableCamera): void {
        // A frame left open (no endFrame) must not snapshot its own jitter as
        // the app's view, or the offsets would compound frame over frame.
        this._restoreView();

        // Snapshot the jitter-free projection for velocity before offsetting.
        // It keeps the app's own view offset; only the jitter is excluded.
        camera.updateProjectionMatrix();
        this.unjitteredProjectionMatrix.copy(camera.projectionMatrix);

        const core = this._core;
        const jitter = core?.beginFrame();
        if (!core || !jitter) return;
        this._viewSnapshot = applyJitterViewOffset(
            camera,
            jitter.x,
            jitter.y,
            core.renderWidth,
            core.renderHeight,
        );
    }

    /**
     * Ends a frame: removes the jitter, putting the camera's view offset back
     * exactly as it was before {@link beginFrame} (none stays none; an
     * app-set offset keeps its values). No-op when no jitter was applied.
     * @param _camera - The camera passed to {@link beginFrame} (the restore
     * targets the camera recorded there)
     */
    endFrame(_camera: JitterableCamera): void {
        this._restoreView();
    }

    private _restoreView(): void {
        if (!this._viewSnapshot) return;
        restoreViewOffset(this._viewSnapshot);
        this._viewSnapshot = null;
    }

    /**
     * Encodes and submits the upscaling passes for this frame. Call after
     * the scene has been rendered into the input textures.
     * @param inputs - Scene color (+ depth/velocity for the temporal path) and frame info
     * @param camera - The scene camera (near/far and projection type)
     */
    dispatch(inputs: DispatchInputs, camera: JitterableCamera): void {
        const core = this._readyCore();
        core.dispatch(this._resolveInputs(inputs), this._frameInfo(camera));
    }

    /**
     * Encodes and submits only the early geometry stage — the reconstruct
     * pass producing the {@link TemporalGuides} products `dilatedMotion`,
     * `dilatedDepth`, and `disocclusion` — so effects that run before the
     * final beauty color exists can consume them.
     *
     * On the `temporal` path this starts a split frame: render/composite the
     * final color afterwards, then finish with {@link dispatchUpscale}. On
     * the `guides` path this is the whole frame. Queue ordering makes the
     * outputs visible to any work submitted afterwards — no explicit sync.
     * @param inputs - Depth + velocity (+ optional reset/deltaTime)
     * @param camera - The scene camera (near/far and projection type)
     */
    dispatchGuides(inputs: GuideDispatchInputs, camera: JitterableCamera): void {
        const core = this._readyCore();
        const resolved: CoreGuideDispatchInputs = {
            depth: getGPUTexture(this._renderer, inputs.depth),
            velocity: getGPUTexture(this._renderer, inputs.velocity),
            reset: inputs.reset,
            deltaTime: inputs.deltaTime,
        };
        core.dispatchGuides(resolved, this._frameInfo(camera));
    }

    /**
     * Finishes a split frame: encodes and submits everything after the
     * geometry stage (reactive, exposure, shading change, accumulate, and
     * the RCAS/output pass). Requires {@link dispatchGuides} earlier in the
     * same frame; equivalent to {@link dispatch} apart from the split.
     * @param inputs - Scene color (+ optional reactive/exposure inputs)
     * @param camera - The camera passed to {@link dispatchGuides}
     */
    dispatchUpscale(inputs: DispatchInputs, camera: JitterableCamera): void {
        if (!this._core) throw new Error("@pmndrs/upscaler: await init() before dispatchUpscale().");
        this._core.dispatchUpscale(this._resolveInputs(inputs), this._frameInfo(camera));
    }

    /** Releases all GPU resources. */
    dispose(): void {
        this._core?.dispose();
        this._core = null;
    }

    //* Three Bridge

    // Dispatch before configure()/init() is the not-ready case, reported like
    // the core's own (warn once, then throw).
    private _readyCore(): UpscalerCore<StorageTexture> {
        if (!this._core) throw notReadyError(this, 'Upscaler', 'preparing');
        return this._core;
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

    private _frameInfo(camera: JitterableCamera): FrameCamera {
        this._frameCamera = camera;
        const frame = this._frame;
        frame.near = camera.near;
        frame.far = camera.far;
        frame.perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
        frame.reversedDepth =
            (this._renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer === true;
        return frame;
    }

    // The bench `camera` variant's side uniform: the z row of
    // prevView * currentCameraWorld (current view space → previous view depth)
    // and the unjittered projection's unprojection terms. The core calls it
    // once per frame (from the guides stage), so the previous view rolls
    // forward here.
    private _writeReproject(): Float32Array<ArrayBuffer> {
        const camera = this._frameCamera!;
        camera.updateMatrixWorld();
        const view = camera.matrixWorldInverse;
        if (!this._hasPrevView) this._prevViewMatrix.copy(view);
        const m = this._relativeView.multiplyMatrices(this._prevViewMatrix, camera.matrixWorld).elements;
        const p = this.unjitteredProjectionMatrix.elements;
        const perspective = (camera as PerspectiveCamera).isPerspectiveCamera === true;
        const d = this._reprojectData;
        // Column-major: row 2 is elements 2, 6, 10, 14. Negated so the dot
        // product yields a positive view distance.
        d[0] = -m[2];
        d[1] = -m[6];
        d[2] = -m[10];
        d[3] = -m[14];
        d[4] = 1 / p[0];
        d[5] = 1 / p[5];
        d[6] = perspective ? p[8] : -p[12];
        d[7] = perspective ? p[9] : -p[13];
        this._prevViewMatrix.copy(view);
        this._hasPrevView = true;
        return d;
    }
}
