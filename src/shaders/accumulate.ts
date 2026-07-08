import { WGSL_COLOR, WGSL_CONSTANTS, WGSL_TONEMAP } from './common';
import { assembleShader } from './wgsl';

/**
 * Reproject & accumulate — the core temporal upscaling pass (FSR2/3's
 * "accumulate" stage, simplified: luminance-stability locks and the
 * shading-change detector are Phase 3 work; see shaders README).
 *
 * Per display pixel:
 * 1. Upsample the current jittered frame with a jitter-aware separable
 *    Lanczos2 kernel over the 3×3 render-texel footprint. Because the
 *    jitter moves the sample grid every frame, integrating these kernels
 *    over time converges to a super-sampled image.
 * 2. Reproject last frame's history through the dilated motion vector with
 *    a Catmull-Rom filter (sharper than bilinear, avoids history blur).
 * 3. Rein in stale history: clip it to the YCoCg variance AABB of the
 *    current neighborhood, and cut its weight by the disocclusion mask.
 * 4. Blend, tracking the accumulated sample count in the alpha channel so
 *    fresh regions converge fast while stable ones stay smooth.
 *
 * Accumulation happens in invertible-tonemap space (see `WGSL_TONEMAP`) so
 * HDR fireflies cannot dominate the running average.
 *
 * Bindings:
 * - 1: scene color, render size (linear HDR)
 * - 2: dilated motion, render size (UV delta in .xy)
 * - 3: masks, render size (r = disocclusion)
 * - 4: history in, display size (rgba16float; rgb tonemapped, a = age)
 * - 5: linear clamp sampler
 * - 6: history out (rgba16float storage, display size)
 * - 7: locks in, display size (rgba16float; r = lifetime, g = locked luma)
 * - 8: locks out (rgba16float storage, display size)
 * - 9: exposure, 1×1 (rgba16float; r = pre-exposure for this frame)
 */
export const ACCUMULATE_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    WGSL_TONEMAP,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var masks : texture_2d<f32>;
@group(0) @binding(4) var historyIn : texture_2d<f32>;
@group(0) @binding(5) var linearSampler : sampler;
@group(0) @binding(6) var historyOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var locksIn : texture_2d<f32>;
@group(0) @binding(8) var locksOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var exposureTex : texture_2d<f32>;

const PI : f32 = 3.14159265358979;
// Variance-clip gamma: how many standard deviations of the current
// neighborhood the history may stray before being clipped.
const CLIP_GAMMA : f32 = 1.0;

//* Luminance-stability lock tuning (FSR2/3's thin-feature protection).
// A "lock" marks a stable sub-pixel luminance outlier (a wire, a fence
// picket) and shields it from the variance clip that would otherwise drag its
// bright/dark history toward the darker/brighter neighborhood — the exact
// cause of thin features dimming and shimmering under motion.
const LOCK_DECAY : f32 = 0.08;         // lifetime lost per frame when no feature present
const LOCK_GROW : f32 = 0.5;           // lifetime gained per frame while a feature is present
const LOCK_CONTRAST_LO : f32 = 0.02;   // YCoCg-Y contrast to start treating a pixel as a thin feature
const LOCK_CONTRAST_HI : f32 = 0.12;
const LOCK_PEAK_LO : f32 = 0.6;        // how many neighborhood std-devs marks an outlier
const LOCK_PEAK_HI : f32 = 2.0;
const LOCK_CLAMP_RELAX : f32 = 12.0;   // how much a full lock widens the variance AABB
const LOCK_HISTORY_BOOST : f32 = 0.7;  // how much a full lock favors history in the blend

//* Shading-change detection (FSR2/3's "luminance instability").
// Distinguishes a genuine shading change (a light turning on, an animated
// material) from mere motion by comparing the reprojected history's luma to the
// current neighborhood's averaged luma — a coherent disagreement the local
// variance can't explain. Measured on averaged luma so sub-pixel aliasing on
// thin edges doesn't read as a change. Where it fires, history is aged so the
// surface re-converges to its new shading instead of ghosting the old.
const SHADING_LO : f32 = 1.5;          // luma disagreement (in neighborhood std-devs) to start reacting
const SHADING_HI : f32 = 4.0;          // ...and to treat as a full shading change
const SHADING_AGE : f32 = 0.75;        // max fraction of accumulation dropped on a full change

// Lanczos2 kernel (the same window FSR2 uses for its upsample taps).
fn lanczos2(x : f32) -> f32 {
    let ax = abs(x);
    if (ax < 1.0e-4) { return 1.0; }
    if (ax >= 2.0) { return 0.0; }
    let px = PI * ax;
    return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}

