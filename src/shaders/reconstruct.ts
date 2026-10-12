import { WGSL_CONSTANTS, WGSL_DEPTH } from './common.js';
import { assembleShader } from './wgsl.js';

/**
 * Reconstruct pass — FSR2/3's "reconstruct & dilate" stage: dilation plus the
 * reconstructed-previous-depth scatter. Its partner {@link DEPTH_CLIP_SHADER}
 * consumes the scatter after a pass boundary (the scatter must complete for
 * every pixel before any pixel reads it).
 *
 * Per render-resolution pixel:
 * 1. Dilate — find the nearest (closest-to-camera) depth in the 3×3
 *    neighborhood and take that texel's motion vector, so thin foreground
 *    silhouettes drag their motion and don't smear background history.
 * 2. Scatter — write this frame's dilated linear depth into the bilinear
 *    footprint of the pixel's previous-frame position, keeping the nearest
 *    (atomicMin on the u32 bits: positive floats order like their bits).
 *
 * The depth clip then compares each pixel against the nearest CURRENT-frame
 * depth that reprojects onto its previous position. Both sides are
 * same-frame depths, so camera and object motion along the view axis cancel —
 * the cross-frame form this replaced compared depths measured from two camera
 * positions and disoccluded every surface a camera moved away from (issue
 * #67: a frontal wall lost 97% of its history to a 0.3-unit dolly-out).
 *
 * The scatter buffer is a plain storage buffer (WebGPU has no float texture
 * atomics) and is ping-ponged: the depth clip empties each pixel's slot of
 * the buffer the next frame scatters into, so there is no clear dispatch.
 *
 * Bindings:
 * - 1: scene depth (depth texture, render size)
 * - 2: velocity (rgba16float, NDC delta in .xy, render size)
 * - 3: dilated view depth output (r32float storage)
 * - 4: dilated motion output (rgba16float storage, UV delta in .xy; .z
 *      carries the 3×3 depth relief to the depth clip — a reserved channel)
 * - 5: reconstructed previous depth (storage buffer, u32 = f32 bits)
 */
export function buildReconstructShader(linear = false): string {
return assembleShader(
    WGSL_CONSTANTS,
    linear ? 'fn linearizeDepth(depth : f32) -> f32 { return depth; }' : WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var sceneDepth : ${linear ? 'texture_2d<f32>' : 'texture_depth_2d'};
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(4) var dilatedMotion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<storage, read_write> reconstructedDepth : array<atomic<u32>>;

// Bilinear taps lighter than this neither scatter nor vote (matches the
// reference; the depth clip uses the same floor so the footprints agree).
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    //* Nearest Depth Search (dilate)
    // With a reversed depth buffer larger values are nearer; otherwise smaller.
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0)${linear ? '.r' : ''};
    var farthestDepth = bestDepth;
    var bestCoord = center;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let p = clamp(center + vec2i(x, y), vec2i(0), maxCoord);
            let d = textureLoad(sceneDepth, p, 0)${linear ? '.r' : ''};
            // Parenthesize the comparisons: WGSL otherwise parses the
            // '<' ... '>' as a template argument list and fails to compile.
            let nearer = select((d < bestDepth), (d > bestDepth), reversed);
            if (nearer) {
                bestDepth = d;
                bestCoord = p;
            }
            let farther = select((d > farthestDepth), (d < farthestDepth), reversed);
            if (farther) { farthestDepth = d; }
        }
    }

    let curDepth = linearizeDepth(bestDepth);
    // The neighborhood's own depth relief in view units — how much the local
    // surface slopes across one texel ring. Neighbors on a slope scatter into
    // overlapping footprints, so a tap can legitimately read a depth up to
    // this much nearer without being a different surface.
    let localRelief = max(linearizeDepth(farthestDepth) - curDepth, 0.0);
    let uvDelta = textureLoad(sceneVelocity, bestCoord, 0).xy * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(curDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, localRelief, 0.0));

    //* Scatter — reconstructed previous depth
    // Motion-only previous position: the depth clip gathers the same
    // footprint, so any common offset (the jitter delta) cancels.
    let prevUV = (vec2f(gid.xy) + 0.5) * C.renderSizeInv - uvDelta;
    let samplePosition = prevUV * C.renderSize - 0.5;
    let base = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let weights = vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
    let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    let encoded = bitcast<u32>(max(curDepth, 0.0));
    let width = i32(C.renderSize.x);
    for (var index = 0; index < 4; index++) {
        if (weights[index] <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let p = base + offsets[index];
        if (any(p < vec2i(0)) || any(p > maxCoord)) { continue; }
        atomicMin(&reconstructedDepth[u32(p.y * width + p.x)], encoded);
    }
}
`,
);
}
export const RECONSTRUCT_SHADER = buildReconstructShader();

/**
 * Depth-clip pass — FSR2/3's disocclusion test against the reconstructed
 * previous depth {@link RECONSTRUCT_SHADER} just scattered.
 *
 * Derived from AMD's formulation (ffx_fsr2_depth_clip.h ComputeDepthClip):
 * each bilinear tap at the pixel's previous position votes a confidence that
 * its separation from the current depth is within the viewport/depth-scaled
 * tolerance. We keep two divergences from the reference, both measured:
 * the tolerance is widened by the 3×3 depth relief (grazing planes), and
 * the best tap wins instead of a positive-separation-only weighted mean.
 *
 * Bindings:
 * - 1: dilated view depth (this frame's, r32float)
 * - 2: dilated motion (this frame's; .xy UV delta, .z depth relief)
 * - 3: reconstructed previous depth (read; this frame's scatter)
 * - 4: mask output (rgba8unorm storage; r = disocclusion)
 * - 5: the other reconstructed-depth buffer (emptied here for next frame)
 */
export const DEPTH_CLIP_SHADER = assembleShader(
    WGSL_CONSTANTS,
    /* wgsl */ `
