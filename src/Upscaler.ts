import {
    HalfFloatType,
    Matrix4,
    NoColorSpace,
    type OrthographicCamera,
    type PerspectiveCamera,
} from 'three';
import { StorageTexture, type Texture, type WebGPURenderer } from 'three/webgpu';

import { ComputePass } from './internal/ComputePass';
import { ConstantsBuffer } from './internal/ConstantsBuffer';
import { GpuTimer } from './internal/GpuTimer';
import { getDevice, getGPUTexture } from './internal/threeWebGPU';
import { JitterSequence } from './math/jitter';
import { getQualityModeRatio, getRenderResolution } from './math/resolution';
import { ACCUMULATE_SHADER } from './shaders/accumulate';
import { BLIT_SHADER } from './shaders/blit';
import {
    ACCUMULATE_SOURCE_FILTER_SHADER,
    ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
    EASU_SOURCE_APPROX_SHADER,
} from './shaders/candidateFilters';
import {
    DEBUG_SOURCE_FILTER_SHADER,
    DEBUG_SOURCE_RESOLVER_SHADER,
    DEBUG_SOURCE_STRUCTURAL_SHADER,
} from './shaders/candidateDebug';
import {
    DEPTH_CLIP_SOURCE_SHADER,
    GENERATE_REACTIVE_SOURCE_SHADER,
    PREPARE_INPUTS_SOURCE_SHADER,
    PREPARE_REACTIVITY_SOURCE_SHADER,
} from './shaders/candidateInputs';
import {
    ACCUMULATE_SOURCE_RESOLVER_SHADER,
    EXPOSURE_HISTORY_SOURCE_SHADER,
    LUMA_INSTABILITY_SOURCE_SHADER,
    LUMA_SPD_SOURCE_SHADER,
    SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
    SHADING_CHANGE_SPD_SOURCE_SHADER,
} from './shaders/candidateTemporal';
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
import { RECONSTRUCT_SHADER } from './shaders/reconstruct';
import { SHADING_CHANGE_SHADER } from './shaders/shadingChange';
import {
    DebugView,
    QualityMode,
    type UpscalerConfig,
    type DispatchInputs,
    type RuntimeSettings,
    type UpscalePath,
} from './types';

type JitterableCamera = PerspectiveCamera | OrthographicCamera;
type CandidateBundleId =
    | 'source-filter-bundle-v1'
    | 'source-structural-bundle-v1'
    | 'source-spd-resolver-bundle-v1';
type UpscalerInternalOptions = {
    renderer: WebGPURenderer;
    _rcasShader?: string;
    _candidateBundle?: string;
};

