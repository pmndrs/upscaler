import { WGSL_COLOR, WGSL_CONSTANTS } from '@pmndrs/upscaler-core/shaders/common';
import { assembleShader } from '@pmndrs/upscaler-core/shaders/wgsl';

/** How a block's stored history of means suppresses a response. */
export type ShadingRecurrenceMode = 'range' | 'nearest' | 'ema' | 'gated';

/** Options for {@link buildShadingRecurrenceShader}. */
export interface ShadingRecurrenceOptions {
    /** `range`: inside [min, max] of the last `slots` means; `nearest`: closest single mean; `ema`: running average. */
    mode: ShadingRecurrenceMode;
    /** Block means kept per block (1–8; `ema` keeps one). */
    slots: number;
    /**
     * `gated` only: the range applies when this frame's jump from the previous
     * mean is at most `jumpGain` × the largest jump between stored means.
     */
    jumpGain?: number;
}

/**
 * Shading-change candidates with a per-block temporal memory (NEXT-STEPS §14).
 * Production (`packages/core/src/shaders/shadingChange.ts`) adopted `gated` with 8 slots and
 * `jumpGain` 1.5; the other forms stay here for re-measurement.
 *
 * The production detector compares this frame's 4×4 / 8×8 block means with
 * the previous frame only. On a still camera, content past the render Nyquist
 * aliases differently on every jitter phase, so a block mean can swing between
 * values it has already taken many times; one previous frame cannot tell that
 * recurrence from a change. These candidates keep the last few raw block means
 * per block (f16, packed 8 to an rgba32uint texel) and let a block whose
 * current mean is explained by that memory read no change:
 * - `range`: inside the [min, max] of the last N means (FSR 3.1's luma
 *   instability / Unreal TSR's flicker idea, as a range);
 * - `nearest`: as close to one stored mean as to the previous frame;
 * - `ema`: compared against a running average;
 * - `gated`: `range`, but only when the frame-to-frame jump is no larger than
 *   the jumps the memory already holds (× `jumpGain`). A monotonic ramp has
 *   small jumps, so a step after it is not hidden inside the ramp's range.
 * The memory only applies to blocks with no motion, disocclusion or reset in
 * the frame; such blocks restart their memory from the current mean, so under
 * motion the detector is exactly production.
 *
 * Bindings 1–8 as production `shadingChange.ts`, plus:
 * - 9: block memory in (rgba32uint; rows [0, ⌈h/4⌉) = 4×4 blocks, then ⌈h/8⌉ rows of 8×8 blocks)
 * - 10: block memory out (same layout, storage)
 * @param options - Memory mode and depth
 * @returns Assembled WGSL
 */
