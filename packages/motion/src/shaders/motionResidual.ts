/**
 * Warp residual (EXPERIMENTAL, motion lab): how well each candidate motion
 * field explains the current image from the previous one.
 *
 * For every pixel and candidate k, the previous image is sampled (bilinear)
 * at `uv − motion_k · (0.5, −0.5)` and compared with the current pixel in
 * conditioned luma (`l / (1 + l)`, the accumulate pass's firefly-safe domain).
 * Candidate 0 is always zero motion; 1–3 are motion textures in three's
 * `velocity` convention (NDC delta, current − previous).
 *
 * Occlusion: a candidate is only scored where the previous linear depth at its
 * previous position matches the static-scene expectation (camera motion's .z)
 * within a relative tolerance. That expectation is exact for static geometry
 * and close for objects whose depth changes slowly; fast motion along the view
 * axis drops out as "no valid candidate" (counted, not scored).
 *
 * Statistics (one slot of `STATS_STRIDE` u32 per invocation) are reduced per
 * workgroup and added atomically: per candidate the residual sum (×1024
 * fixed point), valid / best / unexplained / beaten / moving counts, then the count of
 * pixels no candidate could score and the pixel total. The same pass with the
 * depth test off and `previous` = a reference image measures |current − ref|.
 */
export const RESIDUAL_FIXED_POINT = 1024;
/** u32 words per statistics slot. */
export const STATS_STRIDE = 32;
/** Words per candidate within a slot: sum, valid, best, unexplained, beaten, moving. */
export const CANDIDATE_FIELDS = 6;
export const MAX_CANDIDATES = 4;

/** Residual pass flags. */
export const RESIDUAL_FLAG_DEPTH_TEST = 1;
export const RESIDUAL_FLAG_DEBUG = 2;

/** Debug visualization modes. */
export const RESIDUAL_DEBUG_CLASSIFY = 0;
export const RESIDUAL_DEBUG_HEAT = 1;
/** Candidate motion in analysis pixels: rg = 0.5 + v / 8 (signed, y down), b = |v| / 4. */
export const RESIDUAL_DEBUG_MOTION = 2;
/** Motion (analysis pixels) above which a pixel counts as moving for a candidate. */
export const MOVING_PIXELS = 0.05;

