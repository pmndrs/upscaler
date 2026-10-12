/**
 * Public option/enum types for the FSR3 upscaler.
 *
 * Terminology follows the FidelityFX SDK where possible:
 * - "render resolution" — the (lower) resolution the scene is rasterized at
 * - "display resolution" — the (higher) resolution presented to the user
 * - "upscale ratio" — displaySize / renderSize per axis (uniform in practice)
 */

/**
 * Quality presets matching the official FSR3 scaling ratios.
 *
 * `NativeAA` renders at display resolution and uses the temporal pipeline
 * purely as an anti-aliasing solution (equivalent to AMD's "Native AA" mode).
 */
export enum QualityMode {
    NativeAA = 'native-aa',
    Quality = 'quality',
    Balanced = 'balanced',
    Performance = 'performance',
    UltraPerformance = 'ultra-performance',
}

/**
 * Which upscaling path the pipeline runs.
 *
 * - `bilinear` — plain bilinear sample in the caller's color domain. The naive
 *   baseline every other mode is compared against (and, at ratio 1, the
 *   "native" passthrough mode).
 * - `spatial` — single-frame FSR1 (EASU + RCAS). No history, no motion
 *   vectors required.
 * - `temporal` — FSR2/3-style jittered temporal accumulation. Requires depth
 *   and motion vectors.
 * - `guides` — the temporal path's geometry front-end only (dilated
 *   depth/motion + disocclusion via `UpscalerCore.encodeGuides`), for
 *   apps that consume guides without upscaling. No color input or output;
 *   the adapter retains the depth history required for disocclusion.
 */
export type UpscalePath = 'bilinear' | 'spatial' | 'temporal' | 'guides';

/**
 * A sub-pixel jitter offset in render pixels, each axis in `[-0.5, 0.5]`.
 * x points right and y points down (texel coordinates, top-left origin): the
 * sample for render texel `(i, j)` sits at `(i + 0.5 + x, j + 0.5 + y)` in the
 * unjittered image's pixel coordinates. Used by FrameData and engine adapters.
 */
export interface JitterOffset {
    readonly x: number;
    readonly y: number;
}

/**
 * Debug visualization modes rendered by the debug pass instead of the final
 * image. Useful for validating pipeline inputs while integrating.
 */
export enum DebugView {
    /** Normal output — no debug visualization. */
    None = 0,
    /** Dilated motion vectors, magnitude/direction encoded as color. */
    MotionVectors = 1,
    /** Depth-clip disocclusion mask (white = history rejected). */
    Disocclusion = 2,
    /** Linearized dilated depth. */
    Depth = 3,
    /** History accumulation age (white = fully converged history). */
    AccumulationAge = 4,
    /** Luminance-stability locks (white = a locked thin feature). */
    Locks = 5,
    /** Auto-exposed scene luminance (should sit near mid-grey everywhere). */
    Exposure = 6,
    /** Shading-change factor (white = history aged because shading changed). */
    ShadingChange = 7,
    /** Reactive mask (white = pixel flagged reactive, favouring the current frame). */
    Reactivity = 8,
}

/**
 * Runtime tuning knobs that can change every frame without a pipeline rebuild.
 */
export interface RuntimeSettings {
    /**
     * RCAS sharpening amount in `[0, 1]`. `1` is maximum sharpness (0 stops
     * of attenuation in FidelityFX terms), `0` disables sharpening.
     */
    sharpness: number;
    /**
     * Enable RCAS's denoise variant (FSR1 `FSR_RCAS_DENOISE`): attenuate
     * sharpening on lone luma outliers so grain from noisy inputs (reduced-res
     * SSR/GI, raw path tracing) isn't amplified. Off by default — turn it on
     * only for noisy sources; it slightly softens fine detail. Pairs with a
     * spatial denoiser upstream.
     */
    rcasDenoise: boolean;
    /**
     * Maximum number of accumulated frames in the temporal history. Higher
     * values are more stable but ghost longer. FSR3 uses ~32 internally.
     */
    maxAccumulation: number;
    /**
     * Pre-exposure applied before the invertible tonemap. Used directly when
     * {@link autoExposure} is off; ignored when it is on (the value is computed
     * from scene luminance each frame). Divided back out before display either
     * way, so it conditions accumulation without changing final brightness.
     */
    exposure: number;
    /**
     * Compute the pre-exposure from the scene's average luminance each frame
     * (with eye-adaptation), instead of using the fixed {@link exposure}. Keeps
     * the invertible-tonemap accumulation well-conditioned across HDR scenes of
     * very different brightness. On by default.
     */
    autoExposure: boolean;
    /**
     * Protect stable thin sub-pixel features (wires, fence pickets, foliage)
     * from history rectification via luminance-stability locks. Reduces the
     * dimming/shimmer such features otherwise show under motion. On by default.
     */
    lockThinFeatures: boolean;
    /**
     * Detect genuine shading changes (a light turning on, an animated material)
     * versus mere motion, and age the history there so the changed surface
     * re-converges quickly instead of ghosting its old shading. Measured on
     * averaged luminance so sub-pixel aliasing doesn't trip it. On by default.
     */
    detectShadingChanges: boolean;
    /** Debug visualization mode. */
    debugView: DebugView;
}