export function buildShadingRecurrenceShader(options: ShadingRecurrenceOptions): string {
    const slots = Math.max(1, Math.min(8, Math.round(options.slots)));
    const mode = { range: 0, nearest: 1, ema: 2, gated: 3 }[options.mode];
    const jumpGain = (options.jumpGain ?? 1.5).toFixed(4);
    return assembleShader(
        WGSL_CONSTANTS,
        WGSL_COLOR,
        /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var lumaHistoryIn : texture_2d<f32>;
@group(0) @binding(3) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(4) var exposureTex : texture_2d<f32>;
@group(0) @binding(5) var exposurePrevTex : texture_2d<f32>;
@group(0) @binding(6) var lumaHistoryOut : texture_storage_2d<r32float, write>;
@group(0) @binding(7) var shadingChangeOut : texture_storage_2d<r32float, write>;
@group(0) @binding(8) var masks : texture_2d<f32>;
@group(0) @binding(9) var blockMemoryIn : texture_2d<u32>;
@group(0) @binding(10) var blockMemoryOut : texture_storage_2d<rgba32uint, write>;

var<workgroup> tileSums : array<vec4f, 64>;
// 1 where any texel of the thread's 2×2 moved, was disoccluded or reset.
var<workgroup> tileMoving : array<f32, 64>;

const SHADING_FLOOR_MID : f32 = 0.08;
const SHADING_FLOOR_COARSE : f32 = 0.04;
const SHADING_FLOOR_CV : f32 = 0.35;

const MEMORY_SLOTS : u32 = ${slots}u;
const MEMORY_MODE : u32 = ${mode}u;          // 0 range, 1 nearest, 2 ema, 3 gated
const MEMORY_JUMP_GAIN : f32 = ${jumpGain};
const MEMORY_EMA_WEIGHT : f32 = 0.2;
// Render-px motion above which a block's stored means describe other content.
const MEMORY_STILL_PX : f32 = 0.05;

fn lumaPair(coord : vec2i, currentLuma : f32, hostRatio : f32, conditioning : f32, motion : vec2f, disocclusion : f32) -> vec4f {
    let currentSq = currentLuma * currentLuma;
    let neutral = vec4f(currentLuma, currentLuma, currentSq, currentSq);
    if (hasFlag(FLAG_RESET)) { return neutral; }
    let uv = (vec2f(coord) + 0.5) * C.renderSizeInv;
    let motionUv = uv - motion;
    if (any(motionUv < vec2f(0.0)) || any(motionUv > vec2f(1.0))) {
        return neutral;
    }
    let previousUv = motionUv + (C.jitter - C.jitterPrev) * C.renderSizeInv;
    let pos = previousUv * C.renderSize - 0.5;
    let base = floor(pos);
    let maxCoord = vec2i(C.renderSize) - 1;
    let p00 = clamp(vec2i(base), vec2i(0), maxCoord);
    let p11 = clamp(vec2i(base) + 1, vec2i(0), maxCoord);
    let l00 = textureLoad(lumaHistoryIn, p00, 0).r;
    let l10 = textureLoad(lumaHistoryIn, vec2i(p11.x, p00.y), 0).r;
    let l01 = textureLoad(lumaHistoryIn, vec2i(p00.x, p11.y), 0).r;
    let l11 = textureLoad(lumaHistoryIn, p11, 0).r;
    let scale = hostRatio * conditioning;
    let tapMin = min(min(l00, l10), min(l01, l11)) * scale;
    let tapMax = max(max(l00, l10), max(l01, l11)) * scale;
    let previousLuma = mix(clamp(currentLuma, tapMin, tapMax), currentLuma, disocclusion);
    let fraction = pos - base;
    let reprojected = mix(mix(l00, l10, fraction.x), mix(l01, l11, fraction.x), fraction.y) * scale;
    let previousSq = mix(reprojected * reprojected, currentSq, disocclusion);
    return vec4f(currentLuma, previousLuma, currentSq, previousSq);
}

// Relative distance of two positive values (1 − min/max), 0 for two blacks.
fn relativeDistance(a : f32, b : f32) -> f32 {
    let maximum = max(a, b);
    if (maximum <= 1.0e-8) { return 0.0; }
    return 1.0 - min(a, b) / maximum;
}

fn memorySlot(words : vec4u, index : u32) -> f32 {
    let pair = unpack2x16float(words[index / 2u]);
    return select(pair.x, pair.y, (index & 1u) == 1u);
}

// How far the block's current mean is from what its memory explains. 1 = no
// memory applies (the previous-frame comparison alone decides).
fn memoryDistance(words : vec4u, current : f32) -> f32 {
    if (MEMORY_MODE == 2u) {
        return relativeDistance(current, bitcast<f32>(words.x));
    }
    if (MEMORY_MODE == 1u) {
        var best = 1.0;
        for (var i = 0u; i < MEMORY_SLOTS; i++) {
            best = min(best, relativeDistance(current, memorySlot(words, i)));
        }
        return best;
    }
    var lo = 3.0e38;
    var hi = -3.0e38;
    var flicker = 0.0;
    var newer = memorySlot(words, 0u);
    for (var i = 0u; i < MEMORY_SLOTS; i++) {
        let value = memorySlot(words, i);
        lo = min(lo, value);
        hi = max(hi, value);
        flicker = max(flicker, relativeDistance(newer, value));
        newer = value;
    }
    if (MEMORY_MODE == 3u && relativeDistance(current, memorySlot(words, 0u)) > MEMORY_JUMP_GAIN * flicker) {
        return 1.0;
    }
    return relativeDistance(current, clamp(current, lo, hi));
}

fn halfBits(value : f32) -> u32 {
    return pack2x16float(vec2f(min(value, 65000.0), 0.0)) & 0xffffu;
}

// Pushes the current mean into slot 0 (a 16-bit funnel shift across the four
// words drops the oldest), or restarts the memory from it.
fn memoryUpdate(words : vec4u, current : f32, restart : bool) -> vec4u {
    if (MEMORY_MODE == 2u) {
        let previous = bitcast<f32>(words.x);
        let ema = select(mix(previous, current, MEMORY_EMA_WEIGHT), current, restart);
        return vec4u(bitcast<u32>(ema), 0u, 0u, 0u);
    }
    let bits = halfBits(current);
    if (restart) {
        let both = bits | (bits << 16u);
        return vec4u(both, both, both, both);
    }
    return vec4u(
        (words.x << 16u) | bits,
        (words.y << 16u) | (words.x >> 16u),
        (words.z << 16u) | (words.y >> 16u),
        (words.w << 16u) | (words.z >> 16u),
    );
}

fn scaleResponse(sums : vec4f, count : f32, floorBase : f32, memory : f32) -> f32 {
    let maximum = max(sums.x, sums.y);
    if (maximum <= 1.0e-5) { return 0.0; }
    let means = sums.xy / count;
    let variances = max(sums.zw / count - means * means, vec2f(0.0));
    let cv = sqrt(0.5 * (variances.x + variances.y)) / max(0.5 * (means.x + means.y), 1.0e-4);
    let floorValue = floorBase + SHADING_FLOOR_CV * cv;
    let relative = min(1.0 - min(sums.x, sums.y) / maximum, memory);
    return smoothstep(floorValue, floorValue * 3.0, relative);
}

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id) lid : vec3u,
    @builtin(local_invocation_index) lidx : u32,
) {
    let frameInfo = textureLoad(exposureTex, vec2i(0), 0);
    let hostPrev = textureLoad(exposurePrevTex, vec2i(0), 0).b;
    let hostRatio = select(1.0, frameInfo.b / hostPrev, hostPrev > 1.0e-4 && frameInfo.b > 1.0e-4);
    let conditioning = max(frameInfo.r, 1.0e-4);
    // Memory is kept free of both exposures, so it survives their changes.
    let memoryScale = 1.0 / (conditioning * select(1.0, frameInfo.b, frameInfo.b > 1.0e-4));

    //* Fine Sums + Luma History (2×2 render block per thread)
    let origin = vec2i(gid.xy) * 2;
    let maxCoord = vec2i(C.renderSize) - 1;
    var sums0 = vec4f(0.0);
    var moving = select(0.0, 1.0, hasFlag(FLAG_RESET));
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let coord = clamp(origin + vec2i(x, y), vec2i(0), maxCoord);
            let hostLuma = luma(textureLoad(inputColor, coord, 0).rgb);
            textureStore(lumaHistoryOut, origin + vec2i(x, y), vec4f(hostLuma, 0.0, 0.0, 0.0));
            let motion = textureLoad(dilatedMotion, coord, 0).xy;
            let disocclusion = clamp(textureLoad(masks, coord, 0).r, 0.0, 1.0);
            let still = length(motion * C.renderSize) < MEMORY_STILL_PX && disocclusion < 0.5;
            moving = max(moving, select(1.0, 0.0, still));
            sums0 += lumaPair(coord, hostLuma * conditioning, hostRatio, conditioning, motion, disocclusion);
        }
    }
    tileSums[lidx] = sums0;
    tileMoving[lidx] = moving;
    workgroupBarrier();

    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let outputSize = vec2u(textureDimensions(shadingChangeOut));
    if (any(gid.xy >= outputSize)) { return; }

    //* Coarse Sums (workgroup-local: 4×4 render per mid, 8×8 per coarse)
    let base1 = (lid.xy / 2u) * 2u;
    var sums1 = vec4f(0.0);
    var moving1 = 0.0;
    for (var y = 0u; y < 2u; y++) {
        for (var x = 0u; x < 2u; x++) {
            let index = (base1.y + y) * 8u + base1.x + x;
            sums1 += tileSums[index];
            moving1 = max(moving1, tileMoving[index]);
        }
    }

    let base2 = (lid.xy / 4u) * 4u;
    var sums2 = vec4f(0.0);
    var moving2 = 0.0;
    for (var y = 0u; y < 4u; y++) {
        for (var x = 0u; x < 4u; x++) {
            let index = (base2.y + y) * 8u + base2.x + x;
            sums2 += tileSums[index];
            moving2 = max(moving2, tileMoving[index]);
        }
    }

    //* Block Memory — read, compare, and (one thread per block) advance.
    let midRows = i32(ceil(C.renderSize.y / 4.0));
    let midCoord = vec2i(gid.xy / 2u);
    let coarseCoord = vec2i(gid.xy / 4u) + vec2i(0, midRows);
    let midWords = textureLoad(blockMemoryIn, midCoord, 0);
    let coarseWords = textureLoad(blockMemoryIn, coarseCoord, 0);
    let midMean = sums1.x / 16.0 * memoryScale;
    let coarseMean = sums2.x / 64.0 * memoryScale;
    let midMemory = select(memoryDistance(midWords, midMean), 1.0, moving1 > 0.5);
    let coarseMemory = select(memoryDistance(coarseWords, coarseMean), 1.0, moving2 > 0.5);
    if (all((lid.xy & vec2u(1u)) == vec2u(0u))) {
        textureStore(blockMemoryOut, midCoord, memoryUpdate(midWords, midMean, moving1 > 0.5));
    }
    if (all((lid.xy & vec2u(3u)) == vec2u(0u))) {
        textureStore(blockMemoryOut, coarseCoord, memoryUpdate(coarseWords, coarseMean, moving2 > 0.5));
    }

    //* Resolve — strongest floor-gated mean-ratio across the coarse scales.
    let response = max(
        scaleResponse(sums1, 16.0, SHADING_FLOOR_MID, midMemory),
        scaleResponse(sums2, 64.0, SHADING_FLOOR_COARSE, coarseMemory),
    );
    textureStore(shadingChangeOut, vec2i(gid.xy), vec4f(response, 0.0, 0.0, 1.0));
}
`,
    );
}

/**
 * The production detector as it was before the block memory (frame pair only:
 * main @ 0aa4855, after #58), frozen as the `shading-frame-pair-v1` bench
 * identity so §14's change can be A/B'd again. Bindings 9/10 are declared and
 * touched but unused, so production's bind group still matches.
 */
export const SHADING_CHANGE_FRAME_PAIR_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_COLOR,
    /* wgsl */ `