// Catmull-Rom history sampling via 5 bilinear fetches (Jimenez SIGGRAPH'16).
// Bicubic keeps reprojected history crisp where bilinear would smear it.
fn sampleHistoryCatmullRom(uv : vec2f) -> vec4f {
    let samplePos = uv * C.displaySize;
    let texPos1 = floor(samplePos - 0.5) + 0.5;
    let f = samplePos - texPos1;

    let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    let w3 = f * f * (-0.5 + 0.5 * f);
    let w12 = w1 + w2;
    let offset12 = w2 / w12;

    let texPos0 = (texPos1 - 1.0) * C.displaySizeInv;
    let texPos3 = (texPos1 + 2.0) * C.displaySizeInv;
    let texPos12 = (texPos1 + offset12) * C.displaySizeInv;

    var result =
        textureSampleLevel(historyIn, linearSampler, vec2f(texPos0.x, texPos12.y), 0.0) * (w0.x * w12.y) +
        textureSampleLevel(historyIn, linearSampler, vec2f(texPos12.x, texPos0.y), 0.0) * (w12.x * w0.y) +
        textureSampleLevel(historyIn, linearSampler, texPos12, 0.0) * (w12.x * w12.y) +
        textureSampleLevel(historyIn, linearSampler, vec2f(texPos3.x, texPos12.y), 0.0) * (w3.x * w12.y) +
        textureSampleLevel(historyIn, linearSampler, vec2f(texPos12.x, texPos3.y), 0.0) * (w12.x * w3.y);
    // Corner taps are dropped, so renormalize by the weight actually used.
    let wSum = w0.x * w12.y + w12.x * w0.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    result = result / wSum;
    return max(result, vec4f(0.0));
}