/** Configuration applied only between frames. */
export interface CoreConfiguration {
    /** Positive integer input width in pixels. */
    renderWidth: number;
    /** Positive integer input height in pixels. */
    renderHeight: number;
    /** Positive integer output width in pixels. */
    displayWidth: number;
    /** Positive integer output height in pixels. */
    displayHeight: number;
    /** Processing path; defaults to temporal. */
    path?: UpscalePath;
    /** Hardware depth by default, or positive linear R32F with a finite positive background. */
    depthMode?: 'hardware' | 'linear';
    /** Upstream metering by default; provided publishes CPU or GPU exposure without metering. */
    exposureMode?: 'upstream' | 'provided';
    /** Correct history for conditioning-exposure changes; disabled by default. */
    correctConditioningExposure?: boolean;
    /** Temporal RCAS age knee in [0, 1]; zero preserves the upstream lobe. Requires preparation/reset. */
    rcasAgeKnee?: number;
}

/** Caller-owned texture and resolved view used for resource validation and bindings. */
export interface TextureResource {
    texture: GPUTexture;
    /** A single-mip storage view, or a depth-only view for combined depth/stencil. */
    view: GPUTextureView;
}
/** Previous/current allocations; the caller advances history after submitting a frame. */
export interface TextureHistory { read: TextureResource; write: TextureResource }
/** Names of allocations described by getResourceDescriptors(), excluding host inputs. */
export type ResourceName = 'output' | 'exposure' | 'dummy' | 'easuOutput' | 'dilatedDepth' |
    'dilatedMotion' | 'masks' | 'history' | 'locks' | 'reactiveGenerated' | 'shadingLumaHistory' |
    'shadingSignal' | 'shadingBlockMemory';
/** Resolved host inputs and configured working textures; ownership remains with the host. */
export type CoreResources = Partial<Record<ResourceName, TextureResource | TextureHistory>> & {
    color?: TextureResource;
    depth?: TextureResource;
    velocity?: TextureResource;
    reactive?: TextureResource;
    reactiveOpaqueColor?: TextureResource;
    exposureTexture?: TextureResource;
    preExposureTexture?: TextureResource;
    /** Previous dilated depth published to guides consumers (not used by production reconstruction). */
    previousDepth?: TextureResource;
};
/** Per-frame geometry, exposure and settings; geometry stays fixed across split phases. */
export interface FrameData {
    /** Host frame index; identical across both phases of a split frame. */
    frameIndex: number;
    /** Current projection jitter in render pixels; defaults to zero. */
    jitter?: JitterOffset;
    /** Previous projection jitter in render pixels; defaults to zero. */
    jitterPrevious?: JitterOffset;
    /** Per-axis conversion from input velocity to UV delta; defaults to (0.5, -0.5). */
    motionScale?: JitterOffset;
    /** Camera near plane for hardware-depth decoding; defaults to 0.1. */
    near?: number;
    /** Camera far plane for hardware-depth decoding; defaults to 1000. */
    far?: number;
    /** Enable perspective hardware-depth decoding; false selects orthographic. */
    perspective?: boolean;
    /** Hardware reversed-depth convention; ignored for positive linear depth. */
    reversedDepth?: boolean;
    /** Elapsed time in seconds; defaults to 1/60. */
    deltaTime?: number;
    /** Request history invalidation; must stay identical across split phases. */
    reset?: boolean;
    /** Host exposure baked into input color; default 1, preserved at output. */
    hostPreExposure?: number;
    /** Current runtime overrides merged with DEFAULT_SETTINGS. */
    settings?: Partial<RuntimeSettings>;
    /** Bench-only current-view to previous-view reprojection constants. */
    reprojection?: Float32Array;
}
/** Pure allocation requirement, including usage flags, initialization and history policy. */
export interface ResourceDescriptor {
    name: ResourceName;
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    history: boolean;
    sampling: 'linear' | 'load';
    initialization: 'zero';
}

/** Neutral upstream runtime settings used when a frame does not override individual fields. */
export const DEFAULT_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
    sharpness: 0.8, rcasDenoise: false, maxAccumulation: 24, exposure: 1,
    autoExposure: true, lockThinFeatures: true, detectShadingChanges: true, debugView: DebugView.None,
});
