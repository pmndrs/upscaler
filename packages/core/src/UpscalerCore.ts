import { ComputePass } from './internal/ComputePass';
import { notReadyError } from './initializationError';
import { ConstantsBuffer } from './internal/ConstantsBuffer';
import { GpuTimer } from './internal/GpuTimer';
import { JitterSequence } from './math/jitter';
import { getQualityModeRatio, getRenderResolution } from './math/resolution';
import { ACCUMULATE_SHADER } from './shaders/accumulate';
import { BLIT_SHADER } from './shaders/blit';
import {
    FLAG_AUTO_EXPOSURE,
    FLAG_EXTERNAL_EXPOSURE,
    FLAG_INPUT_REINHARD,
    FLAG_LOCKS,
    FLAG_PERSPECTIVE,
    FLAG_RCAS_DENOISE,
    FLAG_REACTIVE,
    FLAG_RESET,
    FLAG_REVERSED_DEPTH,
    FLAG_SHADING_CHANGE,
} from './shaders/common';
import { DEBUG_SHADER } from './shaders/debug';
import { EASU_SHADER } from './shaders/easu';
import { GENERATE_REACTIVE_SHADER } from './shaders/generateReactive';
import { LUMINANCE_PYRAMID_SHADER } from './shaders/luminancePyramid';
import { RCAS_SHADER } from './shaders/rcas';
import { DEPTH_CLIP_SHADER, RECONSTRUCT_SHADER } from './shaders/reconstruct';
import { SHADING_CHANGE_SHADER } from './shaders/shadingChange';
import {
    DebugView,
    QualityMode,
    type UpscalerConfig,
    type DispatchInputs,
    type FrameCamera,
    type GuideDispatchInputs,
    type JitterOffset,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
} from './types';
import { createDeviceTextureAllocator, type CoreTexture, type CoreTextureFormat, type TextureAllocator } from './textures';

const EMPTY_TIMINGS: ReadonlyMap<string, number> = new Map();

/** Construction options for {@link UpscalerCore}. */
export interface UpscalerCoreOptions<THandle = GPUTexture> {
    /**
     * The device the passes run on — the engine's own, so the passes share
     * its queue. The core never creates or destroys it.
     */
    device: GPUDevice;
    /**
     * Allocates the published textures (output and guides) so the engine can
     * sample them. Defaults to plain `device.createTexture()` with the
     * `GPUTexture` as the handle; an engine adapter passes its own (see
     * {@link TextureAllocator}).
     */
    allocateTexture?: TextureAllocator<THandle>;
    /**
     * Collect per-pass GPU times into {@link UpscalerCore.gpuTimings}. Defaults to
     * `false` — a debugging aid with a per-frame cost. See {@link UpscalerCore.gpuTiming}.
     */
    gpuTiming?: boolean;
    /**
     * The settings object to read every frame, held by reference (not
     * copied). Defaults to a fresh object with the standard defaults.
     */
    settings?: RuntimeSettings;
    /**
     * Converts the engine's motion vectors to a UV delta (`prevUV = uv −
     * motion · scale`). Defaults to `[0.5, -0.5]`: an NDC delta, current −
     * previous, y up (three's `velocity` node). See docs/engine-contract.md.
     */
    motionScale?: readonly [number, number];
}

/**
 * Bench-only construction knobs. Not part of the published surface; reached
 * through the private workspace package.
 * @internal
 */
export type UpscalerCoreInternalOptions<THandle = GPUTexture> = UpscalerCoreOptions<THandle> & {
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
    // Bench-only: the camera-compensated cross-frame variant's side uniform
    // (8 floats, see the three adapter's reprojection writer). Called once per
    // frame, from the guides stage.
    _reprojectData?: () => Float32Array<ArrayBuffer>;
};

/**
 * The engine-agnostic FSR3-style upscaler: raw WGSL compute passes on a
 * caller-supplied `GPUDevice`, with GPU-texture inputs and plain camera data.
 * Engine adapters (the three `Upscaler`, …) wrap it; a raw WebGPU app can
 * drive it directly. The engine contract (input formats, motion and depth
 * conventions, submit ordering): docs/engine-contract.md.
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
 * const jitter = core.beginFrame();   // advance; offset your projection by it
 * // render color + depth + motion at core.renderWidth × core.renderHeight
 * core.dispatch({ color, depth, velocity, deltaTime }, { near, far, perspective: true });
 * // core.output is linear/HDR — present or post-process it
 * ```
 */
export class UpscalerCore<THandle = GPUTexture> {
    //* Public State

    /** Runtime tuning knobs — mutate freely between frames. */
    readonly settings: RuntimeSettings;

    //* Internals

    private readonly _device: GPUDevice;
    private readonly _allocate: TextureAllocator<THandle>;
    private readonly _motionScale: readonly [number, number];
    private readonly _rcasShader: string;
    private readonly _spatialRcasShader: string | null;
    private readonly _shadingChangeShader: string | null;
    private readonly _depthClipShader: string | null;
    private readonly _crossFrameReconstruct: { shader: string; cameraCompensated: boolean } | null;
    private _constants!: ConstantsBuffer;
    // Null while GPU timing is off: nothing is allocated, nothing attached.
    private _timer: GpuTimer | null = null;
    private _gpuTiming: boolean;
    private _linearSampler!: GPUSampler;

    private _blitPass!: ComputePass;
    private _easuPass!: ComputePass;
    private _rcasPass!: ComputePass;
    private _spatialRcasPass!: ComputePass;
    private _reconstructPass!: ComputePass;
    private _depthClipPass!: ComputePass;
    // Bench-only `camera` identity state (unused in production).
    private _reprojectBuffer: GPUBuffer | null = null;
    private readonly _reprojectData: (() => Float32Array<ArrayBuffer>) | null;
    private _accumulatePass!: ComputePass;
    private _exposurePass!: ComputePass;
    private _generateReactivePass!: ComputePass;
    private _shadingChangePass!: ComputePass;
    private _debugPass!: ComputePass;

    private _path: UpscalePath = 'temporal';
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
    private _frameIndex = 0;
    private _pendingReset = true;
    private _warnedMsaa = false;
    private _historyIndex = 0;
    private _depthIndex = 0;
    private _initialized = false;
    private _generation = 0;
    private _deviceLost = false;
    private readonly _passes = new Map<string, ComputePass>();
    private readonly _requests = new Map<string, Promise<void>>();
    private readonly _failures = new Map<string, unknown>();
    private _effectiveSettings: RuntimeSettings;
    private _shadingActive = false;
    private _debugActive = false;

