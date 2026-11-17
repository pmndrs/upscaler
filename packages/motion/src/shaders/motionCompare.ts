/**
 * Motion-vector endpoint error against an oracle (EXPERIMENTAL, motion lab).
 *
 * The oracle is a motion field rendered in the same pass as the candidates, by
 * per-object materials that know the scene's exact previous positions. Both are
 * written for the same rasterized surface point, so the per-pixel difference is
 * the candidate's error and nothing else: no resampling, no aliasing, no
 * occlusion test. That makes it exact where the warp residual is only a proxy.
 *
 * Oracle texel (rgba16float): `.xy` motion in three's `velocity` convention
 * (NDC delta, current − previous), `.z` a coverage marker ({@link ORACLE_VALID}
 * or {@link ORACLE_NO_PREVIOUS}; anything else, such as a background clear
 * colour, is uncovered), `.w` the object id (`0 … COMPARE_OBJECTS − 1`).
 *
 * Per object, statistics words (stride {@link COMPARE_OBJECT_STRIDE}):
 * `[covered, noPrevious, Σ|oracle| px, reserved]`, then per candidate
 * (zero motion first, then up to three fields) `[Σ error px, error > 0.25 px,
 * error > 1 px]`. Sums are fixed point ×{@link COMPARE_FIXED_POINT}, per-pixel
 * values capped at {@link COMPARE_CAP_PIXELS}, so a full frame up to 1920×1080
 * cannot overflow a u32 (larger frames need a coarser fixed point).
 */

/** Oracle `.z` for a covered pixel whose surface point had a previous position. */
export const ORACLE_VALID = 3;
/** Oracle `.z` for a covered pixel with no previous position (behind the previous camera). */
export const ORACLE_NO_PREVIOUS = 2;
/** Object ids the comparison separates. */
export const COMPARE_OBJECTS = 8;
/** Zero motion plus up to three candidate fields. */
export const COMPARE_CANDIDATES = 4;
export const COMPARE_HEADER_WORDS = 4;
export const COMPARE_CANDIDATE_WORDS = 3;
export const COMPARE_OBJECT_STRIDE = COMPARE_HEADER_WORDS + COMPARE_CANDIDATES * COMPARE_CANDIDATE_WORDS;
export const COMPARE_WORDS = COMPARE_OBJECTS * COMPARE_OBJECT_STRIDE;
export const COMPARE_FIXED_POINT = 32;
export const COMPARE_CAP_PIXELS = 64;
export const COMPARE_SMALL_PIXELS = 0.25;
export const COMPARE_LARGE_PIXELS = 1;
export const COMPARE_CONSTANTS_BYTES = 16;

export const MOTION_COMPARE_SHADER = /* wgsl */ `
struct CompareConstants {
    size: vec2f,
    candidateCount: u32,
    _pad: u32,
};

@group(0) @binding(0) var<uniform> C: CompareConstants;
@group(0) @binding(1) var oracle: texture_2d<f32>;
@group(0) @binding(2) var motion1: texture_2d<f32>;
@group(0) @binding(3) var motion2: texture_2d<f32>;
@group(0) @binding(4) var motion3: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>>;

const OBJECTS: u32 = ${COMPARE_OBJECTS}u;
const STRIDE: u32 = ${COMPARE_OBJECT_STRIDE}u;
const HEADER: u32 = ${COMPARE_HEADER_WORDS}u;
const PER_CANDIDATE: u32 = ${COMPARE_CANDIDATE_WORDS}u;
const WORDS: u32 = ${COMPARE_WORDS}u;
const FIXED: f32 = ${COMPARE_FIXED_POINT}.0;
const CAP: f32 = ${COMPARE_CAP_PIXELS}.0;

var<workgroup> local: array<atomic<u32>, WORDS>;

fn fixedPixels(value: f32) -> u32 {
    return u32(round(min(value, CAP) * FIXED));
}

fn candidate(index: u32, pixel: vec2i) -> vec2f {
    switch index {
        case 1u: { return textureLoad(motion1, pixel, 0).xy; }
        case 2u: { return textureLoad(motion2, pixel, 0).xy; }
        case 3u: { return textureLoad(motion3, pixel, 0).xy; }
        default: { return vec2f(0.0); }
    }
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
    for (var i = lid; i < WORDS; i += 64u) { atomicStore(&local[i], 0u); }
    workgroupBarrier();

    // No early return: every invocation must reach the barriers.
    let inside = all(vec2f(gid.xy) < C.size);
    let pixel = vec2i(gid.xy);
    let texel = select(vec4f(0.0), textureLoad(oracle, pixel, 0), inside);
    let marker = round(texel.z);
    let id = u32(clamp(round(texel.w), 0.0, f32(OBJECTS - 1u)));
    let base = id * STRIDE;
    // NDC delta → render pixels.
    let toPixels = 0.5 * C.size;
    if (inside && marker == ${ORACLE_NO_PREVIOUS}.0) {
        atomicAdd(&local[base + 1u], 1u);
    }
    if (inside && marker == ${ORACLE_VALID}.0) {
        atomicAdd(&local[base], 1u);
        atomicAdd(&local[base + 2u], fixedPixels(length(texel.xy * toPixels)));
        for (var k = 0u; k <= C.candidateCount; k++) {
            let error = length((candidate(k, pixel) - texel.xy) * toPixels);
            let offset = base + HEADER + k * PER_CANDIDATE;
            atomicAdd(&local[offset], fixedPixels(error));
            if (error > ${COMPARE_SMALL_PIXELS}) { atomicAdd(&local[offset + 1u], 1u); }
            if (error > ${COMPARE_LARGE_PIXELS}.0) { atomicAdd(&local[offset + 2u], 1u); }
        }
    }
    workgroupBarrier();

    for (var i = lid; i < WORDS; i += 64u) {
        let value = atomicLoad(&local[i]);
        if (value != 0u) { atomicAdd(&stats[i], value); }
    }
}
`;