/**
 * FSR3-style upscaler for three's `WebGPURenderer`, implemented as raw WGSL
 * compute passes on the renderer's GPU device.
 *
 * Pipelines:
 * - `bilinear` — blit (comparison baseline / native passthrough)
 * - `spatial`  — EASU → RCAS (FSR1)
 * - `temporal` — dilate → depth-clip → accumulate → RCAS (FSR2/3-style)
 *
 * Usage per frame (temporal path):
 * ```ts
 * upscaler.beginFrame(camera, deltaTime);      // applies sub-pixel jitter
 * renderer.setRenderTarget(sceneRT);           // color+velocity MRT, depth
 * renderer.render(scene, camera);
 * upscaler.dispatch({ color, depth, velocity });
 * upscaler.endFrame(camera);                   // clears jitter
 * // present upscaler.outputTexture on a fullscreen quad
 * ```
 * Feed `upscaler.unjitteredProjectionMatrix` to the scene's `velocity` node
 * via `setProjectionMatrix` so motion vectors stay jitter-free.
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
    private readonly _candidateBundle: CandidateBundleId | null;
    private _device!: GPUDevice;
    private _constants!: ConstantsBuffer;
    private _timer!: GpuTimer;
    private _linearSampler!: GPUSampler;

    private _blitPass!: ComputePass;
    private _easuPass!: ComputePass;
    private _rcasPass!: ComputePass;
    private _reconstructPass!: ComputePass;
    private _accumulatePass!: ComputePass;
    private _exposurePass!: ComputePass;
    private _generateReactivePass!: ComputePass;
    private _shadingChangePass!: ComputePass;
    private _debugPass!: ComputePass;
    private _depthClipPass: ComputePass | null = null;
    private _prepareReactivityPass: ComputePass | null = null;
    private _shadingSpdPass: ComputePass | null = null;
    private _shadingResolvePass: ComputePass | null = null;
    private _lumaInstabilityPass: ComputePass | null = null;

    private _path: UpscalePath = 'temporal';
    private _displayWidth = 0;
    private _displayHeight = 0;
    private _renderWidth = 0;
    private _renderHeight = 0;
    private _ratio = 1;

    private _jitter!: JitterSequence;
    private _jitterEnabled = true;
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
    // Candidate-only source graph resources. Production never allocates these.
    private _reconstructedDepth: GPUBuffer | null = null;
    private _inputSignals: GPUTexture | null = null;
    private _preparedMasks: GPUTexture | null = null;
    private _accumulation: [GPUTexture, GPUTexture] | null = null;
    private _newLocks: GPUBuffer | null = null;
    private _lumaPyramid: GPUTexture | null = null;
    private _shadingPyramid: GPUTexture | null = null;
    private _shadingChange: GPUTexture | null = null;
    private _lumaHistory: [GPUTexture, GPUTexture] | null = null;
    private _lumaInstability: GPUTexture | null = null;
    // Production shading-change detector state (distinct from the candidate
    // resolver's _lumaHistory/_shadingChange above).
    private _shadingLumaHistory: [GPUTexture, GPUTexture] | null = null;
    private _shadingSignal: GPUTexture | null = null;

    constructor(options: { renderer: WebGPURenderer });
    constructor(options: UpscalerInternalOptions) {
        this._renderer = options.renderer;
        this._rcasShader = options._rcasShader ?? RCAS_SHADER;
        const candidate = options._candidateBundle;
        if (
            candidate !== undefined &&
            candidate !== 'source-filter-bundle-v1' &&
            candidate !== 'source-structural-bundle-v1' &&
            candidate !== 'source-spd-resolver-bundle-v1'
        )
            throw new Error(`@pmndrs/upscaler: unknown internal candidate bundle ${candidate}.`);
        this._candidateBundle = candidate ?? null;
    }

    private get _usesStructuralInputs(): boolean {
        return (
            this._candidateBundle === 'source-structural-bundle-v1' ||
            this._candidateBundle === 'source-spd-resolver-bundle-v1'
        );
    }

    private get _usesSourceResolver(): boolean {
        return this._candidateBundle === 'source-spd-resolver-bundle-v1';
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
        this._easuPass = new ComputePass(
            device,
            'easu',
            this._candidateBundle ? EASU_SOURCE_APPROX_SHADER : EASU_SHADER,
            this._candidateBundle
                ? {
                      shaderKey: 'fsr1-source-approx-v1',
                      assembledChunks: ['constants', 'easu-source-approx'],
                  }
                : {},
        );
        this._rcasPass = new ComputePass(device, 'rcas', this._rcasShader);
        this._reconstructPass = new ComputePass(
            device,
            'reconstruct',
            this._candidateBundle ? PREPARE_INPUTS_SOURCE_SHADER : RECONSTRUCT_SHADER,
            this._candidateBundle
                ? {
                      shaderKey: this._usesStructuralInputs
                          ? 'fsr315-prepare-inputs-structural-v1'
                          : 'fsr315-prepare-inputs-filter-v1',
                      assembledChunks: ['constants', 'color', 'depth', 'candidate-depth', 'prepare-inputs'],
                      constants: {
                          MOTION_INPUT_AT_DISPLAY_RESOLUTION: 0,
                          MOTION_CANCEL_JITTER: 0,
                          MOTION_SCALE_X: 1,
                          MOTION_SCALE_Y: 1,
                          PREPARE_STRUCTURAL_SIGNALS: this._usesStructuralInputs ? 1 : 0,
                      },
                  }
                : {},
        );
        const accumulateShader = this._usesSourceResolver
            ? ACCUMULATE_SOURCE_RESOLVER_SHADER
            : this._usesStructuralInputs
              ? ACCUMULATE_SOURCE_STRUCTURAL_SHADER
              : this._candidateBundle
                ? ACCUMULATE_SOURCE_FILTER_SHADER
                : ACCUMULATE_SHADER;
        this._accumulatePass = new ComputePass(device, 'accumulate', accumulateShader, {
            shaderKey: this._candidateBundle
                ? this._usesSourceResolver
                    ? 'fsr315-source-resolver-v1'
                    : this._usesStructuralInputs
                      ? 'fsr315-source-filter-structural-v1'
                      : 'fsr315-source-filter-v1'
                : 'baseline:accumulate',
            assembledChunks: this._candidateBundle
                ? ['constants', 'color', 'tonemap', 'candidate-accumulate']
                : [],
        });
        this._exposurePass = new ComputePass(
            device,
            'exposure',
            this._usesSourceResolver
                ? LUMA_SPD_SOURCE_SHADER
                : this._candidateBundle
                  ? EXPOSURE_HISTORY_SOURCE_SHADER
                  : LUMINANCE_PYRAMID_SHADER,
            this._candidateBundle
                ? {
                      shaderKey: this._usesSourceResolver
                          ? 'fsr315-luma-spd-v1'
                          : 'fsr315-exposure-history-v1',
                      assembledChunks: ['constants', 'candidate-exposure'],
                  }
                : {},
        );
        this._shadingChangePass = new ComputePass(device, 'shading-change', SHADING_CHANGE_SHADER);
        this._generateReactivePass = new ComputePass(
            device,
            'gen-reactive',
            this._usesStructuralInputs
                ? GENERATE_REACTIVE_SOURCE_SHADER
                : GENERATE_REACTIVE_SHADER,
            this._usesStructuralInputs
                ? {
                      shaderKey: 'fsr315-generate-reactive-policy-v1',
                      assembledChunks: ['constants', 'generate-reactive-source-policy'],
                      constants: {
                          REACTIVE_USE_COMPONENT_MAX: 1,
                          REACTIVE_APPLY_THRESHOLD: 1,
                          REACTIVE_BINARY: 0,
                          REACTIVE_THRESHOLD: 0.04,
                          REACTIVE_SCALE: 2,
                          REACTIVE_BINARY_VALUE: 1,
                      },
                  }
                : {},
        );
        const debugShader = this._usesSourceResolver
            ? DEBUG_SOURCE_RESOLVER_SHADER
            : this._usesStructuralInputs
              ? DEBUG_SOURCE_STRUCTURAL_SHADER
              : this._candidateBundle
                ? DEBUG_SOURCE_FILTER_SHADER
                : DEBUG_SHADER;
        this._debugPass = new ComputePass(device, 'debug', debugShader, {
            shaderKey: this._candidateBundle
                ? `${this._candidateBundle}:debug-v1`
                : 'baseline:debug',
            assembledChunks: this._candidateBundle
                ? ['constants', 'color', 'candidate-debug']
                : [],
        });
        if (this._candidateBundle) {
            this._depthClipPass = new ComputePass(device, 'depth-clip', DEPTH_CLIP_SOURCE_SHADER, {
                shaderKey: this._usesStructuralInputs
                    ? 'fsr315-depth-clip-structural-v1'
                    : 'fsr315-depth-clip-filter-v1',
                assembledChunks: ['constants', 'depth', 'candidate-depth', 'depth-clip'],
                constants: {
                    DEPTH_CLIP_MOTION_DIVERGENCE: this._usesStructuralInputs ? 1 : 0,
                },
            });
        }
        if (this._usesStructuralInputs) {
            this._prepareReactivityPass = new ComputePass(
                device,
                'prepare-reactivity',
                PREPARE_REACTIVITY_SOURCE_SHADER,
                {
                    shaderKey: 'fsr315-prepare-reactivity-v1',
                    assembledChunks: ['constants', 'prepare-reactivity'],
                },
            );
        }
        if (this._usesSourceResolver) {
            this._shadingSpdPass = new ComputePass(
                device,
                'shading-spd',
                SHADING_CHANGE_SPD_SOURCE_SHADER,
                {
                    shaderKey: 'fsr315-shading-change-spd-v1',
                    assembledChunks: ['constants', 'shading-change-spd'],
                },
            );
            this._shadingResolvePass = new ComputePass(
                device,
                'shading-resolve',
                SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
                {
                    shaderKey: 'fsr315-shading-change-resolve-v1',
                    assembledChunks: ['constants', 'shading-change-resolve'],
                },
            );
            this._lumaInstabilityPass = new ComputePass(
                device,
                'luma-instability',
                LUMA_INSTABILITY_SOURCE_SHADER,
                {
                    shaderKey: 'fsr315-luma-instability-v1',
                    assembledChunks: ['constants', 'luma-instability'],
                },
            );
        }

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
            throw new Error('@pmndrs/upscaler: configure() must run before outputTexture is used.');
        }
        return this._output;
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
     * No-op on non-temporal paths, or when jitter is disabled (see the
     * `jitter` config flag — the temporal path still reprojects and
     * accumulates, it just doesn't add the sub-pixel offset).
     * @param camera - The scene camera (perspective or orthographic)
     */
    beginFrame(camera: JitterableCamera): void {
        // Snapshot the jitter-free projection for velocity before offsetting.
        camera.updateProjectionMatrix();
        this.unjitteredProjectionMatrix.copy(camera.projectionMatrix);

        if (this._path !== 'temporal' || !this._jitterEnabled) return;

        this._jitter.advance();
        const [jx, jy] = this._jitter.current;
        camera.setViewOffset(
            this._renderWidth,
            this._renderHeight,
            jx,
            jy,
            this._renderWidth,
            this._renderHeight,
        );
    }

    /**
     * Ends a frame: removes the jitter view offset from the camera.
     * @param camera - The camera passed to {@link beginFrame}
     */
    endFrame(camera: JitterableCamera): void {
        if (camera.view !== null && camera.view.enabled) {
            camera.clearViewOffset();
        }
    }

    /**
     * Encodes and submits the upscaling passes for this frame. Call after
     * the scene has been rendered into the input textures.
     * @param inputs - Scene color (+ depth/velocity for the temporal path) and camera info
     */
    dispatch(inputs: DispatchInputs, camera: JitterableCamera): void {
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
                this._encodeBlit(encoder, colorGPU.createView(), this._exposure![0].createView());
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

    /** Releases all GPU resources. */
    dispose(): void {
        this._destroyTextures();
        this._constants?.dispose();
        this._timer?.dispose();
        this._initialized = false;
    }

    //* Pass Encoding

    private _encodeBlit(
        encoder: GPUCommandEncoder,
        input: GPUTextureView,
        exposure: GPUTextureView,
    ): void {
        const bindGroup = this._blitPass.createBindGroup([
            { buffer: this._constants.buffer },
            input,
            this._linearSampler,
            exposure,
            this._outputView(),
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
            this._encodeRcas(encoder, this._easuOutput!.createView(), exposureView);
        } else {
            this._encodeBlit(encoder, this._easuOutput!.createView(), exposureView);
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
        if (this._candidateBundle) {
            this._encodeCandidateTemporal(encoder, colorGPU, inputs);
            return;
        }

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
        const historyIn = this._history![this._historyIndex];
        const historyOut = this._history![1 - this._historyIndex];
        const locksIn = this._locks![this._historyIndex];
        const locksOut = this._locks![1 - this._historyIndex];
        const exposurePrev = this._exposure![this._historyIndex];
        const exposureCur = this._exposure![1 - this._historyIndex];
        //* Reactive mask — explicit mask, else auto-generate from an opaque-only
        //* color diff against the final color, else a zero dummy.
        let reactiveView: GPUTextureView;
        if (inputs.reactive) {
            reactiveView = getGPUTexture(this._renderer, inputs.reactive).createView();
        } else if (inputs.reactiveOpaqueColor) {
            const opaqueGPU = getGPUTexture(this._renderer, inputs.reactiveOpaqueColor);
            const genBindGroup = this._generateReactivePass.createBindGroup([
                { buffer: this._constants.buffer },
                opaqueGPU.createView(),
                colorGPU.createView(),
                this._reactiveGenerated!.createView(),
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
            this._encodeRcas(encoder, historyOut.createView(), exposureCur.createView());
        } else {
            this._encodeBlit(encoder, historyOut.createView(), exposureCur.createView());
        }
    }

    private _encodeCandidateTemporal(
        encoder: GPUCommandEncoder,
        colorGPU: GPUTexture,
        inputs: DispatchInputs,
    ): void {
        const depthGPU = getGPUTexture(this._renderer, inputs.depth!);
        const velocityGPU = getGPUTexture(this._renderer, inputs.velocity!);
        this._checkMsaa(depthGPU, 'depth');
        this._checkMsaa(velocityGPU, 'velocity');
        const depthView = depthGPU.createView(
            depthGPU.format.includes('stencil') ? { aspect: 'depth-only' } : undefined,
        );

        const historyIn = this._history![this._historyIndex];
        const historyOut = this._history![1 - this._historyIndex];
        const locksIn = this._locks![this._historyIndex];
        const locksOut = this._locks![1 - this._historyIndex];
        const exposurePrev = this._exposure![this._historyIndex];
        const exposureCur = this._exposure![1 - this._historyIndex];
        const depthCur = this._dilatedDepth![this._depthIndex];
        const externalConditioning = inputs.exposureTexture
            ? getGPUTexture(this._renderer, inputs.exposureTexture).createView()
            : this._reactiveDummy!.createView();
        const hostPreExposure = inputs.preExposureTexture
            ? getGPUTexture(this._renderer, inputs.preExposureTexture).createView()
            : this._reactiveDummy!.createView();

        // Atomic scatter/lock buffers are frame-transient. GPU clears preserve
        // the pass boundary without a CPU upload proportional to resolution.
        encoder.clearBuffer(this._reconstructedDepth!);
        if (this._newLocks) encoder.clearBuffer(this._newLocks);

        //* Reactive Generation ===
        let reactiveView: GPUTextureView;
        if (inputs.reactive) {
            reactiveView = getGPUTexture(this._renderer, inputs.reactive).createView();
        } else if (inputs.reactiveOpaqueColor) {
            const opaqueGPU = getGPUTexture(this._renderer, inputs.reactiveOpaqueColor);
            const bindGroup = this._generateReactivePass.createBindGroup([
                { buffer: this._constants.buffer },
                opaqueGPU.createView(),
                colorGPU.createView(),
                this._reactiveGenerated!.createView(),
            ]);
            const pass = encoder.beginComputePass({
                label: 'upscale-gen-reactive',
                timestampWrites: this._timer.passDescriptor('genReactive'),
            });
            this._generateReactivePass.dispatch(pass, bindGroup, this._renderWidth, this._renderHeight);
            pass.end();
            reactiveView = this._reactiveGenerated!.createView();
        } else {
            reactiveView = this._reactiveDummy!.createView();
        }

        //* Prepare Inputs + Atomic Depth Scatter ===
        const prepareInputsBindGroup = this._reconstructPass.createBindGroup([
            { buffer: this._constants.buffer },
            depthView,
            velocityGPU.createView(),
            colorGPU.createView(),
            { buffer: this._reconstructedDepth! },
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            this._inputSignals!.createView(),
        ]);
        const prepareInputsPass = encoder.beginComputePass({
            label: 'upscale-prepare-inputs',
            timestampWrites: this._timer.passDescriptor('prepareInputs'),
        });
        this._reconstructPass.dispatch(
            prepareInputsPass,
            prepareInputsBindGroup,
            this._renderWidth,
            this._renderHeight,
        );
        prepareInputsPass.end();

        //* Exposure State / Luma SPD ===
        if (this._usesSourceResolver) {
            const lumaSpdBindGroup = this._exposurePass.createBindGroup([
                { buffer: this._constants.buffer },
                this._inputSignals!.createView(),
                exposurePrev.createView(),
                externalConditioning,
                hostPreExposure,
                exposureCur.createView(),
                this._mipView(this._lumaPyramid!, 0),
                this._mipView(this._lumaPyramid!, 1),
                this._mipView(this._lumaPyramid!, 2),
            ]);
            const lumaSpdPass = encoder.beginComputePass({
                label: 'upscale-luma-spd',
                timestampWrites: this._timer.passDescriptor('lumaSpd'),
            });
            this._exposurePass.dispatch(
                lumaSpdPass,
                lumaSpdBindGroup,
                Math.max(1, Math.ceil(this._renderWidth / 2)),
                Math.max(1, Math.ceil(this._renderHeight / 2)),
            );
            lumaSpdPass.end();
        } else {
            const exposureBindGroup = this._exposurePass.createBindGroup([
                { buffer: this._constants.buffer },
                colorGPU.createView(),
                this._linearSampler,
                exposurePrev.createView(),
                exposureCur.createView(),
                externalConditioning,
                hostPreExposure,
            ]);
            const exposurePass = encoder.beginComputePass({
                label: 'upscale-exposure-history',
                timestampWrites: this._timer.passDescriptor('exposure'),
            });
            this._exposurePass.dispatch(exposurePass, exposureBindGroup, 8, 8);
            exposurePass.end();
        }

        //* Reconstructed Depth Resolve ===
        const depthClipBindGroup = this._depthClipPass!.createBindGroup([
            { buffer: this._constants.buffer },
            { buffer: this._reconstructedDepth! },
            depthCur.createView(),
            this._dilatedMotion!.createView(),
            this._masks!.createView(),
        ]);
        const depthClipPass = encoder.beginComputePass({
            label: 'upscale-depth-clip',
            timestampWrites: this._timer.passDescriptor('depthClip'),
        });
        this._depthClipPass!.dispatch(
            depthClipPass,
            depthClipBindGroup,
            this._renderWidth,
            this._renderHeight,
        );
        depthClipPass.end();

        //* Signed-Difference Shading SPD ===
        if (this._usesSourceResolver) {
            const lumaHistoryIn = this._lumaHistory![this._historyIndex];
            const shadingSpdBindGroup = this._shadingSpdPass!.createBindGroup([
                { buffer: this._constants.buffer },
                this._inputSignals!.createView(),
                lumaHistoryIn.createView(),
                this._dilatedMotion!.createView(),
                exposureCur.createView(),
                exposurePrev.createView(),
                this._mipView(this._shadingPyramid!, 0),
                this._mipView(this._shadingPyramid!, 1),
                this._mipView(this._shadingPyramid!, 2),
            ]);
            const shadingSpdPass = encoder.beginComputePass({
                label: 'upscale-shading-spd',
                timestampWrites: this._timer.passDescriptor('shadingSpd'),
            });
            this._shadingSpdPass!.dispatch(
                shadingSpdPass,
                shadingSpdBindGroup,
                Math.max(1, Math.ceil(this._renderWidth / 2)),
                Math.max(1, Math.ceil(this._renderHeight / 2)),
            );
            shadingSpdPass.end();

            const shadingResolveBindGroup = this._shadingResolvePass!.createBindGroup([
                { buffer: this._constants.buffer },
                this._shadingPyramid!.createView({
                    baseMipLevel: 0,
                    mipLevelCount: 3,
                }),
                this._shadingChange!.createView(),
            ]);
            const shadingResolvePass = encoder.beginComputePass({
                label: 'upscale-shading-resolve',
                timestampWrites: this._timer.passDescriptor('shadingResolve'),
            });
            this._shadingResolvePass!.dispatch(
                shadingResolvePass,
                shadingResolveBindGroup,
                Math.max(1, Math.ceil(this._renderWidth / 2)),
                Math.max(1, Math.ceil(this._renderHeight / 2)),
            );
            shadingResolvePass.end();
        }

        //* Prepare Reactivity / Accumulation State ===
        if (this._usesStructuralInputs) {
            const accumulationIn = this._accumulation![this._historyIndex];
            const accumulationOut = this._accumulation![1 - this._historyIndex];
            const compositionView = inputs.transparencyAndComposition
                ? getGPUTexture(this._renderer, inputs.transparencyAndComposition).createView()
                : this._reactiveDummy!.createView();
            const shadingView = this._usesSourceResolver
                ? this._shadingChange!.createView()
                : this._reactiveDummy!.createView();
            const prepareReactivityBindGroup = this._prepareReactivityPass!.createBindGroup([
                { buffer: this._constants.buffer },
                this._masks!.createView(),
                this._dilatedMotion!.createView(),
                this._inputSignals!.createView(),
                reactiveView,
                compositionView,
                accumulationIn.createView(),
                shadingView,
                this._preparedMasks!.createView(),
                accumulationOut.createView(),
                { buffer: this._newLocks! },
            ]);
            const prepareReactivityPass = encoder.beginComputePass({
                label: 'upscale-prepare-reactivity',
                timestampWrites: this._timer.passDescriptor('prepareReactivity'),
            });
            this._prepareReactivityPass!.dispatch(
                prepareReactivityPass,
                prepareReactivityBindGroup,
                this._renderWidth,
                this._renderHeight,
            );
            prepareReactivityPass.end();
        }

        //* Four-Frame Luma Instability ===
        if (this._usesSourceResolver) {
            const lumaHistoryIn = this._lumaHistory![this._historyIndex];
            const lumaHistoryOut = this._lumaHistory![1 - this._historyIndex];
            const instabilityBindGroup = this._lumaInstabilityPass!.createBindGroup([
                { buffer: this._constants.buffer },
                this._inputSignals!.createView(),
                this._dilatedMotion!.createView(),
                this._preparedMasks!.createView(),
                lumaHistoryIn.createView(),
                exposureCur.createView(),
                exposurePrev.createView(),
                lumaHistoryOut.createView(),
                this._lumaInstability!.createView(),
            ]);
            const instabilityPass = encoder.beginComputePass({
                label: 'upscale-luma-instability',
                timestampWrites: this._timer.passDescriptor('lumaInstability'),
            });
            this._lumaInstabilityPass!.dispatch(
                instabilityPass,
                instabilityBindGroup,
                this._renderWidth,
                this._renderHeight,
            );
            instabilityPass.end();
        }

        //* Candidate Accumulation ===
        let accumulateResources: GPUBindingResource[];
        if (this._usesSourceResolver) {
            accumulateResources = [
                { buffer: this._constants.buffer },
                colorGPU.createView(),
                this._dilatedMotion!.createView(),
                this._preparedMasks!.createView(),
                historyIn.createView(),
                historyOut.createView(),
                this._inputSignals!.createView(),
                this._lumaInstability!.createView(),
                { buffer: this._newLocks! },
                exposureCur.createView(),
                exposurePrev.createView(),
            ];
        } else if (this._usesStructuralInputs) {
            accumulateResources = [
                { buffer: this._constants.buffer },
                colorGPU.createView(),
                this._dilatedMotion!.createView(),
                this._preparedMasks!.createView(),
                historyIn.createView(),
                this._linearSampler,
                historyOut.createView(),
                locksIn.createView(),
                locksOut.createView(),
                exposureCur.createView(),
                exposurePrev.createView(),
            ];
        } else {
            accumulateResources = [
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
            ];
        }
        const accumulateBindGroup = this._accumulatePass.createBindGroup(accumulateResources);
        const accumulatePass = encoder.beginComputePass({
            label: 'upscale-accumulate-candidate',
            timestampWrites: this._timer.passDescriptor('accumulate'),
        });
        this._accumulatePass.dispatch(
            accumulatePass,
            accumulateBindGroup,
            this._displayWidth,
            this._displayHeight,
        );
        accumulatePass.end();

        //* Output ===
        if (this.settings.debugView !== DebugView.None) {
            const debugMasks = this._usesStructuralInputs
                ? this._preparedMasks!.createView()
                : this._masks!.createView();
            const debugAuxiliary = this._usesSourceResolver
                ? this._lumaInstability!.createView()
                : locksOut.createView();
            const debugReactive = this._usesStructuralInputs
                ? this._preparedMasks!.createView()
                : reactiveView;
            const debugBindGroup = this._debugPass.createBindGroup([
                { buffer: this._constants.buffer },
                this._dilatedMotion!.createView(),
                debugMasks,
                this._inputSignals!.createView(),
                historyOut.createView(),
                debugAuxiliary,
                exposureCur.createView(),
                colorGPU.createView(),
                debugReactive,
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
            this._encodeRcas(encoder, historyOut.createView(), exposureCur.createView());
        } else {
            this._encodeBlit(encoder, historyOut.createView(), exposureCur.createView());
        }
    }

    private _encodeRcas(
        encoder: GPUCommandEncoder,
        input: GPUTextureView,
        exposure: GPUTextureView,
    ): void {
        const bindGroup = this._rcasPass.createBindGroup([
            { buffer: this._constants.buffer },
            input,
            exposure,
            this._outputView(),
        ]);
        const pass = encoder.beginComputePass({
            label: 'upscale-rcas',
            timestampWrites: this._timer.passDescriptor('rcas'),
        });
        this._rcasPass.dispatch(pass, bindGroup, this._displayWidth, this._displayHeight);
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

    private _mipView(texture: GPUTexture, level: number): GPUTextureView {
        return texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
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

    private _writeConstants(inputs: DispatchInputs, camera: JitterableCamera): void {
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
        if (this._path === 'temporal' && !this._usesSourceResolver) flags |= FLAG_INPUT_REINHARD;
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

    private _allocateTextures(): void {
        this._destroyTextures();
        const rw = this._renderWidth;
        const rh = this._renderHeight;
        const dw = this._displayWidth;
        const dh = this._displayHeight;

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

        // Exposure is a 1×1 value read by every output path (blit/rcas), so it
        // is allocated for all pipelines even though only the temporal path
        // computes it — the other paths bind [0] and leave its content unused.
        this._exposure = [
            this._createTexture('exposure-0', 1, 1, 'rgba16float'),
            this._createTexture('exposure-1', 1, 1, 'rgba16float'),
        ];
        // Sampled-only (no storage) so a non-storage format is fine; zero-init
        // gives a "nothing reactive" default when the caller passes no mask.
        this._reactiveDummy = this._device.createTexture({
            label: 'upscale-reactive-dummy',
            size: { width: 1, height: 1 },
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
        });

        if (this._path === 'spatial') {
            this._easuOutput = this._createTexture('easu-output', dw, dh, 'rgba16float');
        }

        if (this._path === 'temporal') {
            this._history = [
                this._createTexture('history-0', dw, dh, 'rgba16float'),
                this._createTexture('history-1', dw, dh, 'rgba16float'),
            ];
            this._locks = [
                this._createTexture('locks-0', dw, dh, 'rgba16float'),
                this._createTexture('locks-1', dw, dh, 'rgba16float'),
            ];
            this._dilatedDepth = [
                this._createTexture('dilated-depth-0', rw, rh, 'r32float'),
                this._createTexture('dilated-depth-1', rw, rh, 'r32float'),
            ];
            this._dilatedMotion = this._createTexture('dilated-motion', rw, rh, 'rgba16float');
            this._masks = this._createTexture(
                'masks',
                rw,
                rh,
                this._candidateBundle ? 'rgba16float' : 'rgba8unorm',
            );
            this._reactiveGenerated = this._createTexture('reactive-gen', rw, rh, 'rgba8unorm');
            //* Shading-change detector state (shadingChange.ts)
            this._shadingLumaHistory = [
                this._createTexture('shading-luma-0', rw, rh, 'r32float'),
                this._createTexture('shading-luma-1', rw, rh, 'r32float'),
            ];
            this._shadingSignal = this._createTexture(
                'shading-signal',
                Math.max(1, Math.ceil(rw / 2)),
                Math.max(1, Math.ceil(rh / 2)),
                'r32float',
            );

            if (this._candidateBundle) {
                this._reconstructedDepth = this._device.createBuffer({
                    label: 'upscale-reconstructed-depth-atomic',
                    size: Math.max(4, rw * rh * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
                this._inputSignals = this._createTexture('input-signals', rw, rh, 'rgba16float');
            }

            if (this._usesStructuralInputs) {
                this._preparedMasks = this._createTexture(
                    'prepared-masks',
                    rw,
                    rh,
                    'rgba16float',
                );
                this._accumulation = [
                    this._createTexture('accumulation-0', rw, rh, 'r32float'),
                    this._createTexture('accumulation-1', rw, rh, 'r32float'),
                ];
                this._newLocks = this._device.createBuffer({
                    label: 'upscale-new-locks-atomic',
                    size: Math.max(4, dw * dh * Uint32Array.BYTES_PER_ELEMENT),
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                });
            }

            if (this._usesSourceResolver) {
                // Each successive mip uses floor(base / 2). Round the base to
                // four so odd render sizes still have room for every ceil-sized
                // direct reduction written by the single-dispatch shaders.
                const halfWidth = Math.max(4, Math.ceil(rw / 8) * 4);
                const halfHeight = Math.max(4, Math.ceil(rh / 8) * 4);
                this._lumaPyramid = this._device.createTexture({
                    label: 'upscale-luma-spd',
                    size: { width: halfWidth, height: halfHeight },
                    mipLevelCount: 3,
                    format: 'rgba16float',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
                });
                this._shadingPyramid = this._device.createTexture({
                    label: 'upscale-shading-change-spd',
                    size: { width: halfWidth, height: halfHeight },
                    mipLevelCount: 3,
                    format: 'rgba16float',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
                });
                this._shadingChange = this._createTexture(
                    'shading-change',
                    Math.max(1, Math.ceil(rw / 2)),
                    Math.max(1, Math.ceil(rh / 2)),
                    'r32float',
                );
                this._lumaHistory = [
                    this._createTexture('luma-history-0', rw, rh, 'rgba16float'),
                    this._createTexture('luma-history-1', rw, rh, 'rgba16float'),
                ];
                this._lumaInstability = this._createTexture(
                    'luma-instability',
                    rw,
                    rh,
                    'r32float',
                );
            }
        }
    }

    private _destroyTextures(): void {
        this._output?.dispose();
        this._output = null;
        this._outputGPU = null;
        this._easuOutput?.destroy();
        this._easuOutput = null;
        if (this._history) {
            this._history.forEach((t) => t.destroy());
            this._history = null;
        }
        if (this._locks) {
            this._locks.forEach((t) => t.destroy());
            this._locks = null;
        }
        if (this._dilatedDepth) {
            this._dilatedDepth.forEach((t) => t.destroy());
            this._dilatedDepth = null;
        }
        this._dilatedMotion?.destroy();
        this._dilatedMotion = null;
        this._masks?.destroy();
        this._masks = null;
        if (this._exposure) {
            this._exposure.forEach((t) => t.destroy());
            this._exposure = null;
        }
        this._reactiveDummy?.destroy();
        this._reactiveDummy = null;
        this._reactiveGenerated?.destroy();
        this._reactiveGenerated = null;
        this._reconstructedDepth?.destroy();
        this._reconstructedDepth = null;
        this._inputSignals?.destroy();
        this._inputSignals = null;
        this._preparedMasks?.destroy();
        this._preparedMasks = null;
        if (this._accumulation) {
            this._accumulation.forEach((texture) => texture.destroy());
            this._accumulation = null;
        }
        this._newLocks?.destroy();
        this._newLocks = null;
        this._lumaPyramid?.destroy();
        this._lumaPyramid = null;
        this._shadingPyramid?.destroy();
        this._shadingPyramid = null;
        this._shadingChange?.destroy();
        this._shadingChange = null;
        if (this._lumaHistory) {
            this._lumaHistory.forEach((texture) => texture.destroy());
            this._lumaHistory = null;
        }
        this._lumaInstability?.destroy();
        this._lumaInstability = null;
        if (this._shadingLumaHistory) {
            this._shadingLumaHistory.forEach((texture) => texture.destroy());
            this._shadingLumaHistory = null;
        }
        this._shadingSignal?.destroy();
        this._shadingSignal = null;
    }
}
