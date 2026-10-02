import { WGSL_COLOR, WGSL_CONSTANTS, WGSL_DEPTH, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/*
 * EXPERIMENTAL — issue #7 research prototype, off unless a dispatch passes
 * `giFusion`. Design, measurements and the recommendation:
 * docs/research/GI-HISTORY-FUSION.md.
 */

/** Byte size of the pass-local `GiFusionParams` uniform (binding 14). */
export const GI_FUSION_PARAMS_SIZE = 32;
/** Pass-local flag: an occlusion texture is bound (else occlusion reads 1). */
export const GI_FUSION_FLAG_OCCLUSION = 1;
/** Pass-local flag: drop the GI history this frame (first fused frame). */
export const GI_FUSION_FLAG_RESET = 2;
/** Pass-local flag: accumulate in invertible-tonemap space (firefly guard). */
export const GI_FUSION_FLAG_TONEMAP = 4;
/** Pass-local flag: keep history per surface (raw-depth tag; see below). */
export const GI_FUSION_FLAG_SURFACE = 8;
/** Pass-local flag: size the anti-lag box by the fast mean's standard error. */
export const GI_FUSION_FLAG_STDERR_BOX = 16;
/** Pass-local flag: 3×3 block-mean anti-lag correction before the clamp. */
export const GI_FUSION_FLAG_BLOCK_ANTILAG = 32;

/**
 * GI history fusion — accumulates a noisy, pre-albedo GI signal (e.g. SSGI
 * irradiance + AO) in its own render-resolution history, driven by the
 * upscaler's own guides, and composites `base·occlusion + albedo·GI` into the
 * color the rest of the temporal path consumes.
 *
 * Why here and not in a second temporal node in front of the upscaler: such a
 * node reprojects the *composited* beauty, so it either rejects the jittered
 * history (noise survives) or stabilizes away the jitter the accumulate pass
 * integrates (aliasing returns). This pass integrates only the demodulated
 * illumination — smooth on any one surface, so a render-res history blurs
 * nothing that matters — while albedo and direct light reach the accumulate
 * pass with their per-phase jitter intact (the SVGF-then-TAA split). It
 * reprojects with our dilated motion and drops history on our disocclusion,
 * so it agrees with accumulate about what survives.
 *
 * The one place demodulation is NOT smooth is a sub-texel feature: as the
 * jitter moves, a render pixel alternates between a wire and the wall behind
 * it, and a plain history averages their GI — the wire then wears the wall's
 * bounce light (measured: a wire-mask bias the raw path does not have). With
 * GI_FLAG_SURFACE the history is tagged with the raw (jittered, undilated)
 * view depth it was built on; a sample from a different surface neither
 * updates nor reads it — the pixel keeps the background's history for the
 * phases the background shows, and the foreground sample is shaded from its
 * own same-surface spatial neighborhood instead (preferring neighbors'
 * histories that carry its tag).
 *
 * Per render pixel:
 * 1. Raw-depth-weighted 3×3 spatial statistics of the signal.
 * 2. Reproject the GI history + moments + surface tag; disocclusion zeroes
 *    the length; a sample from another surface stops here (above).
 * 3. SVGF moments: fast E[luma], E[luma²] (blend floor `momentsAlpha`).
 * 4. Anti-lag (ReLAX-style), centered on the fast mean, never on one jitter
 *    phase's 3×3 — so a converged history sits inside the box and is not
 *    re-snapped per phase (convergence rule 2), and nothing ages the length
 *    by clamp magnitude (convergence rule 1). Two stages: a 3×3 block-mean
 *    rescale (coherent lighting changes), then the per-pixel clamp. Both
 *    boxes are `clampGamma` standard errors of the fast mean, from this
 *    frame's spatial σ (a temporal σ is inflated by the step it should
 *    catch — measured: ~2× the lag).
 * 5. Blend at 1/length (floor 1/maxHistory); while the history is short the
 *    output leans on the spatial mean instead (ReBLUR's "history fix").
 *
 * Bindings:
 * - 1: GI signal, render size (rgb = irradiance, linear, pre-albedo)
 * - 2: occlusion, render size (r; any texture when the flag is off)
 * - 3: base color, render size (everything not modulated by the GI signal)
 * - 4: albedo, render size (rgb)
 * - 5: dilated motion, render size (UV delta in .xy)
 * - 6: masks, render size (r = disocclusion)
 * - 7: scene depth, render size (depth texture; jittered, undilated)
 * - 8: GI history in (rgba16float; rgb = slow GI, a = slow occlusion)
 * - 9: GI moments in (rgba16float; r = E[luma], g = E[luma²], b = fast
 *      occlusion, a = history length in frames)
 * - 10: linear clamp sampler
 * - 11: GI history out (rgba16float storage)
 * - 12: GI moments out (rgba16float storage)
 * - 13: composite out (rgba16float storage; the color accumulate consumes)
 * - 14: pass-local parameters (uniform)
 * - 15: GI surface tag in (r32float; linear view depth the history belongs to)
 * - 16: GI surface tag out (r32float storage)
 */
export const GI_FUSION_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    WGSL_TONEMAP,
    WGSL_DEPTH,
    /* wgsl */ `
struct GiFusionParams {
    maxHistory       : f32,  // offset  0 — longest GI history, frames
    momentsAlpha     : f32,  // offset  4 — floor of the fast/moments blend weight (SVGF's α)
    clampGamma       : f32,  // offset  8 — anti-lag box half-width, in standard errors
    shortHistory     : f32,  // offset 12 — length at which the spatial fallback is fully off
    depthSigma       : f32,  // offset 16 — relative depth tolerance of the spatial weights
    flags            : u32,  // offset 20 — GI_FLAG_* bits
    surfaceTolerance : f32,  // offset 24 — relative depth gap that reads as another surface
    _pad0            : u32,  // offset 28
}

@group(0) @binding(1) var giSignal : texture_2d<f32>;
@group(0) @binding(2) var occlusionSignal : texture_2d<f32>;
@group(0) @binding(3) var baseColor : texture_2d<f32>;
@group(0) @binding(4) var albedoTex : texture_2d<f32>;
@group(0) @binding(5) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(6) var masks : texture_2d<f32>;
@group(0) @binding(7) var sceneDepth : texture_depth_2d;
@group(0) @binding(8) var giHistoryIn : texture_2d<f32>;
@group(0) @binding(9) var giMomentsIn : texture_2d<f32>;
@group(0) @binding(10) var linearSampler : sampler;
@group(0) @binding(11) var giHistoryOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var giMomentsOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(13) var compositeOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(14) var<uniform> P : GiFusionParams;
@group(0) @binding(15) var giSurfaceIn : texture_2d<f32>;
@group(0) @binding(16) var giSurfaceOut : texture_storage_2d<r32float, write>;

// Pass-local, deliberately not in the shared constants chunk (adding to it
// re-fingerprints every shader).
const GI_FLAG_OCCLUSION : u32 = 1u;
const GI_FLAG_RESET : u32 = 2u;
const GI_FLAG_TONEMAP : u32 = 4u;
const GI_FLAG_SURFACE : u32 = 8u;
const GI_FLAG_STDERR_BOX : u32 = 16u;
const GI_FLAG_BLOCK_ANTILAG : u32 = 32u;
const LUMA_EPS : f32 = 1.0e-4;

fn hasGiFlag(bit : u32) -> bool { return (P.flags & bit) != 0u; }

// With GI_FLAG_TONEMAP the whole history lives in FSR2's invertible-tonemap
// space (as accumulate's does) so a rare bright sample cannot dominate the
// running mean; the composite inverts it once.
fn loadSignal(c : vec2i) -> vec3f {
    let s = max(textureLoad(giSignal, c, 0).rgb, vec3f(0.0));
    if (hasGiFlag(GI_FLAG_TONEMAP)) { return tonemapInvertible(s); }
    return s;
}

fn decodeSignal(s : vec3f) -> vec3f {
    if (hasGiFlag(GI_FLAG_TONEMAP)) { return tonemapInvert(s); }
    return s;
}

fn loadOcclusion(c : vec2i) -> f32 {
    if (!hasGiFlag(GI_FLAG_OCCLUSION)) { return 1.0; }
    return clamp(textureLoad(occlusionSignal, c, 0).r, 0.0, 1.0);
}

fn viewDepth(c : vec2i) -> f32 {
    return linearizeDepth(textureLoad(sceneDepth, c, 0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }

    let coord = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;
    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;

    //* Current Signal + Same-Surface 3×3 Statistics
    // Weighted by the raw (undilated) depth so a wire's GI does not average
    // with the wall behind it. The center weight is exp(0) = 1, so the weight
    // sum never reaches 0.
    let centerDepth = viewDepth(coord);
    let depthTolerance = max(P.depthSigma * centerDepth, 1.0e-4);
    let current = loadSignal(coord);
    let currentOcclusion = loadOcclusion(coord);
    var giSum = vec3f(0.0);
    var occlusionSum = 0.0;
    var occlusionSq = 0.0;
    var lumaSum = 0.0;
    var lumaSq = 0.0;
    var weightSum = 0.0;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let c = clamp(coord + vec2i(x, y), vec2i(0), maxCoord);
            let w = exp(-abs(viewDepth(c) - centerDepth) / depthTolerance);
            let s = loadSignal(c);
            let o = loadOcclusion(c);
            let l = luma(s);
            giSum += s * w;
            occlusionSum += o * w;
            occlusionSq += o * o * w;
            lumaSum += l * w;
            lumaSq += l * l * w;
            weightSum += w;
        }
    }
    let spatialGi = giSum / weightSum;
    let spatialOcclusion = occlusionSum / weightSum;
    let spatialLuma = lumaSum / weightSum;
    let spatialVariance = max(lumaSq / weightSum - spatialLuma * spatialLuma, 0.0);
    let occlusionSigma = sqrt(max(occlusionSq / weightSum - spatialOcclusion * spatialOcclusion, 0.0));
    let base = textureLoad(baseColor, coord, 0);
    let albedo = textureLoad(albedoTex, coord, 0).rgb;

    //* Reprojection — the upscaler's own dilated motion and disocclusion
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    let disocclusion = textureLoad(masks, coord, 0).r;
    let prevUV = uv - motion;
    let offscreen = any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0));
    let reset = hasFlag(FLAG_RESET) || hasGiFlag(GI_FLAG_RESET) || offscreen;
    var history = vec4f(current, currentOcclusion);
    var moments = vec4f(0.0);
    var historyDepth = centerDepth;
    if (!reset) {
        history = textureSampleLevel(giHistoryIn, linearSampler, prevUV, 0.0);
        moments = textureSampleLevel(giMomentsIn, linearSampler, prevUV, 0.0);
        // r32float is not filterable — the tag is the nearest texel's.
        let tagCoord = clamp(vec2i(prevUV * C.renderSize), vec2i(0), maxCoord);
        historyDepth = textureLoad(giSurfaceIn, tagCoord, 0).r;
    }

    //* Surface Tag — a sample from another surface leaves the history alone
    let otherSurface = hasGiFlag(GI_FLAG_SURFACE) && !reset && moments.a > 0.0 &&
        abs(centerDepth - historyDepth) > P.surfaceTolerance * min(centerDepth, historyDepth);
    if (otherSurface) {
        // Carry the reprojected history, moments and tag forward unchanged —
        // no aging: the background's history must survive every phase the
        // foreground covers it.
        textureStore(giHistoryOut, coord, history);
        textureStore(giMomentsOut, coord, moments);
        textureStore(giSurfaceOut, coord, vec4f(historyDepth, 0.0, 0.0, 0.0));
        // Shade this sample from its own surface: the reprojected histories of
        // neighbors tagged with this depth (a wire's history lives on the
        // pixels the wire covers most phases), weighted by their length, and
        // the same-surface spatial mean of this frame for whatever they lack.
        let tagCenter = clamp(vec2i(prevUV * C.renderSize), vec2i(0), maxCoord);
        var neighborGi = vec4f(0.0);
        var neighborLength = 0.0;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let c = clamp(tagCenter + vec2i(x, y), vec2i(0), maxCoord);
                let tag = textureLoad(giSurfaceIn, c, 0).r;
                if (abs(tag - centerDepth) <= P.surfaceTolerance * min(tag, centerDepth)) {
                    let w = textureLoad(giMomentsIn, c, 0).a;
                    neighborGi += textureLoad(giHistoryIn, c, 0) * w;
                    neighborLength += w;
                }
            }
        }
        let neighborTrust = smoothstep(1.0, P.shortHistory, neighborLength);
        let foreground = mix(
            vec4f(spatialGi, spatialOcclusion),
            neighborGi / max(neighborLength, 1.0e-4),
            neighborTrust,
        );
        let gi = decodeSignal(foreground.rgb);
        textureStore(compositeOut, coord, vec4f(base.rgb * foreground.a + albedo * gi, base.a));
        return;
    }

    // Disocclusion shortens the history (the value itself is replaced by the
    // 1/length blend below), exactly as accumulate drops its sample count.
    let previousLength = select(moments.a * (1.0 - disocclusion), 0.0, reset);
    let historyLength = min(previousLength + 1.0, P.maxHistory);

    //* SVGF Moments
    let currentLuma = luma(current);
    let fastAlpha = max(1.0 / historyLength, P.momentsAlpha);
    let m1 = mix(moments.r, currentLuma, fastAlpha);
    let m2 = mix(moments.g, currentLuma * currentLuma, fastAlpha);
    let fastOcclusion = mix(moments.b, currentOcclusion, fastAlpha);
    // Temporal variance once there is history to estimate it from; the
    // spatial estimate stands in while the history is short (SVGF §4.2).
    let trust = smoothstep(1.0, P.shortHistory, historyLength);
    var sigma = sqrt(mix(spatialVariance, max(m2 - m1 * m1, 0.0), trust));
    var occlusionSpread = max(occlusionSigma, 0.02);
    // GI_FLAG_STDERR_BOX: the temporal σ above is inflated by the very step it
    // should catch (the fast window straddles old and new lighting), so a
    // light change hides inside its own box. Instead take this frame's
    // spatial σ — blind to temporal steps — scaled to the standard error of
    // an EMA with weight α, sqrt(α/(2−α)): the box then asks "has the fast
    // mean moved further than its own noise explains?". A converged slow
    // history sits ~1 standard error from the fast mean, so γ ≈ 3 keeps
    // still scenes unclamped (convergence rule 2).
    if (hasGiFlag(GI_FLAG_STDERR_BOX)) {
        let standardError = sqrt(fastAlpha / (2.0 - fastAlpha));
        sigma = sqrt(spatialVariance) * standardError;
        occlusionSpread = max(occlusionSigma * standardError, 0.01);
    }

    //* Block Anti-Lag (GI_FLAG_BLOCK_ANTILAG)
    // Per pixel, a noisy signal cannot tell a lighting change from its own
    // noise within a few frames: the fast mean's error bar is as wide as the
    // step. Lighting changes are spatially coherent, though, so compare the
    // 3×3 block means of the slow and fast histories — nine pixels' fast
    // means shrink the error bar by 3 — and when the block's slow mean sits
    // outside it, rescale this pixel's slow history by the block ratio
    // (a regional DeltaPreExposure). The same block-mean idea as the
    // shading-change detector, applied as a correction instead of aging.
    if (hasGiFlag(GI_FLAG_BLOCK_ANTILAG) && trust > 0.0) {
        var blockSlow = 0.0;
        var blockFast = 0.0;
        for (var y = -1; y <= 1; y++) {
            for (var x = -1; x <= 1; x++) {
                let tapUV = prevUV + vec2f(f32(x), f32(y)) * C.renderSizeInv;
                blockSlow += luma(textureSampleLevel(giHistoryIn, linearSampler, tapUV, 0.0).rgb);
                blockFast += textureSampleLevel(giMomentsIn, linearSampler, tapUV, 0.0).r;
            }
        }
        blockSlow /= 9.0;
        // Fold this frame in, as each tap's own update will.
        blockFast = mix(blockFast / 9.0, spatialLuma, fastAlpha);
        let blockBox = P.clampGamma * sqrt(spatialVariance) * sqrt(fastAlpha / (2.0 - fastAlpha)) / 3.0;
        let blockTarget = clamp(blockSlow, max(blockFast - blockBox, 0.0), blockFast + blockBox);
        if (blockSlow > LUMA_EPS && abs(blockTarget - blockSlow) > 0.0) {
            history = vec4f(history.rgb * (blockTarget / blockSlow), history.a);
        }
    }

    //* Anti-Lag Clamp (fast mean ± γσ)
    let slowLuma = luma(history.rgb);
    let clampedLuma = clamp(slowLuma, max(m1 - P.clampGamma * sigma, 0.0), m1 + P.clampGamma * sigma);
    // Rescale rather than replace so the history keeps its chroma; a black
    // history borrows the current sample's chroma instead.
    var slow = history.rgb * (clampedLuma / max(slowLuma, LUMA_EPS));
    if (slowLuma < LUMA_EPS) {
        slow = select(vec3f(clampedLuma), current * (clampedLuma / currentLuma), currentLuma > LUMA_EPS);
    }
    let occlusionBox = P.clampGamma * occlusionSpread;
    let slowOcclusion = clamp(history.a, fastOcclusion - occlusionBox, fastOcclusion + occlusionBox);

    //* Blend
    let slowAlpha = max(1.0 / historyLength, 1.0 / P.maxHistory);
    let resolvedGi = mix(slow, current, slowAlpha);
    let resolvedOcclusion = mix(slowOcclusion, currentOcclusion, slowAlpha);
    textureStore(giHistoryOut, coord, vec4f(resolvedGi, resolvedOcclusion));
    textureStore(giMomentsOut, coord, vec4f(m1, m2, fastOcclusion, historyLength));
    textureStore(giSurfaceOut, coord, vec4f(centerDepth, 0.0, 0.0, 0.0));

    //* Composite — short histories lean on the spatial mean (history fix)
    let outGi = decodeSignal(mix(spatialGi, resolvedGi, trust));
    let outOcclusion = mix(spatialOcclusion, resolvedOcclusion, trust);
    textureStore(compositeOut, coord, vec4f(base.rgb * outOcclusion + albedo * outGi, base.a));
}
`,
);
