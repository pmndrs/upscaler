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

import { ComputePass } from './internal/ComputePass';
import { ConstantsBuffer } from './internal/ConstantsBuffer';
import { GpuTimer } from './internal/GpuTimer';
import { getDevice, getGPUTexture } from './internal/threeWebGPU';
import { JitterSequence } from './math/jitter';
import { applyJitterViewOffset, restoreViewOffset, type ViewOffsetSnapshot } from './math/viewOffset';
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
import {
    GI_FUSION_FLAG_OCCLUSION,
    GI_FUSION_FLAG_RESET,
    GI_FUSION_FLAG_BLOCK_ANTILAG,
    GI_FUSION_FLAG_STDERR_BOX,
    GI_FUSION_FLAG_SURFACE,
    GI_FUSION_FLAG_TONEMAP,
    GI_FUSION_PARAMS_SIZE,
    GI_FUSION_SHADER,
} from './shaders/giFusion';
import { LUMINANCE_PYRAMID_SHADER } from './shaders/luminancePyramid';
import { RCAS_SHADER } from './shaders/rcas';
import { RECONSTRUCT_SHADER } from './shaders/reconstruct';
import { SHADING_CHANGE_SHADER } from './shaders/shadingChange';
import {
    DebugView,
    QualityMode,
    type UpscalerConfig,
    type DispatchInputs,
    type GiFusionInputs,
    type GuideDispatchInputs,
    type RuntimeSettings,
    type TemporalGuides,
    type UpscalePath,
} from './types';

type JitterableCamera = PerspectiveCamera | OrthographicCamera;
type UpscalerInternalOptions = {
    renderer: WebGPURenderer;
    _rcasShader?: string;
    // Bench-only: an RCAS for the spatial path that differs from `_rcasShader`
    // (a frozen temporal identity that still runs FSR1 on production RCAS).
    _spatialRcasShader?: string;
};