// Clips a color toward the AABB center (Playdead's variance clipping) —
// gentler than a hard clamp, no hue snapping at box corners.
fn clipToAABB(center : vec3f, extents : vec3f, color : vec3f) -> vec3f {
    let dir = color - center;
    let scale = extents / max(abs(dir), vec3f(1.0e-6));
    let t = min(1.0, min(scale.x, min(scale.y, scale.z)));
    return center + dir * t;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.displaySize)) { return; }

    let uv = (vec2f(gid.xy) + 0.5) * C.displaySizeInv;
    let renderCoord = clamp(vec2i(uv * C.renderSize), vec2i(0), vec2i(C.renderSize) - 1);
    let motion = textureLoad(dilatedMotion, renderCoord, 0).xy;
    let disocclusion = textureLoad(masks, renderCoord, 0).r;
    // Pre-exposure for this frame (auto or manual) — divided back out at output.
    let exposure = textureLoad(exposureTex, vec2i(0), 0).r;

    //* Current Frame Upsample (jitter-aware Lanczos2)
    // srcPos is the display pixel in render texel-index space, shifted by
    // the jitter so distances are measured to where samples actually landed.
    let srcPos = uv * C.renderSize - 0.5 - C.jitter;
    let baseTexel = vec2i(round(srcPos));
    let maxCoord = vec2i(C.renderSize) - 1;

    var colorSum = vec3f(0.0);
    var weightSum = 0.0;
    var m1 = vec3f(0.0); // YCoCg first moment
    var m2 = vec3f(0.0); // YCoCg second moment
    var boxMin = vec3f(1.0e5);
    var boxMax = vec3f(-1.0e5);

    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            let coord = clamp(baseTexel + vec2i(x, y), vec2i(0), maxCoord);
            let d = srcPos - vec2f(coord);
            let w = lanczos2(d.x) * lanczos2(d.y);
            let c = tonemapInvertible(textureLoad(inputColor, coord, 0).rgb * exposure);
            colorSum += c * w;
            weightSum += w;

            let ycc = rgbToYCoCg(c);
            m1 += ycc;
            m2 += ycc * ycc;
            boxMin = min(boxMin, ycc);
            boxMax = max(boxMax, ycc);
        }
    }

    // Lanczos lobes go negative — dering by clamping into the local box.
    var current = yCoCgToRgb(clamp(
        rgbToYCoCg(colorSum / max(weightSum, 1.0e-4)),
        boxMin, boxMax,
    ));

    // Confidence in the current sample: 1 when a jittered sample landed on
    // this display pixel, lower when we're interpolating between samples.
    let sampleDist = length(srcPos - vec2f(baseTexel));
    let confidence = clamp(1.0 - sampleDist, 0.25, 1.0);

    //* History Reprojection
    let prevUV = uv - motion;
    let offscreen = any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0));

    if (hasFlag(FLAG_RESET) || offscreen) {
        textureStore(historyOut, gid.xy, vec4f(current, 1.0 / C.maxAccumulation));
        textureStore(locksOut, gid.xy, vec4f(0.0));
        return;
    }

    let history = sampleHistoryCatmullRom(prevUV);
    var sampleCount = history.a * C.maxAccumulation;

    //* Neighborhood Statistics (YCoCg)
    let mean = m1 / 9.0;
    let variance = max(m2 / 9.0 - mean * mean, vec3f(0.0));
    let curY = rgbToYCoCg(current).x;
    let histY = rgbToYCoCg(history.rgb).x;
    let contrast = boxMax.x - boxMin.x;

    //* Shading-Change Detection
    // Coherent luma disagreement between reprojected history and the current
    // neighborhood, normalized by how much the neighborhood itself varies —
    // large only when the surface's shading changed rather than just moved.
    var shadingChange = 0.0;
    if (hasFlag(FLAG_SHADING_CHANGE)) {
        let lumaSpread = sqrt(variance.x) + 0.5 * contrast + 1.0e-3;
        shadingChange = smoothstep(SHADING_LO, SHADING_HI, abs(mean.x - histY) / lumaSpread);
    }

    //* Luminance-Stability Lock
    // Detect a thin feature (a luminance outlier vs the neighborhood) that is
    // temporally stable, and grow a lock on it; the lock then shields the
    // feature from rectification below. Locks reproject through motion just
    // like the color history.
    var lockLife = 0.0;
    var lockedLuma = curY;
    if (hasFlag(FLAG_LOCKS)) {
        // Thin feature = a luminance outlier vs its neighborhood with real
        // local contrast. Creation does NOT require frame-to-frame stability
        // (thin features alias under motion); instability is what breaks it.
        let peakiness = abs(curY - mean.x) / max(sqrt(variance.x), 1.0e-3);
        let featureStrength =
            smoothstep(LOCK_PEAK_LO, LOCK_PEAK_HI, peakiness) *
            smoothstep(LOCK_CONTRAST_LO, LOCK_CONTRAST_HI, contrast);

        let lockPrev = textureSampleLevel(locksIn, linearSampler, prevUV, 0.0);
        lockedLuma = select(lockPrev.g, curY, lockPrev.r < 0.05);
        // Grow the lock while a feature is present, decay it otherwise.
        lockLife = lockPrev.r + select(-LOCK_DECAY, LOCK_GROW * featureStrength, featureStrength > 0.1);
        // Break on disocclusion or a shading change measured against the lock's
        // OWN tracked luma — not the neighborhood-mean detector, which on a thin
        // bright feature always disagrees with the (background-dominated) mean
        // and would break every lock. The mean-based detector only ages
        // non-locked history below.
        let lockShading = smoothstep(max(contrast, 1.0e-3), max(contrast, 1.0e-3) * 2.0, abs(curY - lockedLuma));
        lockLife = clamp(lockLife * (1.0 - disocclusion) * (1.0 - lockShading), 0.0, 1.0);
    }

    //* History Rectification
    // Variance AABB of the current neighborhood in YCoCg; clip history into
    // it so shading changes cannot ghost. A lock widens the box so a protected
    // thin feature keeps its accumulated value instead of being pulled toward
    // the (darker/brighter) neighborhood mean.
    let extents = sqrt(variance) * CLIP_GAMMA * (1.0 + lockLife * LOCK_CLAMP_RELAX);
    let historyYcc = rgbToYCoCg(history.rgb);
    let clippedYcc = clipToAABB(mean, extents, historyYcc);
    let clipAmount = clamp(
        length(clippedYcc - historyYcc) / max(length(extents), 1.0e-4),
        0.0, 1.0,
    );
    let rectifiedHistory = yCoCgToRgb(clippedYcc);

    // Disocclusion discards history outright; heavy clipping ages it so
    // changed regions re-converge quickly instead of averaging with stale data
    // — but a lock protects its feature from that clip-driven aging.
    sampleCount *= (1.0 - disocclusion);
    sampleCount *= (1.0 - 0.5 * clipAmount * (1.0 - lockLife));
    // A detected shading change ages history so the new shading converges fast;
    // a lock protects its thin feature from this (aliasing there is not a change).
    sampleCount *= (1.0 - SHADING_AGE * shadingChange * (1.0 - lockLife));

    //* Blend — locked features lean on the accumulated history so sub-pixel
    //* detail persists under motion instead of dimming.
    let newCount = min(sampleCount + 1.0, C.maxAccumulation);
    let baseAlpha = clamp(confidence / newCount, 1.0 / C.maxAccumulation, 1.0);
    let alpha = max(baseAlpha * (1.0 - LOCK_HISTORY_BOOST * lockLife), 1.0 / (C.maxAccumulation * 2.0));
    let result = mix(rectifiedHistory, current, alpha);

    textureStore(historyOut, gid.xy, vec4f(result, newCount / C.maxAccumulation));
    // b = shading-change factor (for the debug view); a unused.
    textureStore(locksOut, gid.xy, vec4f(lockLife, lockedLuma, shadingChange, 0.0));
}
`,
);