@group(0) @binding(1) var inputColor : texture_2d<f32>;
@group(0) @binding(2) var lumaHistoryIn : texture_2d<f32>;
@group(0) @binding(3) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(4) var exposureTex : texture_2d<f32>;
@group(0) @binding(5) var exposurePrevTex : texture_2d<f32>;
@group(0) @binding(6) var lumaHistoryOut : texture_storage_2d<r32float, write>;
@group(0) @binding(7) var shadingChangeOut : texture_storage_2d<r32float, write>;
@group(0) @binding(8) var masks : texture_2d<f32>;
// Declared (and touched in main) only so the auto layout matches production's
// bind group; this identity has no block memory.
@group(0) @binding(9) var blockMemoryIn : texture_2d<u32>;
@group(0) @binding(10) var blockMemoryOut : texture_storage_2d<rgba32uint, write>;

// Per-thread block state: x = current-luma sum, y = reprojected previous-luma
// sum, z = current-luma² sum, w = previous-luma² sum (each frame's own
// within-block spread, for the block's coefficient of variation).
// Luma is averaged BEFORE taking any ratio: per-texel relative differences are
// asymmetric (the darker side of any jitter/alias residue always yields the
// larger ratio), so their signed mean carries a coherent bias on
// high-frequency content — measured as a 0.07–0.10 still-scene floor.
var<workgroup> tileSums : array<vec4f, 64>;

