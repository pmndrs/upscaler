import {
    FloatType,
    HalfFloatType,
    Matrix4,
    NearestFilter,
    NoColorSpace,
    RGBAFormat,
    RedFormat,
    UnsignedByteType,
    type OrthographicCamera,
    type PerspectiveCamera,
} from 'three';
import { StorageTexture, type Texture, type WebGPURenderer } from 'three/webgpu';

import { UpscalerCore } from './core/UpscalerCore.js';
import type { CoreConfiguration, CoreResources, FrameData, TextureResource } from './core/types.js';
import { notReadyError } from './initializationError.js';
import { GpuTimer } from './internal/GpuTimer.js';
import { getDevice, getGPUTexture } from './internal/threeWebGPU.js';
import { JitterSequence } from './math/jitter.js';
import { applyJitterViewOffset, restoreViewOffset, type ViewOffsetSnapshot } from './math/viewOffset.js';
import { getQualityModeRatio, getRenderResolution } from './math/resolution.js';
import {
    DebugView,
    QualityMode,
    type UpscalerConfig,
    type DispatchInputs,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
} from './types.js';

type JitterableCamera = PerspectiveCamera | OrthographicCamera;

const EMPTY_TIMINGS: ReadonlyMap<string, number> = new Map();

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

type UpscalerInternalOptions = UpscalerOptions & {
    _rcasShader?: string;
    // Bench-only: an RCAS for the spatial path that differs from `_rcasShader`
    // (a frozen temporal identity that still runs FSR1 on production RCAS).
    _spatialRcasShader?: string;
    // Bench-only: a shading-change shader with production's bindings (block
    // memory at 9 / 10 included) — the NEXT-STEPS §14 candidates and the
    // frozen pre-memory identity in bench/src/candidates/shaders/shadingChangeRange.ts.
    _shadingChangeShader?: string;
    // Bench-only: a depth-clip shader with production's bindings — the
    // issue #79 variants in shaders/reconstructVariants.ts.
    _depthClipShader?: string;
    // Bench-only: a single-pass cross-frame reconstruct (the frozen pre-#67
    // form, or its camera-compensated variant — shaders/reconstructVariants.ts)
    // in place of the production scatter + depth clip pair.
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
    private readonly _rcasShader: string | undefined;
    private readonly _spatialRcasShader: string | null;
    private readonly _shadingChangeShader: string | null;
    private readonly _depthClipShader: string | null;
    private readonly _crossFrameReconstruct: { shader: string; cameraCompensated: boolean } | null;
    private _device!: GPUDevice;
    private _core!: UpscalerCore;
    private _splitResources: CoreResources | null = null;
    private _reprojectionForFrame: Float32Array | undefined;
    // Null while GPU timing is off: nothing is allocated, nothing attached.
    private _timer: GpuTimer | null = null;
    private _gpuTiming: boolean;

    // Bench-only `camera` identity state (unused in production).
    private readonly _reprojectData = new Float32Array(8);
    private readonly _prevViewMatrix = new Matrix4();
    private readonly _relativeView = new Matrix4();
    private _hasPrevView = false;
    private _frameCamera: JitterableCamera | null = null;

    private _path: UpscalePath = 'temporal';
    private _variants: Pick<CoreConfiguration, 'depthMode' | 'exposureMode' | 'correctConditioningExposure' | 'rcasAgeKnee'> = {};
    private readonly _views = new WeakMap<GPUTexture, GPUTextureView>();
    private _displayWidth = 0;
    private _displayHeight = 0;
    private _renderWidth = 0;
    private _renderHeight = 0;
    private _ratio = 1;

    private _jitter!: JitterSequence;
    private _jitterEnabled = true;
    // Stable objects behind the public jitter getters (no per-read allocation).
    private readonly _jitterOut = { x: 0, y: 0 };
    private readonly _jitterPreviousOut = { x: 0, y: 0 };
    // The camera's view state from before this frame's jitter, held while the
    // jitter is applied (beginFrame → endFrame). Restoring from it, rather
    // than clearing, keeps an app-set view offset (tiled/multi-screen) intact.
    private _viewSnapshot: ViewOffsetSnapshot | null = null;
    private _frameIndex = 0;
    private _pendingReset = true;
    private _warnedMsaa = false;
    private _historyIndex = 0;
    private _depthIndex = 0;
    private _initialized = false;
    private _generation = 0;
    private _deviceLost = false;
    private get _passes() { return this._core.passes; }
    private _effectiveSettings: RuntimeSettings = { ...this.settings };
    private _shadingActive = false;
    private _debugActive = false;

    // GPU-side working set (owned raw textures + the three-visible output)
    private _output: StorageTexture | null = null;
    private _outputGPU: GPUTexture | null = null;
    private _history: [GPUTexture, GPUTexture] | null = null;
    // Luminance-stability lock state (r = lock lifetime, g = locked luma,
    // b = shading-change age, a = resolved alpha), ping-ponged with history.
    private _locks: [GPUTexture, GPUTexture] | null = null;
    private _dilatedDepth: [GPUTexture, GPUTexture] | null = null;
    // Reconstructed previous depth (u32 = f32 bits), ping-ponged: one is
    // scattered into while the depth clip empties the other for next frame.
    private _dilatedMotion: GPUTexture | null = null;
    private _masks: GPUTexture | null = null;
    private _easuOutput: GPUTexture | null = null;
    // Auto-exposure state: 1×1 exposure value (r = exposure, g = avg luma,
    // b = host pre-exposure), ping-ponged so eye-adaptation can ease from last
    // frame's value.
    private _exposure: [GPUTexture, GPUTexture] | null = null;
    // 1×1 zero texture bound in place of a reactive mask when the caller
    // doesn't supply one (WebGPU zero-inits it, so reactivity reads 0).
    private _reactiveDummy: GPUTexture | null = null;
    // Render-res target the auto-generated reactive mask is written into when
    // the caller passes an opaque-only color to diff against the final color.
    private _reactiveGenerated: GPUTexture | null = null;
    // Production shading-change detector state.
    private _shadingLumaHistory: [GPUTexture, GPUTexture] | null = null;
    private _shadingSignal: GPUTexture | null = null;
    // Per-block memory of past means (shadingChange.ts), ping-ponged with
    // history. Stale once a temporal frame ran without the detector: it is
    // zeroed before the detector next runs. The shader reads an all-zero
    // memory as empty: it suppresses nothing and restarts from the current mean.
    private _shadingBlockMemory: [GPUTexture, GPUTexture] | null = null;

    //* Published Guides (contract: docs/temporal-guides.md)
    // The production working set is allocated as three StorageTextures so the
    // guides bundle is consumable outside (TSL texture() nodes, raw bind
    // groups); the raw fields above keep holding the GPU handles the encode
    // paths bind.
    private _guideTex: {
        dilatedMotion: StorageTexture | null;
        dilatedDepth: [StorageTexture, StorageTexture] | null;
        masks: StorageTexture | null;
        reactiveGenerated: StorageTexture | null;
        shadingSignal: StorageTexture | null;
        exposure: [StorageTexture, StorageTexture] | null;
        locks: [StorageTexture, StorageTexture] | null;
        history: [StorageTexture, StorageTexture] | null;
    } = {
        dilatedMotion: null,
        dilatedDepth: null,
        masks: null,
        reactiveGenerated: null,
        shadingSignal: null,
        exposure: null,
        locks: null,
        history: null,
    };
    private _guides: TemporalGuides | null = null;
    // Ping-pong halves most recently written, so the guides getters resolve
    // "current" vs "previous" correctly both mid-frame (between the split
    // dispatches) and after the frame-end index flips.
    private _latestDepthWrite = 0;
    private _latestHistoryWrite = 0;
    // A split frame is in flight: dispatchGuides() ran, dispatchUpscale()
    // hasn't. Guards against double-encoding the guides stage.
    private _guidesPending = false;

    constructor(options: UpscalerOptions);
    constructor(options: UpscalerInternalOptions) {
        this._renderer = options.renderer;
        this._gpuTiming = options.gpuTiming ?? false;
        // Any override must declare RCAS's alpha-source binding (4) — every
        // shader in rcas.ts does — because _encodeRcas always binds it.
        this._rcasShader = options._rcasShader;
        this._spatialRcasShader = options._spatialRcasShader ?? null;
        this._shadingChangeShader = options._shadingChangeShader ?? null;
        this._depthClipShader = options._depthClipShader ?? null;
        this._crossFrameReconstruct = options._crossFrameReconstruct ?? null;
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
        this._ensureResources();
        const preparation = this._deviceLost
            ? Promise.reject(new Error("@pmndrs/upscaler: GPU device lost."))
            : this._queuePreparation(true);
        // Pass failures already report their cause. Ignored promises must not add
        // an unhandled rejection; returning the original still rejects for awaiters.
        void preparation.catch(() => {});
        return preparation;
    }

    /** Mandatory passes are ready; newly requested optional passes may still be preparing. */
    get isReady(): boolean {
        return this._initialized && !this._deviceLost &&
            this._core.isReady;
    }

    /** The debug view actually used by the most recent frame (None while preparing). */
    get activeDebugView(): DebugView {
        return this._effectiveSettings.debugView;
    }

    private _ensureResources(): void {
        if (this._initialized) return;
        const device = getDevice(this._renderer);
        this._device = device;
        this._deviceLost = false;
        const generation = this._generation;
        void device.lost.then(() => {
            if (generation === this._generation) this._deviceLost = true;
        });
        this._core = new UpscalerCore({
            device,
            timestampWrites: name => this._timer?.passDescriptor(name),
            shaders: {
                rcas: this._rcasShader,
                ...(this._spatialRcasShader ? { spatialRcas: this._spatialRcasShader } : {}),
                ...(this._shadingChangeShader ? { shadingChange: this._shadingChangeShader } : {}),
                ...(this._depthClipShader ? { depthClip: this._depthClipShader } : {}),
                ...(this._crossFrameReconstruct ? { reconstruct: this._crossFrameReconstruct.shader } : {}),
            },
            crossFrameReconstruct: !!this._crossFrameReconstruct,
            cameraCompensated: this._crossFrameReconstruct?.cameraCompensated,
        });
        if (this._gpuTiming) this._timer = new GpuTimer(device);
        this._jitter = new JitterSequence(this._ratio);
        this._initialized = true;
    }





    private _queuePreparation(retry: boolean): Promise<void> {
        return this._core.prepare(this._path === 'temporal' ? this.settings : {}, retry);
    }

    private _startDispatch(): void {
        if (!this.isReady) {
            throw notReadyError(this, 'Upscaler', this._deviceLost ? 'device-lost' : 'preparing');
        }
        // Automatic preparation handles rejection here; explicit prepare() still rejects.
        void this._queuePreparation(false).catch(() => {});
        const shading = this._path === 'temporal' && this.settings.detectShadingChanges && this._passes.has('shadingChange');
        const debug = this._path === 'temporal' && this.settings.debugView !== DebugView.None && this._passes.has('debug');
        if ((shading && !this._shadingActive) || (debug && !this._debugActive)) {
            // The input may already have rendered with this frame's jitter.
            // Invalidate history without changing that projection's sample.
            this._pendingReset = true;
        }
        this._shadingActive = shading;
        this._debugActive = debug;
        this._effectiveSettings = {
            ...this.settings, detectShadingChanges: shading,
            debugView: debug ? this.settings.debugView : DebugView.None,
        };
    }

    /**
     * (Re)configures resolutions and the active pipeline. Allocates the
     * working texture set — call on startup, resize, or mode change.
     * @param config - Display size, quality mode/ratio, and pipeline path
     */
    configure(config: UpscalerConfig): void {
        if (this._guidesPending) throw new Error('@pmndrs/upscaler: cannot configure during a split frame.');
        this._ensureResources();

        // A new pass graph: samples still in flight from the old one must not
        // land in gpuTimings after it.
        this._timer?.reset();
        this._path = config.path ?? 'temporal';
        this._variants = { depthMode: config.depthMode ?? 'hardware', exposureMode: config.exposureMode ?? 'upstream', correctConditioningExposure: config.correctConditioningExposure ?? false, rcasAgeKnee: config.rcasAgeKnee ?? 0 };
        this._jitterEnabled = config.jitter ?? true;
        this._displayWidth = Math.max(1, Math.floor(config.displayWidth));
        this._displayHeight = Math.max(1, Math.floor(config.displayHeight));

        if (config.renderWidth && config.renderHeight) {
            // Explicit render size — the input is produced by an external pass
            // whose resolution we don't control (e.g. the TSL node feeding a
            // reduced-res effect graph). Match it exactly and derive the ratio.
            this._renderWidth = Math.max(1, Math.floor(config.renderWidth));
            this._renderHeight = Math.max(1, Math.floor(config.renderHeight));
            this._ratio = this._displayWidth / this._renderWidth;
        } else {
            this._ratio =
                config.customUpscaleRatio ??
                getQualityModeRatio(config.qualityMode ?? QualityMode.Quality);
            const render = getRenderResolution(this._displayWidth, this._displayHeight, this._ratio);
            this._renderWidth = render.width;
            this._renderHeight = render.height;
        }

        this._core.configure({
            renderWidth: this._renderWidth, renderHeight: this._renderHeight,
            displayWidth: this._displayWidth, displayHeight: this._displayHeight, path: this._path,
            ...this._variants,
        });
        this._jitter.setRatio(this._ratio);
        this._allocateTextures();
        this.resetHistory();
        void this._queuePreparation(false).catch(() => {});
    }

    //* Accessors

    /** Render (input) resolution in pixels. */
    get renderWidth(): number {
        return this._renderWidth;
    }

    get renderHeight(): number {
        return this._renderHeight;
    }

    /** Display (output) resolution in pixels. */
    get displayWidth(): number {
        return this._displayWidth;
    }

    get displayHeight(): number {
        return this._displayHeight;
    }

    /** Current upscale ratio (display / render). */
    get upscaleRatio(): number {
        return this._ratio;
    }

    /** Number of jitter phases at the current ratio. */
    get jitterPhaseCount(): number {
        return this._jitter.phaseCount;
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
        return this._readJitter(this._jitterOut, false);
    }

    /**
     * The previous frame's jitter, same convention as {@link jitter}: the
     * offset reprojection compensates against. On the first frame after a
     * reset history is discarded, so nothing uses it there.
     */
    get jitterPrevious(): JitterOffset {
        return this._readJitter(this._jitterPreviousOut, true);
    }

    /**
     * Index of this frame's {@link jitter} in
     * `generateJitterSequence(jitterPhaseCount)`, `0 … jitterPhaseCount − 1`.
     * `beginFrame()` advances before applying, so the first frame after
     * `configure()` or `resetHistory()` is phase 1, and phase 0 ends the cycle.
     * `0` when jitter is disabled or the path isn't `temporal`.
     */
    get jitterPhase(): number {
        return this._jittering ? this._jitter.phaseIndex : 0;
    }

    private get _jittering(): boolean {
        return this._initialized && this._path === 'temporal' && this._jitterEnabled;
    }

    private _readJitter(out: { x: number; y: number }, previous: boolean): JitterOffset {
        if (!this._jittering) {
            out.x = 0;
            out.y = 0;
            return out;
        }
        const [x, y] = previous ? this._jitter.previous : this._jitter.current;
        out.x = x;
        out.y = y;
        return out;
    }

    /**
     * The upscaled result as a three texture — sample it on a fullscreen
     * quad or feed it into later post-processing. Values remain in the
     * caller's linear/HDR domain; presentation is the caller's responsibility.
     */
    get outputTexture(): Texture {
        if (!this._output) {
            if (this._path === 'guides') {
                throw new Error(
                    "@pmndrs/upscaler: the 'guides' path produces no upscaled output — " +
                        'consume the guides bundle instead (upscaler.guides).',
                );
            }
            throw new Error('@pmndrs/upscaler: configure() must run before outputTexture is used.');
        }
        return this._output;
    }

    /**
     * The published temporal-guides bundle (dilated motion/depth,
     * disocclusion, and the late data products) as ordinary three textures.
     * Available on the `temporal` and `guides` paths after `configure()`.
     * See {@link TemporalGuides} for each product's contract, and
     * docs/temporal-guides.md for the frame stages and consumer rules.
     */
    get guides(): TemporalGuides {
        if (!this._guides) {
            throw new Error(
                '@pmndrs/upscaler: guides are only available on the temporal or guides ' +
                    'paths, after configure().',
            );
        }
        return this._guides;
    }

    /**
     * True while a split frame is in flight — {@link dispatchGuides} has run
     * this frame and {@link dispatchUpscale} hasn't yet. Lets a driver decide
     * between finishing the split frame and the monolithic {@link dispatch}.
     */
    get guidesPending(): boolean {
        return this._guidesPending;
    }

    /**
     * Per-pass GPU times (ms) of the latest timed frame, keyed by pass label.
     * Holds only the passes that frame ran, so summing it gives the frame's
     * upscale cost. Empty while {@link gpuTiming} is off, without
     * `timestamp-query` support, and for the first frame or so after timing
     * starts.
     */
    get gpuTimings(): ReadonlyMap<string, number> {
        return this._timer?.timings ?? EMPTY_TIMINGS;
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
        if (enabled === this._gpuTiming) return;
        this._gpuTiming = enabled;
        if (!this._initialized) return;
        if (enabled) this._timer = new GpuTimer(this._device);
        else {
            this._timer?.dispose();
            this._timer = null;
        }
    }

    /** Drops all temporal history on the next dispatch (camera cut etc.). */
    resetHistory(): void {
        this._pendingReset = true;
        this._guidesPending = false;
        this._splitResources = null;
        this._core.resetHistory();
        this._jitter.reset();
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

        if (this._path !== 'temporal' || !this._jitterEnabled) return;

        this._jitter.advance();
        const [jx, jy] = this._jitter.current;
        this._viewSnapshot = applyJitterViewOffset(
            camera,
            jx,
            jy,
            this._renderWidth,
            this._renderHeight,
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
        this._startDispatch();
        if (this._path === 'guides') throw new Error("@pmndrs/upscaler: the guides path has no upscale; use dispatchGuides().");
        if (this._guidesPending) throw new Error('@pmndrs/upscaler: a split frame is in flight; finish dispatchUpscale().');
        const encoder = this._device.createCommandEncoder({ label: 'upscale' });
        this._timer?.beginFrame(this._frameIndex);
        this._latestDepthWrite = this._depthIndex;
        this._latestHistoryWrite = 1 - this._historyIndex;
        this._core.encode(encoder, this._coreResources(inputs), this._coreFrame(inputs, camera));
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer?.readback();
        this._frameIndex++; this._pendingReset = false;
        if (this._path === 'temporal') {
            this._historyIndex = 1 - this._historyIndex;
            this._depthIndex = 1 - this._depthIndex;
        }
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
        this._startDispatch();
        if (this._guidesPending) throw new Error('@pmndrs/upscaler: a split frame is already in flight.');
        const resources = this._coreResources(inputs);
        const frame = this._coreFrame(inputs, camera);
        const encoder = this._device.createCommandEncoder({ label: 'upscale-guides' });
        this._timer?.beginFrame(this._frameIndex);
        this._latestDepthWrite = this._depthIndex;
        this._core.encodeGuides(encoder, resources, frame);
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer?.readback(this._path === 'guides');
        if (this._path === 'guides') {
            this._frameIndex++; this._pendingReset = false; this._depthIndex = 1 - this._depthIndex;
        } else { this._guidesPending = true; this._splitResources = resources; }
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
        if (!this.isReady) throw new Error('@pmndrs/upscaler: await init() before dispatchUpscale().');
        if (!this._guidesPending || !this._splitResources) throw new Error('@pmndrs/upscaler: call dispatchGuides() first.');
        const encoder = this._device.createCommandEncoder({ label: 'upscale-late' });
        this._timer?.beginFrame(this._frameIndex);
        this._latestHistoryWrite = 1 - this._historyIndex;
        this._core.encodeUpscale(encoder, { ...this._splitResources, ...this._coreResources(inputs) }, this._coreFrame(inputs, camera));
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer?.readback();
        this._guidesPending = false; this._splitResources = null;
        this._frameIndex++; this._pendingReset = false;
        this._historyIndex = 1 - this._historyIndex; this._depthIndex = 1 - this._depthIndex;
    }

    /** Releases all GPU resources. */
    dispose(): void {
        this._generation++;
        this._shadingActive = false; this._debugActive = false;
        this._destroyTextures(); this._core?.dispose();
        this._timer?.dispose(); this._timer = null;
        this._initialized = false;
    }

    /** Resolve allocations and history halves owned by this Three adapter. */
    private _coreResources(inputs: Omit<DispatchInputs, 'color'> & { color?: Texture }): CoreResources {
        const borrow = (texture: GPUTexture): TextureResource => {
            let view = this._views.get(texture);
            if (!view) {
                view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1, aspect: texture.format.startsWith('depth') ? 'depth-only' : 'all' });
                this._views.set(texture, view);
            }
            return { texture, view };
        };
        const pair = (textures: [GPUTexture, GPUTexture], read: number) => ({ read: borrow(textures[read]), write: borrow(textures[1 - read]) });
        const r: CoreResources = {};
        for (const name of ['color', 'depth', 'velocity', 'reactive', 'reactiveOpaqueColor', 'exposureTexture', 'preExposureTexture'] as const) {
            const input = inputs[name];
            if (input) r[name] = borrow(getGPUTexture(this._renderer, input));
        }
        if (this._outputGPU) r.output = borrow(this._outputGPU);
        if (this._exposure) r.exposure = pair(this._exposure, this._historyIndex);
        if (this._reactiveDummy) r.dummy = borrow(this._reactiveDummy);
        if (this._easuOutput) r.easuOutput = borrow(this._easuOutput);
        if (this._dilatedDepth) r.dilatedDepth = pair(this._dilatedDepth, 1 - this._depthIndex);
        if (this._dilatedMotion) r.dilatedMotion = borrow(this._dilatedMotion);
        if (this._masks) r.masks = borrow(this._masks);
        if (this._history) r.history = pair(this._history, this._historyIndex);
        if (this._locks) r.locks = pair(this._locks, this._historyIndex);
        if (this._reactiveGenerated) r.reactiveGenerated = borrow(this._reactiveGenerated);
        if (this._shadingSignal) r.shadingSignal = borrow(this._shadingSignal);
        if (this._shadingLumaHistory) r.shadingLumaHistory = pair(this._shadingLumaHistory, this._historyIndex);
        if (this._shadingBlockMemory) r.shadingBlockMemory = pair(this._shadingBlockMemory, this._historyIndex);
        return r;
    }

    private _coreFrame(inputs: Omit<DispatchInputs, 'color'>, camera: JitterableCamera): FrameData {
        this._frameCamera = camera;
        if (inputs.reset) this._pendingReset = true;
        if (this._crossFrameReconstruct?.cameraCompensated && !this._guidesPending) this._reprojectionForFrame = this._writeReproject();
        return {
            frameIndex: this._frameIndex, deltaTime: inputs.deltaTime ?? 1 / 60, hostPreExposure: inputs.hostPreExposure,
            jitter: { ...this.jitter }, jitterPrevious: { ...this.jitterPrevious },
            motionScale: { x: 0.5, y: -0.5 }, near: camera.near, far: camera.far,
            perspective: (camera as PerspectiveCamera).isPerspectiveCamera === true,
            reversedDepth: (this._renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer,
            reset: this._pendingReset, settings: this._effectiveSettings, reprojection: this._reprojectionForFrame,
        };
    }

    private _writeReproject(): Float32Array {
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

    //* Texture Allocation

    private _createTexture(
        label: string,
        w: number,
        h: number,
        format: GPUTextureFormat,
        extraUsage = 0,
    ): GPUTexture {
        return this._device.createTexture({
            label: `upscale-${label}`,
            size: { width: w, height: h },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | extraUsage,
        });
    }

    // Allocates a working texture through three (same mechanism as the output)
    // so it is publishable in the guides bundle: the three StorageTexture is
    // what consumers sample, the raw handle is what our passes bind.
    private _createSharedTexture(
        label: string,
        w: number,
        h: number,
        format: 'r32float' | 'rgba8unorm' | 'rgba16float' | 'rgba32float',
    ): { tex: StorageTexture; gpu: GPUTexture } {
        const tex = new StorageTexture(w, h);
        tex.name = `upscale-${label}`;
        tex.colorSpace = NoColorSpace;
        // Storage views must cover exactly one mip level (see _output).
        tex.generateMipmaps = false;
        switch (format) {
            case 'rgba32float':
                tex.format = RGBAFormat; tex.type = FloatType;
                tex.minFilter = NearestFilter; tex.magFilter = NearestFilter;
                break;
            case 'r32float':
                tex.format = RedFormat;
                tex.type = FloatType;
                // r32float is non-filterable — consumers must sample nearest.
                tex.minFilter = NearestFilter;
                tex.magFilter = NearestFilter;
                break;
            case 'rgba8unorm':
                tex.format = RGBAFormat;
                tex.type = UnsignedByteType;
                break;
            case 'rgba16float':
                tex.format = RGBAFormat;
                tex.type = HalfFloatType;
                break;
        }
        this._renderer.initTexture(tex);
        return { tex, gpu: getGPUTexture(this._renderer, tex) };
    }

    private _allocateTextures(): void {
        this._destroyTextures();
        const rw = this._renderWidth;
        const rh = this._renderHeight;
        const dw = this._displayWidth;
        const dh = this._displayHeight;
        const guidesOnly = this._path === 'guides';

        if (!guidesOnly) {
            // The output is a three StorageTexture so the caller can sample it
            // like any other texture; initTexture forces GPU-side creation so
            // the storage view exists before the first dispatch.
            this._output = new StorageTexture(dw, dh);
            this._output.name = 'upscale-output';
            this._output.colorSpace = NoColorSpace;
            this._output.type = HalfFloatType;
            // Texture.generateMipmaps defaults to true, which would make three
            // allocate a mip chain — storage views must cover exactly one level.
            this._output.generateMipmaps = false;
            this._renderer.initTexture(this._output);
            this._outputGPU = getGPUTexture(this._renderer, this._output);

            // Exposure is a 1×1 value read by every output path (blit/rcas), so
            // it is allocated for all upscaling paths even though only the
            // temporal path computes it — the others bind [0] unused.
            const exposureFormat = this._variants.exposureMode === 'provided' ? 'rgba32float' : 'rgba16float';
            const exposure0 = this._createSharedTexture('exposure-0', 1, 1, exposureFormat);
            const exposure1 = this._createSharedTexture('exposure-1', 1, 1, exposureFormat);
            this._guideTex.exposure = [exposure0.tex, exposure1.tex];
            this._exposure = [exposure0.gpu, exposure1.gpu];
            // Sampled-only (no storage) so a non-storage format is fine; zero-init
            // gives a "nothing reactive" default when the caller passes no mask.
            this._reactiveDummy = this._device.createTexture({
                label: 'upscale-reactive-dummy',
                size: { width: 1, height: 1 },
                format: 'r8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING,
            });
        }

        if (this._path === 'spatial') {
            this._easuOutput = this._createTexture('easu-output', dw, dh, 'rgba16float');
        }

        //* Geometry guide set — the temporal front-end, also the whole of the
        //* guides path.
        if (this._path === 'temporal' || guidesOnly) {
            const depth0 = this._createSharedTexture('dilated-depth-0', rw, rh, 'r32float');
            const depth1 = this._createSharedTexture('dilated-depth-1', rw, rh, 'r32float');
            this._guideTex.dilatedDepth = [depth0.tex, depth1.tex];
            this._dilatedDepth = [depth0.gpu, depth1.gpu];
            const motion = this._createSharedTexture('dilated-motion', rw, rh, 'rgba16float');
            this._guideTex.dilatedMotion = motion.tex;
            this._dilatedMotion = motion.gpu;
            const masks = this._createSharedTexture(
                'masks',
                rw,
                rh,
                'rgba8unorm',
            );
            this._guideTex.masks = masks.tex;
            this._masks = masks.gpu;
            this._latestDepthWrite = this._depthIndex;
        }

        if (this._path === 'temporal') {
            const history0 = this._createSharedTexture('history-0', dw, dh, 'rgba16float');
            const history1 = this._createSharedTexture('history-1', dw, dh, 'rgba16float');
            this._guideTex.history = [history0.tex, history1.tex];
            this._history = [history0.gpu, history1.gpu];
            const locks0 = this._createSharedTexture('locks-0', dw, dh, 'rgba16float');
            const locks1 = this._createSharedTexture('locks-1', dw, dh, 'rgba16float');
            this._guideTex.locks = [locks0.tex, locks1.tex];
            this._locks = [locks0.gpu, locks1.gpu];
            const reactiveGen = this._createSharedTexture('reactive-gen', rw, rh, 'rgba8unorm');
            this._guideTex.reactiveGenerated = reactiveGen.tex;
            this._reactiveGenerated = reactiveGen.gpu;
            this._latestHistoryWrite = this._historyIndex;
            //* Shading-change detector state (shadingChange.ts)
            this._shadingLumaHistory = [
                this._createTexture('shading-luma-0', rw, rh, 'r32float'),
                this._createTexture('shading-luma-1', rw, rh, 'r32float'),
            ];
            const shadingSignal = this._createSharedTexture(
                'shading-signal',
                Math.max(1, Math.ceil(rw / 2)),
                Math.max(1, Math.ceil(rh / 2)),
                'r32float',
            );
            this._guideTex.shadingSignal = shadingSignal.tex;
            this._shadingSignal = shadingSignal.gpu;
            // Block memory: the 4×4 blocks' rows, then the 8×8 blocks' rows;
            // 8 f16 means per rgba32uint texel. Allocated zeroed, which the
            // shader treats as empty (configure() also resets history, which
            // restarts every block on the first frame anyway).
            const memoryWidth = Math.max(1, Math.ceil(rw / 4));
            const memoryHeight = Math.max(1, Math.ceil(rh / 4) + Math.ceil(rh / 8));
            this._shadingBlockMemory = [
                // COPY_DST: reset copies are ordered with the host compute passes.
                this._createTexture('shading-memory-0', memoryWidth, memoryHeight, 'rgba32uint', GPUTextureUsage.COPY_DST),
                this._createTexture('shading-memory-1', memoryWidth, memoryHeight, 'rgba32uint', GPUTextureUsage.COPY_DST),
            ];

        }

        this._guides =
            this._path === 'temporal' || guidesOnly ? this._buildGuides() : null;
    }

    // The bundle resolves through getters so ping-ponged products always point
    // at the most recently written half — consumers re-read per frame.
    private _buildGuides(): TemporalGuides {
        // Object-literal getters rebind `this` to the bundle — the alias is the
        // idiomatic way to reach the upscaler's live state from them.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const upscaler = this;
        return {
            get dilatedMotion() {
                return upscaler._guideTex.dilatedMotion!;
            },
            get dilatedDepth() {
                return upscaler._guideTex.dilatedDepth![upscaler._latestDepthWrite];
            },
            get previousDepth() {
                return upscaler._guideTex.dilatedDepth![1 - upscaler._latestDepthWrite];
            },
            get disocclusion() {
                return upscaler._guideTex.masks!;
            },
            get reactive() {
                return upscaler._guideTex.reactiveGenerated;
            },
            get shadingChange() {
                return upscaler._guideTex.shadingSignal;
            },
            get exposure() {
                return upscaler._guideTex.exposure?.[upscaler._latestHistoryWrite] ?? null;
            },
            get lockStatus() {
                return upscaler._guideTex.locks?.[upscaler._latestHistoryWrite] ?? null;
            },
            get history() {
                return upscaler._guideTex.history?.[upscaler._latestHistoryWrite] ?? null;
            },
        };
    }

    private _destroyTextures(): void {
        this._output?.dispose();
        this._output = null;
        this._outputGPU = null;
        this._easuOutput?.destroy();
        this._easuOutput = null;
        // Published (three-owned) textures: dispose() destroys the backing
        // GPUTexture — never also .destroy() their raw handles.
        const guideTex = this._guideTex;
        guideTex.dilatedMotion?.dispose();
        guideTex.masks?.dispose();
        guideTex.reactiveGenerated?.dispose();
        guideTex.shadingSignal?.dispose();
        guideTex.dilatedDepth?.forEach((t) => t.dispose());
        guideTex.exposure?.forEach((t) => t.dispose());
        guideTex.locks?.forEach((t) => t.dispose());
        guideTex.history?.forEach((t) => t.dispose());
        this._guideTex = {
            dilatedMotion: null,
            dilatedDepth: null,
            masks: null,
            reactiveGenerated: null,
            shadingSignal: null,
            exposure: null,
            locks: null,
            history: null,
        };
        this._guides = null;
        this._guidesPending = false;
        this._history = null;
        this._locks = null;
        this._dilatedDepth = null;
        this._dilatedMotion = null;
        this._masks = null;
        this._exposure = null;
        this._reactiveGenerated = null;
        this._shadingSignal = null;
        this._reactiveDummy?.destroy();
        this._reactiveDummy = null;
        if (this._shadingLumaHistory) {
            this._shadingLumaHistory.forEach((texture) => texture.destroy());
            this._shadingLumaHistory = null;
        }
        if (this._shadingBlockMemory) {
            this._shadingBlockMemory.forEach((texture) => texture.destroy());
            this._shadingBlockMemory = null;
        }
    }
}
