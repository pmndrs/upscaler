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
 * - `bilinear` — plain bilinear sample + display transform. The naive
 *   baseline every other mode is compared against (and, at ratio 1, the
 *   "native" passthrough mode).
 * - `spatial` — single-frame FSR1 (EASU + RCAS). No history, no motion
 *   vectors required. Phase 1 baseline.
 * - `temporal` — FSR2/3-style jittered temporal accumulation. Requires depth
 *   and motion vectors. Phase 2.
 */
export type UpscalePath = 'bilinear' | 'spatial' | 'temporal';

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
 * Static configuration for {@link Upscaler.configure}.
 */
export interface UpscalerConfig {
    /** Output (display) resolution in physical pixels. */
    displayWidth: number;
    /** Output (display) resolution in physical pixels. */
    displayHeight: number;
    /**
     * Quality preset controlling the render resolution. Ignored when
     * `customUpscaleRatio` is provided.
     */
    qualityMode?: QualityMode;
    /** Explicit upscale ratio (e.g. `1.5` renders at 1/1.5 of display size). */
    customUpscaleRatio?: number;
    /**
     * Explicit render (input) resolution. Overrides {@link customUpscaleRatio} /
     * {@link qualityMode} — use when the input is produced by an external pass
     * whose size you don't control (the TSL node feeding a reduced-res effect
     * graph). Must be set together with {@link renderHeight}.
     */
    renderWidth?: number;
    /** Explicit render (input) height — see {@link renderWidth}. */
    renderHeight?: number;
    /** Which upscaling pipeline to run. Defaults to `'temporal'`. */
    path?: UpscalePath;
    /**
     * Apply the sub-pixel camera jitter each frame (temporal path only).
     * Defaults to `true`.
     *
     * Jitter is what lets the temporal path *reconstruct* detail beyond the
     * render resolution: each frame samples a slightly different sub-pixel grid,
     * and accumulation resolves them into a higher-res image. **But it only works
     * if the input is re-rendered under the jittered projection every frame.** If
     * you feed the upscaler a buffer whose rendering you don't control under the
     * jitter (an effect texture from an external pipeline, a pre-rendered target,
     * anything composited outside the jitter window), the color won't reflect the
     * offset while reprojection assumes it does — so history lands on the wrong
     * texels and the image smears.
     *
     * Set `false` for those inputs: the temporal path still reprojects, clips,
     * and accumulates (so it denoises noisy GI and holds temporal stability, and
     * upscales), it just skips the sub-pixel offset — no reconstruction gain, no
     * smear risk. Owning-the-render integrations (the `upscaleScene` node, `UpscalePass`)
     * default it on; the composable `upscale` node defaults it off for exactly this
     * reason.
     */
    jitter?: boolean;
}

/**
 * Per-frame inputs consumed by {@link Upscaler.dispatch}. All textures
 * are three textures (render-target attachments) — the upscaler resolves
 * the raw GPU handles internally.
 */
export interface DispatchInputs {
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
    /**
     * Optional Transparency & Composition mask at render resolution. This is
     * intentionally softer than {@link reactive}: it tightens history
     * rectification and reduces lock/history confidence without forcing the
     * aggressive current-frame reset used for particles and untracked transparents.
     * Consumed by source-style structural resolver candidates; ignored by the
     * production fallback.
     */
    transparencyAndComposition?: Texture;
    /**
     * Opaque-only scene color at render resolution. When provided (and no
     * explicit {@link reactive} mask is given), the upscaler auto-generates the
     * reactive mask from the difference between this and the final `color` —
     * FSR2's `GenerateReactiveMask`. Render your scene once with transparents
     * hidden into this buffer; `color` stays the full composited render.
     */
    reactiveOpaqueColor?: Texture;
    /**
     * Optional app-supplied **exposure** texture (value in the red texel, any
     * float format — a 1×1 is typical). When provided it overrides both
     * auto-exposure and the fixed {@link RuntimeSettings.exposure}: a pipeline
     * that already meters exposure (its own luminance/adaptation pass) feeds
     * the result here and the upscaler conditions accumulation on it instead of
     * computing its own. Divided back out before display, so — like the other
     * exposure modes — it steadies accumulation without changing final
     * brightness. Mirrors FSR3's `exposure` dispatch resource.
     */
    exposureTexture?: Texture;
    /**
     * Optional host pre-exposure texture (red texel, typically 1×1): the
     * exposure factor the app has already baked into this frame's input color.
     * Unlike {@link exposureTexture}, this factor is part of the caller's
     * color domain and is therefore preserved at output. The temporal path
     * tracks its previous/current ratio and corrects reprojected history
     * across a change (FSR3's `DeltaPreExposure`), so stepping or ramping the
     * host exposure does not read as a full-screen shading change. Omission is
     * equivalent to `1`.
     */
    preExposureTexture?: Texture;
    /** Drop all history this frame (camera cut, teleport, resize). */
    reset?: boolean;
    /** Seconds since the previous frame. */
    deltaTime?: number;
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
