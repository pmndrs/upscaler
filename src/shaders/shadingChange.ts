import { WGSL_COLOR, WGSL_CONSTANTS } from './common';
import { assembleShader } from './wgsl';

/**
 * Shading-change detection — the concept of FSR3's signed luma-difference
 * pyramid (the source resolver's "coarse mip" detector), fused into one
 * render-resolution dispatch.
 *
 * The pass averages current luma and last frame's reprojected luma over
 * 2×2 / 4×4 / 8×8 render blocks and compares the *means* per scale, each gated
 * by a scale-matched noise floor. Averaging before the ratio is the point:
 * block-mean luma is stable under sub-pixel jitter and aliasing, so genuine
 * shading changes (a light turning on, an animated material) move the means
 * while alias flicker does not. (Two rejected designs, measured on GPU: the
 * source-style mean-of-per-texel-signed-ratios floors at ~0.10 on a still
 * jittered scene because the ratio metric weights the darker side of any
 * residual more — a coherent bias averaging cannot cancel; point-sampled
 * reprojection without the jitter-delta alignment is worse still.) The
 * strongest gated scale is the response — replacing the 3×3-neighborhood
 * variance heuristic, which false-positived on high-frequency content under
 * heavy motion.
 *
 * Structure (why this diverges from the source's SPD + resolve pass pair): one
 * 8×8 workgroup with a 2×2 render block per thread covers 16×16 render pixels —
 * exactly one 8×8-block (mip2) tile — so every reduction scale is
 * workgroup-local. Each signed difference is evaluated once into workgroup
 * memory and the mip means + resolve happen in-register; the source-style
 * candidate re-evaluated differences per mip with per-tap 1×1 frame-info
 * reloads and measured 0.225 ms against this pass's target of a fraction of
 * that. The pass also writes this frame's luma history (host-domain) for the
 * next frame's comparison.
 *
 * Bindings:
 * - 1: scene color, render size (linear HDR, host domain)
 * - 2: luma history in, render size (r32float; last frame's host-domain luma)
 * - 3: dilated motion, render size (UV delta in .xy)
 * - 4: exposure, 1×1 (r = conditioning, b = host pre-exposure)
 * - 5: previous frame's exposure, 1×1
 * - 6: luma history out (r32float storage, render size)
 * - 7: shading-change response out (r32float storage, ceil(render/2))
 */
export const SHADING_CHANGE_SHADER = assembleShader(
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

// Per-thread block state: x = current-luma sum, y = reprojected previous-luma
// sum, z = current-luma² sum (for the block's coefficient of variation).
// Luma is averaged BEFORE taking any ratio: per-texel relative differences are
// asymmetric (the darker side of any jitter/alias residue always yields the
// larger ratio), so their signed mean carries a coherent bias on
// high-frequency content — measured as a 0.07–0.10 still-scene floor.
var<workgroup> tileSums : array<vec3f, 64>;

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
// (cv ≈ 1) is inherently ambiguous and defers to the variance-clip path.
const SHADING_FLOOR_CV : f32 = 0.35;

// Sums this texel's current luma, the previous frame's luma reprojected to the
// same world position (jitter-delta compensated, bilinear — r32float is not
// filterable), and current luma². Reset/offscreen texels contribute neutrally
// (prev = cur), and disoccluded texels are neutralized toward it — their
// previous luma belongs to another surface, and disocclusion already discards
// that history downstream.
fn lumaPair(coord : vec2i, currentLuma : f32, hostRatio : f32, conditioning : f32) -> vec3f {
    let neutral = vec3f(currentLuma, currentLuma, currentLuma * currentLuma);
    if (hasFlag(FLAG_RESET)) { return neutral; }
    let uv = (vec2f(coord) + 0.5) * C.renderSizeInv;
    let motion = textureLoad(dilatedMotion, coord, 0).xy;
    // Texel i samples the scene at i + jitter, so the previous frame's
    // equivalent position shifts by the jitter delta.
    let previousUv = uv - motion + (C.jitter - C.jitterPrev) * C.renderSizeInv;
    if (any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
        return neutral;
    }
    let pos = previousUv * C.renderSize - 0.5;
    let base = floor(pos);
    let fraction = pos - base;
    let maxCoord = vec2i(C.renderSize) - 1;
    let p00 = clamp(vec2i(base), vec2i(0), maxCoord);
    let p11 = clamp(vec2i(base) + 1, vec2i(0), maxCoord);
    let l00 = textureLoad(lumaHistoryIn, p00, 0).r;
    let l10 = textureLoad(lumaHistoryIn, vec2i(p11.x, p00.y), 0).r;
    let l01 = textureLoad(lumaHistoryIn, vec2i(p00.x, p11.y), 0).r;
    let l11 = textureLoad(lumaHistoryIn, p11, 0).r;
    let previousHostLuma = mix(mix(l00, l10, fraction.x), mix(l01, l11, fraction.x), fraction.y);
    var previousLuma = previousHostLuma * hostRatio * conditioning;
    let disocclusion = textureLoad(masks, coord, 0).r;
    previousLuma = mix(previousLuma, currentLuma, clamp(disocclusion, 0.0, 1.0));
    return vec3f(currentLuma, previousLuma, currentLuma * currentLuma);
}

// Relative difference of two block means, gated by the scale's base floor
// plus the block's own contrast-scaled flicker allowance.
fn scaleResponse(sums : vec3f, count : f32, floorBase : f32) -> f32 {
    let maximum = max(sums.x, sums.y);
    if (maximum <= 1.0e-5) { return 0.0; }
    let mean = sums.x / count;
    let variance = max(sums.z / count - mean * mean, 0.0);
    let cv = sqrt(variance) / max(mean, 1.0e-4);
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

    //* Fine Sums + Luma History (2×2 render block per thread)
    let origin = vec2i(gid.xy) * 2;
    let maxCoord = vec2i(C.renderSize) - 1;
    var sums0 = vec3f(0.0);
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
    var sums1 = vec3f(0.0);
    for (var y = 0u; y < 2u; y++) {
        for (var x = 0u; x < 2u; x++) {
            sums1 += tileSums[(base1.y + y) * 8u + base1.x + x];
        }
    }

    let base2 = (lid.xy / 4u) * 4u;
    var sums2 = vec3f(0.0);
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