export const MOTION_RESIDUAL_SHADER = /* wgsl */ `
struct ResidualConstants {
    size : vec2f,
    invSize : vec2f,
    motionSize : vec2f,
    depthSize : vec2f,
    depthTolerance : f32,
    threshold : f32,
    candidateCount : u32,
    flags : u32,
    debugMode : u32,
    debugCandidate : u32,
    slot : u32,
    pad : u32,
};

const FIXED : f32 = ${RESIDUAL_FIXED_POINT}.0;
const STRIDE : u32 = ${STATS_STRIDE}u;
const FIELDS : u32 = ${CANDIDATE_FIELDS}u;
const CANDIDATES : u32 = ${MAX_CANDIDATES}u;
const WORDS : u32 = ${MAX_CANDIDATES * CANDIDATE_FIELDS + 2}u;

@group(0) @binding(0) var<uniform> R : ResidualConstants;
@group(0) @binding(1) var current : texture_2d<f32>;
@group(0) @binding(2) var previous : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@group(0) @binding(4) var motion1 : texture_2d<f32>;
@group(0) @binding(5) var motion2 : texture_2d<f32>;
@group(0) @binding(6) var motion3 : texture_2d<f32>;
@group(0) @binding(7) var cameraMotion : texture_2d<f32>;
@group(0) @binding(8) var previousDepth : texture_2d<f32>;
@group(0) @binding(9) var debugOut : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(10) var<storage, read_write> stats : array<atomic<u32>>;

var<workgroup> partial : array<atomic<u32>, WORDS>;

fn conditionedLuma(c : vec3f) -> f32 {
    let l = dot(max(c, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
    return l / (1.0 + l);
}

fn texel(uv : vec2f, size : vec2f) -> vec2i {
    return vec2i(clamp(floor(uv * size), vec2f(0.0), size - 1.0));
}

fn readMotion(k : u32, uv : vec2f) -> vec2f {
    let p = texel(uv, R.motionSize);
    if (k == 1u) { return textureLoad(motion1, p, 0).xy; }
    if (k == 2u) { return textureLoad(motion2, p, 0).xy; }
    if (k == 3u) { return textureLoad(motion3, p, 0).xy; }
    return vec2f(0.0);
}

fn depthValid(uv : vec2f, prevUV : vec2f) -> bool {
    if ((R.flags & 1u) == 0u) { return true; }
    let expected = textureLoad(cameraMotion, texel(uv, R.depthSize), 0).z;
    let prevDepth = textureLoad(previousDepth, texel(prevUV, R.depthSize), 0).r;
    return expected > 0.0 && abs(prevDepth - expected) <= R.depthTolerance * expected;
}

@compute @workgroup_size(8, 8)
fn main(
    @builtin(global_invocation_id) gid : vec3u,
    @builtin(local_invocation_index) lid : u32,
) {
    if (lid < WORDS) { atomicStore(&partial[lid], 0u); }
    workgroupBarrier();

    // No early return: every invocation must reach the barriers below.
    let inBounds = all(vec2f(gid.xy) < R.size);
    if (inBounds) {
        let uv = (vec2f(gid.xy) + 0.5) * R.invSize;
        let center = textureLoad(current, vec2i(gid.xy), 0).rgb;
        let lc = conditionedLuma(center);

        var residual : array<f32, CANDIDATES>;
        var valid : array<bool, CANDIDATES>;
        var shift : array<vec2f, CANDIDATES>;
        var best = 1e9;
        var bestIndex = CANDIDATES;
        for (var k = 0u; k < CANDIDATES; k++) {
            residual[k] = 0.0;
            valid[k] = false;
            shift[k] = vec2f(0.0);
            if (k > R.candidateCount) { continue; }
            let uvMotion = readMotion(k, uv) * vec2f(0.5, -0.5);
            shift[k] = uvMotion * R.size;
            let prevUV = uv - uvMotion;
            if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) { continue; }
            if (!depthValid(uv, prevUV)) { continue; }
            let lp = conditionedLuma(textureSampleLevel(previous, linearSampler, prevUV, 0.0).rgb);
            residual[k] = abs(lc - lp);
            valid[k] = true;
            if (residual[k] < best) {
                best = residual[k];
                bestIndex = k;
            }
        }

        for (var k = 0u; k < CANDIDATES; k++) {
            if (k <= R.candidateCount && length(shift[k]) > ${MOVING_PIXELS}) { atomicAdd(&partial[k * FIELDS + 5u], 1u); }
            if (!valid[k]) { continue; }
            let base = k * FIELDS;
            atomicAdd(&partial[base], u32(round(residual[k] * FIXED)));
            atomicAdd(&partial[base + 1u], 1u);
            if (k == bestIndex) { atomicAdd(&partial[base + 2u], 1u); }
            if (residual[k] > R.threshold) {
                atomicAdd(&partial[base + 3u], 1u);
                if (best <= 0.5 * R.threshold) { atomicAdd(&partial[base + 4u], 1u); }
            }
        }
        if (bestIndex == CANDIDATES) { atomicAdd(&partial[CANDIDATES * FIELDS], 1u); }
        atomicAdd(&partial[CANDIDATES * FIELDS + 1u], 1u);

        if ((R.flags & 2u) != 0u) {
            let shade = vec3f(0.35 * lc);
            var color = vec4f(shade, 1.0);
            if (R.debugMode == 0u) {
                if (bestIndex == CANDIDATES) {
                    color = vec4f(0.1, 0.25, 0.85, 1.0);
                } else if (best > R.threshold) {
                    // Nothing explains it: shading change, or every motion is wrong.
                    color = vec4f(mix(0.4, 1.0, saturate(best * 8.0)), 0.05, 0.05, 1.0);
                } else if (R.candidateCount >= 1u && valid[1] && residual[1] > R.threshold) {
                    // The engine's motion (candidate 1) is beaten by another candidate.
                    color = vec4f(1.0, 0.85, 0.1, 1.0);
                }
            } else if (R.debugMode == 2u) {
                let v = shift[min(R.debugCandidate, CANDIDATES - 1u)];
                color = vec4f(saturate(0.5 + v / 8.0), saturate(length(v) / 4.0), 1.0);
            } else {
                let k = min(R.debugCandidate, CANDIDATES - 1u);
                color = select(
                    vec4f(0.1, 0.25, 0.85, 1.0),
                    vec4f(vec3f(saturate(residual[k] * 8.0)), 1.0),
                    valid[k],
                );
            }
            textureStore(debugOut, vec2i(gid.xy), color);
        }
    }

    workgroupBarrier();
    if (lid < WORDS) {
        let value = atomicLoad(&partial[lid]);
        if (value != 0u) { atomicAdd(&stats[R.slot * STRIDE + lid], value); }
    }
}
`;

/** Byte size of `ResidualConstants`. */
export const RESIDUAL_CONSTANTS_BYTES = 64;