    // GPU-side working set (owned raw textures + the engine-visible output)
    private _output: CoreTexture<THandle> | null = null;
    private _outputGPU: GPUTexture | null = null;
    private _history: [GPUTexture, GPUTexture] | null = null;
    // Luminance-stability lock state (r = lock lifetime, g = locked luma,
    // b = shading-change age, a = resolved alpha), ping-ponged with history.
    private _locks: [GPUTexture, GPUTexture] | null = null;
    private _dilatedDepth: [GPUTexture, GPUTexture] | null = null;
    // Reconstructed previous depth (u32 = f32 bits), ping-ponged: one is
    // scattered into while the depth clip empties the other for next frame.
    private _reconstructedDepth: [GPUBuffer, GPUBuffer] | null = null;
    private _scatterIndex = 0;
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
    private _shadingMemoryStale = false;

    //* Published Guides (contract: docs/temporal-guides.md)
    // The production working set is allocated through the texture allocator
    // so the guides bundle is consumable by the engine (TSL texture() nodes,
    // raw bind groups); the raw fields above keep holding the GPU handles the
    // encode paths bind.
    private _guideTex: {
        dilatedMotion: CoreTexture<THandle> | null;
        dilatedDepth: [CoreTexture<THandle>, CoreTexture<THandle>] | null;
        masks: CoreTexture<THandle> | null;
        reactiveGenerated: CoreTexture<THandle> | null;
        shadingSignal: CoreTexture<THandle> | null;
        exposure: [CoreTexture<THandle>, CoreTexture<THandle>] | null;
        locks: [CoreTexture<THandle>, CoreTexture<THandle>] | null;
        history: [CoreTexture<THandle>, CoreTexture<THandle>] | null;
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
    private _guides: TemporalGuides<THandle> | null = null;
    // Ping-pong halves most recently written, so the guides getters resolve
    // "current" vs "previous" correctly both mid-frame (between the split
    // dispatches) and after the frame-end index flips.
    private _latestDepthWrite = 0;
    private _latestHistoryWrite = 0;
    // A split frame is in flight: dispatchGuides() ran, dispatchUpscale()
    // hasn't. Guards against double-encoding the guides stage.
    private _guidesPending = false;

    constructor(options: UpscalerCoreOptions<THandle>);
    constructor(options: UpscalerCoreInternalOptions<THandle>) {
        this._device = options.device;
        // Without an allocator the handles are the GPUTextures themselves.
        this._allocate = options.allocateTexture ??
            (createDeviceTextureAllocator(options.device) as unknown as TextureAllocator<THandle>);
        this._motionScale = options.motionScale ?? [0.5, -0.5];
        this.settings = options.settings ?? {
            sharpness: 0.8,
            rcasDenoise: false,
            maxAccumulation: 24,
            exposure: 1.0,
            autoExposure: true,
            lockThinFeatures: true,
            detectShadingChanges: true,
            debugView: DebugView.None,
        };
        this._effectiveSettings = { ...this.settings };
        this._gpuTiming = options.gpuTiming ?? false;
        // Any override must declare RCAS's alpha-source binding (4) — every
        // shader in rcas.ts does — because _encodeRcas always binds it.
        this._rcasShader = options._rcasShader ?? RCAS_SHADER;
        this._spatialRcasShader = options._spatialRcasShader ?? null;
        this._shadingChangeShader = options._shadingChangeShader ?? null;
        this._depthClipShader = options._depthClipShader ?? null;
        this._crossFrameReconstruct = options._crossFrameReconstruct ?? null;
        this._reprojectData = options._reprojectData ?? null;
    }

    /** Baseline device capability only; does not compile or allocate anything. */
    static isSupported(device: GPUDevice): boolean {
        const limits = device.limits;
        return limits.maxBindGroups >= 1 &&
            limits.maxBindingsPerBindGroup >= 13 &&
            limits.maxSampledTexturesPerShaderStage >= 9 &&
            limits.maxStorageTexturesPerShaderStage >= 3 &&
            limits.maxStorageBuffersPerShaderStage >= 2 &&
            limits.maxUniformBuffersPerShaderStage >= 1 &&
            limits.maxSamplersPerShaderStage >= 1 &&
            limits.maxUniformBufferBindingSize >= ConstantsBuffer.SIZE &&
            limits.maxComputeWorkgroupSizeX >= 8 && limits.maxComputeWorkgroupSizeY >= 8 &&
            limits.maxComputeInvocationsPerWorkgroup >= 64 &&
            limits.maxComputeWorkgroupStorageSize >= 1280;
    }

    /**
     * Compiles the configured path's pipelines (and the enabled optional
     * ones); also retries failed requests. Await before the first dispatch.
     * Configuring queues this too, but only an explicit call retries.
     */
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
            this._mandatoryPasses().every(name => this._passes.has(name));
    }

    /** The debug view actually used by the most recent frame (None while preparing). */
    get activeDebugView(): DebugView {
        return this._effectiveSettings.debugView;
    }