@group(0) @binding(1) var dilatedDepth : texture_2d<f32>;
@group(0) @binding(2) var dilatedMotion : texture_2d<f32>;
@group(0) @binding(3) var<storage, read> reconstructedDepth : array<u32>;
@group(0) @binding(4) var maskOutput : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read_write> nextReconstructedDepth : array<u32>;

// AMD's separation tolerance (ffx_fsr2_depth_clip.h): the minimum view-depth
// gap that reads as a different surface scales with viewport resolution and
// scene depth, absorbing depth-buffer quantization without a scene-tuned guess.
const DEPTH_SEPARATION_CONSTANT : f32 = 1.37e-5;
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;
// +inf bits: an empty slot reads as farther than any surface.
const EMPTY_DEPTH : u32 = 0x7f800000u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;
    let width = i32(C.renderSize.x);
    // Ping-pong clear: one texel per slot, so every slot of the buffer the
    // next frame scatters into is emptied without a clear dispatch.
    nextReconstructedDepth[u32(center.y * width + center.x)] = EMPTY_DEPTH;

    let curDepth = textureLoad(dilatedDepth, center, 0).r;
    let motion = textureLoad(dilatedMotion, center, 0);
    let uvDelta = motion.xy;
    let localRelief = motion.z;

    let uv = (vec2f(gid.xy) + 0.5) * C.renderSizeInv;
    let prevUV = uv - uvDelta;
    if (any(prevUV < vec2f(0.0)) || any(prevUV > vec2f(1.0))) {
        textureStore(maskOutput, gid.xy, vec4f(1.0, 0.0, 0.0, 1.0));
        return;
    }
    let samplePosition = prevUV * C.renderSize - 0.5;
    let base = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let offsets = array<vec2i, 4>(vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
    let weights = vec4f(
        (1.0 - fraction.x) * (1.0 - fraction.y),
        fraction.x * (1.0 - fraction.y),
        (1.0 - fraction.x) * fraction.y,
        fraction.x * fraction.y
    );
    let halfViewportWidth = length(C.renderSize * 0.5);
    var surfaceConfidence = 0.0;
    var sawValidTap = false;
    for (var index = 0; index < 4; index++) {
        let weight = weights[index];
        if (weight <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let p = clamp(base + offsets[index], vec2i(0), maxCoord);
        // This pixel scattered into its own footprint, so a tap reads its own
        // depth unless something nearer reprojects there too (empty slots
        // only occur at the clamped border and read as +inf).
        let tapDepth = bitcast<f32>(reconstructedDepth[u32(p.y * width + p.x)]);
        let difference = curDepth - tapDepth;
        // A tap at or behind the current surface: nothing in front — full
        // confidence. Taps in front witness an occluder that moved off this
        // point, with confidence falling as the separation exceeds tolerance.
        var tapConfidence = 1.0;
        if (difference > 0.0) {
            // Tolerance: the viewport/depth-scaled quantization term
            // (reference formulation), widened by the neighborhood's own
            // relief so a slope's per-texel depth change is not separation.
            let required = max(
                DEPTH_SEPARATION_CONSTANT * halfViewportWidth * max(curDepth, tapDepth),
                localRelief,
            );
            tapConfidence = clamp(required / max(difference, 1.0e-7), 0.0, 1.0);
        }
        // MAX vote, not a weighted mean: if ANY footprint tap recognizes the
        // current surface it is the same surface; a genuine disocclusion has
        // every tap covered by the occluder that moved away.
        surfaceConfidence = max(surfaceConfidence, tapConfidence);
        sawValidTap = true;
    }
    let disocclusion = select(0.0, clamp(1.0 - surfaceConfidence, 0.0, 1.0), sawValidTap);
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);