// Per-scale base noise floors for the relative difference of block means.
// Only the 4×4 and 8×8 scales contribute to the response — this is the
// "coarse mip" of the roadmap item: 2×2 means of a thin feature still swing
// under sub-pixel jitter no matter the floor (measured as per-block speckle on
// grid intersections and silhouettes), while a genuinely changing small
// feature still moves its containing 4×4 mean.
const SHADING_FLOOR_MID : f32 = 0.08;    // 4×4 render-texel means
const SHADING_FLOOR_COARSE : f32 = 0.04; // 8×8
// Adaptive part: jitter/alias flicker of a block mean scales with the block's
// own luma contrast, so the floor grows with its coefficient of variation.
// Flat regions (cv ≈ 0) stay maximally sensitive; a checkerboard block
// (cv ≈ 1) is inherently ambiguous and defers to the variance-clip path. A
// block whose luma sits in a few texels over black (sub-texel wires, issue
// #22) reads cv ≈ √(N/m − 1) for m lit texels of N — its whole mean can come
// and go with the jitter phase, and this term keeps it from firing.
const SHADING_FLOOR_CV : f32 = 0.35;

// Sums this texel's current luma, the previous frame's luma reprojected to the
// same world position (jitter-delta compensated; the compared value is clamped
// into the bilinear footprint's tap range — see below), and both squared.
// Reset/offscreen texels contribute neutrally
// (prev = cur), and disoccluded texels are neutralized toward it — their
// previous luma belongs to another surface, and disocclusion already discards
// that history downstream.
fn lumaPair(coord : vec2i, currentLuma : f32, hostRatio : f32, conditioning : f32) -> vec4f {
    let currentSq = currentLuma * currentLuma;
    let neutral = vec4f(currentLuma, currentLuma, currentSq, currentSq);
    if (hasFlag(FLAG_RESET)) { return neutral; }
    let uv = (vec2f(coord) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    // Off-screen tested on the motion-only reprojection, as in reconstruct.ts:
    // the jitter shift alone must not push border texels out of detection.
    let motionUv = uv - motion;
    if (any(motionUv < vec2f(0.0)) || any(motionUv > vec2f(1.0))) {
        return neutral;
    }
    // Texel i samples the scene at i + jitter, so the previous frame's
    // equivalent position shifts by the jitter delta.
    let previousUv = motionUv + (C.jitter - C.jitterPrev) * C.renderSizeInv;
    let pos = previousUv * C.renderSize - 0.5;
    let base = floor(pos);
    let maxCoord = vec2i(C.renderSize) - 1;
    let p00 = clamp(vec2i(base), vec2i(0), maxCoord);
    let p11 = clamp(vec2i(base) + 1, vec2i(0), maxCoord);
    let l00 = textureLoad(lumaHistoryIn, p00, 0).r;
    let l10 = textureLoad(lumaHistoryIn, vec2i(p11.x, p00.y), 0).r;
    let l01 = textureLoad(lumaHistoryIn, vec2i(p00.x, p11.y), 0).r;
    let l11 = textureLoad(lumaHistoryIn, p11, 0).r;
    // Last frame never sampled this exact position — only the four texels
    // around it, under a different jitter. An aliased edge between them can
    // land on either side, so no interpolation recovers the true value; the
    // honest prior is the whole tap range. Comparing against the closest value
    // in it reads 0 wherever jitter alone explains the difference, while a
    // genuine change (current outside its neighbours' range) still registers.
    // Interpolating instead left a measured ~0.7% still-scene firing floor on
    // edges and ~2% under SSGI's rotating pattern (example 09); this reads 0%
    // and 0.06%, with light-step detection unchanged.
    let scale = hostRatio * conditioning;
    let tapMin = min(min(l00, l10), min(l01, l11)) * scale;
    let tapMax = max(max(l00, l10), max(l01, l11)) * scale;
    let disocclusion = clamp(textureLoad(masks, coord, 0).r, 0.0, 1.0);
    let previousLuma = mix(clamp(currentLuma, tapMin, tapMax), currentLuma, disocclusion);
    // The spread term keeps the interpolated value: it measures last frame's
    // own within-block contrast (issue #22's two-sided floor), which the
    // closest-value prior would collapse toward the current frame.
    let fraction = pos - base;
    let reprojected = mix(mix(l00, l10, fraction.x), mix(l01, l11, fraction.x), fraction.y) * scale;
    let previousSq = mix(reprojected * reprojected, currentSq, disocclusion);
    return vec4f(currentLuma, previousLuma, currentSq, previousSq);
}

// Relative difference of two block means, gated by the scale's base floor
// plus the block's own contrast-scaled flicker allowance. The contrast is the
// within-frame spread of BOTH frames over their joint mean. Measuring it on
// the current frame alone made the gate one-sided: a thin bright feature that
// this jitter phase missed leaves a block with no spread (cv = 0, base floor
// only) against a previous frame that hit it, so the block fired at full
// strength exactly when its content vanished (issue #22, NEXT-STEPS §9 — the
// same artefact was most of the still-scene block speckle on Q1/Q12 and the
// motion false positives on Q4). The between-frame shift is deliberately left
// out of the spread, so a genuine change on a flat surface does not raise its
// own floor.
fn scaleResponse(sums : vec4f, count : f32, floorBase : f32) -> f32 {
    let maximum = max(sums.x, sums.y);
    if (maximum <= 1.0e-5) { return 0.0; }
    let means = sums.xy / count;
    let variances = max(sums.zw / count - means * means, vec2f(0.0));
    let cv = sqrt(0.5 * (variances.x + variances.y)) / max(0.5 * (means.x + means.y), 1.0e-4);
    let floorValue = floorBase + SHADING_FLOOR_CV * cv;
    let relative = 1.0 - min(sums.x, sums.y) / maximum;
    return smoothstep(floorValue, floorValue * 3.0, relative);
}

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_id) lid : vec3u,
    @builtin(local_invocation_index) lidx : u32,
) {
    // Hoisted once per invocation — the source-style candidate reloaded these
    // 1×1 texels inside every reduction tap, which dominated its cost.
    let frameInfo = textureLoad(exposureTex, vec2i(0), 0);
    let hostPrev = textureLoad(exposurePrevTex, vec2i(0), 0).b;
    let hostRatio = select(1.0, frameInfo.b / hostPrev, hostPrev > 1.0e-4 && frameInfo.b > 1.0e-4);
    let conditioning = max(frameInfo.r, 1.0e-4);
    _ = textureDimensions(blockMemoryIn);
    _ = textureDimensions(blockMemoryOut);

    //* Fine Sums + Luma History (2×2 render block per thread)
    let origin = vec2i(gid.xy) * 2;
    let maxCoord = vec2i(C.renderSize) - 1;
    var sums0 = vec4f(0.0);
    for (var y = 0; y < 2; y++) {
        for (var x = 0; x < 2; x++) {
            let coord = clamp(origin + vec2i(x, y), vec2i(0), maxCoord);
            // History stays in the caller's host domain; host + conditioning
            // are applied to both sides of the comparison only.
            let hostLuma = luma(textureLoad(inputColor, coord, 0).rgb);
            textureStore(lumaHistoryOut, origin + vec2i(x, y), vec4f(hostLuma, 0.0, 0.0, 0.0));
            sums0 += lumaPair(coord, hostLuma * conditioning, hostRatio, conditioning);
        }
    }
    tileSums[lidx] = sums0;
    workgroupBarrier();

    // Grid guards sit AFTER the barrier: every invocation must reach it
    // (uniform control flow), and out-of-range texture writes above are no-ops.
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let outputSize = vec2u(textureDimensions(shadingChangeOut));
    if (any(gid.xy >= outputSize)) { return; }

    //* Coarse Sums (workgroup-local: 4×4 render per mid, 8×8 per coarse)
    let base1 = (lid.xy / 2u) * 2u;
    var sums1 = vec4f(0.0);
    for (var y = 0u; y < 2u; y++) {
        for (var x = 0u; x < 2u; x++) {
            sums1 += tileSums[(base1.y + y) * 8u + base1.x + x];
        }
    }

    let base2 = (lid.xy / 4u) * 4u;
    var sums2 = vec4f(0.0);
    for (var y = 0u; y < 4u; y++) {
        for (var x = 0u; x < 4u; x++) {
            sums2 += tileSums[(base2.y + y) * 8u + base2.x + x];
        }
    }

    //* Resolve — strongest floor-gated mean-ratio across the coarse scales.
    let response = max(
        scaleResponse(sums1, 16.0, SHADING_FLOOR_MID),
        scaleResponse(sums2, 64.0, SHADING_FLOOR_COARSE),
    );
    textureStore(shadingChangeOut, vec2i(gid.xy), vec4f(response, 0.0, 0.0, 1.0));
}
`,
);
