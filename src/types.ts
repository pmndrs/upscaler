import type { Texture } from 'three';

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
export enum FSRQualityMode {
    NativeAA = 'native-aa',
    Quality = 'quality',
    Balanced = 'balanced',
    Performance = 'performance',
    UltraPerformance = 'ultra-performance',
}

/**
 * Which upscaling path the pipeline runs.
 *
 * - `bilinear` — plain bilinear sample + display transform. The naive
 *   baseline every other mode is compared against (and, at ratio 1, the
 *   "native" passthrough mode).
 * - `spatial` — single-frame FSR1 (EASU + RCAS). No history, no motion
 *   vectors required. Phase 1 baseline.
 * - `temporal` — FSR2/3-style jittered temporal accumulation. Requires depth
 *   and motion vectors. Phase 2.
 */
export type FSRUpscalePath = 'bilinear' | 'spatial' | 'temporal';

/**
 * Debug visualization modes rendered by the debug pass instead of the final
 * image. Useful for validating pipeline inputs while integrating.
 */
export enum FSRDebugView {
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
 * Static configuration for {@link FSR3Upscaler.configure}.
 */
export interface FSRConfig {
    /** Output (display) resolution in physical pixels. */
    displayWidth: number;
    /** Output (display) resolution in physical pixels. */
    displayHeight: number;
    /**
     * Quality preset controlling the render resolution. Ignored when
     * `customUpscaleRatio` is provided.
     */
    qualityMode?: FSRQualityMode;
    /** Explicit upscale ratio (e.g. `1.5` renders at 1/1.5 of display size). */
    customUpscaleRatio?: number;
    /** Which upscaling pipeline to run. Defaults to `'temporal'`. */
    path?: FSRUpscalePath;
}

/**
 * Per-frame inputs consumed by {@link FSR3Upscaler.dispatch}. All textures
 * are three textures (render-target attachments) — the upscaler resolves
 * the raw GPU handles internally.
 */
export interface FSRDispatchInputs {
    /** Scene color at render resolution (linear HDR, rgba16float). */
    color: Texture;
    /** Scene depth at render resolution. Required for the temporal path. */
    depth?: Texture;
    /**
     * Screen-space motion vectors at render resolution (NDC delta,
     * current − previous, as produced by three's `velocity` node).
     * Required for the temporal path.
     */
    velocity?: Texture;
    /**
     * Optional reactive mask at render resolution — the red channel in `[0, 1]`
     * flags pixels whose current-frame color should dominate over history
     * (additive particles, transparent/animated surfaces that have no reliable
     * depth or motion and would otherwise ghost). Higher = more reactive. Author
     * it yourself (render your transparents' coverage) or via a future helper.
     */
    reactive?: Texture;
    /** Drop all history this frame (camera cut, teleport, resize). */
    reset?: boolean;
    /** Seconds since the previous frame. */
    deltaTime?: number;
}

/**
 * Runtime tuning knobs that can change every frame without a pipeline rebuild.
 */
export interface FSRRuntimeSettings {
    /**
     * RCAS sharpening amount in `[0, 1]`. `1` is maximum sharpness (0 stops
     * of attenuation in FidelityFX terms), `0` disables sharpening.
     */
    sharpness: number;
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
    debugView: FSRDebugView;
}