    private _ensureResources(): void {
        if (this._initialized) return;
        const device = this._device;
        this._deviceLost = false;
        const generation = this._generation;
        void device.lost.then(() => {
            if (generation === this._generation) this._deviceLost = true;
        });
        this._constants = new ConstantsBuffer(device);
        if (this._gpuTiming) this._timer = new GpuTimer(device);
        this._linearSampler = device.createSampler({
            label: 'upscale-linear-clamp', magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
        });
        if (this._crossFrameReconstruct?.cameraCompensated) {
            this._reprojectBuffer = device.createBuffer({
                label: 'upscale-reproject', size: 32,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        this._jitter = new JitterSequence(this._ratio);
        this._initialized = true;
    }

    private _mandatoryPasses(): string[] {
        if (this._path === 'bilinear') return ['blit'];
        if (this._path === 'spatial') return ['easu', 'spatialRcas', 'blit'];
        const geometry = this._crossFrameReconstruct ? ['reconstruct'] : ['reconstruct', 'depthClip'];
        return this._path === 'guides' ? geometry :
            [...geometry, 'accumulate', 'exposure', 'generateReactive', 'rcas', 'blit'];
    }

    private _requestPass(name: string, retry: boolean): Promise<void> {
        if (this._passes.has(name)) return Promise.resolve();
        if (this._failures.has(name)) {
            if (!retry) return Promise.reject(this._failures.get(name));
            this._failures.delete(name);
            this._requests.delete(name);
        }
        const existing = this._requests.get(name);
        if (existing) return existing;
        const shaders: Record<string, [string, string]> = {
            blit: ['blit', BLIT_SHADER], easu: ['easu', EASU_SHADER],
            rcas: ['rcas', this._rcasShader],
            spatialRcas: ['rcas', this._spatialRcasShader ?? this._rcasShader],
            reconstruct: ['reconstruct', this._crossFrameReconstruct?.shader ?? RECONSTRUCT_SHADER],
            depthClip: ['depth-clip', this._depthClipShader ?? DEPTH_CLIP_SHADER],
            accumulate: ['accumulate', ACCUMULATE_SHADER],
            exposure: ['exposure', LUMINANCE_PYRAMID_SHADER],
            generateReactive: ['gen-reactive', GENERATE_REACTIVE_SHADER],
            shadingChange: ['shading-change', this._shadingChangeShader ?? SHADING_CHANGE_SHADER],
            debug: ['debug', DEBUG_SHADER],
        };
        const [label, code] = shaders[name];
        const generation = this._generation;
        const request = ComputePass.create(this._device, label, code).then(pass => {
            if (generation !== this._generation || this._deviceLost) {
                throw new Error('@pmndrs/upscaler: preparation cancelled by disposal or device loss.');
            }
            this._passes.set(name, pass);
            switch (name) {
                case 'blit': this._blitPass = pass; break;
                case 'easu': this._easuPass = pass; break;
                case 'rcas': this._rcasPass = pass; break;
                case 'spatialRcas': this._spatialRcasPass = pass; break;
                case 'reconstruct': this._reconstructPass = pass; break;
                case 'depthClip': this._depthClipPass = pass; break;
                case 'accumulate': this._accumulatePass = pass; break;
                case 'exposure': this._exposurePass = pass; break;
                case 'generateReactive': this._generateReactivePass = pass; break;
                case 'shadingChange': this._shadingChangePass = pass; break;
                case 'debug': this._debugPass = pass; break;
            }
        }).catch(error => {
            if (generation === this._generation && !this._failures.has(name)) {
                this._failures.set(name, error);
                console.error('@pmndrs/upscaler: failed to prepare ' + label, error);
            }
            throw error;
        });
        this._requests.set(name, request);
        return request;
    }

    private _queuePreparation(retry: boolean): Promise<void> {
        const names = this._mandatoryPasses();
        if (this._path === 'temporal') {
            if (this.settings.detectShadingChanges) names.push('shadingChange');
            if (this.settings.debugView !== DebugView.None) names.push('debug');
        }
        return Promise.all(names.filter(name => !this._passes.has(name)).map(name => this._requestPass(name, retry))).then(() => {});
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
            this._shadingMemoryStale = true;
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
        this._ensureResources();

        // A new pass graph: samples still in flight from the old one must not
        // land in gpuTimings after it.
        this._timer?.reset();
        this._path = config.path ?? 'temporal';
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
     * `(2x / renderWidth, −2y / renderHeight)`. It is the offset the input
     * must be rendered with and the value the shaders reconcile history
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
     * The upscaled result as the allocator's handle — sample it on a
     * fullscreen quad or feed it into later post-processing. Values remain in
     * the caller's linear/HDR domain; presentation is the caller's
     * responsibility. Re-read after `configure()`: it reallocates.
     */
    get output(): THandle {
        if (!this._output) {
            if (this._path === 'guides') {
                throw new Error(
                    "@pmndrs/upscaler: the 'guides' path produces no upscaled output — " +
                        'consume the guides bundle instead (upscaler.guides).',
                );
            }
            throw new Error('@pmndrs/upscaler: configure() must run before outputTexture is used.');
        }
        return this._output.handle;
    }

    /**
     * The published temporal-guides bundle (dilated motion/depth,
     * disocclusion, and the late data products) as allocator handles.
     * Available on the `temporal` and `guides` paths after `configure()`.
     * See {@link TemporalGuides} for each product's contract, and
     * docs/temporal-guides.md for the frame stages and consumer rules.
     */
    get guides(): TemporalGuides<THandle> {
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
     * allocates on the spot (or at `prepare()`), and timings start a frame or so
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
        this._jitter.reset();
    }

    //* Frame Lifecycle

    /**
     * Starts a frame: advances the jitter sequence. Offset this frame's
     * projection by the returned jitter (see {@link jitter} for the
     * convention), and keep motion vectors jitter-free. No-op on non-temporal
     * paths, or when jitter is disabled (see the `jitter` config flag — the
     * temporal path still reprojects and accumulates, it just doesn't add the
     * sub-pixel offset).
     * @returns This frame's jitter (the {@link jitter} object), or `null` when
     * there is nothing to apply
     */
    beginFrame(): JitterOffset | null {
        if (!this._jittering) return null;
        this._jitter.advance();
        return this.jitter;
    }

    /**
     * Encodes and submits the upscaling passes for this frame. Call after
     * the scene has been rendered into the input textures.
     * @param inputs - Scene color (+ depth/velocity for the temporal path) and frame info
     * @param camera - This frame's camera facts (near/far, projection type, depth convention)
     */
    dispatch(inputs: DispatchInputs, camera: FrameCamera): void {
        this._stageFrame(inputs, camera);
        const encoder = this._device.createCommandEncoder({ label: 'upscale' });
        this._timer?.beginFrame(this._frameIndex);
        this._encodeFrame(encoder, inputs);
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer?.readback();
        this._endFrame();
    }

    /**
     * {@link dispatch} into the caller's encoder, for hosts that batch their
     * own work into one submit. Never submits. Submit before the next
     * `encode*()`/`dispatch*()` call: the passes share one constants buffer,
     * written on the queue at encode time. Not GPU-timed.
     * @param encoder - The host's command encoder, outside any pass
     * @param inputs - As {@link dispatch}
     * @param camera - As {@link dispatch}
     */
    encode(encoder: GPUCommandEncoder, inputs: DispatchInputs, camera: FrameCamera): void {
        this._stageFrame(inputs, camera);
        this._encodeFrame(encoder, inputs);
        this._endFrame();
    }

    private _stageFrame(inputs: DispatchInputs, camera: FrameCamera): void {
        this._startDispatch();
        if (this._path === 'guides') {
            throw new Error(
                "@pmndrs/upscaler: the 'guides' path has no upscale — drive it with dispatchGuides().",
            );
        }
        if (this._guidesPending) {
            throw new Error(
                '@pmndrs/upscaler: a split frame is in flight — finish it with dispatchUpscale() ' +
                    'instead of dispatch().',
            );
        }
        if (!this._output || !this._outputGPU) {
            throw new Error('@pmndrs/upscaler: configure() must run before dispatch().');
        }

        this._writeConstants(inputs, camera);
        this._constants.upload();
    }

    private _encodeFrame(encoder: GPUCommandEncoder, inputs: DispatchInputs): void {
        const colorGPU = inputs.color;
        this._checkMsaa(colorGPU, 'color');
        switch (this._path) {
            case 'bilinear':
                this._encodeBlit(
                    encoder,
                    colorGPU.createView(),
                    this._exposure![0].createView(),
                    colorGPU.createView(),
                );
                break;
            case 'spatial':
                this._encodeSpatial(encoder, colorGPU);
                break;
            case 'temporal':
                this._encodeTemporal(encoder, colorGPU, inputs);
                break;
        }
    }

    private _endFrame(): void {
        this._frameIndex++;
        this._pendingReset = false;
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
     * @param camera - This frame's camera facts
     */
    dispatchGuides(inputs: GuideDispatchInputs, camera: FrameCamera): void {
        this._stageGuides(inputs, camera);
        const encoder = this._device.createCommandEncoder({ label: 'upscale-guides' });
        this._timer?.beginFrame(this._frameIndex);
        this._encodeGuides(encoder, inputs);
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        // On the temporal path dispatchUpscale's submit finishes this frame.
        this._timer?.readback(this._path === 'guides');
        this._endGuides();
    }

    /**
     * {@link dispatchGuides} into the caller's encoder. Never submits; submit
     * it before {@link encodeUpscale} (the stages share one constants buffer).
     * Not GPU-timed.
     * @param encoder - The host's command encoder, outside any pass
     * @param inputs - As {@link dispatchGuides}
     * @param camera - As {@link dispatchGuides}
     */
    encodeGuides(encoder: GPUCommandEncoder, inputs: GuideDispatchInputs, camera: FrameCamera): void {
        this._stageGuides(inputs, camera);
        this._encodeGuides(encoder, inputs);
        this._endGuides();
    }

    private _stageGuides(inputs: GuideDispatchInputs, camera: FrameCamera): void {
        this._startDispatch();
        if (this._path !== 'temporal' && this._path !== 'guides') {
            throw new Error(
                `@pmndrs/upscaler: dispatchGuides() requires the temporal or guides path (got '${this._path}').`,
            );
        }
        if (!this._dilatedMotion) {
            throw new Error('@pmndrs/upscaler: configure() must run before dispatchGuides().');
        }
        if (this._guidesPending) {
            throw new Error(
                '@pmndrs/upscaler: dispatchGuides() already ran this frame — finish with dispatchUpscale().',
            );
        }
        this._writeConstants(inputs, camera);
        this._constants.upload();
    }

    private _endGuides(): void {
        if (this._path === 'guides') {
            // The frame ends here — there is no late stage.
            this._frameIndex++;
            this._pendingReset = false;
            this._depthIndex = 1 - this._depthIndex;
        } else {
            this._guidesPending = true;
        }
    }

    /**
     * Finishes a split frame: encodes and submits everything after the
     * geometry stage (reactive, exposure, shading change, accumulate, and
     * the RCAS/output pass). Requires {@link dispatchGuides} earlier in the
     * same frame; equivalent to {@link dispatch} apart from the split.
     * @param inputs - Scene color (+ optional reactive/exposure inputs)
     * @param camera - The camera facts passed to {@link dispatchGuides}
     */
    dispatchUpscale(inputs: DispatchInputs, camera: FrameCamera): void {
        this._stageUpscale(inputs, camera);
        const encoder = this._device.createCommandEncoder({ label: 'upscale-late' });
        this._timer?.beginFrame(this._frameIndex);
        this._checkMsaa(inputs.color, 'color');
        this._encodeLate(encoder, inputs.color, inputs);
        this._timer?.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer?.readback();
        this._endUpscale();
    }

    /**
     * {@link dispatchUpscale} into the caller's encoder. Never submits.
     * Not GPU-timed.
     * @param encoder - The host's command encoder, outside any pass
     * @param inputs - As {@link dispatchUpscale}
     * @param camera - As {@link dispatchUpscale}
     */
    encodeUpscale(encoder: GPUCommandEncoder, inputs: DispatchInputs, camera: FrameCamera): void {
        this._stageUpscale(inputs, camera);
        this._checkMsaa(inputs.color, 'color');
        this._encodeLate(encoder, inputs.color, inputs);
        this._endUpscale();
    }

    private _stageUpscale(inputs: DispatchInputs, camera: FrameCamera): void {
        if (!this.isReady) throw new Error("@pmndrs/upscaler: await init() (or prepare()) before dispatchUpscale().");
        if (this._path !== 'temporal') {
            throw new Error(
                `@pmndrs/upscaler: dispatchUpscale() requires the temporal path (got '${this._path}').`,
            );
        }
        if (!this._guidesPending) {
            throw new Error(
                '@pmndrs/upscaler: call dispatchGuides() first (or use the all-in-one dispatch()).',
            );
        }
        if (!this._output || !this._outputGPU) {
            throw new Error('@pmndrs/upscaler: configure() must run before dispatchUpscale().');
        }

        // Rewritten (not reused) so color-dependent flags — reactive, external
        // exposure — reflect this call's inputs. Jitter and reset state are
        // unchanged since the guides stage, so the shared UBO stays coherent.
        this._writeConstants(inputs, camera);
        this._constants.upload();
    }

    private _endUpscale(): void {
        this._guidesPending = false;
        this._frameIndex++;
        this._pendingReset = false;
        this._historyIndex = 1 - this._historyIndex;
        this._depthIndex = 1 - this._depthIndex;
    }

    /** Releases every GPU resource the core allocated (never the device). */
    dispose(): void {
        this._generation++;
        this._passes.clear();
        this._requests.clear();
        this._failures.clear();
        this._shadingActive = false;
        this._debugActive = false;
        this._destroyTextures();
        this._constants?.dispose();
        this._reprojectBuffer?.destroy();
        this._timer?.dispose();
        this._timer = null;
        this._initialized = false;
    }

    //* Pass Encoding

    // `alpha` names the texture whose .a carries the caller's alpha. It is the
    // color input itself everywhere except the temporal path, where the input's
    // .a is the accumulation age and the resolved alpha lives in the locks
    // buffer (see accumulate.ts).
    private _encodeBlit(
        encoder: GPUCommandEncoder,
        input: GPUTextureView,
        exposure: GPUTextureView,
        alpha: GPUTextureView,
    ): void {
        const bindGroup = this._blitPass.createBindGroup([
            { buffer: this._constants.buffer },
            input,
            this._linearSampler,
            exposure,
            this._outputView(),
            alpha,
        ]);
        const pass = encoder.beginComputePass({
            label: 'upscale-blit',
            timestampWrites: this._timer?.passDescriptor('blit'),
        });
        this._blitPass.dispatch(pass, bindGroup, this._displayWidth, this._displayHeight);
        pass.end();
    }

    private _encodeSpatial(encoder: GPUCommandEncoder, colorGPU: GPUTexture): void {
        //* EASU — edge-adaptive upscale into the display-res intermediate
        const easuBindGroup = this._easuPass.createBindGroup([
            { buffer: this._constants.buffer },
            colorGPU.createView(),
            this._easuOutput!.createView(),
        ]);
        const easuPass = encoder.beginComputePass({
            label: 'upscale-easu',
            timestampWrites: this._timer?.passDescriptor('easu'),
        });
        this._easuPass.dispatch(easuPass, easuBindGroup, this._displayWidth, this._displayHeight);
        easuPass.end();

        //* RCAS — sharpen in the caller's color domain
        const exposureView = this._exposure![0].createView();
        if (this._effectiveSettings.sharpness > 0) {
            this._encodeRcas(
                encoder,
                this._easuOutput!.createView(),
                exposureView,
                this._easuOutput!.createView(),
            );
        } else {
            this._encodeBlit(
                encoder,
                this._easuOutput!.createView(),
                exposureView,
                this._easuOutput!.createView(),
            );
        }
    }

    private _encodeTemporal(
        encoder: GPUCommandEncoder,
        colorGPU: GPUTexture,
        inputs: DispatchInputs,
    ): void {
        if (!inputs.depth || !inputs.velocity) {
            throw new Error('@pmndrs/upscaler: the temporal path requires depth and velocity inputs.');
        }
        // The frame's two stages (docs/temporal-guides.md): geometry guides
        // need only depth + velocity; everything after needs the beauty color.
        // Composed on one encoder here so the monolithic dispatch keeps its
        // single submit — the seam exists for the split-dispatch guides API.
        this._encodeGuides(encoder, { depth: inputs.depth, velocity: inputs.velocity });
        this._encodeLate(encoder, colorGPU, inputs);
    }

    // Early stage — reconstruct (dilate + previous-depth scatter) then depth
    // clip. Produces the signal-agnostic geometry guides: dilated depth/motion,
    // disocclusion.
    private _encodeGuides(encoder: GPUCommandEncoder, inputs: GuideDispatchInputs): void {
        const depthGPU = inputs.depth;
        const velocityGPU = inputs.velocity;
        this._checkMsaa(depthGPU, 'depth');
        this._checkMsaa(velocityGPU, 'velocity');
        // Stencil-less depth formats bind directly; combined formats need a
        // depth-only view for texture_depth_2d.
        const depthView = depthGPU.createView(
            depthGPU.format.includes('stencil') ? { aspect: 'depth-only' } : undefined,
        );
        const depthCur = this._dilatedDepth![this._depthIndex];
        const depthPrev = this._dilatedDepth![1 - this._depthIndex];
        this._latestDepthWrite = this._depthIndex;
        const w = this._renderWidth;
        const h = this._renderHeight;

        if (this._crossFrameReconstruct) {
            this._encodeCrossFrameReconstruct(encoder, depthView, velocityGPU, depthPrev, depthCur);
            return;
        }

        // The guides stage is encoded exactly once per frame (monolithic or
        // split), so the scatter buffers flip here: this frame scatters into
        // the one last frame's depth clip emptied.
        this._scatterIndex = 1 - this._scatterIndex;
        const scatterBuffer = this._reconstructedDepth![this._scatterIndex];
        const nextScatterBuffer = this._reconstructedDepth![1 - this._scatterIndex];

        //* Reconstruct — dilate (nearest-depth motion/depth over 3×3) and
        //* scatter this frame's depth to each pixel's previous position.
        const reconstructBindGroup = this._reconstructPass.createBindGroup([
            { buffer: this._constants.buffer },
            depthView,
            velocityGPU.createView(),
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            { buffer: scatterBuffer },
        ]);
        const reconstructPass = encoder.beginComputePass({
            label: 'upscale-reconstruct',
            timestampWrites: this._timer?.passDescriptor('reconstruct'),
        });
        this._reconstructPass.dispatch(reconstructPass, reconstructBindGroup, w, h);
        reconstructPass.end();

        //* Depth Clip — disocclusion against the reconstructed previous depth.
        // A separate pass: every pixel's scatter must land before any reads.
        const depthClipBindGroup = this._depthClipPass.createBindGroup([
            { buffer: this._constants.buffer },
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            { buffer: scatterBuffer },
            this._masks!.createView(),
            { buffer: nextScatterBuffer },
        ]);
        const depthClipPass = encoder.beginComputePass({
            label: 'upscale-depth-clip',
            timestampWrites: this._timer?.passDescriptor('depthClip'),
        });
        this._depthClipPass.dispatch(depthClipPass, depthClipBindGroup, w, h);
        depthClipPass.end();
    }

    // Bench-only single-pass reconstruct identities (`cross-frame`, `camera`):
    // dilate + depth clip fused, against last frame's dilated depth.
    private _encodeCrossFrameReconstruct(
        encoder: GPUCommandEncoder,
        depthView: GPUTextureView,
        velocityGPU: GPUTexture,
        depthPrev: GPUTexture,
        depthCur: GPUTexture,
    ): void {
        const entries: GPUBindingResource[] = [
            { buffer: this._constants.buffer },
            depthView,
            velocityGPU.createView(),
            depthPrev.createView(),
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            this._masks!.createView(),
        ];
        if (this._reprojectBuffer) {
            this._writeReproject();
            entries.push({ buffer: this._reprojectBuffer! });
        }
        const bindGroup = this._reconstructPass.createBindGroup(entries);
        const pass = encoder.beginComputePass({
            label: 'upscale-reconstruct',
            timestampWrites: this._timer?.passDescriptor('reconstruct'),
        });
        this._reconstructPass.dispatch(pass, bindGroup, this._renderWidth, this._renderHeight);
        pass.end();
    }

    // Stages the `camera` variant's side uniform (computed by the adapter,
    // which owns the camera matrices). Runs once per frame: the guides stage
    // is encoded exactly once.
    private _writeReproject(): void {
        this._device.queue.writeBuffer(this._reprojectBuffer!, 0, this._reprojectData!());
    }

    // Late stage — everything that needs the final beauty color: reactive,
    // exposure, shading change, accumulate, and the output pass.
    private _encodeLate(
        encoder: GPUCommandEncoder,
        colorGPU: GPUTexture,
        inputs: DispatchInputs,
    ): void {
        const depthCur = this._dilatedDepth![this._depthIndex];
        const historyIn = this._history![this._historyIndex];
        this._latestHistoryWrite = 1 - this._historyIndex;
        const historyOut = this._history![1 - this._historyIndex];
        const locksIn = this._locks![this._historyIndex];
        const locksOut = this._locks![1 - this._historyIndex];
        const exposurePrev = this._exposure![this._historyIndex];
        const exposureCur = this._exposure![1 - this._historyIndex];
        //* Reactive mask — merge-not-overwrite (docs/temporal-guides.md).
        //* With an opaque-only color, the generator runs and max-merges any
        //* incoming mask (explicit, or effect-written into guides.reactive
        //* and passed back as `reactive`); an explicit mask alone binds
        //* directly; else the zero dummy.
        let reactiveView: GPUTextureView;
        if (inputs.reactiveOpaqueColor) {
            let incomingView = this._reactiveDummy!.createView();
            if (inputs.reactive) {
                const incoming = inputs.reactive;
                if (incoming === this._reactiveGenerated) {
                    throw new Error(
                        '@pmndrs/upscaler: `reactive` must not be the generated mask itself ' +
                            '(guides.reactive) while `reactiveOpaqueColor` is set — the generator ' +
                            'writes that texture. Pass one of the two, not both.',
                    );
                }
                incomingView = incoming.createView();
            }
            const opaqueGPU = inputs.reactiveOpaqueColor;
            const genBindGroup = this._generateReactivePass.createBindGroup([
                { buffer: this._constants.buffer },
                opaqueGPU.createView(),
                colorGPU.createView(),
                this._reactiveGenerated!.createView(),
                incomingView,
            ]);
            const genPass = encoder.beginComputePass({
                label: 'upscale-gen-reactive',
                timestampWrites: this._timer?.passDescriptor('genReactive'),
            });
            this._generateReactivePass.dispatch(
                genPass,
                genBindGroup,
                this._renderWidth,
                this._renderHeight,
            );
            genPass.end();
            reactiveView = this._reactiveGenerated!.createView();
        } else if (inputs.reactive) {
            reactiveView = inputs.reactive.createView();
        } else {
            reactiveView = this._reactiveDummy!.createView();
        }

        //* Exposure — reduce scene luminance to a pre-exposure (auto-exposure).
        // Runs first; every later pass reads this frame's value from exposureCur.
        // App-supplied exposure when given, else the 1×1 dummy (ignored unless
        // FLAG_EXTERNAL_EXPOSURE is set — reuse the reactive dummy as a valid
        // texture_2d<f32> placeholder rather than allocate a second one).
        const externalExposureView = inputs.exposureTexture
            ? inputs.exposureTexture.createView()
            : this._reactiveDummy!.createView();
        // Host pre-exposure input — the zero dummy publishes as 1.0 (inert).
        const hostPreExposureView = inputs.preExposureTexture
            ? inputs.preExposureTexture.createView()
            : this._reactiveDummy!.createView();
        const exposureBindGroup = this._exposurePass.createBindGroup([
            { buffer: this._constants.buffer },
            colorGPU.createView(),
            this._linearSampler,
            exposurePrev.createView(),
            exposureCur.createView(),
            externalExposureView,
            hostPreExposureView,
        ]);
        const exposurePass = encoder.beginComputePass({
            label: 'upscale-exposure',
            timestampWrites: this._timer?.passDescriptor('exposure'),
        });
        // One workgroup performs the whole reduction (see luminancePyramid.ts).
        this._exposurePass.dispatch(exposurePass, exposureBindGroup, 8, 8);
        exposurePass.end();

        //* Shading Change — fused multi-scale block-mean detector (skipped
        //* entirely when the detector is off; accumulate then reads a zero dummy).
        let shadingSignalView = this._reactiveDummy!.createView();
        if (!this._effectiveSettings.detectShadingChanges) this._shadingMemoryStale = true;
        else {
            const shadingMemoryIn = this._shadingBlockMemory![this._historyIndex];
            if (this._shadingMemoryStale) {
                this._shadingMemoryStale = false;
                this._device.queue.writeTexture(
                    { texture: shadingMemoryIn },
                    new Uint8Array(shadingMemoryIn.width * shadingMemoryIn.height * 16),
                    { bytesPerRow: shadingMemoryIn.width * 16 },
                    { width: shadingMemoryIn.width, height: shadingMemoryIn.height },
                );
            }
            const shadingLumaIn = this._shadingLumaHistory![this._historyIndex];
            const shadingLumaOut = this._shadingLumaHistory![1 - this._historyIndex];
            const shadingBindGroup = this._shadingChangePass.createBindGroup([
                { buffer: this._constants.buffer },
                colorGPU.createView(),
                shadingLumaIn.createView(),
                this._dilatedMotion!.createView(),
                exposureCur.createView(),
                exposurePrev.createView(),
                shadingLumaOut.createView(),
                this._shadingSignal!.createView(),
                this._masks!.createView(),
                shadingMemoryIn.createView(),
                this._shadingBlockMemory![1 - this._historyIndex].createView(),
            ]);
            const shadingPass = encoder.beginComputePass({
                label: 'upscale-shading-change',
                timestampWrites: this._timer?.passDescriptor('shadingChange'),
            });
            // Half-resolution grid: one thread per 2×2 render block (the pass
            // covers a 16×16 render tile per workgroup — see shadingChange.ts).
            this._shadingChangePass.dispatch(
                shadingPass,
                shadingBindGroup,
                Math.max(1, Math.ceil(this._renderWidth / 2)),
                Math.max(1, Math.ceil(this._renderHeight / 2)),
            );
            shadingPass.end();
            shadingSignalView = this._shadingSignal!.createView();
        }

        //* Accumulate — jittered upsample + history reprojection/rectification
        const accumulateBindGroup = this._accumulatePass.createBindGroup([
            { buffer: this._constants.buffer },
            colorGPU.createView(),
            this._dilatedMotion!.createView(),
            this._masks!.createView(),
            historyIn.createView(),
            this._linearSampler,
            historyOut.createView(),
            locksIn.createView(),
            locksOut.createView(),
            exposureCur.createView(),
            reactiveView,
            exposurePrev.createView(),
            shadingSignalView,
        ]);
        const accumulatePass = encoder.beginComputePass({
            label: 'upscale-accumulate',
            timestampWrites: this._timer?.passDescriptor('accumulate'),
        });
        this._accumulatePass.dispatch(
            accumulatePass,
            accumulateBindGroup,
            this._displayWidth,
            this._displayHeight,
        );
        accumulatePass.end();

        //* Output — debug view, RCAS sharpen, or plain resolve
        if (this._effectiveSettings.debugView !== DebugView.None) {
            const debugBindGroup = this._debugPass.createBindGroup([
                { buffer: this._constants.buffer },
                this._dilatedMotion!.createView(),
                this._masks!.createView(),
                depthCur.createView(),
                historyOut.createView(),
                locksOut.createView(),
                exposureCur.createView(),
                colorGPU.createView(),
                reactiveView,
                this._outputView(),
            ]);
            const debugPass = encoder.beginComputePass({
                label: 'upscale-debug',
                timestampWrites: this._timer?.passDescriptor('output'),
            });
            this._debugPass.dispatch(
                debugPass,
                debugBindGroup,
                this._displayWidth,
                this._displayHeight,
            );
            debugPass.end();
        } else if (this._effectiveSettings.sharpness > 0) {
            this._encodeRcas(
                encoder,
                historyOut.createView(),
                exposureCur.createView(),
                locksOut.createView(),
            );
        } else {
            this._encodeBlit(
                encoder,
                historyOut.createView(),
                exposureCur.createView(),
                locksOut.createView(),
            );
        }
    }

    // See _encodeBlit for what `alpha` is bound to on each path.
    private _encodeRcas(
        encoder: GPUCommandEncoder,
        input: GPUTextureView,
        exposure: GPUTextureView,
        alpha: GPUTextureView,
    ): void {
        const rcasPass = this._path === 'spatial' ? this._spatialRcasPass : this._rcasPass;
        const bindGroup = rcasPass.createBindGroup([
            { buffer: this._constants.buffer },
            input,
            exposure,
            this._outputView(),
            alpha,
        ]);
        const pass = encoder.beginComputePass({
            label: 'upscale-rcas',
            timestampWrites: this._timer?.passDescriptor('rcas'),
        });
        rcasPass.dispatch(pass, bindGroup, this._displayWidth, this._displayHeight);
        pass.end();
    }

    // FSR is itself the anti-aliaser (the temporal path is a TAA-class
    // resolver — that's what Native AA mode is), so it wants an aliased,
    // single-sample, jittered render. A multisampled input can't even bind to
    // the compute passes as a texture_2d, and would waste the MSAA cost. Warn
    // once (cheap: one property read) rather than let bind-group creation fail
    // with an opaque validation error.
    private _checkMsaa(tex: GPUTexture, label: string): void {
        if (this._warnedMsaa || tex.sampleCount <= 1) return;
        this._warnedMsaa = true;
        console.warn(
            `@pmndrs/upscaler: the ${label} input is multisampled (sampleCount=${tex.sampleCount}). ` +
                `FSR does its own anti-aliasing — feed it an aliased, single-sample, jittered ` +
                `render with MSAA disabled. Multisampled inputs are not supported.`,
        );
    }

    // Storage bindings must view exactly one mip level — pin it explicitly
    // rather than trusting the texture to be single-mip.
    private _outputView(): GPUTextureView {
        return this._outputGPU!.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    }

    //* Constants Staging

    private _baseFlags(camera: FrameCamera): number {
        let flags = 0;
        if (this._pendingReset) flags |= FLAG_RESET;
        if (camera.reversedDepth) flags |= FLAG_REVERSED_DEPTH;
        return flags;
    }

    // Accepts either dispatch shape — the guides stage has no color, and every
    // field this reads is shared between the two input types.
    private _writeConstants(
        inputs: Omit<DispatchInputs, 'color'>,
        camera: FrameCamera,
    ): void {
        const c = this._constants;
        c.setRenderSize(this._renderWidth, this._renderHeight);
        c.setDisplaySize(this._displayWidth, this._displayHeight);

        // The public getters are the single source, so what an app reads and
        // what the shaders reconcile against cannot disagree.
        const jitter = this.jitter;
        const previous = this.jitterPrevious;
        c.setJitter(jitter.x, jitter.y, previous.x, previous.y);

        // NDC delta -> UV delta: u = 0.5 + ndc.x/2, v = 0.5 - ndc.y/2.
        c.setMotionScale(this._motionScale[0], this._motionScale[1]);
        c.setDepthNearFar(camera.near, camera.far);
        c.setSharpness(Math.min(1, Math.max(0, this._effectiveSettings.sharpness)));
        c.setMaxAccumulation(Math.max(1, this._effectiveSettings.maxAccumulation));
        c.setExposure(this._effectiveSettings.exposure);
        c.setDeltaTime(inputs.deltaTime ?? 1 / 60);
        c.setFrameIndex(this._frameIndex);
        c.setDebugMode(this._effectiveSettings.debugView);

        // The input-space flag only matters to the final output pass (blit
        // or RCAS) — earlier passes ignore it, so it is staged once here.
        let flags = this._baseFlags(camera);
        if (inputs.reset) {
            this._pendingReset = true;
            flags |= FLAG_RESET;
        }
        if (camera.perspective) flags |= FLAG_PERSPECTIVE;
        if (this._path === 'temporal') flags |= FLAG_INPUT_REINHARD;
        if (this._effectiveSettings.lockThinFeatures) flags |= FLAG_LOCKS;
        if (this._effectiveSettings.autoExposure) flags |= FLAG_AUTO_EXPOSURE;
        if (this._effectiveSettings.detectShadingChanges) flags |= FLAG_SHADING_CHANGE;
        if (inputs.reactive || inputs.reactiveOpaqueColor) flags |= FLAG_REACTIVE;
        if (inputs.exposureTexture) flags |= FLAG_EXTERNAL_EXPOSURE;
        if (this._effectiveSettings.rcasDenoise) flags |= FLAG_RCAS_DENOISE;
        c.setFlags(flags);
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

    // Allocates a published texture through the engine's allocator: the
    // handle is what consumers sample, the raw GPUTexture is what our passes
    // bind — one allocation.
    private _createSharedTexture(
        label: string,
        w: number,
        h: number,
        format: CoreTextureFormat,
    ): CoreTexture<THandle> {
        return this._allocate({ label: `upscale-${label}`, width: w, height: h, format });
    }

    private _allocateTextures(): void {
        this._destroyTextures();
        const rw = this._renderWidth;
        const rh = this._renderHeight;
        const dw = this._displayWidth;
        const dh = this._displayHeight;
        const guidesOnly = this._path === 'guides';

        if (!guidesOnly) {
            // Allocated like the guides so the caller samples it as an
            // ordinary engine texture.
            this._output = this._createSharedTexture('output', dw, dh, 'rgba16float');
            this._outputGPU = this._output.gpu;

            // Exposure is a 1×1 value read by every output path (blit/rcas), so
            // it is allocated for all upscaling paths even though only the
            // temporal path computes it — the others bind [0] unused.
            const exposure0 = this._createSharedTexture('exposure-0', 1, 1, 'rgba16float');
            const exposure1 = this._createSharedTexture('exposure-1', 1, 1, 'rgba16float');
            this._guideTex.exposure = [exposure0, exposure1];
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
            this._guideTex.dilatedDepth = [depth0, depth1];
            this._dilatedDepth = [depth0.gpu, depth1.gpu];
            const motion = this._createSharedTexture('dilated-motion', rw, rh, 'rgba16float');
            this._guideTex.dilatedMotion = motion;
            this._dilatedMotion = motion.gpu;
            const masks = this._createSharedTexture(
                'masks',
                rw,
                rh,
                'rgba8unorm',
            );
            this._guideTex.masks = masks;
            this._masks = masks.gpu;
            // Both start empty (+inf bits); afterwards each frame's depth
            // clip empties the buffer the next frame scatters into.
            if (!this._crossFrameReconstruct) {
                const createEmpty = (index: number): GPUBuffer => {
                    const buffer = this._device.createBuffer({
                        label: `upscale-reconstructed-depth-${index}`,
                        size: rw * rh * 4,
                        usage: GPUBufferUsage.STORAGE,
                        mappedAtCreation: true,
                    });
                    new Uint32Array(buffer.getMappedRange()).fill(0x7f800000);
                    buffer.unmap();
                    return buffer;
                };
                this._reconstructedDepth = [createEmpty(0), createEmpty(1)];
            }
            this._latestDepthWrite = this._depthIndex;
        }

        if (this._path === 'temporal') {
            const history0 = this._createSharedTexture('history-0', dw, dh, 'rgba16float');
            const history1 = this._createSharedTexture('history-1', dw, dh, 'rgba16float');
            this._guideTex.history = [history0, history1];
            this._history = [history0.gpu, history1.gpu];
            const locks0 = this._createSharedTexture('locks-0', dw, dh, 'rgba16float');
            const locks1 = this._createSharedTexture('locks-1', dw, dh, 'rgba16float');
            this._guideTex.locks = [locks0, locks1];
            this._locks = [locks0.gpu, locks1.gpu];
            const reactiveGen = this._createSharedTexture('reactive-gen', rw, rh, 'rgba8unorm');
            this._guideTex.reactiveGenerated = reactiveGen;
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
            this._guideTex.shadingSignal = shadingSignal;
            this._shadingSignal = shadingSignal.gpu;
            // Block memory: the 4×4 blocks' rows, then the 8×8 blocks' rows;
            // 8 f16 means per rgba32uint texel. Allocated zeroed, which the
            // shader treats as empty (configure() also resets history, which
            // restarts every block on the first frame anyway).
            const memoryWidth = Math.max(1, Math.ceil(rw / 4));
            const memoryHeight = Math.max(1, Math.ceil(rh / 4) + Math.ceil(rh / 8));
            this._shadingBlockMemory = [
                // COPY_DST: zeroed by queue.writeTexture when it goes stale.
                this._createTexture('shading-memory-0', memoryWidth, memoryHeight, 'rgba32uint', GPUTextureUsage.COPY_DST),
                this._createTexture('shading-memory-1', memoryWidth, memoryHeight, 'rgba32uint', GPUTextureUsage.COPY_DST),
            ];
            this._shadingMemoryStale = false;

        }

        this._guides =
            this._path === 'temporal' || guidesOnly ? this._buildGuides() : null;
    }

    // The bundle resolves through getters so ping-ponged products always point
    // at the most recently written half — consumers re-read per frame.
    private _buildGuides(): TemporalGuides<THandle> {
        // Object-literal getters rebind `this` to the bundle — the alias is the
        // idiomatic way to reach the upscaler's live state from them.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const upscaler = this;
        return {
            get dilatedMotion() {
                return upscaler._guideTex.dilatedMotion!.handle;
            },
            get dilatedDepth() {
                return upscaler._guideTex.dilatedDepth![upscaler._latestDepthWrite].handle;
            },
            get previousDepth() {
                return upscaler._guideTex.dilatedDepth![1 - upscaler._latestDepthWrite].handle;
            },
            get disocclusion() {
                return upscaler._guideTex.masks!.handle;
            },
            get reactive() {
                return upscaler._guideTex.reactiveGenerated?.handle ?? null;
            },
            get shadingChange() {
                return upscaler._guideTex.shadingSignal?.handle ?? null;
            },
            get exposure() {
                return upscaler._guideTex.exposure?.[upscaler._latestHistoryWrite].handle ?? null;
            },
            get lockStatus() {
                return upscaler._guideTex.locks?.[upscaler._latestHistoryWrite].handle ?? null;
            },
            get history() {
                return upscaler._guideTex.history?.[upscaler._latestHistoryWrite].handle ?? null;
            },
        };
    }

    private _destroyTextures(): void {
        this._output?.destroy();
        this._output = null;
        this._outputGPU = null;
        this._easuOutput?.destroy();
        this._easuOutput = null;
        // Published (allocator-owned) textures: their destroy() releases the
        // backing GPUTexture — never also .destroy() the raw handles.
        const guideTex = this._guideTex;
        guideTex.dilatedMotion?.destroy();
        guideTex.masks?.destroy();
        guideTex.reactiveGenerated?.destroy();
        guideTex.shadingSignal?.destroy();
        guideTex.dilatedDepth?.forEach((t) => t.destroy());
        guideTex.exposure?.forEach((t) => t.destroy());
        guideTex.locks?.forEach((t) => t.destroy());
        guideTex.history?.forEach((t) => t.destroy());
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
        this._reconstructedDepth?.forEach((buffer) => buffer.destroy());
        this._reconstructedDepth = null;
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