/**
 * FSR3-style upscaler for three's `WebGPURenderer`, implemented as raw WGSL
 * compute passes on the renderer's GPU device.
 *
 * Pipelines:
 * - `bilinear` — blit (comparison baseline / native passthrough)
 * - `spatial`  — EASU → RCAS (FSR1)
 * - `temporal` — reconstruct (fused dilate + depth clip) → exposure →
 *   shading change → accumulate → RCAS (FSR2/3-style)
 * - `guides`   — reconstruct only (see {@link dispatchGuides})
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
    private readonly _rcasShader: string;
    private readonly _spatialRcasShader: string | null;
    private _device!: GPUDevice;
    private _constants!: ConstantsBuffer;
    private _timer!: GpuTimer;
    private _linearSampler!: GPUSampler;

    private _blitPass!: ComputePass;
    private _easuPass!: ComputePass;
    private _rcasPass!: ComputePass;
    private _spatialRcasPass!: ComputePass;
    private _reconstructPass!: ComputePass;
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

    // GPU-side working set (owned raw textures + the three-visible output)
    private _output: StorageTexture | null = null;
    private _outputGPU: GPUTexture | null = null;
    private _history: [GPUTexture, GPUTexture] | null = null;
    // Luminance-stability lock state (r = lock lifetime, g = locked luma),
    // ping-ponged in lockstep with history.
    private _locks: [GPUTexture, GPUTexture] | null = null;
    private _dilatedDepth: [GPUTexture, GPUTexture] | null = null;
    private _dilatedMotion: GPUTexture | null = null;
    private _masks: GPUTexture | null = null;
    private _easuOutput: GPUTexture | null = null;
    // Auto-exposure state: 1×1 exposure value (r = exposure, g = avg luma),
    // ping-ponged so eye-adaptation can ease from last frame's value.
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

    //* Experimental GI History Fusion (issue #7, docs/research/GI-HISTORY-FUSION.md)
    // Everything here is created on the first dispatch that passes
    // `giFusion` — with the option absent nothing is compiled, allocated or
    // dispatched, so production output is untouched by construction.
    private _giFusionPass: ComputePass | null = null;
    private _giFusionParams: GPUBuffer | null = null;
    private readonly _giFusionParamData = new ArrayBuffer(GI_FUSION_PARAMS_SIZE);
    private _giHistory: [GPUTexture, GPUTexture] | null = null;
    private _giMoments: [GPUTexture, GPUTexture] | null = null;
    private _giSurface: [GPUTexture, GPUTexture] | null = null;
    private _giComposite: GPUTexture | null = null;
    // Whether last frame ran the fusion pass — its history is stale otherwise.
    private _giFusedLastFrame = false;

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

    constructor(options: { renderer: WebGPURenderer });
    constructor(options: UpscalerInternalOptions) {
        this._renderer = options.renderer;
        // Any override must declare RCAS's alpha-source binding (4) — every
        // shader in rcas.ts does — because _encodeRcas always binds it.
        this._rcasShader = options._rcasShader ?? RCAS_SHADER;
        this._spatialRcasShader = options._spatialRcasShader ?? null;
    }

    /**
     * Compiles all compute pipelines. Call once after `renderer.init()`.
     */
    init(): void {
        if (this._initialized) return;
        const device = getDevice(this._renderer);
        this._device = device;
        this._constants = new ConstantsBuffer(device);
        this._timer = new GpuTimer(device);
        this._linearSampler = device.createSampler({
            label: 'upscale-linear-clamp',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this._blitPass = new ComputePass(device, 'blit', BLIT_SHADER);
        this._easuPass = new ComputePass(device, 'easu', EASU_SHADER);
        this._rcasPass = new ComputePass(device, 'rcas', this._rcasShader);
        this._spatialRcasPass =
            this._spatialRcasShader === null
                ? this._rcasPass
                : new ComputePass(device, 'rcas', this._spatialRcasShader);
        this._reconstructPass = new ComputePass(device, 'reconstruct', RECONSTRUCT_SHADER);
        this._accumulatePass = new ComputePass(device, 'accumulate', ACCUMULATE_SHADER, {
            shaderKey: 'baseline:accumulate',
            assembledChunks: [],
        });
        this._exposurePass = new ComputePass(device, 'exposure', LUMINANCE_PYRAMID_SHADER);
        this._shadingChangePass = new ComputePass(device, 'shading-change', SHADING_CHANGE_SHADER);
        this._generateReactivePass = new ComputePass(
            device,
            'gen-reactive',
            GENERATE_REACTIVE_SHADER,
        );
        this._debugPass = new ComputePass(device, 'debug', DEBUG_SHADER, {
            shaderKey: 'baseline:debug',
            assembledChunks: [],
        });

        this._jitter = new JitterSequence(this._ratio);
        this._initialized = true;
    }

    /**
     * (Re)configures resolutions and the active pipeline. Allocates the
     * working texture set — call on startup, resize, or mode change.
     * @param config - Display size, quality mode/ratio, and pipeline path
     */
    configure(config: UpscalerConfig): void {
        if (!this._initialized) this.init();

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

    /** Per-pass GPU times (ms) when timestamp queries are supported. */
    get gpuTimings(): ReadonlyMap<string, number> {
        return this._timer.timings;
    }

    /** Drops all temporal history on the next dispatch (camera cut etc.). */
    resetHistory(): void {
        this._pendingReset = true;
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
     * @param inputs - Scene color (+ depth/velocity for the temporal path) and camera info
     */
    dispatch(inputs: DispatchInputs, camera: JitterableCamera): void {
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

        const colorGPU = getGPUTexture(this._renderer, inputs.color);
        this._checkMsaa(colorGPU, 'color');
        const encoder = this._device.createCommandEncoder({ label: 'upscale' });
        this._timer.beginFrame();

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

        this._timer.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer.readback();

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
     * @param camera - The scene camera (near/far and projection type)
     */
    dispatchGuides(inputs: GuideDispatchInputs, camera: JitterableCamera): void {
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

        const encoder = this._device.createCommandEncoder({ label: 'upscale-guides' });
        this._timer.beginFrame();
        this._encodeGuides(encoder, inputs);
        this._timer.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer.readback();

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
     * @param camera - The camera passed to {@link dispatchGuides}
     */
    dispatchUpscale(inputs: DispatchInputs, camera: JitterableCamera): void {
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

        const colorGPU = getGPUTexture(this._renderer, inputs.color);
        this._checkMsaa(colorGPU, 'color');
        const encoder = this._device.createCommandEncoder({ label: 'upscale-late' });
        this._timer.beginFrame();
        this._encodeLate(encoder, colorGPU, inputs);
        this._timer.resolve(encoder);
        this._device.queue.submit([encoder.finish()]);
        this._timer.readback();

        this._guidesPending = false;
        this._frameIndex++;
        this._pendingReset = false;
        this._historyIndex = 1 - this._historyIndex;
        this._depthIndex = 1 - this._depthIndex;
    }

    /** Releases all GPU resources. */
    dispose(): void {
        this._destroyTextures();
        this._giFusionParams?.destroy();
        this._giFusionParams = null;
        this._constants?.dispose();
        this._timer?.dispose();
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
            timestampWrites: this._timer.passDescriptor('blit'),
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
            timestampWrites: this._timer.passDescriptor('easu'),
        });
        this._easuPass.dispatch(easuPass, easuBindGroup, this._displayWidth, this._displayHeight);
        easuPass.end();

        //* RCAS — sharpen in the caller's color domain
        const exposureView = this._exposure![0].createView();
        if (this.settings.sharpness > 0) {
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

    // Early stage — the reconstruct pass (fused dilate + depth clip). Produces
    // the signal-agnostic geometry guides: dilated depth/motion, disocclusion.
    private _encodeGuides(encoder: GPUCommandEncoder, inputs: GuideDispatchInputs): void {
        const depthGPU = getGPUTexture(this._renderer, inputs.depth);
        const velocityGPU = getGPUTexture(this._renderer, inputs.velocity);
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

        //* Reconstruct — dilate (nearest-depth motion/depth over 3×3) + depth
        //* clip (disocclusion vs last frame's dilated depth) fused into one pass.
        const reconstructBindGroup = this._reconstructPass.createBindGroup([
            { buffer: this._constants.buffer },
            depthView,
            velocityGPU.createView(),
            depthPrev.createView(),
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            this._masks!.createView(),
        ]);
        const reconstructPass = encoder.beginComputePass({
            label: 'upscale-reconstruct',
            timestampWrites: this._timer.passDescriptor('reconstruct'),
        });
        this._reconstructPass.dispatch(
            reconstructPass,
            reconstructBindGroup,
            this._renderWidth,
            this._renderHeight,
        );
        reconstructPass.end();
    }

    // Late stage — everything that needs the final beauty color: reactive,
    // exposure, shading change, accumulate, and the output pass.
    private _encodeLate(
        encoder: GPUCommandEncoder,
        inputColorGPU: GPUTexture,
        inputs: DispatchInputs,
    ): void {
        // Experimental GI fusion: from here on the pipeline consumes the
        // fused composite in place of the caller's color.
        const colorGPU = inputs.giFusion
            ? this._encodeGiFusion(encoder, inputColorGPU, inputs.giFusion, inputs.depth)
            : inputColorGPU;
        this._giFusedLastFrame = inputs.giFusion !== undefined;
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
                const incoming = getGPUTexture(this._renderer, inputs.reactive);
                if (incoming === this._reactiveGenerated) {
                    throw new Error(
                        '@pmndrs/upscaler: `reactive` must not be the generated mask itself ' +
                            '(guides.reactive) while `reactiveOpaqueColor` is set — the generator ' +
                            'writes that texture. Pass one of the two, not both.',
                    );
                }
                incomingView = incoming.createView();
            }
            const opaqueGPU = getGPUTexture(this._renderer, inputs.reactiveOpaqueColor);
            const genBindGroup = this._generateReactivePass.createBindGroup([
                { buffer: this._constants.buffer },
                opaqueGPU.createView(),
                colorGPU.createView(),
                this._reactiveGenerated!.createView(),
                incomingView,
            ]);
            const genPass = encoder.beginComputePass({
                label: 'upscale-gen-reactive',
                timestampWrites: this._timer.passDescriptor('genReactive'),
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
            reactiveView = getGPUTexture(this._renderer, inputs.reactive).createView();
        } else {
            reactiveView = this._reactiveDummy!.createView();
        }

        //* Exposure — reduce scene luminance to a pre-exposure (auto-exposure).
        // Runs first; every later pass reads this frame's value from exposureCur.
        // App-supplied exposure when given, else the 1×1 dummy (ignored unless
        // FLAG_EXTERNAL_EXPOSURE is set — reuse the reactive dummy as a valid
        // texture_2d<f32> placeholder rather than allocate a second one).
        const externalExposureView = inputs.exposureTexture
            ? getGPUTexture(this._renderer, inputs.exposureTexture).createView()
            : this._reactiveDummy!.createView();
        // Host pre-exposure input — the zero dummy publishes as 1.0 (inert).
        const hostPreExposureView = inputs.preExposureTexture
            ? getGPUTexture(this._renderer, inputs.preExposureTexture).createView()
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
            timestampWrites: this._timer.passDescriptor('exposure'),
        });
        // One workgroup performs the whole reduction (see luminancePyramid.ts).
        this._exposurePass.dispatch(exposurePass, exposureBindGroup, 8, 8);
        exposurePass.end();

        //* Shading Change — signed luma-difference pyramid (skipped entirely
        //* when the detector is off; accumulate then reads a zero dummy).
        let shadingSignalView = this._reactiveDummy!.createView();
        if (this.settings.detectShadingChanges) {
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
            ]);
            const shadingPass = encoder.beginComputePass({
                label: 'upscale-shading-change',
                timestampWrites: this._timer.passDescriptor('shadingChange'),
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
            timestampWrites: this._timer.passDescriptor('accumulate'),
        });
        this._accumulatePass.dispatch(
            accumulatePass,
            accumulateBindGroup,
            this._displayWidth,
            this._displayHeight,
        );
        accumulatePass.end();

        //* Output — debug view, RCAS sharpen, or plain resolve
        if (this.settings.debugView !== DebugView.None) {
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
                timestampWrites: this._timer.passDescriptor('output'),
            });
            this._debugPass.dispatch(
                debugPass,
                debugBindGroup,
                this._displayWidth,
                this._displayHeight,
            );
            debugPass.end();
        } else if (this.settings.sharpness > 0) {
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

    // Experimental (issue #7): accumulates the caller's noisy GI signal in its
    // own render-res history and returns the composite the rest of the late
    // stage consumes. See shaders/giFusion.ts.
    private _encodeGiFusion(
        encoder: GPUCommandEncoder,
        baseGPU: GPUTexture,
        gi: GiFusionInputs,
        depth: Texture | undefined,
    ): GPUTexture {
        if (!depth) {
            throw new Error(
                '@pmndrs/upscaler: giFusion needs the depth input on the late dispatch too ' +
                    '(it tags GI history by surface).',
            );
        }
        const rw = this._renderWidth;
        const rh = this._renderHeight;
        this._giFusionPass ??= new ComputePass(this._device, 'gi-fusion', GI_FUSION_SHADER);
        this._giFusionParams ??= this._device.createBuffer({
            label: 'upscale-gi-fusion-params',
            size: GI_FUSION_PARAMS_SIZE,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        let reset = !this._giFusedLastFrame;
        if (!this._giHistory || !this._giMoments || !this._giSurface || !this._giComposite) {
            this._giHistory = [
                this._createTexture('gi-history-0', rw, rh, 'rgba16float'),
                this._createTexture('gi-history-1', rw, rh, 'rgba16float'),
            ];
            this._giMoments = [
                this._createTexture('gi-moments-0', rw, rh, 'rgba16float'),
                this._createTexture('gi-moments-1', rw, rh, 'rgba16float'),
            ];
            this._giSurface = [
                this._createTexture('gi-surface-0', rw, rh, 'r32float'),
                this._createTexture('gi-surface-1', rw, rh, 'r32float'),
            ];
            this._giComposite = this._createTexture('gi-composite', rw, rh, 'rgba16float');
            reset = true;
        }

        //* Pass-local parameters (layout: GiFusionParams in giFusion.ts)
        const f32 = new Float32Array(this._giFusionParamData);
        const u32 = new Uint32Array(this._giFusionParamData);
        f32[0] = Math.max(1, gi.maxHistory ?? 48);
        f32[1] = Math.min(1, Math.max(0, gi.momentsAlpha ?? 0.2));
        f32[2] = Math.max(0, gi.clampGamma ?? 4);
        f32[3] = 4; // shortHistory: spatial fallback fades out by 4 frames
        f32[4] = 0.02; // depthSigma: relative depth tolerance of the 3×3
        u32[5] =
            (gi.occlusion ? GI_FUSION_FLAG_OCCLUSION : 0) |
            (reset ? GI_FUSION_FLAG_RESET : 0) |
            ((gi.tonemap ?? true) ? GI_FUSION_FLAG_TONEMAP : 0) |
            ((gi.surfaceTolerance ?? 0.03) > 0 ? GI_FUSION_FLAG_SURFACE : 0) |
            ((gi.antiLag ?? 'standard-error') === 'standard-error' ? GI_FUSION_FLAG_STDERR_BOX : 0) |
            ((gi.blockAntiLag ?? true) ? GI_FUSION_FLAG_BLOCK_ANTILAG : 0);
        f32[6] = Math.max(0, gi.surfaceTolerance ?? 0.03);
        this._device.queue.writeBuffer(this._giFusionParams, 0, this._giFusionParamData);

        const historyIn = this._historyIndex;
        const historyOut = 1 - this._historyIndex;
        const signalView = getGPUTexture(this._renderer, gi.signal).createView();
        const depthGPU = getGPUTexture(this._renderer, depth);
        const depthView = depthGPU.createView(
            depthGPU.format.includes('stencil') ? { aspect: 'depth-only' } : undefined,
        );
        const bindGroup = this._giFusionPass.createBindGroup([
            { buffer: this._constants.buffer },
            signalView,
            gi.occlusion ? getGPUTexture(this._renderer, gi.occlusion).createView() : signalView,
            baseGPU.createView(),
            getGPUTexture(this._renderer, gi.albedo).createView(),
            this._dilatedMotion!.createView(),
            this._masks!.createView(),
            depthView,
            this._giHistory[historyIn].createView(),
            this._giMoments[historyIn].createView(),
            this._linearSampler,
            this._giHistory[historyOut].createView(),
            this._giMoments[historyOut].createView(),
            this._giComposite.createView(),
            { buffer: this._giFusionParams },
            this._giSurface[historyIn].createView(),
            this._giSurface[historyOut].createView(),
        ]);
        const pass = encoder.beginComputePass({
            label: 'upscale-gi-fusion',
            timestampWrites: this._timer.passDescriptor('giFusion'),
        });
        this._giFusionPass.dispatch(pass, bindGroup, rw, rh);
        pass.end();
        return this._giComposite;
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
            timestampWrites: this._timer.passDescriptor('rcas'),
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

    private _baseFlags(): number {
        let flags = 0;
        if (this._pendingReset) flags |= FLAG_RESET;
        if ((this._renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer) {
            flags |= FLAG_REVERSED_DEPTH;
        }
        return flags;
    }

    // Accepts either dispatch shape — the guides stage has no color, and every
    // field this reads is shared between the two input types.
    private _writeConstants(
        inputs: Omit<DispatchInputs, 'color'>,
        camera: JitterableCamera,
    ): void {
        const c = this._constants;
        c.setRenderSize(this._renderWidth, this._renderHeight);
        c.setDisplaySize(this._displayWidth, this._displayHeight);

        if (this._path === 'temporal' && this._jitterEnabled) {
            const [jx, jy] = this._jitter.current;
            const [px, py] = this._jitter.previous;
            c.setJitter(jx, jy, px, py);
        } else {
            c.setJitter(0, 0, 0, 0);
        }

        // NDC delta -> UV delta: u = 0.5 + ndc.x/2, v = 0.5 - ndc.y/2.
        c.setMotionScale(0.5, -0.5);
        c.setDepthNearFar(camera.near, camera.far);
        c.setSharpness(Math.min(1, Math.max(0, this.settings.sharpness)));
        c.setMaxAccumulation(Math.max(1, this.settings.maxAccumulation));
        c.setExposure(this.settings.exposure);
        c.setDeltaTime(inputs.deltaTime ?? 1 / 60);
        c.setFrameIndex(this._frameIndex);
        c.setDebugMode(this.settings.debugView);

        // The input-space flag only matters to the final output pass (blit
        // or RCAS) — earlier passes ignore it, so it is staged once here.
        let flags = this._baseFlags();
        if (inputs.reset) {
            this._pendingReset = true;
            flags |= FLAG_RESET;
        }
        if ((camera as PerspectiveCamera).isPerspectiveCamera) flags |= FLAG_PERSPECTIVE;
        if (this._path === 'temporal') flags |= FLAG_INPUT_REINHARD;
        if (this.settings.lockThinFeatures) flags |= FLAG_LOCKS;
        if (this.settings.autoExposure) flags |= FLAG_AUTO_EXPOSURE;
        if (this.settings.detectShadingChanges) flags |= FLAG_SHADING_CHANGE;
        if (inputs.reactive || inputs.reactiveOpaqueColor) flags |= FLAG_REACTIVE;
        if (inputs.exposureTexture) flags |= FLAG_EXTERNAL_EXPOSURE;
        if (this.settings.rcasDenoise) flags |= FLAG_RCAS_DENOISE;
        c.setFlags(flags);
    }

    //* Texture Allocation

    private _createTexture(
        label: string,
        w: number,
        h: number,
        format: GPUTextureFormat,
    ): GPUTexture {
        return this._device.createTexture({
            label: `upscale-${label}`,
            size: { width: w, height: h },
            format,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });
    }

    // Allocates a working texture through three (same mechanism as the output)
    // so it is publishable in the guides bundle: the three StorageTexture is
    // what consumers sample, the raw handle is what our passes bind.
    private _createSharedTexture(
        label: string,
        w: number,
        h: number,
        format: 'r32float' | 'rgba8unorm' | 'rgba16float',
    ): { tex: StorageTexture; gpu: GPUTexture } {
        const tex = new StorageTexture(w, h);
        tex.name = `upscale-${label}`;
        tex.colorSpace = NoColorSpace;
        // Storage views must cover exactly one mip level (see _output).
        tex.generateMipmaps = false;
        switch (format) {
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
            const exposure0 = this._createSharedTexture('exposure-0', 1, 1, 'rgba16float');
            const exposure1 = this._createSharedTexture('exposure-1', 1, 1, 'rgba16float');
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
        this._giHistory?.forEach((texture) => texture.destroy());
        this._giMoments?.forEach((texture) => texture.destroy());
        this._giSurface?.forEach((texture) => texture.destroy());
        this._giComposite?.destroy();
        this._giSurface = null;
        this._giHistory = null;
        this._giMoments = null;
        this._giComposite = null;
        this._giFusedLastFrame = false;
    }
}
