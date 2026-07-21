import { WGSL_CONSTANTS, WGSL_DEPTH } from './common';
import { assembleShader } from './wgsl';

/**
 * Reconstruct pass — fuses FSR2/3's "reconstruct & dilate" and "depth clip"
 * stages into one render-resolution dispatch (a Phase-5 merge: depth clip only
 * ever read the current pixel's own dilated depth and motion, both of which
 * this pass already has in-register, plus the previous frame's dilated depth).
 *
 * Per render-resolution pixel:
 * 1. Dilate — find the nearest (closest-to-camera) depth in the 3×3
 *    neighborhood and take that texel's motion vector, so thin foreground
 *    silhouettes drag their motion and don't smear background history.
 * 2. Depth clip — reproject through that motion and compare the current
 *    dilated (linear) depth against last frame's dilated depth; a surface that
 *    was hidden behind something nearer last frame is disoccluded and its
 *    history must be dropped.
 *
 * Bindings:
 * - 1: scene depth (depth texture, render size)
 * - 2: velocity (rgba16float, NDC delta in .xy, render size)
 * - 3: previous frame's dilated view depth (r32float, render size)
 * - 4: dilated view depth output (r32float storage)
 * - 5: dilated motion output (rgba16float storage, UV delta in .xy)
 * - 6: mask output (rgba8unorm storage; r = disocclusion)
 */
export const RECONSTRUCT_SHADER = assembleShader(
    WGSL_CONSTANTS,
    WGSL_DEPTH,
    /* wgsl */ `
@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var sceneVelocity : texture_2d<f32>;
@group(0) @binding(3) var previousDepth : texture_2d<f32>;
@group(0) @binding(4) var dilatedDepth : texture_storage_2d<r32float, write>;
@group(0) @binding(5) var dilatedMotion : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var maskOutput : texture_storage_2d<rgba8unorm, write>;

// AMD's separation tolerance (ffx_fsr2_depth_clip.h): the minimum view-depth
// gap that reads as a different surface scales with viewport resolution and
// scene depth, absorbing depth-buffer quantization without a scene-tuned guess.
const DEPTH_SEPARATION_CONSTANT : f32 = 1.37e-5;
// Bilinear taps lighter than this cannot vote (matches the reference).
const DEPTH_TAP_WEIGHT_FLOOR : f32 = 6.1e-4;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(vec2f(gid.xy) >= C.renderSize)) { return; }
    let center = vec2i(gid.xy);
    let maxCoord = vec2i(C.renderSize) - 1;

    //* Nearest Depth Search (dilate)
    // With a reversed depth buffer larger values are nearer; otherwise smaller.
    let reversed = hasFlag(FLAG_REVERSED_DEPTH);
    var bestDepth = textureLoad(sceneDepth, center, 0);
    var bestCoord = center;
    for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) { continue; }
            let p = clamp(center + vec2i(x, y), vec2i(0), maxCoord);
            let d = textureLoad(sceneDepth, p, 0);
            // Parenthesize the comparisons: WGSL otherwise parses the
            // '<' ... '>' as a template argument list and fails to compile.
            let nearer = select((d < bestDepth), (d > bestDepth), reversed);
            if (nearer) {
                bestDepth = d;
                bestCoord = p;
            }
        }
    }

    let curDepth = linearizeDepth(bestDepth);
    let uvDelta = textureLoad(sceneVelocity, bestCoord, 0).xy * C.motionScale;
    textureStore(dilatedDepth, gid.xy, vec4f(curDepth, 0.0, 0.0, 0.0));
    textureStore(dilatedMotion, gid.xy, vec4f(uvDelta, 0.0, 0.0));

    //* Depth Clip — disocclusion from the just-dilated depth + motion.
    // AMD's formulation (ffx_fsr2_depth_clip.h ComputeDepthClip, via the
    // GPU-verified candidate port): each bilinear tap of last frame's dilated
    // depth votes a confidence that its separation from the current depth is
    // within the viewport/depth-scaled tolerance; disocclusion is the weighted
    // complement, and only positive separations (current surface was occluded)
    // count at all.
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
    var separationConfidence = 0.0;
    var weightSum = 0.0;
    var potentialDisocclusion = true;
    for (var index = 0; index < 4; index++) {
        let weight = weights[index];
        if (weight <= DEPTH_TAP_WEIGHT_FLOOR) { continue; }
        let p = clamp(base + offsets[index], vec2i(0), maxCoord);
        let prevDepth = textureLoad(previousDepth, p, 0).r;
        let difference = curDepth - prevDepth;
        potentialDisocclusion = potentialDisocclusion && difference > 1.175e-38;
        if (potentialDisocclusion) {
            let required = DEPTH_SEPARATION_CONSTANT * halfViewportWidth * max(curDepth, prevDepth);
            separationConfidence += clamp(required / max(difference, 1.0e-7), 0.0, 1.0) * weight;
            weightSum += weight;
        }
    }
    let disocclusion = select(
        0.0,
        clamp(1.0 - separationConfidence / max(weightSum, 1.0e-6), 0.0, 1.0),
        potentialDisocclusion && weightSum > 0.0,
    );
    textureStore(maskOutput, gid.xy, vec4f(disocclusion, 0.0, 0.0, 1.0));
}
`,
);
